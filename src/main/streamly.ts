import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, screen, session, WebContentsView, webFrameMain } from 'electron'
import { ElectronBlocker, Request } from '@ghostery/adblocker-electron'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Rectangle } from 'electron'
import { STREAMLY_HOME, safeStreamlyUrl } from '../shared/streamly'
import type { StreamlyPlatform, StreamlyStatus } from '../shared/streamly'

// The page itself, including its protected player and original subtitle layer,
// remains in one WebContentsView when transferred to the floating window.
let view: WebContentsView | null = null
let tabs: Array<{ id: number; view: WebContentsView; pendingUrl?: string; pendingTitle?: string }> = []
const readyViews = new Set<WebContentsView>()
let nextTabId = 1
let pipWindow: BrowserWindow | null = null
let pipGrip: WebContentsView | null = null
let menuWindow: BrowserWindow | null = null
let toastWindow: BrowserWindow | null = null
let platform: StreamlyPlatform = 'youtube'
let platformHome = STREAMLY_HOME.youtube
let platformFamily = ''
let mainBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
let mainViewAttached = false

let savedPipBounds: Rectangle | null = null
let mainGetter: () => BrowserWindow | null = () => null
let active = false
let openGeneration = 0
let closingPip = false
let pageFullScreen = false
let youtubePipStyle: { contents: Electron.WebContents; key: string } | null = null
let youtubePipStyleRevision = 0
let youtubeBlocker: ElectronBlocker | null = null
let nativePipFrame: Electron.WebFrameMain | null = null
let nativePipTimer: ReturnType<typeof setInterval> | null = null
let pipChanging = false
const pipAccelerator = 'Alt+Z'

function isNetflixProtectedHost(value: string): boolean {
  try {
    const host = new URL(value).hostname
    return ['netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxso.net', 'nflxext.com', 'nflxsearch.net'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    )
  } catch { return true }
}
function isAnimeSamaHost(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return /^(?:www\.)?anime-sama\.[a-z.]+$/.test(host)
  } catch { return false }
}

function isMovyHost(value: string): boolean {
  try { const host = new URL(value).hostname.toLowerCase(); return /^(?:www\.)?movy\.[a-z.]+$/.test(host) } catch { return false }
}

function isAnimeAdDestination(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return ['korbo.fr', 'eneba.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch { return false }
}
function blockedNavigation(url: string, source: string): boolean {
  if (!youtubeBlocker || !source || !/^https?:\/\//i.test(url)) return false
  try {
    if (new URL(url).hostname === new URL(source).hostname || isNetflixProtectedHost(url)) return false
    return youtubeBlocker.match(Request.fromRawDetails({ url, sourceUrl: source, type: 'other' })).match
  } catch { return false }
}

function setMovyPipStyle(enabled: boolean): void {
  if (!view || !(platformFamily === 'movy' || isMovyHost(platformHome))) return
  for (const frame of view.webContents.mainFrame.framesInSubtree) void frame.executeJavaScript(`(() => {
    document.getElementById('streamly-movy-captions')?.remove();
    if (!${enabled}) return;
    const style = document.createElement('style'); style.id = 'streamly-movy-captions';
    style.textContent = '.vjs-text-track-cue, .jw-captions-text, .plyr__captions, .art-subtitle, video::cue { font-size: clamp(12px, 4vmin, 22px) !important; line-height: 1.25 !important; }';
    (document.head || document.documentElement).appendChild(style);
  })()`).catch(() => undefined)
}
async function setYoutubePipStyle(enabled: boolean): Promise<void> {
  const revision = ++youtubePipStyleRevision
  const previous = youtubePipStyle
  youtubePipStyle = null
  if (previous && !previous.contents.isDestroyed()) {
    await previous.contents.removeInsertedCSS(previous.key).catch(() => undefined)
  }
  if (revision !== youtubePipStyleRevision || !enabled || !['youtube', 'prime'].includes(platform) || !view || view.webContents.isDestroyed()) return
  const contents = view.webContents
  // YouTube captions and controls are descendants of #movie_player. Keep
  // that original element on screen; a native video-only PiP loses captions.
  const key = await contents.insertCSS(platform === 'prime' ? `
    [data-testid*="xray" i], [data-automation-id*="xray" i],
    [class*="atvwebplayersdk-xray"], [class*="atvwebplayersdk-XRay"] { visibility: hidden !important; pointer-events: none !important; }
  ` : `
    html, body { overflow: hidden !important; }
    #movie_player {
      position: fixed !important; inset: 0 !important;
      width: 100vw !important; height: 100vh !important;
      z-index: 2147483647 !important; background: #000 !important;
    }
  `).catch(() => null)
  if (!key) return
  if (revision === youtubePipStyleRevision) youtubePipStyle = { contents, key }
  else if (!contents.isDestroyed()) await contents.removeInsertedCSS(key).catch(() => undefined)
}

function main(): BrowserWindow | null {
  const window = mainGetter()
  return window && !window.isDestroyed() ? window : null
}

function validSender(sender: Electron.WebContents): boolean {
  return sender === main()?.webContents
}

function sendStatus(error?: string): void {
  const window = main()
  if (!window || !active) return
  const contents = view && !view.webContents.isDestroyed() ? view.webContents : null
  const status: StreamlyStatus = {
    platform,
    url: contents?.getURL() ?? '',
    title: contents?.getTitle() ?? '',
    loading: contents?.isLoading() ?? false,
    ready: !!view && readyViews.has(view),
    canGoBack: contents?.canGoBack() ?? false,
    canGoForward: contents?.canGoForward() ?? false,
    pip: !!pipWindow || !!nativePipFrame,
    // Keep React's fullscreen layout in lockstep with the native window state.
    // A stale HTML fullscreen event must not hide the entire IPTV Flow shell.
    fullScreen: platform === 'youtube' && pageFullScreen && (pipWindow ? pipWindow.isFullScreen() : window.isFullScreen()),
    pipBounds: savedPipBounds ?? undefined,
    activeTabId: tabs.find((tab) => tab.view === view)?.id,
    tabs: tabs.map((tab) => ({ id: tab.id, title: tab.view.webContents.getTitle() || tab.pendingTitle || '', url: tab.pendingUrl ?? tab.view.webContents.getURL() })),
    error
  }
  window.webContents.send('streamly:status', status)
}

function layoutPip(): void {
  if (!pipWindow || !view || pipWindow.isDestroyed()) return
  const [width, height] = pipWindow.getContentSize()
  view.setBounds({ x: 0, y: 0, width, height })
  pipGrip?.setBounds({ x: Math.round((width - 100) / 2), y: 0, width: 100, height: 18 })
}

function releaseView(): void {
  void exitNativePip()
  if (!view && !tabs.length) return
  if (pageFullScreen) {
    pageFullScreen = false
    main()?.setFullScreen(false)
  }
  youtubePipStyle = null
  youtubePipStyleRevision++
  const owner = pipWindow && !pipWindow.isDestroyed() ? pipWindow : main()
  if (owner && view && (pipWindow || mainViewAttached)) owner.contentView.removeChildView(view)
  mainViewAttached = false
  for (const tab of tabs) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  tabs = []
  readyViews.clear()
  view = null
}

function stop(): void {
  active = false
  openGeneration++
  mainBounds = { x: 0, y: 0, width: 0, height: 0 }
  if (pageFullScreen) {
    pageFullScreen = false
    main()?.setFullScreen(false)
  }
  globalShortcut.unregister(pipAccelerator)
  releaseView()
  if (pipWindow && !pipWindow.isDestroyed()) {
    closingPip = true
    pipWindow.close()
    closingPip = false
  }
  pipWindow = null
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.close()
  menuWindow = null
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.close()
  toastWindow = null
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

function showPlatformMenu(items: Array<{ id: string; name: string; logo: string }>, activeId: string, anchor: Rectangle): void {
  const owner = main()
  if (!owner || !active) return
  if (menuWindow && !menuWindow.isDestroyed()) { menuWindow.close(); return }
  const rows = items.map((item) => `<button onclick="console.log('streamly-menu:select:${encodeURIComponent(item.id)}')">${item.logo ? `<img src="${escapeHtml(item.logo)}">` : `<i>◉</i>`}<span>${escapeHtml(item.name)}</span>${item.id === activeId ? '<b>✓</b>' : ''}</button>`).join('')
  const addIcon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>'
  const manageIcon = '<svg viewBox="0 0 24 24"><path d="M4 7h16M7 12h10M10 17h4"/><circle cx="7" cy="7" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="10" cy="17" r="1.4"/></svg>'
  const html = `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:#1b1e27;color:#f6f7fb;font:14px -apple-system,BlinkMacSystemFont,sans-serif;border:1px solid #343846;border-radius:13px;overflow-y:auto;padding:9px}header{color:#aeb4c4;font-size:11px;font-weight:700;letter-spacing:.08em;padding:8px 10px}button{display:flex;align-items:center;gap:11px;width:100%;height:43px;border:0;border-radius:9px;padding:5px 9px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}button:hover{background:#303546}img,i{width:32px;height:32px;border-radius:7px;object-fit:contain;background:transparent;display:grid;place-items:center;font-style:normal;font-weight:700}span{flex:1}b{color:#b2a5ff}hr{border:0;border-top:1px solid #343846;margin:8px 2px}footer{display:flex}footer button{font-size:14px;gap:11px}.action-icon{width:20px;height:20px;flex:0 0 20px;display:block;stroke:#b9bfd0;stroke-width:1.8;fill:none;stroke-linecap:round;stroke-linejoin:round}</style><header>PLATEFORMES</header>${rows}<hr><footer><button onclick="console.log('streamly-menu:add')"><svg class="action-icon" viewBox="0 0 24 24">${addIcon.slice(addIcon.indexOf('>') + 1, addIcon.lastIndexOf('</svg>'))}</svg><span>Ajouter une plateforme</span></button></footer><footer><button onclick="console.log('streamly-menu:manage')"><svg class="action-icon" viewBox="0 0 24 24">${manageIcon.slice(manageIcon.indexOf('>') + 1, manageIcon.lastIndexOf('</svg>'))}</svg><span>Gérer les plateformes</span></button></footer>`
  const bounds = owner.getContentBounds()
  const popup = new BrowserWindow({ x: Math.round(bounds.x + anchor.x), y: Math.round(bounds.y + anchor.y + anchor.height + 5), width: 270, height: Math.min(430, 70 + items.length * 43 + 88), parent: owner, frame: false, resizable: false, show: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#1b1e27', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  menuWindow = popup
  popup.setAlwaysOnTop(true, 'pop-up-menu')
  popup.on('closed', () => { if (menuWindow === popup) menuWindow = null })
  popup.on('blur', () => { setTimeout(() => { if (menuWindow === popup && !popup.isDestroyed() && !popup.isFocused()) popup.close() }, 150) })
  popup.webContents.on('console-message', (_event, _level, message) => {
    if (!message.startsWith('streamly-menu:')) return
    const action = decodeURIComponent(message.slice('streamly-menu:'.length))
    if (action.startsWith('select:')) owner.webContents.send('streamly:menu-action', 'select', action.slice(7))
    else if (action === 'add' || action === 'manage') owner.webContents.send('streamly:menu-action', action)
    if (menuWindow === popup && !popup.isDestroyed()) popup.close()
  })
  popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => popup.show()).catch(() => popup.close())
}

function showToast(message: string): void {
  const owner = main()
  if (!owner || !active) return
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.close()
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:transparent;color:#fff;font:13px -apple-system,sans-serif}div{margin:auto;width:max-content;max-width:400px;padding:10px 16px;border-radius:10px;background:#10131bea;border:0;box-shadow:none}</style><div>${escapeHtml(message)}</div>`
  const bounds = owner.getBounds()
  const popup = new BrowserWindow({ x: bounds.x + Math.round((bounds.width - 300) / 2), y: bounds.y + bounds.height - 76, width: 300, height: 44, parent: owner, frame: false, transparent: true, resizable: false, show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  toastWindow = popup
  popup.setAlwaysOnTop(true, 'floating')
  popup.on('closed', () => { if (toastWindow === popup) toastWindow = null })
  popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => popup.showInactive()).catch(() => popup.close())
  setTimeout(() => { if (!popup.isDestroyed()) popup.close() }, 2200)
}

function attachToMain(): void {
  const window = main()
  if (!window || !view || !readyViews.has(view)) return
  if (pipWindow) return
  if (mainBounds.width < 320 || mainBounds.height < 200) {
    if (mainViewAttached) {
      window.contentView.removeChildView(view)
      mainViewAttached = false
    }
    return
  }
  // Set the size before attaching the native child. Otherwise Electron may
  // briefly show its default view over the whole app, hiding the sidebar.
  view.setBounds(streamlyViewBounds(window))
  if (!mainViewAttached) {
    window.contentView.addChildView(view)
    mainViewAttached = true
  }
  view.webContents.setBackgroundThrottling(false)
  sendStatus()
}

function streamlyViewBounds(window: BrowserWindow): Rectangle {
  // The renderer reports the surface rectangle asynchronously. On the first
  // open (and while switching from a hidden panel), the native view can be
  // attached before ResizeObserver has delivered it. A zero or stale rect
  // must never let the web page cover the Streamly sidebar and app chrome.
  const [contentWidth, contentHeight] = window.getContentSize()
  const youtubeFullScreen = platform === 'youtube' && pageFullScreen && window.isFullScreen()
  const fallback: Rectangle = {
    x: youtubeFullScreen ? 0 : 64,
    y: youtubeFullScreen ? 0 : 46,
    width: Math.max(0, contentWidth - (youtubeFullScreen ? 0 : 64)),
    height: Math.max(0, contentHeight - (youtubeFullScreen ? 0 : 46))
  }
  if (mainBounds.width < 320 || mainBounds.height < 200) return fallback
  if (youtubeFullScreen) return mainBounds
  const x = Math.max(64, mainBounds.x)
  const y = Math.max(46, mainBounds.y)
  return {
    x,
    y,
    width: Math.max(0, Math.min(mainBounds.x + mainBounds.width, contentWidth) - x),
    height: Math.max(0, Math.min(mainBounds.y + mainBounds.height, contentHeight) - y)
  }
}

function exitPip(): void {
  if (!pipWindow || !view) return
  globalShortcut.unregister(pipAccelerator)
  const window = pipWindow
  savedPipBounds = window.getBounds()
  setMovyPipStyle(false)
  void setYoutubePipStyle(false)
  window.contentView.removeChildView(view)
  mainViewAttached = false
  pipWindow = null
  attachToMain()
  closingPip = true
  if (!window.isDestroyed()) window.close()
  closingPip = false
  main()?.show()
  main()?.focus()
  view?.webContents.focus()
}

async function exitNativePip(): Promise<void> {
  const frame = nativePipFrame
  nativePipFrame = null
  if (nativePipTimer) clearInterval(nativePipTimer)
  nativePipTimer = null
  if (frame) {
    globalShortcut.unregister(pipAccelerator)
    try { await frame.executeJavaScript('document.pictureInPictureElement ? document.exitPictureInPicture().then(() => true) : false', true) } catch { /* Frame may have navigated. */ }
    sendStatus()
  }
}

async function toggleAutomaticPip(): Promise<void> {
  if (pipChanging) return
  pipChanging = true
  try {
    if (nativePipFrame) { await exitNativePip(); return }
    if (pipWindow) { exitPip(); return }
    if (!active || !view || view.webContents.isDestroyed()) return
    const target = view
    // Netflix retains its original caption layer. For Prime, prefer the
    // compatible window when captions are present or cannot be assessed.
    const canTryNative = platform === 'youtube' || (platformFamily === 'anime' || isAnimeSamaHost(platformHome))
    if (canTryNative) {
      for (const frame of target.webContents.mainFrame.framesInSubtree) {
        try {
          const result = await frame.executeJavaScript(`(async () => {
            if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return 'closed'; }
            const videos = [...document.querySelectorAll('video')].filter(v => v.readyState >= 2 && v.videoWidth > 0);
            videos.sort((a,b) => Number(a.paused) - Number(b.paused) || b.videoWidth*b.videoHeight - a.videoWidth*a.videoHeight);
            const video = videos[0];
            if (!video) return 'no-video';
            if (${platform === 'prime'} && ([...video.textTracks].some(t => t.mode === 'showing') || [...document.querySelectorAll('[class*="captions"], [class*="subtitle"]')].some(el => el.textContent.trim() && el.getClientRects().length))) return 'captions';
            if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function' || video.disablePictureInPicture) return 'unsupported';
            await video.requestPictureInPicture();
            return document.pictureInPictureElement === video ? 'opened' : 'unsupported';
          })()`, true)
          if (result === 'closed') return
          if (result === 'captions') break
          if (result !== 'opened') continue
          if (!active || view !== target) { await frame.executeJavaScript('document.exitPictureInPicture().then(() => true)').catch(() => undefined); return }
          nativePipFrame = frame
          globalShortcut.register(pipAccelerator, () => { void toggleAutomaticPip() })
          nativePipTimer = setInterval(() => {
            void frame.executeJavaScript('!!document.pictureInPictureElement').then((open) => { if (!open && nativePipFrame === frame) void exitNativePip() }).catch(() => { if (nativePipFrame === frame) void exitNativePip() })
          }, 1000)
          sendStatus()
          return
        } catch { /* A refused native PiP falls back to the compatible window. */ }
      }
    }
    if (active && view === target) enterPip()
  } finally { pipChanging = false }
}

function enterPip(): void {
  if (!active || !view || pipWindow) return
  const window = main()
  if (!window) return
  const workArea = screen.getDisplayMatching(window.getBounds()).workArea
  const bounds = savedPipBounds ?? {
    x: workArea.x + workArea.width - 500 - 20,
    y: workArea.y + workArea.height - 320 - 20,
    width: 500,
    height: 320
  }
  savedPipBounds = bounds
  const floating = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 200,
    frame: false,
    roundedCorners: true,
    resizable: true,
    title: `Streamly · ${platform === 'prime' ? 'Prime Video' : platform === 'youtube' ? 'YouTube' : platform === 'netflix' ? 'Netflix' : 'Plateforme'}`,
    backgroundColor: '#080a10',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
  })
  floating.setWindowButtonVisibility(false)
  floating.setAlwaysOnTop(true, 'floating')
  floating.setVisibleOnAllWorkspaces(true)
  window.contentView.removeChildView(view)
  mainViewAttached = false
  pipWindow = floating
  setMovyPipStyle(true)
  globalShortcut.register(pipAccelerator, () => { if (pipWindow) exitPip() })
  floating.contentView.addChildView(view)
  // A separate transparent native view keeps drag regions away from the site's
  // controls and caption DOM, including cross-origin embedded players.
  const grip = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  pipGrip = grip
  grip.setBackgroundColor('#00000000')
  floating.contentView.addChildView(grip)
  void grip.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><style>html,body{margin:0;background:transparent;width:100%;height:100%;overflow:hidden}body{display:flex;justify-content:center;align-items:center;app-region:drag}span{width:44px;height:4px;border-radius:3px;background:#ffffff88;opacity:0;transition:opacity .15s}body:hover span{opacity:1}</style><span></span>`))
  floating.once('closed', () => { if (pipGrip === grip) pipGrip = null; if (!grip.webContents.isDestroyed()) grip.webContents.close() })
  layoutPip()
  floating.focus()
  view.webContents.focus()
  void setYoutubePipStyle(true)
  floating.on('resize', () => { layoutPip(); savedPipBounds = floating.getBounds(); sendStatus() })
  floating.on('move', () => { savedPipBounds = floating.getBounds(); sendStatus() })
  floating.on('close', () => { savedPipBounds = floating.getBounds() })
  floating.on('closed', () => {
    if (closingPip) return
    setMovyPipStyle(false)
    globalShortcut.unregister(pipAccelerator)
    pipWindow = null
    if (active && view) { void setYoutubePipStyle(false); attachToMain() }
  })
  sendStatus()
}

function command(action: string): boolean {
  if (!view || view.webContents.isDestroyed()) return false
  const contents = view.webContents
  if (action === 'back') { if (contents.canGoBack()) contents.goBack(); return true }
  if (action === 'forward') { if (contents.canGoForward()) contents.goForward(); return true }
  if (action === 'reload') { contents.reload(); return true }
  if (action === 'home') { void contents.loadURL(platformHome); return true }
  if (action === 'pip') { void toggleAutomaticPip(); return true }
  if (action === 'fullscreen') {
    void contents.executeJavaScript(`(() => {
      if (document.fullscreenElement) return document.exitFullscreen();
      const video = [...document.querySelectorAll('video')].find(v => v.readyState > 0);
      return (video ?? document.documentElement).requestFullscreen();
    })()`, true).catch(() => undefined)
    return true
  }
  if (['playpause', 'back10', 'forward10'].includes(action)) {
    const script = `(() => { const video = [...document.querySelectorAll('video')].find(v => v.readyState > 0); if (!video) return false; if (${JSON.stringify(action)} === 'playpause') { if (video.paused) void video.play(); else video.pause(); } else { video.currentTime += ${action === 'back10' ? -10 : 10}; } return true; })()`
    void contents.executeJavaScript(script, true).catch(() => undefined)
    return true
  }
  return false
}

function youtubeLink(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && (parsed.hostname === 'youtube.com' || parsed.hostname.endsWith('.youtube.com') || parsed.hostname === 'youtu.be')
  } catch { return false }
}

function isNetflixWatchPage(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.hostname === 'netflix.com' || url.hostname.endsWith('.netflix.com')) && /^\/watch(?:\/|$)/.test(url.pathname)
  } catch { return false }
}

function selectTab(id: number): void {
  const target = tabs.find((tab) => tab.id === id)
  if (!target || target.view === view) return
  void exitNativePip()
  if (pipWindow) exitPip()
  if (view) {
    void view.webContents.executeJavaScript("document.querySelectorAll('video,audio').forEach(v => v.pause())").catch(() => undefined)
    if (mainViewAttached) main()?.contentView.removeChildView(view)
    mainViewAttached = false
  }
  view = target.view
  if (target.pendingUrl) {
    const url = target.pendingUrl
    target.pendingUrl = undefined
    void view.webContents.loadURL(url).catch((error) => sendStatus(String(error)))
  }
  attachToMain()
  view.webContents.focus()
}

function closeTab(id: number): void {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const tab = tabs[index]
  if (tab.view === view) {
    if (pipWindow) exitPip()
    if (mainViewAttached) main()?.contentView.removeChildView(tab.view)
    mainViewAttached = false
    view = null
  }
  tabs.splice(index, 1)
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  if (!tabs.length && platform === 'youtube' && active) { createTab(STREAMLY_HOME.youtube, true); return }
  if (!view && tabs.length) selectTab(tabs[Math.min(index, tabs.length - 1)].id)
  sendStatus()
}

function createTab(initialUrl: string, foreground: boolean): void {
  const guest = new WebContentsView({
    webPreferences: {
      partition: 'persist:streamly',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/streamly-web.js'),
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  const tab: { id: number; view: WebContentsView; pendingUrl?: string; pendingTitle?: string } = { id: nextTabId++, view: guest, pendingUrl: !foreground && view ? initialUrl : undefined }
  tabs.push(tab)
  guest.setBackgroundColor('#080a10')
  const contents = guest.webContents
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!/^https:\/\//i.test(url)) return { action: 'deny' }
    // Anime-Sama's embedded players can open unsolicited advertising windows.
    if ((platformFamily === 'anime' || isAnimeSamaHost(platformHome)) || (platformFamily === 'movy' || isMovyHost(platformHome))) {
      if (((platformFamily === 'anime' || isAnimeSamaHost(platformHome)) && isAnimeSamaHost(url)) || ((platformFamily === 'movy' || isMovyHost(platformHome)) && isMovyHost(url))) void contents.loadURL(url).catch((error) => sendStatus(String(error)))
      return { action: 'deny' }
    }
    if (platform === 'youtube' && youtubeLink(url)) {
      createTab(url, disposition !== 'background-tab')
      return { action: 'deny' }
    }
    if (blockedNavigation(url, contents.getURL() || platformHome)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: {
          partition: 'persist:streamly',
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      }
    }
  })
  contents.on('will-navigate', (event, url) => {
    if (!/^https:\/\//i.test(url) || ((platformFamily === 'anime' || isAnimeSamaHost(platformHome)) && isAnimeAdDestination(url)) || blockedNavigation(url, contents.getURL() || platformHome)) event.preventDefault()
  })
  contents.on('did-navigate', () => { if (pipWindow) void setYoutubePipStyle(true); sendStatus() })
  contents.on('did-navigate-in-page', () => sendStatus())
  contents.on('did-frame-finish-load', (_event, _mainFrame, processId, routingId) => {
    if (pipWindow) setMovyPipStyle(true)
    const loadedFrame = webFrameMain.fromId(processId, routingId)
    if (loadedFrame) void loadedFrame.executeJavaScript(`(() => {
      if (!document.getElementById('streamly-ad-elements')) {
        const style = document.createElement('style'); style.id = 'streamly-ad-elements';
        style.textContent = 'ins.adsbygoogle, .ad-banner, .ads-banner, .advertisement, [data-ad-slot], [data-ad-unit], .popunder-overlay { display:none !important; }';
        (document.head || document.documentElement).appendChild(style);
      }
      if (!window.__streamlyAdSkip) window.__streamlyAdSkip = setInterval(() => {
        const skip = document.querySelector('.videoAdUiSkipButton, .ima-skip-button, .jw-skip.jw-skippable');
        if (skip instanceof HTMLElement && skip.getClientRects().length && skip.getAttribute('aria-disabled') !== 'true') skip.click();
      }, 1000);
    })()`).catch(() => undefined)
    if (!(platformFamily === 'anime' || isAnimeSamaHost(platformHome)) && !(platformFamily === 'movy' || isMovyHost(platformHome))) return
    const frame = webFrameMain.fromId(processId, routingId)
    if (!frame) return
    void frame.executeJavaScript(`(() => {
      if (window.__streamlyVideoKeys) return;
      window.__streamlyVideoKeys = true;
      document.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
        const target = e.target;
        if (target instanceof Element && (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || target.closest('[role="textbox"]'))) return;
        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space','Escape'].includes(e.code)) return;
        const video = [...document.querySelectorAll('video')].find(v => v.readyState > 0);
        if (!video) return;
        if (e.code === 'Escape') { if (document.fullscreenElement) { e.preventDefault(); void document.exitFullscreen(); } return; }
        e.preventDefault(); e.stopPropagation();
        if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { video.volume = Math.max(0, Math.min(1, video.volume + (e.code === 'ArrowUp' ? .1 : -.1))); video.muted = false; }
        else if (e.code === 'Space') { if (video.paused) void video.play().catch(() => {}); else video.pause(); }
        else video.currentTime = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : Infinity, video.currentTime + (e.code === 'ArrowLeft' ? -10 : 10)));
      }, true);
    })()`).catch(() => undefined)
  })
  contents.on('enter-html-full-screen', () => {
    pageFullScreen = true
    const owner = pipWindow ?? main()
    if (platform === 'youtube' && owner && !owner.isFullScreen()) {
      setTimeout(() => { if (!owner.isDestroyed() && pageFullScreen && !owner.isFullScreen()) owner.setFullScreen(true) }, 150)
    }
    sendStatus()
    setTimeout(sendStatus, 400)
  })
  contents.on('leave-html-full-screen', () => {
    pageFullScreen = false
    const owner = pipWindow ?? main()
    const wasFullScreen = platform === 'youtube' && !!owner?.isFullScreen()
    if (platform === 'youtube' && !pipWindow) {
      void setYoutubePipStyle(false)
      // The renderer reports the restored surface after leaving fullscreen.
      // Never reuse mainBounds here: it can still be the fullscreen rectangle.
      const restoreLayout = (): void => {
        if (active && view === guest && !pageFullScreen) {
          attachToMain()
          void contents.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => undefined)
        }
      }
      if (wasFullScreen && owner) {
        owner.once('leave-full-screen', restoreLayout)
        setTimeout(() => { if (!owner.isDestroyed() && !pageFullScreen && owner.isFullScreen()) owner.setFullScreen(false) }, 150)
      }
      else setTimeout(restoreLayout, 450)
    }
    sendStatus()
  })
  contents.on('page-title-updated', () => sendStatus())
  contents.on('did-start-loading', () => sendStatus())
  contents.on('did-stop-loading', () => sendStatus())
  contents.on('did-finish-load', () => {
    readyViews.add(guest)
    if (view === guest && active && !pipWindow) attachToMain()
    sendStatus()
    if (platform === 'youtube') void contents.executeJavaScript(`(() => {
      if (window.__streamlySwipeInstalled) return;
      window.__streamlySwipeInstalled = true;
      let total = 0, last = 0, lockedUntil = 0;
      window.addEventListener('wheel', event => {
        if (event.ctrlKey || event.metaKey || event.altKey || Math.abs(event.deltaX) < Math.abs(event.deltaY) * 1.4) return;
        const now = Date.now();
        if (now < lockedUntil) return;
        for (let el = event.target instanceof Element ? event.target : null; el; el = el.parentElement) {
          const style = getComputedStyle(el);
          if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2 && ((event.deltaX < 0 && el.scrollLeft > 1) || (event.deltaX > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1))) { total = 0; return; }
        }
        if (now - last > 180) total = 0;
        last = now; total += event.deltaX;
        if (Math.abs(total) > 120) { const delta = total; total = 0; lockedUntil = now + 1000; if (delta < 0) history.back(); else history.forward(); }
      }, { passive: true });
    })()`).catch(() => undefined)
    if (platform === 'netflix') void contents.insertCSS('[data-uia="pause-ad"] { display: none !important; }').catch(() => undefined)
    if ((platformFamily === 'anime' || isAnimeSamaHost(platformHome))) void contents.insertCSS(`
      .adsbygoogle, [data-ad-slot], [data-ad-unit], [class*="ad-slot"], [class*="ad-banner"],
      [class*="advertisement"], [class*="popunder"], [id^="pub-"],
      a[href*="korbo.fr"], a[href*="eneba.com"],
      aside:has(a[href*="korbo.fr"]), aside:has(a[href*="eneba.com"]),
      div[class*="ad-"]:has(a[href*="korbo.fr"]), div[class*="ad-"]:has(a[href*="eneba.com"])
      { display: none !important; }
    `).catch(() => undefined)
    if (platform === 'youtube') void contents.insertCSS(`
      ytd-ad-slot-renderer, ytd-promoted-video-renderer, ytd-display-ad-renderer,
      ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer,
      ytd-promoted-sparkles-web-renderer, ytd-action-companion-ad-renderer,
      ytd-search-pyv-renderer, ytd-video-masthead-ad-v3-renderer, #masthead-ad,
      ytd-ad-slot-renderer, ytd-companion-slot-renderer, ytd-player-legacy-desktop-watch-ads-renderer,
      ytd-rich-section-renderer:has(ytd-ad-slot-renderer), ytd-rich-item-renderer:has([is-ad]),
      #player-ads, .ytp-ad-overlay-container, .ytd-display-ad-renderer, ytd-merch-shelf-renderer,
      ytd-rich-item-renderer:has(ytd-ad-slot-renderer) { display: none !important; }
    `).catch(() => undefined)
    if (platform === 'youtube') void contents.executeJavaScript(`(() => {
      if (window.__streamlySkipTimer) return;
      const skip = () => {
        const button = document.querySelector('.ytp-ad-skip-button-modern, .ytp-ad-skip-button');
        if (button instanceof HTMLElement && button.offsetParent !== null) button.click();
      };
      let observed = null;
      const observer = new MutationObserver(skip);
      const watchPlayer = () => {
        const player = document.querySelector('#movie_player');
        if (player && player !== observed) { observer.disconnect(); observed = player; observer.observe(player, { childList: true, subtree: true }); }
        skip();
      };
      window.__streamlySkipTimer = setInterval(watchPlayer, 1000);
      watchPlayer();
    })()`).catch(() => undefined)
  })
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && view === guest) {
      readyViews.delete(guest)
      if (mainViewAttached) {
        main()?.contentView.removeChildView(guest)
        mainViewAttached = false
      }
      sendStatus(description)
    }
  })
  contents.on('media-started-playing', () => {
    if (view !== guest) void contents.executeJavaScript("document.querySelectorAll('video,audio').forEach(v => v.pause())").catch(() => undefined)
  })
  contents.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = []
    if (platform === 'youtube' && youtubeLink(params.linkURL)) {
      items.push({ label: 'Ouvrir le lien dans un nouvel onglet', click: () => createTab(params.linkURL, false) })
      items.push({ label: 'Copier l’adresse du lien', click: () => clipboard.writeText(params.linkURL) })
      items.push({ type: 'separator' })
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
    else if (params.selectionText) items.push({ label: 'Copier', click: () => contents.copy() })
    else items.push({ label: 'Retour', enabled: contents.canGoBack(), click: () => contents.goBack() }, { label: 'Suivant', enabled: contents.canGoForward(), click: () => contents.goForward() }, { label: 'Actualiser', click: () => contents.reload() })
    Menu.buildFromTemplate(items).popup({ window: pipWindow ?? main() ?? undefined })
  })
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.code === 'Escape' && !input.alt && !input.meta && !input.control && platform.startsWith('custom:') && !pageFullScreen) {
      const focused = contents.focusedFrame ?? contents.mainFrame
      void focused.executeJavaScript(`(() => {
        const target = document.activeElement;
        return !(target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="menu"],[role="listbox"],[role="dialog"]')) && ![...document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"]')].some(el => el.getClientRects().length);
      })()`).then(async allowed => {
        if (!allowed || view !== guest || !active || contents.isDestroyed()) return;
        let hasVideo = false;
        for (const frame of contents.mainFrame.framesInSubtree) {
          const found = await frame.executeJavaScript("[...document.querySelectorAll('video')].some(v => v.readyState > 0 && v.getClientRects().length > 0)").catch(() => false);
          if (found) hasVideo = true;
        }
        if (!hasVideo || contents.isDestroyed() || view !== guest) return;
        if (pipWindow) { exitPip(); return; }
        for (const frame of contents.mainFrame.framesInSubtree) void frame.executeJavaScript("document.querySelectorAll('video,audio').forEach(v => v.pause())").catch(() => undefined);
        if (contents.canGoBack()) contents.goBack();
        else void contents.loadURL(platformHome);
      }).catch(() => undefined);
    }
    if (platform === 'netflix' && input.code === 'Escape' && isNetflixWatchPage(contents.getURL())) {
      event.preventDefault()
      if (pageFullScreen) {
        pageFullScreen = false
        const owner = pipWindow ?? main()
        if (owner?.isFullScreen()) owner.setFullScreen(false)
      }
      if (contents.canGoBack()) contents.goBack()
      else void contents.loadURL('https://www.netflix.com/browse')
      sendStatus()
    } else if (input.alt && (input.code === 'KeyZ' || input.code === 'KeyW' || ['z', 'w', 'Ω'].includes(input.key.toLowerCase()))) {
      event.preventDefault()
      command('pip')
    } else if (platform === 'youtube' && input.meta && !input.alt && !input.shift && input.code === 'KeyT') {
      event.preventDefault()
      createTab(STREAMLY_HOME.youtube, true)
    } else if (platform === 'youtube' && input.meta && !input.alt && !input.shift && /^Digit[1-9]$/.test(input.code)) {
      const index = Number(input.code.slice(-1)); const target = index === 9 ? tabs[tabs.length - 1] : tabs[index - 1]
      if (target) { event.preventDefault(); selectTab(target.id) }
    } else if (platform === 'youtube' && tabs.length > 1 && input.meta && !input.alt && !input.shift && (input.code === 'KeyW' || input.key.toLowerCase() === 'w')) {
      event.preventDefault()
      if (view) closeTab(tabs.find((entry) => entry.view === view)?.id ?? tab.id)
    } else if (input.meta && !input.alt && !input.shift && input.code === 'KeyR') {
      event.preventDefault()
      contents.reload()
    } else if (input.alt && !input.meta && /^Digit[0-9]$/.test(input.code)) {
      event.preventDefault()
      main()?.webContents.send('streamly:switch-shortcut', input.code === 'Digit0' ? 10 : Number(input.code.slice(-1)))
    } else if (input.alt && input.code === 'ArrowLeft') {
      event.preventDefault()
      command('back')
    } else if (input.alt && input.code === 'ArrowRight') {
      event.preventDefault()
      command('forward')
    } else if (input.meta && input.shift && input.code === 'Space') {
      event.preventDefault()
      command('playpause')
    } else if (input.meta && input.shift && input.code === 'ArrowLeft') {
      event.preventDefault()
      command('back10')
    } else if (input.meta && input.shift && input.code === 'ArrowRight') {
      event.preventDefault()
      command('forward10')
    }
  })
  if (foreground || !view) {
    selectTab(tab.id)
    void contents.loadURL(initialUrl).catch((error) => sendStatus(String(error)))
  } else {
    sendStatus()
    main()?.webContents.send('streamly:background-tab')
    if (youtubeLink(initialUrl)) {
      const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(initialUrl)}`
      void fetch(endpoint, { signal: AbortSignal.timeout(5000) }).then(async (response) => response.ok ? response.json() : null).then((data: unknown) => {
        const title = (data as { title?: unknown } | null)?.title
        if (tabs.includes(tab) && typeof title === 'string' && title.trim()) { tab.pendingTitle = title.trim(); sendStatus() }
      }).catch(() => undefined)
    }
  }
}

function createView(initialUrl: string): void {
  releaseView()
  createTab(initialUrl, true)
}

export function registerStreamly(getMainWindow: () => BrowserWindow | null): void {
  mainGetter = getMainWindow
  // A distinct persistent session keeps streaming logins outside the IPTV
  // renderer's CORS modifications and survives application restarts.
  const streamSession = session.fromPartition('persist:streamly')
  // Keep Netflix's own media, license and app hosts untouched. Public lists
  // can filter separate third-party requests, but cannot promise to remove
  // ads inserted into Netflix's protected first-party stream.
  const cachePath = join(app.getPath('userData'), 'streamly-adblock-v3.bin')
  const bundledCachePath = app.isPackaged
    ? join(process.resourcesPath, 'streamly-adblock-base.bin')
    : join(app.getAppPath(), 'resources', 'streamly-adblock-base.bin')
  let lastUpdate = 0
  let refreshInFlight: Promise<void> | null = null
  streamSession.webRequest.onBeforeRequest((details, callback) => {
    // Apply list rules to first-party scripts/XHR too: ad services often use
    // the site's own host. Netflix keeps its working protected-host exception.
    const shouldFilter = details.resourceType !== 'mainFrame'
      && !isNetflixProtectedHost(details.url)
    if (shouldFilter && youtubeBlocker) youtubeBlocker.onBeforeRequest(details, callback)
    else callback({})
  })
  const refreshFilters = async (): Promise<void> => {
    if (youtubeBlocker && Date.now() - lastUpdate < 2 * 86_400_000) return
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
      try {
        const updated = await ElectronBlocker.fromLists(fetch, [
          'https://easylist.to/easylist/easylist.txt',
          'https://easylist.to/easylist/easyprivacy.txt',
          'https://easylist-downloads.adblockplus.org/liste_fr.txt',
          'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
          'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
          'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2020.txt',
          'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
          'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt'
        ], { loadCosmeticFilters: false, loadCSPFilters: false })
        const bytes = updated.serialize()
        await writeFile(`${cachePath}.tmp`, bytes)
        await rename(`${cachePath}.tmp`, cachePath)
        youtubeBlocker = updated
        lastUpdate = Date.now()
      } catch (error) { console.warn('Streamly ad filtering update unavailable:', error) }
    })().finally(() => { refreshInFlight = null })
    return refreshInFlight
  }
  const filterReady = (async () => {
    for (const path of [cachePath, bundledCachePath]) {
      try {
        youtubeBlocker = ElectronBlocker.deserialize(await readFile(path))
        lastUpdate = path === cachePath ? (await stat(path)).mtimeMs : 0
        break
      } catch { /* try the packaged fallback */ }
    }
    void refreshFilters()
  })()
  setInterval(() => { void filterReady.then(refreshFilters) }, 12 * 60 * 60 * 1000).unref()
  ipcMain.handle('streamly:open', async (event, nextPlatform: StreamlyPlatform, lastUrl: string, pipBounds?: Rectangle, customHome?: string, family?: string) => {
    if (!validSender(event.sender)) return false
    const home = customHome ?? STREAMLY_HOME[nextPlatform]
    if (!STREAMLY_HOME[nextPlatform] && !nextPlatform.startsWith('custom:')) return false
    if (!home || !/^https:\/\//i.test(home)) return false
    const generation = ++openGeneration
    await filterReady
    if (generation !== openGeneration || !validSender(event.sender)) return false
    if (pipBounds && [pipBounds.x, pipBounds.y, pipBounds.width, pipBounds.height].every(Number.isFinite) && pipBounds.width >= 320 && pipBounds.height >= 200) savedPipBounds = pipBounds
    active = true
    if (pipWindow) exitPip()
    platform = nextPlatform
    platformHome = home
    platformFamily = family === 'anime' || family === 'movy' ? family : ''
    createView(safeStreamlyUrl(platform, lastUrl, home))
    return true
  })
  ipcMain.handle('streamly:bounds', (event, bounds: Rectangle) => {
    if (!validSender(event.sender)) return
    mainBounds = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)) }
    const owner = main()
    if (owner && view && !pipWindow) attachToMain()
    })
  ipcMain.handle('streamly:focus', (event) => {
    if (validSender(event.sender) && active && mainViewAttached && mainBounds.width > 0 && mainBounds.height > 0 && !menuWindow && !pipWindow) view?.webContents.focus()
  })
  ipcMain.handle('streamly:command', (event, action: string) => validSender(event.sender) && command(action))
  ipcMain.handle('streamly:menu-open', (event, items: Array<{ id: string; name: string; logo: string }>, activeId: string, anchor: Rectangle) => {
    if (!validSender(event.sender) || !active || !Array.isArray(items) || items.length > 40 || ![anchor.x, anchor.y, anchor.width, anchor.height].every(Number.isFinite)) return
    showPlatformMenu(items.map((item) => ({ id: String(item.id).slice(0, 100), name: String(item.name).slice(0, 80), logo: typeof item.logo === 'string' && (item.logo.startsWith('data:image/') || /^https:\/\//i.test(item.logo)) ? item.logo : '' })), activeId, anchor)
  })
  ipcMain.handle('streamly:toast', (event, message: string) => { if (validSender(event.sender) && typeof message === 'string') { showToast(message.slice(0, 120)); if (active && view && !pipWindow && !menuWindow) view.webContents.focus() } })
  ipcMain.handle('streamly:tab-open', (event) => {
    if (validSender(event.sender) && active && platform === 'youtube') createTab(STREAMLY_HOME.youtube, true)
  })
  ipcMain.handle('streamly:tab-select', (event, id: number) => { if (validSender(event.sender)) selectTab(id) })
  ipcMain.handle('streamly:tab-close', (event, id: number) => { if (validSender(event.sender)) closeTab(id) })
  ipcMain.handle('streamly:tab-reorder', (event, ids: number[]) => {
    if (!validSender(event.sender) || !Array.isArray(ids) || ids.length !== tabs.length || new Set(ids).size !== tabs.length) return
    const reordered = ids.map((id) => tabs.find((tab) => tab.id === id))
    if (reordered.every(Boolean)) { tabs = reordered as typeof tabs; sendStatus() }
  })
  ipcMain.handle('streamly:close', (event) => {
    if (validSender(event.sender)) stop()
  })
  ipcMain.handle('streamly:site-meta', async (event, rawUrl: string) => {
    if (!validSender(event.sender)) return null
    try {
      const url = new URL(rawUrl)
      if (url.protocol !== 'https:') return null
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!response.ok || !response.url.startsWith('https:')) return null
      const html = (await response.text()).slice(0, 1_000_000)
      const unescape = (s: string): string => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      const meta = (name: string): string => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return unescape(new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*content=["']([^"']+)`, 'i').exec(html)?.[1] ?? '')
      }
      const title = meta('og:site_name') || meta('application-name') || /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || url.hostname
      const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])
      const attr = (tag: string, name: string): string => unescape(new RegExp(`${name}=["']([^"']+)`, 'i').exec(tag)?.[1] ?? '')
      let iconCandidates = links.filter((tag) => /rel=["'][^"']*icon[^"']*["']/i.test(tag)).sort((a, b) => Number(/apple-touch-icon/i.test(b)) - Number(/apple-touch-icon/i.test(a))).map((tag) => attr(tag, 'href'))
      const manifestHref = links.find((tag) => /rel=["']manifest["']/i.test(tag))
      if (manifestHref) {
        try {
          const manifestUrl = new URL(attr(manifestHref, 'href'), response.url)
          if (manifestUrl.protocol === 'https:') {
            const manifestResponse = await fetch(manifestUrl, { signal: AbortSignal.timeout(4000) })
            const manifest = await manifestResponse.json() as { icons?: Array<{ src?: string; sizes?: string }> }
            iconCandidates.unshift(...(manifest.icons ?? []).sort((a, b) => parseInt(b.sizes ?? '0') - parseInt(a.sizes ?? '0')).map((icon) => icon.src ?? ''))
          }
        } catch { /* use page favicons */ }
      }
      iconCandidates.push('/favicon.ico', `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=128`)
      let logo = ''
      for (const candidate of iconCandidates.filter(Boolean)) {
        try {
          const iconUrl = new URL(candidate, response.url)
          if (iconUrl.protocol !== 'https:') continue
          const icon = await fetch(iconUrl, { signal: AbortSignal.timeout(4000) })
          const mime = icon.headers.get('content-type')?.split(';')[0] ?? ''
          if (!icon.ok || !mime.startsWith('image/')) continue
          const bytes = Buffer.from(await icon.arrayBuffer())
          if (bytes.length <= 256_000) { logo = `data:${mime};base64,${bytes.toString('base64')}`; break }
        } catch { /* test next favicon source */ }
      }
      return { name: title.slice(0, 80), logo, url: new URL(response.url).origin + '/' }
    } catch { return null }
  })
}

export function closeStreamly(): void {
  stop()
}

export function reloadStreamly(): boolean {
  return active && command('reload')
}

export function closeActiveStreamlyTab(): boolean {
  if (!active || platform !== 'youtube' || tabs.length <= 1 || !view) return false
  const tab = tabs.find((entry) => entry.view === view)
  if (!tab) return false
  closeTab(tab.id)
  return true
}
