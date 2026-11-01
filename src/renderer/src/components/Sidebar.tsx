import { useState } from 'react'
import type { MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { clearCache } from '../lib/proxy'
import { useDownloads } from '../lib/downloads'
import { useT7 } from '../lib/t7'
import type { Section, UserInfo } from '../types'

const t7Icon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="12" x2="2" y2="12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    <line x1="6" y1="16" x2="6.01" y2="16" />
    <line x1="10" y1="16" x2="10.01" y2="16" />
  </svg>
)

const streamlyIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="3" />
    <path d="m10 8 6 4-6 4z" />
  </svg>
)

interface Props {
  section: Section
  account: UserInfo
  onSection: (s: Section) => void
  onSwitchProfile: () => void
  onSettings: () => void
  onExport?: () => void
  profileName: string
  collapsed: boolean
}

const NAV: { id: Section; label: string; icon: JSX.Element }[] = [
  {
    id: 'live',
    label: 'TV en Direct',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="7" width="20" height="14" rx="2" />
        <path d="M8 3l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    id: 'movies',
    label: 'Films',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" strokeLinecap="round" />
      </svg>
    )
  },
  {
    id: 'series',
    label: 'Séries',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="6" width="20" height="13" rx="2" />
        <path d="M8 2l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7 19v2M17 19v2" strokeLinecap="round" />
      </svg>
    )
  },
]

const NAV_BOTTOM: { id: Section; label: string; icon: JSX.Element }[] = [
  {
    id: 'downloads',
    label: 'Téléchargements',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    )
  }
]

function formatExp(exp: string | null): string {
  if (!exp) return 'Illimité'
  const d = new Date(Number(exp) * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

const settingsIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const logoutIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
)

const cacheIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
)

const exportIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v13" />
    <polyline points="7 8 12 3 17 8" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
)

const loginIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <polyline points="10 17 15 12 10 7" />
    <line x1="15" y1="12" x2="3" y2="12" />
  </svg>
)

function keepPointerFocus(event: MouseEvent<HTMLElement>): void {
  if (event.button === 0 && event.target instanceof Element && event.target.closest('button')) event.preventDefault()
}

function formatBytes(bytes = 0): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 o'
  const units = ['o', 'Ko', 'Mo', 'Go']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

export default function Sidebar({ section, account, onSection, onSwitchProfile, onSettings, onExport, profileName, collapsed }: Props): JSX.Element {
  const [cleared, setCleared] = useState(false)
  const [cacheNotice, setCacheNotice] = useState('')
  const { activeCount } = useDownloads()
  const { available: t7Available } = useT7()
  async function handleClearCache(): Promise<void> {
    const result = await clearCache()
    setCacheNotice(`${formatBytes(result.bytes)} supprimés`)
    setCleared(true)
    if (section === 'streamly') void (window as unknown as { host?: { streamly?: { toast: (message: string) => Promise<void> } } }).host?.streamly?.toast(`Cache vidé · ${formatBytes(result.bytes)} supprimés`)
    window.setTimeout(() => {
      setCleared(false)
      setCacheNotice('')
    }, 4000)
  }

  return (
    <aside onMouseDown={keepPointerFocus} className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
      <div className="sidebar-brand">
        <span className="brand-mark">▶</span>
        {!collapsed && <span className="brand-name">IPTV Flow</span>}
      </div>

      <nav className="nav nav-primary-offset">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${section === item.id ? 'active' : ''}`}
            onClick={() => onSection(item.id)}
            title={collapsed ? item.label : undefined}
          >
            {item.icon}
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}

        <button
          className={`nav-item ${section === 't7flix' ? 'active' : ''} ${t7Available ? '' : 'disabled'}`}
          onClick={() => t7Available && onSection('t7flix')}
          disabled={!t7Available}
          title={collapsed ? (t7Available ? 'T7Flix' : 'T7Flix — SSD débranché') : (t7Available ? 'T7Flix' : 'Branche le SSD T7 pour activer')}
        >
          {t7Icon}
          {!collapsed && <span>T7Flix</span>}
          {!collapsed && !t7Available && <span className="nav-off">débranché</span>}
        </button>

        <button className={`nav-item streamly-nav-item ${section === 'streamly' ? 'active' : ''}`} onClick={() => onSection('streamly')} title="Streamly">
          {streamlyIcon}
          {!collapsed && <span>Streamly</span>}
        </button>

        {NAV_BOTTOM.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${section === item.id ? 'active' : ''}`}
            onClick={() => onSection(item.id)}
            title={collapsed ? item.label : undefined}
          >
            {item.icon}
            {!collapsed && <span>{item.label}</span>}
            {item.id === 'downloads' && activeCount > 0 && (
              <span className="nav-badge">{activeCount}</span>
            )}
          </button>
        ))}
      </nav>

      {collapsed ? (
        <div className="sidebar-foot-collapsed">
          <button className="nav-item" onClick={onSettings} title="Réglages">{settingsIcon}</button>
          {onExport && (
            <button className="nav-item" onClick={onExport} title="Exporter la bibliothèque T7Flix en CSV">{exportIcon}</button>
          )}
          <button className="nav-item" onClick={handleClearCache} title={cleared ? 'Cache vidé ✓' : 'Vider le cache'}>
            {cacheIcon}
          </button>
          {cacheNotice && section !== 'streamly' && createPortal(<div className="cache-toast">{cacheNotice}</div>, document.body)}
          <button className="nav-item" onClick={onSwitchProfile} title="Changer de compte">{logoutIcon}</button>
        </div>
      ) : (
        <div className="sidebar-foot">
          <div className="account">
            <div className="account-name">{profileName || account.username}</div>
            <div className="account-meta">
              <span className={`dot ${account.status?.toLowerCase() === 'active' ? 'ok' : 'warn'}`} />
              {account.status} · expire {formatExp(account.exp_date)}
            </div>
            <div className="account-meta">
              {account.active_cons}/{account.max_connections} connexion(s)
            </div>
          </div>
          <button className="btn-ghost" onClick={onSettings}>
            Réglages
          </button>
          {onExport && (
            <button className="btn-ghost" onClick={onExport}>
              Exporter
            </button>
          )}
          <button className="btn-ghost" onClick={handleClearCache}>
            {cleared ? 'Cache vidé ✓' : 'Vider le cache'}
          </button>
          {cacheNotice && section !== 'streamly' && createPortal(<div className="cache-toast">{cacheNotice}</div>, document.body)}
          <button className="btn-ghost" onClick={onSwitchProfile}>
            Changer de compte
          </button>
        </div>
      )}
    </aside>
  )
}

/** Mini sidebar for the T7-only (no Xtream login) mode.
 * Mirrors the collapsed sidebar: same width + same bottom icons,
 * but with a Login button instead of Logout, and no account info. */
export function T7MinimalSidebar({
  onLogin,
  onExport,
  onSettings,
  section,
  onSection,
  t7Available,
}: {
  onLogin: () => void
  onExport?: () => void
  onSettings: () => void
  section: 't7flix' | 'streamly'
  onSection: (section: 't7flix' | 'streamly') => void
  t7Available: boolean
}): JSX.Element {
  const [cleared, setCleared] = useState(false)
  const [cacheNotice, setCacheNotice] = useState('')
  async function handleClearCache(): Promise<void> {
    const result = await clearCache()
    setCacheNotice(`${formatBytes(result.bytes)} supprimés`)
    setCleared(true)
    if (section === 'streamly') void (window as unknown as { host?: { streamly?: { toast: (message: string) => Promise<void> } } }).host?.streamly?.toast(`Cache vidé · ${formatBytes(result.bytes)} supprimés`)
    window.setTimeout(() => {
      setCleared(false)
      setCacheNotice('')
    }, 4000)
  }
  return (
    <aside onMouseDown={keepPointerFocus} className="sidebar sidebar-collapsed">
      <div className="sidebar-brand">
        <span className="brand-mark">▶</span>
      </div>
      <nav className="nav">
        <button className={`nav-item ${section === 't7flix' ? 'active' : ''} ${t7Available ? '' : 'disabled'}`} onClick={() => onSection('t7flix')} disabled={!t7Available} title={t7Available ? 'T7Flix' : 'T7Flix — SSD débranché'}>{t7Icon}</button>
        <button className={`nav-item streamly-nav-item ${section === 'streamly' ? 'active' : ''}`} onClick={() => onSection('streamly')} title="Streamly">{streamlyIcon}</button>
      </nav>
      <div className="sidebar-foot-collapsed">
        <button className="nav-item" onClick={onSettings} title="Réglages">{settingsIcon}</button>
        {onExport && (
          <button className="nav-item" onClick={onExport} title="Exporter la bibliothèque T7Flix en CSV">{exportIcon}</button>
        )}
        <button className="nav-item" onClick={handleClearCache} title={cleared ? 'Cache vidé ✓' : 'Vider le cache'}>
          {cacheIcon}
        </button>
        {cacheNotice && section !== 'streamly' && createPortal(<div className="cache-toast">{cacheNotice}</div>, document.body)}
        <button className="nav-item" onClick={onLogin} title="Se connecter">{loginIcon}</button>
      </div>
    </aside>
  )
}
