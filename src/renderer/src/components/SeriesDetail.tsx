import { useEffect, useMemo, useState } from 'react'
import type { Credentials, Episode, Series, SeriesInfo } from '../types'
import { getSeriesInfo } from '../api/xtream'
import { useDownloads } from '../lib/downloads'

interface Props {
  creds: Credentials
  series: Series
  onClose: () => void
  onPlayEpisode: (episodes: Episode[], index: number, seriesName: string, season: number, seriesId?: number) => void
  onDownloadEpisode: (ep: Episode, seriesName: string, season: number) => void
}

export default function SeriesDetail({ creds, series, onClose, onPlayEpisode, onDownloadEpisode }: Props): JSX.Element {
  const { items: downloads, remove: removeDownload } = useDownloads()
  const [data, setData] = useState<SeriesInfo | null>(null)
  const [activeSeason, setActiveSeason] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  useEffect(() => {
    let alive = true
    setLoading(true)
    getSeriesInfo(creds, series.series_id)
      .then((info) => {
        if (!alive) return
        setData(info)
        const firstNonSpecial = info.seasons.find((s) => s.season_number !== 0)
        setActiveSeason(firstNonSpecial?.season_number ?? info.seasons[0]?.season_number ?? null)
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [creds, series.series_id])

  const sortedSeasons = data
    ? [...data.seasons.filter((s) => s.season_number !== 0), ...data.seasons.filter((s) => s.season_number === 0)]
    : []
  const episodes = (activeSeason != null && data?.episodes[String(activeSeason)]) || []
  const cover = data?.info.cover || series.cover
  const plot = data?.info.plot || series.plot
  const downloadsById = useMemo(
    () => new Map(downloads.map((item) => [item.id, item])),
    [downloads]
  )
  const episodeLabel = (episode: Episode): string => {
    const title = episode.title || episode.info?.name || episode.info?.title || ''
    const readable = title.replace(/\bS\d{1,2}E\d{1,3}\b\s*[-–:·]?\s*/i, '').trim()
    return readable || `Épisode ${episode.episode_num}`
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Fermer">
          ✕
        </button>

        <div className="series-head">
          {cover ? <img className="series-cover" src={cover} alt="" /> : <div className="series-cover ph" />}
          <div className="series-meta">
            <h2>{series.name}</h2>
            <div className="series-tags">
              {series.genre && <span className="tag">{series.genre}</span>}
              {series.rating && <span className="tag">★ {series.rating}</span>}
              {series.releaseDate && <span className="tag">{series.releaseDate}</span>}
              {(series.category_name || series.category_id) && <span className="tag">Catégorie : {series.category_name || series.category_id}</span>}
            </div>
            {plot && <p className="series-plot">{plot}</p>}
          </div>
        </div>

        {loading ? (
          <div className="grid-state">
            <div className="spinner" />
          </div>
        ) : error ? (
          <div className="banner-error">{error}</div>
        ) : (
          <>
            {sortedSeasons.length > 1 && (
              <div className="season-tabs">
                {sortedSeasons.map((s) => (
                  <button
                    key={s.season_number}
                    className={`season-tab ${activeSeason === s.season_number ? 'active' : ''}`}
                    onClick={() => setActiveSeason(s.season_number)}
                  >
                    {s.name || (s.season_number === 0 ? 'Spéciaux' : `Saison ${s.season_number}`)}
                  </button>
                ))}
              </div>
            )}

            <div className="episodes">
              {episodes.length === 0 ? (
                <div className="grid-state muted">Aucun épisode.</div>
              ) : (
                episodes.map((ep, i) => (
                  <div key={ep.id} className={`episode-row ${downloadsById.has(`ep-${ep.id}`) ? 'episode-row--downloading' : ''}`}>
                    <button
                      className="episode"
                      onClick={() => onPlayEpisode(episodes, i, series.name, activeSeason ?? 0, series.series_id)}
                    >
                      <span className="episode-num">{ep.episode_num}</span>
                      <span className="episode-title">{episodeLabel(ep)}</span>
                      {ep.info?.duration && <span className="episode-dur">{ep.info.duration}</span>}
                      <span className="episode-play">▶</span>
                    </button>
                    <button
                      className="episode-dl"
                      title={downloadsById.has(`ep-${ep.id}`) ? 'Supprimer ce téléchargement' : 'Télécharger cet épisode'}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (downloadsById.has(`ep-${ep.id}`)) void removeDownload(`ep-${ep.id}`)
                        else onDownloadEpisode(ep, series.name, activeSeason ?? 0)
                      }}
                    >
                      {downloadsById.has(`ep-${ep.id}`) ? (
                        <span className="episode-dl-active" aria-label="Supprimer le téléchargement">✓</span>
                      ) : (
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
