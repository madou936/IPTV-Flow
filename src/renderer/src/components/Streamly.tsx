import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { STREAMLY_HOME, safeStreamlyUrl } from '../../../shared/streamly'
import type { StreamlyPlatform, StreamlyStatus } from '../../../shared/streamly'

type PlatformEntry = { id: string; name: string; url: string; logo: string; family?: string }
const DEFAULTS: PlatformEntry[] = [
  { id: 'netflix', name: 'Netflix', url: STREAMLY_HOME.netflix, logo: '' },
  { id: 'prime', name: 'Prime Video', url: STREAMLY_HOME.prime, logo: '' },
  { id: 'youtube', name: 'YouTube', url: STREAMLY_HOME.youtube, logo: '' }
]
const PLATFORM_STORE = 'streamly:platforms-v1'
const LAST_PLATFORM = 'streamly:last-platform'
const PIP_BOUNDS = 'streamly:pip-bounds'
// Numeric shortcuts follow the visible platform order. Option+0 selects #10.
function shortcutIndex(code: string): number {
  return /^Digit[0-9]$/.test(code) ? (code === 'Digit0' ? 10 : Number(code.slice(-1))) : 0
}
function validUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null } catch { return null }
}
function loadPlatforms(): PlatformEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PLATFORM_STORE) || 'null')
    if (Array.isArray(raw)) {
      const entries = raw.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.url === 'string' && validUrl(item.url))
        .map((item) => ({ id: item.id, name: item.name.slice(0, 80), url: item.url, family: item.family === 'anime' || item.family === 'movy' ? item.family : (/^https:\/\/(?:www\.)?anime-sama\./i.test(item.url) ? 'anime' : /^https:\/\/(?:www\.)?movy\./i.test(item.url) ? 'movy' : undefined), logo: typeof item.logo === 'string' && (item.logo.startsWith('data:image/') || !!validUrl(item.logo)) ? item.logo : '' }))
      if (entries.length) return entries
    }
  } catch { /* reset malformed platform list */ }
  return DEFAULTS
}
function platformLogo(entry: PlatformEntry): string {
  if (entry.logo) return entry.logo
  const svg = entry.id === 'youtube'
    ? '<rect width="32" height="32" rx="8" fill="#ff0033"/><path d="M13 9.5v13l11-6.5z" fill="white"/>'
    : entry.id === 'netflix'
      ? '<rect width="32" height="32" rx="8" fill="#000"/><path d="M9 6h5l9 20h-5z" fill="#e50914"/><path d="M9 6h4v20H9zm10 0h4v20h-4z" fill="#b1060e"/>'
      : entry.id === 'prime'
        ? '<rect width="32" height="32" rx="8" fill="#00a8e1"/><path d="M9 10h3.5c4 0 5 2 5 4s-2 4-5 4H12v4H9zm3 3v2h1c1 0 1-2 0-2zM8 24c5 3 12 3 17-1" fill="white" stroke="white" stroke-width="1.2"/>'
        : '<rect width="32" height="32" rx="8" fill="#3b4560"/><circle cx="16" cy="16" r="9" fill="none" stroke="#e7eaf0" stroke-width="1.6"/><path d="M7 16h18M16 7c-5 5-5 13 0 18M16 7c5 5 5 13 0 18" fill="none" stroke="#e7eaf0" stroke-width="1.4"/>'
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${svg}</svg>`)}`
}
function PlatformLogo({ entry }: { entry: PlatformEntry }): JSX.Element {
  return <span className="streamly-mark"><img src={platformLogo(entry)} alt="" onError={(event) => { event.currentTarget.src = platformLogo({ ...entry, logo: '' }) }} /></span>
}
interface StreamlyBridge {
  focus: () => Promise<void>
  open: (platform: StreamlyPlatform, url: string, pipBounds?: { x: number; y: number; width: number; height: number }, home?: string, family?: string) => Promise<boolean>
  siteMeta: (url: string) => Promise<{ name: string; logo: string; url: string } | null>
  openMenu: (items: Array<{ id: string; name: string; logo: string }>, activeId: string, anchor: { x: number; y: number; width: number; height: number }) => Promise<void>
  onMenuAction: (fn: (action: string, id?: string) => void) => () => void
  bounds: (rect: { x: number; y: number; width: number; height: number }) => Promise<void>
  command: (action: string) => Promise<boolean>
  openTab: () => Promise<void>
  selectTab: (id: number) => Promise<void>
  closeTab: (id: number) => Promise<void>
  reorderTabs: (ids: number[]) => Promise<void>
  close: () => Promise<void>
  onStatus: (fn: (status: StreamlyStatus) => void) => () => void
  onBackgroundTab: (fn: () => void) => () => void
  onSwitchShortcut: (fn: (index: number) => void) => () => void
}
function bridge(): StreamlyBridge | undefined {
  return (window as unknown as { host?: { streamly?: StreamlyBridge } }).host?.streamly
}

export default function Streamly({ menuOpen, onMenuClose, covered, onFullScreenChange }: { menuOpen: boolean; onMenuClose: () => void; covered: boolean; onFullScreenChange: (enabled: boolean) => void }): JSX.Element {
  const [platforms, setPlatforms] = useState<PlatformEntry[]>(loadPlatforms)
  const [platform, setPlatform] = useState(() => localStorage.getItem(LAST_PLATFORM) || 'youtube')
  const [status, setStatus] = useState<StreamlyStatus | null>(null)
  const [panel, setPanel] = useState<'menu' | 'add' | 'manage' | 'edit' | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState({ url: '', name: '', logo: '' })
  const [detecting, setDetecting] = useState(false)
  const [formError, setFormError] = useState('')
  const [alwaysShowTabs, setAlwaysShowTabs] = useState(() => localStorage.getItem('streamly:youtube-tabs-always') === '1')
  const [showNewTabNotice, setShowNewTabNotice] = useState(false)
  const noticeTimer = useRef<number | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const draggedTab = useRef<number | null>(null)
  const draggedPlatform = useRef<string | null>(null)
  const platformRef = useRef(platform)
  const platformsRef = useRef(platforms)
  const onFullScreenChangeRef = useRef(onFullScreenChange)
  platformRef.current = platform
  platformsRef.current = platforms
  onFullScreenChangeRef.current = onFullScreenChange

  useEffect(() => {
    if (covered || panel || menuOpen) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const restore = (event: MouseEvent): void => {
      if (event.detail === 0 || !(event.target instanceof Element)) return
      const button = event.target.closest('.sidebar button, .sidebar-edge-toggle')
      if (!(button instanceof HTMLElement)) return
      // Only pointer clicks release the button. Tab/Space activation continues
      // to behave normally, and opening a modal cancels this deferred restore.
      button.blur()
      timer = setTimeout(() => { void bridge()?.focus() }, 0)
    }
    document.addEventListener('click', restore)
    return () => { document.removeEventListener('click', restore); clearTimeout(timer) }
  }, [covered, panel, menuOpen])

  useEffect(() => { localStorage.setItem(PLATFORM_STORE, JSON.stringify(platforms)) }, [platforms])
  useEffect(() => {
    if (!platforms.some((p) => p.id === platform)) setPlatform(platforms[0]?.id || 'youtube')
  }, [platforms, platform])
  useEffect(() => {
    const host = bridge()
    if (!host) return
    const removeStatus = host.onStatus((next) => {
      if (next.platform !== platformRef.current) return
      setStatus(next)
      onFullScreenChangeRef.current(next.fullScreen ?? false)
      if (next.pipBounds) localStorage.setItem(PIP_BOUNDS, JSON.stringify(next.pipBounds))
      const entry = platformsRef.current.find((item) => item.id === next.platform)
      if (entry && next.url && safeStreamlyUrl(next.platform, next.url, entry.url) === next.url) localStorage.setItem(`streamly:last-url:${next.platform}`, next.url)
    })
    const removeShortcut = host.onSwitchShortcut((index) => {
      const id = platformsRef.current[index - 1]?.id
      if (platformsRef.current.some((entry) => entry.id === id)) setPlatform(id)
    })
    const removeMenuAction = host.onMenuAction((action, id) => {
      if (action === 'select' && id && platformsRef.current.some((entry) => entry.id === id)) setPlatform(id)
      else if (action === 'add') { setEditingId(null); setDraft({ url: '', name: '', logo: '' }); setPanel('add') }
      else if (action === 'manage') setPanel('manage')
    })
    const removeBackgroundTab = host.onBackgroundTab(() => {
      setShowNewTabNotice(true)
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
      noticeTimer.current = window.setTimeout(() => { noticeTimer.current = null; setShowNewTabNotice(false) }, 2500)
    })
    const updateTabsPreference = (): void => setAlwaysShowTabs(localStorage.getItem('streamly:youtube-tabs-always') === '1')
    window.addEventListener('streamly:tabs-preference', updateTabsPreference)
    return () => { removeStatus(); removeShortcut(); removeMenuAction(); removeBackgroundTab(); window.removeEventListener('streamly:tabs-preference', updateTabsPreference); if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current); void host.close() }
  }, [])
  useEffect(() => {
    const entry = platforms.find((item) => item.id === platform)
    const host = bridge()
    if (!host || !entry) return
    localStorage.setItem(LAST_PLATFORM, platform)
    setStatus(null)
    const saved = localStorage.getItem('streamly:restore-page') !== '0' ? localStorage.getItem(`streamly:last-url:${platform}`) : null
    let pipBounds: { x: number; y: number; width: number; height: number } | undefined
    try { pipBounds = JSON.parse(localStorage.getItem(PIP_BOUNDS) ?? 'null') ?? undefined } catch { /* ignore */ }
    void host.open(platform, safeStreamlyUrl(platform, saved ?? entry.url, entry.url), pipBounds, entry.url, entry.family)
  }, [platform])
  useEffect(() => {
    const element = surface.current, host = bridge()
    if (!element || !host) return
    const update = (): void => {
      const rect = element.getBoundingClientRect()
      void host.bounds((covered || (panel !== null && panel !== 'menu')) ? { x: 0, y: 0, width: 0, height: 0 } : { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    update()
    const timer = window.setTimeout(update, 500)
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.clearTimeout(timer) }
  }, [covered, menuOpen, panel, status?.fullScreen])
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && panel && panel !== 'menu') { event.preventDefault(); event.stopPropagation(); setPanel(null); return }
      if (event.altKey && !event.metaKey && !event.ctrlKey && (event.code === 'KeyZ' || event.code === 'KeyW' || ['z', 'w', 'Ω'].includes(event.key.toLowerCase()))) {
        event.preventDefault(); void bridge()?.command('pip')
      } else if (platform === 'youtube' && event.metaKey && !event.altKey && !event.shiftKey && event.code === 'KeyT') {
        event.preventDefault(); void bridge()?.openTab()
      } else if (platform === 'youtube' && event.metaKey && !event.altKey && !event.shiftKey && shortcutIndex(event.code) > 0 && shortcutIndex(event.code) <= 9) {
        const index = shortcutIndex(event.code); const tab = index === 9 ? status?.tabs?.at(-1) : status?.tabs?.[index - 1]
        if (tab) { event.preventDefault(); void bridge()?.selectTab(tab.id) }
      } else if (event.altKey && !event.metaKey && shortcutIndex(event.code)) {
        const id = platforms[shortcutIndex(event.code) - 1]?.id
        if (platforms.some((entry) => entry.id === id)) { event.preventDefault(); setPlatform(id) }
      } else if (event.altKey && event.code === 'ArrowLeft') { event.preventDefault(); void bridge()?.command('back') }
      else if (event.altKey && event.code === 'ArrowRight') { event.preventDefault(); void bridge()?.command('forward') }
      else if (event.metaKey && event.shiftKey && event.code === 'Space') { event.preventDefault(); void bridge()?.command('playpause') }
      else if (event.metaKey && event.shiftKey && event.code === 'ArrowLeft') { event.preventDefault(); void bridge()?.command('back10') }
      else if (event.metaKey && event.shiftKey && event.code === 'ArrowRight') { event.preventDefault(); void bridge()?.command('forward10') }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [status?.activeTabId, status?.tabs, platforms, platform, panel])
  useEffect(() => {
    if (!menuOpen) return
    const anchor = document.querySelector('.streamly-nav-item')?.getBoundingClientRect()
    if (!anchor) return
    void bridge()?.openMenu(platforms.map((entry) => ({ id: entry.id, name: entry.name, logo: platformLogo(entry) })), platform, { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height })
    onMenuClose()
  }, [menuOpen])
  useEffect(() => {
    if (panel !== 'add' && panel !== 'edit') return
    const normalized = validUrl(draft.url)
    if (!normalized) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setDetecting(true)
      const result = await bridge()?.siteMeta(normalized)
      if (!cancelled && result) setDraft((current) => current.url === normalized || validUrl(current.url) === normalized ? { ...current, name: current.name || result.name, logo: current.logo || result.logo } : current)
      if (!cancelled) setDetecting(false)
    }, 600)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [draft.url, panel])

  const current = platforms.find((entry) => entry.id === platform)
  const tabs = status?.tabs ?? []
  const visiblePanel: 'menu' | 'add' | 'manage' | 'edit' | null = panel === 'menu' ? null : panel
  const choose = (id: string): void => { setPanel(null); onMenuClose(); if (id !== platform) setPlatform(id) }
  const openForm = (entry?: PlatformEntry): void => {
    setEditingId(entry?.id ?? null)
    setDraft({ url: entry?.url ?? '', name: entry?.name ?? '', logo: entry?.logo ?? '' })
    setFormError('')
    setPanel(entry ? 'edit' : 'add')
    onMenuClose()
  }
  const saveForm = (): void => {
    const url = validUrl(draft.url)
    if (!url) { setFormError('Saisis une adresse HTTPS valide.'); return }
    if (draft.logo && !draft.logo.startsWith('data:image/') && !validUrl(draft.logo)) { setFormError('Saisis une URL HTTPS valide pour le logo.'); return }
    const id = editingId ?? `custom:${crypto.randomUUID()}`
    const family = /^https:\/\/(?:www\.)?anime-sama\./i.test(url) ? 'anime' : /^https:\/\/(?:www\.)?movy\./i.test(url) ? 'movy' : platforms.find(item => item.id === id)?.family
    const next = { id, family, name: draft.name.trim() || new URL(url).hostname, url, logo: draft.logo }
    setPlatforms((items) => editingId ? items.map((entry) => entry.id === id ? next : entry) : [...items, next])
    if (editingId && platforms.find(item => item.id === id)?.url !== url) localStorage.removeItem(`streamly:last-url:${id}`)
    if (editingId === platform && current?.url !== url) { localStorage.removeItem(`streamly:last-url:${id}`); void bridge()?.open(id, url, undefined, url, family) }
    setPanel(editingId ? 'manage' : 'menu')
  }
  const removePlatform = (entry: PlatformEntry): void => {
    if (!window.confirm(`Supprimer ${entry.name} de Streamly ?`)) return
    const remaining = platforms.filter((item) => item.id !== entry.id)
    setPlatforms(remaining.length ? remaining : DEFAULTS)
    if (entry.id === platform) setPlatform(remaining[0]?.id ?? 'youtube')
  }
  const reorderPlatform = (targetId: string): void => {
    const id = draggedPlatform.current; draggedPlatform.current = null
    if (!id || id === targetId) return
    setPlatforms((items) => { const next = [...items], from = next.findIndex((item) => item.id === id), to = next.findIndex((item) => item.id === targetId); if (from < 0 || to < 0) return items; next.splice(to, 0, next.splice(from, 1)[0]); return next })
  }
  const reorderTab = (target: number): void => {
    const from = draggedTab.current; draggedTab.current = null
    if (from == null || from === target) return
    const ids = tabs.map((tab) => tab.id), fromIndex = ids.indexOf(from), toIndex = ids.indexOf(target)
    if (fromIndex < 0 || toIndex < 0) return
    ids.splice(fromIndex, 1); ids.splice(toIndex, 0, from); void bridge()?.reorderTabs(ids)
  }

  const titlebar = document.querySelector('.window-drag')
  const tabStrip = platform === 'youtube' && !status?.fullScreen && !status?.pip && !covered && !visiblePanel && titlebar
    ? createPortal(<div className={`streamly-titlebar-hover${alwaysShowTabs || showNewTabNotice ? ' visible' : ''}`} aria-label="Onglets YouTube">
        <div className="streamly-titlebar-tabs">
          <div className="streamly-titlebar-list">{tabs.map((tab, index) => <div key={tab.id} className={`streamly-browser-tab${tab.id === status?.activeTabId ? ' active' : ''}`} draggable onDragStart={() => { draggedTab.current = tab.id }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); reorderTab(tab.id) }} onDragEnd={() => { draggedTab.current = null }}>
            <span className="streamly-browser-favicon">▶</span><button className="streamly-browser-title" onClick={() => void bridge()?.selectTab(tab.id)} title={tab.title || tab.url}>{tab.title || (tab.url ? 'YouTube' : `Onglet ${index + 1}`)}</button><button className="streamly-browser-close" onClick={() => void bridge()?.closeTab(tab.id)} aria-label="Fermer l’onglet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
          </div>)}</div><button className="streamly-browser-new" onClick={() => void bridge()?.openTab()} aria-label="Nouvel onglet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
        </div>
      </div>, titlebar) : null

  return <section className={`streamly content${status?.fullScreen ? ' fullscreen' : ''}`} aria-label="Streamly">
    {tabStrip}
    {visiblePanel && <div className="streamly-modal-backdrop" onClick={() => setPanel(null)}><div role="dialog" aria-modal="true" className={`streamly-panel streamly-panel-${visiblePanel}`} onClick={(event) => event.stopPropagation()}>
      {panel === 'menu' && <>
        <div className="streamly-panel-heading">Plateformes <button onClick={() => { setPanel(null); onMenuClose() }} aria-label="Fermer le menu">×</button></div>
        {platforms.map((entry) => <button key={entry.id} className={`streamly-panel-platform ${entry.id === platform ? 'selected' : ''}`} onClick={() => choose(entry.id)}><PlatformLogo entry={entry} /><span>{entry.name}</span>{entry.id === platform && <span className="streamly-check">✓</span>}</button>)}
        <div className="streamly-panel-divider" />
        <button className="streamly-panel-platform" onClick={() => openForm()}><span className="streamly-menu-symbol"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg></span>Ajouter une plateforme</button>
        <button className="streamly-panel-platform" onClick={() => { setPanel('manage'); onMenuClose() }}><span className="streamly-menu-symbol"><svg viewBox="0 0 24 24"><path d="M4 7h16M7 12h10M10 17h4"/><circle cx="7" cy="7" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="10" cy="17" r="1.4"/></svg></span>Gérer les plateformes</button>
        {platform === 'youtube' && <><div className="streamly-panel-divider" /><div className="streamly-panel-heading">Onglets <button onClick={() => void bridge()?.openTab()} title="Nouvel onglet YouTube" aria-label="Nouvel onglet">＋</button></div><div className="streamly-tabs">{tabs.map((tab, index) => <div key={tab.id} className={`streamly-tab ${tab.id === status?.activeTabId ? 'selected' : ''}`} draggable onDragStart={() => { draggedTab.current = tab.id }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); reorderTab(tab.id) }} onDragEnd={() => { draggedTab.current = null }}><button className="streamly-tab-select" onClick={() => { void bridge()?.selectTab(tab.id); setPanel(null) }} title={tab.title || tab.url || `Onglet ${index + 1}`}>{tab.title || (tab.url ? 'YouTube' : `Onglet ${index + 1}`)}</button><button className="streamly-tab-close" onClick={() => void bridge()?.closeTab(tab.id)} title="Fermer l’onglet">×</button></div>)}</div></>}
      </>}
      {visiblePanel === 'manage' && <>
        <div className="streamly-panel-heading">Gérer les plateformes <button onClick={() => setPanel(null)} aria-label="Fermer">×</button></div>
        <div className="streamly-panel-hint">Glisser pour réorganiser</div>
        {platforms.map((entry) => <div className="streamly-manage-row" key={entry.id} draggable onDragStart={() => { draggedPlatform.current = entry.id }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); reorderPlatform(entry.id) }}><span className="streamly-grip">⠿</span><PlatformLogo entry={entry} /><div className="streamly-manage-label"><strong>{entry.name}</strong><small>{new URL(entry.url).hostname}</small></div><button onClick={() => openForm(entry)} title="Modifier">✎</button><button className="streamly-delete-button" onClick={() => removePlatform(entry)} title="Supprimer" aria-label={`Supprimer ${entry.name}`}><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14M10 11v6m4-6v6"/></svg></button></div>)}
        <button className="streamly-action-primary" onClick={() => openForm()}>＋ Ajouter</button>
      </>}
      {(visiblePanel === 'add' || visiblePanel === 'edit') && <>
        <div className="streamly-panel-heading">{editingId ? 'Modifier la plateforme' : 'Ajouter une plateforme'} <button onClick={() => setPanel(editingId ? 'manage' : null)} aria-label="Fermer">×</button></div>
        <label className="streamly-field">URL de la plateforme<input type="url" value={draft.url} placeholder="https://example.com" onChange={(event) => setDraft((value) => ({ ...value, url: event.target.value }))} /></label>
        <div className="streamly-panel-hint">{detecting ? 'Recherche du nom et du logo…' : 'Nom et logo détectés automatiquement, puis modifiables.'}</div>
        <div className="streamly-preview"><PlatformLogo entry={{ id: editingId ?? '', name: draft.name || 'Plateforme', url: draft.url, logo: draft.logo }} /><strong>{draft.name || 'Nom de la plateforme'}</strong></div>
        <label className="streamly-field">Nom<input value={draft.name} placeholder="Nom détecté automatiquement" onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></label>
        <label className="streamly-field">URL du logo<input type="url" value={draft.logo.startsWith("data:image/") ? "" : draft.logo} placeholder="https://exemple.com/logo.png" onChange={(event) => setDraft((value) => ({ ...value, logo: event.target.value }))} /></label>
        {formError && <div className="streamly-error">{formError}</div>}
        <div className="streamly-form-actions"><button onClick={() => setPanel(editingId ? 'manage' : null)}>Annuler</button><button className="streamly-action-primary" onClick={saveForm}>{editingId ? 'Enregistrer' : 'Ajouter'}</button></div>
      </>}
    </div></div>}
    <div className="streamly-main">
      {status?.error && <div className="streamly-error">Impossible de charger la page : {status.error} <button onClick={() => void bridge()?.command('reload')}>Réessayer</button></div>}
      <div className="streamly-surface" ref={surface}>
        {(!status || (status.loading && !status.ready)) && <div className="streamly-loading"><span className="spinner" />Chargement de la plateforme…</div>}
        {status?.pip && <div className="streamly-pip-placeholder"><strong>PiP actif</strong><button onClick={() => void bridge()?.command('pip')}>Revenir à Streamly</button></div>}
      </div>
    </div>
  </section>
}
