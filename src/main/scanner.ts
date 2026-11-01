import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { getT7Config } from './localLibrary'
import type { LibraryKind } from './localLibrary'

// ---------------------------------------------------------------------------
// T7Flix scanner (phase 1B) — walks the designated folders, parses filenames
// into movies / shows→seasons→episodes, and matches sidecar subtitle files.
// No network, no TMDB here (that's phase 2): titles come straight from the
// filenames, refined later.
// ---------------------------------------------------------------------------

const VIDEO_EXT = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.ts', '.wmv', '.webm', '.flv', '.mpg', '.mpeg'
])
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub'])
const SHARED_SUBTITLE_FOLDER = 'Sous-titres FR SRT'

export interface LocalSub {
  label: string
  path: string
  ext: string
}
export interface LocalMovie {
  id: string
  title: string
  year?: number
  filePath: string
  /** Immediate parent folder name — used later for folder-based collections. */
  folder: string
  subs: LocalSub[]
}
export interface LocalEpisode {
  id: string
  season: number
  episode: number
  title?: string
  filePath: string
  subs: LocalSub[]
}
export interface LocalSeason {
  season: number
  episodes: LocalEpisode[]
}
export interface LocalShow {
  id: string
  title: string
  seasons: LocalSeason[]
}
export interface ScanResult {
  kind: LibraryKind
  available: boolean
  movies: LocalMovie[]
  shows: LocalShow[]
}

function hash(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 12)
}

function cleanName(s: string): string {
  return s
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isSample(name: string): boolean {
  return /(^|[\s._-])sample([\s._-]|$)/i.test(name)
}

async function walk(dir: string, vids: string[], subs: string[], depth = 0): Promise<void> {
  if (depth > 8) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable folder (permissions, vanished) — never throw
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      await walk(full, vids, subs, depth + 1)
    } else {
      const ext = extname(e.name).toLowerCase()
      if (VIDEO_EXT.has(ext) && !isSample(e.name)) vids.push(full)
      else if (SUB_EXT.has(ext)) subs.push(full)
    }
  }
}

/** Group subtitle paths by directory for fast sidecar lookup. */
function indexSubs(subs: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const s of subs) {
    const d = dirname(s)
    const arr = m.get(d)
    if (arr) arr.push(s)
    else m.set(d, [s])
  }
  return m
}

/** Sidecar subs share the video's basename, optionally with a language suffix
 * ("Movie.srt", "Movie.fr.srt", "Movie.en.ass"). */
function subsFor(videoPath: string, idx: Map<string, string[]>): LocalSub[] {
  const videoDir = dirname(videoPath)
  // T7Flix normally accepts sidecars next to the video. A show can also keep
  // all generated text subtitles together in this dedicated child folder.
  const candidates = [
    ...(idx.get(videoDir) ?? []),
    ...(idx.get(join(videoDir, SHARED_SUBTITLE_FOLDER)) ?? [])
  ]
  if (candidates.length === 0) return []
  const vbase = basename(videoPath, extname(videoPath)).toLowerCase()
  const out: LocalSub[] = []
  for (const s of candidates) {
    const sbase = basename(s, extname(s)).toLowerCase()
    if (sbase === vbase || sbase.startsWith(vbase + '.')) {
      const ext = extname(s).slice(1).toLowerCase()
      const suffix = sbase.length > vbase.length ? sbase.slice(vbase.length + 1) : ''
      out.push({ label: (suffix || ext).toUpperCase(), path: s, ext })
    }
  }
  return out
}

function buildMovie(file: string, idx: Map<string, string[]>): LocalMovie {
  const base = basename(file, extname(file))
  const ym = base.match(/(?:^|[.\s_([-])((?:19|20)\d\d)(?:[.\s_)\]-]|$)/)
  let year: number | undefined
  let title = base
  if (ym && ym.index != null) {
    year = Number(ym[1])
    const before = base.slice(0, ym.index).trim()
    if (before) title = before
  }
  return {
    id: hash(file),
    title: cleanName(title) || base,
    year,
    filePath: file,
    folder: basename(dirname(file)),
    subs: subsFor(file, idx)
  }
}

interface ParsedEp {
  show: string
  season: number
  episode: number | null
  title: string
  filePath: string
  subs: LocalSub[]
}

const SPECIAL_RE = /(special|sp[ée]cial|specials|sp[ée]ciaux|\bova\b|\boav\b|extras|hors[\s-]?s[ée]rie)/i

function buildEpisode(file: string, root: string, idx: Map<string, string[]>): ParsedEp {
  const rel = relative(root, file)
  const segs = rel.split(sep)
  const fname = basename(file, extname(file))

  // Show name = top-level folder under the root when nested, else parsed from
  // the filename (text before the SxxEyy / episode marker).
  let show = segs.length >= 2 ? segs[0] : ''
  let season: number | undefined
  let episode: number | null = null

  const isSpecial = segs.some((s) => SPECIAL_RE.test(s))

  // "Season 1" / "Saison 1" / "S1" folder.
  for (const s of segs.slice(0, -1)) {
    const m = s.match(/(?:season|saison|s)\s*[_\s-]*?(\d{1,2})\b/i)
    if (m) {
      season = Number(m[1])
      break
    }
  }

  // SxxEyy → most reliable. Also accepts the "EP" variant (S1EP10, S01 EP 5)
  // and the "Part" variant the user types in Finder (P4E13 = part 4, ep 13).
  let m = fname.match(/[sp](\d{1,2})[\s._-]*ep?\.?[\s._-]*(\d{1,3})/i)
  if (m) {
    season = season ?? Number(m[1])
    episode = Number(m[2])
  } else if ((m = fname.match(/(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:[\s._-]|$)/i))) {
    season = season ?? Number(m[1])
    episode = Number(m[2])
  } else if ((m = fname.match(/(?:^|[\s._-])e(?:p)?\.?\s*(\d{1,3})(?:[\s._-]|$)/i))) {
    episode = Number(m[1])
  } else if ((m = fname.match(/(?:^|[\s._-]|#)(\d{1,3})(?:v\d)?(?:[\s._-]|$)/))) {
    // Anime-style trailing/standalone episode number ("Show - 012", "Show #07").
    episode = Number(m[1])
  }

  if (isSpecial) season = 0
  if (season == null) season = 1

  // Derive show from filename when files sit flat in the root.
  if (!show) {
    const cut = fname.search(/[sp]\d{1,2}[\s._-]*ep?\.?[\s._-]*\d{1,3}|(?:^|[\s._-])\d{1,2}x\d{1,3}|(?:^|[\s._-])e(?:p)?\.?\s*\d{1,3}|(?:^|[\s._-]|#)\d{1,3}(?:[\s._-]|$)/i)
    show = cleanName(cut > 0 ? fname.slice(0, cut) : fname) || 'Inconnu'
  } else {
    show = cleanName(show)
  }

  return { show, season, episode, title: cleanName(fname), filePath: file, subs: subsFor(file, idx) }
}

function groupShows(parsed: ParsedEp[]): LocalShow[] {
  const byShow = new Map<string, Map<number, ParsedEp[]>>()
  for (const e of parsed) {
    let seasons = byShow.get(e.show)
    if (!seasons) byShow.set(e.show, (seasons = new Map()))
    const arr = seasons.get(e.season)
    if (arr) arr.push(e)
    else seasons.set(e.season, [e])
  }

  const shows: LocalShow[] = []
  for (const [title, seasons] of byShow) {
    const seasonArr: LocalSeason[] = [...seasons.entries()]
      .map(([season, eps]) => {
        // Assign sequential numbers to episodes we couldn't parse, keeping
        // already-numbered ones intact.
        const sorted = eps
          .slice()
          .sort((a, b) => (a.episode ?? 9999) - (b.episode ?? 9999) || a.title.localeCompare(b.title, 'fr'))
        let fallback = 1
        const episodes: LocalEpisode[] = sorted.map((e) => {
          const num = e.episode ?? fallback
          fallback = num + 1
          return {
            id: hash(e.filePath),
            season: e.season,
            episode: num,
            title: e.title,
            filePath: e.filePath,
            subs: e.subs
          }
        })
        return { season, episodes }
      })
      .sort((a, b) => a.season - b.season)
    shows.push({ id: hash(title), title, seasons: seasonArr })
  }
  return shows.sort((a, b) => a.title.localeCompare(b.title, 'fr'))
}

// In-memory cache per kind (invalidated when the configured folder changes or
// on an explicit rescan). Avoids re-walking the SSD on every section visit.
const cache = new Map<LibraryKind, { folder: string; result: ScanResult }>()

export async function scanLibrary(kind: LibraryKind, force = false): Promise<ScanResult> {
  const config = await getT7Config()
  const folder = config[kind]
  if (!folder || !existsSync(folder)) {
    cache.delete(kind)
    return { kind, available: false, movies: [], shows: [] }
  }
  const cached = cache.get(kind)
  if (!force && cached && cached.folder === folder) return cached.result

  const vids: string[] = []
  const subs: string[] = []
  await walk(folder, vids, subs)
  const idx = indexSubs(subs)

  let result: ScanResult
  if (kind === 'movies') {
    const movies = vids
      .map((f) => buildMovie(f, idx))
      .sort((a, b) => a.title.localeCompare(b.title, 'fr'))
    result = { kind, available: true, movies, shows: [] }
  } else {
    const parsed = vids.map((f) => buildEpisode(f, folder, idx))
    result = { kind, available: true, movies: [], shows: groupShows(parsed) }
  }
  cache.set(kind, { folder, result })
  return result
}

export function clearScanCache(): void {
  cache.clear()
}
