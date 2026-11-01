import { app, BrowserWindow, clipboard, components, dialog, ipcMain, Menu, screen, session, shell, webContents } from 'electron'
import { extname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { readFile, readdir, rm, unlink, stat, writeFile } from 'node:fs/promises'
import { getProxyPort, startProxy, probeDuration } from './proxy'
import { scanLibrary } from './scanner'
import {
  startDownload,
  cancelDownload,
  pauseDownload,
  resumeDownload,
  deleteDownload,
  listDownloads,
  onDownloadUpdate,
  openDownloadsFolder
} from './downloader'
import type { StartDownloadParams } from './downloader'
import {
  getT7Config,
  setT7Folder,
  pickFolder,
  isT7Available,
  startT7Watch,
  getFilters,
  saveFilters
} from './localLibrary'
import type { LibraryKind } from './localLibrary'
import {
  getMeta,
  searchMeta,
  setOverride,
  clearOverride,
  getPosterOptions,
  getSeasonPosters,
  setPoster,
  clearPoster,
  getMetaForKey,
  getCollections,
  saveCollectionsList,
  getSeasonPrefs,
  setSeasonPrefs,
  getOmdbKey,
  setOmdbKey,
  getSortNames,
  setSortName,
  getTmdbToken,
  setTmdbToken,
  getPostersByPrefix,
  getEpisodeNames,
  getEpisodeImages,
  lockMeta,
  unlockMeta,
  getLockedKeys,
  refreshBackdrops,
  getCollectionBackdrops,
  getCollectionPosters,
  getBackdropOptions,
  getMovieCredits,
  getCollectionDetails
} from './metadata'
import type { Collection, MetaRequest, ProviderId, SeasonPrefs } from './metadata'
import { readSidecarVtt } from './subtitles'
import { castMedia, discoverCastDevices, startLocalCast } from './cast'
import type { CastDevice } from './cast'
import { getT7TvUrl, startT7TvServer } from './t7tv'
import {
  getOsubSettings,
  setOsubCredentials,
  searchSubtitles,
  downloadSubtitle
} from './opensubtitles'
import type { OsubResult, DownloadSubResult } from './opensubtitles'
import { closeActiveStreamlyTab, closeStreamly, registerStreamly, reloadStreamly } from './streamly'

async function cleanSubtitleTmp(maxAgeDays?: number): Promise<number> {
  const dir = join(app.getPath('userData'), 'subtitles-tmp')
  let deletedBytes = 0
  try {
    const files = await readdir(dir)
    const cutoff = maxAgeDays != null ? Date.now() - maxAgeDays * 86_400_000 : Infinity
    await Promise.all(files.map(async (f) => {
      const p = join(dir, f)
      const s = await stat(p).catch(() => null)
      if (maxAgeDays != null) {
        if (!s || s.mtimeMs >= cutoff) return
      }
      if (s?.isFile()) deletedBytes += s.size
      await unlink(p).catch(() => {})
    }))
  } catch { /* dir may not exist yet */ }
  return deletedBytes
}

async function directoryBytes(path: string): Promise<number> {
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) bytes += await directoryBytes(child)
    else if (entry.isFile()) bytes += (await stat(child).catch(() => null))?.size ?? 0
  }
  return bytes
}

const disposableCacheFolders = [
  'Cache', 'Code Cache', 'GPUCache', 'GPUPersistentCache',
  'DawnGraphiteCache', 'GraphiteDawnCache', 'DawnWebGPUCache',
  'Shared Dictionary', 'VideoDecodeStats'
]
function cachePaths(): string[] {
  const userData = app.getPath('userData')
  return [userData, join(userData, 'Partitions', 'streamly')]
    .flatMap(root => disposableCacheFolders.map(name => join(root, name)))
}
async function clearDiskCacheFolders(): Promise<number> {
  let bytes = 0
  for (const path of cachePaths()) {
    bytes += await directoryBytes(path)
    await rm(path, { recursive: true, force: true }).catch(error => console.warn('Cache folder could not be removed:', path, error))
  }
  return bytes
}
async function clearBrowserCaches(): Promise<void> {
  for (const browserSession of [session.defaultSession, session.fromPartition('persist:streamly')]) {
    await browserSession.clearCache().catch(() => undefined)
    await browserSession.clearCodeCaches({}).catch(() => undefined)
  }
}
let cacheMaintenanceRunning = false
async function maintainCache(startup = false): Promise<void> {
  if (cacheMaintenanceRunning) return
  cacheMaintenanceRunning = true
  try {
    // At runtime only clean in the background, and fail closed if a frame cannot
    // be checked. This avoids deleting cache while even a muted video is playing.
    if (!startup) {
      if (BrowserWindow.getAllWindows().some(window => window.isFocused())) return
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue
        if (contents.isCurrentlyAudible()) return
        for (const frame of contents.mainFrame.framesInSubtree) {
          const playing = await frame.executeJavaScript("Array.from(document.querySelectorAll('video,audio')).some(v => !v.paused && !v.ended)").catch(() => true)
          if (playing) return
        }
      }
    }
    let bytes = 0
    for (const path of cachePaths()) bytes += await directoryBytes(path)
    if (bytes <= 500 * 1024 * 1024) return
    await clearBrowserCaches()
    await clearDiskCacheFolders()
    await cleanSubtitleTmp(3)
  } catch (error) { console.warn('Automatic cache maintenance skipped:', error) }
  finally { cacheMaintenanceRunning = false }
}

const isDev = !!process.env.ELECTRON_RENDERER_URL
const diagnostics = process.env.IPTV_FLOW_DIAGNOSTICS === '1'

// Sets the macOS menu-bar name (next to the Apple logo) and the about panel.
app.setName('IPTV Flow')

let mainWindow: BrowserWindow | null = null
let savedPipBounds: Electron.Rectangle | null = null
let pipRestoreFullscreen = false
let pendingOpenFilePaths: string[] = []
let openFilesTimer: ReturnType<typeof setTimeout> | null = null
let rendererReady = false
const videoFileExtensions = new Set(['mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv'])

function flushOpenFilePaths(): void {
  const win = mainWindow
  if (!pendingOpenFilePaths.length || !rendererReady || !win || win.isDestroyed()) return
  const paths = pendingOpenFilePaths
  pendingOpenFilePaths = []
  win.show()
  win.focus()
  win.webContents.send('media:open-files', paths)
}

ipcMain.on('media:renderer-ready', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
  rendererReady = true
  flushOpenFilePaths()
})

function queueOpenFilePath(path: string): void {
  const extension = extname(path).slice(1).toLowerCase()
  if (!videoFileExtensions.has(extension) || !existsSync(path) || pendingOpenFilePaths.includes(path)) return
  pendingOpenFilePaths.push(path)
  if (openFilesTimer) clearTimeout(openFilesTimer)
  openFilesTimer = setTimeout(() => {
    openFilesTimer = null
    flushOpenFilePaths()
  }, 120)
}

// Register before app.whenReady(): macOS can deliver a file while launching.
app.on('open-file', (event, path) => {
  event.preventDefault()
  queueOpenFilePath(path)
})

// Some macOS launch paths expose the opened document in argv instead of
// delivering open-file before the first window has loaded. Accept both forms.
if (process.platform === 'darwin') {
  for (const arg of process.argv) {
    const extension = extname(arg).slice(1).toLowerCase()
    if (videoFileExtensions.has(extension)) queueOpenFilePath(arg)
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'IPTV Flow',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 11 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  mainWindow = win
  rendererReady = false
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => { closeStreamly(); mainWindow = null; rendererReady = false })
  win.webContents.on('did-start-loading', () => { rendererReady = false })
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.meta && !input.alt && !input.shift && (input.code === 'KeyW' || input.key.toLowerCase() === 'w') && closeActiveStreamlyTab()) event.preventDefault()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (diagnostics) {
    win.webContents.on('console-message', (_event, _level, message) => {
      if (message.includes('IPTV_FLOW_DIAG')) console.log(message)
    })
    win.webContents.on('did-finish-load', () => {
      void win.webContents.executeJavaScript(`
        (() => {
          const host = window.host || {};
          console.log(JSON.stringify({
            tag: 'IPTV_FLOW_DIAG',
            event: 'renderer:loaded',
            at: Date.now(),
            diagnostics: host.diagnostics,
            debugMediaPath: host.debugMediaPath || '',
            location: window.location.href,
            bodyText: document.body ? document.body.innerText.slice(0, 200) : ''
          }));
        })()
      `).catch(() => undefined)
    })
  }

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // ECS installs and updates Widevine as a managed component. Wait for its
  // initial setup before Streamly creates any platform WebContentsViews.
  try {
    await components.whenReady()
    console.info('Streamly Widevine component status:', components.status())
  } catch (error) {
    console.warn('Streamly Widevine component is not ready; DRM playback may be unavailable:', error)
  }
  registerStreamly(() => mainWindow)
  const menu = Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Réglages…', accelerator: 'Command+,', click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('settings:open')
      } },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
    ] },
    { label: 'File', submenu: [{
      label: 'Ouvrir…', accelerator: 'Command+O', click: async () => {
        const result = await dialog.showOpenDialog({
          title: 'Ouvrir une vidéo',
          properties: ['openFile'],
          filters: [{ name: 'Vidéos', extensions: [...videoFileExtensions] }]
        })
        if (!result.canceled && result.filePaths[0]) queueOpenFilePath(result.filePaths[0])
      }
    }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Présentation', submenu: [{ label: 'Actualiser', accelerator: 'Command+R', click: () => {
      if (!reloadStreamly() && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
    } }] },
    { label: 'Window', submenu: [{ label: 'Fermer', accelerator: 'Command+W', click: () => {
      if (!closeActiveStreamlyTab()) mainWindow?.close()
    } }, { type: 'separator' }, { role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ])
  Menu.setApplicationMenu(menu)

  // Local remux proxy: converts the IPTV streams into something Chromium can
  // play (fMP4 + AAC) while leaving the video codec untouched.
  await startProxy()

  // IPTV panels rarely send CORS headers; inject a permissive one so the
  // renderer's fetch() calls and the proxy media requests just work.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Headers': ['*']
      }
    })
  })

  // Renderer reads the proxy port synchronously at preload time.
  ipcMain.on('proxy-port', (e) => {
    e.returnValue = getProxyPort()
  })

  void startT7TvServer().catch((error) => {
    console.warn('T7Flix TV server failed to start', error)
  })

  // Clear both browser partitions and only known disposable on-disk caches.
  // Cookies, local storage, IndexedDB, Widevine, metadata and downloads stay.
  ipcMain.handle('clear-cache', async () => {
    const sessions = [session.defaultSession, session.fromPartition('persist:streamly')]
    let browserBytes = 0
    for (const browserSession of sessions) {
      browserBytes += await browserSession.getCacheSize().catch(() => 0)
      await browserSession.clearCache()
      await browserSession.clearCodeCaches({}).catch(() => undefined)
      await browserSession.clearStorageData({ storages: ['cachestorage'] }).catch(() => undefined)
    }
    const diskBytes = await clearDiskCacheFolders()
    const subtitleBytes = await cleanSubtitleTmp()
    // Browser cache bytes overlap with the on-disk folders.
    return { bytes: Math.max(browserBytes, diskBytes) + subtitleBytes }
  })
  ipcMain.handle('system:open-cast-settings', async () => {
    const urls = [
      'x-apple.systempreferences:com.apple.preference.displays',
      'x-apple.systempreferences:com.apple.ControlCenter-Settings.extension'
    ]
    for (const url of urls) {
      try {
        await shell.openExternal(url)
        return true
      } catch {
        // Try the next deep-link before falling back to System Settings.
      }
    }
    try {
      await shell.openPath('/System/Applications/System Settings.app')
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('t7tv:start', async () => {
    await startT7TvServer()
    return getT7TvUrl()
  })
  ipcMain.handle('t7tv:get-url', async () => {
    await startT7TvServer()
    return getT7TvUrl()
  })
  ipcMain.handle('cast:start', async (_, src: string) => {
    const result = await startLocalCast(src)
    if (result?.url) clipboard.writeText(result.url)
    return result?.url ?? null
  })
  ipcMain.handle('cast:list-devices', () => discoverCastDevices())
  ipcMain.handle('cast:play', async (_, device: CastDevice, src: string, title: string, currentTime: number, isLive: boolean, opts?: { audio?: number; sub?: number; subBitmap?: boolean; subPath?: string }) => {
    const result = await castMedia(device, src, title, currentTime, isLive, opts)
    return result
  })

  // Download management via ffmpeg -c copy.
  ipcMain.handle('download:start', (_, p: StartDownloadParams) => startDownload(p))
  ipcMain.handle('download:cancel', (_, id: string) => cancelDownload(id))
  ipcMain.handle('download:pause', (_, id: string) => pauseDownload(id))
  ipcMain.handle('download:resume', (_, id: string) => resumeDownload(id))
  ipcMain.handle('download:delete', (_, id: string) => deleteDownload(id))
  ipcMain.handle('download:list', () => listDownloads())
  ipcMain.handle('download:open-folder', () => openDownloadsFolder())
  ipcMain.handle('xtream:export-organisation', async (e, contents: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win ?? mainWindow!, {
      title: 'Exporter l’organisation Xtream',
      defaultPath: 'IPTV Flow - organisation Xtream.json',
      filters: [{ name: 'Fichier JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, contents, 'utf8')
    return true
  })
  ipcMain.handle('xtream:pick-organisation', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? mainWindow!, {
      title: 'Importer une organisation Xtream',
      properties: ['openFile'],
      filters: [{ name: 'Fichier JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return readFile(result.filePaths[0], 'utf8')
  })

  // T7Flix local library (external SSD). Phase 1A: config + drive status.
  ipcMain.handle('t7:get-config', () => getT7Config())
  ipcMain.handle('t7:set-folder', (_, kind: LibraryKind, path: string | null) =>
    setT7Folder(kind, path)
  )
  ipcMain.handle('t7:pick-folder', (e) => pickFolder(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('t7:drive-status', () => isT7Available())
  ipcMain.handle('t7:scan', (_, kind: LibraryKind) => scanLibrary(kind, false))
  ipcMain.handle('t7:rescan', (_, kind: LibraryKind) => scanLibrary(kind, true))
  ipcMain.handle('t7:probe-duration', (_, path: string) => probeDuration(path))
  ipcMain.handle('t7:read-subtitle', (_, path: string) => readSidecarVtt(path))
  ipcMain.handle('t7:get-filters', () => getFilters())
  ipcMain.handle('t7:save-filters', (_, filters) => saveFilters(filters))
  ipcMain.handle('sub:pick-file', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? mainWindow!, {
      title: 'Choisir un fichier de sous-titres',
      filters: [{ name: 'Sous-titres', extensions: ['srt', 'ass', 'ssa', 'vtt'] }],
      properties: ['openFile']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('media:pick-files', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win ?? mainWindow!, {
      title: 'Ouvrir une ou plusieurs vidéos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Vidéos', extensions: ['mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv'] }]
    })
    return result.canceled ? [] : result.filePaths
  })

  // T7Flix metadata + posters (phase 2): OMDb / Jikan / Wikipédia FR, manual
  // associations ("Corriger") and film collections — all cached in userData.
  ipcMain.handle('meta:get', (_, req: MetaRequest) => getMeta(req))
  ipcMain.handle('meta:search', (_, kind: LibraryKind, query: string) => searchMeta(kind, query))
  ipcMain.handle('meta:set-override', (_, req: MetaRequest, provider: ProviderId, id: string) =>
    setOverride(req, provider, id)
  )
  ipcMain.handle('meta:clear-override', (_, req: MetaRequest) => clearOverride(req))
  ipcMain.handle('meta:poster-options', (_, req: MetaRequest, season?: number) =>
    getPosterOptions(req, season)
  )
  ipcMain.handle('meta:backdrop-options', (_, req: MetaRequest) => getBackdropOptions(req))
  ipcMain.handle('meta:movie-credits', (_, req: MetaRequest) => getMovieCredits(req))
  ipcMain.handle('meta:season-posters', (_, req: MetaRequest) => getSeasonPosters(req))
  ipcMain.handle('meta:set-poster', (_, key: string, url: string) => setPoster(key, url))
  ipcMain.handle('meta:clear-poster', (_, key: string) => clearPoster(key))
  ipcMain.handle('meta:meta-for-key', (_, req: MetaRequest) => getMetaForKey(req))
  ipcMain.handle('meta:get-collections', () => getCollections())
  ipcMain.handle('meta:save-collections', (_, list: Collection[]) => saveCollectionsList(list))
  ipcMain.handle('meta:get-season-prefs', (_, key: string) => getSeasonPrefs(key))
  ipcMain.handle('meta:save-season-prefs', (_, key: string, prefs: SeasonPrefs) =>
    setSeasonPrefs(key, prefs)
  )
  ipcMain.handle('meta:get-omdb-key', () => getOmdbKey())
  ipcMain.handle('meta:set-omdb-key', (_, key: string) => setOmdbKey(key))
  ipcMain.handle('meta:get-sort-names', () => getSortNames())
  ipcMain.handle('meta:set-sort-name', (_, key: string, name: string) => setSortName(key, name))
  ipcMain.handle('meta:get-tmdb-token', () => getTmdbToken())
  ipcMain.handle('meta:set-tmdb-token', (_, token: string) => setTmdbToken(token))
  ipcMain.handle('meta:get-coll-posters', () => getPostersByPrefix('coll:'))
  ipcMain.handle('meta:get-episode-names', (_, req: MetaRequest, season: number, offset: number, globalNumbering?: boolean) =>
    getEpisodeNames(req, season, offset, globalNumbering)
  )
  ipcMain.handle('meta:get-episode-images', (_, req: MetaRequest, season: number, offset: number, globalNumbering?: boolean) =>
    getEpisodeImages(req, season, offset, globalNumbering)
  )
  ipcMain.handle('meta:lock', (_, key: string) => lockMeta(key))
  ipcMain.handle('meta:unlock', (_, key: string) => unlockMeta(key))
  ipcMain.handle('meta:get-locked-keys', () => getLockedKeys())
  ipcMain.handle('meta:get-backdrop-overrides', () => getPostersByPrefix('backdrop:'))
  ipcMain.handle('meta:refresh-backdrops', () => refreshBackdrops())
  ipcMain.handle('meta:collection-posters', (_, id: number) => getCollectionPosters(id))
  ipcMain.handle('meta:collection-backdrops', (_, id: number) => getCollectionBackdrops(id))
  ipcMain.handle('meta:collection-details', (_, id: number) => getCollectionDetails(id))

  // OpenSubtitles
  ipcMain.handle('osub:get-settings', () => getOsubSettings())
  ipcMain.handle('osub:set-credentials', (_, username: string, password: string) =>
    setOsubCredentials(username, password)
  )
  ipcMain.handle('osub:search', (_, query: string, lang: string, year?: number) =>
    searchSubtitles(query, lang, year)
  )
  ipcMain.handle('osub:download', (_, fileId: number, fileName: string) =>
    downloadSubtitle(fileId, fileName)
  )

  // Push download progress updates to the renderer.
  onDownloadUpdate((item) => {
    mainWindow?.webContents.send('download:update', item)
  })

  // Bring the window back to the front — used when the user taps "expand" on
  // the PiP mini-window to return to full screen.
  ipcMain.handle('focus-window', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    if (w) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
    app.focus({ steal: true })
  })

  // Custom PiP — resize and pin the window instead of delegating to the native
  // macOS PiP API. Video, audio and subtitle overlay all stay in the same
  // renderer context, guaranteeing zero audio/video/subtitle drift.
  ipcMain.handle('pip:enter', async (event, aspectRatio?: number) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    if (!w) return
    pipRestoreFullscreen = w.isFullScreen()
    if (pipRestoreFullscreen) {
      w.setFullScreen(false)
      await new Promise((resolve) => setTimeout(resolve, 140))
    }
    savedPipBounds = w.getBounds()
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
    const pipW = 420
    const ratio = (aspectRatio && aspectRatio > 0) ? aspectRatio : 16 / 9
    const pipH = Math.round(pipW / ratio)
    w.setMinimumSize(200, 140)
    // setBounds is atomic: size + position set in one native call, no intermediate
    // flash to top-left between resize and reposition.
    w.setBounds({ x: sw - pipW - 16, y: sh - pipH - 16, width: pipW, height: pipH })
    w.setAlwaysOnTop(true, 'floating')
    w.setVisibleOnAllWorkspaces(true)
    w.setWindowButtonVisibility(false)
  })

  ipcMain.handle('pip:set-position', (event, x: number, y: number) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    if (!w) return
    w.setPosition(Math.round(x), Math.round(y))
  })

  ipcMain.handle('pip:exit', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    if (!w) return
    w.setAlwaysOnTop(false)
    w.setVisibleOnAllWorkspaces(false)
    w.setWindowButtonVisibility(true)
    w.setMinimumSize(1024, 680)
    if (savedPipBounds) {
      w.setBounds(savedPipBounds, true)
      savedPipBounds = null
    }
    if (pipRestoreFullscreen) {
      w.setFullScreen(true)
      pipRestoreFullscreen = false
    }
    w.focus()
  })

  await maintainCache(true)
  createWindow()
  const cacheMaintenanceTimer = setInterval(() => { void maintainCache() }, 10 * 60_000)
  cacheMaintenanceTimer.unref()
  void cleanSubtitleTmp(3) // delete cached subtitle files older than 3 days

  // Watch for the T7 SSD being plugged in / pulled out and tell the renderer.
  startT7Watch(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
