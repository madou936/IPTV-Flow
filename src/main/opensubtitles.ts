import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'

const API = 'https://api.opensubtitles.com/api/v1'
const API_KEY = (() => {
  try { return readFileSync(join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'opensubtitles-key.txt' : 'resources/opensubtitles-key.txt'), 'utf8').trim() } catch { return process.env.OPENSUBTITLES_API_KEY ?? '' }
})()
const UA = 'IPTVFlow/0.1'

// ---- File helpers ----------------------------------------------------------

function dataPath(name: string): string {
  return join(app.getPath('userData'), name)
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

// ---- Persistent settings ---------------------------------------------------

interface OsubSettings {
  username?: string
  password?: string
}

export function getOsubSettings(): { username: string; password: string; hasPassword: boolean } {
  const s = readJson<OsubSettings>(dataPath('subtitle-settings.json'), {})
  return { username: s.username ?? '', password: s.password ?? '', hasPassword: !!(s.username && s.password) }
}

export function setOsubCredentials(username: string, password: string): void {
  const s = readJson<OsubSettings>(dataPath('subtitle-settings.json'), {})
  s.username = username.trim()
  s.password = password
  writeJson(dataPath('subtitle-settings.json'), s)
  cachedToken = null
  tokenExpiry = 0
}

// ---- JWT cache (in-memory) -------------------------------------------------

let cachedToken: string | null = null
let tokenExpiry = 0

async function ensureToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken
  const s = readJson<OsubSettings>(dataPath('subtitle-settings.json'), {})
  if (!s.username || !s.password) return null
  try {
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': API_KEY, 'User-Agent': UA },
      body: JSON.stringify({ username: s.username, password: s.password })
    })
    if (!res.ok) return null
    const data = (await res.json()) as { token?: string }
    if (!data.token) return null
    cachedToken = data.token
    tokenExpiry = Date.now() + 23 * 60 * 60 * 1000 // 23 h (token valid 24 h)
    return cachedToken
  } catch {
    return null
  }
}

// ---- Search ----------------------------------------------------------------

export interface OsubResult {
  fileId: number
  fileName: string
  releaseName: string
  language: string
  ext: string
  downloads: number
  rating: number
}

export async function searchSubtitles(
  query: string,
  lang: string,
  year?: number
): Promise<OsubResult[]> {
  const params = new URLSearchParams({ query, languages: lang })
  if (year) params.set('year', String(year))
  try {
    const res = await fetch(`${API}/subtitles?${params}`, {
      headers: { 'Api-Key': API_KEY, 'User-Agent': UA }
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      data?: {
        attributes?: {
          release?: string
          language?: string
          download_count?: number
          ratings?: number
          files?: { file_id?: number; file_name?: string }[]
        }
      }[]
    }
    const out: OsubResult[] = []
    for (const item of data.data ?? []) {
      const a = item.attributes
      if (!a) continue
      for (const f of a.files ?? []) {
        if (!f.file_id) continue
        const name = f.file_name ?? ''
        const ext = name.split('.').pop()?.toLowerCase() ?? 'srt'
        out.push({
          fileId: f.file_id,
          fileName: name,
          releaseName: a.release ?? name,
          language: a.language ?? lang,
          ext,
          downloads: a.download_count ?? 0,
          rating: a.ratings ?? 0
        })
      }
    }
    return out.sort((a, b) => (b.downloads - a.downloads) || (b.rating - a.rating))
  } catch {
    return []
  }
}

// ---- Download --------------------------------------------------------------

export type DownloadSubResult =
  | { path: string; remaining: number }
  | { error: string }

export async function downloadSubtitle(
  fileId: number,
  fileName: string
): Promise<DownloadSubResult> {
  const token = await ensureToken()
  if (!token) {
    return { error: 'Connexion OpenSubtitles requise. Configure tes identifiants dans les Réglages.' }
  }

  try {
    const dlRes = await fetch(`${API}/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': API_KEY,
        'Authorization': `Bearer ${token}`,
        'User-Agent': UA
      },
      body: JSON.stringify({ file_id: fileId })
    })
    if (!dlRes.ok) {
      if (dlRes.status === 401) { cachedToken = null; tokenExpiry = 0 }
      const body = await dlRes.text().catch(() => '')
      return { error: `Erreur OpenSubtitles (${dlRes.status})${body ? ': ' + body : ''}` }
    }
    const dlData = (await dlRes.json()) as { link?: string; file_name?: string; remaining?: number }
    if (!dlData.link) return { error: 'Lien de téléchargement invalide.' }

    const subRes = await fetch(dlData.link, { headers: { 'User-Agent': UA } })
    if (!subRes.ok) return { error: `Échec du téléchargement (${subRes.status})` }
    const content = await subRes.arrayBuffer()

    const dir = join(app.getPath('userData'), 'subtitles-tmp')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const safeName = (dlData.file_name ?? fileName).replace(/[/\\:*?"<>|]/g, '_')
    const outPath = join(dir, safeName)
    writeFileSync(outPath, Buffer.from(content))

    return { path: outPath, remaining: dlData.remaining ?? 0 }
  } catch (e) {
    return { error: String(e) }
  }
}
