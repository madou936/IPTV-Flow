import { useEffect, useRef, useState } from 'react'
import type { Meta, MetaRequest } from '../types'
import {
  backdropOptions,
  metaKey,
  posterOptions,
  rawSetPoster,
  setCustomPoster
} from '../lib/metadata'

interface Props {
  req: MetaRequest
  current: Meta | null
  posterKey?: string
  season?: number
  currentPosterUrl?: string
  currentBackdropUrl?: string
  title?: string
  onClose: () => void
  onApplied: (m: Meta) => void
  onBackdropApplied?: (url: string) => void
}

export default function MetaPosterModal({
  req,
  current,
  posterKey,
  season,
  currentPosterUrl,
  currentBackdropUrl,
  title,
  onClose,
  onApplied,
  onBackdropApplied
}: Props): JSX.Element {
  const key = posterKey ?? metaKey(req.kind, req.title, req.year)
  const [tab, setTab] = useState<'poster' | 'backdrop'>('poster')
  const [posters, setPosters] = useState<string[]>([])
  const [backdrops, setBackdrops] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const alive = useRef(true)
  const hasBackdropTab = !!onBackdropApplied && season == null

  useEffect(() => {
    const fn = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  useEffect(() => {
    alive.current = true
    Promise.all([
      posterOptions(req, season),
      hasBackdropTab ? backdropOptions(req) : Promise.resolve([])
    ]).then(([posterList, backdropList]) => {
      if (!alive.current) return
      setPosters(posterList)
      setBackdrops(backdropList)
    }).finally(() => {
      if (alive.current) setLoading(false)
    })
    return () => { alive.current = false }
  }, [req, season, hasBackdropTab])

  async function applyPoster(value: string): Promise<void> {
    setBusy(true)
    const meta = await setCustomPoster(req, key, value)
    setBusy(false)
    if (meta) onApplied(meta)
    onClose()
  }

  async function applyBackdrop(value: string): Promise<void> {
    setBusy(true)
    await rawSetPoster(`backdrop:${key}`, value)
    setBusy(false)
    onBackdropApplied?.(value.trim())
    onClose()
  }

  const choices = tab === 'poster' ? posters : backdrops
  const currentUrl = tab === 'poster' ? (currentPosterUrl ?? current?.poster) : currentBackdropUrl
  const apply = tab === 'poster' ? applyPoster : applyBackdrop
  const manualUrl = currentUrl && !choices.includes(currentUrl) ? currentUrl : ''
  const pastedUrl = url.trim()
  const customChoices = pastedUrl && !choices.includes(pastedUrl) ? [pastedUrl] : []
  const visibleChoices = [...customChoices, ...choices]

  useEffect(() => {
    setUrl(manualUrl)
  }, [manualUrl])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal poster-modal artwork-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2 className="settings-title">Personnaliser les images</h2>
        <p className="settings-sub">{title ?? req.title}</p>

        {hasBackdropTab && (
          <div className="artwork-tabs">
            <button className={tab === 'poster' ? 'on' : ''} onClick={() => { setTab('poster'); setUrl('') }}>Affiche</button>
            <button className={tab === 'backdrop' ? 'on' : ''} onClick={() => { setTab('backdrop'); setUrl('') }}>Fond</button>
          </div>
        )}

        <div className={tab === 'poster' ? 'poster-grid' : 'backdrop-grid'}>
          {loading ? (
            <div className="grid-state"><div className="spinner" /></div>
          ) : visibleChoices.length === 0 ? (
            <div className="grid-state muted">
              Aucune image TMDB trouvée. Colle une URL ci-dessous.
            </div>
          ) : visibleChoices.map((image) => (
            <button
              key={image}
              className={`${tab === 'poster' ? 'poster-opt' : 'backdrop-opt'} ${currentUrl === image ? 'on' : ''}`}
              onClick={() => void apply(image)}
              disabled={busy}
            >
              <img src={image} alt="" loading="lazy" onError={(e) => { e.currentTarget.parentElement?.classList.add('broken') }} />
            </button>
          ))}
        </div>

        <div className="poster-url-row">
          <input
            className="search poster-url"
            type="url"
            placeholder={`…ou coller l’URL ${tab === 'poster' ? 'd’une affiche' : 'd’un fond'}`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn-ghost" onClick={() => void apply(pastedUrl)} disabled={busy || !pastedUrl}>
            Appliquer
          </button>
        </div>
        <div className="correct-actions">
          <button className="btn-ghost" onClick={() => void apply('')} disabled={busy}>
            Revenir à l’image automatique TMDB
          </button>
        </div>
      </div>
    </div>
  )
}
