import type { ExternalSub } from '../types'
import { subtitleUrl } from './proxy'

/** Convert SubRip (.srt) text to WebVTT so the <video> element can render it. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim()
  return `WEBVTT\n\n${body}\n`
}

/**
 * Best-effort extraction of subtitle URLs from a get_vod_info payload. Panels
 * are wildly inconsistent here, so we probe the common shapes and skip anything
 * that doesn't look like a usable URL.
 */
export function extractSubs(vodInfo: { info?: Record<string, unknown> } | null): ExternalSub[] {
  const info = (vodInfo?.info || {}) as Record<string, unknown>
  const raw = (info.subtitles ?? info.subtitle ?? []) as unknown
  const list = Array.isArray(raw) ? raw : [raw]
  const out: ExternalSub[] = []

  list.forEach((entry, i) => {
    if (!entry) return
    const obj = entry as Record<string, unknown>
    const url =
      typeof entry === 'string'
        ? entry
        : (obj.url as string) || (obj.file as string) || (obj.src as string) || (obj.link as string)
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return

    const label =
      (typeof entry === 'object' &&
        ((obj.label as string) || (obj.lang as string) || (obj.language as string) || (obj.name as string))) ||
      `Sous-titres ${i + 1}`
    const lang =
      typeof entry === 'object' ? ((obj.lang as string) || (obj.language as string)) : undefined

    out.push({ url, label: String(label), lang: lang ? String(lang) : undefined })
  })

  return out
}

/** Attach an external subtitle file to a <video>, converting SRT→VTT if needed. */
export async function attachSubtitle(video: HTMLVideoElement, sub: ExternalSub): Promise<void> {
  let src = sub.url
  try {
    if (/\.srt(\?|$)/i.test(sub.url)) {
      const text = await (await fetch(sub.url)).text()
      const blob = new Blob([srtToVtt(text)], { type: 'text/vtt' })
      src = URL.createObjectURL(blob)
    }
    const track = document.createElement('track')
    track.kind = 'subtitles'
    track.label = sub.label
    if (sub.lang) track.srclang = sub.lang
    track.src = src
    video.appendChild(track)
  } catch {
    /* a failed subtitle shouldn't break playback */
  }
}

// ---- Embedded text-subtitle engine (Films/Séries) ----------------------------
// The proxy extracts a chosen text subtitle track as WebVTT, streamed from a
// given position. We parse those cues into REAL (absolute) timestamps and cache
// them per (src, track). The <video> timeline is rebased to 0 at every reload
// (seek / audio-track change), so cues are rendered into a script-created
// TextTrack shifted by the current rebase offset. Because cues are cached, an
// audio-track change re-shows them INSTANTLY (no ffmpeg restart, no race), they
// reliably appear (a fully-owned TextTrack, not a streamed <track> we poll), and
// they show in the PiP window because the track is properly "showing".

interface Cue {
  start: number // real seconds
  end: number
  text: string
}

const cueCache = new Map<string, Cue[]>()
const coveredFrom = new Map<string, number>() // we hold cues from this real sec → EOF
const activeStream = new Map<string, AbortController & { from: number }>()
const emitters = new Map<string, Set<(c: Cue) => void>>()
const MANAGED_TRACK_LABEL = 'IPTV Flow'
const GHOST_SWEEP_DELAYS = [0, 150, 500]

function subKey(src: string, rel: number): string {
  return `${src}::${rel}`
}

function parseTs(s: string): number {
  let sec = 0
  for (const p of s.trim().replace(',', '.').split(':')) sec = sec * 60 + parseFloat(p)
  return Number.isFinite(sec) ? sec : 0
}

function parseCueBlock(block: string, from: number): Cue | null {
  const lines = block.split('\n')
  const i = lines.findIndex((l) => l.includes('-->'))
  if (i < 0) return null
  const [a, b] = lines[i].split('-->')
  if (!a || !b) return null
  const start = parseTs(a) + from
  const end = parseTs(b.trim().split(/\s+/)[0]) + from
  const text = lines.slice(i + 1).join('\n').trim()
  if (!text || end <= start) return null
  return { start, end, text }
}

function cachedCues(src: string, rel: number): Cue[] {
  return cueCache.get(subKey(src, rel)) || []
}

/** Stream the WebVTT for a track from `from` (sec) to EOF, caching cues and
 * notifying display subscribers. No-op if an active or completed stream already
 * covers `from`, so seeking forward / switching audio never re-extracts. */
async function fillCues(src: string, rel: number, from: number): Promise<void> {
  const k = subKey(src, rel)
  const active = activeStream.get(k)
  if (active && active.from <= from + 0.5) return // a running stream already covers this
  const done = coveredFrom.get(k)
  if (done != null && from >= done - 0.5) return // cached down to EOF from here already
  active?.abort()
  const ctrl = Object.assign(new AbortController(), { from })
  activeStream.set(k, ctrl)
  let cues = cueCache.get(k)
  if (!cues) {
    cues = []
    cueCache.set(k, cues)
  }
  const seen = new Set(cues.map((c) => Math.round(c.start * 1000)))
  try {
    const res = await fetch(subtitleUrl(src, rel, from), { signal: ctrl.signal })
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const drain = (): void => {
      let j: number
      while ((j = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, j)
        buf = buf.slice(j + 2)
        const c = parseCueBlock(block, from)
        if (!c) continue
        const id = Math.round(c.start * 1000)
        if (seen.has(id)) continue
        seen.add(id)
        cues!.push(c)
        emitters.get(k)?.forEach((fn) => fn(c))
      }
    }
    for (;;) {
      const { value, done: d } = await reader.read()
      if (d) break
      buf += dec.decode(value, { stream: true }).replace(/\r/g, '')
      drain()
    }
    buf += '\n\n'
    drain()
    const prev = coveredFrom.get(k)
    coveredFrom.set(k, Math.min(prev ?? Infinity, from)) // reached EOF → covered from here
  } catch {
    /* aborted or network error — leave coverage unset so a later show can retry */
  } finally {
    if (activeStream.get(k) === ctrl) activeStream.delete(k)
  }
}

// One on-screen subtitle subscription at a time.
// Uses a native <track> element with a Blob VTT URL so cues propagate to the
// Electron PiP window (script-created addTextTrack() tracks do not).
let activeTrackEl: HTMLTrackElement | null = null
let activeTrackVideo: HTMLVideoElement | null = null
let activeBlobUrl: string | null = null
let activeMountKey: string | null = null
let activeMountOffset = 0
let activeEmitFn: ((c: Cue) => void) | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
let lifecycleSeq = 0
let activeGeneration = 0
let subtitleVerticalPosition = 90

function formatVttTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000))
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

function buildVtt(cues: Cue[], offset: number): string {
  const lines: string[] = ['WEBVTT', '']
  let idx = 1
  for (const c of cues) {
    const s = Math.max(0, c.start - offset)
    const e = c.end - offset
    if (e <= 0 || s >= e) continue
    lines.push(String(idx++))
    lines.push(`${formatVttTime(s)} --> ${formatVttTime(e)} line:${subtitleVerticalPosition}%`)
    lines.push(c.text)
    lines.push('')
  }
  return lines.join('\n')
}

function cuesByKey(key: string): Cue[] {
  return cueCache.get(key) || []
}

function diagnosticsEnabled(): boolean {
  return (window as unknown as { host?: { diagnostics?: boolean } }).host?.diagnostics === true
}

function isManagedTextTrack(track: TextTrack): boolean {
  return track.label === MANAGED_TRACK_LABEL
}

function isManagedTrackElement(el: HTMLTrackElement): boolean {
  return el.dataset.iptvFlowSubtitles === '1' || el.label === MANAGED_TRACK_LABEL
}

function textTrackSnapshot(video: HTMLVideoElement): Array<Record<string, unknown>> {
  return Array.from(video.textTracks).map((track, index) => ({
    index,
    label: track.label,
    language: track.language,
    kind: track.kind,
    mode: track.mode,
    managed: isManagedTextTrack(track),
    cueCount: track.cues?.length ?? null,
    activeCueCount: track.activeCues?.length ?? null
  }))
}

function domTrackSnapshot(video: HTMLVideoElement): Array<Record<string, unknown>> {
  return Array.from(video.querySelectorAll('track')).map((el, index) => ({
    index,
    label: el.label,
    kind: el.kind,
    srclang: el.srclang,
    src: el.src,
    readyState: el.readyState,
    mode: el.track.mode,
    managed: isManagedTrackElement(el),
    inDom: el.parentElement === video
  }))
}

function logSubtitleLifecycle(
  event: string,
  video: HTMLVideoElement | null,
  extra: Record<string, unknown> = {}
): void {
  if (!diagnosticsEnabled()) return
  const textTracks = video ? textTrackSnapshot(video) : []
  const domTracks = video ? domTrackSnapshot(video) : []
  const managedShowing = textTracks.filter((track) => track.managed && track.mode === 'showing')
  const anyShowing = textTracks.filter((track) => track.mode === 'showing')
  console.log(JSON.stringify({
    tag: 'IPTV_FLOW_DIAG',
    event: `subtitles:${event}`,
    at: Date.now(),
    generation: activeGeneration,
    currentTime: video?.currentTime ?? null,
    activeMountKey,
    activeMountOffset,
    activeBlobUrl,
    textTrackCount: textTracks.length,
    domTrackCount: domTracks.length,
    showingTextTrackCount: anyShowing.length,
    managedShowingTextTrackCount: managedShowing.length,
    textTracks,
    domTracks,
    ...extra
  }))
}

export function debugSubtitleLifecycle(
  video: HTMLVideoElement | null,
  event: string,
  extra: Record<string, unknown> = {}
): void {
  logSubtitleLifecycle(event, video, extra)
}

function nextGeneration(): number {
  activeGeneration = ++lifecycleSeq
  return activeGeneration
}

function disableManagedTextTracks(video: HTMLVideoElement, keep?: TextTrack): void {
  for (const track of Array.from(video.textTracks)) {
    if (track !== keep && isManagedTextTrack(track)) track.mode = 'disabled'
  }
}

function disableAllTextTracks(video: HTMLVideoElement, keep?: TextTrack): void {
  for (const track of Array.from(video.textTracks)) {
    if (track !== keep) track.mode = 'disabled'
  }
}

function removeManagedTrackElements(video: HTMLVideoElement, keep?: HTMLTrackElement): void {
  for (const el of Array.from(video.querySelectorAll('track'))) {
    if (el === keep) continue
    if (!isManagedTrackElement(el)) continue
    el.track.mode = 'disabled'
    video.removeChild(el)
  }
  disableManagedTextTracks(video, keep?.track)
}

function sweepTracks(
  video: HTMLVideoElement,
  keep: HTMLTrackElement | null,
  generation: number,
  reason: string,
  disableAll = false
): void {
  if (generation !== activeGeneration) return
  if (disableAll) disableAllTextTracks(video, keep?.track)
  else disableManagedTextTracks(video, keep?.track)
  removeManagedTrackElements(video, keep ?? undefined)
  logSubtitleLifecycle('sweep', video, {
    reason,
    disableAll,
    keepLabel: keep?.label ?? null,
    keepSrc: keep?.src ?? null
  })
}

function queueGhostSweeps(
  video: HTMLVideoElement,
  keep: HTMLTrackElement | null,
  generation: number,
  reason: string,
  disableAll = false
): void {
  sweepTracks(video, keep, generation, reason, disableAll)
  for (const delay of GHOST_SWEEP_DELAYS) {
    window.setTimeout(() => {
      sweepTracks(video, keep, generation, `${reason}:delay-${delay}`, disableAll)
    }, delay)
  }
}

function clearTrackNow(
  video: HTMLVideoElement,
  generation: number,
  reason: string,
  disableAll = false
): void {
  sweepTracks(video, null, generation, reason, disableAll)
}

function applyTrackNow(generation = activeGeneration, reason = 'applyTrackNow'): void {
  if (generation !== activeGeneration) return
  if (rebuildTimer) rebuildTimer = null
  const video = activeTrackVideo
  const key = activeMountKey
  if (!video || !key) return

  const vtt = buildVtt(cuesByKey(key), activeMountOffset)

  if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null }
  removeManagedTrackElements(video)
  logSubtitleLifecycle('apply:before-append', video, { reason, key, offset: activeMountOffset })

  const blob = new Blob([vtt], { type: 'text/vtt' })
  activeBlobUrl = URL.createObjectURL(blob)

  const el = document.createElement('track')
  el.kind = 'subtitles'
  el.label = MANAGED_TRACK_LABEL
  el.srclang = 'und'
  el.dataset.iptvFlowSubtitles = '1'
  el.src = activeBlobUrl
  video.appendChild(el)
  activeTrackEl = el

  // Blob URLs are already in memory — activate immediately instead of waiting
  // for the load event (which sometimes doesn't fire in Electron/Chromium).
  // Reapply after 100 ms in case Chromium resets mode during async track init.
  const activate = (phase: string): void => {
    if (generation !== activeGeneration || activeTrackEl !== el || el.parentElement !== video) return
    el.track.mode = 'showing'
    disableAllTextTracks(video, el.track)
    removeManagedTrackElements(video, el)
    logSubtitleLifecycle('activate', video, {
      reason,
      phase,
      key,
      offset: activeMountOffset,
      blobSrc: el.src,
      readyState: el.readyState
    })
  }
  el.onload = (): void => activate('load')
  el.onerror = (): void => logSubtitleLifecycle('track-error', video, { reason, key, src: el.src, readyState: el.readyState })
  activate('sync')
  window.setTimeout(() => activate('delay-100'), 100)
  window.setTimeout(() => queueGhostSweeps(video, el, generation, `${reason}:post-append`, false), 250)
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  const generation = activeGeneration
  rebuildTimer = setTimeout(() => applyTrackNow(generation, 'scheduleRebuild'), 80)
}

function resetTrack(video = activeTrackVideo, reason = 'resetTrack', disableAll = false): number {
  const generation = nextGeneration()
  if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null }
  if (activeEmitFn && activeMountKey) {
    emitters.get(activeMountKey)?.delete(activeEmitFn)
    activeEmitFn = null
  }
  if (video) clearTrackNow(video, generation, reason, disableAll)
  activeTrackEl = null
  activeTrackVideo = null
  if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null }
  activeMountKey = null
  activeMountOffset = 0
  logSubtitleLifecycle('reset', video, { reason, disableAll })
  return generation
}

function prepareMount(
  video: HTMLVideoElement,
  key: string,
  offset: number,
  reason: string,
  extra: Record<string, unknown> = {}
): number {
  const generation = resetTrack(video, `${reason}:prepare`, false)
  activeTrackVideo = video
  activeMountKey = key
  activeMountOffset = offset
  logSubtitleLifecycle('mount:prepare', video, { reason, key, offset, generation, ...extra })
  return generation
}

function completePreparedMount(
  video: HTMLVideoElement,
  key: string,
  offset: number,
  generation: number,
  reason: string,
  extra: Record<string, unknown> = {}
): void {
  if (generation !== activeGeneration || activeTrackVideo !== video || activeMountKey !== key) {
    logSubtitleLifecycle('mount:stale-callback', video, { reason, key, offset, generation, ...extra })
    return
  }
  activeMountOffset = offset
  const fn = (_c: Cue): void => { scheduleRebuild() }
  let set = emitters.get(key)
  if (!set) { set = new Set(); emitters.set(key, set) }
  set.add(fn)
  activeEmitFn = fn
  applyTrackNow(generation, reason)
}

/** Render the cues cached under `key` into a native <track> element (Blob VTT),
 * shifted so real second `offset` maps to currentTime 0. Subscribe for cues that
 * stream in later — they trigger a debounced rebuild of the blob. Shared by the
 * embedded-extraction path and the sidecar-file path. */
function mount(video: HTMLVideoElement, key: string, offset: number): void {
  if (
    activeTrackVideo === video &&
    activeMountKey === key &&
    Math.abs(activeMountOffset - offset) < 0.01 &&
    activeTrackEl?.parentElement === video
  ) {
    activeTrackEl.track.mode = 'showing'
    disableAllTextTracks(video, activeTrackEl.track)
    queueGhostSweeps(video, activeTrackEl, activeGeneration, 'mount:idempotent', false)
    logSubtitleLifecycle('mount:idempotent', video, { key, offset })
    return
  }

  const generation = prepareMount(video, key, offset, 'mount')
  completePreparedMount(video, key, offset, generation, 'mount')
}

/** Show subtitle track `rel` of `src`. The <video> timeline is currently rebased
 * so real second `offset` maps to currentTime 0. Cached cues appear instantly;
 * any not-yet-extracted ones stream in. Call again (new offset) after a seek or
 * audio-track change — it re-times from cache with no flicker or refetch. */
export function showSubtitles(
  video: HTMLVideoElement,
  src: string,
  rel: number,
  offset: number,
  from = offset
): void {
  logSubtitleLifecycle('showSubtitles:request', video, { src, rel, offset, from, key: subKey(src, rel) })
  mount(video, subKey(src, rel), offset)
  void fillCues(src, rel, from)
}

// ---- Sidecar text subs (local .srt/.vtt) — zero re-encode --------------------
// A sidecar .srt/.vtt is read by the main process as WebVTT (absolute cue times)
// and parsed once into cues, then rendered through the same offset-rebasing
// track as above. Because nothing is burned into the video, the stream stays on
// the light `-c:v copy` remux path — switching the sub on/off needs no reload at
// all, and a seek keeps the fast path instead of re-encoding 4K.

function fileKey(path: string): string {
  return `file::${path}`
}

/** True for sidecar formats we render as a text track (vs. burn-in for .ass). */
export function isTextSidecar(path: string): boolean {
  return /\.(srt|vtt)$/i.test(path)
}

function readSidecar(path: string): Promise<string> {
  const fn = (window as unknown as { host?: { t7?: { readSubtitle?: (p: string) => Promise<string> } } }).host?.t7
    ?.readSubtitle
  return fn ? fn(path) : Promise.resolve('')
}

function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = []
  for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    const c = parseCueBlock(block, 0) // sidecar times are already absolute
    if (c) cues.push(c)
  }
  return cues
}

async function ensureSidecarCues(path: string): Promise<void> {
  const key = fileKey(path)
  if (cueCache.has(key)) return
  const vtt = await readSidecar(path)
  cueCache.set(key, vtt ? parseVtt(vtt) : [])
}

/** Show a sidecar .srt/.vtt as a text track, rebased so real second `offset`
 * maps to currentTime 0. Re-call after a seek/audio change with the new offset;
 * cues are cached so it re-times instantly. */
export function showSidecarSubtitles(
  video: HTMLVideoElement,
  path: string,
  offset: number
): Promise<void> {
  const key = fileKey(path)
  if (cueCache.has(key)) {
    logSubtitleLifecycle('showSidecarSubtitles:request', video, { path, offset, key, cached: true })
    mount(video, key, offset)
    return Promise.resolve()
  }
  const generation = prepareMount(video, key, offset, 'showSidecarSubtitles:pending', { path, cached: false })
  return ensureSidecarCues(path)
    .then(() => {
      completePreparedMount(video, key, offset, generation, 'showSidecarSubtitles:ready', { path })
    })
    .catch(() => {
      if (generation === activeGeneration) resetTrack(video, 'showSidecarSubtitles:error', true)
    })
}

/** Force-rebuild the current subtitle track — call when entering PiP to ensure
 * the track is visible in the new rendering context. No-op when no track is active. */
export function refreshSubtitleTrack(): void {
  logSubtitleLifecycle('refreshSubtitleTrack', activeTrackVideo, { active: !!activeMountKey })
  if (activeMountKey) scheduleRebuild()
}

/** Move managed text subtitles without reloading the direct video. */
export function setSubtitleVerticalPosition(position: number): void {
  subtitleVerticalPosition = Math.max(5, Math.min(95, Math.round(position)))
  if (activeMountKey) scheduleRebuild()
}

/** Hide on-screen subtitles, keeping cached cues and any in-flight extraction so
 * a later re-show is instant. */
export function hideSubtitles(video?: HTMLVideoElement | null): void {
  const target = video ?? activeTrackVideo
  const generation = resetTrack(target, 'hideSubtitles', true)
  if (target) queueGhostSweeps(target, null, generation, 'hideSubtitles:settle', true)
}

/** Hide subtitles and stop background extraction — used when leaving a title. */
export function closeSubtitles(video?: HTMLVideoElement | null): void {
  hideSubtitles(video ?? activeTrackVideo)
  for (const ctrl of activeStream.values()) ctrl.abort()
  activeStream.clear()
  logSubtitleLifecycle('closeSubtitles', video ?? activeTrackVideo, { activeStreamCount: activeStream.size })
}

/** Pre-read a sidecar .srt/.vtt into the cache without mounting it.
 * Call when a media item starts so the first subtitle selection is instant. */
export function prefetchSidecarCues(path: string): void {
  if (isTextSidecar(path)) void ensureSidecarCues(path)
}
