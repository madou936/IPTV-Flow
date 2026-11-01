import type { AudioTrack, DownloadItem, StartDownloadParams, SubTrack } from '../types'

interface DownloadBridge {
  start: (p: StartDownloadParams) => Promise<DownloadItem>
  cancel: (id: string) => Promise<void>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  delete: (id: string) => Promise<void>
  list: () => Promise<DownloadItem[]>
  openFolder: () => Promise<void>
  onUpdate: (fn: (item: DownloadItem) => void) => () => void
}

interface SubBridge {
  pickFile: () => Promise<string | null>
}

interface PipBridge {
  enter: (aspectRatio?: number) => Promise<void>
  exit: () => Promise<void>
  setPosition: (x: number, y: number) => Promise<void>
}

export interface CastDevice {
  id: string
  name: string
  host: string
  port: number
  model?: string
}

export interface CastPlaybackOptions {
  audio?: number
  sub?: number
  subBitmap?: boolean
  subPath?: string
}

interface HostBridge {
  platform?: string
  proxyPort?: number
  diagnostics?: boolean
  debugMediaPath?: string
  focusWindow?: () => void
  clearCache?: () => Promise<{ bytes?: number }>
  t7tv?: {
    start?: () => Promise<string>
    getUrl?: () => Promise<string>
  }
  system?: {
    openCastSettings?: () => Promise<boolean>
    startLocalCast?: (src: string) => Promise<string | null>
    listCastDevices?: () => Promise<CastDevice[]>
    playOnCastDevice?: (
      device: CastDevice,
      src: string,
      title: string,
      currentTime: number,
      isLive: boolean,
      opts?: CastPlaybackOptions
    ) => Promise<{ url: string; playerState?: string }>
  }
  downloads?: DownloadBridge
  xtream?: {
    exportOrganisation?: (contents: string) => Promise<boolean>
    pickOrganisation?: () => Promise<string | null>
  }
  sub?: SubBridge
  pip?: PipBridge
}

function host(): HostBridge | undefined {
  return (window as unknown as { host?: HostBridge }).host
}

function base(): string {
  return `http://127.0.0.1:${host()?.proxyPort}`
}

export interface StreamParams {
  live?: boolean
  start?: number
  audio?: number
  sub?: number
  subBitmap?: boolean
  /** External sidecar subtitle file to burn in (local T7 media). */
  subPath?: string
  /** Set only after the direct video element has rejected the picture codec. */
  transcodeVideo?: boolean
}

/** Build a URL to the local remux proxy for a given source stream. */
export function proxyUrl(src: string, opts: StreamParams = {}): string {
  const params = new URLSearchParams({ src })
  if (opts.live) params.set('live', '1')
  if (opts.start && opts.start > 0) params.set('start', String(Math.floor(opts.start)))
  if (opts.audio && opts.audio > 0) params.set('audio', String(opts.audio))
  if (opts.sub != null && opts.sub >= 0) {
    params.set('sub', String(opts.sub))
    if (opts.subBitmap) params.set('subBitmap', '1')
  }
  if (opts.subPath) params.set('subPath', opts.subPath)
  if (opts.transcodeVideo) params.set('transcodeVideo', '1')
  return `${base()}/stream?${params.toString()}`
}

/** Extract a small JPEG frame for the seek-bar hover preview. */
export function thumbnailUrl(src: string, time: number): string {
  const params = new URLSearchParams({ src, time: String(Math.max(0, Math.floor(time))) })
  return `${base()}/thumbnail?${params.toString()}`
}

/** Serve a local media file over the app's loopback HTTP server with Range support. */
export function localFileUrl(src: string): string {
  const params = new URLSearchParams({ src })
  return `${base()}/file?${params.toString()}`
}

/** Build a URL for a text subtitle track extracted as WebVTT by the proxy. */
export function subtitleUrl(src: string, sub: number, start = 0): string {
  const params = new URLSearchParams({ src, sub: String(sub) })
  if (start > 0) params.set('start', String(Math.floor(start)))
  return `${base()}/subtitle?${params.toString()}`
}

export function companionAudioUrl(src: string, audio: number, start: number): string {
  const params = new URLSearchParams({ src, audio: String(audio) })
  if (start > 0) params.set('start', String(start))
  return `${base()}/audio?${params.toString()}`
}

export function bitmapSubtitleUrl(src: string, sub: number, start: number, width = 1920, height = 1080): string {
  const params = new URLSearchParams({ src, sub: String(sub), width: String(width), height: String(height) })
  if (start > 0) params.set('start', String(start))
  return `${base()}/bitmap-subtitle?${params.toString()}`
}

export interface VideoInfo {
  codec: string
  codecTag?: string
  width: number
  height: number
  bitrate: number  // bits per second (0 = unknown)
  encoder: string  // e.g. "x264" / "x265" — often empty for IPTV streams
  bitDepth: number  // 8, 10 or 12
}

/** Ask ffprobe (via the proxy) for the audio + subtitle tracks of a stream. */
export async function probeTracks(src: string): Promise<{ audio: AudioTrack[]; subs: SubTrack[]; video: VideoInfo | null; duration?: number }> {
  try {
    const res = await fetch(`${base()}/probe?src=${encodeURIComponent(src)}`)
    const data = await res.json()
    const duration = Number(data.duration)
    return { audio: data.audio || [], subs: data.subs || [], video: data.video ?? null, duration: Number.isFinite(duration) && duration > 0 ? duration : undefined }
  } catch {
    return { audio: [], subs: [], video: null, duration: undefined }
  }
}

export function focusWindow(): void {
  host()?.focusWindow?.()
}

export async function enterPip(aspectRatio?: number): Promise<void> {
  await host()?.pip?.enter?.(aspectRatio)
}

export async function exitPip(): Promise<void> {
  await host()?.pip?.exit?.()
}

export function movePipWindow(x: number, y: number): void {
  void host()?.pip?.setPosition?.(x, y)
}

export async function pickSubtitleFile(): Promise<string | null> {
  return host()?.sub?.pickFile?.() ?? null
}

export async function clearCache(): Promise<{ bytes?: number }> {
  return host()?.clearCache?.() ?? {}
}

export async function getT7TvUrl(): Promise<string> {
  return (await host()?.t7tv?.getUrl?.()) ?? ''
}

export async function startT7Tv(): Promise<string> {
  return (await host()?.t7tv?.start?.()) ?? ''
}

export function hostPlatform(): string {
  return host()?.platform || 'unknown'
}

export async function openCastSettings(): Promise<boolean> {
  return (await host()?.system?.openCastSettings?.()) ?? false
}

export async function startLocalCast(src: string): Promise<string | null> {
  return (await host()?.system?.startLocalCast?.(src)) ?? null
}

export async function listCastDevices(): Promise<CastDevice[]> {
  return (await host()?.system?.listCastDevices?.()) ?? []
}

export async function playOnCastDevice(
  device: CastDevice,
  src: string,
  title: string,
  currentTime: number,
  isLive: boolean,
  opts?: CastPlaybackOptions
): Promise<{ url: string; playerState?: string } | null> {
  return (await host()?.system?.playOnCastDevice?.(device, src, title, currentTime, isLive, opts)) ?? null
}

export function downloadBridge(): DownloadBridge | undefined {
  return host()?.downloads
}

/** Saves the local Xtream organisation through a native macOS save dialog. */
export function exportXtreamOrganisation(contents: string): Promise<boolean> {
  return host()?.xtream?.exportOrganisation?.(contents) ?? Promise.resolve(false)
}

/** Opens a native dialog and returns a previously exported Xtream JSON file. */
export function pickXtreamOrganisation(): Promise<string | null> {
  return host()?.xtream?.pickOrganisation?.() ?? Promise.resolve(null)
}

/** Parse an Xtream duration ("HH:MM:SS" or duration_secs) into seconds. */
export function durationToSecs(
  info: { duration_secs?: number | string; duration?: string } | null | undefined
): number | undefined {
  if (!info) return undefined
  if (info.duration_secs != null && info.duration_secs !== '') {
    const n = Number(info.duration_secs)
    if (!Number.isNaN(n) && n > 0) return n
  }
  if (typeof info.duration === 'string') {
    const parts = info.duration.split(':').map(Number)
    if (parts.length === 3 && parts.every((p) => !Number.isNaN(p))) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }
  }
  return undefined
}
