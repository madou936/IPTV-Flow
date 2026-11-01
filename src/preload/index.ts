import { contextBridge, ipcRenderer } from 'electron'
import type { StreamlyPlatform, StreamlyStatus } from '../shared/streamly'
import type {
  Collection,
  DownloadItem,
  DownloadSubResult,
  Meta,
  MetaCandidate,
  MetaProvider,
  MetaRequest,
  OsubResult,
  ScanResult,
  SeasonPrefs,
  StartDownloadParams,
  T7Config,
  T7Kind
} from '../renderer/src/types'

const proxyPort = ipcRenderer.sendSync('proxy-port') as number

type OpenFilesListener = (paths: string[]) => void
const openFilesListeners = new Set<OpenFilesListener>()
let pendingOpenFiles: string[][] = []
ipcRenderer.on('media:open-files', (_event, paths: string[]) => {
  if (openFilesListeners.size === 0) {
    pendingOpenFiles.push(paths)
    return
  }
  openFilesListeners.forEach((listener) => listener(paths))
})
ipcRenderer.send('media:renderer-ready')

contextBridge.exposeInMainWorld('host', {
  platform: process.platform,
  electron: process.versions.electron,
  proxyPort,
  diagnostics: process.env.IPTV_FLOW_DIAGNOSTICS === '1',
  debugMediaPath: process.env.IPTV_FLOW_DEBUG_MEDIA || '',
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  onOpenSettings: (fn: () => void): (() => void) => {
    const handler = (): void => fn()
    ipcRenderer.on('settings:open', handler)
    return () => ipcRenderer.removeListener('settings:open', handler)
  },
  system: {
    openCastSettings: (): Promise<boolean> => ipcRenderer.invoke('system:open-cast-settings'),
    startLocalCast: (src: string): Promise<string | null> => ipcRenderer.invoke('cast:start', src),
    listCastDevices: (): Promise<Array<{ id: string; name: string; host: string; port: number; model?: string }>> =>
      ipcRenderer.invoke('cast:list-devices'),
    playOnCastDevice: (
      device: { id: string; name: string; host: string; port: number; model?: string },
      src: string,
      title: string,
      currentTime: number,
      isLive: boolean,
      opts?: { audio?: number; sub?: number; subBitmap?: boolean; subPath?: string }
    ): Promise<{ url: string; playerState?: string }> =>
      ipcRenderer.invoke('cast:play', device, src, title, currentTime, isLive, opts)
  },
  pip: {
    enter: (aspectRatio?: number): Promise<void> => ipcRenderer.invoke('pip:enter', aspectRatio),
    exit: (): Promise<void> => ipcRenderer.invoke('pip:exit'),
    setPosition: (x: number, y: number): Promise<void> => ipcRenderer.invoke('pip:set-position', x, y),
  },
  streamly: {
    focus: (): Promise<void> => ipcRenderer.invoke('streamly:focus'),
    open: (platform: StreamlyPlatform, url: string, pipBounds?: { x: number; y: number; width: number; height: number }, customHome?: string, family?: string): Promise<boolean> => ipcRenderer.invoke('streamly:open', platform, url, pipBounds, customHome, family),
    siteMeta: (url: string): Promise<{ name: string; logo: string; url: string } | null> => ipcRenderer.invoke('streamly:site-meta', url),
    openMenu: (items: Array<{ id: string; name: string; logo: string }>, activeId: string, anchor: { x: number; y: number; width: number; height: number }): Promise<void> => ipcRenderer.invoke('streamly:menu-open', items, activeId, anchor),
    toast: (message: string): Promise<void> => ipcRenderer.invoke('streamly:toast', message),
    bounds: (rect: { x: number; y: number; width: number; height: number }): Promise<void> => ipcRenderer.invoke('streamly:bounds', rect),
    command: (action: string): Promise<boolean> => ipcRenderer.invoke('streamly:command', action),
    openTab: (): Promise<void> => ipcRenderer.invoke('streamly:tab-open'),
    selectTab: (id: number): Promise<void> => ipcRenderer.invoke('streamly:tab-select', id),
    closeTab: (id: number): Promise<void> => ipcRenderer.invoke('streamly:tab-close', id),
    reorderTabs: (ids: number[]): Promise<void> => ipcRenderer.invoke('streamly:tab-reorder', ids),
    close: (): Promise<void> => ipcRenderer.invoke('streamly:close'),
    onStatus: (fn: (status: StreamlyStatus) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: StreamlyStatus): void => fn(status)
      ipcRenderer.on('streamly:status', handler)
      return () => ipcRenderer.removeListener('streamly:status', handler)
    },
    onBackgroundTab: (fn: () => void): (() => void) => {
      const handler = (): void => fn()
      ipcRenderer.on('streamly:background-tab', handler)
      return () => ipcRenderer.removeListener('streamly:background-tab', handler)
    },
    onSwitchShortcut: (fn: (index: number) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, index: number): void => fn(index)
      ipcRenderer.on('streamly:switch-shortcut', handler)
      return () => ipcRenderer.removeListener('streamly:switch-shortcut', handler)
    },
    onMenuAction: (fn: (action: string, id?: string) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, action: string, id?: string): void => fn(action, id)
      ipcRenderer.on('streamly:menu-action', handler)
      return () => ipcRenderer.removeListener('streamly:menu-action', handler)
    }
  },
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  t7tv: {
    start: (): Promise<string> => ipcRenderer.invoke('t7tv:start'),
    getUrl: (): Promise<string> => ipcRenderer.invoke('t7tv:get-url')
  },
  downloads: {
    start: (p: StartDownloadParams) => ipcRenderer.invoke('download:start', p),
    cancel: (id: string) => ipcRenderer.invoke('download:cancel', id),
    pause: (id: string) => ipcRenderer.invoke('download:pause', id),
    resume: (id: string) => ipcRenderer.invoke('download:resume', id),
    delete: (id: string) => ipcRenderer.invoke('download:delete', id),
    list: (): Promise<DownloadItem[]> => ipcRenderer.invoke('download:list'),
    openFolder: (): Promise<void> => ipcRenderer.invoke('download:open-folder'),
    onUpdate: (fn: (item: DownloadItem) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, item: DownloadItem): void => fn(item)
      ipcRenderer.on('download:update', handler)
      return () => ipcRenderer.removeListener('download:update', handler)
    }
  },
  xtream: {
    exportOrganisation: (contents: string): Promise<boolean> =>
      ipcRenderer.invoke('xtream:export-organisation', contents),
    pickOrganisation: (): Promise<string | null> =>
      ipcRenderer.invoke('xtream:pick-organisation')
  },
  t7: {
    getConfig: (): Promise<T7Config> => ipcRenderer.invoke('t7:get-config'),
    setFolder: (kind: T7Kind, path: string | null): Promise<T7Config> =>
      ipcRenderer.invoke('t7:set-folder', kind, path),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('t7:pick-folder'),
    getDriveStatus: (): Promise<boolean> => ipcRenderer.invoke('t7:drive-status'),
    scan: (kind: T7Kind): Promise<ScanResult> => ipcRenderer.invoke('t7:scan', kind),
    rescan: (kind: T7Kind): Promise<ScanResult> => ipcRenderer.invoke('t7:rescan', kind),
    probeDuration: (path: string): Promise<number | undefined> =>
      ipcRenderer.invoke('t7:probe-duration', path),
    readSubtitle: (path: string): Promise<string> => ipcRenderer.invoke('t7:read-subtitle', path),
    getFilters: (): Promise<import('../renderer/src/types').T7Filter[]> => ipcRenderer.invoke('t7:get-filters'),
    saveFilters: (filters: import('../renderer/src/types').T7Filter[]): Promise<void> => ipcRenderer.invoke('t7:save-filters', filters),
    onDriveStatus: (fn: (available: boolean) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, available: boolean): void => fn(available)
      ipcRenderer.on('t7:drive-status', handler)
      return () => ipcRenderer.removeListener('t7:drive-status', handler)
    }
  },
  sub: {
    pickFile: (): Promise<string | null> => ipcRenderer.invoke('sub:pick-file')
  },
  mediaFiles: {
    pick: (): Promise<string[]> => ipcRenderer.invoke('media:pick-files'),
    onOpen: (fn: OpenFilesListener): (() => void) => {
      openFilesListeners.add(fn)
      const pending = pendingOpenFiles
      pendingOpenFiles = []
      pending.forEach((paths) => fn(paths))
      return () => openFilesListeners.delete(fn)
    }
  },
  osub: {
    getSettings: (): Promise<{ username: string; password: string; hasPassword: boolean }> =>
      ipcRenderer.invoke('osub:get-settings'),
    setCredentials: (username: string, password: string): Promise<void> =>
      ipcRenderer.invoke('osub:set-credentials', username, password),
    search: (query: string, lang: string, year?: number): Promise<OsubResult[]> =>
      ipcRenderer.invoke('osub:search', query, lang, year),
    download: (fileId: number, fileName: string): Promise<DownloadSubResult> =>
      ipcRenderer.invoke('osub:download', fileId, fileName)
  },
  meta: {
    get: (req: MetaRequest): Promise<Meta> => ipcRenderer.invoke('meta:get', req),
    search: (kind: T7Kind, query: string): Promise<MetaCandidate[]> =>
      ipcRenderer.invoke('meta:search', kind, query),
    setOverride: (req: MetaRequest, provider: MetaProvider, id: string): Promise<Meta> =>
      ipcRenderer.invoke('meta:set-override', req, provider, id),
    clearOverride: (req: MetaRequest): Promise<Meta> => ipcRenderer.invoke('meta:clear-override', req),
    posterOptions: (req: MetaRequest, season?: number): Promise<string[]> =>
      ipcRenderer.invoke('meta:poster-options', req, season),
    backdropOptions: (req: MetaRequest): Promise<string[]> =>
      ipcRenderer.invoke('meta:backdrop-options', req),
    movieCredits: (req: MetaRequest): Promise<import('../renderer/src/types').MovieCredits> =>
      ipcRenderer.invoke('meta:movie-credits', req),
    seasonPosters: (req: MetaRequest): Promise<Record<number, string>> =>
      ipcRenderer.invoke('meta:season-posters', req),
    setPoster: (key: string, url: string): Promise<void> =>
      ipcRenderer.invoke('meta:set-poster', key, url),
    clearPoster: (key: string): Promise<void> => ipcRenderer.invoke('meta:clear-poster', key),
    metaForKey: (req: MetaRequest): Promise<Meta> => ipcRenderer.invoke('meta:meta-for-key', req),
    getCollections: (): Promise<Collection[]> => ipcRenderer.invoke('meta:get-collections'),
    saveCollections: (list: Collection[]): Promise<Collection[]> =>
      ipcRenderer.invoke('meta:save-collections', list),
    getSeasonPrefs: (key: string): Promise<SeasonPrefs> =>
      ipcRenderer.invoke('meta:get-season-prefs', key),
    saveSeasonPrefs: (key: string, prefs: SeasonPrefs): Promise<SeasonPrefs> =>
      ipcRenderer.invoke('meta:save-season-prefs', key, prefs),
    getOmdbKey: (): Promise<string> => ipcRenderer.invoke('meta:get-omdb-key'),
    setOmdbKey: (key: string): Promise<void> => ipcRenderer.invoke('meta:set-omdb-key', key),
    getSortNames: (): Promise<Record<string, string>> => ipcRenderer.invoke('meta:get-sort-names'),
    setSortName: (key: string, name: string): Promise<void> =>
      ipcRenderer.invoke('meta:set-sort-name', key, name),
    getTmdbToken: (): Promise<string> => ipcRenderer.invoke('meta:get-tmdb-token'),
    setTmdbToken: (token: string): Promise<void> => ipcRenderer.invoke('meta:set-tmdb-token', token),
    getCollPosters: (): Promise<Record<string, string>> => ipcRenderer.invoke('meta:get-coll-posters'),
    getBackdropOverrides: (): Promise<Record<string, string>> => ipcRenderer.invoke('meta:get-backdrop-overrides'),
    refreshBackdrops: (): Promise<void> => ipcRenderer.invoke('meta:refresh-backdrops'),
    getEpisodeNames: (req: MetaRequest, season: number, offset: number, globalNumbering?: boolean): Promise<Record<number, string>> =>
      ipcRenderer.invoke('meta:get-episode-names', req, season, offset, globalNumbering),
    getEpisodeImages: (req: MetaRequest, season: number, offset: number, globalNumbering?: boolean): Promise<Record<number, string>> =>
      ipcRenderer.invoke('meta:get-episode-images', req, season, offset, globalNumbering),
    lockMeta: (key: string): Promise<void> => ipcRenderer.invoke('meta:lock', key),
    unlockMeta: (key: string): Promise<void> => ipcRenderer.invoke('meta:unlock', key),
    getLockedKeys: (): Promise<string[]> => ipcRenderer.invoke('meta:get-locked-keys'),
    collectionPosters: (id: number): Promise<string[]> => ipcRenderer.invoke('meta:collection-posters', id),
    collectionBackdrops: (id: number): Promise<string[]> => ipcRenderer.invoke('meta:collection-backdrops', id),
    collectionDetails: (id: number): Promise<import('../renderer/src/types').CollectionDetails> =>
      ipcRenderer.invoke('meta:collection-details', id)
  }
})
