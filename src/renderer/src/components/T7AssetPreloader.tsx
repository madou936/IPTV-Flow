import { useEffect } from 'react'
import { scanT7, useT7 } from '../lib/t7'
import {
  getEpisodeImages,
  getEpisodeNames,
  movieCredits,
  seasonPosters
} from '../lib/metadata'
import type { LocalMovie, LocalShow, MetaRequest, ScanResult, T7Kind } from '../types'

const movieReq = (movie: LocalMovie): MetaRequest => ({
  kind: 'movies',
  title: movie.title,
  year: movie.year
})
const showReq = (kind: T7Kind, show: LocalShow): MetaRequest => ({ kind, title: show.title })

function preloadImage(url?: string): Promise<void> {
  if (!url) return Promise.resolve()
  return new Promise((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = url
    if (img.complete) resolve()
  })
}

/** Starts warming every T7Flix remote asset as soon as the app launches.
 * All results are also persisted by the metadata layer, so later launches and
 * Chromium-cache clears keep opening details instantly. */
export default function T7AssetPreloader(): null {
  const { config } = useT7()

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const results: Partial<Record<T7Kind, ScanResult>> = {}
      await Promise.all((['movies', 'series', 'anime'] as T7Kind[]).map(async (kind) => {
        if (!config[kind]) return
        try {
          const result = await scanT7(kind)
          if (result) results[kind] = result
        } catch {
          // A disconnected folder must not block other configured libraries.
        }
      }))
      if (cancelled) return

      const tasks: Array<() => Promise<unknown>> = []
      for (const movie of results.movies?.movies ?? []) {
        tasks.push(() => movieCredits(movieReq(movie)))
      }
      for (const kind of ['series', 'anime'] as T7Kind[]) {
        for (const show of results[kind]?.shows ?? []) {
          const req = showReq(kind, show)
          tasks.push(async () => {
            const posters = await seasonPosters(req)
            await Promise.all(Object.values(posters).map((url) => preloadImage(url)))
          })
          for (const season of show.seasons) {
            const offset = show.seasons
              .filter((entry) => entry.season > 0 && entry.season < (season.season === 0 ? Infinity : season.season))
              .reduce((sum, entry) => sum + entry.episodes.length, 0)
            const firstEpisode = season.episodes[0]?.episode
            const globalNumbering = firstEpisode != null && firstEpisode > 1
            tasks.push(() => getEpisodeNames(req, season.season, offset, globalNumbering))
            tasks.push(async () => {
              const images = await getEpisodeImages(req, season.season, offset, globalNumbering)
              await Promise.all(Object.values(images).map((url) => preloadImage(url)))
            })
          }
        }
      }

      let cursor = 0
      async function worker(): Promise<void> {
        while (!cancelled) {
          const index = cursor++
          if (index >= tasks.length) return
          try {
            await tasks[index]()
          } catch {
            // Continue warming the remaining library after an unavailable item.
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, () => worker()))
    })()

    return () => { cancelled = true }
  }, [config.movies, config.series, config.anime])

  return null
}
