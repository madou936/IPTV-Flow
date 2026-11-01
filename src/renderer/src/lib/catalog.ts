import type { Category, LiveStream, Series, VodStream } from '../types'

type Item = LiveStream | VodStream | Series

interface Cached {
  cats: Category[]
  items: Item[]
}

// Per-section catalogue cache for the current session. Keeps section switching
// instant; "Mettre à jour" clears it to force a fresh fetch.
const cache = new Map<string, Cached>()

export function getCatalog(section: string): Cached | undefined {
  return cache.get(section)
}

export function setCatalog(section: string, cats: Category[], items: Item[]): void {
  cache.set(section, { cats, items })
}

/** Clear one section's cache, or all of them when no section is given. */
export function clearCatalog(section?: string): void {
  if (section) cache.delete(section)
  else cache.clear()
}
