import { useEffect, useState } from 'react'
import type {
  Collection,
  CollectionDetails,
  Meta,
  MetaCandidate,
  MetaProvider,
  MetaRequest,
  MovieCredits,
  SeasonPrefs,
  T7Kind
} from '../types'

// ---------------------------------------------------------------------------
// Renderer side of T7Flix metadata (phase 2). Lazily fetches a poster + French
// title/plot per visible item, caps concurrency, and caches results so revisits
// are instant. Also wraps the "Corriger l'association" + collections IPC.
// ---------------------------------------------------------------------------

interface MetaBridge {
  get: (req: MetaRequest) => Promise<Meta>
  search: (kind: T7Kind, query: string) => Promise<MetaCandidate[]>
  setOverride: (req: MetaRequest, provider: MetaProvider, id: string) => Promise<Meta>
  clearOverride: (req: MetaRequest) => Promise<Meta>
  posterOptions: (req: MetaRequest, season?: number) => Promise<string[]>
  backdropOptions: (req: MetaRequest) => Promise<string[]>
  movieCredits: (req: MetaRequest) => Promise<MovieCredits>
  seasonPosters: (req: MetaRequest) => Promise<Record<number, string>>
  setPoster: (key: string, url: string) => Promise<void>
  clearPoster: (key: string) => Promise<void>
  metaForKey: (req: MetaRequest) => Promise<Meta>
  getCollections: () => Promise<Collection[]>
  saveCollections: (list: Collection[]) => Promise<Collection[]>
  getSeasonPrefs: (key: string) => Promise<SeasonPrefs>
  saveSeasonPrefs: (key: string, prefs: SeasonPrefs) => Promise<SeasonPrefs>
  getOmdbKey: () => Promise<string>
  setOmdbKey: (key: string) => Promise<void>
  getSortNames: () => Promise<Record<string, string>>
  setSortName: (key: string, name: string) => Promise<void>
  getTmdbToken: () => Promise<string>
  setTmdbToken: (token: string) => Promise<void>
  getCollPosters: () => Promise<Record<string, string>>
  getBackdropOverrides: () => Promise<Record<string, string>>
  refreshBackdrops: () => Promise<void>
  collectionPosters: (id: number) => Promise<string[]>
  collectionBackdrops: (id: number) => Promise<string[]>
  collectionDetails: (id: number) => Promise<CollectionDetails>
  getEpisodeNames: (req: MetaRequest, season: number, offset: number, globalNumbering?: boolean) => Promise<Record<number, string>>
  getEpisodeImages: (req: MetaRequest, season: number, offset: number, globalNumbering?: boolean) => Promise<Record<number, string>>
  lockMeta: (key: string) => Promise<void>
  unlockMeta: (key: string) => Promise<void>
  getLockedKeys: () => Promise<string[]>
}

function bridge(): MetaBridge | undefined {
  return (window as unknown as { host?: { meta?: MetaBridge } }).host?.meta
}

/** MUST match `metaKey` in src/main/metadata.ts — both derive the same id so
 * collections/overrides map onto scanned items. */
export function metaKey(kind: T7Kind, title: string, year?: number): string {
  const n = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return kind === 'movies' ? `movie:${n}:${year ?? ''}` : `${kind}:${n}`
}

// ---- Cache + bounded fetch queue ------------------------------------------
const cache = new Map<string, Meta>()
const inflight = new Map<string, Promise<Meta>>()
const subs = new Map<string, Set<(m: Meta) => void>>()

let active = 0
const MAX_CONCURRENT = 6
const waiting: (() => void)[] = []
function acquire(): Promise<void> {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENT) {
      active++
      resolve()
    } else {
      waiting.push(() => {
        active++
        resolve()
      })
    }
  })
}
function release(): void {
  active--
  waiting.shift()?.()
}

function publish(m: Meta): void {
  cache.set(m.key, m)
  subs.get(m.key)?.forEach((fn) => fn(m))
}

function fetchMeta(req: MetaRequest): Promise<Meta> {
  const key = metaKey(req.kind, req.title, req.year)
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(key)
  if (running) return running
  const b = bridge()
  if (!b) return Promise.resolve({ key, status: 'notfound', provider: 'none', fetchedAt: 0 })
  const p = (async () => {
    await acquire()
    try {
      const m = await b.get(req)
      publish(m)
      return m
    } finally {
      release()
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

/** Lazily resolve metadata for one item. Returns null until it arrives; updates
 * live when the user re-associates it via "Corriger". */
export function useMeta(req: MetaRequest | null): Meta | null {
  const key = req ? metaKey(req.kind, req.title, req.year) : ''
  const [meta, setMeta] = useState<Meta | null>(() => (key ? cache.get(key) ?? null : null))

  useEffect(() => {
    if (!req || !key) {
      setMeta(null)
      return
    }
    let alive = true
    const cached = cache.get(key)
    if (cached) setMeta(cached)
    else {
      setMeta(null)
      fetchMeta(req).then((m) => {
        if (alive) setMeta(m)
      })
    }
    let set = subs.get(key)
    if (!set) {
      set = new Set()
      subs.set(key, set)
    }
    const fn = (m: Meta): void => {
      if (alive) setMeta(m)
    }
    set.add(fn)
    return () => {
      alive = false
      set!.delete(fn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return meta
}

export function searchMeta(kind: T7Kind, query: string): Promise<MetaCandidate[]> {
  return bridge()?.search(kind, query) ?? Promise.resolve([])
}

/** Eagerly resolve metadata for a whole list (for sorting by display title /
 * year). Returns a key→Meta map that grows as results arrive and updates live
 * when an item is re-associated. Local libraries are small, so this is cheap and
 * fully cached after the first pass. */
export function useMetaMap(reqs: MetaRequest[]): Map<string, Meta> {
  const keys = reqs.map((r) => metaKey(r.kind, r.title, r.year))
  const sig = keys.join('|')
  const [map, setMap] = useState<Map<string, Meta>>(() => {
    const m = new Map<string, Meta>()
    for (const k of keys) {
      const c = cache.get(k)
      if (c) m.set(k, c)
    }
    return m
  })

  useEffect(() => {
    let alive = true
    const m = new Map<string, Meta>()
    for (const k of keys) {
      const c = cache.get(k)
      if (c) m.set(k, c)
    }
    setMap(new Map(m))
    const unsubs: (() => void)[] = []
    reqs.forEach((req, i) => {
      const key = keys[i]
      const onMeta = (meta: Meta): void => {
        if (!alive) return
        m.set(key, meta)
        setMap(new Map(m))
      }
      let set = subs.get(key)
      if (!set) {
        set = new Set()
        subs.set(key, set)
      }
      set.add(onMeta)
      unsubs.push(() => set!.delete(onMeta))
      if (!cache.get(key)) void fetchMeta(req).then(onMeta)
    })
    return () => {
      alive = false
      unsubs.forEach((u) => u())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  return map
}

export async function applyOverride(
  req: MetaRequest,
  provider: MetaProvider,
  id: string
): Promise<Meta | null> {
  const b = bridge()
  if (!b) return null
  const m = await b.setOverride(req, provider, id)
  publish(m)
  return m
}

export async function clearAssociation(req: MetaRequest): Promise<Meta | null> {
  const b = bridge()
  if (!b) return null
  const m = await b.clearOverride(req)
  publish(m)
  return m
}

// ---- Poster customisation --------------------------------------------------
export function posterOptions(req: MetaRequest, season?: number): Promise<string[]> {
  return bridge()?.posterOptions(req, season) ?? Promise.resolve([])
}

const seasonPosterMemory = new Map<string, Promise<Record<number, string>>>()
export function seasonPosters(req: MetaRequest, refresh = false): Promise<Record<number, string>> {
  const key = metaKey(req.kind, req.title, req.year)
  if (refresh) seasonPosterMemory.delete(key)
  const existing = seasonPosterMemory.get(key)
  if (existing) return existing
  const request = bridge()?.seasonPosters(req) ?? Promise.resolve({})
  seasonPosterMemory.set(key, request)
  request.catch(() => seasonPosterMemory.delete(key))
  return request
}

/** Set/clear a custom poster, then refresh the tile live. Empty url = clear. */
export async function setCustomPoster(req: MetaRequest, key: string, url: string): Promise<Meta | null> {
  const b = bridge()
  if (!b) return null
  if (url.trim()) await b.setPoster(key, url.trim())
  else await b.clearPoster(key)
  const m = await b.metaForKey(req)
  publish(m)
  return m
}

export function getSortNames(): Promise<Record<string, string>> {
  return bridge()?.getSortNames() ?? Promise.resolve({})
}
export function setSortName(key: string, name: string): Promise<void> {
  return bridge()?.setSortName(key, name) ?? Promise.resolve()
}

export function getTmdbToken(): Promise<string> {
  return bridge()?.getTmdbToken() ?? Promise.resolve('')
}
export function setTmdbToken(token: string): Promise<void> {
  return bridge()?.setTmdbToken(token) ?? Promise.resolve()
}

export function getCollPosters(): Promise<Record<string, string>> {
  return bridge()?.getCollPosters() ?? Promise.resolve({})
}
export function getBackdropOverrides(): Promise<Record<string, string>> {
  return bridge()?.getBackdropOverrides() ?? Promise.resolve({})
}
export function backdropOptions(req: MetaRequest): Promise<string[]> {
  return bridge()?.backdropOptions(req) ?? Promise.resolve([])
}
const movieCreditsMemory = new Map<string, Promise<MovieCredits>>()
export function movieCredits(req: MetaRequest): Promise<MovieCredits> {
  const key = metaKey(req.kind, req.title, req.year)
  const existing = movieCreditsMemory.get(key)
  if (existing) return existing
  const request = bridge()?.movieCredits(req) ?? Promise.resolve({ cast: [] })
  movieCreditsMemory.set(key, request)
  request.catch(() => movieCreditsMemory.delete(key))
  return request
}
export function refreshBackdrops(): Promise<void> {
  return bridge()?.refreshBackdrops() ?? Promise.resolve()
}
export function getCollectionPosters(id: number): Promise<string[]> {
  return bridge()?.collectionPosters(id) ?? Promise.resolve([])
}
export function getCollectionBackdrops(id: number): Promise<string[]> {
  return bridge()?.collectionBackdrops(id) ?? Promise.resolve([])
}
export function getCollectionDetails(id: number): Promise<CollectionDetails> {
  return bridge()?.collectionDetails(id) ?? Promise.resolve({})
}

const episodeNamesMemory = new Map<string, Promise<Record<number, string>>>()
const episodeImagesMemory = new Map<string, Promise<Record<number, string>>>()
const episodeNamesResolved = new Map<string, Record<number, string>>()
const episodeImagesResolved = new Map<string, Record<number, string>>()
function episodeCacheKey(req: MetaRequest, season: number, offset: number, globalNumbering: boolean): string {
  return `${metaKey(req.kind, req.title, req.year)}:${season}:${offset}:${globalNumbering ? 1 : 0}`
}

export function getEpisodeNames(req: MetaRequest, season: number, offset = 0, globalNumbering = false): Promise<Record<number, string>> {
  const key = episodeCacheKey(req, season, offset, globalNumbering)
  const resolved = episodeNamesResolved.get(key)
  if (resolved) return Promise.resolve(resolved)
  const existing = episodeNamesMemory.get(key)
  if (existing) return existing
  const request = (bridge()?.getEpisodeNames(req, season, offset, globalNumbering) ?? Promise.resolve({}))
    .then((result) => {
      episodeNamesResolved.set(key, result)
      return result
    })
  episodeNamesMemory.set(key, request)
  request.catch(() => episodeNamesMemory.delete(key))
  return request
}

export function getEpisodeImages(req: MetaRequest, season: number, offset = 0, globalNumbering = false): Promise<Record<number, string>> {
  const key = episodeCacheKey(req, season, offset, globalNumbering)
  const resolved = episodeImagesResolved.get(key)
  if (resolved) return Promise.resolve(resolved)
  const existing = episodeImagesMemory.get(key)
  if (existing) return existing
  const request = (bridge()?.getEpisodeImages(req, season, offset, globalNumbering) ?? Promise.resolve({}))
    .then((result) => {
      episodeImagesResolved.set(key, result)
      return result
    })
  episodeImagesMemory.set(key, request)
  request.catch(() => episodeImagesMemory.delete(key))
  return request
}

export function peekEpisodeNames(req: MetaRequest, season: number, offset = 0, globalNumbering = false): Record<number, string> {
  return episodeNamesResolved.get(episodeCacheKey(req, season, offset, globalNumbering)) ?? {}
}

export function peekEpisodeImages(req: MetaRequest, season: number, offset = 0, globalNumbering = false): Record<number, string> {
  return episodeImagesResolved.get(episodeCacheKey(req, season, offset, globalNumbering)) ?? {}
}

export function lockMeta(key: string): Promise<void> {
  return bridge()?.lockMeta(key) ?? Promise.resolve()
}
export function unlockMeta(key: string): Promise<void> {
  return bridge()?.unlockMeta(key) ?? Promise.resolve()
}
export function getLockedKeys(): Promise<string[]> {
  return bridge()?.getLockedKeys() ?? Promise.resolve([])
}

/** Set/clear a poster override by raw key (e.g. `coll:<id>`). */
export function rawSetPoster(key: string, url: string): Promise<void> {
  const b = bridge()
  if (!b) return Promise.resolve()
  if (url.trim()) return b.setPoster(key, url.trim())
  return b.clearPoster(key)
}

export function getCollections(): Promise<Collection[]> {
  return bridge()?.getCollections() ?? Promise.resolve([])
}
export function saveCollections(list: Collection[]): Promise<Collection[]> {
  return bridge()?.saveCollections(list) ?? Promise.resolve(list)
}
export function getSeasonPrefs(key: string): Promise<SeasonPrefs> {
  return bridge()?.getSeasonPrefs(key) ?? Promise.resolve({ labels: {}, order: [] })
}
export function saveSeasonPrefs(key: string, prefs: SeasonPrefs): Promise<SeasonPrefs> {
  for (const cacheKey of episodeNamesMemory.keys()) {
    if (cacheKey.startsWith(`${key}:`)) episodeNamesMemory.delete(cacheKey)
  }
  for (const cacheKey of episodeNamesResolved.keys()) {
    if (cacheKey.startsWith(`${key}:`)) episodeNamesResolved.delete(cacheKey)
  }
  for (const cacheKey of episodeImagesMemory.keys()) {
    if (cacheKey.startsWith(`${key}:`)) episodeImagesMemory.delete(cacheKey)
  }
  for (const cacheKey of episodeImagesResolved.keys()) {
    if (cacheKey.startsWith(`${key}:`)) episodeImagesResolved.delete(cacheKey)
  }
  return bridge()?.saveSeasonPrefs(key, prefs) ?? Promise.resolve(prefs)
}

export function getOmdbKey(): Promise<string> {
  return bridge()?.getOmdbKey() ?? Promise.resolve('')
}
export function setOmdbKey(key: string): Promise<void> {
  return bridge()?.setOmdbKey(key) ?? Promise.resolve()
}
