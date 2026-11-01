import { useDownloads } from '../lib/downloads'
import type { DownloadItem } from '../types'

interface Props {
  onPlay: (item: DownloadItem) => void
}

function OpenFolderButton(): JSX.Element {
  const { openFolder } = useDownloads()
  return (
    <button
      className="dl-open-btn"
      onClick={openFolder}
      title="Ouvrir le dossier des téléchargements dans le Finder"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      Ouvrir le dossier
    </button>
  )
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} Go`
  return `${mb} Mo`
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

function StatusBadge({ item }: { item: DownloadItem }): JSX.Element {
  if (item.status === 'downloading' || item.status === 'paused') {
    return (
      <div className="dl-progress-wrap">
        <div className="dl-progress-track">
          <div
            className={`dl-progress-bar ${item.status === 'paused' ? 'dl-progress-paused' : ''}`}
            style={{ width: `${Math.max(0, Math.min(100, item.progress))}%` }}
          />
        </div>
        <span className="dl-pct">
          {item.status === 'paused' ? `En pause · ${item.progress}%` : `${item.progress}%`}
        </span>
      </div>
    )
  }
  if (item.status === 'done') {
    const elapsed = item.doneAt && item.startedAt ? item.doneAt - item.startedAt : 0
    return (
      <span className="dl-badge dl-done">
        ✓ Terminé
        {item.sizeMb != null && ` · ${formatSize(item.sizeMb)}`}
        {elapsed > 0 && ` · ${formatDuration(elapsed)}`}
      </span>
    )
  }
  if (item.status === 'error') {
    return <span className="dl-badge dl-error" title={item.error}>✕ Erreur</span>
  }
  return <span className="dl-badge dl-cancelled">Annulé</span>
}

function DownloadRow({ item, onPlay }: { item: DownloadItem; onPlay: (item: DownloadItem) => void }): JSX.Element {
  const { cancel, pause, resume, remove } = useDownloads()
  const initials = item.title.slice(0, 2).toUpperCase()

  return (
    <div className="dl-row">
      <div className="dl-thumb">{initials}</div>
      <div className="dl-info">
        <div className="dl-title">{item.title}</div>
        {item.subtitle && <div className="dl-sub">{item.subtitle}</div>}
        <StatusBadge item={item} />
      </div>
      <div className="dl-actions">
        {item.status === 'done' && (
          <button className="dl-btn dl-btn-play" onClick={() => onPlay(item)} title="Lire">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          </button>
        )}
        {item.status === 'downloading' && (
          <button className="dl-btn dl-btn-pause" onClick={() => pause(item.id)} title="Mettre en pause">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          </button>
        )}
        {item.status === 'paused' && (
          <button className="dl-btn dl-btn-resume" onClick={() => resume(item.id)} title="Reprendre">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <polygon points="6,4 20,12 6,20" />
            </svg>
          </button>
        )}
        {(item.status === 'downloading' || item.status === 'paused') && (
          <button className="dl-btn dl-btn-cancel" onClick={() => cancel(item.id)} title="Annuler">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        {(item.status === 'done' || item.status === 'error' || item.status === 'cancelled') && (
          <button className="dl-btn dl-btn-delete" onClick={() => remove(item.id)} title="Supprimer">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4h6v2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

export default function Downloads({ onPlay }: Props): JSX.Element {
  const { items } = useDownloads()

  const active = items.filter((d) => d.status === 'downloading' || d.status === 'paused')
  const done = items.filter((d) => d.status !== 'downloading' && d.status !== 'paused')

  if (items.length === 0) {
    return (
      <main className="content">
        <header className="topbar">
          <h2>Téléchargements</h2>
          <OpenFolderButton />
        </header>
        <div className="dl-empty">
          <div className="dl-empty-icon">⬇</div>
          <p>Aucun téléchargement.</p>
          <p className="muted">Clic droit sur un film ou un épisode → <strong>Télécharger</strong>.</p>
        </div>
      </main>
    )
  }

  return (
    <main className="content">
      <header className="topbar">
        <h2>Téléchargements</h2>
        {active.length > 0 && (
          <span className="dl-header-active">{active.length} en cours</span>
        )}
        <OpenFolderButton />
      </header>
      <div className="dl-list">
        {active.length > 0 && (
          <section>
            <div className="dl-section-title">En cours</div>
            {active.map((d) => <DownloadRow key={d.id} item={d} onPlay={onPlay} />)}
          </section>
        )}
        {done.length > 0 && (
          <section>
            <div className="dl-section-title">Terminés</div>
            {done.map((d) => <DownloadRow key={d.id} item={d} onPlay={onPlay} />)}
          </section>
        )}
      </div>
    </main>
  )
}
