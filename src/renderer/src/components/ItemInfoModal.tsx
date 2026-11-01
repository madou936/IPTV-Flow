import { useEffect, useState } from 'react'
import type { ContentSection, Credentials, LiveStream, Series, VodStream } from '../types'
import { getVodInfo } from '../api/xtream'

type CatalogItem = LiveStream | VodStream | Series

interface Props {
  creds: Credentials
  section: ContentSection
  item: CatalogItem
  categoryNames: string[]
  onClose: () => void
}

function valueText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(', ')
  return ''
}

export default function ItemInfoModal({ creds, section, item, categoryNames, onClose }: Props): JSX.Element {
  const [providerInfo, setProviderInfo] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(section === 'movies')

  useEffect(() => {
    if (section !== 'movies') return
    let alive = true
    getVodInfo(creds, (item as VodStream).stream_id)
      .then((response) => alive && setProviderInfo(response.info ?? {}))
      .catch(() => alive && setProviderInfo({}))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [creds, item, section])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const info = providerInfo ?? {}
  const read = (...keys: string[]): string => {
    for (const key of keys) {
      const text = valueText(info[key])
      if (text) return text
    }
    return ''
  }
  const facts: Array<[string, string]> = [['Catégorie', categoryNames.length ? categoryNames.join(', ') : 'Sans catégorie']]
  if (section === 'live') {
    const channel = item as LiveStream
    facts.push(['EPG', valueText(channel.epg_channel_id)])
    if (channel.tv_archive) facts.push(['Replay', `${channel.tv_archive} jours`])
  } else if (section === 'movies') {
    facts.push(
      ['Titre original', read('o_name', 'original_name')],
      ['Genre', read('genre')],
      ['Sortie', read('releasedate', 'releaseDate', 'release_date')],
      ['Durée', read('episode_run_time', 'duration', 'duration_secs')],
      ['Note', read('rating', 'rating_imdb')],
      ['Réalisateur', read('director')],
      ['Casting', read('cast', 'actors')],
      ['TMDB', read('tmdb_id')],
      ['Bande-annonce', read('youtube_trailer')]
    )
  } else {
    const show = item as Series
    facts.push(
      ['Genre', valueText(show.genre)],
      ['Sortie', valueText(show.releaseDate)],
      ['Note', valueText(show.rating)],
      ['Casting', valueText(show.cast)]
    )
  }
  facts.push(['Identifiant fournisseur', section === 'series' ? String((item as Series).series_id) : String((item as LiveStream | VodStream).stream_id)])
  const description = section === 'movies'
    ? read('plot', 'description', 'overview')
    : section === 'series' ? valueText((item as Series).plot) : ''

  return (
    <div className="modal-backdrop info-backdrop" onClick={onClose}>
      <div className="modal item-info-modal" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        <h2 className="settings-title">Informations</h2>
        <p className="item-info-title">{item.name}</p>
        {loading && <div className="item-info-loading">Chargement des informations fournisseur…</div>}
        <dl className="item-info-facts">
          {facts.filter(([, value]) => value).map(([label, value]) => (
            <div className="item-info-fact" key={label}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>
          ))}
        </dl>
        {description && <section className="item-info-description"><h3>Synopsis</h3><p>{description}</p></section>}
      </div>
    </div>
  )
}
