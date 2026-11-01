import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryKind } from './localLibrary'

// ---------------------------------------------------------------------------
// T7Flix — metadata + posters (phase 2). Primary provider is now TMDB (the
// user's network finally reaches api.themoviedb.org + image.tmdb.org), with the
// old providers kept as a fallback:
//   • Films / Séries / Anime → TMDB (fr-FR)   — poster, note, plot, collection
//   • Fallback Films/Séries  → OMDb (IMDb)    — when no TMDB token / no hit
//   • Fallback Anime         → Jikan/MAL      — handles versions/alias
//   • French (OMDb fallback) → Wikidata → Wikipédia FR
// IMPORTANT: TMDB only enriches show-level metadata + posters. It NEVER drives
// the season/episode structure — the user's local folders stay the source of
// truth (e.g. JoJo's split S1, Hunter x Hunter's per-arc folders). Posters can
// be customised per title (and later per season) from TMDB's gallery or a URL.
// Everything is cached on disk so each title is fetched once. Manual overrides
// ("Corriger l'association"), poster overrides and film sagas live in their own
// JSON files. No media file is ever renamed — only our sidecar JSON changes.
// ---------------------------------------------------------------------------

const UA = 'IPTVFlow/1.0 (personal media app)'

/** Free OMDb key the user generated for this app. Stored in settings so it can
 * be swapped without a rebuild; this is only the seed default. */
const DEFAULT_OMDB_KEY = 'd6e39373'

const TMDB_API = 'https://api.themoviedb.org/3'
const TMDB_IMG = 'https://image.tmdb.org/t/p'
function tmdbImg(path?: string | null, size = 'w500'): string | undefined {
  return path ? `${TMDB_IMG}/${size}${path}` : undefined
}

export type ProviderId = 'tmdb' | 'omdb' | 'jikan'
export type MetaProvider = ProviderId | 'manual' | 'none'

export interface Meta {
  key: string
  status: 'ok' | 'notfound'
  provider: MetaProvider
  providerId?: string
  /** Display title — French when we could resolve one, else the provider title. */
  title?: string
  originalTitle?: string
  year?: number
  poster?: string
  plot?: string
  genre?: string
  rating?: string
  runtime?: string
  /** Low-confidence auto-match → renderer shows an "à vérifier" badge. */
  needsReview?: boolean
  /** TMDB id/type — kept so the poster gallery and (later) per-season posters
   * can be fetched without re-searching. */
  tmdbId?: number
  tmdbType?: 'movie' | 'tv'
  /** TMDB collection id (film saga) when the movie belongs to one. */
  collectionId?: number
  collectionName?: string
  /** TMDB backdrop image URL (wide format, for detail pages). */
  backdrop?: string
  fetchedAt: number
}

export interface MetaRequest {
  kind: LibraryKind
  title: string
  year?: number
}

export interface MovieCredits {
  director?: { name: string; photo?: string }
  cast: Array<{ name: string; character?: string; photo?: string }>
}

export interface CollectionDetails {
  name?: string
  overview?: string
  poster?: string
  backdrop?: string
}

export interface MetaCandidate {
  provider: ProviderId
  providerId: string
  title: string
  year?: number
  poster?: string
  type?: string
}

export interface Collection {
  id: string
  name: string
  poster?: string
  /** metaKeys of the member movies, in display order. */
  keys: string[]
}

/** Per-show custom season naming/ordering (anime only): rename each season to
 * its arc (HxH → "Greed Island"…) and reorder them. Keyed by the show metaKey. */
export interface SeasonPrefs {
  /** season number (as string) → custom label. */
  labels: Record<string, string>
  /** season numbers in the user's preferred display order. */
  order: number[]
  /** season number (string) → TMDB season number to use for episode names. */
  tmdbSeasonMap?: Record<string, number>
  /** season number (string) → first TMDB episode to include (1-based, default 1). */
  tmdbEpStart?: Record<string, number>
  /** Internal revision used to safely refresh corrected episode metadata once. */
  episodeMappingVersion?: number
}

// TMDB keeps Phantom Blood and Battle Tendency together in season 1, whereas
// the local JoJo library intentionally keeps one folder per part. Keep the
// user's folder association and artwork intact; this only tells the metadata
// layer where each local part starts in TMDB's episode catalogue.
const JOJO_PARTS_KEY = 'anime:jojo s bizarre adventure 2012'
const JOJO_PART_TMDB_SEASONS: Record<string, number> = {
  '1': 1,
  '2': 1,
  '3': 2,
  '4': 3,
  '5': 4,
  '6': 5,
  '7': 6
}
const JOJO_PART_TMDB_EP_START: Record<string, number> = { '2': 10 }
const JOJO_PART_MAPPING_VERSION = 1

// ---- Stable key shared with the renderer (lib/metadata.ts) ----------------
// MUST stay identical on both sides: the renderer derives the same key to map
// collections/overrides onto scanned items.
export function metaKey(kind: LibraryKind, title: string, year?: number): string {
  const n = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return kind === 'movies' ? `movie:${n}:${year ?? ''}` : `${kind}:${n}`
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function parseYear(s?: string | number | null): number | undefined {
  if (s == null) return undefined
  const m = String(s).match(/(19|20)\d\d/)
  return m ? Number(m[0]) : undefined
}

function naOrUndef(s?: string): string | undefined {
  return !s || s === 'N/A' ? undefined : s
}

// ---- Per-provider serial limiters (politeness + rate limits) --------------
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
/** Serialize calls with a minimum gap between them. Jikan caps at ~3 req/s; the
 * others we just keep polite. */
function limiter(gap: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.then(() => delay(gap), () => delay(gap))
    return run
  }
}
const omdbLimit = limiter(120)
const jikanLimit = limiter(450)
const wikiLimit = limiter(200)
const tmdbLimit = limiter(60) // TMDB allows ~50 req/s; stay polite

async function getJson(url: string, timeoutMs = 9000, bearer?: string): Promise<unknown> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      }
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// ---- Persistence -----------------------------------------------------------
interface Settings {
  omdbKey: string
  /** TMDB v4 read token (Bearer). Stored in userData, never hardcoded. */
  tmdbToken: string
}
interface Store {
  cache: Record<string, Meta>
  overrides: Record<string, { provider: ProviderId; providerId: string }>
  /** Custom poster URL per key — show metaKey, or `${metaKey}#s${n}` per season. */
  posters: Record<string, string>
  /** Plex-style sort name per metaKey — overrides the display title for sorting. */
  sortNames: Record<string, string>
  collections: Collection[]
  seasonPrefs: Record<string, SeasonPrefs>
  settings: Settings
  /** Episode names cache: "${key}#ep${season}" or "${key}#all" → { episode_number: name } */
  episodeNames: Record<string, Record<number, string>>
  /** Episode thumbnail cache: same keys as episodeNames, values are still URLs. */
  episodeImages: Record<string, Record<number, string>>
  movieCredits: Record<string, MovieCredits>
  seasonPosters: Record<string, Record<number, string>>
  /**
   * Frozen metadata snapshots for locked items. When a key is present here:
   * - getMeta returns the snapshot directly (no re-fetch, no cache lookup)
   * - setOverride / clearOverride / setPoster / clearPoster / setSeasonPrefs are no-ops
   * - episode-name caches are never cleared
   * Auto-locked on first successful resolution and after manual overrides.
   */
  locked: Record<string, Meta>
}

const store: Store = {
  cache: {},
  overrides: {},
  posters: {},
  sortNames: {},
  collections: [],
  seasonPrefs: {},
  settings: { omdbKey: DEFAULT_OMDB_KEY, tmdbToken: '' },
  episodeNames: {},
  episodeImages: {},
  movieCredits: {},
  seasonPosters: {},
  locked: {}
}
let loaded = false

function file(name: string): string {
  return join(app.getPath('userData'), name)
}

async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file(name), 'utf-8')) as T
  } catch {
    return fallback
  }
}

async function load(): Promise<void> {
  if (loaded) return
  store.cache = await readJsonFile('metadata-cache.json', {})
  store.overrides = await readJsonFile('metadata-overrides.json', {})
  store.posters = await readJsonFile('poster-overrides.json', {})
  store.sortNames = await readJsonFile('sort-names.json', {})
  store.collections = await readJsonFile<Collection[]>('collections.json', [])
  store.seasonPrefs = await readJsonFile('season-prefs.json', {})
  store.episodeNames = await readJsonFile('episode-names-cache.json', {})
  store.episodeImages = await readJsonFile('episode-images-cache.json', {})
  store.movieCredits = await readJsonFile('movie-credits-cache.json', {})
  store.seasonPosters = await readJsonFile('season-posters-cache.json', {})
  store.locked = await readJsonFile('locked-keys.json', {})
  const s = await readJsonFile<Partial<Settings>>('metadata-settings.json', {})
  store.settings = { omdbKey: s.omdbKey || DEFAULT_OMDB_KEY, tmdbToken: s.tmdbToken || '' }
  loaded = true

  // One-time compatibility migration: older series/anime snapshots sometimes
  // kept an internal key without the year while the record itself was stored
  // under the current scanned-title key (for example `anime:death note 2006`).
  // The outer key is authoritative because every override/pref references it.
  let cacheMigrated = false
  let lockedMigrated = false
  for (const [key, meta] of Object.entries(store.cache)) {
    if (meta.key !== key) {
      store.cache[key] = { ...meta, key }
      cacheMigrated = true
    }
  }
  for (const [key, meta] of Object.entries(store.locked)) {
    if (meta.key !== key) {
      store.locked[key] = { ...meta, key }
      lockedMigrated = true
    }
  }
  if (cacheMigrated) persist('metadata-cache.json', store.cache)
  if (lockedMigrated) persist('locked-keys.json', store.locked)

  // Repair the previously saved JoJo configuration. Older builds exposed the
  // fields in the editor but accidentally discarded them when reading prefs,
  // so the local parts were queried as if they matched TMDB season numbers.
  const jojoPrefs = store.seasonPrefs[JOJO_PARTS_KEY]
  if (jojoPrefs) {
    const tmdbSeasonMap = { ...JOJO_PART_TMDB_SEASONS, ...(jojoPrefs.tmdbSeasonMap ?? {}) }
    const tmdbEpStart = { ...JOJO_PART_TMDB_EP_START, ...(jojoPrefs.tmdbEpStart ?? {}) }
    const changed = JSON.stringify(jojoPrefs.tmdbSeasonMap ?? {}) !== JSON.stringify(tmdbSeasonMap)
      || JSON.stringify(jojoPrefs.tmdbEpStart ?? {}) !== JSON.stringify(tmdbEpStart)
      || jojoPrefs.episodeMappingVersion !== JOJO_PART_MAPPING_VERSION
    if (changed) {
      store.seasonPrefs[JOJO_PARTS_KEY] = {
        ...jojoPrefs,
        tmdbSeasonMap,
        tmdbEpStart,
        episodeMappingVersion: JOJO_PART_MAPPING_VERSION
      }
      clearEpisodeCacheForKey(JOJO_PARTS_KEY, true)
      saveSeasonPrefsFile()
    }
  }
}

// Debounced writes — metadata fills in over a scan, so coalesce the saves.
const saveTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {}
function persist(name: string, data: unknown): void {
  if (saveTimers[name]) clearTimeout(saveTimers[name])
  saveTimers[name] = setTimeout(() => {
    void writeFile(file(name), JSON.stringify(data, null, name === 'metadata-cache.json' ? 0 : 2)).catch(
      () => undefined
    )
  }, 600)
}
const saveCache = (): void => persist('metadata-cache.json', store.cache)
const saveOverrides = (): void => persist('metadata-overrides.json', store.overrides)
const savePosters = (): void => persist('poster-overrides.json', store.posters)
const saveSortNames = (): void => persist('sort-names.json', store.sortNames)
const saveCollections = (): void => persist('collections.json', store.collections)
const saveSeasonPrefsFile = (): void => persist('season-prefs.json', store.seasonPrefs)
const saveSettings = (): void => persist('metadata-settings.json', store.settings)
const saveEpisodeNames = (): void => persist('episode-names-cache.json', store.episodeNames)
const saveEpisodeImages = (): void => persist('episode-images-cache.json', store.episodeImages)
const saveMovieCredits = (): void => persist('movie-credits-cache.json', store.movieCredits)
const saveSeasonPosters = (): void => persist('season-posters-cache.json', store.seasonPosters)
const saveLocked = (): void => persist('locked-keys.json', store.locked)

// ---- OMDb (films / séries) -------------------------------------------------
interface OmdbRec {
  Title?: string
  Year?: string
  Runtime?: string
  Genre?: string
  Plot?: string
  Poster?: string
  imdbRating?: string
  imdbID?: string
  Type?: string
  Response?: string
}

function omdbBase(): string {
  return `https://www.omdbapi.com/?apikey=${encodeURIComponent(store.settings.omdbKey)}`
}

async function omdbByTitle(title: string, year: number | undefined, type: 'movie' | 'series'): Promise<OmdbRec | null> {
  return omdbLimit(async () => {
    const tryFetch = async (withYear: boolean): Promise<OmdbRec | null> => {
      let url = `${omdbBase()}&type=${type}&t=${encodeURIComponent(title)}`
      if (withYear && year) url += `&y=${year}`
      const r = (await getJson(url)) as OmdbRec | null
      return r && r.Response === 'True' ? r : null
    }
    return (await tryFetch(true)) || (year ? await tryFetch(false) : null)
  })
}

async function omdbById(id: string): Promise<OmdbRec | null> {
  return omdbLimit(async () => {
    const r = (await getJson(`${omdbBase()}&i=${encodeURIComponent(id)}&plot=full`)) as OmdbRec | null
    return r && r.Response === 'True' ? r : null
  })
}

async function omdbSearch(query: string, type: 'movie' | 'series'): Promise<MetaCandidate[]> {
  return omdbLimit(async () => {
    const r = (await getJson(`${omdbBase()}&type=${type}&s=${encodeURIComponent(query)}`)) as
      | { Search?: OmdbRec[]; Response?: string }
      | null
    if (!r || r.Response !== 'True' || !Array.isArray(r.Search)) return []
    return r.Search.slice(0, 12).map((c) => ({
      provider: 'omdb' as const,
      providerId: c.imdbID || '',
      title: c.Title || '',
      year: parseYear(c.Year),
      poster: naOrUndef(c.Poster),
      type: c.Type
    })).filter((c) => c.providerId)
  })
}

function metaFromOmdb(key: string, rec: OmdbRec, scannedTitle: string): Meta {
  const title = rec.Title || scannedTitle
  const needsReview = !looseMatch(scannedTitle, title)
  return {
    key,
    status: 'ok',
    provider: 'omdb',
    providerId: rec.imdbID,
    title,
    originalTitle: title,
    year: parseYear(rec.Year),
    poster: naOrUndef(rec.Poster),
    plot: naOrUndef(rec.Plot),
    genre: naOrUndef(rec.Genre),
    rating: naOrUndef(rec.imdbRating),
    runtime: naOrUndef(rec.Runtime),
    needsReview,
    fetchedAt: Date.now()
  }
}

// ---- Jikan / MyAnimeList (anime) -------------------------------------------
interface JikanAnime {
  mal_id: number
  title?: string
  title_english?: string
  title_synonyms?: string[]
  titles?: { type: string; title: string }[]
  synopsis?: string
  year?: number | null
  aired?: { from?: string }
  episodes?: number | null
  score?: number | null
  members?: number | null
  genres?: { name: string }[]
  images?: { jpg?: { large_image_url?: string; image_url?: string } }
  type?: string
}

/** Common anime alias / version hints the user flagged. Bias the Jikan query so
 * "SNK" → Shingeki no Kyojin, FMA → Brotherhood, HxH → the 2011 remake. */
const ANIME_ALIASES: { test: RegExp; query: string; year?: number }[] = [
  { test: /\bsnk\b|attack on titan|attaque des titans/i, query: 'Shingeki no Kyojin' },
  { test: /full ?metal alchemist/i, query: 'Fullmetal Alchemist Brotherhood' },
  { test: /hunter ?x ?hunter|hxh/i, query: 'Hunter x Hunter', year: 2011 }
]

function poster(a: JikanAnime): string | undefined {
  return a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || undefined
}
function jikanYear(a: JikanAnime): number | undefined {
  return a.year ?? parseYear(a.aired?.from)
}

async function jikanSearch(q: string): Promise<JikanAnime[]> {
  return jikanLimit(async () => {
    const r = (await getJson(
      `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=12&sfw=false&order_by=members&sort=desc`
    )) as { data?: JikanAnime[] } | null
    return r?.data || []
  })
}

async function jikanById(id: string): Promise<JikanAnime | null> {
  return jikanLimit(async () => {
    const r = (await getJson(`https://api.jikan.moe/v4/anime/${encodeURIComponent(id)}/full`)) as
      | { data?: JikanAnime }
      | null
    return r?.data || null
  })
}

function pickAnime(list: JikanAnime[], scannedTitle: string, yearHint?: number): JikanAnime | null {
  if (!list.length) return null
  const wanted = normName(scannedTitle)
  const score = (a: JikanAnime): number => {
    const names = [a.title, a.title_english, ...(a.title_synonyms || []), ...(a.titles || []).map((t) => t.title)]
      .filter(Boolean)
      .map((n) => normName(n as string))
    let s = 0
    if (names.includes(wanted)) s += 100
    else if (names.some((n) => n.includes(wanted) || wanted.includes(n))) s += 40
    if (yearHint && jikanYear(a) === yearHint) s += 60
    // TV series outrank ONAs/specials/movies of the same name by default.
    if (a.type === 'TV') s += 8
    s += Math.min(20, Math.log10((a.members || 1) + 1) * 3) // popularity tie-break
    return s
  }
  return [...list].sort((a, b) => score(b) - score(a))[0]
}

function metaFromJikan(key: string, a: JikanAnime, scannedTitle: string, frTitle?: string): Meta {
  const display = frTitle || a.title_english || a.title || scannedTitle
  const matched =
    looseMatch(scannedTitle, a.title || '') ||
    looseMatch(scannedTitle, a.title_english || '') ||
    (a.title_synonyms || []).some((s) => looseMatch(scannedTitle, s))
  return {
    key,
    status: 'ok',
    provider: 'jikan',
    providerId: String(a.mal_id),
    title: display,
    originalTitle: a.title || display,
    year: jikanYear(a),
    poster: poster(a),
    plot: naOrUndef(a.synopsis),
    genre: (a.genres || []).map((g) => g.name).join(', ') || undefined,
    rating: a.score ? String(a.score) : undefined,
    runtime: a.episodes ? `${a.episodes} ép.` : undefined,
    needsReview: !matched,
    fetchedAt: Date.now()
  }
}

// ---- French title + synopsis (Wikidata → Wikipédia FR) ---------------------
async function frenchFromImdb(imdbID: string): Promise<{ title?: string; plot?: string } | null> {
  return wikiLimit(async () => {
    try {
      // 1. IMDb id (P345) → Wikidata entity.
      const s = (await getJson(
        `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
          'haswbstatement:P345=' + imdbID
        )}&format=json`
      )) as { query?: { search?: { title?: string }[] } } | null
      const qid = s?.query?.search?.[0]?.title
      if (!qid) return null
      // 2. Entity → French Wikipedia page title.
      const e = (await getJson(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks|labels&languages=fr&sitefilter=frwiki&format=json`
      )) as {
        entities?: Record<string, { sitelinks?: { frwiki?: { title?: string } }; labels?: { fr?: { value?: string } } }>
      } | null
      const ent = e?.entities?.[qid]
      const frTitle = ent?.sitelinks?.frwiki?.title
      const frLabel = ent?.labels?.fr?.value
      if (!frTitle) return frLabel ? { title: frLabel } : null
      // 3. French Wikipedia summary → localized synopsis.
      const sum = (await getJson(
        `https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(frTitle)}`
      )) as { extract?: string } | null
      return { title: frLabel || frTitle, plot: naOrUndef(sum?.extract) }
    } catch {
      return null
    }
  })
}

/** Loose title equality used to flag low-confidence matches. */
function looseMatch(a: string, b: string): boolean {
  const x = normName(a)
  const y = normName(b)
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

// ---- TMDB (primary: films / séries / anime) --------------------------------
interface TmdbMovie {
  id: number
  title?: string
  original_title?: string
  overview?: string
  poster_path?: string | null
  backdrop_path?: string | null
  release_date?: string
  vote_average?: number
  runtime?: number
  genres?: { name: string }[]
  belongs_to_collection?: { id: number; name: string; poster_path?: string | null } | null
}
interface TmdbTv {
  id: number
  name?: string
  original_name?: string
  overview?: string
  poster_path?: string | null
  backdrop_path?: string | null
  first_air_date?: string
  vote_average?: number
  number_of_episodes?: number
  genres?: { name: string }[]
}
interface TmdbSearchItem {
  id: number
  title?: string
  name?: string
  original_title?: string
  original_name?: string
  release_date?: string
  first_air_date?: string
  poster_path?: string | null
  vote_count?: number
}

function tmdbToken(): string {
  return store.settings.tmdbToken
}
async function tmdbGet(path: string): Promise<unknown> {
  const token = tmdbToken()
  if (!token) return null
  const sep = path.includes('?') ? '&' : '?'
  return tmdbLimit(() => getJson(`${TMDB_API}${path}${sep}language=fr-FR`, 9000, token))
}
async function tmdbGetLang(path: string, language: string): Promise<unknown> {
  const token = tmdbToken()
  if (!token) return null
  const sep = path.includes('?') ? '&' : '?'
  return tmdbLimit(() => getJson(`${TMDB_API}${path}${sep}language=${language}`, 9000, token))
}

/** Pick the closest search hit: exact title match + year, else most-voted. */
function pickTmdb(items: TmdbSearchItem[], scanned: string, yearHint?: number): TmdbSearchItem | null {
  if (!items.length) return null
  const wanted = normName(scanned)
  const score = (it: TmdbSearchItem): number => {
    const names = [it.title, it.name, it.original_title, it.original_name].filter(Boolean).map((n) => normName(n as string))
    let s = 0
    if (names.includes(wanted)) s += 100
    else if (names.some((n) => n.includes(wanted) || wanted.includes(n))) s += 40
    const y = parseYear(it.release_date || it.first_air_date)
    if (yearHint && y === yearHint) s += 60
    s += Math.min(20, Math.log10((it.vote_count || 0) + 1) * 6)
    return s
  }
  return [...items].sort((a, b) => score(b) - score(a))[0]
}

async function tmdbSearch(kind: 'movie' | 'tv', query: string, yearHint?: number): Promise<TmdbSearchItem[]> {
  const yq = kind === 'movie' && yearHint ? `&year=${yearHint}` : ''
  const r = (await tmdbGet(`/search/${kind}?include_adult=false&query=${encodeURIComponent(query)}${yq}`)) as
    | { results?: TmdbSearchItem[] }
    | null
  return r?.results || []
}

/** TMDB FR overviews are sometimes empty → backfill plot/poster/backdrop from en-US. */
async function tmdbFill(kind: 'movie' | 'tv', id: number, fr: TmdbMovie & TmdbTv): Promise<TmdbMovie & TmdbTv> {
  if (fr.overview && fr.poster_path && fr.backdrop_path) return fr
  const token = tmdbToken()
  const en = (await tmdbLimit(() =>
    getJson(`${TMDB_API}/${kind}/${id}?language=en-US`, 9000, token)
  )) as (TmdbMovie & TmdbTv) | null
  if (!en) return fr
  return {
    ...fr,
    overview: fr.overview || en.overview,
    poster_path: fr.poster_path || en.poster_path,
    backdrop_path: fr.backdrop_path || en.backdrop_path
  }
}

function rating10(v?: number): string | undefined {
  return v && v > 0 ? v.toFixed(1) : undefined
}

function metaFromTmdbMovie(key: string, m: TmdbMovie, scanned: string): Meta {
  const title = m.title || m.original_title || scanned
  return {
    key,
    status: 'ok',
    provider: 'tmdb',
    providerId: String(m.id),
    tmdbId: m.id,
    tmdbType: 'movie',
    title,
    originalTitle: m.original_title || title,
    year: parseYear(m.release_date),
    poster: tmdbImg(m.poster_path),
    backdrop: tmdbImg(m.backdrop_path, 'w1280'),
    plot: naOrUndef(m.overview),
    genre: (m.genres || []).map((g) => g.name).join(', ') || undefined,
    rating: rating10(m.vote_average),
    runtime: m.runtime ? `${m.runtime} min` : undefined,
    collectionId: m.belongs_to_collection?.id,
    collectionName: m.belongs_to_collection?.name || undefined,
    needsReview: !looseMatch(scanned, m.title || '') && !looseMatch(scanned, m.original_title || ''),
    fetchedAt: Date.now()
  }
}

function metaFromTmdbTv(key: string, t: TmdbTv, scanned: string): Meta {
  const title = t.name || t.original_name || scanned
  return {
    key,
    status: 'ok',
    provider: 'tmdb',
    providerId: String(t.id),
    tmdbId: t.id,
    tmdbType: 'tv',
    title,
    originalTitle: t.original_name || title,
    year: parseYear(t.first_air_date),
    poster: tmdbImg(t.poster_path),
    backdrop: tmdbImg(t.backdrop_path, 'w1280'),
    plot: naOrUndef(t.overview),
    genre: (t.genres || []).map((g) => g.name).join(', ') || undefined,
    rating: rating10(t.vote_average),
    runtime: t.number_of_episodes ? `${t.number_of_episodes} ép.` : undefined,
    needsReview: !looseMatch(scanned, t.name || '') && !looseMatch(scanned, t.original_name || ''),
    fetchedAt: Date.now()
  }
}

/** Resolve a request to a TMDB record (auto). Returns null if no token/no hit. */
async function tmdbResolve(req: MetaRequest, key: string): Promise<Meta | null> {
  if (!tmdbToken()) return null
  if (req.kind === 'movies') {
    const hit = pickTmdb(await tmdbSearch('movie', req.title, req.year), req.title, req.year)
    if (!hit) return null
    const d = (await tmdbGet(`/movie/${hit.id}`)) as TmdbMovie | null
    return d ? metaFromTmdbMovie(key, await tmdbFill('movie', hit.id, d as TmdbMovie & TmdbTv), req.title) : null
  }
  // series + anime → TV. Bias anime queries with the user's alias table.
  const alias = req.kind === 'anime' ? ANIME_ALIASES.find((al) => al.test.test(req.title)) : undefined
  const query = alias ? alias.query : req.title
  const yearHint = alias?.year ?? req.year
  const hit = pickTmdb(await tmdbSearch('tv', query, yearHint), query, yearHint)
  if (!hit) return null
  const d = (await tmdbGet(`/tv/${hit.id}`)) as TmdbTv | null
  return d ? metaFromTmdbTv(key, await tmdbFill('tv', hit.id, d as TmdbMovie & TmdbTv), req.title) : null
}

/** Resolve a TMDB record by explicit id (manual override / poster gallery). */
async function tmdbById(kind: LibraryKind, id: string, key: string, scanned: string): Promise<Meta | null> {
  if (req2type(kind) === 'movie') {
    const d = (await tmdbGet(`/movie/${id}`)) as TmdbMovie | null
    return d ? metaFromTmdbMovie(key, await tmdbFill('movie', Number(id), d as TmdbMovie & TmdbTv), scanned) : null
  }
  const d = (await tmdbGet(`/tv/${id}`)) as TmdbTv | null
  return d ? metaFromTmdbTv(key, await tmdbFill('tv', Number(id), d as TmdbMovie & TmdbTv), scanned) : null
}
function req2type(kind: LibraryKind): 'movie' | 'tv' {
  return kind === 'movies' ? 'movie' : 'tv'
}

// ---- Public API ------------------------------------------------------------
async function fetchMeta(req: MetaRequest, key: string): Promise<Meta> {
  const override = store.overrides[key]
  if (override) {
    if (override.provider === 'tmdb') {
      const m = await tmdbById(req.kind, override.providerId, key, req.title)
      if (m) return { ...m, provider: 'manual', needsReview: false }
    } else if (override.provider === 'jikan') {
      const a = await jikanById(override.providerId)
      if (a) {
        const fr = undefined // anime keeps its romaji/English title by design
        return { ...metaFromJikan(key, a, req.title, fr), provider: 'manual', needsReview: false }
      }
    } else {
      const rec = await omdbById(override.providerId)
      if (rec) {
        const m = metaFromOmdb(key, rec, req.title)
        const fr = rec.imdbID ? await frenchFromImdb(rec.imdbID) : null
        return { ...m, provider: 'manual', needsReview: false, title: fr?.title || m.title, plot: fr?.plot || m.plot }
      }
    }
    return { key, status: 'notfound', provider: 'manual', fetchedAt: Date.now() }
  }

  // Primary: TMDB (fr-FR). Falls through to the legacy providers below on miss.
  const tmdb = await tmdbResolve(req, key)
  if (tmdb) return tmdb

  if (req.kind === 'anime') {
    const alias = ANIME_ALIASES.find((al) => al.test.test(req.title))
    const list = await jikanSearch(alias ? alias.query : req.title)
    const best = pickAnime(list, alias ? alias.query : req.title, alias?.year ?? req.year)
    if (best) return metaFromJikan(key, best, req.title)
    return { key, status: 'notfound', provider: 'none', fetchedAt: Date.now() }
  }

  const type = req.kind === 'series' ? 'series' : 'movie'
  const rec = await omdbByTitle(req.title, req.year, type)
  if (rec) {
    const m = metaFromOmdb(key, rec, req.title)
    const fr = rec.imdbID ? await frenchFromImdb(rec.imdbID) : null
    return { ...m, title: fr?.title || m.title, plot: fr?.plot || m.plot }
  }
  return { key, status: 'notfound', provider: 'none', fetchedAt: Date.now() }
}

// Coalesce concurrent requests for the same key (the grid fires many at once).
const inflight = new Map<string, Promise<Meta>>()

/** Overlay a custom poster (set via "Changer l'affiche") on top of cached meta,
 * without polluting the cache — clearing the override restores the original. */
function withPoster(m: Meta, requestedKey = m.key): Meta {
  // Some older frozen anime snapshots carry a legacy key without the year,
  // while their poster override uses the current scanned-title key. Prefer the
  // current request key and publish that key back to the renderer.
  const p = store.posters[requestedKey] || store.posters[m.key]
  return { ...m, key: requestedKey, ...(p ? { poster: p } : {}) }
}

export async function getMeta(req: MetaRequest): Promise<Meta> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)
  // Locked items return the frozen snapshot — no re-fetch, no rescan can change them.
  // withPoster re-applied so custom poster overrides always win even post-lock.
  if (store.locked[key]) return withPoster(store.locked[key], key)
  const cached = store.cache[key]
  if (cached) return withPoster(cached, key)
  const running = inflight.get(key)
  if (running) return running
  const p = (async () => {
    const m = await fetchMeta(req, key)
    // Cache hits ("ok") permanently; cache misses too (avoid re-hammering dead
    // titles) but they're cheap to clear via a rescan/override.
    store.cache[key] = m
    saveCache()
    // Auto-lock on first successful resolution so rescans never overwrite user data.
    if (m.status === 'ok') {
      store.locked[key] = withPoster(m, key)
      saveLocked()
    }
    return withPoster(m, key)
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

export async function searchMeta(kind: LibraryKind, query: string): Promise<MetaCandidate[]> {
  await load()
  // TMDB first (when configured): same provider as the auto-match.
  if (tmdbToken()) {
    const type = req2type(kind)
    const items = await tmdbSearch(type, query)
    if (items.length) {
      return items.slice(0, 14).map((it) => ({
        provider: 'tmdb' as const,
        providerId: String(it.id),
        title: it.title || it.name || it.original_title || it.original_name || '',
        year: parseYear(it.release_date || it.first_air_date),
        poster: tmdbImg(it.poster_path),
        type
      }))
    }
  }
  if (kind === 'anime') {
    const list = await jikanSearch(query)
    return list.slice(0, 12).map((a) => ({
      provider: 'jikan' as const,
      providerId: String(a.mal_id),
      title: a.title_english || a.title || '',
      year: jikanYear(a),
      poster: poster(a),
      type: a.type
    }))
  }
  return omdbSearch(query, kind === 'series' ? 'series' : 'movie')
}

// ---- Poster customisation --------------------------------------------------
/** Find this title's TMDB id+type, from cache or a fresh search. */
async function resolveTmdbId(req: MetaRequest, key: string): Promise<{ id: number; type: 'movie' | 'tv' } | null> {
  const cached = store.cache[key]
  if (cached?.tmdbId && cached.tmdbType) return { id: cached.tmdbId, type: cached.tmdbType }
  const type = req2type(req.kind)
  const alias = req.kind === 'anime' ? ANIME_ALIASES.find((al) => al.test.test(req.title)) : undefined
  const q = alias ? alias.query : req.title
  const hit = pickTmdb(await tmdbSearch(type, q, alias?.year ?? req.year), q, alias?.year ?? req.year)
  return hit ? { id: hit.id, type } : null
}

function postersFrom(data: { posters?: { file_path?: string }[] } | null): string[] {
  const out: string[] = []
  for (const p of data?.posters || []) {
    const u = tmdbImg(p.file_path)
    if (u) out.push(u)
  }
  return out.slice(0, 24)
}

function backdropsFrom(data: { backdrops?: { file_path?: string }[] } | null): string[] {
  const out: string[] = []
  for (const image of data?.backdrops || []) {
    const url = tmdbImg(image.file_path, 'w1280')
    if (url) out.push(url)
  }
  return out.slice(0, 24)
}

function hasJapaneseScript(value?: string): boolean {
  return !!value && /[\u3040-\u30ff\u3400-\u9fff]/.test(value)
}

function imageLanguages(req: MetaRequest, key?: string): string {
  const cached = key ? store.cache[key] : undefined
  const includeJapanese = req.kind === 'anime' || hasJapaneseScript(req.title) || hasJapaneseScript(cached?.originalTitle)
  return includeJapanese ? 'fr,en,ja,null' : 'fr,en,null'
}

/** Poster choices TMDB has for this title (fr/en/no-language), as full URLs.
 * With `season`, returns that TV season's posters (falls back to show posters
 * if the season has none). Works regardless of the text-metadata provider. */
export async function getPosterOptions(req: MetaRequest, season?: number): Promise<string[]> {
  await load()
  if (!tmdbToken()) return []
  const key = metaKey(req.kind, req.title, req.year)
  const resolved = await resolveTmdbId(req, key)
  if (!resolved) return []
  const { id, type } = resolved
  if (season != null && type === 'tv') {
    const prefs = store.seasonPrefs[key]
    const tmdbSeason = prefs?.tmdbSeasonMap?.[String(season)] ?? season
    const sd = (await tmdbGet(`/tv/${id}/season/${tmdbSeason}/images?include_image_language=${imageLanguages(req, key)}`)) as
      | { posters?: { file_path?: string }[] }
      | null
    const list = postersFrom(sd)
    if (list.length) return list
    // Season has no dedicated artwork → offer the show's posters instead.
  }
  return postersFrom(
    (await tmdbGet(`/${type}/${id}/images?include_image_language=${imageLanguages(req, key)}`)) as
      | { posters?: { file_path?: string }[] }
      | null
  )
}

/** Wide TMDB artwork choices used as fixed Plex-style detail backgrounds. */
export async function getBackdropOptions(req: MetaRequest): Promise<string[]> {
  await load()
  if (!tmdbToken()) return []
  const key = metaKey(req.kind, req.title, req.year)
  const resolved = await resolveTmdbId(req, key)
  if (!resolved) return []
  return backdropsFrom(
    (await tmdbGet(
      `/${resolved.type}/${resolved.id}/images?include_image_language=${imageLanguages(req, key)}`
    )) as { backdrops?: { file_path?: string }[] } | null
  )
}

/** Director and principal cast for the Plex-style local movie detail. */
export async function getMovieCredits(req: MetaRequest): Promise<MovieCredits> {
  await load()
  if (!tmdbToken() || req.kind !== 'movies') return { cast: [] }
  const key = metaKey(req.kind, req.title, req.year)
  if (store.movieCredits[key]) return store.movieCredits[key]
  const resolved = await resolveTmdbId(req, key)
  if (!resolved || resolved.type !== 'movie') return { cast: [] }
  const data = (await tmdbGet(`/movie/${resolved.id}/credits`)) as {
    crew?: Array<{ job?: string; name?: string; profile_path?: string | null }>
    cast?: Array<{ name?: string; character?: string; profile_path?: string | null; order?: number }>
  } | null
  const directorRaw = data?.crew?.find((person) => person.job === 'Director' && person.name)
  const director = directorRaw?.name
    ? { name: directorRaw.name, photo: tmdbImg(directorRaw.profile_path, 'w185') }
    : undefined
  const cast = (data?.cast ?? [])
    .filter((person) => !!person.name)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, 8)
    .map((person) => ({
      name: person.name!,
      character: person.character || undefined,
      photo: tmdbImg(person.profile_path, 'w185')
    }))
  const result = { director, cast }
  store.movieCredits[key] = result
  saveMovieCredits()
  return result
}

/** Per-season poster URL map for the "seasons as collections" grid: TMDB season
 * artwork (best-effort by season number) overlaid with any manual override
 * (`${metaKey}#s${n}`). Local folder seasons that TMDB doesn't match simply get
 * no TMDB poster — the user sets those by hand. */
export async function getSeasonPosters(req: MetaRequest): Promise<Record<number, string>> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)
  const out: Record<number, string> = { ...(store.seasonPosters[key] ?? {}) }
  const prefs = store.seasonPrefs[key]
  const mappedSeasons = prefs?.tmdbSeasonMap ?? {}
  if (tmdbToken() && req.kind !== 'movies' && (!store.seasonPosters[key] || Object.keys(mappedSeasons).length > 0)) {
    const resolved = await resolveTmdbId(req, key)
    if (resolved && resolved.type === 'tv') {
      const d = (await tmdbGet(`/tv/${resolved.id}`)) as
        | { seasons?: { season_number?: number; poster_path?: string | null }[] }
        | null
      const byTmdbSeason: Record<number, string> = {}
      for (const s of d?.seasons || []) {
        if (s.season_number == null) continue
        const u = tmdbImg(s.poster_path)
        if (!u) continue
        byTmdbSeason[s.season_number] = u
        if (!store.seasonPosters[key]) out[s.season_number] = u
      }
      for (const [localSeason, tmdbSeasonValue] of Object.entries(mappedSeasons)) {
        const local = Number(localSeason)
        const tmdbSeason = Number(tmdbSeasonValue)
        const poster = byTmdbSeason[tmdbSeason]
        if (!Number.isNaN(local) && poster) out[local] = poster
      }
    }
    if (Object.keys(out).length) {
      store.seasonPosters[key] = { ...out }
      saveSeasonPosters()
    }
  }
  // Manual per-season overrides win.
  const prefix = `${key}#s`
  for (const k of Object.keys(store.posters)) {
    if (k.startsWith(prefix)) {
      const n = Number(k.slice(prefix.length))
      if (!Number.isNaN(n)) out[n] = store.posters[k]
    }
  }
  return out
}

export async function setPoster(key: string, url: string): Promise<void> {
  await load()
  const u = url.trim()
  if (u) store.posters[key] = u
  else delete store.posters[key]
  savePosters()
}

export async function clearPoster(key: string): Promise<void> {
  await load()
  delete store.posters[key]
  savePosters()
}

/** Returns all poster overrides whose key starts with the given prefix. */
export async function getPostersByPrefix(prefix: string): Promise<Record<string, string>> {
  await load()
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(store.posters)) {
    if (k.startsWith(prefix)) out[k] = v
  }
  return out
}

/** Re-read a title's meta with the current poster override applied (for live UI
 * refresh after the user picks/clears a custom poster). */
export async function getMetaForKey(req: MetaRequest): Promise<Meta> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)
  const cached = store.cache[key]
  if (cached) return withPoster(cached, key)
  return getMeta(req)
}

function clearEpisodeCacheForKey(key: string, force = false): void {
  if (store.locked[key] && !force) return
  const prefix = `${key}#ep`
  const allPrefix = `${key}#all`
  for (const k of Object.keys(store.episodeNames)) {
    if (k.startsWith(prefix) || k === allPrefix) delete store.episodeNames[k]
  }
  for (const k of Object.keys(store.episodeImages)) {
    if (k.startsWith(prefix) || k === allPrefix) delete store.episodeImages[k]
  }
  saveEpisodeNames()
  saveEpisodeImages()
}

export async function setOverride(
  req: MetaRequest,
  provider: ProviderId,
  providerId: string
): Promise<Meta> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)
  if (store.locked[key]) return withPoster(store.locked[key], key)
  store.overrides[key] = { provider, providerId }
  saveOverrides()
  delete store.cache[key]
  inflight.delete(key)
  clearEpisodeCacheForKey(key)
  const m = await fetchMeta(req, key)
  store.cache[key] = m
  saveCache()
  // Re-lock with the newly chosen association.
  if (m.status === 'ok') {
    store.locked[key] = withPoster(m, key)
    saveLocked()
  }
  return withPoster(m, key)
}

export async function clearOverride(req: MetaRequest): Promise<Meta> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)
  if (store.locked[key]) return withPoster(store.locked[key], key)
  delete store.overrides[key]
  saveOverrides()
  delete store.cache[key]
  inflight.delete(key)
  clearEpisodeCacheForKey(key)
  const m = await fetchMeta(req, key)
  store.cache[key] = m
  saveCache()
  return withPoster(m, key)
}

/** Fetch all TMDB seasons for a show and number episodes sequentially (1→N).
 * Specials (season 0) are skipped. Returns a global ep-number → fr-FR title map. */
async function buildTmdbGlobalMap(tmdbId: number): Promise<Record<number, string>> {
  const showData = (await tmdbGet(`/tv/${tmdbId}`)) as {
    seasons?: Array<{ season_number: number }>
  } | null
  if (!showData?.seasons) return {}
  const names: Record<number, string> = {}
  let globalEp = 0
  for (const s of showData.seasons) {
    if (s.season_number === 0) continue
    const data = (await tmdbGet(`/tv/${tmdbId}/season/${s.season_number}`)) as {
      episodes?: Array<{ episode_number: number; name?: string }>
    } | null
    for (const ep of data?.episodes ?? []) {
      globalEp++
      const n = ep.name?.trim()
      if (n && !/^(épisode|episode)\s+\d+$/i.test(n)) names[globalEp] = n
    }
  }
  return names
}


async function buildTmdbGlobalImageMap(tmdbId: number): Promise<Record<number, string>> {
  const showData = (await tmdbGet(`/tv/${tmdbId}`)) as {
    seasons?: Array<{ season_number: number }>
  } | null
  if (!showData?.seasons) return {}
  const images: Record<number, string> = {}
  let globalEp = 0
  for (const s of showData.seasons) {
    if (s.season_number === 0) continue
    const data = (await tmdbGet(`/tv/${tmdbId}/season/${s.season_number}`)) as {
      episodes?: Array<{ still_path?: string | null }>
    } | null
    for (const ep of data?.episodes ?? []) {
      globalEp++
      const still = tmdbImg(ep.still_path, 'w780')
      if (still) images[globalEp] = still
    }
  }
  return images
}

/** Fetch every Jikan episode page for a show (handles has_next_page pagination).
 * Returns a mal_id → title map (mal_id equals the global episode number on MAL). */
async function buildJikanGlobalMap(providerId: string): Promise<Record<number, string>> {
  const names: Record<number, string> = {}
  let page = 1
  let hasNext = true
  while (hasNext) {
    const data = (await jikanLimit(() =>
      getJson(`https://api.jikan.moe/v4/anime/${encodeURIComponent(providerId)}/episodes?page=${page}`)
    )) as {
      data?: Array<{ mal_id: number; title?: string; title_romanji?: string }>
      pagination?: { has_next_page?: boolean }
    } | null
    if (!data?.data) break
    for (const ep of data.data) {
      const title = ep.title || ep.title_romanji
      if (title) names[ep.mal_id] = title
    }
    hasNext = data.pagination?.has_next_page ?? false
    page++
  }
  return names
}

/**
 * Fetch episode names (fr-FR) for a TV season.
 *
 * When `globalNumbering=true` (files use a continuous count across all seasons,
 * e.g. HxH E1…E148): fetches ALL TMDB seasons at once, counts episodes 1→N
 * across the whole show, and stores a single `${key}#all` cache entry. This
 * handles cross-season arcs (Greed Island split over TMDB S1/S2) automatically.
 * Jikan is used as fallback when TMDB has no data for the show.
 *
 * When `globalNumbering=false` (normal shows): fetches the specific TMDB season,
 * respecting tmdbSeasonMap / tmdbEpStart overrides for JoJo-style splits.
 *
 * `episodeOffset` is only used in the non-global Jikan fallback path.
 */
export async function getEpisodeNames(
  req: MetaRequest,
  season: number,
  episodeOffset = 0,
  globalNumbering = false
): Promise<Record<number, string>> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)

  // ---- Global numbering: one #all entry covers the whole show ---------------
  if (globalNumbering) {
    const allKey = `${key}#all`
    const cachedAll = store.episodeNames[allKey]
    if (cachedAll && Object.keys(cachedAll).length) return cachedAll
    const meta = await getMeta(req)
    // TMDB: fetch all seasons, number episodes sequentially across the show.
    if (tmdbToken() && meta.tmdbId && meta.tmdbType === 'tv') {
      const names = await buildTmdbGlobalMap(meta.tmdbId)
      if (Object.keys(names).length) {
        store.episodeNames[allKey] = names
        saveEpisodeNames()
        return names
      }
    }
    // Jikan fallback: paginate through all episodes.
    if (req.kind === 'anime' && meta.providerId) {
      const names = await buildJikanGlobalMap(meta.providerId)
      if (Object.keys(names).length) {
        store.episodeNames[allKey] = names
        saveEpisodeNames()
        return names
      }
    }
    store.episodeNames[allKey] = {}
    saveEpisodeNames()
    return {}
  }

  // ---- Per-season path (regular shows + non-globally-numbered anime) ---------
  const cacheKey = `${key}#ep${season}`
  const cached = store.episodeNames[cacheKey]

  const names: Record<number, string> = { ...(cached ?? {}) }
  const prefs = store.seasonPrefs[key]
  const tmdbSeason = prefs?.tmdbSeasonMap?.[String(season)] ?? season
  const tmdbEpStartVal = prefs?.tmdbEpStart?.[String(season)] ?? 1

  const meta = await getMeta(req)

  if (tmdbToken() && meta.tmdbId && meta.tmdbType === 'tv') {
    const data = (await tmdbGetLang(`/tv/${meta.tmdbId}/season/${tmdbSeason}`, 'fr-FR')) as {
      episodes?: Array<{ episode_number: number; name?: string }>
    } | null
    if (data?.episodes) {
      for (const ep of data.episodes) {
        if (ep.episode_number < tmdbEpStartVal) continue
        const n = ep.name?.trim()
        if (n && !/^(épisode|episode)\s+\d+$/i.test(n)) {
          const localEp = ep.episode_number - tmdbEpStartVal + 1
          names[localEp] = n
        }
      }
    }
    // Some seasons have no translated episode titles on TMDB (The Boondocks
    // season 2 is one example). Fill only the missing/generic names from en-US.
    if ((data?.episodes?.length ?? 0) > Object.keys(names).length) {
      const english = (await tmdbGetLang(`/tv/${meta.tmdbId}/season/${tmdbSeason}`, 'en-US')) as {
        episodes?: Array<{ episode_number: number; name?: string }>
      } | null
      for (const ep of english?.episodes ?? []) {
        if (ep.episode_number < tmdbEpStartVal) continue
        const localEp = ep.episode_number - tmdbEpStartVal + 1
        if (names[localEp]) continue
        const title = ep.name?.trim()
        if (title && !/^(épisode|episode)\s+\d+$/i.test(title)) names[localEp] = title
      }
    }
  }

  // Jikan fallback (anime only, when TMDB had no result for this show)
  if (!Object.keys(names).length && req.kind === 'anime' && !meta.tmdbId && meta.providerId) {
    const startGlobal = episodeOffset + 1
    const page = Math.max(1, Math.ceil(startGlobal / 100))
    const data = (await jikanLimit(() =>
      getJson(`https://api.jikan.moe/v4/anime/${encodeURIComponent(meta.providerId!)}/episodes?page=${page}`)
    )) as { data?: Array<{ mal_id: number; title?: string; title_romanji?: string }> } | null
    if (data?.data) {
      for (const ep of data.data) {
        const title = ep.title || ep.title_romanji
        if (!title) continue
        const localEpNum = ep.mal_id - episodeOffset
        if (localEpNum >= 1) names[localEpNum] = title
      }
    }
  }

  // Only persist non-empty results: an empty cache would prevent any future
  // retry (e.g. if the TMDB token wasn't set yet when this was first called).
  if (Object.keys(names).length) {
    store.episodeNames[cacheKey] = names
    saveEpisodeNames()
  }
  return Object.keys(names).length ? names : (cached ?? {})
}

export async function getCachedEpisodeNames(
  req: MetaRequest,
  season: number,
  globalNumbering = false
): Promise<Record<number, string>> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)
  return store.episodeNames[globalNumbering ? `${key}#all` : `${key}#ep${season}`] ?? {}
}

export async function getEpisodeImages(
  req: MetaRequest,
  season: number,
  _episodeOffset = 0,
  globalNumbering = false
): Promise<Record<number, string>> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)

  if (globalNumbering) {
    const allKey = `${key}#all`
    const cachedAll = store.episodeImages[allKey]
    if (cachedAll && Object.keys(cachedAll).length) return cachedAll
    const meta = await getMeta(req)
    if (tmdbToken() && meta.tmdbId && meta.tmdbType === 'tv') {
      const images = await buildTmdbGlobalImageMap(meta.tmdbId)
      if (Object.keys(images).length) {
        store.episodeImages[allKey] = images
        saveEpisodeImages()
        return images
      }
    }
    return {}
  }

  const cacheKey = `${key}#ep${season}`
  const cached = store.episodeImages[cacheKey]
  if (cached && Object.keys(cached).length) return cached

  const images: Record<number, string> = {}
  const prefs = store.seasonPrefs[key]
  const tmdbSeason = prefs?.tmdbSeasonMap?.[String(season)] ?? season
  const tmdbEpStartVal = prefs?.tmdbEpStart?.[String(season)] ?? 1
  const meta = await getMeta(req)

  if (tmdbToken() && meta.tmdbId && meta.tmdbType === 'tv') {
    const data = (await tmdbGet(`/tv/${meta.tmdbId}/season/${tmdbSeason}`)) as {
      episodes?: Array<{ episode_number: number; still_path?: string | null }>
    } | null
    if (data?.episodes) {
      for (const ep of data.episodes) {
        if (ep.episode_number < tmdbEpStartVal) continue
        const still = tmdbImg(ep.still_path, 'w780')
        if (!still) continue
        const localEp = ep.episode_number - tmdbEpStartVal + 1
        images[localEp] = still
      }
    }
  }

  if (Object.keys(images).length) {
    store.episodeImages[cacheKey] = images
    saveEpisodeImages()
  }
  return images
}

export async function getCachedEpisodeImages(
  req: MetaRequest,
  season: number,
  globalNumbering = false
): Promise<Record<number, string>> {
  await load()
  const key = metaKey(req.kind, req.title, req.year)
  return store.episodeImages[globalNumbering ? `${key}#all` : `${key}#ep${season}`] ?? {}
}

export async function getCollections(): Promise<Collection[]> {
  await load()
  return store.collections
}

export async function saveCollectionsList(list: Collection[]): Promise<Collection[]> {
  await load()
  store.collections = list
  saveCollections()
  return store.collections
}

export async function getSeasonPrefs(key: string): Promise<SeasonPrefs> {
  await load()
  const p = store.seasonPrefs[key]
  return {
    labels: p?.labels ?? {},
    order: p?.order ?? [],
    ...(p?.tmdbSeasonMap ? { tmdbSeasonMap: p.tmdbSeasonMap } : {}),
    ...(p?.tmdbEpStart ? { tmdbEpStart: p.tmdbEpStart } : {}),
    ...(p?.episodeMappingVersion ? { episodeMappingVersion: p.episodeMappingVersion } : {})
  }
}

export async function setSeasonPrefs(key: string, prefs: SeasonPrefs): Promise<SeasonPrefs> {
  await load()
  if (store.locked[key]) return store.seasonPrefs[key] ?? { labels: {}, order: [] }
  const updated: SeasonPrefs = { labels: prefs.labels ?? {}, order: prefs.order ?? [] }
  if (prefs.tmdbSeasonMap && Object.keys(prefs.tmdbSeasonMap).length) updated.tmdbSeasonMap = prefs.tmdbSeasonMap
  if (prefs.tmdbEpStart && Object.keys(prefs.tmdbEpStart).length) updated.tmdbEpStart = prefs.tmdbEpStart
  if (prefs.episodeMappingVersion) updated.episodeMappingVersion = prefs.episodeMappingVersion
  store.seasonPrefs[key] = updated
  saveSeasonPrefsFile()
  // Mapping changed → cached episode names are stale.
  clearEpisodeCacheForKey(key)
  delete store.seasonPosters[key]
  saveSeasonPosters()
  return store.seasonPrefs[key]
}

// ---- Lock / unlock API -------------------------------------------------------
/** Lock metadata for a key — freezes the current cache snapshot. */
export async function lockMeta(key: string): Promise<void> {
  await load()
  const m = store.cache[key]
  if (!m) return
  store.locked[key] = withPoster(m, key)
  saveLocked()
}

/** Unlock metadata for a key — allows re-fetch, override, and poster changes. */
export async function unlockMeta(key: string): Promise<void> {
  await load()
  delete store.locked[key]
  saveLocked()
}

/** Return all currently locked keys. */
export async function getLockedKeys(): Promise<string[]> {
  await load()
  return Object.keys(store.locked)
}

export async function getOmdbKey(): Promise<string> {
  await load()
  return store.settings.omdbKey
}

export async function setOmdbKey(keyValue: string): Promise<void> {
  await load()
  store.settings.omdbKey = keyValue.trim() || DEFAULT_OMDB_KEY
  saveSettings()
}

export async function getSortNames(): Promise<Record<string, string>> {
  await load()
  return store.sortNames
}

export async function setSortName(key: string, name: string): Promise<void> {
  await load()
  const n = name.trim()
  if (n) store.sortNames[key] = n
  else delete store.sortNames[key]
  saveSortNames()
}

export async function getTmdbToken(): Promise<string> {
  await load()
  return store.settings.tmdbToken
}

export async function setTmdbToken(token: string): Promise<void> {
  await load()
  store.settings.tmdbToken = token.trim()
  saveSettings()
}

export async function getCollectionPosters(id: number): Promise<string[]> {
  await load()
  if (!store.settings.tmdbToken) return []
  try {
    const data = (await tmdbGet(`/collection/${id}/images?include_image_language=fr,en,null`)) as {
      posters?: { file_path: string }[]
    } | null
    return (data?.posters ?? [])
      .map((p) => tmdbImg(p.file_path, 'w500'))
      .filter((u): u is string => !!u)
  } catch {
    return []
  }
}

export async function getCollectionBackdrops(id: number): Promise<string[]> {
  await load()
  if (!store.settings.tmdbToken) return []
  try {
    const data = (await tmdbGet(`/collection/${id}/images?include_image_language=fr,en,null`)) as {
      backdrops?: { file_path: string }[]
    } | null
    return (data?.backdrops ?? [])
      .map((p) => tmdbImg(p.file_path, 'w1280'))
      .filter((u): u is string => !!u)
  } catch {
    return []
  }
}

export async function getCollectionDetails(id: number): Promise<CollectionDetails> {
  await load()
  if (!store.settings.tmdbToken || !Number.isFinite(id)) return {}
  const data = (await tmdbGet(`/collection/${id}?language=fr-FR`)) as {
    name?: string
    overview?: string
    poster_path?: string | null
    backdrop_path?: string | null
  } | null
  return data ? {
    name: data.name,
    overview: data.overview || undefined,
    poster: tmdbImg(data.poster_path, 'w500'),
    backdrop: tmdbImg(data.backdrop_path, 'w1280')
  } : {}
}

/** Re-fetches TMDB data for all cached entries that have a tmdbId but no backdrop.
 * Runs silently in the background at startup; respects the existing rate limiter. */
export async function refreshBackdrops(): Promise<void> {
  await load()
  if (!store.settings.tmdbToken) return
  const entries = Object.values(store.cache) as Meta[]
  let updated = false
  for (const entry of entries) {
    if (!entry.tmdbId || !entry.tmdbType || entry.backdrop) continue
    try {
      const raw = (await tmdbGet(`/${entry.tmdbType}/${entry.tmdbId}`)) as (TmdbMovie & TmdbTv) | null
      if (!raw?.backdrop_path) continue
      store.cache[entry.key] = { ...entry, backdrop: tmdbImg(raw.backdrop_path, 'w1280') }
      updated = true
    } catch { /* skip */ }
  }
  if (updated) saveCache()
}
