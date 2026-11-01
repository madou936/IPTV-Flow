import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'
import ffmpegStatic from 'ffmpeg-static'

const unpack = (p?: string | null): string | undefined =>
  p?.replace('app.asar', 'app.asar.unpacked')
const ffmpegPath = unpack(ffmpegStatic as unknown as string)

export type DownloadStatus = 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'

export interface DownloadItem {
  id: string
  title: string
  subtitle?: string
  src: string
  filePath: string
  status: DownloadStatus
  progress: number
  error?: string
  startedAt: number
  doneAt?: number
  durationSecs?: number
  sizeMb?: number
}

export interface StartDownloadParams {
  id: string
  title: string
  subtitle?: string
  src: string
  ext: string
  durationSecs?: number
}

interface ActiveDownload extends DownloadItem {
  proc?: ChildProcess
}

const downloads = new Map<string, ActiveDownload>()
type UpdateListener = (item: DownloadItem) => void
const listeners = new Set<UpdateListener>()

export function onDownloadUpdate(fn: UpdateListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(item: ActiveDownload): void {
  const { proc: _p, ...rest } = item
  for (const fn of listeners) fn(rest)
}

function sanitize(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100)
}

function parseHHMMSS(t: string): number {
  const parts = t.split(':')
  if (parts.length !== 3) return 0
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])
}

export function downloadsDir(): string {
  return join(app.getPath('userData'), 'downloads')
}

/** Reveal the downloads folder in Finder (creating it first if no file has been
 * downloaded yet, so the click never fails on a missing path). */
export async function openDownloadsFolder(): Promise<void> {
  const dir = downloadsDir()
  await mkdir(dir, { recursive: true })
  await shell.openPath(dir)
}

export async function startDownload(params: StartDownloadParams): Promise<DownloadItem> {
  const { id, title, subtitle, src, durationSecs } = params
  const existing = downloads.get(id)
  if (existing?.status === 'downloading') {
    const { proc: _p, ...rest } = existing
    return rest
  }

  const dir = downloadsDir()
  await mkdir(dir, { recursive: true })

  // Always write Matroska: it accepts every codec we may copy untouched
  // (HEVC/H264 video, AAC/AC3/E-AC3 audio, SRT/ASS/mov_text subtitles). MP4
  // rejects SRT subtitles outright, which made `-map 0 -c copy` abort.
  const nameParts = [sanitize(title)]
  if (subtitle) nameParts.push(sanitize(subtitle))
  const filePath = join(dir, `${nameParts.join(' - ')}.mkv`)

  const item: ActiveDownload = {
    id, title, subtitle, src, filePath,
    status: 'downloading',
    progress: 0,
    startedAt: Date.now(),
    durationSecs
  }
  downloads.set(id, item)
  notify(item)

  if (!ffmpegPath) {
    item.status = 'error'
    item.error = 'ffmpeg introuvable'
    notify(item)
    const { proc: _p, ...rest } = item
    return rest
  }

  const args = [
    '-v', 'quiet', '-progress', 'pipe:2',
    '-nostdin',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', src,
    '-map', '0',
    '-c', 'copy',
    '-y',
    filePath
  ]

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  item.proc = proc

  // -progress pipe:2 writes key=value lines to stderr, e.g.:
  //   out_time=00:01:23.456789
  //   progress=continue  (or "end" when done)
  // Keep only the tail of the stream and read the LAST out_time, otherwise a
  // non-global match keeps returning the first (oldest) value forever.
  let buf = ''
  proc.stderr.on('data', (d: Buffer) => {
    buf += d.toString()
    if (buf.length > 8192) buf = buf.slice(-4096)
    const matches = buf.match(/out_time=(\d+:\d+:\d+\.\d+)/g)
    if (matches && matches.length) {
      const last = matches[matches.length - 1].slice('out_time='.length)
      const elapsed = parseHHMMSS(last)
      if (durationSecs && durationSecs > 0) {
        item.progress = Math.min(99, Math.round((elapsed / durationSecs) * 100))
      } else {
        item.progress = Math.min(99, Math.round((elapsed / 10800) * 100))
      }
      notify(item)
    }
  })

  proc.on('error', (err) => {
    if (item.status !== 'cancelled') {
      item.status = 'error'
      item.error = err.message
    }
    item.proc = undefined
    notify(item)
  })

  proc.on('exit', async (code) => {
    item.proc = undefined
    if (item.status === 'cancelled') {
      try { await unlink(filePath) } catch { /* ok */ }
      notify(item)
      return
    }
    if (code === 0) {
      item.status = 'done'
      item.progress = 100
      item.doneAt = Date.now()
      try {
        const s = await stat(filePath)
        item.sizeMb = Math.round((s.size / 1024 / 1024) * 10) / 10
      } catch { /* ok */ }
    } else {
      item.status = 'error'
      item.error = `Erreur ffmpeg (code ${code})`
      try { await unlink(filePath) } catch { /* ok */ }
    }
    notify(item)
  })

  const { proc: _p, ...rest } = item
  return rest
}

/** SIGSTOP suspends ffmpeg in place; the kept HTTP socket may drop after a long
 * pause, in which case `-reconnect 1` will reopen the source on resume. */
export function pauseDownload(id: string): void {
  const item = downloads.get(id)
  if (!item || item.status !== 'downloading') return
  const pid = item.proc?.pid
  if (!pid) return
  try {
    process.kill(pid, 'SIGSTOP')
    item.status = 'paused'
    notify(item)
  } catch { /* ok */ }
}

export function resumeDownload(id: string): void {
  const item = downloads.get(id)
  if (!item || item.status !== 'paused') return
  const pid = item.proc?.pid
  if (!pid) return
  try {
    process.kill(pid, 'SIGCONT')
    item.status = 'downloading'
    notify(item)
  } catch { /* ok */ }
}

function killProc(item: ActiveDownload): void {
  const pid = item.proc?.pid
  if (!pid) return
  // SIGKILL terminates a SIGSTOP-ed process too, but SIGCONT-ing first lets the
  // child see the signal cleanly and emit its 'exit' event without delay.
  try { process.kill(pid, 'SIGCONT') } catch { /* ok */ }
  try { item.proc?.kill('SIGKILL') } catch { /* ok */ }
}

export function cancelDownload(id: string): void {
  const item = downloads.get(id)
  if (!item || (item.status !== 'downloading' && item.status !== 'paused')) return
  item.status = 'cancelled'
  killProc(item)
  notify(item)
}

export async function deleteDownload(id: string): Promise<void> {
  const item = downloads.get(id)
  if (!item) return
  if (item.status === 'downloading' || item.status === 'paused') {
    item.status = 'cancelled'
    killProc(item)
  }
  try { await unlink(item.filePath) } catch { /* ok */ }
  downloads.delete(id)
}

export function listDownloads(): DownloadItem[] {
  return Array.from(downloads.values()).map(({ proc: _p, ...rest }) => rest)
}
