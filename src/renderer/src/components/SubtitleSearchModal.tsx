import { useEffect, useRef, useState } from 'react'
import type { OsubResult } from '../types'
import { downloadSubtitle, searchSubtitles } from '../lib/opensubtitles'

interface Props {
  /** Initial search query (media title). */
  initialQuery: string
  /** Episode subtitle string e.g. "S2 E3 · Title" — used to auto-suffix the query. */
  initialSubtitle?: string
  initialYear?: number
  onClose: () => void
  /** Called when a subtitle has been downloaded — passes the local file path. */
  onLoaded: (path: string) => void
}

/** Build "Title S02E03" from title + optional subtitle string. */
function buildQuery(title: string, subtitle?: string): string {
  if (!subtitle) return title
  const m = subtitle.match(/S(\d+)\s+(?:·\s+)?E(\d+)/i)
  if (!m) return title
  return `${title} S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}`
}

const LANGS = [
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'Anglais' }
]

export default function SubtitleSearchModal({
  initialQuery,
  initialSubtitle,
  initialYear,
  onClose,
  onLoaded
}: Props): JSX.Element {
  const [query, setQuery] = useState(() => buildQuery(initialQuery, initialSubtitle))
  const [lang, setLang] = useState('fr')
  const [results, setResults] = useState<OsubResult[]>([])
  const [searching, setSearching] = useState(false)
  const [downloading, setDownloading] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  useEffect(() => {
    void doSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  async function doSearch(): Promise<void> {
    const q = query.trim()
    if (!q) return
    const mine = ++seq.current
    setSearching(true)
    setFeedback(null)
    const res = await searchSubtitles(q, lang, initialYear)
    if (seq.current !== mine) return
    setResults(res)
    setSearching(false)
    if (res.length === 0) setFeedback('Aucun résultat. Essaie un titre différent ou une autre langue.')
  }

  async function pick(r: OsubResult): Promise<void> {
    setDownloading(r.fileId)
    setFeedback(null)
    const result = await downloadSubtitle(r.fileId, r.fileName)
    setDownloading(null)
    if ('error' in result) {
      setFeedback(result.error)
      return
    }
    if (result.remaining <= 2) {
      setFeedback(`Téléchargé. Quota restant aujourd'hui : ${result.remaining}`)
    }
    onLoaded(result.path)
    onClose()
  }

  function langLabel(code: string): string {
    return code === 'fr' ? 'FR' : code === 'en' ? 'EN' : code.toUpperCase()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal osub-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2 className="settings-title">Télécharger des sous-titres</h2>

        <div className="osub-search-row">
          <input
            className="search osub-query"
            type="text"
            placeholder="Titre…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doSearch() }}
            autoFocus
          />
          <div className="osub-lang-tabs">
            {LANGS.map((l) => (
              <button
                key={l.code}
                className={`osub-lang-btn ${lang === l.code ? 'on' : ''}`}
                onClick={() => setLang(l.code)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <button className="btn-ghost osub-search-btn" onClick={() => void doSearch()} disabled={searching}>
            {searching ? '…' : 'Chercher'}
          </button>
        </div>

        {feedback && <p className="osub-feedback muted">{feedback}</p>}

        <div className="osub-results">
          {searching ? (
            <div className="grid-state"><div className="spinner" /></div>
          ) : (
            results.map((r) => (
              <button
                key={r.fileId}
                className="osub-row"
                onClick={() => void pick(r)}
                disabled={downloading !== null}
              >
                {downloading === r.fileId ? (
                  <span className="osub-row-loading">Téléchargement…</span>
                ) : (
                  <>
                    <span className="osub-row-name">{r.releaseName}</span>
                    <span className="osub-row-meta muted">
                      {langLabel(r.language)} · {r.ext.toUpperCase()}
                      {r.rating > 0 && ` · ★ ${r.rating.toFixed(1)}`}
                      {r.downloads > 0 && ` · ${r.downloads.toLocaleString('fr')} dl`}
                    </span>
                  </>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
