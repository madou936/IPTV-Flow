import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Category,
  CategoryPrefs,
  ContentSection,
  Credentials,
  Favorite,
  FavoriteKind,
  LiveStream,
  Series,
  VodStream
} from '../types'
import {
  getLiveCategories,
  getLiveStreams,
  getSeries,
  getSeriesCategories,
  getVodCategories,
  getVodStreams
} from '../api/xtream'
import { applyPrefs, loadPrefs, savePrefs } from '../lib/categories'
import { clearCatalog, getCatalog, setCatalog } from '../lib/catalog'
import { useFavorites } from '../lib/favorites'
import { useDownloads } from '../lib/downloads'
import CategorySettings from './CategorySettings'
import ItemInfoModal from './ItemInfoModal'

type Item = LiveStream | VodStream | Series

interface Props {
  creds: Credentials
  section: ContentSection
  onPlayLive: (s: LiveStream) => void
  onPlayVod: (s: VodStream) => void
  onOpenSeries: (s: Series) => void
  onDownloadVod: (s: VodStream) => void
}

const LABEL: Record<ContentSection, string> = {
  live: 'TV en Direct',
  movies: 'Films',
  series: 'Séries'
}
const KIND: Record<ContentSection, FavoriteKind> = { live: 'live', movies: 'movie', series: 'series' }
const FAV_ID = '__fav__'
const RENDER_CAP = 600

type SortKey = 'default' | 'az' | 'za' | 'recent' | 'rating'

function readSort(section: ContentSection): SortKey {
  const value = localStorage.getItem(`iptv_sort_${section}`)
  return value === 'az' || value === 'za' || value === 'recent' || value === 'rating' ? value : 'default'
}

function numVal(v: unknown): number {
  const n = parseFloat(String(v ?? ''))
  return Number.isNaN(n) ? 0 : n
}
function recentVal(i: Item): number {
  const o = i as { added?: string; last_modified?: string }
  return numVal(o.added ?? o.last_modified)
}
function sortItems(list: Item[], by: SortKey): Item[] {
  if (by === 'default') return list
  const a = list.slice()
  if (by === 'az') a.sort((x, y) => x.name.localeCompare(y.name, 'fr'))
  else if (by === 'za') a.sort((x, y) => y.name.localeCompare(x.name, 'fr'))
  else if (by === 'recent') a.sort((x, y) => recentVal(y) - recentVal(x))
  else if (by === 'rating')
    a.sort((x, y) => numVal((y as { rating?: string }).rating) - numVal((x as { rating?: string }).rating))
  return a
}
function sortFavs(list: Favorite[], by: SortKey): Favorite[] {
  if (by === 'az') return list.slice().sort((x, y) => x.name.localeCompare(y.name, 'fr'))
  if (by === 'za') return list.slice().sort((x, y) => y.name.localeCompare(x.name, 'fr'))
  return list
}
/** Accent- and case-insensitive normalisation for search. */
function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}
/** Every category a stream belongs to (some panels use a `category_ids` array). */
function itemCats(i: Item): string[] {
  const o = i as { category_id?: string; category_ids?: (number | string)[] }
  if (o.category_ids && o.category_ids.length) return o.category_ids.map(String)
  return o.category_id ? [String(o.category_id)] : []
}

function isProviderCategoryStub(item: Item): boolean {
  return /^\s*#{3,}/.test(item.name || '')
}

// Search index: precomputed normalised names, cached per catalogue array (so a
// 90k-item catalogue is normalised once, never per keystroke or per revisit).
const indexCache = new WeakMap<object, { item: Item; n: string }[]>()
function buildIndex(items: Item[]): { item: Item; n: string }[] {
  let idx = indexCache.get(items)
  if (!idx) {
    idx = items.map((i) => ({ item: i, n: norm(i.name || '') }))
    indexCache.set(items, idx)
  }
  return idx
}

function buildFav(section: ContentSection, item: Item): Favorite {
  if (section === 'live') {
    const s = item as LiveStream
    return { kind: 'live', id: s.stream_id, name: s.name, image: s.stream_icon, category_id: s.category_id }
  }
  if (section === 'movies') {
    const s = item as VodStream
    return { kind: 'movie', id: s.stream_id, name: s.name, image: s.stream_icon, ext: s.container_extension || 'mp4', category_id: s.category_id }
  }
  const s = item as Series
  return { kind: 'series', id: s.series_id, name: s.name, image: s.cover, category_id: s.category_id }
}

function itemKey(section: ContentSection, item: Item): number {
  return section === 'series' ? (item as Series).series_id : (item as LiveStream).stream_id
}

interface Ctx {
  x: number
  y: number
  fav: Favorite
  item?: Item
}

export default function ContentBrowser({
  creds,
  section,
  onPlayLive,
  onPlayVod,
  onOpenSeries,
  onDownloadVod
}: Props): JSX.Element {
  const { favorites, isFavorite, toggle } = useFavorites()
  const { items: downloads, remove: removeDownload } = useDownloads()
  const [rawCats, setRawCats] = useState<Category[]>([])
  const [prefs, setPrefs] = useState<CategoryPrefs>(() => loadPrefs(section))
  const [activeCat, setActiveCat] = useState<string | null>(null)
  const [allItems, setAllItems] = useState<Item[] | null>(null)
  const [loadingCats, setLoadingCats] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [infoItem, setInfoItem] = useState<Item | null>(null)
  const [reload, setReload] = useState(0)
  const [refreshMenu, setRefreshMenu] = useState(false)
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Debounce search so a huge catalogue isn't re-filtered on every keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 180)
    return () => window.clearTimeout(t)
  }, [search])

  // Warm the search index as soon as the catalogue loads → the first search is
  // instant (cached across remounts via the WeakMap).
  useEffect(() => {
    if (allItems && allItems.length) buildIndex(allItems)
  }, [allItems])
  const [sortBySection, setSortBySection] = useState<Record<ContentSection, SortKey>>(() => ({
    live: readSort('live'),
    movies: readSort('movies'),
    series: readSort('series')
  }))
  const sortBy = sortBySection[section]
  function setSortBy(value: SortKey): void {
    setSortBySection((current) => ({ ...current, [section]: value }))
    localStorage.setItem(`iptv_sort_${section}`, value)
  }

  const realCats = useMemo(() => applyPrefs(rawCats, prefs), [rawCats, prefs])
  const categories = useMemo<Category[]>(
    () => [{ category_id: FAV_ID, category_name: '★ Favoris' }, ...realCats],
    [realCats]
  )
  const isFav = activeCat === FAV_ID
  const favItems = useMemo(() => favorites.filter((f) => f.kind === KIND[section]), [favorites, section])

  // Count of items per category (from the full catalogue).
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    ;(allItems || []).forEach((i) => itemCats(i).forEach((c) => m.set(c, (m.get(c) || 0) + 1)))
    return m
  }, [allItems])

  // Load categories + the full catalogue (cached per section → instant on
  // revisit; "Mettre à jour" bumps `reload` to force a fresh fetch).
  useEffect(() => {
    let alive = true
    const cached = getCatalog(section)
    if (cached) {
      setRawCats(cached.cats)
      setAllItems(cached.items as Item[])
      setLoadingCats(false)
      return
    }
    setLoadingCats(true)
    setAllItems(null)
    setError(null)
    const catLoader =
      section === 'live' ? getLiveCategories : section === 'movies' ? getVodCategories : getSeriesCategories
    const itemLoader = section === 'live' ? getLiveStreams : section === 'movies' ? getVodStreams : getSeries
    Promise.all([catLoader(creds), itemLoader(creds)])
      .then(([cats, items]) => {
        if (!alive) return
        const c = cats || []
        const list = (items as Item[]) || []
        setRawCats(c)
        setAllItems(list)
        setCatalog(section, c, list)
      })
      .catch((e) => {
        if (alive) {
          setError((e as Error).message)
          setAllItems([])
        }
      })
      .finally(() => alive && setLoadingCats(false))
    return () => {
      alive = false
    }
  }, [creds, section, reload])

  // Keep a valid active category (default = first real category).
  useEffect(() => {
    const ids = categories.map((c) => c.category_id)
    if (!activeCat || !ids.includes(activeCat)) {
      setActiveCat(realCats[0]?.category_id ?? FAV_ID)
    }
  }, [categories, realCats, activeCat])

  // Close the context menu on any outside interaction.
  useEffect(() => {
    if (!ctx) return
    const close = (): void => setCtx(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtx(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctx])

  // Close the refresh menu on any outside click.
  useEffect(() => {
    if (!refreshMenu) return
    const close = (): void => setRefreshMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [refreshMenu])

  const activeItems = useMemo(() => {
    if (!allItems || isFav || !activeCat) return []
    return allItems.filter((i) => itemCats(i).includes(activeCat) && (section !== 'live' || !isProviderCategoryStub(i)))
  }, [allItems, activeCat, isFav])

  const searchableItems = useMemo(() => {
    const hidden = new Set(prefs.hidden)
    return (allItems || []).filter((item) => {
      const memberships = itemCats(item)
      return memberships.length === 0 || memberships.some((id) => !hidden.has(id))
    })
  }, [allItems, prefs.hidden])
  const catalogItemsByID = useMemo(() => {
    const map = new Map<string, Item>()
    for (const item of allItems || []) {
      const id = section === 'series'
        ? String((item as Series).series_id)
        : String((item as LiveStream | VodStream).stream_id)
      map.set(id, item)
    }
    return map
  }, [allItems, section])

  const filtered = useMemo(() => {
    const q = norm(debouncedSearch.trim())
    if (!q) return sortItems(activeItems, sortBy)
    const base = buildIndex(searchableItems)
      .filter((x) => x.n.includes(q))
      .map((x) => x.item)
    return sortItems(base, sortBy)
  }, [activeItems, searchableItems, debouncedSearch, sortBy])

  const filteredFav = useMemo(() => {
    const q = norm(debouncedSearch.trim())
    const hidden = new Set(prefs.hidden)
    const base = q
      ? favItems.filter((f) => {
          if (!norm(f.name).includes(q)) return false
          const item = catalogItemsByID.get(String(f.id))
          if (!item) return true
          const memberships = itemCats(item)
          return memberships.length === 0 || memberships.some((id) => !hidden.has(id))
        })
      : favItems
    return sortFavs(base, sortBy)
  }, [favItems, debouncedSearch, sortBy, catalogItemsByID, prefs.hidden])

  function handleClick(item: Item): void {
    if (section === 'live') onPlayLive(item as LiveStream)
    else if (section === 'movies') onPlayVod(item as VodStream)
    else {
      const series = item as Series
      onOpenSeries({ ...series, category_name: rawCats.find((category) => category.category_id === series.category_id)?.category_name })
    }
  }

  function activateFavorite(fav: Favorite): void {
    if (fav.kind === 'live') {
      onPlayLive({ num: 0, name: fav.name, stream_id: fav.id, stream_icon: fav.image, category_id: '' })
    } else if (fav.kind === 'movie') {
      onPlayVod({
        num: 0,
        name: fav.name,
        stream_id: fav.id,
        stream_icon: fav.image,
        category_id: '',
        container_extension: fav.ext
      })
    } else {
      onOpenSeries({
        num: 0, series_id: fav.id, name: fav.name, cover: fav.image,
        category_id: fav.category_id || '',
        category_name: rawCats.find((category) => category.category_id === fav.category_id)?.category_name
      })
    }
  }

  function openContext(e: React.MouseEvent, fav: Favorite, item?: Item): void {
    e.preventDefault()
    e.stopPropagation()
    const catalogID = String(fav.id)
    setCtx({ x: e.clientX, y: e.clientY, fav, item: item ?? catalogItemsByID.get(catalogID) })
  }

  function saveSettings(next: CategoryPrefs): void {
    savePrefs(section, next)
    setPrefs(next)
    setSettingsOpen(false)
  }

  function refresh(target: 'all' | ContentSection): void {
    setRefreshMenu(false)
    if (target === 'all') {
      clearCatalog()
      setReload((r) => r + 1)
    } else if (target === section) {
      clearCatalog(section)
      setReload((r) => r + 1)
    } else {
      clearCatalog(target) // reloaded when that section is opened
    }
  }

  const searching = !!debouncedSearch.trim()
  const loading = allItems === null
  const shown = filtered.slice(0, RENDER_CAP)
  const shownFav = filteredFav.slice(0, RENDER_CAP)

  const loadingState = (
    <div className="grid-state">
      <div className="spinner" />
      <span className="loading-label">Chargement du catalogue…</span>
    </div>
  )
  const itemGrid = (
    <>
      <div className={`grid ${section === 'live' ? 'grid-live' : 'grid-poster'}`}>
        {shown.map((item) => (
          <Card
            key={itemKey(section, item)}
            title={item.name}
            image={section === 'series' ? (item as Series).cover : (item as VodStream).stream_icon}
            live={section === 'live'}
            downloadable={section === 'movies'}
            downloaded={section === 'movies' && downloads.some((download) => download.id === `movie-${(item as VodStream).stream_id}`)}
            onDownload={section === 'movies' ? () => {
              const id = `movie-${(item as VodStream).stream_id}`
              if (downloads.some((download) => download.id === id)) void removeDownload(id)
              else onDownloadVod(item as VodStream)
            } : undefined}
            fav={buildFav(section, item)}
            onClick={() => handleClick(item)}
            onContext={(e, fav) => openContext(e, fav, item)}
          />
        ))}
      </div>
      {filtered.length > RENDER_CAP && (
        <div className="grid-more muted">
          Affichage limité à {RENDER_CAP} sur {filtered.length}. Affine ta recherche.
        </div>
      )}
    </>
  )

  return (
    <main className="content">
      <header className="topbar">
        <h2>{LABEL[section]}</h2>
        <input
          className="search"
          type="search"
          placeholder={`Rechercher dans ${LABEL[section]}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="sort"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          title="Trier"
        >
          <option value="default">Tri : défaut</option>
          <option value="az">Nom A → Z</option>
          <option value="za">Nom Z → A</option>
          <option value="recent">Plus récents</option>
          <option value="rating">Mieux notés</option>
        </select>
        <div className="refresh-wrap">
          <button
            className="cog"
            onClick={(e) => {
              e.stopPropagation()
              setRefreshMenu((v) => !v)
            }}
            title="Mettre à jour le contenu"
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
          {refreshMenu && (
            <div className="sub-menu refresh-menu">
              <button className="sub-item" onClick={() => refresh('all')}>
                Tout actualiser
              </button>
              <button className="sub-item" onClick={() => refresh('live')}>
                TV en Direct
              </button>
              <button className="sub-item" onClick={() => refresh('movies')}>
                Films
              </button>
              <button className="sub-item" onClick={() => refresh('series')}>
                Séries
              </button>
            </div>
          )}
        </div>
        <button
          className="cog"
          onClick={() => setSettingsOpen(true)}
          title="Gérer les catégories"
          disabled={rawCats.length === 0}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </button>
      </header>

      {error && <div className="banner-error">{error}</div>}

      <div className="browser">
        <div className="cat-list">
          {loadingCats ? (
            <div className="cat-loading">Chargement…</div>
          ) : (
            categories.map((c) => {
              const count = c.category_id === FAV_ID ? favItems.length : counts.get(c.category_id)
              return (
                <button
                  key={c.category_id}
                  className={`cat ${activeCat === c.category_id ? 'active' : ''} ${c.category_id === FAV_ID ? 'cat-fav' : ''}`}
                  onClick={() => {
                    setSearch('')
                    setActiveCat(c.category_id)
                  }}
                  title={c.category_name}
                >
                  <span className="cat-name">{c.category_name}</span>
                  {count != null && <span className="cat-count">{count}</span>}
                </button>
              )
            })
          )}
        </div>

        <div className="grid-wrap">
          {searching ? (
            // Search always spans the whole section catalogue — even from Favoris.
            loading ? (
              loadingState
            ) : shown.length === 0 ? (
              <div className="grid-state muted">Aucun résultat.</div>
            ) : (
              itemGrid
            )
          ) : isFav ? (
            shownFav.length === 0 ? (
              <div className="fav-empty">
                <div className="fav-empty-star">★</div>
                <p>Aucun favori dans cette section.</p>
                <p className="muted">
                  Clic droit (ou appui long) sur une vignette → <strong>Ajouter aux favoris</strong>.
                </p>
              </div>
            ) : (
              <div className={`grid ${section === 'live' ? 'grid-live' : 'grid-poster'}`}>
                {shownFav.map((fav) => (
                  <Card
                    key={`${fav.kind}-${fav.id}`}
                    title={fav.name}
                    image={fav.image}
                    live={fav.kind === 'live'}
                    downloadable={fav.kind === 'movie'}
                    downloaded={fav.kind === 'movie' && downloads.some((download) => download.id === `movie-${fav.id}`)}
                    onDownload={fav.kind === 'movie' ? () => {
                      const id = `movie-${fav.id}`
                      if (downloads.some((download) => download.id === id)) void removeDownload(id)
                      else onDownloadVod({ num: 0, name: fav.name, stream_id: fav.id, stream_icon: fav.image, category_id: '', container_extension: fav.ext })
                    } : undefined}
                    fav={fav}
                    onClick={() => activateFavorite(fav)}
                    onContext={openContext}
                  />
                ))}
              </div>
            )
          ) : loading ? (
            loadingState
          ) : shown.length === 0 ? (
            <div className="grid-state muted">Catégorie vide.</div>
          ) : (
            itemGrid
          )}
        </div>
      </div>

      {ctx && (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
          <button
            className="ctx-item"
            onClick={() => {
              toggle(ctx.fav)
              setCtx(null)
            }}
          >
            {isFavorite(ctx.fav.kind, ctx.fav.id) ? '★ Retirer des favoris' : '☆ Ajouter aux favoris'}
          </button>
          {section === 'movies' && ctx.item && (
            <button
              className="ctx-item"
              onClick={() => {
                onDownloadVod(ctx.item as VodStream)
                setCtx(null)
              }}
            >
              ⬇ Télécharger
            </button>
          )}
          {ctx.item && (
            <button
              className="ctx-item"
              onClick={() => {
                setInfoItem(ctx.item ?? null)
                setCtx(null)
              }}
            >
              ⓘ Infos
            </button>
          )}
        </div>
      )}

      {settingsOpen && (
        <CategorySettings
          title={LABEL[section]}
          categories={rawCats}
          prefs={prefs}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}
      {infoItem && (
        <ItemInfoModal
          creds={creds}
          section={section}
          item={infoItem}
          categoryNames={itemCats(infoItem).map((id) => rawCats.find((category) => category.category_id === id)?.category_name ?? id)}
          onClose={() => setInfoItem(null)}
        />
      )}
    </main>
  )
}

const HOLD_MS = 400
const RING = 2 * Math.PI * 16

export function Card({
  title,
  image,
  live,
  downloadable = false,
  downloaded = false,
  onDownload,
  fav,
  onClick,
  onContext
}: {
  title: string
  image: string
  live: boolean
  downloadable?: boolean
  downloaded?: boolean
  onDownload?: () => void
  fav: Favorite
  onClick: () => void
  onContext: (e: React.MouseEvent, fav: Favorite) => void
}): JSX.Element {
  const { isFavorite, toggle } = useFavorites()
  const faved = isFavorite(fav.kind, fav.id)
  const [broken, setBroken] = useState(false)
  const [pressing, setPressing] = useState(false)
  const [flash, setFlash] = useState<null | 'added' | 'removed'>(null)
  const timer = useRef<number>()
  const longFired = useRef(false)

  function start(e: React.PointerEvent): void {
    if (e.button !== 0) return // ignore right/middle click (right-click = context menu)
    longFired.current = false
    setPressing(true)
    timer.current = window.setTimeout(() => {
      longFired.current = true
      setPressing(false)
      const added = toggle(fav)
      setFlash(added ? 'added' : 'removed')
      window.setTimeout(() => setFlash(null), 900)
    }, HOLD_MS)
  }
  function cancel(): void {
    setPressing(false)
    if (timer.current) window.clearTimeout(timer.current)
  }
  function handleClick(): void {
    if (longFired.current) {
      longFired.current = false
      return
    }
    onClick()
  }

  return (
    <button
      className={`card ${live ? 'card-live' : ''}`}
      style={{ width: '100%', minWidth: 0, justifySelf: 'stretch' }}
      onClick={handleClick}
      onContextMenu={(e) => onContext(e, fav)}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      title={title}
    >
      <div className="card-thumb">
        {image && !broken ? (
          <img src={image} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <div className="card-fallback">{title?.slice(0, 2).toUpperCase()}</div>
        )}
        <span className="card-play">▶</span>
        {downloadable && onDownload && (
          <span
            className="card-download-hint"
            title="Télécharger"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onDownload()
            }}
          >{downloaded ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Téléchargé">
              <path d="m5 12 4 4L19 6" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-label="Télécharger">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="m7 10 5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
          )}</span>
        )}
        {faved && (
          <span
            className="card-fav"
            role="button"
            title="Retirer des favoris"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              toggle(fav)
            }}
          >★</span>
        )}
        {pressing && (
          <svg className="hold-ring" viewBox="0 0 36 36">
            <circle className="hold-ring-bg" cx="18" cy="18" r="16" />
            <circle
              className="hold-ring-fg"
              cx="18"
              cy="18"
              r="16"
              style={{ strokeDasharray: RING, strokeDashoffset: RING, animationDuration: `${HOLD_MS}ms` }}
            />
          </svg>
        )}
        {flash && <span className={`hold-flash ${flash}`}>{flash === 'added' ? '★ Ajouté' : 'Retiré'}</span>}
      </div>
      <div className="card-title">{title}</div>
    </button>
  )
}
