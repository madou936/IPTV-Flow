import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, Server, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

const unpack = (p?: string | null): string | undefined => p?.replace('app.asar', 'app.asar.unpacked')
const ffmpegPath = unpack(ffmpegStatic as unknown as string)
const ffprobePath = unpack((ffprobeStatic as unknown as { path: string })?.path)
const diagnostics = process.env.IPTV_FLOW_DIAGNOSTICS === '1'

const BITMAP_SUBS = new Set(['dvb_subtitle', 'dvd_subtitle', 'hdmv_pgs_subtitle', 'xsub'])

let server: Server | null = null
let port = 0

interface StreamOpts {
  live: boolean
  start: number
  audio: number // relative audio index
  sub: number // relative subtitle index to burn in, -1 = none
  subBitmap: boolean
  subPath: string // external sidecar subtitle file to burn in, '' = none
  forceVideoTranscode: boolean // only after Chromium rejected the direct picture
  syncSafe?: boolean // TV/Firestick path: prefer a freshly generated A/V timeline
}

/** ffmpeg's -reconnect options only exist for HTTP(S); they make it abort on a
 * local file path ("Option reconnect not found"). Downloaded media is local. */
function isRemote(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

/** ffprobe sizing args. Local SSD files are well-formed and respond in <100 ms
 * with a tiny probe window; remote streams need a larger lookahead for
 * multi-stream detection and buffering variability. */
function probeArgs(src: string): string[] {
  return isRemote(src)
    ? ['-analyzeduration', '4000000', '-probesize', '6000000']
    : ['-analyzeduration', '100000', '-probesize', '65536']
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.mkv': return 'video/x-matroska'
    case '.mp4':
    case '.m4v': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    case '.avi': return 'video/x-msvideo'
    default: return 'application/octet-stream'
  }
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null
  const m = value.match(/^bytes=(\d*)-(\d*)$/)
  if (!m) return null
  let start = m[1] ? Number(m[1]) : 0
  let end = m[2] ? Number(m[2]) : size - 1
  if (!m[1] && m[2]) {
    const suffix = Number(m[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/** Audio codec names per source, indexed by *relative* audio index. Lets us
 * decide copy-vs-transcode once and reuse it across seeks (each seek restarts
 * ffmpeg from scratch). Filled here on first play and by handleProbe. */
const audioCodecCache = new Map<string, string[]>()

function diag(event: string, payload: Record<string, unknown>): void {
  if (!diagnostics) return
  console.log(JSON.stringify({ tag: 'IPTV_FLOW_DIAG', event, at: Date.now(), ...payload }))
}

function probeAudioCodecs(src: string): Promise<string[]> {
  const cached = audioCodecCache.get(src)
  if (cached) return Promise.resolve(cached)
  return new Promise((resolve) => {
    if (!ffprobePath) {
      resolve([])
      return
    }
    const ff = spawn(ffprobePath, [
      '-v', 'quiet',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_name',
      '-of', 'json',
      ...probeArgs(src),
      src
    ])
    let buf = ''
    ff.stdout.on('data', (d) => (buf += d))
    let done = false
    const finish = (codecs: string[]): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (codecs.length) audioCodecCache.set(src, codecs)
      resolve(codecs)
    }
    const timer = setTimeout(() => {
      try {
        ff.kill('SIGKILL')
      } catch {
        /* gone */
      }
      finish([]) // probe too slow → fall back to transcoding (always plays)
    }, 6000)
    ff.on('error', () => finish([]))
    ff.on('close', () => {
      let codecs: string[] = []
      try {
        const streams = (JSON.parse(buf).streams || []) as Array<{ codec_name?: string }>
        codecs = streams.map((s) => s.codec_name || '')
      } catch {
        /* ignore parse errors */
      }
      finish(codecs)
    })
  })
}

function shouldTranscodeVideo(o: StreamOpts, audioCopy: boolean, burning: boolean): boolean {
  // Keep the local SSD video bitstream untouched even when AC3/E-AC3 audio
  // needs conversion. Re-encoding the whole HEVC/H.264 picture on every seek
  // was the main source of launch/seek stalls in T7Flix. The fragmented MP4
  // muxer below rebuilds the container timestamps; only subtitle burn-in still
  // requires a video encode.
  return burning || o.forceVideoTranscode
}

function pushVideoTranscodeArgs(out: string[], hw: boolean): void {
  if (hw) {
    // VideoToolbox: hardware H.264 encode (paired with -hwaccel videotoolbox
    // decode) so re-encoding a 4K HEVC stream on a seek stays real-time instead
    // of choking a software libx264 encoder. The re-encode still regenerates
    // clean timestamps — which is what keeps A/V in sync after a seek.
    out.push('-c:v', 'h264_videotoolbox', '-b:v', '20M', '-pix_fmt', 'yuv420p')
  } else {
    // Software path, used for burn-in where a software filter (subtitles /
    // overlay) produces the frames — videotoolbox decode can't feed those.
    out.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-crf', '21')
  }
}

export function buildArgs(src: string, o: StreamOpts, audioCopy: boolean): string[] {
  const burning = o.sub >= 0 || !!o.subPath
  const transcodeVideo = shouldTranscodeVideo(o, audioCopy, burning)
  // Full hardware path only when re-encoding without a software video filter.
  const hwTranscode = transcodeVideo && !burning
  const pre = ['-loglevel', 'error', '-nostdin']
  if (isRemote(src)) {
    pre.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2')
  }
  if (hwTranscode) pre.push('-hwaccel', 'videotoolbox')
  // nobuffer discards packets while probing a live transport stream.  Audio
  // and video may then begin at different source timestamps (often one GOP,
  // several seconds apart), which the fragmented MP4 muxer rebases separately.
  if (o.live) pre.push('-fflags', '+genpts')
  else if (o.syncSafe) pre.push('-fflags', '+genpts')
  if (o.start > 0) pre.push('-ss', String(o.start))

  const out: string[] = []
  if (burning) {
    if (o.subBitmap) {
      // Bitmap subs (DVB/PGS): overlay onto the video from the same input.
      out.push('-filter_complex', `[0:v:0][0:s:${o.sub}]overlay[v]`, '-map', '[v]')
    } else {
      // Text subs: render with the subtitles filter. ffmpeg double-unescapes
      // filter args, so each ":" in the path must become "\\:" to survive both
      // passes — otherwise it splits the path into bogus filter options. A
      // sidecar file (subPath, e.g. a local .srt/.ass) is read straight by
      // libass; otherwise we pick embedded track `si` from the source itself.
      const subFile = o.subPath || src
      const esc = subFile
        .replace(/'/g, "\\\\'")
        .replace(/:/g, '\\\\:')
        .replace(/,/g, '\\\\,')
        .replace(/\[/g, '\\\\[')
        .replace(/\]/g, '\\\\]')
      // The subtitles filter re-reads the file with ABSOLUTE timestamps, but
      // input seeking (-ss) rebases frame PTS to ~0 → subtitles desync by the
      // seek amount. Restore absolute PTS around the filter, then rebase to 0
      // so the player timeline (currentTime from 0) stays correct.
      const sub = o.subPath ? `subtitles=${esc}` : `subtitles=${esc}:si=${o.sub}`
      const vf =
        o.start > 0
          ? `setpts=PTS+${o.start}/TB,${sub},setpts=PTS-${o.start}/TB`
          : sub
      out.push('-map', '0:v:0', '-vf', vf)
    }
    out.push('-map', `0:a:${o.audio}?`)
    pushVideoTranscodeArgs(out, false)
  } else {
    // Default fast path: copy the video untouched (any codec, incl. 4K/8K HEVC).
    out.push('-map', '0:v:0', '-map', `0:a:${o.audio}?`)
    if (transcodeVideo) {
      pushVideoTranscodeArgs(out, hwTranscode)
    } else {
      out.push('-c:v', 'copy')
    }
  }
  // Audio: copy when the source is already AAC so playback stays a pure remux —
  // the original timestamps (hence A/V sync) are preserved exactly. The AAC
  // *re-encode* adds an encoder priming delay (~20-30 ms) the fragmented-MP4
  // muxer doesn't compensate, which desynced every transcoded file by a constant
  // amount. Only non-AAC audio (Dolby AC3/E-AC3, DTS, MP2…) is transcoded.
  if (audioCopy) {
    out.push('-c:a', 'copy')
    // Live MPEG-TS carries AAC in ADTS framing, which MP4 cannot mux directly.
    // The filter converts only the framing and keeps audio packets/timestamps.
    out.push('-bsf:a', 'aac_adtstoasc')
  } else {
    out.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k')
    if (o.live) out.push('-af', 'aresample=async=1000')
    else if (o.syncSafe) out.push('-af', 'aresample=async=1:first_pts=0')
  }
  out.push(
    // Do not use -avoid_negative_ts make_zero here. With H.264 B-frames and
    // freshly encoded AAC it drops/rebases the encoder-delay samples, leaving
    // an audible 83 ms gap after the first packet (measured on Creed III and
    // Dernier Train pour Busan). negative_cts_offsets preserves the original
    // presentation timeline while still keeping the fragmented MP4 playable.
    // frag_keyframe alone makes one fragment per GOP — several seconds for
    // long-GOP HEVC — so Chromium receives big chunks and can drift A/V. A
    // fixed 0.5 s fragment duration forces tight, regular A/V interleaving.
    // negative_cts_offsets writes real (negative) composition offsets for
    // B-frame video instead of delaying its presentation, which otherwise makes
    // the picture lag the audio (audio "ahead") on HEVC/H.264 with B-frames.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets',
    '-frag_duration', '500000',
    '-f', 'mp4', 'pipe:1'
  )
  return [...pre, '-i', src, ...out]
}

async function handleStream(src: string, o: StreamOpts, res: ServerResponse): Promise<void> {
  if (!ffmpegPath) {
    res.writeHead(500).end('ffmpeg introuvable')
    return
  }
  // The renderer has already probed the tracks before requesting playback.
  // Reuse that result for live AAC too: copying keeps its source timestamps
  // paired with the copied video instead of introducing a second audio clock.
  const codecs = audioCodecCache.get(src) ?? (o.live ? [] : await probeAudioCodecs(src))
  if (res.writableEnded || res.destroyed) return // client gave up during probe
  const audioCopy = codecs[o.audio] === 'aac'
  const args = buildArgs(src, o, audioCopy)
  diag('ffmpeg:stream', { src, opts: o, audioCopy, args })
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' })
  ff.stdout.pipe(res)
  const kill = (): void => {
    try {
      ff.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
  res.on('close', kill)
  ff.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
  ff.on('exit', () => res.end())
}

function handleSubtitle(src: string, rel: number, start: number, res: ServerResponse): void {
  if (!ffmpegPath) {
    res.writeHead(500).end('ffmpeg introuvable')
    return
  }
  const pre = ['-loglevel', 'error', '-nostdin']
  if (isRemote(src)) {
    pre.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2')
  }
  if (start > 0) pre.push('-ss', String(start))
  const args = [
    ...pre,
    '-i', src,
    '-map', `0:s:${rel}`,
    '-c:s', 'webvtt',
    '-f', 'webvtt',
    'pipe:1'
  ]
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  res.writeHead(200, {
    'Content-Type': 'text/vtt; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  ff.stdout.pipe(res)
  const kill = (): void => {
    try {
      ff.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
  res.on('close', kill)
  ff.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
  ff.on('exit', () => res.end())
}

/** Decode only a selected unsupported audio track.  The visible video remains
 * the local file opened directly by Chromium. */
function handleCompanionAudio(src: string, rel: number, start: number, res: ServerResponse): void {
  if (!ffmpegPath) {
    res.writeHead(500).end('ffmpeg introuvable')
    return
  }
  const args = ['-loglevel', 'error', '-nostdin']
  if (start > 0) args.push('-ss', String(start))
  args.push(
    '-i', src,
    '-map', `0:a:${rel}`,
    '-vn',
    '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'aac',
    '-ac', '2',
    '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets',
    '-frag_duration', '500000',
    '-f', 'mp4',
    'pipe:1'
  )
  diag('ffmpeg:audio', { src, rel, start, args })
  pipeFfmpeg(args, 'audio/mp4; codecs="mp4a.40.2"', res)
}

/** Render an embedded bitmap subtitle into a transparent companion layer.
 * This is deliberately separate from the main picture, avoiding video burn-in
 * and preserving direct playback of the original local file. */
function handleBitmapSubtitle(src: string, rel: number, start: number, width: number, height: number, res: ServerResponse): void {
  if (!ffmpegPath) {
    res.writeHead(500).end('ffmpeg introuvable')
    return
  }
  const w = Math.max(16, Math.min(7680, Math.round(width) || 1920))
  const h = Math.max(16, Math.min(4320, Math.round(height) || 1080))
  const args = ['-loglevel', 'error', '-nostdin']
  if (start > 0) args.push('-ss', String(start))
  args.push(
    '-i', src,
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=${w}x${h}:r=25`,
    '-filter_complex', `[1:v]format=yuva420p[base];[base][0:s:${rel}]overlay=eof_action=pass:shortest=1:format=auto,format=yuva420p`,
    '-an',
    '-c:v', 'libvpx-vp9',
    '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-auto-alt-ref', '0',
    '-b:v', '1200k',
    '-f', 'webm', 'pipe:1'
  )
  diag('ffmpeg:bitmap-subtitle', { src, rel, start, width: w, height: h, args })
  pipeFfmpeg(args, 'video/webm; codecs=vp9', res)
}

function pipeFfmpeg(args: string[], contentType: string, res: ServerResponse): void {
  if (!ffmpegPath) return
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
  ff.stdout.pipe(res)
  const kill = (): void => { try { ff.kill('SIGKILL') } catch { /* gone */ } }
  res.on('close', kill)
  ff.on('error', () => res.end())
  ff.on('exit', () => res.end())
}

function handleProbe(src: string, res: ServerResponse): void {
  if (!ffprobePath) {
    res.writeHead(200).end(JSON.stringify({ audio: [], subs: [] }))
    return
  }
  const ff = spawn(ffprobePath, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    ...probeArgs(src),
    src
  ])
  let buf = ''
  ff.stdout.on('data', (d) => (buf += d))
  const timer = setTimeout(kill, 9000)
  function kill(): void {
    try {
      ff.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
  ff.on('error', () => {
    clearTimeout(timer)
    res.writeHead(200).end(JSON.stringify({ audio: [], subs: [] }))
  })
  ff.on('close', () => {
    clearTimeout(timer)
    const audio: unknown[] = []
    const subs: unknown[] = []
    const audioCodecs: string[] = []
    let video: { codec: string; codecTag?: string; width: number; height: number; bitrate: number; encoder: string; bitDepth: number } | null = null
    let duration: number | undefined
    try {
      const parsed = JSON.parse(buf) as { streams?: Array<{
        index?: number
        codec_type: string
        codec_name: string
        codec_tag_string?: string
        width?: number
        height?: number
        bit_rate?: string
        pix_fmt?: string
        tags?: { language?: string; title?: string; encoder?: string }
        disposition?: { default?: number }
      }>; format?: { duration?: string } }
      const streams = parsed.streams || []
      const rawDuration = Number(parsed.format?.duration)
      if (Number.isFinite(rawDuration) && rawDuration > 0) duration = rawDuration
      let ai = 0
      let si = 0
      for (const s of streams) {
        if (s.codec_type === 'video' && !video) {
          const pf = s.pix_fmt || ''
          const bitDepth = pf.includes('12') ? 12 : pf.includes('10') ? 10 : 8
          video = {
            codec: s.codec_name || '',
            codecTag: s.codec_tag_string || '',
            width: s.width || 0,
            height: s.height || 0,
            bitrate: Number(s.bit_rate) || 0,
            encoder: s.tags?.encoder || '',
            bitDepth
          }
        } else if (s.codec_type === 'audio') {
          audioCodecs.push(s.codec_name || '')
          audio.push({
            rel: ai++,
            lang: s.tags?.language || '',
            title: s.tags?.title || '',
            codec: s.codec_name,
            default: !!s.disposition?.default
          })
        } else if (s.codec_type === 'subtitle') {
          subs.push({
            rel: si++,
            lang: s.tags?.language || '',
            title: s.tags?.title || '',
            codec: s.codec_name,
            bitmap: BITMAP_SUBS.has(s.codec_name)
          })
        }
      }
      // Warm the copy-vs-transcode cache so the first stream skips its own probe.
      if (audioCodecs.length) audioCodecCache.set(src, audioCodecs)
    } catch {
      /* ignore parse errors */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ audio, subs, video, duration }))
  })
}

function handleThumbnail(src: string, time: number, res: ServerResponse): void {
  if (!ffmpegPath || !Number.isFinite(time) || time < 0 || isRemote(src) && !/^https?:\/\//i.test(src)) {
    res.writeHead(400).end()
    return
  }
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...probeArgs(src),
    '-ss', String(Math.floor(time)),
    '-i', src,
    '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=360:-2', '-q:v', '5',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
  ]
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  const chunks: Buffer[] = []
  let size = 0
  let finished = false
  const finish = (status: number): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (status === 0 && size > 0 && !res.destroyed) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300' })
      res.end(Buffer.concat(chunks))
    } else if (!res.destroyed) {
      res.writeHead(404).end()
    }
  }
  ff.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= 2_000_000) chunks.push(chunk)
    else { ff.kill('SIGKILL'); finish(1) }
  })
  ff.on('error', () => finish(1))
  ff.on('close', (code) => finish(code ?? 1))
  const timer = setTimeout(() => { ff.kill('SIGKILL'); finish(1) }, 12000)
  res.on('close', () => { if (!finished) { ff.kill('SIGKILL'); finish(1) } })
}

async function handleLocalFile(src: string, rangeHeader: string | undefined, res: ServerResponse): Promise<void> {
  if (isRemote(src)) {
    res.writeHead(400).end()
    return
  }
  try {
    const info = await stat(src)
    if (!info.isFile()) {
      res.writeHead(404).end()
      return
    }
    const range = parseRange(rangeHeader, info.size)
    const start = range?.start ?? 0
    const end = range?.end ?? info.size - 1
    const headers: Record<string, string | number> = {
      'Content-Type': contentTypeFor(src),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': end - start + 1
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`
    diag('http:file', { src, range: range ?? null, size: info.size })
    res.writeHead(range ? 206 : 200, headers)
    createReadStream(src, { start, end }).pipe(res)
  } catch {
    res.writeHead(404).end()
  }
}

export function startProxy(): Promise<number> {
  if (server) return Promise.resolve(port)
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const u = new URL(req.url || '', 'http://127.0.0.1')
      const src = u.searchParams.get('src')
      if (!src) {
        res.writeHead(400).end()
        return
      }
      if (u.pathname === '/probe') {
        handleProbe(src, res)
        return
      }
      if (u.pathname === '/file') {
        void handleLocalFile(src, req.headers.range, res)
        return
      }
      if (u.pathname === '/thumbnail') {
        handleThumbnail(src, Number(u.searchParams.get('time') || '0'), res)
        return
      }
      if (u.pathname === '/subtitle') {
        handleSubtitle(src, Number(u.searchParams.get('sub') || '0'), Number(u.searchParams.get('start') || '0'), res)
        return
      }
      if (u.pathname === '/audio') {
        handleCompanionAudio(src, Number(u.searchParams.get('audio') || '0'), Number(u.searchParams.get('start') || '0'), res)
        return
      }
      if (u.pathname === '/bitmap-subtitle') {
        handleBitmapSubtitle(src, Number(u.searchParams.get('sub') || '0'), Number(u.searchParams.get('start') || '0'), Number(u.searchParams.get('width') || '1920'), Number(u.searchParams.get('height') || '1080'), res)
        return
      }
      if (u.pathname === '/stream') {
        void handleStream(
          src,
          {
            live: u.searchParams.get('live') === '1',
            start: Number(u.searchParams.get('start') || '0'),
            audio: Number(u.searchParams.get('audio') || '0'),
            sub: u.searchParams.has('sub') ? Number(u.searchParams.get('sub')) : -1,
            subBitmap: u.searchParams.get('subBitmap') === '1',
            subPath: u.searchParams.get('subPath') || '',
            forceVideoTranscode: u.searchParams.get('transcodeVideo') === '1'
          },
          res
        )
        return
      }
      res.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1', () => {
      port = (server!.address() as { port: number }).port
      resolve(port)
    })
  })
}

export function getProxyPort(): number {
  return port
}

/** ffprobe a media file for its total duration in seconds (used to give local
 * T7 files a seek bar). Resolves undefined on any failure — never throws. */
export function probeDuration(src: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (!ffprobePath) {
      resolve(undefined)
      return
    }
    const ff = spawn(ffprobePath, [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      ...probeArgs(src),
      src
    ])
    let buf = ''
    ff.stdout.on('data', (d) => (buf += d))
    const timer = setTimeout(() => {
      try {
        ff.kill('SIGKILL')
      } catch {
        /* gone */
      }
      resolve(undefined)
    }, 8000)
    ff.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    ff.on('close', () => {
      clearTimeout(timer)
      const n = parseFloat(buf.trim())
      resolve(Number.isFinite(n) && n > 0 ? n : undefined)
    })
  })
}
