import type { Category, CategoryPrefs } from '../types'

const key = (section: string): string => `iptv_catprefs_${section}`

export function loadPrefs(section: string): CategoryPrefs {
  try {
    const raw = localStorage.getItem(key(section))
    if (raw) return JSON.parse(raw) as CategoryPrefs
  } catch {
    /* ignore */
  }
  return { order: [], hidden: [] }
}

export function savePrefs(section: string, prefs: CategoryPrefs): void {
  localStorage.setItem(key(section), JSON.stringify(prefs))
}

/** Order a category list by the user's preference, keeping unranked ones last. */
export function orderCategories<T extends Category>(cats: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return cats
    .slice()
    .sort(
      (a, b) =>
        (rank.has(a.category_id) ? (rank.get(a.category_id) as number) : Infinity) -
        (rank.has(b.category_id) ? (rank.get(b.category_id) as number) : Infinity)
    )
}

/** Apply hide + order prefs to a freshly fetched category list. */
export function applyPrefs(cats: Category[], prefs: CategoryPrefs): Category[] {
  return orderCategories(
    cats.filter((c) => !prefs.hidden.includes(c.category_id)),
    prefs.order
  )
}
