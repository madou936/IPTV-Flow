export type StreamlyPlatform = string

export interface StreamlyStatus {
  platform: StreamlyPlatform
  url: string
  title: string
  loading: boolean
  ready?: boolean
  canGoBack: boolean
  canGoForward: boolean
  pip: boolean
  fullScreen?: boolean
  pipBounds?: { x: number; y: number; width: number; height: number }
  activeTabId?: number
  tabs?: Array<{ id: number; title: string; url: string }>
  error?: string
}

export const STREAMLY_HOME: Record<string, string> = {
  netflix: 'https://www.netflix.com/',
  prime: 'https://www.primevideo.com/',
  youtube: 'https://www.youtube.com/'
}

export function safeStreamlyUrl(platform: StreamlyPlatform, value: string, home = STREAMLY_HOME[platform]): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !home) return home ?? ''
    if (!STREAMLY_HOME[platform] || home !== STREAMLY_HOME[platform]) return url.origin === new URL(home).origin ? url.href : home
    const host = url.hostname.toLowerCase()
    const allowed = platform === 'netflix'
      ? host === 'netflix.com' || host.endsWith('.netflix.com')
      : platform === 'prime'
        ? host === 'primevideo.com' || host.endsWith('.primevideo.com') || /(^|\.)amazon\.(?:[a-z]{2,3})(?:\.[a-z]{2})?$/.test(host)
        : host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be'
    return allowed ? url.href : home
  } catch {
    return home ?? ''
  }
}
