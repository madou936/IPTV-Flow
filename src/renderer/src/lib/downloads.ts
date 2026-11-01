import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useReducer,
  type ReactNode
} from 'react'
import { createElement } from 'react'
import type { DownloadItem, StartDownloadParams } from '../types'
import { downloadBridge } from './proxy'

interface DownloadsState {
  items: DownloadItem[]
}

type Action =
  | { type: 'loaded'; items: DownloadItem[] }
  | { type: 'update'; item: DownloadItem }
  | { type: 'remove'; id: string }

function reducer(state: DownloadsState, action: Action): DownloadsState {
  switch (action.type) {
    case 'loaded':
      return { items: action.items }
    case 'update': {
      const idx = state.items.findIndex((d) => d.id === action.item.id)
      if (idx === -1) return { items: [action.item, ...state.items] }
      const next = [...state.items]
      next[idx] = action.item
      return { items: next }
    }
    case 'remove':
      return { items: state.items.filter((d) => d.id !== action.id) }
    default:
      return state
  }
}

interface DownloadsCtx {
  items: DownloadItem[]
  activeCount: number
  start: (p: StartDownloadParams) => Promise<void>
  cancel: (id: string) => void
  pause: (id: string) => void
  resume: (id: string) => void
  remove: (id: string) => Promise<void>
  openFolder: () => void
}

const Ctx = createContext<DownloadsCtx>({
  items: [],
  activeCount: 0,
  start: async () => {},
  cancel: () => {},
  pause: () => {},
  resume: () => {},
  remove: async () => {},
  openFolder: () => {}
})

export function DownloadsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, { items: [] })
  const removedIds = useRef(new Set<string>())

  useEffect(() => {
    const bridge = downloadBridge()
    if (!bridge) return
    bridge.list().then((items) => dispatch({ type: 'loaded', items })).catch(() => {})
    const unsub = bridge.onUpdate((item) => {
      if (!removedIds.current.has(item.id)) dispatch({ type: 'update', item })
    })
    return unsub
  }, [])

  const start = useCallback(async (p: StartDownloadParams) => {
    removedIds.current.delete(p.id)
    const bridge = downloadBridge()
    if (!bridge) return
    const item = await bridge.start(p)
    dispatch({ type: 'update', item })
  }, [])

  const cancel = useCallback((id: string) => {
    downloadBridge()?.cancel(id)
  }, [])

  const pause = useCallback((id: string) => {
    downloadBridge()?.pause(id)
  }, [])

  const resume = useCallback((id: string) => {
    downloadBridge()?.resume(id)
  }, [])

  const remove = useCallback(async (id: string) => {
    // The cancelled ffmpeg process may emit one final update after deletion.
    // Ignore it so the ✓ instantly returns to the download icon.
    removedIds.current.add(id)
    await downloadBridge()?.delete(id)
    dispatch({ type: 'remove', id })
  }, [])

  const openFolder = useCallback(() => {
    void downloadBridge()?.openFolder()
  }, [])

  const activeCount = state.items.filter(
    (d) => d.status === 'downloading' || d.status === 'paused'
  ).length

  return createElement(
    Ctx.Provider,
    { value: { items: state.items, activeCount, start, cancel, pause, resume, remove, openFolder } },
    children
  )
}

export function useDownloads(): DownloadsCtx {
  return useContext(Ctx)
}
