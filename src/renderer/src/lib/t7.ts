import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from 'react'
import type { ScanResult, T7Config, T7Filter, T7Kind } from '../types'

interface T7Bridge {
  getConfig: () => Promise<T7Config>
  setFolder: (kind: T7Kind, path: string | null) => Promise<T7Config>
  pickFolder: () => Promise<string | null>
  getDriveStatus: () => Promise<boolean>
  scan: (kind: T7Kind) => Promise<ScanResult>
  rescan: (kind: T7Kind) => Promise<ScanResult>
  probeDuration: (path: string) => Promise<number | undefined>
  getFilters: () => Promise<T7Filter[]>
  saveFilters: (filters: T7Filter[]) => Promise<void>
  onDriveStatus: (fn: (available: boolean) => void) => () => void
}

function bridge(): T7Bridge | undefined {
  return (window as unknown as { host?: { t7?: T7Bridge } }).host?.t7
}

/** Scan a category's folder (cached in main; pass force=true to rescan). */
export async function scanT7(kind: T7Kind, force = false): Promise<ScanResult | null> {
  const b = bridge()
  if (!b) return null
  return force ? b.rescan(kind) : b.scan(kind)
}

/** ffprobe a local file's duration (so the seek bar appears). */
export async function probeT7Duration(path: string): Promise<number | undefined> {
  return bridge()?.probeDuration(path)
}

export function getFilters(): Promise<T7Filter[]> {
  return bridge()?.getFilters() ?? Promise.resolve([])
}
export function saveFilters(filters: T7Filter[]): Promise<void> {
  return bridge()?.saveFilters(filters) ?? Promise.resolve()
}

const EMPTY: T7Config = { movies: null, series: null, anime: null }

interface T7Ctx {
  /** Is the SSD currently mounted? */
  available: boolean
  config: T7Config
  /** True once the initial drive status + config have been read. */
  ready: boolean
  /** Open the native picker and store the chosen folder for `kind`. */
  designate: (kind: T7Kind) => Promise<void>
  /** Forget the folder designated for `kind`. */
  clearFolder: (kind: T7Kind) => Promise<void>
}

const Ctx = createContext<T7Ctx>({
  available: false,
  config: EMPTY,
  ready: false,
  designate: async () => {},
  clearFolder: async () => {}
})

export function T7Provider({ children }: { children: ReactNode }): JSX.Element {
  const [available, setAvailable] = useState(false)
  const [config, setConfig] = useState<T7Config>(EMPTY)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const b = bridge()
    if (!b) {
      setReady(true)
      return
    }
    b.getDriveStatus().then(setAvailable).catch(() => undefined)
    b.getConfig()
      .then(setConfig)
      .catch(() => undefined)
      .finally(() => setReady(true))
    const unsub = b.onDriveStatus(setAvailable)
    return unsub
  }, [])

  const designate = useCallback(async (kind: T7Kind) => {
    const b = bridge()
    if (!b) return
    const path = await b.pickFolder()
    if (!path) return
    const next = await b.setFolder(kind, path)
    setConfig(next)
  }, [])

  const clearFolder = useCallback(async (kind: T7Kind) => {
    const b = bridge()
    if (!b) return
    const next = await b.setFolder(kind, null)
    setConfig(next)
  }, [])

  return createElement(
    Ctx.Provider,
    { value: { available, config, ready, designate, clearFolder } },
    children
  )
}

export function useT7(): T7Ctx {
  return useContext(Ctx)
}
