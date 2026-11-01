import { app, dialog, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// T7Flix — local library on the user's external SSD (named "T7").
// Phase 1A: only the resilience backbone — folder designation + drive
// detection. Scanning/metadata come in phase 1B.
// ---------------------------------------------------------------------------

export type LibraryKind = 'movies' | 'series' | 'anime'

export interface T7Config {
  movies: string | null
  series: string | null
  anime: string | null
}

const EMPTY: T7Config = { movies: null, series: null, anime: null }

/** Default mount point of the SSD; used to detect the drive before any folder
 * has been designated. */
const DEFAULT_VOLUME = '/Volumes/T7'

function configPath(): string {
  return join(app.getPath('userData'), 't7flix.json')
}

let config: T7Config = { ...EMPTY }
let loaded = false

async function loadConfig(): Promise<T7Config> {
  if (loaded) return config
  try {
    const raw = await readFile(configPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<T7Config>
    config = {
      movies: parsed.movies ?? null,
      series: parsed.series ?? null,
      anime: parsed.anime ?? null
    }
  } catch {
    config = { ...EMPTY }
  }
  loaded = true
  return config
}

async function saveConfig(): Promise<void> {
  try {
    await writeFile(configPath(), JSON.stringify(config, null, 2), 'utf-8')
  } catch {
    /* a write failure must never crash the app */
  }
}

export async function getT7Config(): Promise<T7Config> {
  return loadConfig()
}

export async function setT7Folder(kind: LibraryKind, path: string | null): Promise<T7Config> {
  await loadConfig()
  config[kind] = path
  await saveConfig()
  // A changed folder may sit on a different volume → re-evaluate availability.
  emit()
  return config
}

/** Native folder picker, rooted at the SSD when it's mounted. */
export async function pickFolder(win: BrowserWindow | null): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Choisir un dossier sur le T7',
    properties: ['openDirectory'],
    defaultPath: existsSync(DEFAULT_VOLUME) ? DEFAULT_VOLUME : app.getPath('home')
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
}

// ---- Custom filters (Option B: manual playlists) --------------------------

function filtersPath(): string {
  return join(app.getPath('userData'), 't7-filters.json')
}

export async function getFilters(): Promise<import('../renderer/src/types').T7Filter[]> {
  try {
    const raw = await readFile(filtersPath(), 'utf-8')
    return JSON.parse(raw) as import('../renderer/src/types').T7Filter[]
  } catch {
    return []
  }
}

export async function saveFilters(filters: import('../renderer/src/types').T7Filter[]): Promise<void> {
  try {
    await writeFile(filtersPath(), JSON.stringify(filters, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

// ---- Drive detection ------------------------------------------------------

/** "/Volumes/T7/Films" → "/Volumes/T7"; null for non-/Volumes paths. */
function volumeRootOf(p: string): string | null {
  const m = p.match(/^(\/Volumes\/[^/]+)/)
  return m ? m[1] : null
}

/** The volume mount points we must watch: the roots of the configured folders,
 * or the default SSD mount when nothing is configured yet. */
function volumeRoots(): string[] {
  const roots = new Set<string>()
  for (const kind of ['movies', 'series', 'anime'] as LibraryKind[]) {
    const p = config[kind]
    const root = p ? volumeRootOf(p) : null
    if (root) roots.add(root)
  }
  if (roots.size === 0) roots.add(DEFAULT_VOLUME)
  return [...roots]
}

/** True when every relevant volume is mounted (so the section is browseable). */
export function isT7Available(): boolean {
  const roots = volumeRoots()
  return roots.length > 0 && roots.every((r) => existsSync(r))
}

let winGetter: () => BrowserWindow | null = () => null
let lastAvailable: boolean | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let volumesWatcher: FSWatcher | null = null

function emit(): void {
  const now = isT7Available()
  if (now !== lastAvailable) {
    lastAvailable = now
    const win = winGetter()
    if (win && !win.isDestroyed()) win.webContents.send('t7:drive-status', now)
  }
}

/** Start polling + watching /Volumes so the renderer is told the instant the
 * SSD is plugged in or pulled out. Safe to call once at startup. */
export function startT7Watch(getWin: () => BrowserWindow | null): void {
  winGetter = getWin
  void loadConfig().then(() => {
    lastAvailable = null
    emit()
    if (!pollTimer) pollTimer = setInterval(emit, 2000)
    try {
      if (!volumesWatcher) volumesWatcher = watch('/Volumes', { persistent: false }, () => emit())
    } catch {
      /* fs.watch unsupported here → poll-only fallback */
    }
  })
}
