export interface Credentials {
  url: string
  username: string
  password: string
}

export interface UserInfo {
  username: string
  status: string
  auth: number
  exp_date: string | null
  is_trial: string
  active_cons: string
  max_connections: string
}

export interface Category {
  category_id: string
  category_name: string
  parent_id?: number
}

export interface LiveStream {
  num: number
  name: string
  stream_id: number
  stream_icon: string
  category_id: string
  epg_channel_id?: string | null
  tv_archive?: number
  added?: string
}

export interface VodStream {
  num: number
  name: string
  stream_id: number
  stream_icon: string
  category_id: string
  container_extension?: string
  rating?: string
  added?: string
}

export interface Series {
  num: number
  series_id: number
  name: string
  cover: string
  plot?: string
  cast?: string
  genre?: string
  rating?: string
  releaseDate?: string
  last_modified?: string
  category_id: string
  category_name?: string
}

export interface Episode {
  id: string
  episode_num: number | string
  title: string
  container_extension: string
  info?: {
    name?: string
    title?: string
    movie_image?: string
    plot?: string
    duration?: string
    rating?: number | string
  }
}

export interface SeriesInfo {
  info: {
    name?: string
    cover?: string
    plot?: string
    cast?: string
    genre?: string
    rating?: string
    releaseDate?: string
    release_date?: string
    director?: string
    actors?: string
    tmdb_id?: number | string
    episode_run_time?: number | string
  }
  seasons: { season_number: number; name?: string; cover?: string }[]
  episodes: Record<string, Episode[]>
}

export type ContentSection = 'live' | 'movies' | 'series'
export type Section = ContentSection | 'downloads' | 't7flix' | 'streamly'

/** A T7Flix local-library category, each mapped to one user-designated folder. */
export type T7Kind = 'movies' | 'series' | 'anime'

export interface T7Config {
  movies: string | null
  series: string | null
  anime: string | null
}

/** A sidecar subtitle file sitting next to a local video. */
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
  kind: T7Kind
  available: boolean
  movies: LocalMovie[]
  shows: LocalShow[]
}

// ---- T7Flix metadata (phase 2) ---------------------------------------------
export type ProviderId = 'tmdb' | 'omdb' | 'jikan'
export type MetaProvider = ProviderId | 'manual' | 'none'

export interface Meta {
  key: string
  status: 'ok' | 'notfound'
  provider: MetaProvider
  providerId?: string
  /** Display title — French when resolved, else the provider title. */
  title?: string
  originalTitle?: string
  year?: number
  poster?: string
  plot?: string
  genre?: string
  rating?: string
  runtime?: string
  /** Low-confidence auto-match → show an "à vérifier" badge. */
  needsReview?: boolean
  /** TMDB id/type — used by the poster gallery and per-season posters. */
  tmdbId?: number
  tmdbType?: 'movie' | 'tv'
  /** TMDB collection id (film saga) when the movie belongs to one. */
  collectionId?: number
  collectionName?: string
  backdrop?: string
  fetchedAt: number
}

export interface MetaRequest {
  kind: T7Kind
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

export interface T7Filter {
  id: string
  name: string
  kind: T7Kind
  keys: string[]
}

export interface MetaCandidate {
  provider: ProviderId
  providerId: string
  title: string
  year?: number
  poster?: string
  type?: string
}

/** A film saga (LOTR/Avengers/…). OMDb has no collections, so these are built
 * from sub-folders or grouped by hand; membership is by movie metaKey. */
export interface Collection {
  id: string
  name: string
  poster?: string
  keys: string[]
}

/** Per-anime custom season naming/ordering (rename seasons to their arc, reorder). */
export interface SeasonPrefs {
  labels: Record<string, string>
  order: number[]
  /** season number (string) → TMDB season number to use for episode names. */
  tmdbSeasonMap?: Record<string, number>
  /** season number (string) → first TMDB episode to include (1-based, default 1). */
  tmdbEpStart?: Record<string, number>
  /** Internal revision used to safely refresh corrected episode metadata once. */
  episodeMappingVersion?: number
}

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

export type FavoriteKind = 'live' | 'movie' | 'series'

export interface AudioTrack {
  rel: number
  lang: string
  title: string
  codec: string
  default?: boolean
}

export interface SubTrack {
  rel: number
  lang: string
  title: string
  codec: string
  bitmap: boolean
}

/** Lightweight item used by the in-player episode/collection picker. */
export interface MediaQueueItem {
  id: string
  title: string
  subtitle?: string
  src: string
  durationSecs?: number
  resumeKey?: string
  localSubs?: LocalSub[]
  audioPrefKey?: string
  local?: boolean
  /** File belongs to the configured T7 library and stops if that drive is removed. */
  requiresT7?: boolean
}
export interface MediaQueueGroup {
  id: string
  label: string
  items: MediaQueueItem[]
}

export interface Favorite {
  kind: FavoriteKind
  id: number
  name: string
  image: string
  ext?: string
  category_id?: string
}

export interface CategoryPrefs {
  /** category_ids in the user's preferred order (top to bottom). */
  order: string[]
  /** category_ids the user hid. */
  hidden: string[]
}

export interface ExternalSub {
  label: string
  url: string
  lang?: string
}

export interface MediaTarget {
  title: string
  subtitle?: string
  isLive: boolean
  /** Original stream URL (live .ts, movie or episode file); played via the remux proxy. */
  src: string
  /** Total duration in seconds for VOD, when known (enables the seek bar). */
  durationSecs?: number
  /** Stable id used to remember playback position (VOD only). */
  resumeKey?: string
  /** Skip the resume prompt and continue from the saved position immediately. */
  autoResume?: boolean
  /** Plays the previous episode, when there is one. */
  onPrev?: () => void
  /** Lazily fetched extras (duration + external subtitles), e.g. from get_vod_info. */
  fetchInfo?: () => Promise<{ durationSecs?: number; subs?: ExternalSub[] }>
  /** True for a file on the T7 SSD → playback is stopped if the drive is pulled. */
  local?: boolean
  /** True only for playback that depends on the mounted T7 library. */
  requiresT7?: boolean
  /** Sidecar subtitle files found next to a local video (burned in on demand). */
  localSubs?: LocalSub[]
  /** Stable key used to remember a preferred audio track across episodes of the same series. */
  audioPrefKey?: string
  /** Optional in-player episode/collection picker. */
  queue?: MediaQueueItem[]
  queueIndex?: number
  onQueueSelect?: (index: number, groupIndex?: number) => void
  queueGroups?: MediaQueueGroup[]
  queueGroupIndex?: number
  onQueueGroupSelect?: (index: number) => void
}

export interface OsubResult {
  fileId: number
  fileName: string
  releaseName: string
  language: string
  ext: string
  downloads: number
  rating: number
}

export type DownloadSubResult = { path: string; remaining: number } | { error: string }
