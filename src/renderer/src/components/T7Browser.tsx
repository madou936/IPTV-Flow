import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT7, scanT7, getFilters, saveFilters } from '../lib/t7'
import { getAllProgress, getProgressState, getProgress, hideFromContinue, isHiddenFromContinue, onProgressChange } from '../lib/progress'
import {
  backdropOptions,
  getBackdropOverrides,
  getCollectionBackdrops,
  getCollectionDetails,
  getCollectionPosters,
  getCollections,
  getCollPosters,
  getEpisodeImages,
  getEpisodeNames,
  getLockedKeys,
  getSeasonPrefs,
  getSortNames,
  lockMeta,
  metaKey,
  movieCredits,
  peekEpisodeImages,
  peekEpisodeNames,
  rawSetPoster,
  refreshBackdrops,
  saveCollections,
  saveSeasonPrefs,
  seasonPosters as fetchSeasonPosters,
  setSortName,
  unlockMeta,
  useMeta,
  useMetaMap
} from '../lib/metadata'
import MetaCorrectModal from './MetaCorrectModal'
import MetaPosterModal from './MetaPosterModal'
import type {
  Collection,
  CollectionDetails,
  LocalEpisode,
  LocalMovie,
  LocalShow,
  Meta,
  MetaRequest,
  MovieCredits,
  ScanResult,
  SeasonPrefs,
  T7Filter,
  T7Kind,
  MediaQueueItem,
  MediaQueueGroup
} from '../types'

interface Props {
  onPlayMovie: (movie: LocalMovie, autoResume?: boolean, displayTitle?: string, queue?: MediaQueueItem[], queueIndex?: number) => void
  onPlayEpisode: (episodes: LocalEpisode[], index: number, showTitle: string, season: number, autoResume?: boolean, show?: LocalShow, episodeTitle?: string, displayShowTitle?: string, queue?: MediaQueueItem[], queueIndex?: number, queueGroups?: MediaQueueGroup[], queueGroupIndex?: number) => void
  onBackToLogin?: () => void
  exporterRef?: React.MutableRefObject<(() => void) | null>
}

// Picture/landscape icon used on the "change poster" button.
const posterIcon = (
  <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', flexShrink: 0 }}>
    <rect x="2" y="3" width="16" height="14" rx="2" />
    <circle cx="7" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
    <polyline points="2,14 6,10 9,13 13,9 18,14" />
  </svg>
)

function PersonPortrait({ photo, name }: { photo?: string; name: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  if (photo && !broken) {
    return <img src={photo} alt={name} loading="lazy" onError={() => setBroken(true)} />
  }
  return (
    <div className="person-placeholder" aria-label={`Aucune photo pour ${name}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4.5 21c.7-4.4 3.2-6.6 7.5-6.6s6.8 2.2 7.5 6.6" />
      </svg>
    </div>
  )
}

function ExpandablePlot({ text, className = '' }: { text: string; className?: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    setExpanded(false)
  }, [text])

  useLayoutEffect(() => {
    const node = textRef.current
    if (!node) return
    const measure = (): void => {
      if (expanded) {
        setCanExpand(true)
        return
      }
      setCanExpand(node.scrollHeight - node.clientHeight > 2)
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(node)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [expanded, text])

  return (
    <div className={`plot-block ${className}`}>
      <p ref={textRef} className={`show-plot${expanded ? ' expanded' : ''}`}>{text}</p>
      {canExpand && (
        <button className="plot-more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Voir moins' : 'Voir plus'}
        </button>
      )}
    </div>
  )
}

function DetailInfoModal({
  title,
  subtitle,
  plot,
  details,
  onClose
}: {
  title: string
  subtitle?: string
  plot?: string
  details: Array<{ label: string; value?: string | number | null }>
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const fn = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', fn, true)
    return () => window.removeEventListener('keydown', fn, true)
  }, [onClose])

  const filtered = details.filter((item) => item.value != null && item.value !== '')

  return (
    <div className="modal-backdrop detail-info-backdrop" onClick={onClose}>
      <div className="modal detail-info-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="detail-info-copy">
          <h3 className="detail-info-title">{title}</h3>
          {subtitle && <p className="detail-info-sub">{subtitle}</p>}
          {plot && <ExpandablePlot text={plot} className="detail-info-plot" />}
        </div>
        {filtered.length > 0 && (
          <div className="detail-info-grid">
            {filtered.map((item) => (
              <div key={`${item.label}:${String(item.value)}`} className="detail-info-item">
                <span className="detail-info-label">{item.label}</span>
                <strong className="detail-info-value">{item.value}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const CATS: { id: T7Kind; label: string }[] = [
  { id: 'movies', label: 'Films' },
  { id: 'series', label: 'Séries' },
  { id: 'anime', label: 'Anime' }
]
const RENDER_CAP = 600

function norm(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}
function seasonLabel(n: number): string {
  return n === 0 ? 'Spéciaux' : `Saison ${n}`
}
function epCount(show: LocalShow): number {
  return show.seasons.reduce((n, s) => n + s.episodes.length, 0)
}
function orderedShowSeasons(show: LocalShow): LocalShow['seasons'] {
  return [...show.seasons.filter((s) => s.season !== 0), ...show.seasons.filter((s) => s.season === 0)]
}
function fmtResumeTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}
function initials(s: string): string {
  return (s || '?').slice(0, 2).toUpperCase()
}

/** Poster image that falls back to initials/label if the URL is missing or fails
 * to load (e.g. a pasted page URL instead of an image) — so a bad custom poster
 * never leaves a broken tile without its "Changer l'affiche" button. */
function Poster({ src, fallback }: { src?: string; fallback: string }): JSX.Element {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  if (!src || broken) return <div className="card-fallback">{fallback}</div>
  return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
}
function rand(): string {
  return Math.random().toString(36).slice(2, 10)
}
function movieReq(m: LocalMovie): MetaRequest {
  return { kind: 'movies', title: m.title, year: m.year }
}
function showReq(kind: T7Kind, s: LocalShow): MetaRequest {
  return { kind, title: s.title }
}
function episodeNamesKey(kind: T7Kind, show: LocalShow, season: number): string {
  return `${metaKey(kind, show.title)}#s${season}`
}
function buildShowQueueGroups(
  show: LocalShow,
  displayTitle: string,
  seasonLabelFor: (season: number) => string,
  episodeNameFor: (season: number, episode: LocalEpisode) => string
): MediaQueueGroup[] {
  return orderedShowSeasons(show).map((seasonEntry) => ({
    id: `season-${seasonEntry.season}`,
    label: seasonLabelFor(seasonEntry.season),
    items: seasonEntry.episodes.map((ep) => {
      const episodeTitle = episodeNameFor(seasonEntry.season, ep)
      return {
        id: ep.id,
        title: displayTitle,
        subtitle: `${seasonEntry.season === 0 ? 'Spéciaux' : `S${seasonEntry.season}`} · E${ep.episode} · ${episodeTitle}`,
        src: ep.filePath,
        resumeKey: `t7-${ep.id}`,
        local: true,
        requiresT7: true,
        localSubs: ep.subs,
        audioPrefKey: `t7-series-${show.title.trim().toLowerCase()}`
      }
    })
  }))
}

/** A poster card backed by lazily-fetched metadata (OMDb/Jikan/Wikipédia FR).
 * Falls back to the scanned title + initials until/if metadata arrives. */
function MetaTile({
  req,
  fallbackTitle,
  titleOverride,
  sub,
  onClick,
  onPrefetch,
  onCorrect,
  onChangePoster,
  selectMode = false,
  selected = false,
  isLocked = false,
  onToggleLock
}: {
  req: MetaRequest
  fallbackTitle: string
  titleOverride?: string
  sub?: string
  onClick: (displayTitle: string) => void
  onPrefetch?: () => void
  onCorrect?: (meta: Meta | null) => void
  onChangePoster?: (meta: Meta | null) => void
  selectMode?: boolean
  selected?: boolean
  isLocked?: boolean
  onToggleLock?: () => void
}): JSX.Element {
  const meta = useMeta(req)
  const ok = meta?.status === 'ok'
  const poster = ok ? meta?.poster : undefined
  const title = titleOverride || (ok && meta?.title) || fallbackTitle
  const review = !!(ok && meta?.needsReview)
  return (
    <button
      className={`card ${selected ? 'card-sel' : ''}`}
      onClick={() => onClick(title)}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      title={title}
    >
      <div className="card-thumb">
        <Poster src={poster} fallback={initials(fallbackTitle)} />
        <span className="card-play">{selectMode ? (selected ? '✓' : '+') : '▶'}</span>
        {ok && meta?.rating && !selectMode && <span className="meta-rating">★ {meta.rating}</span>}
        {selected && <span className="card-check">✓</span>}
        {onChangePoster && !selectMode && !isLocked && (
          <span
            className="card-poster"
            role="button"
            title="Changer l'affiche"
            onClick={(e) => {
              e.stopPropagation()
              onChangePoster(meta)
            }}
          >
            {posterIcon}
          </span>
        )}
        {onCorrect && !selectMode && !isLocked && (
          <span
            className={`card-corr ${review ? 'review' : ''}`}
            role="button"
            title={review ? 'Association à vérifier — corriger' : "Corriger l'association"}
            onClick={(e) => {
              e.stopPropagation()
              onCorrect(meta)
            }}
          >
            {review ? '!' : '✎'}
          </span>
        )}
        {onToggleLock && !selectMode && (
          <span
            className={`card-lock ${isLocked ? 'card-lock-on' : 'card-lock-off'}`}
            role="button"
            title={isLocked ? 'Métadonnées verrouillées — cliquer pour déverrouiller' : 'Verrouiller les métadonnées'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleLock()
            }}
          >
            {isLocked ? '🔒' : '🔓'}
          </span>
        )}
        {meta !== null && meta.status !== 'ok' && !selectMode && (
          <span className="card-issue" title="Métadonnées introuvables" />
        )}
      </div>
      <div className="card-title">
        {title}
        {sub && <span className="t7-tile-sub"> {sub}</span>}
      </div>
    </button>
  )
}

interface ContinueItem {
  type: 'movie' | 'episode'
  movie?: LocalMovie
  show?: LocalShow
  showKind?: T7Kind
  episode?: LocalEpisode
  season?: number
  hideKeys: string[]
  pos: number
  dur: number
  ts: number
  pct: number
}

interface DisplayColl {
  id: string
  name: string
  keys: string[]
  movies: LocalMovie[]
  poster?: string
  manual: boolean
}

/** One cell in the films grid — either a saga tile or a standalone movie. */
type MovieGridItem =
  | { type: 'coll'; key: string; name: string; coll: DisplayColl }
  | { type: 'movie'; key: string; name: string; movie: LocalMovie }


function ContinueTile({
  req,
  fallbackTitle,
  sub,
  pct,
  onClick,
  onRemove
}: {
  req: MetaRequest
  fallbackTitle: string
  sub?: string
  pct: number
  onClick: (displayTitle: string) => void
  onRemove: () => void
}): JSX.Element {
  const meta = useMeta(req)
  const ok = meta?.status === 'ok'
  const poster = ok ? meta?.poster : undefined
  const title = (ok && meta?.title) || fallbackTitle
  return (
    <button className="card" onClick={() => onClick(title)} title={title}>
      <div className="card-thumb">
        <Poster src={poster} fallback={initials(fallbackTitle)} />
        <span className="card-play">▶</span>
        <div className="card-progress" style={{ width: `${Math.round(pct * 100)}%` }} />
        <span
          className="card-remove"
          role="button"
          title="Retirer de En cours"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
        >×</span>
      </div>
      <div className="card-title">
        {title}
        {sub && <span className="t7-tile-sub"> {sub}</span>}
      </div>
    </button>
  )
}

/** Saga / collection tile (stacked look). Poster comes from the saved override
 * or the first member's metadata. */
function CollectionTile({
  coll,
  posterOverride,
  onClick,
  onChangePoster
}: {
  coll: DisplayColl
  posterOverride?: string
  onClick: () => void
  onChangePoster?: () => void
}): JSX.Element {
  const first = coll.movies[0]
  const meta = useMeta(first ? movieReq(first) : null)
  const poster = posterOverride || coll.poster || (meta?.status === 'ok' ? meta?.poster : undefined)
  return (
    <button className="card card-coll" onClick={onClick} title={coll.name}>
      <div className="card-thumb coll-thumb">
        <Poster src={poster} fallback={initials(coll.name)} />
        <span className="coll-badge">▦ {coll.movies.length}</span>
        <span className="card-play">▶</span>
        {onChangePoster && (
          <span
            className="card-poster"
            role="button"
            title="Changer l'affiche de la saga"
            onClick={(e) => { e.stopPropagation(); onChangePoster() }}
          >
            {posterIcon}
          </span>
        )}
      </div>
      <div className="card-title">
        {coll.name.replace(/\s*-\s*saga\s*$/i, '')}
        <span className="t7-tile-sub"> · saga</span>
      </div>
    </button>
  )
}

function LocalMovieDetail({
  movie,
  onClose,
  onBack,
  onPlay,
  onCorrect,
  onChangePoster,
  isLocked = false,
  onToggleLock,
  backdropOverride,
  queue,
  queueIndex = 0
}: {
  movie: LocalMovie
  onClose: () => void
  onBack?: () => void
  onPlay: (m: LocalMovie, displayTitle?: string, queue?: MediaQueueItem[], queueIndex?: number) => void
  onCorrect: (meta: Meta | null) => void
  onChangePoster: (meta: Meta | null) => void
  isLocked?: boolean
  onToggleLock?: () => void
  backdropOverride?: string
  queue?: MediaQueueItem[]
  queueIndex?: number
}): JSX.Element {
  const meta = useMeta(movieReq(movie))
  const [backgroundBroken, setBackgroundBroken] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [credits, setCredits] = useState<MovieCredits>({ cast: [] })
  const ok = meta?.status === 'ok'
  const title = (ok && meta?.title) || movie.title
  const progress = getProgress(`t7-${movie.id}`)
  const duration = (ok && meta?.runtime ? parseInt(meta.runtime, 10) * 60 : 0) || 0
  const hasPct = progress > 0 && duration > 0 && progress / duration < 0.95
  const canEditMeta = !isLocked

  useEffect(() => {
    const fn = (e: KeyboardEvent): void => {
      if (document.querySelector('.poster-modal, .correct-modal, .osub-modal')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (onBack && (e.key === 'Backspace' || e.key === 'Delete')) {
        const target = e.target as HTMLElement | null
        if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return
        e.preventDefault()
        e.stopPropagation()
        onBack()
      }
    }
    window.addEventListener('keydown', fn, true)
    return () => window.removeEventListener('keydown', fn, true)
  }, [onBack, onClose])

  useEffect(() => {
    let alive = true
    movieCredits(movieReq(movie))
      .then((result) => { if (alive) setCredits(result) })
      .catch(() => { if (alive) setCredits({ cast: [] }) })
    return () => { alive = false }
  }, [movie.id])

  function fmt(sec: number): string {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`
  }
  const year = (ok && meta?.year) || movie.year
  const heroSrc = localStorage.getItem('t7_backdrops') === '0'
    ? undefined
    : backdropOverride || (ok ? meta?.backdrop : undefined)
  useEffect(() => setBackgroundBroken(false), [heroSrc])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal movie-detail-modal${heroSrc && !backgroundBroken ? ' has-screen-bg' : ''}`} onClick={(e) => e.stopPropagation()}>
        {heroSrc && !backgroundBroken && (
          <div className="detail-screen-bg" aria-hidden="true">
            <img src={heroSrc} alt="" onError={() => setBackgroundBroken(true)} />
            <div className="detail-screen-shade" />
          </div>
        )}
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="detail-body">
        <div className="show-head">
          <div className="show-poster">
            <Poster src={ok ? meta?.poster : undefined} fallback={initials(movie.title)} />
          </div>
          <div className="show-head-info">
            <h2 className="settings-title">{title}</h2>
            <p className="settings-sub">
              {[year, ok && meta?.genre, ok && meta?.runtime ? fmt(parseInt(meta.runtime, 10) * 60) : null, ok && meta?.rating ? `★ ${meta.rating}` : null]
                .filter(Boolean).join(' · ')}
            </p>
            <div className="show-head-actions movie-detail-actions">
              <button className="btn-ghost detail-info-btn" onClick={() => setShowInfo(true)}>
                Voir les infos
              </button>
            </div>
            <div className="detail-toolbar detail-toolbar-bottom">
              <button className="btn-primary detail-hero-btn" onClick={() => onPlay(movie, title, queue, queueIndex)}>
                {hasPct ? `▶ Reprendre à ${fmt(progress)}` : '▶ Lire'}
              </button>
              {canEditMeta && (
                <>
                  <button className="btn-ghost show-corr detail-hero-btn" onClick={() => onCorrect(meta)}>
                    {meta?.needsReview ? "⚠︎ Corriger l'association" : "Corriger l'association"}
                  </button>
                  <button className="btn-ghost show-corr detail-hero-btn" onClick={() => onChangePoster(meta)}>
                    Changer l'affiche
                  </button>
                </>
              )}
              {onToggleLock && (
                <button
                  className={`detail-lock-toggle ${isLocked ? 'on' : 'off'}`}
                  onClick={onToggleLock}
                  title={isLocked ? 'Métadonnées verrouillées — cliquer pour déverrouiller' : 'Verrouiller les métadonnées'}
                >
                  {isLocked ? '🔒' : '🔓'}
                </button>
              )}
            </div>
          </div>
        </div>
        {(credits.director || credits.cast.length > 0) && (
          <section className="movie-credits detail-media-section">
            <div className="credits-group credits-cast">
              <h3>Acteurs principaux</h3>
              <div className="people-row">
                {credits.director && (
                  <div className="person-card">
                    <div className="person-photo"><PersonPortrait photo={credits.director.photo} name={credits.director.name} /></div>
                    <strong>{credits.director.name}</strong>
                    <span>Réalisateur</span>
                  </div>
                )}
                {credits.cast.map((person) => (
                  <div className="person-card" key={`${person.name}:${person.character ?? ''}`}>
                    <div className="person-photo"><PersonPortrait photo={person.photo} name={person.name} /></div>
                    <strong>{person.name}</strong>
                    <span>{person.character || 'Interprète'}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
        {showInfo && (
          <DetailInfoModal
            title={title}
            subtitle={year ? String(year) : undefined}
            plot={ok ? meta?.plot : undefined}
            details={[
              { label: 'Titre original', value: ok ? meta?.originalTitle : null },
              { label: 'Genre', value: ok ? meta?.genre : null },
              { label: 'Durée', value: ok ? meta?.runtime : null },
              { label: 'Note', value: ok ? meta?.rating : null },
              { label: 'Fichier', value: movie.filePath.split('/').pop() },
              { label: 'Dossier', value: movie.folder }
            ]}
            onClose={() => setShowInfo(false)}
          />
        )}
        </div>
      </div>
    </div>
  )
}

function CollectionView({
  coll,
  posterOverride,
  backdropOverride,
  sortNames,
  onClose,
  onPlay,
  onCorrect,
  onChangePoster,
  onChangeCollPoster,
  onRename,
  onDelete,
  lockedKeys,
  onToggleLock,
  onOpenDetail
}: {
  coll: DisplayColl
  posterOverride?: string
  backdropOverride?: string
  sortNames?: Record<string, string>
  onClose: () => void
  onPlay: (m: LocalMovie, displayTitle?: string, queue?: MediaQueueItem[], queueIndex?: number) => void
  onCorrect: (m: LocalMovie, meta: Meta | null) => void
  onChangePoster: (m: LocalMovie, meta: Meta | null) => void
  onChangeCollPoster?: () => void
  onRename?: (name: string) => void
  onDelete?: () => void
  lockedKeys?: Set<string>
  onToggleLock?: (key: string) => void
  onOpenDetail?: (m: LocalMovie) => void
}): JSX.Element {
  const [name, setName] = useState(coll.name)
  const [editingName, setEditingName] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [details, setDetails] = useState<CollectionDetails>({})
  const firstMeta = useMeta(coll.movies[0] ? movieReq(coll.movies[0]) : null)
  const collectionMeta = useMetaMap(coll.movies.map(movieReq))
  const [backgroundBroken, setBackgroundBroken] = useState(false)
  const tmdbCollectionId = coll.id.startsWith('tmdb:')
    ? Number(coll.id.slice(5))
    : firstMeta?.collectionId
  useEffect(() => {
    if (!tmdbCollectionId) {
      setDetails({})
      return
    }
    let alive = true
    getCollectionDetails(tmdbCollectionId)
      .then((value) => { if (alive) setDetails(value) })
      .catch(() => { if (alive) setDetails({}) })
    return () => { alive = false }
  }, [tmdbCollectionId])
  const autoBackdrop = details.backdrop || (firstMeta?.status === 'ok' ? firstMeta.backdrop : undefined)
  const heroSrc = localStorage.getItem('t7_backdrops') === '0'
    ? undefined
    : backdropOverride || autoBackdrop
  useEffect(() => setBackgroundBroken(false), [heroSrc])
  const years = coll.movies
    .map((movie) => collectionMeta.get(metaKey('movies', movie.title, movie.year))?.year ?? movie.year)
    .filter((year): year is number => typeof year === 'number')
  const firstYear = years.length ? Math.min(...years) : undefined
  const lastYear = years.length ? Math.max(...years) : undefined
  const ratings = coll.movies
    .map((movie) => Number(collectionMeta.get(metaKey('movies', movie.title, movie.year))?.rating))
    .filter((rating) => Number.isFinite(rating) && rating > 0)
  const averageRating = ratings.length
    ? (ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(1)
    : undefined

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (document.querySelector('.poster-modal, .correct-modal, .osub-modal')) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal coll-modal${heroSrc && !backgroundBroken ? ' has-screen-bg' : ''}`} onClick={(e) => e.stopPropagation()}>
        {heroSrc && !backgroundBroken && (
          <div className="detail-screen-bg" aria-hidden="true">
            <img src={heroSrc} alt="" onError={() => setBackgroundBroken(true)} />
            <div className="detail-screen-shade" />
          </div>
        )}
        <div className="coll-top-actions">
          {coll.manual && onRename && !editingName && (
            <button className="btn-ghost coll-icon-btn" onClick={() => setEditingName(true)} title="Renommer la collection">
              ✎
            </button>
          )}
          {onChangeCollPoster && (
            <button className="btn-ghost coll-icon-btn" onClick={onChangeCollPoster} title="Changer l’affiche ou le fond de la saga">
              {posterIcon}
            </button>
          )}
          <button className="modal-close coll-close" onClick={onClose}>✕</button>
        </div>
        <div className="coll-body">
        <div className="show-head coll-head">
          <div className="show-poster">
            <Poster src={posterOverride || details.poster} fallback={initials(coll.name)} />
          </div>
          <div className="show-head-info">
            <div className="coll-title-row">
              {coll.manual && onRename && editingName ? (
                <input
                  className="coll-name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => {
                    const n = name.trim()
                    if (n && n !== coll.name) onRename(n)
                    setEditingName(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') {
                      setName(coll.name)
                      setEditingName(false)
                    }
                  }}
                  autoFocus
                />
              ) : (
                <h2 className="settings-title">{coll.name}</h2>
              )}
            </div>
            <p className="settings-sub">
              {[
                `${coll.movies.length} film${coll.movies.length > 1 ? 's' : ''}`,
                firstYear && lastYear ? (firstYear === lastYear ? `${firstYear}` : `${firstYear}–${lastYear}`) : null,
                averageRating ? `★ ${averageRating}` : null,
                coll.manual ? 'Saga manuelle' : 'Collection'
              ].filter(Boolean).join(' · ')}
            </p>
            <div className="detail-toolbar coll-toolbar">
              <button className="btn-ghost detail-hero-btn detail-info-btn" onClick={() => setShowInfo(true)}>
                Voir les infos
              </button>
            </div>
          </div>
        </div>
        <section className="detail-media-section">
        <h3 className="coll-films-title">Films de la collection</h3>
        <div className="grid grid-poster coll-grid">
          {coll.movies.map((m) => {
            const mk = metaKey('movies', m.title, m.year)
            return (
              <MetaTile
                key={m.id}
                req={movieReq(m)}
                fallbackTitle={m.title}
                titleOverride={sortNames?.[mk] || undefined}
                sub={m.year ? `(${m.year})` : undefined}
                onPrefetch={() => { void movieCredits(movieReq(m)) }}
                onClick={() => onOpenDetail ? onOpenDetail(m) : onPlay(m, collectionMeta.get(mk)?.title || m.title, coll.movies.map((movie) => {
                  const movieMeta = collectionMeta.get(metaKey('movies', movie.title, movie.year))
                  return { id: movie.id, title: movieMeta?.title || movie.title, src: movie.filePath, resumeKey: `t7-${movie.id}`, local: true, requiresT7: true, localSubs: movie.subs }
                }), coll.movies.findIndex((movie) => movie.id === m.id))}
                onCorrect={(meta) => onCorrect(m, meta)}
                onChangePoster={(meta) => onChangePoster(m, meta)}
                isLocked={lockedKeys?.has(mk)}
                onToggleLock={onToggleLock ? () => onToggleLock(mk) : undefined}
              />
            )
          })}
        </div>
        </section>
        {coll.manual && onDelete && (
          <div className="coll-actions">
            <button className="btn-ghost" onClick={onDelete}>
              Supprimer la saga
            </button>
          </div>
        )}
        {showInfo && (
          <DetailInfoModal
            title={coll.name}
            subtitle={coll.manual ? 'Saga manuelle' : 'Collection'}
            plot={details.overview}
            details={[
              { label: 'Films', value: coll.movies.length },
              { label: 'Période', value: firstYear && lastYear ? (firstYear === lastYear ? `${firstYear}` : `${firstYear}–${lastYear}`) : null },
              { label: 'Note moyenne', value: averageRating ? `★ ${averageRating}` : null },
              { label: 'Type', value: coll.manual ? 'Saga manuelle' : 'Collection TMDB / auto' }
            ]}
            onClose={() => setShowInfo(false)}
          />
        )}
        </div>
      </div>
    </div>
  )
}

function LocalSeriesDetail({
  show,
  kind,
  titleOverride,
  onClose,
  onPlayEpisode,
  onCorrect,
  onChangePoster,
  isLocked = false,
  onToggleLock,
  backdropOverride
}: {
  show: LocalShow
  kind: T7Kind
  titleOverride?: string
  onClose: () => void
  onPlayEpisode: Props['onPlayEpisode']
  onCorrect: (meta: Meta | null) => void
  onChangePoster: (meta: Meta | null) => void
  isLocked?: boolean
  onToggleLock?: () => void
  backdropOverride?: string
}): JSX.Element {
  const isAnime = kind === 'anime'
  const mk = metaKey(kind, show.title)
  const meta = useMeta(showReq(kind, show))
  const ok = meta?.status === 'ok'
  const title = titleOverride || (ok && meta?.title) || show.title
  const [showInfo, setShowInfo] = useState(false)
  const [prefs, setPrefs] = useState<SeasonPrefs>({ labels: {}, order: [] })
  const [editSeasons, setEditSeasons] = useState(false)
  const [progressVersion, setProgressVersion] = useState(0)
  const episodeReq = useMemo(() => ({ kind, title: show.title } as MetaRequest), [kind, show.title])
  const [episodeImages, setEpisodeImages] = useState<Record<number, string>>({})
  const [backgroundBroken, setBackgroundBroken] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const canEditMeta = !isLocked

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (document.querySelector('.poster-modal, .correct-modal, .osub-modal')) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  useEffect(() => onProgressChange(() => setProgressVersion((v) => v + 1)), [])

  useEffect(() => {
    if (!isAnime) return
    getSeasonPrefs(mk).then(setPrefs).catch(() => undefined)
  }, [isAnime, mk])

  const orderedSeasons = useMemo(() => {
    let base: typeof show.seasons
    if (!isAnime || prefs.order.length === 0) {
      base = show.seasons
    } else {
      const byNum = new Map(show.seasons.map((s) => [s.season, s] as const))
      const out: typeof show.seasons = []
      for (const n of prefs.order) {
        const s = byNum.get(n)
        if (s) { out.push(s); byNum.delete(n) }
      }
      for (const s of show.seasons) if (byNum.has(s.season)) out.push(s)
      base = out
    }
    return orderedShowSeasons({ ...show, seasons: base })
  }, [isAnime, prefs.order, show.seasons])

  const labelFor = (n: number): string => (isAnime && prefs.labels[n]) || seasonLabel(n)

  const [season, setSeason] = useState(orderedSeasons[0]?.season ?? 1)
  useEffect(() => {
    if (!orderedSeasons.some((s) => s.season === season)) setSeason(orderedSeasons[0]?.season ?? 1)
  }, [orderedSeasons, season])
  const current = orderedSeasons.find((s) => s.season === season) ?? orderedSeasons[0]

  const multiSeason = orderedSeasons.length > 1
  const [drilled, setDrilled] = useState(false)
  const episodeListVisible = !editSeasons && (!multiSeason || drilled)

  function handleEpisodeListScroll(e: React.UIEvent<HTMLDivElement>): void {
    const top = e.currentTarget.scrollTop
    if (!episodeListVisible || top < 96) {
      setScrolled(false)
      return
    }
    setScrolled(true)
  }
  const [seasonPosterMap, setSeasonPosterMap] = useState<Record<number, string>>({})
  const [posterRefresh, setPosterRefresh] = useState(0)
  const [editPoster, setEditPoster] = useState<number | null>(null)

  useEffect(() => {
    if (!multiSeason || !drilled || editSeasons) return
    const onKeyDown = (e: KeyboardEvent): void => {
      const isBackKey =
        e.key === 'Backspace' ||
        e.key === 'Delete' ||
        e.code === 'Backspace'
      if (!isBackKey || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      e.preventDefault()
      e.stopPropagation()
      setDrilled(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [drilled, editSeasons, multiSeason])
  useEffect(() => {
    if (!multiSeason) return
    let alive = true
    fetchSeasonPosters(showReq(kind, show), posterRefresh > 0)
      .then((m) => {
        if (alive) setSeasonPosterMap(m)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [multiSeason, kind, show, posterRefresh])

  const [episodeNames, setEpisodeNames] = useState<Record<number, string>>({})
  const [episodeNamesBySeason, setEpisodeNamesBySeason] = useState<Record<number, Record<number, string>>>({})
  useEffect(() => {
    const targetSeason = current?.season
    if (targetSeason == null) return
    let alive = true
    const offset = show.seasons
      .filter((s) => targetSeason !== 0 && s.season > 0 && s.season < targetSeason)
      .reduce((sum, s) => sum + s.episodes.length, 0)
    const firstEpNum = current?.episodes[0]?.episode
    const globalNumbering = targetSeason !== 0 && firstEpNum != null && firstEpNum > 1
    setEpisodeNames(peekEpisodeNames(episodeReq, targetSeason, offset, globalNumbering))
    setEpisodeImages(peekEpisodeImages(episodeReq, targetSeason, offset, globalNumbering))
    getEpisodeNames(episodeReq, targetSeason, offset, globalNumbering)
      .then((names) => { if (alive) { setEpisodeNames(names); setEpisodeNamesBySeason((prev) => ({ ...prev, [targetSeason]: names })) } })
      .catch(() => undefined)
    getEpisodeImages(episodeReq, targetSeason, offset, globalNumbering)
      .then((images) => { if (alive) setEpisodeImages(images) })
      .catch(() => { if (alive) setEpisodeImages({}) })
    return () => { alive = false }
  }, [episodeReq, show.seasons, current?.season])

  useEffect(() => {
    let alive = true
    Promise.all(orderedSeasons.map(async (seasonEntry) => {
      const offset = show.seasons
        .filter((s) => seasonEntry.season !== 0 && s.season > 0 && s.season < seasonEntry.season)
        .reduce((sum, s) => sum + s.episodes.length, 0)
      const firstEpNum = seasonEntry.episodes[0]?.episode
      const globalNumbering = seasonEntry.season !== 0 && firstEpNum != null && firstEpNum > 1
      const names = await getEpisodeNames(episodeReq, seasonEntry.season, offset, globalNumbering).catch(() => ({} as Record<number, string>))
      return [seasonEntry.season, names] as const
    })).then((entries) => {
      if (!alive) return
      setEpisodeNamesBySeason(Object.fromEntries(entries))
    })
    return () => { alive = false }
  }, [episodeReq, orderedSeasons, show.seasons])

  function persistPrefs(next: SeasonPrefs): void {
    setPrefs(next)
    void saveSeasonPrefs(mk, next)
  }
  function setLabel(n: number, value: string): void {
    const labels = { ...prefs.labels }
    if (value) labels[n] = value
    else delete labels[n]
    persistPrefs({ ...prefs, labels })
  }
  function setTmdbSeason(n: number, value: string): void {
    const map = { ...(prefs.tmdbSeasonMap ?? {}) }
    const v = parseInt(value, 10)
    if (!isNaN(v) && v >= 1) map[String(n)] = v
    else delete map[String(n)]
    persistPrefs({ ...prefs, tmdbSeasonMap: Object.keys(map).length ? map : undefined })
  }
  function setTmdbEpStart(n: number, value: string): void {
    const map = { ...(prefs.tmdbEpStart ?? {}) }
    const v = parseInt(value, 10)
    if (!isNaN(v) && v >= 1) map[String(n)] = v
    else delete map[String(n)]
    persistPrefs({ ...prefs, tmdbEpStart: Object.keys(map).length ? map : undefined })
  }
  function moveSeason(idx: number, dir: -1 | 1): void {
    const order = orderedSeasons.map((s) => s.season)
    const j = idx + dir
    if (j < 0 || j >= order.length) return
    ;[order[idx], order[j]] = [order[j], order[idx]]
    persistPrefs({ ...prefs, order })
  }

  const heroSrc = localStorage.getItem('t7_backdrops') === '0'
    ? undefined
    : backdropOverride || (ok ? meta?.backdrop : undefined)
  useEffect(() => setBackgroundBroken(false), [heroSrc])
  const currentSeasonPoster = current ? seasonPosterMap[current.season] : undefined
  const episodeTiles = (current?.episodes ?? []).map((ep, idx) => {
    const progress = getProgressState(`t7-${ep.id}`)
    const episodeTitle = episodeNames[ep.episode] || ep.title || `Épisode ${ep.episode}`
    const thumb = episodeImages[ep.episode] || currentSeasonPoster || (ok ? meta?.backdrop : undefined) || (ok ? meta?.poster : undefined)
    return {
      ep,
      idx,
      progress,
      episodeTitle,
      thumb
    }
  })
  const episodeQueueGroups: MediaQueueGroup[] = buildShowQueueGroups(
    { ...show, seasons: orderedSeasons },
    title,
    labelFor,
    (seasonNum, ep) =>
      episodeNamesBySeason[seasonNum]?.[ep.episode]
      || (seasonNum === current?.season ? episodeNames[ep.episode] : undefined)
      || ep.title
      || `Épisode ${ep.episode}`
  )
  const episodeQueueGroupIndex = Math.max(0, episodeQueueGroups.findIndex((group) => group.id === `season-${current?.season ?? season}`))
  const episodeQueue = episodeQueueGroups[episodeQueueGroupIndex]?.items ?? []
  const resumeTarget = useMemo(() => {
    const progress = getAllProgress()
    let best: {
      seasonEntry: LocalShow['seasons'][number]
      episode: LocalEpisode
      index: number
      pos: number
      ts: number
    } | null = null
    for (const seasonEntry of orderedSeasons) {
      for (let index = 0; index < seasonEntry.episodes.length; index++) {
        const ep = seasonEntry.episodes[index]
        const entry = progress[`t7-${ep.id}`]
        if (!entry || entry.completed || entry.pos <= 180 || (entry.dur > 0 && entry.pos >= entry.dur * 0.95)) continue
        if (!best || entry.ts > best.ts) best = { seasonEntry, episode: ep, index, pos: entry.pos, ts: entry.ts }
      }
    }
    return best
  }, [orderedSeasons, progressVersion])

  return (
    <div className={`modal-backdrop${scrolled && episodeListVisible ? ' modal-backdrop-scrolled' : ''}`} onClick={onClose}>
      <div className={`modal movie-detail-modal t7-series-detail-modal${heroSrc && !backgroundBroken ? ' has-screen-bg' : ''}${scrolled ? ' is-scrolled' : ''}`} onClick={(e) => e.stopPropagation()}>
        {heroSrc && !backgroundBroken && (
          <div className="detail-screen-bg" aria-hidden="true">
            <img src={heroSrc} alt="" onError={() => setBackgroundBroken(true)} />
            <div className="detail-screen-shade" />
          </div>
        )}
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="detail-body" onScroll={handleEpisodeListScroll}>

        <div className="show-head">
          <div className="show-poster">
            <Poster src={ok ? meta?.poster : undefined} fallback={initials(show.title)} />
          </div>
          <div className="show-head-info">
            <h2 className="settings-title">{title}</h2>
            <p className="settings-sub">
              {[ok && meta?.year, `${show.seasons.length} saison${show.seasons.length > 1 ? 's' : ''}`, `${epCount(show)} épisodes`, ok && meta?.genre, ok && meta?.rating ? `★ ${meta.rating}` : null]
                .filter(Boolean).join(' · ')}
            </p>
            <div className="show-head-actions">
              <button className="btn-ghost detail-info-btn" onClick={() => setShowInfo(true)}>
                Voir les infos
              </button>
            </div>
            <div className="detail-toolbar detail-toolbar-bottom">
              {resumeTarget && (
                <button
                  className="btn-primary detail-hero-btn"
                  onClick={() => {
                    const target = resumeTarget
                    const groupIndex = Math.max(0, episodeQueueGroups.findIndex((group) => group.id === `season-${target.seasonEntry.season}`))
                    const queue = episodeQueueGroups[groupIndex]?.items ?? []
                    const episodeTitle = episodeNamesBySeason[target.seasonEntry.season]?.[target.episode.episode]
                      || target.episode.title
                      || `Épisode ${target.episode.episode}`
                    onPlayEpisode(
                      target.seasonEntry.episodes,
                      target.index,
                      show.title,
                      target.seasonEntry.season,
                      true,
                      show,
                      episodeTitle,
                      title,
                      queue,
                      target.index,
                      episodeQueueGroups,
                      groupIndex
                    )
                  }}
                >
                  ▶ Reprendre {resumeTarget.seasonEntry.season === 0 ? 'Spéciaux' : `S${resumeTarget.seasonEntry.season}`}E{resumeTarget.episode.episode} · {fmtResumeTime(resumeTarget.pos)}
                </button>
              )}
              {canEditMeta && (
                <>
                  <button className="btn-ghost show-corr detail-hero-btn" onClick={() => onCorrect(meta)}>
                    {meta?.needsReview ? '⚠︎ Corriger l’association' : 'Corriger l’association'}
                  </button>
                  <button className="btn-ghost show-corr detail-hero-btn" onClick={() => onChangePoster(meta)}>
                    Changer l’affiche
                  </button>
                  {isAnime && show.seasons.length > 1 && (
                    <button className="btn-ghost show-corr detail-hero-btn" onClick={() => setEditSeasons((v) => !v)}>
                      {editSeasons ? 'Fermer l’édition' : 'Renommer les saisons'}
                    </button>
                  )}
                </>
              )}
              {onToggleLock && (
                <button
                  className={`detail-lock-toggle ${isLocked ? 'on' : 'off'}`}
                  onClick={onToggleLock}
                  title={isLocked ? 'Métadonnées verrouillées — cliquer pour déverrouiller' : 'Verrouiller les métadonnées'}
                >
                  {isLocked ? '🔒' : '🔓'}
                </button>
              )}
            </div>
          </div>
        </div>

        {isAnime && editSeasons ? (
          <div className="season-editor">
            <div className="season-editor-intro">
              <h3>Organisation des saisons</h3>
              <p>Noms, ordre et correspondance du catalogue pour les titres et vignettes. Les fichiers et affiches restent inchangés.</p>
            </div>
            <div className="season-editor-list">
              {orderedSeasons.map((s, idx) => (
                <section key={s.season} className="season-edit-card">
                  <div className="season-edit-head">
                    <span className="season-edit-num">{seasonLabel(s.season)}</span>
                    <div className="season-move-actions" aria-label={`Réordonner ${seasonLabel(s.season)}`}>
                      <button className="season-move" onClick={() => moveSeason(idx, -1)} disabled={idx === 0} title="Monter cette saison" aria-label="Monter cette saison">↑</button>
                      <button className="season-move" onClick={() => moveSeason(idx, 1)} disabled={idx === orderedSeasons.length - 1} title="Descendre cette saison" aria-label="Descendre cette saison">↓</button>
                    </div>
                  </div>
                  <label className="season-edit-field">
                    <span>Nom affiché</span>
                    <input
                      className="season-edit-input"
                      value={prefs.labels[s.season] || ''}
                      placeholder="Ex. Greed Island"
                      onChange={(e) => setLabel(s.season, e.target.value)}
                    />
                  </label>
                  <div className="season-catalogue">
                    <span className="season-catalogue-title">Correspondance catalogue</span>
                    <div className="season-edit-tmdb-row">
                      <label className="season-edit-field season-edit-number-field">
                        <span>Saison TMDB</span>
                        <input
                          className="season-edit-tmdb-num"
                          type="number"
                          min={1}
                          value={prefs.tmdbSeasonMap?.[String(s.season)] ?? ''}
                          placeholder={String(s.season)}
                          onChange={(e) => setTmdbSeason(s.season, e.target.value)}
                        />
                      </label>
                      <label className="season-edit-field season-edit-number-field">
                        <span>Commence à l’épisode</span>
                        <input
                          className="season-edit-tmdb-num"
                          type="number"
                          min={1}
                          value={prefs.tmdbEpStart?.[String(s.season)] ?? ''}
                          placeholder="1"
                          onChange={(e) => setTmdbEpStart(s.season, e.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                </section>
              ))}
            </div>
            <div className="season-editor-actions">
              <button className="btn-primary season-done" onClick={() => setEditSeasons(false)}>
                Terminé
              </button>
            </div>
          </div>
        ) : multiSeason && !drilled ? (
          <div className="grid grid-poster season-grid detail-media-section">
            {orderedSeasons.map((s) => (
              <button
                key={s.season}
                className="card"
                onClick={() => {
                  setSeason(s.season)
                  setDrilled(true)
                }}
                title={labelFor(s.season)}
              >
                <div className="card-thumb">
                  <Poster
                    src={seasonPosterMap[s.season] || (ok ? meta?.poster : undefined)}
                    fallback={labelFor(s.season)}
                  />
                  <span className="card-play">▶</span>
                  <span
                    className="card-poster"
                    role="button"
                    title="Changer l'affiche de la saison"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditPoster(s.season)
                    }}
                  >
                    {posterIcon}
                  </span>
                </div>
                <div className="card-title">
                  {labelFor(s.season)}
                  <span className="t7-tile-sub"> · {s.episodes.length} ép.</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          !editSeasons && (
            <>
              {multiSeason && (
                <button className="btn-ghost season-back" onClick={() => setDrilled(false)}>
                  ← Saisons
                </button>
              )}
              {multiSeason && <h3 className="season-head">{labelFor(current?.season ?? season)}</h3>}
              <div className="t7-episode-grid detail-media-section">
                {episodeTiles.map(({ ep, idx, progress, episodeTitle, thumb }) => (
                  <button
                    key={ep.id}
                    className="t7-episode-tile"
                    onClick={() => onPlayEpisode(current.episodes, idx, show.title, current.season, false, show, episodeTitle, title, episodeQueue, idx, episodeQueueGroups, episodeQueueGroupIndex)}
                  >
                    <div className="t7-episode-thumb-wrap">
                      {thumb ? (
                        <img className="t7-episode-thumb" src={thumb} alt="" loading="eager" fetchPriority="high" />
                      ) : (
                        <div className="t7-episode-thumb t7-episode-thumb--fallback">Episode {ep.episode}</div>
                      )}
                      {progress.pct > 0 && (
                        <div className="t7-episode-thumb-progress">
                          <span style={{ width: `${Math.round(progress.pct * 100)}%` }} />
                        </div>
                      )}
                      </div>
                    <div className="t7-episode-text">
                      <div className="t7-episode-title">{episodeTitle}</div>
                      <div className="t7-episode-meta">Épisode {ep.episode}</div>
                    </div>
                    </button>
                ))}
              </div>
            </>
          )
        )}

        {showInfo && (
          <DetailInfoModal
            title={title}
            subtitle={isAnime ? 'Anime' : 'Série'}
            plot={ok ? meta?.plot : undefined}
            details={[
              { label: 'Titre original', value: ok ? meta?.originalTitle : null },
              { label: 'Genre', value: ok ? meta?.genre : null },
              { label: 'Année', value: ok ? meta?.year : null },
              { label: 'Note', value: ok ? meta?.rating : null },
              { label: 'Saisons', value: show.seasons.length },
              { label: 'Épisodes', value: epCount(show) }
            ]}
            onClose={() => setShowInfo(false)}
          />
        )}
        {editPoster != null && (
          <MetaPosterModal
            req={showReq(kind, show)}
            current={meta}
            posterKey={`${mk}#s${editPoster}`}
            season={editPoster}
            currentPosterUrl={seasonPosterMap[editPoster]}
            title={`${title} — ${labelFor(editPoster)}`}
            onClose={() => setEditPoster(null)}
            onApplied={() => setPosterRefresh((n) => n + 1)}
          />
        )}
        </div>
      </div>
    </div>
  )
}

function CollectionPosterModal({
  coll,
  currentPoster,
  currentBackdrop,
  onClose,
  onPosterApplied,
  onBackdropApplied
}: {
  coll: DisplayColl
  currentPoster?: string
  currentBackdrop?: string
  onClose: () => void
  onPosterApplied: (id: string, url: string) => void
  onBackdropApplied: (key: string, url: string) => void
}): JSX.Element {
  const [tab, setTab] = useState<'poster' | 'backdrop'>('poster')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [tmdbPosters, setTmdbPosters] = useState<string[]>([])
  const [tmdbBackdrops, setTmdbBackdrops] = useState<string[]>([])
  const [loadingPosters, setLoadingPosters] = useState(false)
  const alive = useRef(true)

  const tmdbId = coll.id.startsWith('tmdb:') ? Number(coll.id.slice(5)) : null

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  useEffect(() => {
    alive.current = true
    setLoadingPosters(true)
    Promise.all([
      tmdbId ? getCollectionPosters(tmdbId) : Promise.resolve([]),
      tmdbId ? getCollectionBackdrops(tmdbId) : Promise.resolve([])
    ])
      .then(([posters, backdrops]) => {
        if (!alive.current) return
        setTmdbPosters(posters)
        setTmdbBackdrops(backdrops)
      })
      .finally(() => { if (alive.current) setLoadingPosters(false) })
    return () => { alive.current = false }
  }, [tmdbId, coll.movies])

  async function apply(value: string): Promise<void> {
    setBusy(true)
    const key = tab === 'poster' ? `coll:${coll.id}` : `backdrop:coll:${coll.id}`
    await rawSetPoster(key, value)
    setBusy(false)
    if (tab === 'poster') onPosterApplied(coll.id, value.trim())
    else onBackdropApplied(key, value.trim())
    onClose()
  }

  const choices = tab === 'poster' ? tmdbPosters : tmdbBackdrops
  const current = tab === 'poster' ? currentPoster : currentBackdrop
  const manualUrl = current && !choices.includes(current) ? current : ''
  const pastedUrl = url.trim()
  const customChoices = pastedUrl && !choices.includes(pastedUrl) ? [pastedUrl] : []
  const visibleChoices = [...customChoices, ...choices]

  useEffect(() => {
    setUrl(manualUrl)
  }, [manualUrl])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal poster-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2 className="settings-title">Personnaliser les images</h2>
        <p className="settings-sub">{coll.name}</p>

        <div className="artwork-tabs">
          <button className={tab === 'poster' ? 'on' : ''} onClick={() => { setTab('poster'); setUrl('') }}>Affiche</button>
          <button className={tab === 'backdrop' ? 'on' : ''} onClick={() => { setTab('backdrop'); setUrl('') }}>Fond</button>
        </div>

        <div className={tab === 'poster' ? 'poster-grid' : 'backdrop-grid'}>
          {loadingPosters ? (
            <div className="grid-state"><div className="spinner" /></div>
          ) : visibleChoices.length === 0 ? (
            <div className="grid-state muted">Aucune image TMDB trouvée — colle une URL ci-dessous.</div>
          ) : (
            visibleChoices.map((u) => (
              <button
                key={u}
                className={`${tab === 'poster' ? 'poster-opt' : 'backdrop-opt'} ${current === u ? 'on' : ''}`}
                onClick={() => apply(u)}
                disabled={busy}
              >
                <img src={u} alt="" loading="lazy" onError={(e) => { e.currentTarget.parentElement?.classList.add('broken') }} />
              </button>
            ))
          )}
        </div>

        <div className="poster-url-row">
          <input
            className="search poster-url"
            type="url"
            placeholder={`…ou coller l’URL ${tab === 'poster' ? 'd’une affiche' : 'd’un fond'}`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn-ghost" onClick={() => apply(pastedUrl)} disabled={busy || !pastedUrl}>
            Appliquer
          </button>
        </div>
        <div className="correct-actions">
          <button className="btn-ghost" onClick={() => apply('')} disabled={busy}>
            Revenir à l’image automatique TMDB
          </button>
        </div>
      </div>
    </div>
  )
}

export default function T7Browser({ onPlayMovie, onPlayEpisode, onBackToLogin, exporterRef }: Props): JSX.Element {
  const { config, designate, clearFolder } = useT7()
  const [active, setActive] = useState<T7Kind>('movies')
  const [showContinue, setShowContinue] = useState(false)
  const [progressVersion, setProgressVersion] = useState(0)
  const [allResults, setAllResults] = useState<Partial<Record<T7Kind, ScanResult>>>({})
  const [result, setResult] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedShow, setSelectedShow] = useState<LocalShow | null>(null)
  const [correcting, setCorrecting] = useState<{ req: MetaRequest; current: Meta | null } | null>(null)
  const [posterEditing, setPosterEditing] = useState<{
    req: MetaRequest
    current: Meta | null
    title?: string
  } | null>(null)

  // Locked metadata keys — loaded once, updated as the user toggles locks.
  const [lockedKeys, setLockedKeys] = useState<Set<string>>(new Set())

  // Collections / sagas (films only), persisted in userData.
  const [collections, setCollections] = useState<Collection[]>([])
  const [openColl, setOpenColl] = useState<DisplayColl | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [sagaName, setSagaName] = useState('')
  const [autoFolder, setAutoFolder] = useState(
    () => localStorage.getItem('t7_autofolder') !== '0'
  )
  const [barOpen, setBarOpen] = useState(false)
  // Plex-style custom sort names (metaKey → name), used to order the grids.
  const [sortNames, setSortNames] = useState<Record<string, string>>({})
  // Custom poster overrides for sagas/collections (key = `coll:<id>`).
  const [collPosters, setCollPosters] = useState<Record<string, string>>({})
  const [editCollPoster, setEditCollPoster] = useState<DisplayColl | null>(null)
  // Backdrop overrides (key = `backdrop:<metaKey>`).
  const [backdropOverrides, setBackdropOverrides] = useState<Record<string, string>>({})

  // Movie detail modal
  const [selectedMovie, setSelectedMovie] = useState<LocalMovie | null>(null)
  const [movieParentColl, setMovieParentColl] = useState<DisplayColl | null>(null)

  // Custom filters (Option B)
  const [filters, setFilters] = useState<T7Filter[]>([])
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null)
  const effectiveAutoFolder = autoFolder && activeFilterId === null
  const [filterCreateMode, setFilterCreateMode] = useState(false)
  const [filterEditId, setFilterEditId] = useState<string | null>(null)
  const [filterName, setFilterName] = useState('')
  const [filterSelectedKeys, setFilterSelectedKeys] = useState<string[]>([])
  const [showUnassociated, setShowUnassociated] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [genreFilter, setGenreFilter] = useState<string[]>([])
  const [ratingFilter, setRatingFilter] = useState<number | null>(null)
  const [decadeFilter, setDecadeFilter] = useState<number | null>(null)
  const folder = config[active]
  const activeLabel = CATS.find((c) => c.id === active)!.label
  const isMovies = active === 'movies'

  // A watched item becomes visible in "En cours" immediately when the player
  // persists its position; no manual refresh of T7Flix is needed.
  useEffect(() => onProgressChange(() => setProgressVersion((value) => value + 1)), [])

  useEffect(() => {
    getCollections().then(setCollections).catch(() => undefined)
    getSortNames().then(setSortNames).catch(() => undefined)
    getCollPosters().then(setCollPosters).catch(() => undefined)
    getLockedKeys().then((keys) => setLockedKeys(new Set(keys))).catch(() => undefined)
    getFilters().then(setFilters).catch(() => undefined)
    getBackdropOverrides().then(setBackdropOverrides).catch(() => undefined)
  }, [])

  // Scan all configured categories at mount (and on folder change) so the
  // "En cours" view can cross-reference progress against all local content.
  useEffect(() => {
    const kinds: T7Kind[] = ['movies', 'series', 'anime']
    for (const kind of kinds) {
      if (!config[kind]) continue
      scanT7(kind)
        .then((r) => setAllResults((prev) => ({ ...prev, [kind]: r })))
        .catch(() => undefined)
    }
  }, [config.movies, config.series, config.anime])

  // Keep allResults in sync when the active category is rescanned.
  useEffect(() => {
    if (result) setAllResults((prev) => ({ ...prev, [active]: result }))
  }, [result, active])

  // Reset advanced filters when section changes.
  useEffect(() => {
    setGenreFilter([])
    setRatingFilter(null)
    setDecadeFilter(null)
    setShowFilters(false)
    setActiveFilterId(null)
  }, [active])

  function saveSortName(key: string, name: string): void {
    setSortNames((prev) => {
      const next = { ...prev }
      if (name.trim()) next[key] = name.trim()
      else delete next[key]
      return next
    })
    void setSortName(key, name)
  }

  function toggleLock(key: string): void {
    const wasLocked = lockedKeys.has(key)
    setLockedKeys((prev) => {
      const next = new Set(prev)
      if (wasLocked) next.delete(key)
      else next.add(key)
      return next
    })
    if (wasLocked) void unlockMeta(key)
    else void lockMeta(key)
  }

  function lockAllSection(): void {
    const allKeys = isMovies
      ? (result?.movies ?? []).map((m) => metaKey('movies', m.title, m.year))
      : (result?.shows ?? []).map((s) => metaKey(active, s.title))
    const unique = [...new Set(allKeys)]
    const allLocked = unique.length > 0 && unique.every((k) => lockedKeys.has(k))
    setLockedKeys((prev) => {
      const next = new Set(prev)
      if (allLocked) for (const k of unique) next.delete(k)
      else for (const k of unique) next.add(k)
      return next
    })
    if (allLocked) for (const k of unique) void unlockMeta(k)
    else for (const k of unique) void lockMeta(k)
  }

  // Scan the active category whenever it changes or its folder is (re)set.
  useEffect(() => {
    setSearch('')
    setSelectedShow(null)
    setSelectedMovie(null)
    setMovieParentColl(null)
    setResult(null)
    setError(null)
    setSelectMode(false)
    setSelectedKeys([])
    setOpenColl(null)
    setActiveFilterId(null)
    setShowUnassociated(false)
    setFilterCreateMode(false)
    setFilterEditId(null)
    setFilterName('')
    setFilterSelectedKeys([])
    if (!folder) return
    let alive = true
    setLoading(true)
    scanT7(active)
      .then((r) => {
        if (alive) setResult(r)
      })
      .catch(() => alive && setError('Analyse impossible.'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [active, folder])

  async function rescan(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setResult(await scanT7(active, true))
    } catch {
      setError('Analyse impossible.')
    } finally {
      setLoading(false)
    }
  }

  const movies = useMemo(() => {
    const list = result?.movies ?? []
    const q = norm(search.trim())
    return q ? list.filter((m) => norm(m.title).includes(q)) : list
  }, [result, search])

  const shows = useMemo(() => {
    const list = result?.shows ?? []
    const q = norm(search.trim())
    return q ? list.filter((s) => norm(s.title).includes(q)) : list
  }, [result, search])

  const moviesByKey = useMemo(() => {
    const map = new Map<string, LocalMovie>()
    for (const m of result?.movies ?? []) map.set(metaKey('movies', m.title, m.year), m)
    return map
  }, [result])

  // Resolve metadata for the whole active section so the grid can sort by the
  // displayed (French) title and the real TMDB year, not the scanned filename.
  const activeReqs = useMemo<MetaRequest[]>(
    () => (isMovies ? (result?.movies ?? []).map(movieReq) : (result?.shows ?? []).map((s) => showReq(active, s))),
    [isMovies, result, active]
  )
  const metaMap = useMetaMap(activeReqs)
  const [sectionMetaMaps, setSectionMetaMaps] = useState<Partial<Record<T7Kind, typeof metaMap>>>({})
  useEffect(() => {
    if (metaMap.size > 0) setSectionMetaMaps((prev) => ({ ...prev, [active]: metaMap }))
  }, [active, metaMap])

  const availableGenres = useMemo(() => {
    const s = new Set<string>()
    for (const meta of metaMap.values()) {
      if (meta?.status === 'ok' && meta.genre) {
        for (const g of meta.genre.split(',')) { const t = g.trim(); if (t) s.add(t) }
      }
    }
    return [...s].sort((a, b) => a.localeCompare(b, 'fr'))
  }, [metaMap])

  const availableDecades = useMemo(() => {
    const s = new Set<number>()
    for (const m of movies) {
      const y = metaMap.get(metaKey('movies', m.title, m.year))?.year ?? m.year
      if (y) s.add(Math.floor(y / 10) * 10)
    }
    for (const sh of shows) {
      const y = metaMap.get(metaKey(active, sh.title))?.year
      if (y) s.add(Math.floor(y / 10) * 10)
    }
    return [...s].sort((a, b) => b - a)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movies, shows, metaMap, active])

  /** Sort key for a title: custom sort name → displayed title → scanned name. */
  const sortTitle = (kind: T7Kind, title: string, year?: number): string => {
    const k = metaKey(kind, title, year)
    const m = metaMap.get(k)
    return norm(sortNames[k] || (m?.status === 'ok' && m.title ? m.title : '') || title)
  }
  /** Release year for ordering saga members — TMDB year, else filename year. */
  const movieYear = (m: LocalMovie): number => {
    const meta = metaMap.get(metaKey('movies', m.title, m.year))
    return (meta?.status === 'ok' ? meta.year : undefined) ?? m.year ?? 9999
  }
  const byMetaYear = (a: LocalMovie, b: LocalMovie): number =>
    movieYear(a) - movieYear(b) || sortTitle('movies', a.title, a.year).localeCompare(sortTitle('movies', b.title, b.year), 'fr')

  const rootName = (config.movies || '').split('/').filter(Boolean).pop() || ''

  // Manual sagas first, then auto sub-folder groups (≥2 films in a sub-folder,
  // excluding films sitting directly in the root and those already in a saga).
  const displayColls = useMemo<DisplayColl[]>(() => {
    if (!isMovies) return []
    const used = new Set<string>()
    const out: DisplayColl[] = []
    for (const c of collections) {
      const ms = c.keys
        .map((k) => moviesByKey.get(k))
        .filter((m): m is LocalMovie => !!m)
        .sort(byMetaYear)
      if (ms.length === 0) continue
      ms.forEach((m) => used.add(metaKey('movies', m.title, m.year)))
      out.push({ id: c.id, name: c.name, keys: c.keys, movies: ms, poster: c.poster, manual: true })
    }
    if (effectiveAutoFolder) {
    // TMDB auto-collections: group films that share a collectionId in their metadata.
    const byTmdbColl = new Map<number, { name: string; movies: LocalMovie[] }>()
    for (const m of result?.movies ?? []) {
      const mk = metaKey('movies', m.title, m.year)
      if (used.has(mk)) continue
      const meta = metaMap.get(mk)
      if (!meta?.collectionId || !meta?.collectionName) continue
      const entry = byTmdbColl.get(meta.collectionId)
      if (entry) entry.movies.push(m)
      else byTmdbColl.set(meta.collectionId, { name: meta.collectionName, movies: [m] })
    }
    for (const [id, { name, movies }] of byTmdbColl) {
      if (movies.length < 2) continue
      const sorted = movies.slice().sort(byMetaYear)
      sorted.forEach((m) => used.add(metaKey('movies', m.title, m.year)))
      out.push({
        id: `tmdb:${id}`,
        name,
        keys: sorted.map((m) => metaKey('movies', m.title, m.year)),
        movies: sorted,
        manual: false
      })
    }

      const byFolder = new Map<string, LocalMovie[]>()
      for (const m of result?.movies ?? []) {
        const k = metaKey('movies', m.title, m.year)
        if (used.has(k) || !m.folder || m.folder === rootName) continue
        const arr = byFolder.get(m.folder)
        if (arr) arr.push(m)
        else byFolder.set(m.folder, [m])
      }
      for (const [name, ms] of byFolder) {
        if (ms.length < 2) continue
        const sorted = ms.slice().sort(byMetaYear)
        out.push({
          id: `auto:${name}`,
          name,
          keys: sorted.map((m) => metaKey('movies', m.title, m.year)),
          movies: sorted,
          manual: false
        })
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMovies, collections, effectiveAutoFolder, moviesByKey, result, rootName, metaMap, sortNames])

  function movieQueueFor(coll: DisplayColl): MediaQueueItem[] {
    return coll.movies.map((movie) => {
      const movieMeta = sectionMetaMaps.movies?.get(metaKey('movies', movie.title, movie.year))
      return {
        id: movie.id,
        title: movieMeta?.title || movie.title,
        src: movie.filePath,
        resumeKey: `t7-${movie.id}`,
        local: true,
        requiresT7: true,
        localSubs: movie.subs
      }
    })
  }

  // Active filter for the current section.
  const activeFilter = useMemo(
    () => filters.find((f) => f.id === activeFilterId && f.kind === active) ?? null,
    [filters, activeFilterId, active]
  )
  const filtersForSection = useMemo(
    () => filters.filter((f) => f.kind === active),
    [filters, active]
  )

  const filteredMovies = useMemo(() => {
    let list: LocalMovie[]
    if (showUnassociated) {
      list = movies.filter((m) => {
        const meta = metaMap.get(metaKey('movies', m.title, m.year))
        return meta != null && meta.status !== 'ok'
      })
    } else if (activeFilter) {
      list = movies.filter((m) => activeFilter.keys.includes(metaKey('movies', m.title, m.year)))
    } else {
      list = movies
    }
    if (genreFilter.length > 0 || ratingFilter !== null || decadeFilter !== null) {
      list = list.filter((m) => {
        const mk = metaKey('movies', m.title, m.year)
        const meta = metaMap.get(mk)
        const ok = meta?.status === 'ok'
        if (genreFilter.length > 0) {
          const gs = ok && meta?.genre ? meta.genre.split(',').map((g) => g.trim()) : []
          if (!genreFilter.some((g) => gs.includes(g))) return false
        }
        if (ratingFilter !== null) {
          const r = ok && meta?.rating ? parseFloat(meta.rating) : 0
          if (!(r >= ratingFilter)) return false
        }
        if (decadeFilter !== null) {
          const y = (ok && meta?.year) || m.year
          if (!y || Math.floor(y / 10) * 10 !== decadeFilter) return false
        }
        return true
      })
    }
    return list
  }, [movies, activeFilter, showUnassociated, metaMap, genreFilter, ratingFilter, decadeFilter])

  const filteredShows = useMemo(() => {
    let list: LocalShow[]
    if (showUnassociated) {
      list = shows.filter((s) => {
        const meta = metaMap.get(metaKey(active, s.title))
        return meta != null && meta.status !== 'ok'
      })
    } else if (activeFilter) {
      list = shows.filter((s) => activeFilter.keys.includes(metaKey(active, s.title)))
    } else {
      list = shows
    }
    if (genreFilter.length > 0 || ratingFilter !== null || decadeFilter !== null) {
      list = list.filter((s) => {
        const mk = metaKey(active, s.title)
        const meta = metaMap.get(mk)
        const ok = meta?.status === 'ok'
        if (genreFilter.length > 0) {
          const gs = ok && meta?.genre ? meta.genre.split(',').map((g) => g.trim()) : []
          if (!genreFilter.some((g) => gs.includes(g))) return false
        }
        if (ratingFilter !== null) {
          const r = ok && meta?.rating ? parseFloat(meta.rating) : 0
          if (!(r >= ratingFilter)) return false
        }
        if (decadeFilter !== null) {
          const y = ok && meta?.year ? meta.year : undefined
          if (!y || Math.floor(y / 10) * 10 !== decadeFilter) return false
        }
        return true
      })
    }
    return list
  }, [shows, activeFilter, active, showUnassociated, metaMap, genreFilter, ratingFilter, decadeFilter])

  const groupedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const c of displayColls) for (const m of c.movies) s.add(metaKey('movies', m.title, m.year))
    return s
  }, [displayColls])

  const standalone = useMemo(
    () => filteredMovies.filter((m) => !groupedKeys.has(metaKey('movies', m.title, m.year))),
    [filteredMovies, groupedKeys]
  )

  // Films grid: when any filter is active show all films individually;
  // otherwise mix sagas + standalone sorted A→Z.
  const mergedItems = useMemo<MovieGridItem[]>(() => {
    const anyFilter = !!activeFilter || showUnassociated || genreFilter.length > 0 || ratingFilter !== null || decadeFilter !== null
    const keyOf = (it: MovieGridItem): string =>
      it.type === 'coll' ? norm(it.coll.name) : sortTitle('movies', it.movie.title, it.movie.year)
    if (anyFilter) {
      return filteredMovies
        .map((m) => ({ type: 'movie' as const, key: m.id, name: m.title, movie: m }))
        .sort((a, b) => keyOf(a).localeCompare(keyOf(b), 'fr'))
    }
    const items: MovieGridItem[] = [
      ...displayColls.map((c) => ({ type: 'coll' as const, key: `c:${c.id}`, name: c.name, coll: c })),
      ...standalone.map((m) => ({ type: 'movie' as const, key: m.id, name: m.title, movie: m }))
    ]
    return items.sort((a, b) => keyOf(a).localeCompare(keyOf(b), 'fr'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayColls, standalone, filteredMovies, sortNames, activeFilter, showUnassociated, genreFilter, ratingFilter, decadeFilter])

  function toggleSelect(key: string): void {
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  function startSaga(): void {
    setSelectMode(true)
    setSelectedKeys([])
    setSagaName('')
    setSearch('')
  }
  function cancelSaga(): void {
    setSelectMode(false)
    setSelectedKeys([])
    setSagaName('')
  }
  async function createSaga(): Promise<void> {
    const name = sagaName.trim()
    if (!name || selectedKeys.length < 2) return
    const next = [...collections, { id: rand(), name, keys: selectedKeys.slice() }]
    setCollections(next)
    await saveCollections(next)
    cancelSaga()
  }
  async function deleteColl(id: string): Promise<void> {
    const next = collections.filter((c) => c.id !== id)
    setCollections(next)
    await saveCollections(next)
    setOpenColl(null)
  }
  async function renameColl(id: string, name: string): Promise<void> {
    const next = collections.map((c) => (c.id === id ? { ...c, name } : c))
    setCollections(next)
    await saveCollections(next)
    setOpenColl((o) => (o && o.id === id ? { ...o, name } : o))
  }
  async function saveFilter(): Promise<void> {
    const name = filterName.trim()
    if (!name || filterSelectedKeys.length === 0) return
    const next: T7Filter[] = filterEditId
      ? filters.map((f) => f.id === filterEditId ? { ...f, name, keys: filterSelectedKeys.slice() } : f)
      : [...filters, { id: rand(), name, kind: active, keys: filterSelectedKeys.slice() }]
    setFilters(next)
    await saveFilters(next)
    setFilterCreateMode(false)
    setFilterEditId(null)
    setFilterName('')
    setFilterSelectedKeys([])
  }
  async function deleteFilter(id: string): Promise<void> {
    const next = filters.filter((f) => f.id !== id)
    setFilters(next)
    await saveFilters(next)
    if (activeFilterId === id) setActiveFilterId(null)
  }
  function toggleFilterKey(key: string): void {
    setFilterSelectedKeys((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])
  }
  function startEditFilter(f: T7Filter): void {
    setFilterCreateMode(true)
    setFilterEditId(f.id)
    setFilterName(f.name)
    setFilterSelectedKeys(f.keys.slice())
  }
  function cancelFilterCreate(): void {
    setFilterCreateMode(false)
    setFilterEditId(null)
    setFilterName('')
    setFilterSelectedKeys([])
  }

  function toggleAutoFolder(): void {
    setAutoFolder((v) => {
      localStorage.setItem('t7_autofolder', v ? '0' : '1')
      return !v
    })
  }

  const sortedShows = useMemo(
    () => [...filteredShows].sort((a, b) => sortTitle(active, a.title).localeCompare(sortTitle(active, b.title), 'fr')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredShows, active, metaMap, sortNames]
  )
  const shownShows = sortedShows.slice(0, RENDER_CAP)
  const shownShowSig = shownShows.slice(0, 16).map((show) => show.id).join('|')
  useEffect(() => {
    if (isMovies) return
    // Warm season artwork while the grid is visible so opening a show does not
    // briefly display the generic show poster before the correct season art.
    for (const show of shownShows.slice(0, 16)) {
      void fetchSeasonPosters(showReq(active, show))
    }
  }, [active, isMovies, shownShowSig])
  const total = isMovies ? movies.length : shows.length

  const unassociatedCount = useMemo(() => {
    const items = isMovies ? result?.movies ?? [] : result?.shows ?? []
    return items.filter((item) => {
      const mk = isMovies
        ? metaKey('movies', (item as LocalMovie).title, (item as LocalMovie).year)
        : metaKey(active, (item as LocalShow).title)
      const meta = metaMap.get(mk)
      return meta != null && meta.status !== 'ok'
    }).length
  }, [isMovies, result, active, metaMap])

  const allSectionLocked = useMemo(() => {
    const items = isMovies ? result?.movies ?? [] : result?.shows ?? []
    if (items.length === 0) return false
    return items.every((m) => {
      const k = isMovies
        ? metaKey('movies', (m as LocalMovie).title, (m as LocalMovie).year)
        : metaKey(active, (m as LocalShow).title)
      return lockedKeys.has(k)
    })
  }, [isMovies, result, active, lockedKeys])

  const continueItems = useMemo<ContinueItem[]>(() => {
    const MIN_POS = 180
    const MAX_PCT = 0.9
    const progress = getAllProgress()
    const items: ContinueItem[] = []

    for (const m of allResults.movies?.movies ?? []) {
      const e = progress[`t7-${m.id}`]
      if (!e || e.completed || e.pos <= MIN_POS || e.dur <= 0 || e.pos >= e.dur * MAX_PCT || isHiddenFromContinue(`t7-${m.id}`)) continue
      items.push({ type: 'movie', movie: m, hideKeys: [`t7-${m.id}`], pos: e.pos, dur: e.dur, ts: e.ts, pct: e.pos / e.dur })
    }

    const showMap = new Map<string, ContinueItem>()
    for (const kind of ['series', 'anime'] as T7Kind[]) {
      for (const show of allResults[kind]?.shows ?? []) {
        const flattened = orderedShowSeasons(show).flatMap((season) =>
          season.episodes.map((ep, index) => ({
            season: season.season,
            episodes: season.episodes,
            index,
            episode: ep,
            key: `t7-${ep.id}`
          }))
        )
        const showKeys = flattened.map((entry) => entry.key)
        let latestIndex = -1
        let latestEntry: ReturnType<typeof getAllProgress>[string] | null = null
        for (let i = 0; i < flattened.length; i++) {
          const candidate = progress[flattened[i].key]
          if (!candidate || isHiddenFromContinue(flattened[i].key)) continue
          const touched = candidate.completed || candidate.pos > MIN_POS
          if (!touched) continue
          if (!latestEntry || candidate.ts > latestEntry.ts) {
            latestEntry = candidate
            latestIndex = i
          }
        }
        if (!latestEntry || latestIndex < 0) continue
        const completedLike =
          !!latestEntry.completed ||
          (latestEntry.dur > 0 && latestEntry.pos >= latestEntry.dur * MAX_PCT)
        let target = flattened[latestIndex]
        let pct = latestEntry.dur > 0 ? latestEntry.pos / latestEntry.dur : 0
        if (completedLike) {
          const next = flattened.slice(latestIndex + 1).find((entry) => {
            const e = progress[entry.key]
            return !e || !e.completed
          })
          if (!next) continue
          target = next
          pct = 0
        }
        showMap.set(show.title, {
          type: 'episode',
          show,
          showKind: kind,
          episode: target.episode,
          season: target.season,
          hideKeys: showKeys,
          pos: latestEntry.pos,
          dur: latestEntry.dur,
          ts: latestEntry.ts,
          pct
        })
      }
    }
    for (const item of showMap.values()) items.push(item)

    return items.sort((a, b) => b.ts - a.ts)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allResults, progressVersion])

  const [continueEpisodeNames, setContinueEpisodeNames] = useState<Record<string, Record<number, string>>>({})
  useEffect(() => {
    const targets = [...new Map(
      continueItems
        .filter((item) => item.type === 'episode' && item.show && item.showKind)
        .map((item) => [`${item.showKind}:${item.show!.id}`, { show: item.show!, kind: item.showKind! }])
    ).values()]
    if (targets.length === 0) return
    let alive = true
    Promise.all(targets.flatMap(({ show, kind }) => show.seasons.map(async (seasonEntry) => {
      const season = seasonEntry.season
      const offset = show.seasons
        .filter((entry) => season !== 0 && entry.season > 0 && entry.season < season)
        .reduce((sum, entry) => sum + entry.episodes.length, 0)
      const firstEpNum = seasonEntry.episodes[0]?.episode
      const globalNumbering = season !== 0 && firstEpNum != null && firstEpNum > 1
      const names = await getEpisodeNames(showReq(kind, show), season, offset, globalNumbering).catch(() => ({} as Record<number, string>))
      return [episodeNamesKey(kind, show, season), names] as const
    }))).then((entries) => {
      if (!alive) return
      setContinueEpisodeNames((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          if (!entry) continue
          next[entry[0]] = entry[1]
        }
        return next
      })
    }).catch(() => undefined)
    return () => { alive = false }
  }, [continueItems])

  const advFiltersActive = activeFilterId !== null || genreFilter.length > 0 || ratingFilter !== null || decadeFilter !== null

  function exportLibrary(): void {
    const cv = (s?: string | number | null | false): string =>
      s != null && s !== false && s !== '' ? `"${String(s).replace(/"/g, '""')}"` : ''
    const rows: string[] = ['Type,"Titre FR","Titre original",Année,Genre,Note,Saisons,Épisodes']

    const moviesMap = sectionMetaMaps.movies
    for (const m of allResults.movies?.movies ?? []) {
      const meta = moviesMap?.get(metaKey('movies', m.title, m.year))
      const ok = meta?.status === 'ok'
      rows.push(['Film', cv((ok && meta?.title) || m.title), cv(ok && meta?.originalTitle || m.title),
        cv((ok && meta?.year) || m.year), cv(ok && meta?.genre), cv(ok && meta?.rating), '', ''].join(','))
    }
    for (const [kind, label] of [['series', 'Série'], ['anime', 'Anime']] as const) {
      const showsMap = sectionMetaMaps[kind]
      for (const s of allResults[kind]?.shows ?? []) {
        const meta = showsMap?.get(metaKey(kind, s.title))
        const ok = meta?.status === 'ok'
        const epTotal = s.seasons.reduce((n, ss) => n + ss.episodes.length, 0)
        rows.push([label, cv((ok && meta?.title) || s.title), cv(ok && meta?.originalTitle || s.title),
          cv(ok && meta?.year), cv(ok && meta?.genre), cv(ok && meta?.rating),
          s.seasons.length, epTotal].join(','))
      }
    }

    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const now = new Date()
    const dd = String(now.getDate()).padStart(2, '0')
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const yyyy = now.getFullYear()
    a.download = `T7Flix-Global-${dd}-${mm}-${yyyy}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (exporterRef) exporterRef.current = exportLibrary

  const parentMovieQueue: MediaQueueItem[] | undefined = movieParentColl
    ? movieQueueFor(movieParentColl)
    : undefined
  const parentMovieIndex = parentMovieQueue?.findIndex((item) => item.id === selectedMovie?.id) ?? 0

  return (
    <main className="content">
      <header className="topbar">
        <h2>T7Flix</h2>
        <span className="t7-badge">SSD T7</span>
        {folder && (
          <>
            <input
              className="search"
              type="search"
              placeholder={`Rechercher dans ${activeLabel}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="cog" onClick={rescan} title="Réanalyser le dossier" disabled={loading}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>
            <button
              className={`cog ${advFiltersActive ? 'cog-active' : ''}`}
              onClick={() => setShowFilters((v) => !v)}
              title="Filtres avancés"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              {advFiltersActive && <span className="cog-badge" />}
            </button>
          </>
        )}
      </header>

      <div className="browser">
        <div className="cat-list">
          {continueItems.length > 0 && (
            <button
              className={`cat ${showContinue ? 'active' : ''}`}
              onClick={() => setShowContinue(true)}
              title="En cours"
            >
              <span className="cat-name">En cours</span>
              <span className="cat-count">{continueItems.length}</span>
            </button>
          )}
          {CATS.map((c) => (
            <button
              key={c.id}
              className={`cat ${!showContinue && active === c.id ? 'active' : ''}`}
              onClick={() => { setShowContinue(false); setActive(c.id) }}
              title={c.label}
            >
              <span className="cat-name">{c.label}</span>
              {config[c.id] && <span className="cat-count t7-dot" title="Dossier configuré">●</span>}
            </button>
          ))}
        </div>

        <div className="grid-wrap">
          {showContinue ? (
            <div className="grid grid-poster" style={{ paddingTop: 8 }}>
              {continueItems.map((item) => {
                if (item.type === 'movie') {
                  const m = item.movie!
                  return (
                    <ContinueTile
                      key={`cont-m-${m.id}`}
                      req={movieReq(m)}
                      fallbackTitle={m.title}
                      sub={m.year ? String(m.year) : undefined}
                      pct={item.pct}
                      onClick={(displayTitle) => {
                        const coll = displayColls.find((entry) => entry.movies.some((movie) => movie.id === m.id))
                        if (coll) {
                          const queue = movieQueueFor(coll)
                          const queueIndex = Math.max(0, queue.findIndex((entry) => entry.id === m.id))
                          onPlayMovie(m, true, displayTitle, queue, queueIndex)
                        } else {
                          onPlayMovie(m, true, displayTitle)
                        }
                      }}
                      onRemove={() => { hideFromContinue(item.hideKeys); setProgressVersion((v) => v + 1) }}
                    />
                  )
                }
                const show = item.show!
                const ep = item.episode!
                const sn = item.season!
                const kind = item.showKind!
                const seasonObj = show.seasons.find((s) => s.season === sn)
                const epIdx = seasonObj ? seasonObj.episodes.findIndex((e) => e.id === ep.id) : 0
                const sub = show.seasons.length === 1
                  ? `E${ep.episode}`
                  : `S${sn} · E${ep.episode}`
                return (
                  <ContinueTile
                    key={`cont-e-${ep.id}`}
                    req={showReq(kind, show)}
                    fallbackTitle={show.title}
                    sub={sub}
                    pct={item.pct}
                    onClick={(displayTitle) => {
                      if (!seasonObj) return
                      const episodeTitleFor = (seasonNum: number, episode: LocalEpisode): string =>
                        continueEpisodeNames[episodeNamesKey(kind, show, seasonNum)]?.[episode.episode]
                        || episode.title
                        || `Épisode ${episode.episode}`
                      const groups = buildShowQueueGroups(show, displayTitle, seasonLabel, episodeTitleFor)
                      const groupIndex = Math.max(0, groups.findIndex((group) => group.id === `season-${sn}`))
                      const queue = groups[groupIndex]?.items ?? []
                      const episodeTitle = episodeTitleFor(sn, ep)
                      onPlayEpisode(seasonObj.episodes, Math.max(0, epIdx), show.title, sn, true, show, episodeTitle, displayTitle, queue, Math.max(0, epIdx), groups, groupIndex)
                    }}
                      onRemove={() => { hideFromContinue(item.hideKeys); setProgressVersion((v) => v + 1) }}
                  />
                )
              })}
            </div>
          ) : !folder ? (
            <div className="grid-state">
              <div className="t7-empty-icon">📁</div>
              <p>Aucun dossier désigné pour «&nbsp;{activeLabel}&nbsp;».</p>
              <p className="muted">Choisis le dossier du T7 qui contient tes {activeLabel.toLowerCase()}.</p>
              <button className="btn-primary t7-pick" onClick={() => designate(active)}>
                Choisir le dossier {activeLabel}
              </button>
            </div>
          ) : (
            <>
              {barOpen ? (
                <div className="t7-bar">
                  <span className="t7-bar-path" title={folder}>📁 {folder}</span>
                  <span className="t7-bar-count muted">
                    {loading ? 'Analyse…' : `${total} ${isMovies ? 'film(s)' : 'titre(s)'}`}
                  </span>
                  {isMovies && !selectMode && (
                    <>
                      <button
                        className={`btn-ghost t7-bar-btn ${autoFolder ? 'on' : ''}`}
                        onClick={toggleAutoFolder}
                        title="Regrouper automatiquement les films d'un même sous-dossier en saga"
                      >
                        {autoFolder ? '✓ ' : ''}Sagas par dossier
                      </button>
                      <button className="btn-ghost t7-bar-btn" onClick={startSaga}>
                        Créer une saga
                      </button>
                    </>
                  )}
                  <button className="btn-ghost t7-bar-btn" onClick={() => designate(active)}>
                    Changer
                  </button>
                  {!selectMode && !loading && total > 0 && (
                    <button
                      className="btn-ghost t7-bar-btn"
                      onClick={lockAllSection}
                      title={allSectionLocked ? 'Déverrouiller toutes les métadonnées' : 'Verrouiller toutes les métadonnées'}
                    >
                      {allSectionLocked ? '🔓 Tout déverrouiller' : '🔒 Tout verrouiller'}
                    </button>
                  )}
                  <button
                    className="t7-bar-toggle"
                    onClick={() => setBarOpen(false)}
                    title="Replier le bandeau"
                  >
                    −
                  </button>
                </div>
              ) : (
                <div className="t7-bar-collapsed-row">
                  <button
                    className="t7-bar-toggle"
                    onClick={() => setBarOpen(true)}
                    title="Déplier les options"
                  >
                    +
                  </button>
                </div>
              )}

              {showFilters && !loading && !error && !selectMode && (
                <div className="adv-filter-panel">
                  <div className="adv-filter-group">
                    <div className="adv-filter-label-row">
                      <span className="adv-filter-label">Playlists</span>
                      <button
                        className="adv-filter-create"
                        onClick={() => {
                          setFilterCreateMode(true)
                          setFilterEditId(null)
                          setFilterName('')
                          setFilterSelectedKeys([])
                        }}
                      >
                        + Créer
                      </button>
                    </div>
                    {filtersForSection.length > 0 ? (
                      <div className="adv-filter-chips">
                        {filtersForSection.map((f) => (
                          <span key={f.id} className="adv-chip-wrap">
                            <button
                              className={`adv-chip ${activeFilterId === f.id ? 'on' : ''}`}
                              onClick={() => { setActiveFilterId(activeFilterId === f.id ? null : f.id); setShowUnassociated(false) }}
                            >{f.name}</button>
                            <button className="adv-chip-edit" title="Modifier" onClick={() => startEditFilter(f)}>✎</button>
                            <button className="adv-chip-del" title="Supprimer" onClick={() => deleteFilter(f.id)}>×</button>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {availableGenres.length > 0 && (
                    <div className="adv-filter-group">
                      <span className="adv-filter-label">Genre</span>
                      <div className="adv-filter-chips">
                        {availableGenres.map((g) => (
                          <button
                            key={g}
                            className={`adv-chip ${genreFilter.includes(g) ? 'on' : ''}`}
                            onClick={() => setGenreFilter((prev) => prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g])}
                          >{g}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="adv-filter-group">
                    <span className="adv-filter-label">Note</span>
                    <div className="adv-filter-chips">
                      {([7, 8, 9] as const).map((r) => (
                        <button key={r} className={`adv-chip ${ratingFilter === r ? 'on' : ''}`}
                          onClick={() => setRatingFilter(ratingFilter === r ? null : r)}>★ {r}+</button>
                      ))}
                    </div>
                  </div>
                  {availableDecades.length > 0 && (
                    <div className="adv-filter-group">
                      <span className="adv-filter-label">Décennie</span>
                      <div className="adv-filter-chips">
                        {availableDecades.map((d) => (
                          <button key={d} className={`adv-chip ${decadeFilter === d ? 'on' : ''}`}
                            onClick={() => setDecadeFilter(decadeFilter === d ? null : d)}>{d}s</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {unassociatedCount > 0 && (
                    <div className="adv-filter-group">
                      <span className="adv-filter-label">Métadonnées</span>
                      <div className="adv-filter-chips">
                        <button className={`adv-chip ${showUnassociated ? 'on' : ''}`}
                          onClick={() => { setShowUnassociated((v) => !v); setActiveFilterId(null) }}>
                          ⚠ Non-associés ({unassociatedCount})
                        </button>
                      </div>
                    </div>
                  )}
                  {advFiltersActive && (
                    <button className="adv-filter-reset" onClick={() => { setActiveFilterId(null); setGenreFilter([]); setRatingFilter(null); setDecadeFilter(null) }}>
                      Réinitialiser
                    </button>
                  )}
                </div>
              )}

              {/* Filter chips */}

              {loading ? (
                <div className="grid-state">
                  <div className="spinner" />
                  <span className="loading-label">Analyse du dossier…</span>
                </div>
              ) : error ? (
                <div className="grid-state muted">{error}</div>
              ) : total === 0 ? (
                <div className="grid-state muted">
                  {search ? 'Aucun résultat.' : 'Aucun fichier vidéo trouvé dans ce dossier.'}
                </div>
              ) : isMovies ? (
                (selectMode || filterCreateMode) ? (
                  // Saga builder / filter create: every film is selectable.
                  <div className="grid grid-poster">
                    {movies.slice(0, RENDER_CAP).map((m) => {
                      const k = metaKey('movies', m.title, m.year)
                      const isSelected = selectMode ? selectedKeys.includes(k) : filterSelectedKeys.includes(k)
                      const onToggle = selectMode ? () => toggleSelect(k) : () => toggleFilterKey(k)
                      return (
                        <MetaTile
                          key={m.id}
                          req={movieReq(m)}
                          fallbackTitle={m.title}
                          sub={m.year ? `(${m.year})` : undefined}
                          onPrefetch={() => { void movieCredits(movieReq(m)) }}
                          selectMode
                          selected={isSelected}
                          onClick={onToggle}
                        />
                      )
                    })}
                  </div>
                ) : search || showUnassociated ? (
                  <div className="grid grid-poster">
                    {filteredMovies.slice(0, RENDER_CAP).map((m) => {
                      const mk = metaKey('movies', m.title, m.year)
                      return (
                        <MetaTile
                          key={m.id}
                          req={movieReq(m)}
                          fallbackTitle={m.title}
                          titleOverride={sortNames[mk] || undefined}
                          sub={m.year ? `(${m.year})` : undefined}
                          onClick={() => { setMovieParentColl(null); setSelectedMovie(m) }}
                          onCorrect={(meta) => setCorrecting({ req: movieReq(m), current: meta })}
                          onChangePoster={(meta) =>
                            setPosterEditing({ req: movieReq(m), current: meta, title: m.title })
                          }
                          isLocked={lockedKeys.has(mk)}
                          onToggleLock={() => toggleLock(mk)}
                        />
                      )
                    })}
                  </div>
                ) : (
                  <>
                    <div className="grid grid-poster">
                      {mergedItems.slice(0, RENDER_CAP).map((it) =>
                        it.type === 'coll' ? (
                          <CollectionTile
                            key={it.key}
                            coll={it.coll}
                            posterOverride={collPosters[`coll:${it.coll.id}`]}
                            onClick={() => setOpenColl(it.coll)}
                            onChangePoster={() => setEditCollPoster(it.coll)}
                          />
                        ) : (
                          <MetaTile
                            key={it.key}
                            req={movieReq(it.movie)}
                            fallbackTitle={it.movie.title}
                            titleOverride={sortNames[metaKey('movies', it.movie.title, it.movie.year)] || undefined}
                            sub={it.movie.year ? `(${it.movie.year})` : undefined}
                            onPrefetch={() => { void movieCredits(movieReq(it.movie)) }}
                            onClick={() => { setMovieParentColl(null); setSelectedMovie(it.movie) }}
                            onCorrect={(meta) => setCorrecting({ req: movieReq(it.movie), current: meta })}
                            onChangePoster={(meta) =>
                              setPosterEditing({ req: movieReq(it.movie), current: meta, title: it.movie.title })
                            }
                            isLocked={lockedKeys.has(metaKey('movies', it.movie.title, it.movie.year))}
                            onToggleLock={() => toggleLock(metaKey('movies', it.movie.title, it.movie.year))}
                          />
                        )
                      )}
                    </div>
                    {mergedItems.length > RENDER_CAP && (
                      <div className="grid-more muted">
                        Affichage limité à {RENDER_CAP} sur {mergedItems.length}. Affine ta recherche.
                      </div>
                    )}
                  </>
                )
              ) : filterCreateMode ? (
                <div className="grid grid-poster">
                  {shownShows.slice(0, RENDER_CAP).map((s) => {
                    const k = metaKey(active, s.title)
                    return (
                      <MetaTile
                        key={s.id}
                        req={showReq(active, s)}
                        fallbackTitle={s.title}
                        titleOverride={sortNames[k] || undefined}
                        sub={`${epCount(s)} ép.`}
                        selectMode
                        selected={filterSelectedKeys.includes(k)}
                        onClick={() => toggleFilterKey(k)}
                      />
                    )
                  })}
                </div>
              ) : (
                <>
                  <div className="grid grid-poster">
                    {shownShows.map((s) => {
                      const mk = metaKey(active, s.title)
                      return (
                        <MetaTile
                          key={s.id}
                          req={showReq(active, s)}
                          fallbackTitle={s.title}
                          titleOverride={sortNames[mk] || undefined}
                          sub={`${epCount(s)} ép.`}
                          onPrefetch={() => { void fetchSeasonPosters(showReq(active, s)) }}
                          onClick={() => setSelectedShow(s)}
                          onCorrect={(meta) => setCorrecting({ req: showReq(active, s), current: meta })}
                          onChangePoster={(meta) =>
                            setPosterEditing({ req: showReq(active, s), current: meta, title: s.title })
                          }
                          isLocked={lockedKeys.has(mk)}
                          onToggleLock={() => toggleLock(mk)}
                        />
                      )
                    })}
                  </div>
                  {filteredShows.length > RENDER_CAP && (
                    <div className="grid-more muted">
                      Affichage limité à {RENDER_CAP} sur {filteredShows.length}. Affine ta recherche.
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

      </div>

      {selectMode && (
        <div className="saga-bar">
          <span className="saga-count">{selectedKeys.length} film(s) sélectionné(s)</span>
          <input
            className="saga-name"
            type="text"
            placeholder="Nom de la saga (ex. Le Seigneur des Anneaux)"
            value={sagaName}
            onChange={(e) => setSagaName(e.target.value)}
          />
          <button
            className="btn-primary saga-btn"
            onClick={createSaga}
            disabled={selectedKeys.length < 2 || !sagaName.trim()}
          >
            Créer la saga
          </button>
          <button className="btn-ghost saga-btn" onClick={cancelSaga}>
            Annuler
          </button>
        </div>
      )}

      {filterCreateMode && (
        <div className="filter-create-bar">
          <span className="saga-count">{filterSelectedKeys.length} élément(s) sélectionné(s)</span>
          <input
            className="saga-name"
            type="text"
            placeholder="Nom de la playlist"
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
          />
          <button className="btn-primary saga-btn" onClick={() => { void saveFilter() }} disabled={!filterName.trim() || filterSelectedKeys.length === 0}>
            {filterEditId ? 'Enregistrer' : 'Créer'}
          </button>
          <button className="btn-ghost saga-btn" onClick={cancelFilterCreate}>Annuler</button>
        </div>
      )}

      {openColl && (
        <CollectionView
          coll={openColl}
          posterOverride={collPosters[`coll:${openColl.id}`]}
          backdropOverride={backdropOverrides[`backdrop:coll:${openColl.id}`]}
          sortNames={sortNames}
          onClose={() => setOpenColl(null)}
          onPlay={(m, displayTitle, queue, queueIndex) => {
            setOpenColl(null)
            onPlayMovie(m, false, displayTitle, queue, queueIndex)
          }}
          onCorrect={(m, meta) => setCorrecting({ req: movieReq(m), current: meta })}
          onChangePoster={(m, meta) =>
            setPosterEditing({ req: movieReq(m), current: meta, title: m.title })
          }
          onChangeCollPoster={() => setEditCollPoster(openColl)}
          onRename={openColl.manual ? (name) => renameColl(openColl.id, name) : undefined}
          onDelete={openColl.manual ? () => deleteColl(openColl.id) : undefined}
          lockedKeys={lockedKeys}
          onToggleLock={(key) => toggleLock(key)}
          onOpenDetail={(m) => {
            setMovieParentColl(openColl)
            setOpenColl(null)
            setSelectedMovie(m)
          }}
        />
      )}

      {selectedMovie && (
        <LocalMovieDetail
          movie={selectedMovie}
          backdropOverride={backdropOverrides[`backdrop:${metaKey('movies', selectedMovie.title, selectedMovie.year)}`]}
          onClose={() => {
            setSelectedMovie(null)
            setMovieParentColl(null)
          }}
          onBack={movieParentColl ? () => {
            setSelectedMovie(null)
            setOpenColl(movieParentColl)
            setMovieParentColl(null)
          } : undefined}
          onPlay={(m, displayTitle, queue, queueIndex) => {
            setSelectedMovie(null)
            setOpenColl(null)
            setMovieParentColl(null)
            onPlayMovie(m, false, displayTitle, queue, queueIndex)
          }}
          queue={parentMovieQueue}
          queueIndex={Math.max(0, parentMovieIndex)}
          onCorrect={(meta) => setCorrecting({ req: movieReq(selectedMovie), current: meta })}
          onChangePoster={(meta) => setPosterEditing({ req: movieReq(selectedMovie), current: meta, title: selectedMovie.title })}
          isLocked={lockedKeys.has(metaKey('movies', selectedMovie.title, selectedMovie.year))}
          onToggleLock={() => toggleLock(metaKey('movies', selectedMovie.title, selectedMovie.year))}
        />
      )}

      {selectedShow && (
        <LocalSeriesDetail
          show={selectedShow}
          kind={active}
          titleOverride={sortNames[metaKey(active, selectedShow.title)] || undefined}
          backdropOverride={backdropOverrides[`backdrop:${metaKey(active, selectedShow.title)}`]}
          onClose={() => setSelectedShow(null)}
          onPlayEpisode={onPlayEpisode}
          onCorrect={(meta) => setCorrecting({ req: showReq(active, selectedShow), current: meta })}
          onChangePoster={(meta) =>
            setPosterEditing({ req: showReq(active, selectedShow), current: meta, title: selectedShow.title })
          }
          isLocked={lockedKeys.has(metaKey(active, selectedShow.title))}
          onToggleLock={() => toggleLock(metaKey(active, selectedShow.title))}
        />
      )}

      {correcting && (
        <MetaCorrectModal
          req={correcting.req}
          current={correcting.current}
          sortName={sortNames[metaKey(correcting.req.kind, correcting.req.title, correcting.req.year)] || ''}
          onSortName={(name) =>
            saveSortName(metaKey(correcting.req.kind, correcting.req.title, correcting.req.year), name)
          }
          onClose={() => setCorrecting(null)}
          onApplied={() => undefined}
        />
      )}

      {posterEditing && (() => {
        const mk = metaKey(posterEditing.req.kind, posterEditing.req.title, posterEditing.req.year)
        return (
          <MetaPosterModal
            req={posterEditing.req}
            current={posterEditing.current}
            title={posterEditing.title}
            currentBackdropUrl={backdropOverrides[`backdrop:${mk}`] || posterEditing.current?.backdrop}
            onClose={() => setPosterEditing(null)}
            onApplied={() => undefined}
            onBackdropApplied={(url) =>
              setBackdropOverrides((prev) => {
                const next = { ...prev }
                if (url) next[`backdrop:${mk}`] = url
                else delete next[`backdrop:${mk}`]
                return next
              })
            }
          />
        )
      })()}

      {editCollPoster && (
        <CollectionPosterModal
          coll={editCollPoster}
          currentPoster={collPosters[`coll:${editCollPoster.id}`]}
          currentBackdrop={backdropOverrides[`backdrop:coll:${editCollPoster.id}`]}
          onClose={() => setEditCollPoster(null)}
          onPosterApplied={(id, url) =>
            setCollPosters((prev) => {
              const next = { ...prev }
              if (url) next[`coll:${id}`] = url
              else delete next[`coll:${id}`]
              return next
            })
          }
          onBackdropApplied={(key, url) =>
            setBackdropOverrides((prev) => {
              const next = { ...prev }
              if (url) next[key] = url
              else delete next[key]
              return next
            })
          }
        />
      )}
    </main>
  )
}
