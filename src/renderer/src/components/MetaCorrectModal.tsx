import { useEffect, useRef, useState } from 'react'
import type { Meta, MetaCandidate, MetaRequest } from '../types'
import { applyOverride, clearAssociation, searchMeta } from '../lib/metadata'

interface Props {
  req: MetaRequest
  current: Meta | null
  /** Current custom sort name for this title (empty = sort by displayed title). */
  sortName?: string
  onSortName?: (name: string) => void
  onClose: () => void
  onApplied: (m: Meta) => void
}

const KIND_LABEL: Record<MetaRequest['kind'], string> = {
  movies: 'film',
  series: 'série',
  anime: 'anime'
}

const PROVIDER_LABEL: Record<MetaCandidate['provider'], string> = {
  tmdb: 'TMDB',
  omdb: 'IMDb',
  jikan: 'MAL'
}

// "Corriger l'association" — search the right provider (OMDb for films/séries,
// Jikan/MAL for anime) and pin the chosen entry. Handles aliases/versions (SNK,
// FMA Brotherhood, HxH 2011). The media file is never renamed; only our JSON
// override changes.
export default function MetaCorrectModal({
  req,
  current,
  sortName = '',
  onSortName,
  onClose,
  onApplied
}: Props): JSX.Element {
  const [query, setQuery] = useState(req.title)
  const [sort, setSort] = useState(sortName)
  const [results, setResults] = useState<MetaCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setLoading(false)
      return
    }
    const mine = ++seq.current
    setLoading(true)
    const t = setTimeout(() => {
      searchMeta(req.kind, q)
        .then((r) => {
          if (seq.current === mine) setResults(r)
        })
        .finally(() => {
          if (seq.current === mine) setLoading(false)
        })
    }, 350)
    return () => clearTimeout(t)
  }, [query, req.kind])

  function commitSort(): void {
    if (onSortName && sort !== sortName) onSortName(sort)
  }

  async function choose(c: MetaCandidate): Promise<void> {
    commitSort()
    setBusy(true)
    const m = await applyOverride(req, c.provider, c.providerId)
    setBusy(false)
    if (m) {
      onApplied(m)
      onClose()
    }
  }

  async function dissociate(): Promise<void> {
    commitSort()
    setBusy(true)
    const m = await clearAssociation(req)
    setBusy(false)
    if (m) {
      onApplied(m)
      onClose()
    }
  }

  function close(): void {
    commitSort()
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal correct-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={close}>
          ✕
        </button>
        <h2 className="settings-title">Corriger l'association</h2>
        <p className="settings-sub">
          {KIND_LABEL[req.kind]} · «&nbsp;{req.title}&nbsp;»
          {current?.status === 'ok' && current.title && current.title !== req.title && (
            <>
              {' '}
              → actuellement <strong>{current.title}</strong>
              {current.year ? ` (${current.year})` : ''}
            </>
          )}
        </p>

        {onSortName && (
          <div className="sortname-row">
            <label className="sortname-label">Nom</label>
            <input
              className="search sortname-input"
              type="text"
              placeholder={current?.title || req.title}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              onBlur={commitSort}
            />
            <span className="sortname-hint muted">Remplace le nom affiché et le tri. Laisse vide pour utiliser le titre TMDB / nom du fichier.</span>
          </div>
        )}

        <input
          className="search correct-search"
          type="search"
          placeholder="Rechercher le bon titre / la bonne version…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="correct-results">
          {loading ? (
            <div className="grid-state">
              <div className="spinner" />
            </div>
          ) : results.length === 0 ? (
            <div className="grid-state muted">Aucun résultat.</div>
          ) : (
            results.map((c) => (
              <button
                key={`${c.provider}-${c.providerId}`}
                className={`correct-row ${current?.providerId === c.providerId ? 'on' : ''}`}
                onClick={() => choose(c)}
                disabled={busy}
              >
                <div className="correct-thumb">
                  {c.poster ? <img src={c.poster} alt="" loading="lazy" /> : <span>?</span>}
                </div>
                <div className="correct-meta">
                  <span className="correct-title">{c.title}</span>
                  <span className="correct-sub muted">
                    {[c.year, c.type, PROVIDER_LABEL[c.provider]].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="correct-actions">
          <button className="btn-ghost" onClick={dissociate} disabled={busy}>
            Dissocier (revenir à l'auto)
          </button>
        </div>
      </div>
    </div>
  )
}
