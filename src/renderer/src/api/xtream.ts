import type {
  Category,
  Credentials,
  Episode,
  LiveStream,
  Series,
  SeriesInfo,
  UserInfo,
  VodStream
} from '../types'

/** Normalise the panel URL: ensure a scheme, strip any trailing slash/path noise. */
export function normalizeBase(url: string): string {
  let u = url.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u
  return u.replace(/\/+$/, '')
}

function apiBase(creds: Credentials): string {
  return `${normalizeBase(creds.url)}/player_api.php`
}

async function call<T>(creds: Credentials, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({
    username: creds.username,
    password: creds.password,
    ...params
  })
  const res = await fetch(`${apiBase(creds)}?${query.toString()}`)
  if (!res.ok) throw new Error(`Le serveur a répondu ${res.status}`)
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('Réponse invalide du serveur (URL du panel incorrecte ?)')
  }
}

export interface AuthResult {
  user_info: UserInfo
  server_info: Record<string, unknown>
}

/** Validate credentials. Throws a human-readable error on failure. */
export async function authenticate(creds: Credentials): Promise<AuthResult> {
  let data: AuthResult
  try {
    data = await call<AuthResult>(creds, {})
  } catch (e) {
    throw new Error(
      (e as Error).message ||
        "Connexion impossible. Vérifie l'URL du serveur et ta connexion internet."
    )
  }
  if (!data?.user_info || Number(data.user_info.auth) !== 1) {
    throw new Error('Identifiant ou mot de passe incorrect.')
  }
  if (data.user_info.status && data.user_info.status.toLowerCase() !== 'active') {
    throw new Error(`Compte ${data.user_info.status}.`)
  }
  return data
}

// ---- Catalogue ----------------------------------------------------------

export const getLiveCategories = (c: Credentials) =>
  call<Category[]>(c, { action: 'get_live_categories' })

export const getLiveStreams = (c: Credentials, categoryId?: string) =>
  call<LiveStream[]>(c, {
    action: 'get_live_streams',
    ...(categoryId ? { category_id: categoryId } : {})
  })

export const getVodCategories = (c: Credentials) =>
  call<Category[]>(c, { action: 'get_vod_categories' })

export const getVodStreams = (c: Credentials, categoryId?: string) =>
  call<VodStream[]>(c, {
    action: 'get_vod_streams',
    ...(categoryId ? { category_id: categoryId } : {})
  })

export const getVodInfo = (c: Credentials, vodId: number) =>
  call<{ info: Record<string, unknown>; movie_data: Record<string, unknown> }>(c, {
    action: 'get_vod_info',
    vod_id: String(vodId)
  })

export const getSeriesCategories = (c: Credentials) =>
  call<Category[]>(c, { action: 'get_series_categories' })

export const getSeries = (c: Credentials, categoryId?: string) =>
  call<Series[]>(c, {
    action: 'get_series',
    ...(categoryId ? { category_id: categoryId } : {})
  })

/** Series detail: normalises seasons (some panels leave `seasons` empty). */
export async function getSeriesInfo(c: Credentials, seriesId: number): Promise<SeriesInfo> {
  const raw = await call<{
    info: SeriesInfo['info']
    seasons: SeriesInfo['seasons']
    episodes: Record<string, Episode[]>
  }>(c, { action: 'get_series_info', series_id: String(seriesId) })

  const episodeRows = raw.episodes || {}
  const episodes = Object.fromEntries(Object.entries(episodeRows).map(([season, rows]) => [
    season,
    (Array.isArray(rows) ? rows : []).map((episode) => {
      const row = episode as Episode & {
        name?: string
        episode?: string
        episode_title?: string
        episode_name?: string
      }
      const candidates = [row.info?.name, row.info?.title, row.episode_title, row.episode_name, row.name, row.title]
        .map((value) => typeof value === 'string'
          ? value.replace(/\bS\d{1,2}E\d{1,3}\b\s*[-–:·]?\s*/i, '').trim()
          : '')
      const title = candidates.find((value) => value.length > 0 && !/^(?:episode|épisode)\s*\d+$/i.test(value))
        ?? candidates.find((value) => value.length > 0)
      return { ...row, title: title || `Épisode ${row.episode_num ?? row.episode ?? ''}`.trim() }
    })
  ]))
  let seasons = raw.seasons || []
  if (!seasons.length) {
    seasons = Object.keys(episodes)
      .map((n) => ({ season_number: Number(n) }))
      .sort((a, b) => a.season_number - b.season_number)
  }
  return { info: raw.info || {}, seasons, episodes }
}

// ---- Stream URLs --------------------------------------------------------

export function liveStreamUrl(c: Credentials, streamId: number, ext: 'ts' | 'm3u8' = 'ts'): string {
  const base = normalizeBase(c.url)
  return `${base}/live/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${streamId}.${ext}`
}

export function vodStreamUrl(c: Credentials, streamId: number, ext: string): string {
  const base = normalizeBase(c.url)
  return `${base}/movie/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${streamId}.${ext || 'mp4'}`
}

export function seriesStreamUrl(c: Credentials, episodeId: string, ext: string): string {
  const base = normalizeBase(c.url)
  return `${base}/series/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${episodeId}.${ext || 'mp4'}`
}
