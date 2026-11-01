import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { Favorite, FavoriteKind } from '../types'

const KEY = 'iptv_favorites'

interface FavoritesCtx {
  favorites: Favorite[]
  isFavorite: (kind: FavoriteKind, id: number) => boolean
  /** Adds or removes the favorite. Returns true if it was added. */
  toggle: (fav: Favorite) => boolean
}

const Ctx = createContext<FavoritesCtx | null>(null)

function load(): Favorite[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]') as Favorite[]
  } catch {
    return []
  }
}

export function FavoritesProvider({ children }: { children: ReactNode }): JSX.Element {
  const [favorites, setFavorites] = useState<Favorite[]>(load)

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(favorites))
  }, [favorites])

  const isFavorite = useCallback(
    (kind: FavoriteKind, id: number) => favorites.some((f) => f.kind === kind && f.id === id),
    [favorites]
  )

  const toggle = useCallback(
    (fav: Favorite): boolean => {
      const exists = favorites.some((f) => f.kind === fav.kind && f.id === fav.id)
      setFavorites(
        exists
          ? favorites.filter((f) => !(f.kind === fav.kind && f.id === fav.id))
          : [fav, ...favorites]
      )
      return !exists
    },
    [favorites]
  )

  const value = useMemo(() => ({ favorites, isFavorite, toggle }), [favorites, isFavorite, toggle])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useFavorites(): FavoritesCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useFavorites doit être utilisé dans <FavoritesProvider>')
  return ctx
}
