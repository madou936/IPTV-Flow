import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, Server, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { scanLibrary } from './scanner'
import type { LocalEpisode, LocalMovie, ScanResult } from './scanner'
import type { LibraryKind } from './localLibrary'
import {
  getCollections,
  getCollectionDetails,
  getCachedEpisodeImages,
  getCachedEpisodeNames,
  getEpisodeNames,
  getEpisodeImages,
  getMetaForKey,
  getPostersByPrefix,
  getSeasonPrefs,
  getSeasonPosters,
  getSortNames,
  metaKey
} from './metadata'
import type { Meta, MetaRequest, SeasonPrefs } from './metadata'
import { buildArgs, probeDuration } from './proxy'
import { downloadSubtitle, searchSubtitles } from './opensubtitles'

const unpack = (p?: string | null): string | undefined => p?.replace('app.asar', 'app.asar.unpacked')
const ffmpegPath = unpack(ffmpegStatic as unknown as string)
const ffprobePath = unpack((ffprobeStatic as unknown as { path: string })?.path)
const BITMAP_SUBS = new Set(['dvb_subtitle', 'dvd_subtitle', 'hdmv_pgs_subtitle', 'xsub'])
const audioCodecCache = new Map<string, string[]>()
const externalSubtitlePaths = new Map<string, string>()

let server: Server | null = null
let port = 8788

interface TvItem {
  id: string
  kind: LibraryKind
  type: 'movie' | 'episode'
  title: string
  subtitle?: string
  year?: number
  mediaUrl: string
  poster?: string
  backdrop?: string
  key?: string
  folder?: string
  collectionId?: number
  collectionName?: string
  season?: number
  episode?: number
}

interface TvCollectionPayload {
  id: string
  kind: 'movies'
  type: 'collection'
  title: string
  poster?: string
  backdrop?: string
  movies: TvItem[]
}

interface TvSeasonPayload {
  id: string
  kind: LibraryKind
  type: 'season'
  showId: string
  season: number
  title: string
  subtitle?: string
  poster?: string
  backdrop?: string
  episodes: TvItem[]
}

function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.mp4':
    case '.m4v': return 'video/mp4'
    case '.mkv': return 'video/x-matroska'
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    case '.ts': return 'video/mp2t'
    case '.avi': return 'video/x-msvideo'
    default: return 'application/octet-stream'
  }
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null
  const match = value.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null
  let start = match[1] ? Number(match[1]) : 0
  let end = match[2] ? Number(match[2]) : size - 1
  if (!match[1] && match[2]) {
    const suffix = Number(match[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

async function scanAll(): Promise<Record<LibraryKind, ScanResult>> {
  const [movies, series, anime] = await Promise.all([
    scanLibrary('movies', false),
    scanLibrary('series', false),
    scanLibrary('anime', false)
  ])
  return { movies, series, anime }
}

interface TvShowPayload {
  id: string
  kind: LibraryKind
  type: 'show'
  title: string
  poster?: string
  backdrop?: string
  seasons: TvSeasonPayload[]
}

function req(kind: LibraryKind, title: string, year?: number): MetaRequest {
  return { kind, title, year }
}

function displayTitle(kind: LibraryKind, title: string, year: number | undefined, meta: Meta | null, sortNames: Record<string, string>): string {
  const key = metaKey(kind, title, year)
  return sortNames[key] || meta?.title || title
}

function orderedSeasons(seasons: ScanResult['shows'][number]['seasons'], prefs: SeasonPrefs): ScanResult['shows'][number]['seasons'] {
  const bySeason = new Map(seasons.map((season) => [season.season, season]))
  const ordered = (prefs.order || []).map((season) => bySeason.get(season)).filter((season): season is ScanResult['shows'][number]['seasons'][number] => !!season)
  const seen = new Set(ordered.map((season) => season.season))
  const rest = seasons.filter((season) => !seen.has(season.season))
  return [...ordered, ...rest]
}

function seasonOffset(show: ScanResult['shows'][number], seasonNumber: number): number {
  return show.seasons
    .filter((season) => seasonNumber !== 0 && season.season > 0 && season.season < seasonNumber)
    .reduce((sum, season) => sum + season.episodes.length, 0)
}

function usesGlobalNumbering(season: ScanResult['shows'][number]['seasons'][number]): boolean {
  const first = season.episodes[0]?.episode
  return season.season !== 0 && first != null && first > 1
}

async function movieItem(movie: LocalMovie, sortNames: Record<string, string>): Promise<TvItem> {
  const meta = await getMetaForKey(req('movies', movie.title, movie.year)).catch(() => null)
  const key = metaKey('movies', movie.title, movie.year)
  return {
    id: movie.id,
    kind: 'movies',
    type: 'movie',
    title: displayTitle('movies', movie.title, movie.year, meta, sortNames),
    year: meta?.year || movie.year,
    mediaUrl: `/tv-stream/movies/${encodeURIComponent(movie.id)}`,
    poster: meta?.poster,
    backdrop: meta?.backdrop,
    key,
    folder: movie.folder,
    collectionId: meta?.collectionId,
    collectionName: meta?.collectionName
  }
}

function episodeItem(kind: LibraryKind, showTitle: string, episode: LocalEpisode, episodeTitle: string, poster?: string): TvItem {
  return {
    id: episode.id,
    kind,
    type: 'episode',
    title: episodeTitle,
    subtitle: showTitle,
    mediaUrl: `/tv-stream/${kind}/${encodeURIComponent(episode.id)}`,
    poster,
    season: episode.season,
    episode: episode.episode
  }
}

async function showItem(kind: LibraryKind, show: ScanResult['shows'][number], sortNames: Record<string, string>): Promise<TvShowPayload> {
  const showReq = req(kind, show.title)
  const meta = await getMetaForKey(showReq).catch(() => null)
  const key = metaKey(kind, show.title)
  const prefs = await getSeasonPrefs(key).catch(() => ({ labels: {}, order: [] } as SeasonPrefs))
  const title = displayTitle(kind, show.title, undefined, meta, sortNames)
  const seasonPosters = await getSeasonPosters(showReq).catch(() => ({} as Record<number, string>))
  const imageEntries = await Promise.all(show.seasons.map(async (season) => {
    const offset = seasonOffset(show, season.season)
    const globalNumbering = usesGlobalNumbering(season)
    const [images, names] = await Promise.all([
      getCachedEpisodeImages(showReq, season.season, globalNumbering).catch(() => ({} as Record<number, string>)),
      getCachedEpisodeNames(showReq, season.season, globalNumbering).catch(() => ({} as Record<number, string>))
    ])
    return [season.season, { images, names }] as const
  }))
  const episodeMetaBySeason = new Map<number, { images: Record<number, string>; names: Record<number, string> }>(imageEntries)
  const seasons = orderedSeasons(show.seasons, prefs)
  return {
    id: show.id,
    kind,
    type: 'show',
    title,
    poster: meta?.poster,
    backdrop: meta?.backdrop,
    seasons: seasons.map((season) => {
      const episodeMeta = episodeMetaBySeason.get(season.season)
      return {
        id: `${show.id}:s${season.season}`,
        kind,
        type: 'season',
        showId: show.id,
        season: season.season,
        title: prefs.labels?.[season.season] || (season.season === 0 ? 'Spéciaux' : `Saison ${season.season}`),
        subtitle: `${season.episodes.length} épisodes`,
        poster: seasonPosters[season.season] || meta?.poster,
        backdrop: meta?.backdrop,
        episodes: season.episodes.map((episode) => episodeItem(
          kind,
          title,
          episode,
          episodeMeta?.names[episode.episode] || episode.title || `Épisode ${episode.episode}`,
          episodeMeta?.images[episode.episode] || seasonPosters[season.season] || meta?.backdrop || meta?.poster
        ))
      }
    })
  }
}

function sortTitle<T extends { title: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }))
}

async function movieSection(movies: TvItem[]): Promise<Array<TvItem | TvCollectionPayload>> {
  const used = new Set<string>()
  const out: TvCollectionPayload[] = []
  const collections = await getCollections().catch(() => [])
  const collPosters = await getPostersByPrefix('coll:').catch(() => ({} as Record<string, string>))
  const byKey = new Map(movies.map((movie) => [movie.key || movie.id, movie]))

  for (const coll of collections) {
    const members = coll.keys.map((key) => byKey.get(key)).filter((movie): movie is TvItem => !!movie)
    if (!members.length) continue
    for (const movie of members) if (movie.key) used.add(movie.key)
    out.push({
      id: coll.id,
      kind: 'movies',
      type: 'collection',
      title: coll.name,
      poster: collPosters[`coll:${coll.id}`] || coll.poster || members[0]?.poster,
      backdrop: members.find((movie) => movie.backdrop)?.backdrop,
      movies: sortTitle(members)
    })
  }

  const byTmdb = new Map<number, { name: string; movies: TvItem[] }>()
  for (const movie of movies) {
    if (!movie.key || used.has(movie.key) || !movie.collectionId || !movie.collectionName) continue
    const entry = byTmdb.get(movie.collectionId)
    if (entry) entry.movies.push(movie)
    else byTmdb.set(movie.collectionId, { name: movie.collectionName, movies: [movie] })
  }
  for (const [id, entry] of byTmdb) {
    if (entry.movies.length < 2) continue
    for (const movie of entry.movies) if (movie.key) used.add(movie.key)
    const details = await getCollectionDetails(id).catch(() => null)
    out.push({
      id: `tmdb:${id}`,
      kind: 'movies',
      type: 'collection',
      title: entry.name,
      poster: collPosters[`coll:tmdb:${id}`] || details?.poster || entry.movies[0]?.poster,
      backdrop: details?.backdrop || entry.movies.find((movie) => movie.backdrop)?.backdrop,
      movies: sortTitle(entry.movies)
    })
  }

  const loose = movies.filter((movie) => !movie.key || !used.has(movie.key))
  return sortTitle([...out, ...loose])
}

async function libraryPayload(): Promise<unknown> {
  const all = await scanAll()
  const sortNames = await getSortNames().catch(() => ({} as Record<string, string>))
  const [movies, series, anime] = await Promise.all([
    Promise.all(all.movies.movies.map((movie) => movieItem(movie, sortNames))),
    Promise.all(all.series.shows.map((show) => showItem('series', show, sortNames))),
    Promise.all(all.anime.shows.map((show) => showItem('anime', show, sortNames)))
  ])
  return {
    server: {
      name: 'IPTV Flow T7Flix',
      url: `http://${lanAddress()}:${port}`
    },
    sections: {
      movies: await movieSection(movies),
      series,
      anime
    }
  }
}

async function findMedia(kind: LibraryKind, id: string): Promise<string | null> {
  const result = await scanLibrary(kind, false)
  if (kind === 'movies') return result.movies.find((movie) => movie.id === id)?.filePath ?? null
  for (const show of result.shows) {
    for (const season of show.seasons) {
      const episode = season.episodes.find((entry) => entry.id === id)
      if (episode) return episode.filePath
    }
  }
  return null
}

async function episodeMeta(kind: LibraryKind, showId: string, seasonNumber: number): Promise<{
  names: Record<number, string>
  images: Record<number, string>
}> {
  const result = await scanLibrary(kind, false)
  const show = result.shows.find((entry) => entry.id === showId)
  const season = show?.seasons.find((entry) => entry.season === seasonNumber)
  if (!show || !season) return { names: {}, images: {} }
  const showReq = req(kind, show.title)
  const offset = seasonOffset(show, seasonNumber)
  const globalNumbering = usesGlobalNumbering(season)
  const [names, images] = await Promise.all([
    getEpisodeNames(showReq, seasonNumber, offset, globalNumbering).catch(() => ({} as Record<number, string>)),
    getEpisodeImages(showReq, seasonNumber, offset, globalNumbering).catch(() => ({} as Record<number, string>))
  ])
  return { names, images }
}

async function mediaInfo(kind: LibraryKind, id: string): Promise<{ duration?: number }> {
  const file = await findMedia(kind, id)
  if (!file) return {}
  const [duration, tracks] = await Promise.all([probeDuration(file), probeTracks(file)])
  return { duration, ...tracks }
}

function probeTracks(file: string): Promise<{
  audio: Array<{ rel: number; lang: string; title: string; codec: string; default: boolean }>
  subs: Array<{ rel: number; lang: string; title: string; codec: string; bitmap: boolean }>
}> {
  return new Promise((resolve) => {
    if (!ffprobePath) {
      resolve({ audio: [], subs: [] })
      return
    }
    const ff = spawn(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      '-analyzeduration', '100000',
      '-probesize', '65536',
      file
    ])
    let buf = ''
    ff.stdout.on('data', (d) => { buf += d })
    const timer = setTimeout(() => {
      try { ff.kill('SIGKILL') } catch { /* gone */ }
      resolve({ audio: [], subs: [] })
    }, 9000)
    ff.on('error', () => {
      clearTimeout(timer)
      resolve({ audio: [], subs: [] })
    })
    ff.on('close', () => {
      clearTimeout(timer)
      const audio: Array<{ rel: number; lang: string; title: string; codec: string; default: boolean }> = []
      const subs: Array<{ rel: number; lang: string; title: string; codec: string; bitmap: boolean }> = []
      try {
        const parsed = JSON.parse(buf) as { streams?: Array<{
          codec_type: string
          codec_name: string
          tags?: { language?: string; title?: string }
          disposition?: { default?: number }
        }> }
        let ai = 0
        let si = 0
        for (const stream of parsed.streams || []) {
          if (stream.codec_type === 'audio') {
            audio.push({
              rel: ai++,
              lang: stream.tags?.language || '',
              title: stream.tags?.title || '',
              codec: stream.codec_name || '',
              default: !!stream.disposition?.default
            })
          } else if (stream.codec_type === 'subtitle') {
            subs.push({
              rel: si++,
              lang: stream.tags?.language || '',
              title: stream.tags?.title || '',
              codec: stream.codec_name || '',
              bitmap: BITMAP_SUBS.has(stream.codec_name || '')
            })
          }
        }
      } catch {
        // Ignore invalid ffprobe output.
      }
      if (audio.length) audioCodecCache.set(file, audio.map((track) => track.codec))
      resolve({ audio, subs })
    })
  })
}

async function audioCodecs(file: string): Promise<string[]> {
  const cached = audioCodecCache.get(file)
  if (cached) return cached
  const tracks = await probeTracks(file)
  return tracks.audio.map((track) => track.codec)
}

async function streamMedia(kind: LibraryKind, id: string, rangeHeader: string | undefined, res: ServerResponse): Promise<void> {
  const file = await findMedia(kind, id)
  if (!file) {
    res.writeHead(404).end('Media introuvable')
    return
  }
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) {
    res.writeHead(404).end('Fichier introuvable')
    return
  }
  const range = parseRange(rangeHeader, info.size)
  const start = range?.start ?? 0
  const end = range?.end ?? info.size - 1
  const headers: Record<string, string | number> = {
    'Content-Type': contentTypeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': end - start + 1
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`
  res.writeHead(range ? 206 : 200, headers)
  createReadStream(file, { start, end }).pipe(res)
}

interface TvStreamOptions {
  start: number
  audio: number
  sub: number
  subBitmap: boolean
  subPath?: string
}

async function streamRemuxed(kind: LibraryKind, id: string, options: TvStreamOptions, res: ServerResponse): Promise<void> {
  const file = await findMedia(kind, id)
  if (!file) {
    res.writeHead(404).end('Media introuvable')
    return
  }
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) {
    res.writeHead(404).end('Fichier introuvable')
    return
  }
  if (!ffmpegPath) {
    await streamMedia(kind, id, undefined, res)
    return
  }
  const start = Math.max(0, options.start || 0)
  const audio = Number.isFinite(options.audio) && options.audio >= 0 ? Math.floor(options.audio) : 0
  const sub = Number.isFinite(options.sub) && options.sub >= 0 ? Math.floor(options.sub) : -1
  const subPath = options.subPath ? externalSubtitlePaths.get(options.subPath) || '' : ''
  await audioCodecs(file)
  if (res.writableEnded || res.destroyed) return
  const args = buildArgs(file, {
    live: false,
    start,
    audio,
    sub,
    subBitmap: options.subBitmap,
    subPath,
    forceVideoTranscode: true,
    syncSafe: true
  }, false)
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  ff.stdout.pipe(res)
  const kill = (): void => {
    try { ff.kill('SIGKILL') } catch { /* gone */ }
  }
  res.on('close', kill)
  ff.on('error', () => res.end())
  ff.on('exit', () => res.end())
}

async function streamSubtitleVtt(kind: LibraryKind, id: string, url: URL, res: ServerResponse): Promise<void> {
  const subPathId = url.searchParams.get('subPath') || ''
  const external = subPathId ? externalSubtitlePaths.get(subPathId) || '' : ''
  const file = external || await findMedia(kind, id)
  if (!file) {
    res.writeHead(404).end('Sous-titre introuvable')
    return
  }
  if (!ffmpegPath) {
    res.writeHead(500).end('ffmpeg introuvable')
    return
  }
  const start = Math.max(0, Number(url.searchParams.get('start') || '0') || 0)
  const args = ['-loglevel', 'error', '-nostdin']
  if (start > 0) args.push('-ss', String(Math.floor(start)))
  args.push('-i', file)
  if (external) args.push('-map', '0:0')
  else args.push('-map', `0:s:${Math.max(0, Number(url.searchParams.get('sub') || '0') || 0)}`)
  args.push('-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1')
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  res.writeHead(200, {
    'Content-Type': 'text/vtt; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  ff.stdout.pipe(res)
  const kill = (): void => {
    try { ff.kill('SIGKILL') } catch { /* gone */ }
  }
  res.on('close', kill)
  ff.on('error', () => res.end())
  ff.on('exit', () => res.end())
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(payload))
}

async function readBody(req: import('node:http').IncomingMessage, limit = 128 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Payload trop grand'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function tvHtml(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>T7Flix TV</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#090c12;color:#f4f7fb;font-family:system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
button{font:inherit}
.app{height:100vh;display:grid;grid-template-rows:auto auto 1fr;background:#090c12}
.bg{position:fixed;inset:0;background:#090c12;background-size:cover;background-position:center;opacity:.22;filter:saturate(.85);transition:background-image .2s;pointer-events:none}
.bg:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(9,12,18,.72),#090c12 52%,#090c12)}
header,.tabs,.content{position:relative;z-index:1}
header{display:flex;align-items:center;justify-content:space-between;padding:26px 42px 14px}
.brand{display:flex;align-items:center;gap:14px}
.logo{width:46px;height:46px;border-radius:10px;background:linear-gradient(145deg,#f4d35e,#ee6352 55%,#20263a);display:grid;place-items:center;color:#090c12;font-weight:900;font-size:19px;letter-spacing:-.04em}
h1{margin:0;font-size:34px;letter-spacing:.01em}.status{color:#aab4c5;font-size:15px}
.tabs{display:flex;gap:12px;padding:0 42px 18px}.tab{border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:#dfe7f5;border-radius:8px;padding:11px 18px;font-size:18px;min-width:96px;text-align:center}.tab.active{background:rgba(104,166,255,.18);border-color:rgba(104,166,255,.5)}
.content{padding:0 42px 36px;overflow-y:auto;overscroll-behavior:contain}
.view-head{display:flex;align-items:flex-end;justify-content:space-between;min-height:40px;margin-bottom:18px}
.view-title{font-size:28px;font-weight:800}.view-sub{color:#aab4c5;font-size:16px}.hint{color:#8792a6;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:22px}
.card{border:0;background:transparent;color:#fff;text-align:left;padding:0;min-width:0}
.poster{aspect-ratio:2/3;border-radius:8px;background:linear-gradient(145deg,#20283a,#101620);overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.09)}
.poster img{width:100%;height:100%;object-fit:cover;display:block}.fallback{width:100%;height:100%;display:grid;place-items:center;font-size:42px;font-weight:900;color:#cfd7e6;background:linear-gradient(145deg,#263147,#121825)}
.card-title{font-size:17px;line-height:1.18;font-weight:750;margin:10px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-sub{display:block;color:#aeb8c8;font-size:13px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.episode-grid{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.episode-grid .poster{aspect-ratio:16/9}.episode-grid .fallback{font-size:32px}
.tab.focus{outline:2px solid #68a6ff!important;outline-offset:3px}
.card.focus .poster{outline:2px solid #68a6ff;outline-offset:3px}
.empty{padding:40px;color:#aeb8c8;font-size:22px}
.player{position:fixed;inset:0;background:#000;display:none;z-index:10}.player.on{display:block}.player video{width:100%;height:100%;object-fit:contain;background:#000}
.subtitle-overlay{position:absolute;left:7vw;right:7vw;bottom:8vh;z-index:2;display:flex;flex-direction:column;align-items:center;gap:.16em;pointer-events:none;text-align:center;font-size:clamp(22px,3.4vw,46px);font-weight:720;line-height:1.12;color:#fff;text-shadow:0 2px 5px #000,0 0 10px #000}
.player.controls .subtitle-overlay{bottom:30vh}
.subtitle-overlay div{max-width:100%;padding:.04em .18em;border-radius:6px;background:rgba(0,0,0,.42)}
.player-osd{position:absolute;left:0;right:0;bottom:0;padding:30px 46px 38px;background:linear-gradient(0deg,rgba(0,0,0,.84),rgba(0,0,0,.48),transparent);opacity:0;transform:translateY(12px);transition:.16s}
.player.controls .player-osd{opacity:1;transform:translateY(0)}
.player-title{font-size:24px;font-weight:800;margin-bottom:14px;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player-row{display:flex;align-items:center;gap:16px}.play-state{width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.16);display:grid;place-items:center;font-size:19px}
.track-actions{display:flex;gap:10px;margin-top:16px}.track-btn{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.1);color:#fff;border-radius:8px;padding:9px 13px}.track-btn[disabled]{opacity:.35}.track-btn.player-focus,.track-option.player-focus,.play-state.player-focus{outline:2px solid #68a6ff;outline-offset:2px}.track-panel{position:absolute;left:46px;bottom:242px;min-width:320px;max-width:min(720px,70vw);max-height:36vh;overflow:auto;background:rgba(12,16,24,.96);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:8px;display:none}.track-panel.on{display:block}.track-option{display:block;width:100%;border:0;border-radius:8px;background:transparent;color:#dfe7f5;text-align:left;padding:10px 12px;margin:2px 0;white-space:normal}.track-option.on{background:rgba(104,166,255,.22);color:#fff}
.bar{height:9px;border-radius:999px;background:rgba(255,255,255,.22);flex:1;overflow:hidden}.bar-fill{height:100%;width:0;background:#68a6ff}.time{font-variant-numeric:tabular-nums;color:#d8deeb;font-size:16px;min-width:118px;text-align:right}
.back{position:absolute;top:26px;left:30px;background:rgba(0,0,0,.56);padding:10px 14px;border-radius:8px;color:#fff;opacity:0}.player.controls .back{opacity:1}
</style>
</head>
<body>
<div class="bg" id="bg"></div>
<div class="app">
  <header><div class="brand"><div class="logo">T7</div><h1>T7Flix</h1></div><div class="status" id="status">Connexion au Mac…</div></header>
  <nav class="tabs" id="tabs"></nav>
  <main class="content" id="content"><div class="view-head"><div><div class="view-title" id="viewTitle">Bibliothèque</div><div class="view-sub" id="viewSub"></div></div><div class="hint">Menu: adresse · Retour: revenir</div></div><div class="grid" id="grid"></div></main>
</div>
<div class="player" id="player"><div class="back">Retour</div><video id="video" autoplay></video><div class="subtitle-overlay" id="subtitleOverlay"></div><div class="track-panel" id="trackPanel"></div><div class="player-osd"><div class="player-title" id="playerTitle"></div><div class="player-row"><div class="play-state" id="playState">▶</div><div class="bar"><div class="bar-fill" id="barFill"></div></div><div class="time" id="timeText">0:00 / --:--</div></div><div class="track-actions"><button class="track-btn" id="audioBtn">Audio</button><button class="track-btn" id="subBtn">Sous-titres</button></div></div></div>
<script>
const tabDefs=[['movies','Films'],['series','Séries'],['anime','Anime']];
let data=null, section='movies', mode='home', currentShow=null, currentCollection=null, currentSeason=null, focused=null, currentItem=null, baseStart=0, knownDuration=0, controlsTimer=null, tracks={audio:[],subs:[]}, selectedAudio=0, selectedSub=-1, selectedSubBitmap=false, selectedSubPath='', openTrackMenu=null, playerFocus=null, trackFocus=0, streamSeq=0, subtitleResults=[], subtitleFeedback='', activeSubtitleKey='', subtitleAbort=null, subtitleSeq=0, subtitleCache=new Map();
const tabsEl=document.getElementById('tabs'), grid=document.getElementById('grid'), statusEl=document.getElementById('status'), player=document.getElementById('player'), video=document.getElementById('video'), content=document.getElementById('content'), viewTitle=document.getElementById('viewTitle'), viewSub=document.getElementById('viewSub'), bg=document.getElementById('bg'), playerTitle=document.getElementById('playerTitle'), playState=document.getElementById('playState'), barFill=document.getElementById('barFill'), timeText=document.getElementById('timeText'), audioBtn=document.getElementById('audioBtn'), subBtn=document.getElementById('subBtn'), trackPanel=document.getElementById('trackPanel'), subtitleOverlay=document.getElementById('subtitleOverlay');
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function initials(s){return String(s||'T7').split(/\\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()}
function fmt(t){if(!Number.isFinite(t)||t<=0)return '--:--';t=Math.floor(t);const h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60;return (h? h+':' : '')+(h&&m<10?'0':'')+m+':'+(s<10?'0':'')+s}
function posterHtml(item){return '<div class="poster">'+(item.poster?'<img src="'+esc(item.poster)+'" loading="lazy">':'<div class="fallback">'+esc(initials(item.title))+'</div>')+'</div>'}
function homeItems(){if(!data)return[];return data.sections[section]}
function renderTabs(){tabsEl.innerHTML='';tabDefs.forEach(([id,label])=>{const b=document.createElement('button');b.className='tab focusable '+(id===section?'active':'');b.textContent=label;b.dataset.action='tab';b.dataset.section=id;tabsEl.appendChild(b)})}
function setBg(url){bg.style.backgroundImage=url?'url("'+url.replace(/"/g,'%22')+'")':''}
function setRouteHash(hash){if(location.hash!=='#'+hash)history.replaceState(null,'','#'+hash)}
function render(){setRouteHash(mode==='home'?'home':mode);renderTabs();grid.className='grid';grid.innerHTML='';content.scrollTop=0;let items=homeItems(), title=section==='movies'?'Films':section==='series'?'Séries':'Anime', sub=String(items.length)+' titres', backDrop='';if(mode==='collection'&&currentCollection){items=currentCollection.movies;title=currentCollection.title;sub=String(items.length)+' films';backDrop=currentCollection.backdrop||currentCollection.poster||''}else if(mode==='show'&&currentShow){items=currentShow.seasons;title=currentShow.title;sub=String(items.length)+' saisons';backDrop=currentShow.backdrop||currentShow.poster||''}else if(mode==='season'&&currentSeason){items=currentSeason.episodes;const single=currentShow&&currentShow.seasons&&currentShow.seasons.length===1&&currentSeason.season===1;title=currentShow?(single?currentShow.title:currentShow.title+' · '+currentSeason.title):currentSeason.title;sub=String(items.length)+' épisodes';backDrop=currentSeason.backdrop||currentSeason.poster||(currentShow&&(currentShow.backdrop||currentShow.poster))||''}viewTitle.textContent=title;viewSub.textContent=sub;setBg(backDrop);if(!items.length){grid.innerHTML='<div class="empty">Aucun contenu dans cette section.</div>';focusFirst();return}if(mode==='season')grid.classList.add('episode-grid');items.forEach((item,i)=>{const b=document.createElement('button');b.className='card grid-card';b.dataset.index=String(i);b.dataset.action=item.type==='show'?'show':item.type==='collection'?'collection':item.type==='season'?'season':'play';b.__item=item;const epMeta=item.type==='episode'?'S'+item.season+' · E'+item.episode:'';b.innerHTML=posterHtml(item)+'<div class="card-title">'+esc(item.title)+'</div>'+(item.type==='movie'&&item.year?'<small class="card-sub">'+item.year+'</small>':item.type==='show'?'<small class="card-sub">'+item.seasons.reduce((n,s)=>n+s.episodes.length,0)+' épisodes</small>':item.type==='collection'?'<small class="card-sub">'+item.movies.length+' films</small>':item.type==='season'?'<small class="card-sub">'+item.episodes.length+' épisodes</small>':item.type==='episode'?'<small class="card-sub">'+esc(epMeta)+'</small>':'');grid.appendChild(b)});focusFirst()}
function tabButtons(){return Array.from(document.querySelectorAll('.tab'))}
function gridCards(){return Array.from(document.querySelectorAll('.grid-card'))}
function setFocus(el){if(!el)return;[...tabButtons(),...gridCards()].forEach(x=>x.classList.remove('focus'));focused=el;el.classList.add('focus');el.scrollIntoView({block:'nearest',inline:'nearest'});const it=el.__item;if(it)setBg(it.backdrop||it.poster||(currentSeason&&(currentSeason.backdrop||currentSeason.poster))||(currentShow&&(currentShow.backdrop||currentShow.poster))||'')}
function focusFirst(){setTimeout(()=>setFocus(gridCards()[0]||tabButtons()[0]),0)}
function gridCols(){const cards=gridCards();if(cards.length<2)return 1;const top=cards[0].offsetTop;let count=0;for(const c of cards){if(Math.abs(c.offsetTop-top)<8)count++;else break}return Math.max(1,count)}
function move(dir,step=1){if(!focused){focusFirst();return}const cards=gridCards();if(focused.classList.contains('tab')){const t=tabButtons(),i=t.indexOf(focused);if(dir==='left')setFocus(t[Math.max(0,i-step)]);else if(dir==='right')setFocus(t[Math.min(t.length-1,i+step)]);else if(dir==='down')setFocus(cards[0]);return}const i=cards.indexOf(focused);if(i<0)return;const cols=gridCols();let n=i;if(dir==='right')n=i+step;else if(dir==='left')n=i-step;else if(dir==='down')n=i+cols*step;else if(dir==='up')n=i-cols*step;if(dir==='up'&&n<0){setFocus(tabButtons().find(t=>t.dataset.section===section)||tabButtons()[0]);return}if(dir==='down'&&n>=cards.length)n=cards.length-1;if(n<0)n=cards.length-1;if(n>=cards.length)n=0;setFocus(cards[n])}
function navStep(k,repeat){if(!repeat)return 1;return k==='ArrowDown'||k==='ArrowUp'?2:1}
function enrichSeason(season){if(!season||!season.showId)return;fetch('/api/tv/episode-meta/'+season.kind+'/'+encodeURIComponent(season.showId)+'/'+season.season).then(r=>r.json()).then(j=>{const names=j.names||{},images=j.images||{};let changed=false;season.episodes=season.episodes.map(ep=>{const title=names[ep.episode],poster=images[ep.episode];if(!title&&!poster)return ep;changed=true;return {...ep,title:title||ep.title,poster:poster||ep.poster}});if(currentShow){currentShow.seasons=currentShow.seasons.map(s=>s.id===season.id?season:s)}if(currentSeason&&currentSeason.id===season.id)currentSeason=season;if(changed&&mode==='season')render()}).catch(()=>{})}
function activate(){if(!focused)return;if(focused.classList.contains('tab')){section=focused.dataset.section;mode='home';currentShow=null;currentSeason=null;currentCollection=null;render();return}const item=focused.__item;if(!item)return;if(item.type==='collection'){currentCollection=item;mode='collection';render();return}if(item.type==='show'){currentShow=item;currentSeason=null;if(item.seasons&&item.seasons.length===1&&item.seasons[0].season===1){currentSeason=item.seasons[0];mode='season';render();enrichSeason(currentSeason);return}mode='show';render();return}if(item.type==='season'){currentSeason=item;mode='season';render();enrichSeason(item);return}if(item.type==='movie'||item.type==='episode')play(item)}
function focusActiveTab(){setFocus(tabButtons().find(t=>t.dataset.section===section)||tabButtons()[0])}
function goBack(){if(player.classList.contains('on')){if(openTrackMenu){openTrackMenu=null;setPlayerFocus(null);renderTrackPanel();showControls();return}if(player.classList.contains('controls')){player.classList.remove('controls');setPlayerFocus(null);return}closePlayer();return}if(mode==='season'){if(currentShow&&currentShow.seasons&&currentShow.seasons.length===1&&currentSeason&&currentSeason.season===1){mode='home';currentShow=null;currentSeason=null;render();return}mode='show';currentSeason=null;render();return}if(mode==='show'||mode==='collection'){mode='home';currentShow=null;currentSeason=null;currentCollection=null;render();return}if(focused&&!focused.classList.contains('tab'))focusActiveTab()}
function showControls(){player.classList.add('controls');clearTimeout(controlsTimer);controlsTimer=setTimeout(()=>{if(!openTrackMenu&&!playerFocus)player.classList.remove('controls')},4200)}
function trackLabel(t, fallback){return [t.lang,t.title,t.codec].filter(Boolean).join(' · ')||fallback}
function streamUrl(start){const p=new URLSearchParams();p.set('reload',String(++streamSeq));if(start>0)p.set('start',String(Math.floor(start)));if(selectedAudio>0)p.set('audio',String(selectedAudio));if(selectedSub>=0&&selectedSubBitmap){p.set('sub',String(selectedSub));p.set('subBitmap','1')}const q=p.toString();return currentItem.mediaUrl+(q?'?'+q:'')}
function cleanupNativeTracks(){try{Array.from(video.textTracks||[]).forEach(t=>{t.mode='disabled'})}catch{}Array.from(video.querySelectorAll('track')).forEach(t=>{try{t.track.mode='disabled'}catch{};try{t.remove()}catch{}})}
function clearTextTrack(){subtitleSeq++;if(subtitleAbort){try{subtitleAbort.abort()}catch{}subtitleAbort=null}activeSubtitleKey='';subtitleOverlay.innerHTML='';cleanupNativeTracks()}
function textTrackUrl(start){if(!currentItem)return'';const p=new URLSearchParams();if(start>0)p.set('start',String(Math.floor(start)));if(selectedSubPath)p.set('subPath',selectedSubPath);else if(selectedSub>=0&&!selectedSubBitmap)p.set('sub',String(selectedSub));else return'';return '/api/tv/subtitle-vtt/'+currentItem.kind+'/'+encodeURIComponent(currentItem.id)+'?'+p.toString()}
function subtitleKey(){if(!currentItem)return'';if(selectedSubPath)return currentItem.kind+':'+currentItem.id+':file:'+selectedSubPath;return selectedSub>=0&&!selectedSubBitmap?currentItem.kind+':'+currentItem.id+':sub:'+selectedSub:''}
function parseTs(s){let sec=0;String(s||'').trim().replace(',','.').split(':').forEach(p=>{sec=sec*60+parseFloat(p)});return Number.isFinite(sec)?sec:0}
function cleanCueText(s){return String(s||'').replace(/<[^>]+>/g,'').replace(/\\{\\\\[^}]+\\}/g,'').replace(/&lrm;|&rlm;/g,'').trim()}
function parseCueBlock(block,from){const lines=String(block||'').split('\\n');const i=lines.findIndex(l=>l.includes('-->'));if(i<0)return null;const parts=lines[i].split('-->');const start=parseTs(parts[0])+from,end=parseTs(String(parts[1]||'').trim().split(/\\s+/)[0])+from,text=cleanCueText(lines.slice(i+1).join('\\n'));if(!text||end<=start)return null;return{start,end,text}}
function parseVtt(vtt,from){const out=[];String(vtt||'').replace(/\\r/g,'').split(/\\n\\n+/).forEach(block=>{const c=parseCueBlock(block,from);if(c)out.push(c)});return out}
function renderSubtitleOverlay(){if(!activeSubtitleKey){subtitleOverlay.innerHTML='';return}const cues=subtitleCache.get(activeSubtitleKey)||[];const now=baseStart+(video.currentTime||0);const active=cues.filter(c=>now>=c.start&&now<=c.end).slice(-2);subtitleOverlay.innerHTML=active.map(c=>c.text.split('\\n').map(line=>'<div>'+esc(line)+'</div>').join('')).join('')}
function applyTextTrack(){cleanupNativeTracks();const key=subtitleKey(),src=textTrackUrl(baseStart);if(!key||!src){clearTextTrack();return}activeSubtitleKey=key;subtitleOverlay.innerHTML='';const cached=subtitleCache.get(key);if(cached&&baseStart>=(Number(cached._from)||0)-.5){renderSubtitleOverlay();return}const seq=++subtitleSeq;if(subtitleAbort){try{subtitleAbort.abort()}catch{}}subtitleAbort=new AbortController();const from=Math.floor(baseStart);fetch(src,{signal:subtitleAbort.signal}).then(r=>r.ok?r.text():'').then(vtt=>{if(seq!==subtitleSeq||activeSubtitleKey!==key)return;const cues=parseVtt(vtt,from);cues._from=from;subtitleCache.set(key,cues);renderSubtitleOverlay()}).catch(()=>{if(seq===subtitleSeq)subtitleOverlay.innerHTML=''})}
function restartAt(t){const wasPlaying=!video.paused;baseStart=Math.max(0,t||0);video.pause();video.onloadedmetadata=null;video.src=streamUrl(baseStart);video.load();applyTextTrack();const resume=()=>{if(wasPlaying||player.classList.contains('on'))video.play().catch(()=>{})};video.onloadedmetadata=resume;resume();showControls();renderTrackPanel()}
function clearPlayerFocus(){[playState,audioBtn,subBtn,...Array.from(trackPanel.querySelectorAll('.track-option'))].forEach(x=>x.classList.remove('player-focus'))}
function setPlayerFocus(value){playerFocus=value;clearPlayerFocus();if(value==='play')playState.classList.add('player-focus');else if(value==='audio')audioBtn.classList.add('player-focus');else if(value==='sub')subBtn.classList.add('player-focus');else if(value==='menu'){const opts=Array.from(trackPanel.querySelectorAll('.track-option'));if(opts.length){trackFocus=Math.max(0,Math.min(trackFocus,opts.length-1));opts[trackFocus].classList.add('player-focus');opts[trackFocus].scrollIntoView({block:'nearest'})}}}
function enabledPlayerButtons(){return [[playState,'play'],[audioBtn,'audio'],[subBtn,'sub']].filter(([b])=>!b.disabled)}
function focusFirstPlayerButton(){const buttons=enabledPlayerButtons();setPlayerFocus(buttons.length?buttons[0][1]:null)}
function movePlayerButton(dir){const buttons=enabledPlayerButtons();if(!buttons.length){setPlayerFocus(null);return}let i=buttons.findIndex(([,name])=>name===playerFocus);if(i<0){setPlayerFocus(buttons[0][1]);return}if(dir==='right'||dir==='down')i=Math.min(buttons.length-1,i+1);else i=Math.max(0,i-1);setPlayerFocus(buttons[i][1])}
function subQuery(lang){if(!currentItem)return'';if(currentItem.type==='episode'&&currentItem.season!=null&&currentItem.episode!=null){const s=String(currentItem.season).padStart(2,'0'),e=String(currentItem.episode).padStart(2,'0');return (currentItem.subtitle||currentItem.title)+' S'+s+'E'+e}return currentItem.title}
function searchOnlineSubs(){subtitleResults=[];subtitleFeedback='Recherche…';openTrackMenu='subSearch';trackFocus=0;renderTrackPanel();fetch('/api/tv/subtitles/search?lang=fr&query='+encodeURIComponent(subQuery('fr'))).then(r=>r.json()).then(j=>{subtitleResults=(j.results||[]).slice().sort((a,b)=>(Number(b.downloads)||0)-(Number(a.downloads)||0));subtitleFeedback=subtitleResults.length?'':'Aucun résultat';trackFocus=subtitleResults.length?1:0;renderTrackPanel();setPlayerFocus('menu')}).catch(()=>{subtitleFeedback='Recherche impossible';renderTrackPanel();setPlayerFocus('menu')})}
function downloadOnlineSub(opt){if(!opt)return;subtitleFeedback='Téléchargement…';renderTrackPanel();fetch('/api/tv/subtitles/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:Number(opt.dataset.fileId),fileName:opt.dataset.fileName||'subtitle.srt'})}).then(r=>r.json()).then(j=>{if(j.error){subtitleFeedback=j.error;renderTrackPanel();return}const t=baseStart+(video.currentTime||0);selectedSub=-1;selectedSubBitmap=false;selectedSubPath=j.id||'';openTrackMenu=null;renderTrackPanel();setPlayerFocus('sub');restartAt(t)}).catch(()=>{subtitleFeedback='Téléchargement impossible';renderTrackPanel()})}
function selectTrackOption(){const opt=Array.from(trackPanel.querySelectorAll('.track-option'))[trackFocus];if(!opt)return;if(opt.dataset.back){openTrackMenu='sub';trackFocus=0;subtitleResults=[];subtitleFeedback='';renderTrackPanel();setPlayerFocus('menu');return}if(opt.dataset.online){searchOnlineSubs();return}if(opt.dataset.fileId){downloadOnlineSub(opt);return}const t=baseStart+(video.currentTime||0);if(opt.dataset.audio!=null){selectedAudio=Number(opt.dataset.audio);openTrackMenu=null;renderTrackPanel();setPlayerFocus('audio');restartAt(t);return}if(opt.dataset.sub!=null){selectedSubPath='';selectedSub=Number(opt.dataset.sub);selectedSubBitmap=opt.dataset.bitmap==='1';openTrackMenu=null;renderTrackPanel();setPlayerFocus('sub');if(selectedSub<0){selectedSubBitmap=false;clearTextTrack();showControls();return}restartAt(t);return}}
function openPlayerMenu(name){openTrackMenu=name;trackFocus=0;showControls();renderTrackPanel();setPlayerFocus('menu')}
function play(item){setRouteHash('player');currentItem=item;baseStart=0;knownDuration=0;tracks={audio:[],subs:[]};selectedAudio=0;selectedSub=-1;selectedSubBitmap=false;selectedSubPath='';openTrackMenu=null;playerFocus=null;trackFocus=0;subtitleResults=[];subtitleFeedback='';clearTextTrack();clearPlayerFocus();playerTitle.textContent=item.type==='episode'?(item.subtitle+' · '+item.title):item.title;player.classList.add('on','controls');video.pause();video.src=streamUrl(0);video.load();video.play().catch(()=>{});fetch('/api/tv/media-info/'+item.kind+'/'+encodeURIComponent(item.id)).then(r=>r.json()).then(info=>{knownDuration=Number(info.duration)||0;tracks={audio:info.audio||[],subs:info.subs||[]};audioBtn.disabled=tracks.audio.length<2;subBtn.disabled=false;renderTrackPanel();updateTime()}).catch(()=>{});audioBtn.disabled=true;subBtn.disabled=false;showControls()}
function closePlayer(){video.pause();clearTextTrack();video.removeAttribute('src');video.load();player.classList.remove('on','controls');currentItem=null;baseStart=0;knownDuration=0;openTrackMenu=null;playerFocus=null;trackFocus=0;selectedSubPath='';subtitleResults=[];subtitleFeedback='';clearPlayerFocus();renderTrackPanel();updateTime();setRouteHash(mode==='home'?'home':mode)}
function seek(delta){if(!currentItem||!knownDuration)return;const next=Math.max(0,Math.min(knownDuration-2,baseStart+video.currentTime+delta));restartAt(next)}
function togglePlay(){if(video.paused)video.play().catch(()=>{});else video.pause();showControls();updateTime()}
function updateTime(){const now=baseStart+(video.currentTime||0);const total=knownDuration||video.duration||0;if(total>0)barFill.style.width=Math.max(0,Math.min(100,now/total*100))+'%';else barFill.style.width='0%';timeText.textContent=fmt(now)+' / '+fmt(total);playState.textContent=video.paused?'▶':'Ⅱ';renderSubtitleOverlay()}
function renderTrackPanel(){trackPanel.classList.toggle('on',!!openTrackMenu);if(!openTrackMenu){trackPanel.innerHTML='';clearPlayerFocus();if(playerFocus==='audio')audioBtn.classList.add('player-focus');else if(playerFocus==='sub')subBtn.classList.add('player-focus');return}if(openTrackMenu==='audio'){trackPanel.innerHTML=tracks.audio.map((t,i)=>'<button class="track-option '+(selectedAudio===t.rel?'on':'')+'" data-audio="'+t.rel+'">'+esc(trackLabel(t,'Audio '+(i+1)))+'</button>').join('')}else if(openTrackMenu==='subSearch'){trackPanel.innerHTML='<button class="track-option" data-back="1">Retour</button>'+(subtitleFeedback?'<div class="track-option">'+esc(subtitleFeedback)+'</div>':'')+subtitleResults.map(r=>'<button class="track-option" data-file-id="'+r.fileId+'" data-file-name="'+esc(r.fileName||'subtitle.srt')+'">'+esc((r.language?String(r.language).toUpperCase()+' · ':'')+(r.releaseName||r.fileName||'Sous-titre')+' · '+(Number(r.downloads)||0).toLocaleString('fr')+' dl')+'</button>').join('')}else{trackPanel.innerHTML='<button class="track-option '+(selectedSub<0&&!selectedSubPath?'on':'')+'" data-sub="-1">Désactivés</button>'+tracks.subs.map((t,i)=>'<button class="track-option '+(!selectedSubPath&&selectedSub===t.rel?'on':'')+'" data-sub="'+t.rel+'" data-bitmap="'+(t.bitmap?'1':'0')+'">'+esc(trackLabel(t,'Sous-titre '+(i+1)))+'</button>').join('')+'<button class="track-option" data-online="fr">Télécharger en ligne</button>'}if(playerFocus==='menu')setPlayerFocus('menu')}
audioBtn.onclick=()=>{if(audioBtn.disabled)return;openPlayerMenu('audio')}
subBtn.onclick=()=>{if(subBtn.disabled)return;openPlayerMenu('sub')}
trackPanel.onclick=e=>{const b=e.target.closest('.track-option');if(!b)return;const opts=Array.from(trackPanel.querySelectorAll('.track-option'));trackFocus=Math.max(0,opts.indexOf(b));selectTrackOption()}
video.addEventListener('timeupdate',updateTime);video.addEventListener('durationchange',updateTime);video.addEventListener('play',updateTime);video.addEventListener('pause',updateTime);video.addEventListener('click',showControls);
document.addEventListener('keydown',e=>{const k=e.key;if(player.classList.contains('on')){if(['Backspace','Escape','BrowserBack'].includes(k)){e.preventDefault();goBack();return}if(openTrackMenu){const opts=Array.from(trackPanel.querySelectorAll('.track-option'));if(k==='ArrowDown'){e.preventDefault();trackFocus=Math.min(opts.length-1,trackFocus+1);setPlayerFocus('menu');showControls();return}if(k==='ArrowUp'){e.preventDefault();trackFocus=Math.max(0,trackFocus-1);setPlayerFocus('menu');showControls();return}if(k==='Enter'){e.preventDefault();selectTrackOption();return}if(k==='ArrowLeft'||k==='ArrowRight'){e.preventDefault();const last=openTrackMenu;openTrackMenu=null;renderTrackPanel();setPlayerFocus(last==='audio'?'audio':'sub');showControls();return}}if(k==='Enter'){e.preventDefault();if(!player.classList.contains('controls')){showControls();return}if(playerFocus==='audio'){openPlayerMenu('audio');return}if(playerFocus==='sub'){openPlayerMenu('sub');return}togglePlay();return}if(k==='ArrowDown'){e.preventDefault();showControls();if(!playerFocus)focusFirstPlayerButton();else movePlayerButton('down');return}if(k==='ArrowUp'){e.preventDefault();showControls();if(playerFocus==='sub')setPlayerFocus(audioBtn.disabled?null:'audio');else if(playerFocus==='audio')setPlayerFocus('play');else setPlayerFocus(null);return}if(k==='ArrowLeft'){e.preventDefault();if(playerFocus){movePlayerButton('left');showControls()}else seek(-10);return}if(k==='ArrowRight'){e.preventDefault();if(playerFocus){movePlayerButton('right');showControls()}else seek(10);return}return}const step=navStep(k,e.repeat);if(k==='ArrowRight'){e.preventDefault();move('right',step)}else if(k==='ArrowLeft'){e.preventDefault();move('left',step)}else if(k==='ArrowDown'){e.preventDefault();move('down',step)}else if(k==='ArrowUp'){e.preventDefault();move('up',step)}else if(k==='Enter'){e.preventDefault();activate()}else if(['Backspace','Escape','BrowserBack'].includes(k)){e.preventDefault();goBack()}});
document.addEventListener('click',e=>{const btn=e.target.closest('.tab,.grid-card');if(btn){setFocus(btn);activate()}});
fetch('/api/tv/library').then(r=>r.json()).then(j=>{data=j;statusEl.textContent=j.server.url;render()}).catch(()=>{statusEl.textContent='Serveur indisponible'});
</script>
</body>
</html>`
}

export function startT7TvServer(): Promise<number> {
  if (server) return Promise.resolve(port)
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${lanAddress()}:${port}`)
      if (url.pathname === '/' || url.pathname === '/tv') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(tvHtml())
        return
      }
      if (url.pathname === '/api/tv/status') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, url: `http://${lanAddress()}:${port}` }))
        return
      }
      if (url.pathname === '/api/tv/library') {
        void libraryPayload()
          .then((payload) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(payload))
          })
          .catch((error) => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Erreur inconnue' }))
          })
        return
      }
      if (url.pathname === '/api/tv/subtitles/search') {
        const query = (url.searchParams.get('query') || '').trim()
        const lang = (url.searchParams.get('lang') || 'fr').trim() || 'fr'
        const year = Number(url.searchParams.get('year') || '0') || undefined
        if (!query) {
          json(res, 200, { results: [] })
          return
        }
        void searchSubtitles(query, lang, year)
          .then((results) => json(res, 200, { results }))
          .catch(() => json(res, 200, { results: [] }))
        return
      }
      if (url.pathname === '/api/tv/subtitles/download' && req.method === 'POST') {
        void readBody(req)
          .then(async (body) => {
            const payload = JSON.parse(body || '{}') as { fileId?: number; fileName?: string }
            if (!payload.fileId || !payload.fileName) {
              json(res, 400, { error: 'Sous-titre invalide' })
              return
            }
            const result = await downloadSubtitle(payload.fileId, payload.fileName)
            if ('error' in result) {
              json(res, 400, result)
              return
            }
            const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
            externalSubtitlePaths.set(id, result.path)
            json(res, 200, { id, remaining: result.remaining })
          })
          .catch((error) => json(res, 400, { error: error instanceof Error ? error.message : 'Erreur sous-titres' }))
        return
      }
      const info = url.pathname.match(/^\/api\/tv\/media-info\/(movies|series|anime)\/([^/]+)$/)
      if (info) {
        void mediaInfo(info[1] as LibraryKind, decodeURIComponent(info[2]))
          .then((payload) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(payload))
          })
          .catch(() => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end('{}')
          })
        return
      }
      const epMeta = url.pathname.match(/^\/api\/tv\/episode-meta\/(series|anime)\/([^/]+)\/(\d+)$/)
      if (epMeta) {
        void episodeMeta(epMeta[1] as LibraryKind, decodeURIComponent(epMeta[2]), Number(epMeta[3]))
          .then((payload) => json(res, 200, payload))
          .catch(() => json(res, 200, { names: {}, images: {} }))
        return
      }
      const subVtt = url.pathname.match(/^\/api\/tv\/subtitle-vtt\/(movies|series|anime)\/([^/]+)$/)
      if (subVtt) {
        void streamSubtitleVtt(subVtt[1] as LibraryKind, decodeURIComponent(subVtt[2]), url, res)
        return
      }
      const media = url.pathname.match(/^\/tv-media\/(movies|series|anime)\/([^/]+)$/)
      if (media) {
        void streamMedia(media[1] as LibraryKind, decodeURIComponent(media[2]), req.headers.range, res)
        return
      }
      const stream = url.pathname.match(/^\/tv-stream\/(movies|series|anime)\/([^/]+)$/)
      if (stream) {
        void streamRemuxed(stream[1] as LibraryKind, decodeURIComponent(stream[2]), {
          start: Number(url.searchParams.get('start') || '0'),
          audio: Number(url.searchParams.get('audio') || '0'),
          sub: Number(url.searchParams.get('sub') || '-1'),
          subBitmap: url.searchParams.get('subBitmap') === '1',
          subPath: url.searchParams.get('subPath') || undefined
        }, res)
        return
      }
      res.writeHead(404).end()
    })
    server.listen(port, '0.0.0.0', () => resolve(port))
    server.once('error', () => {
      port = 0
      server?.listen(0, '0.0.0.0', () => {
        port = (server!.address() as { port: number }).port
        resolve(port)
      })
    })
  })
}

export function getT7TvUrl(): string {
  return `http://${lanAddress()}:${port}/tv`
}
