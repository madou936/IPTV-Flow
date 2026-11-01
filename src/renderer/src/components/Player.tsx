import { useEffect, useRef, useState } from 'react'
import type { AudioTrack, LocalSub, MediaTarget, MediaQueueItem, SubTrack } from '../types'
import { bitmapSubtitleUrl, companionAudioUrl, enterPip, exitPip, focusWindow, hostPlatform, listCastDevices, localFileUrl, movePipWindow, openCastSettings, pickSubtitleFile, playOnCastDevice, probeTracks, proxyUrl, startLocalCast, thumbnailUrl } from '../lib/proxy'
import type { CastDevice, VideoInfo } from '../lib/proxy'
import { closeSubtitles, debugSubtitleLifecycle, hideSubtitles, isTextSidecar, prefetchSidecarCues, refreshSubtitleTrack, setSubtitleVerticalPosition, showSidecarSubtitles, showSubtitles } from '../lib/subtitles'
import { getProgress, markCompleted, setProgress } from '../lib/progress'
import { canDirectPlayVideoCodec, canUseDirectLocalVideo, needsCompanionAudio } from '../../../shared/playbackPolicy'
import SubtitleSearchModal from './SubtitleSearchModal'

interface Props {
  media: MediaTarget
  onClose: () => void
}

const AUDIO_PREFS_KEY = 'iptv_audio_prefs'
const SUBTITLE_PREFS_KEY = 'iptv_subtitle_prefs'
const AUTO_FRENCH_SUBTITLES_KEY = 'iptv_auto_french_subtitles'
const COMPANION_AUDIO_START_LEAD = 0.055
const COMPANION_AUDIO_CONTENT_DELAY = 0
const COMPANION_AUDIO_PRIME_VOLUME = 0.001

const pipIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="4" width="18" height="15" rx="2" />
    <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
  </svg>
)
const castIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <path d="M2 18v3h3c0-1.66-1.34-3-3-3Zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7Zm0-4v2c5.52 0 10 4.48 10 10h2c0-6.63-5.37-12-12-12Zm18-5H4c-1.1 0-2 .9-2 2v3h2V7h16v12h-6v2h6c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2Z" />
  </svg>
)
const audioIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 9v6M8 6v12M12 10v4M16 7v10M20 9v6" strokeLinecap="round" />
  </svg>
)
const nextIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
    <path d="M6 5l9 7-9 7z" />
    <rect x="16" y="5" width="2.4" height="14" rx="1" />
  </svg>
)
const prevIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
    <path d="m18 5-9 7 9 7z" />
    <rect x="5.6" y="5" width="2.4" height="14" rx="1" />
  </svg>
)
// Circular arrow wrapped around "10" — rewind 10s.
const back10Icon = (
  <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    <text x="12.3" y="15.2" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" textAnchor="middle">10</text>
  </svg>
)
// Circular arrow wrapped around "10" — forward 10s.
const fwd10Icon = (
  <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    <text x="11.7" y="15.2" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" textAnchor="middle">10</text>
  </svg>
)
const volumeOnIcon = (
  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 3 9 3 15 6 15 11 19 11 5" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
)
const volumeOffIcon = (
  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 3 9 3 15 6 15 11 19 11 5" />
    <line x1="15" y1="9" x2="21" y2="15" />
    <line x1="21" y1="9" x2="15" y2="15" />
  </svg>
)
const fullscreenEnterIcon = (
  <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor">
    <path d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z" />
  </svg>
)
const fullscreenExitIcon = (
  <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor">
    <path d="M10 4v2H6v4H4V4h6Zm4 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z" />
  </svg>
)
const closeIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
)
const queueIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 10h12v8H3zM6 7h12v8M9 4h12v8" />
  </svg>
)

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = m.toString().padStart(2, '0')
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function audioLabel(t: AudioTrack): string {
  const main = (t.lang || `Piste ${t.rel + 1}`).toUpperCase()
  return `${main}${t.title ? ` · ${t.title}` : ''} (${t.codec})`
}
function subLabel(t: SubTrack): string {
  const main = (t.lang || `Piste ${t.rel + 1}`).toUpperCase()
  return `${main}${t.title ? ` · ${t.title}` : ''}${t.bitmap ? ' (image)' : ''}`
}

function normalizeAudioText(value?: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function audioPrefSignature(track: AudioTrack): string {
  return [
    normalizeAudioText(track.lang),
    normalizeAudioText(track.title),
    normalizeAudioText(track.codec)
  ].join('|')
}

function readAudioPrefs(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_KEY)
    return raw ? JSON.parse(raw) as Record<string, string> : {}
  } catch {
    return {}
  }
}

function getSavedAudioPref(key?: string): string | null {
  if (!key) return null
  return readAudioPrefs()[key] || null
}

function setSavedAudioPref(key: string | undefined, track: AudioTrack): void {
  if (!key) return
  const next = readAudioPrefs()
  next[key] = audioPrefSignature(track)
  try {
    localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

function subtitlePrefSignature(track: SubTrack): string {
  return [track.lang, track.title, track.codec, track.bitmap ? 'bitmap' : 'text']
    .map(normalizeTrackText)
    .join('|')
}

function readSubtitlePrefs(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SUBTITLE_PREFS_KEY)
    return raw ? JSON.parse(raw) as Record<string, string> : {}
  } catch {
    return {}
  }
}

function getSavedSubtitlePref(key?: string): string | null {
  return key ? readSubtitlePrefs()[key] || null : null
}

function setSavedSubtitlePref(key: string | undefined, track: SubTrack): void {
  if (!key) return
  const next = readSubtitlePrefs()
  next[key] = subtitlePrefSignature(track)
  try {
    localStorage.setItem(SUBTITLE_PREFS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

function autoFrenchSubtitlesEnabled(): boolean {
  return localStorage.getItem(AUTO_FRENCH_SUBTITLES_KEY) !== '0'
}

function isRemote(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

function getNativeAudioTracks(video: HTMLVideoElement): Array<{ enabled: boolean }> {
  const nativeTracks = (video as HTMLVideoElement & {
    audioTracks?: ArrayLike<{ enabled: boolean }>
  }).audioTracks
  return nativeTracks ? Array.from(nativeTracks) : []
}

function getNativeTextTracks(video: HTMLVideoElement): TextTrack[] {
  return Array.from(video.textTracks ?? [])
}

function normalizeTrackText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function frenchSubtitleScore(track: SubTrack): number {
  const lang = normalizeTrackText(track.lang)
  const title = normalizeTrackText(track.title)
  const text = `${lang} ${title}`.trim()
  // Only these explicit French markers qualify for automatic selection. In
  // particular, do not treat generic "vf", "fra" or a language prefix as
  // French: the user asked for a deliberately narrow automatic rule.
  const frenchMarker = /\b(?:fre|french|francais|fr|vostfr)\b/
  let score = 0
  if (!frenchMarker.test(text)) return 0
  if (lang === 'fr' || lang === 'fre') score += 120
  if (/\bvostfr\b/.test(text)) score += 112
  if (/\bfrench\b|\bfrancais\b/.test(text)) score = Math.max(score, 100)
  if (/\bfr\b/.test(lang)) score = Math.max(score, 96)
  if (!track.bitmap) score += 6
  return score
}

function findPreferredFrenchSubtitle(tracks: SubTrack[]): SubTrack | null {
  let best: SubTrack | null = null
  let bestScore = 0
  for (const track of tracks) {
    const score = frenchSubtitleScore(track)
    if (score > bestScore) {
      best = track
      bestScore = score
    }
  }
  return best
}

function pickInitialSubtitleTrack(tracks: SubTrack[], prefKey?: string): SubTrack | null {
  const savedTrack = findSavedSubtitleTrack(tracks, prefKey)
  if (savedTrack) return savedTrack
  return autoFrenchSubtitlesEnabled() ? findPreferredFrenchSubtitle(tracks) : null
}

function findSavedSubtitleTrack(tracks: SubTrack[], prefKey?: string): SubTrack | null {
  const savedSubtitle = getSavedSubtitlePref(prefKey)
  return savedSubtitle
    ? tracks.find((track) => subtitlePrefSignature(track) === savedSubtitle) ?? null
    : null
}

function diagnosticsEnabled(): boolean {
  return (window as unknown as { host?: { diagnostics?: boolean } }).host?.diagnostics === true
}

function rangesToPairs(ranges: TimeRanges): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < ranges.length; i++) out.push([ranges.start(i), ranges.end(i)])
  return out
}

export default function Player({ media, onClose }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const docPipWinRef = useRef<Window | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const seekPreviewVideoRef = useRef<HTMLVideoElement>(null)
  const seekPreviewCanvasRef = useRef<HTMLCanvasElement>(null)
  const seekPreviewRequestRef = useRef<(time: number) => void>(() => undefined)
  const seekPreviewTargetRef = useRef<number | null>(null)
  const companionAudioRef = useRef<HTMLAudioElement>(null)
  const bitmapSubtitleRef = useRef<HTMLVideoElement>(null)
  const companionAudioBaseRef = useRef(0)
  const bitmapSubtitleBaseRef = useRef(0)
  const companionAudioTrackRef = useRef(-1)
  const bitmapSubtitleTrackRef = useRef(-1)
  const companionAudioActiveRef = useRef(false)
  const bitmapSubtitleActiveRef = useRef(false)
  const logicalMutedRef = useRef(false)
  const baseOffset = useRef(0)
  const audioRef = useRef(0)
  const subRef = useRef(-1)
  const subBitmapRef = useRef(false)
  const subPathRef = useRef('')
  // Active sidecar .srt/.vtt rendered as a text track (no burn-in) — re-shown,
  // rebased, after every reload so seeks keep the light copy path.
  const localTextSubRef = useRef('')
  const durRef = useRef(0)
  const lastSave = useRef(0)
  const clickTimer = useRef<number>()
  const hideTimer = useRef<number>()
  const subSyncRef = useRef(0)
  // Physical key code that produces "z" on the user's layout (KeyZ on QWERTY,
  // KeyW on AZERTY, …). Detected via the Keyboard Map API so Option+Z works
  // regardless of layout.
  const pipKeyCode = useRef<string>('KeyZ')
  // Mirror of the `pip` state accessible inside stale closures (key handlers,
  // close()) without adding pip to every useEffect dependency array.
  const pipRef = useRef(false)
  const pipDraggedRef = useRef(false)
  const playbackModeRef = useRef<'proxy' | 'direct'>('proxy')
  const directFallbackTriedRef = useRef(false)
  const audioPrefAppliedRef = useRef(false)
  const audioTracksRef = useRef<AudioTrack[]>([])
  const subTracksRef = useRef<SubTrack[]>([])
  const videoInfoRef = useRef<VideoInfo | null>(null)
  const audioClockRef = useRef<AudioContext | null>(null)
  const lastDiagTimeRef = useRef(0)
  const pendingSkipRef = useRef<{ target: number; shouldPlay: boolean; timer: number | null } | null>(null)
  // A source reload can clear TextTracks after their first mount. This token
  // ensures only the latest requested subtitle track is attached again once
  // Chromium has finished preparing the video element.
  const subtitleMountRequestRef = useRef(0)

  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [pip, setPip] = useState(false)
  const [menu, setMenu] = useState<'none' | 'audio' | 'sub' | 'cast'>('none')
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([])
  const [subTracks, setSubTracks] = useState<SubTrack[]>([])
  const [audioRel, setAudioRel] = useState(0)
  const [subRel, setSubRel] = useState(-1)
  const [localSubActive, setLocalSubActive] = useState<string | null>(null)
  const [uploadedSubs, setUploadedSubs] = useState<LocalSub[]>([])
  const [showSubSearch, setShowSubSearch] = useState(false)
  const [subSync, setSubSync] = useState(0)
  const [subVertical, setSubVertical] = useState(90)
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [showSpeed, setShowSpeed] = useState(false)
  const [showQueue, setShowQueue] = useState(false)
  const [queueViewGroupIndex, setQueueViewGroupIndex] = useState(media.queueGroupIndex ?? 0)
  const [duration, setDuration] = useState<number | undefined>(undefined)
  const [cur, setCur] = useState(0)
  const [seekDraft, setSeekDraft] = useState<number | null>(null)
  const [seekHover, setSeekHover] = useState<{ time: number; ratio: number } | null>(null)
  const [thumbnailSecond, setThumbnailSecond] = useState<number | null>(null)
  const [localPreviewReady, setLocalPreviewReady] = useState(false)
  const [resumePrompt, setResumePrompt] = useState<number | null>(null)
  const [controlsVisible, setBarVisible] = useState(true)
  const [playbackMode, setPlaybackMode] = useState<'proxy' | 'direct'>('proxy')
  const [playbackRate, setPlaybackRate] = useState(1)
  const [castNotice, setCastNotice] = useState<string | null>(null)
  const [castDevices, setCastDevices] = useState<CastDevice[]>([])
  const [castBusy, setCastBusy] = useState(false)
  const [castBurnSubtitles, setCastBurnSubtitles] = useState(false)
  const castNoticeTimer = useRef<number | null>(null)
  const canCast = hostPlatform() === 'darwin'

  function audioClockTime(): number | null {
    if (!diagnosticsEnabled()) return null
    try {
      if (!audioClockRef.current) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctx) return null
        audioClockRef.current = new Ctx()
      }
      return audioClockRef.current.currentTime
    } catch {
      return null
    }
  }

  function mediaCanSeekTo(element: HTMLMediaElement, time: number): boolean {
    for (let i = 0; i < element.seekable.length; i++) {
      if (time >= element.seekable.start(i) && time <= element.seekable.end(i)) return true
    }
    return false
  }

  function diag(event: string, extra: Record<string, unknown> = {}): void {
    if (!diagnosticsEnabled()) return
    const video = videoRef.current
    const audio = companionAudioRef.current
    const overlay = bitmapSubtitleRef.current
    console.log(JSON.stringify({
      tag: 'IPTV_FLOW_DIAG',
      event,
      at: Date.now(),
      mediaTitle: media.title,
      mode: playbackModeRef.current,
      baseOffset: baseOffset.current,
      logicalTime: video ? baseOffset.current + video.currentTime : baseOffset.current,
      video: video ? {
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        ended: video.ended,
        readyState: video.readyState,
        networkState: video.networkState,
        playbackRate: video.playbackRate,
        buffered: rangesToPairs(video.buffered),
        seekable: rangesToPairs(video.seekable),
        currentSrc: video.currentSrc
      } : null,
      audioClock: audioClockTime(),
      companionDelta: video && audio && companionAudioActiveRef.current
        ? audio.currentTime - video.currentTime
        : null,
      companionContentDelta: video && audio && companionAudioActiveRef.current
        ? audio.currentTime - video.currentTime - COMPANION_AUDIO_CONTENT_DELAY
        : null,
      companionAudio: audio ? {
        active: companionAudioActiveRef.current,
        currentTime: audio.currentTime,
        duration: audio.duration,
        paused: audio.paused,
        readyState: audio.readyState,
        networkState: audio.networkState
      } : null,
      bitmapSubtitle: overlay ? {
        active: bitmapSubtitleActiveRef.current,
        currentTime: overlay.currentTime,
        readyState: overlay.readyState
      } : null,
      ...extra
    }))
  }

  useEffect(() => {
    durRef.current = duration || 0
  }, [duration])

  useEffect(() => {
    setQueueViewGroupIndex(media.queueGroupIndex ?? 0)
  }, [media])

  // Auto-hide the top bar after 3.5 s of mouse inactivity.
  // In PiP mode: no timer — controls show on mouse-enter, hide on mouse-leave.
  function wakeBar(): void {
    setBarVisible(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    if (pipRef.current) return
    hideTimer.current = window.setTimeout(() => {
      const hasOpenMenu = !!document.querySelector('.sub-menu')
      if (!hasOpenMenu) setBarVisible(false)
    }, 3500)
  }

  useEffect(() => {
    wakeBar()
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Detect which physical key produces "z" on this keyboard layout.
  useEffect(() => {
    const nav = navigator as Navigator & {
      keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> }
    }
    nav.keyboard
      ?.getLayoutMap?.()
      .then((map) => {
        for (const [code, key] of map) {
          if (key.toLowerCase() === 'z') {
            pipKeyCode.current = code
            break
          }
        }
      })
      .catch(() => undefined)
  }, [])

  function persist(): void {
    const video = videoRef.current
    if (video && media.resumeKey && !media.isLive) {
      const nativeDur = Number.isFinite(video.duration) && video.duration > 0 ? baseOffset.current + video.duration : 0
      const effectiveDur = durRef.current > 0 ? durRef.current : nativeDur
      const effectivePos = baseOffset.current + video.currentTime
      if (video.ended) {
        markCompleted(media.resumeKey, effectiveDur)
      } else {
        setProgress(media.resumeKey, effectivePos, effectiveDur)
      }
    }
  }

  function stopCompanionAudio(): void {
    companionAudioActiveRef.current = false
    companionAudioTrackRef.current = -1
    const audio = companionAudioRef.current
    if (audio) {
      audio.pause()
      audio.volume = 1
      audio.removeAttribute('src')
      audio.load()
    }
    if (videoRef.current) videoRef.current.muted = logicalMutedRef.current
  }

  function stopBitmapSubtitle(): void {
    bitmapSubtitleActiveRef.current = false
    bitmapSubtitleTrackRef.current = -1
    const overlay = bitmapSubtitleRef.current
    if (overlay) {
      overlay.pause()
      overlay.removeAttribute('src')
      overlay.load()
    }
  }

  function syncCompanionAudio(video: HTMLVideoElement, force = false): void {
    const audio = companionAudioRef.current
    if (!companionAudioActiveRef.current || !audio || audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    const desired = Math.max(0, video.currentTime - companionAudioBaseRef.current)
    if ((force || Math.abs(audio.currentTime - desired) > 0.04) && mediaCanSeekTo(audio, desired)) {
      try { audio.currentTime = desired } catch { /* the stream may still be seeking */ }
    }
    audio.playbackRate = video.playbackRate || playbackRate
    if (!video.paused && audio.paused) void audio.play().catch(() => undefined)
  }

  function startCompanionAudio(video: HTMLVideoElement, rel: number, start: number): void {
    const audio = companionAudioRef.current
    if (!audio) return
    if (companionAudioActiveRef.current && companionAudioTrackRef.current === rel && Math.abs(companionAudioBaseRef.current - start) < 0.25) {
      video.muted = true
      const desired = Math.max(0, video.currentTime - companionAudioBaseRef.current)
      if (Math.abs(audio.currentTime - desired) > 0.08 && mediaCanSeekTo(audio, desired)) {
        try { audio.currentTime = desired } catch { /* stream not seekable yet */ }
      }
      if (!video.paused && audio.paused) void audio.play().catch(() => undefined)
      return
    }
    const resumeAfterReady = !video.paused
    video.pause()
    companionAudioActiveRef.current = true
    companionAudioTrackRef.current = rel
    companionAudioBaseRef.current = Math.max(0, start)
    video.muted = true
    const url = companionAudioUrl(media.src, rel, companionAudioBaseRef.current)
    audio.pause()
    audio.src = url
    const shouldPrime = resumeAfterReady || !video.paused
    audio.muted = logicalMutedRef.current
    audio.volume = shouldPrime && !logicalMutedRef.current ? COMPANION_AUDIO_PRIME_VOLUME : 1
    audio.playbackRate = playbackRate
    audio.load()
    audio.addEventListener('canplay', () => {
      if (audio.src !== url) return
      const desired = Math.max(0, video.currentTime - companionAudioBaseRef.current)
      if (Math.abs(audio.currentTime - desired) > 0.08 && mediaCanSeekTo(audio, desired)) {
        try { audio.currentTime = desired } catch { /* stream not seekable yet */ }
      }
      if (shouldPrime) {
        void audio.play()
          .then(() => {
            const deadline = performance.now() + 450
            const resumeVideo = (): void => {
              if (audio.src !== url) return
              if (audio.currentTime >= COMPANION_AUDIO_START_LEAD || performance.now() >= deadline) {
                audio.volume = 1
                audio.muted = logicalMutedRef.current
                diag('companion:aligned', { audio: rel, videoTime: video.currentTime, companionTime: audio.currentTime, contentDelay: COMPANION_AUDIO_CONTENT_DELAY })
                void video.play().catch(() => undefined)
                return
              }
              window.setTimeout(resumeVideo, 8)
            }
            resumeVideo()
          })
          .catch(() => {
            audio.volume = 1
            audio.muted = logicalMutedRef.current
            void video.play().catch(() => undefined)
          })
      }
    }, { once: true })
  }

  function startBitmapSubtitle(video: HTMLVideoElement, rel: number, start: number): void {
    const overlay = bitmapSubtitleRef.current
    if (!overlay) return
    if (bitmapSubtitleActiveRef.current && bitmapSubtitleTrackRef.current === rel && Math.abs(bitmapSubtitleBaseRef.current - start) < 0.25) return
    bitmapSubtitleActiveRef.current = true
    bitmapSubtitleTrackRef.current = rel
    bitmapSubtitleBaseRef.current = Math.max(0, start)
    const width = videoInfo?.width || video.videoWidth || 1920
    const height = videoInfo?.height || video.videoHeight || 1080
    const url = bitmapSubtitleUrl(media.src, rel, bitmapSubtitleBaseRef.current, width, height)
    overlay.pause()
    overlay.src = url
    overlay.playbackRate = playbackRate
    overlay.load()
    // Do not block the real video on subtitle decoding: the overlay is optional
    // and must never make a direct local file wait for ffmpeg.
    overlay.addEventListener('canplay', () => {
      if (overlay.src === url && !video.paused) void overlay.play().catch(() => undefined)
    }, { once: true })
  }

  function enableRemoteTextSub(t: SubTrack): void {
    const video = videoRef.current
    if (!video) return
    debugSubtitleLifecycle(video, 'player:cc-change:embedded-text', {
      rel: t.rel,
      label: subLabel(t),
      offset: baseOffset.current + subSyncRef.current,
      subSync: subSyncRef.current
    })
    subRef.current = t.rel
    subBitmapRef.current = false
    setSubRel(t.rel)
    setMenu('none')
    setShowInfo(false)
    setShowSpeed(false)
    scheduleTextSubtitleMount(video, t.rel, baseOffset.current)
  }

  function scheduleTextSubtitleMount(video: HTMLVideoElement, rel: number, start: number): void {
    const request = ++subtitleMountRequestRef.current
    const apply = (): void => {
      if (request !== subtitleMountRequestRef.current || subRef.current !== rel || subBitmapRef.current || localTextSubRef.current) return
      const offset = baseOffset.current + subSyncRef.current
      showSubtitles(video, media.src, rel, offset, Math.max(0, start) + subSyncRef.current)
    }

    // First apply immediately for a running title. Then repeat after the
    // asynchronous native track reset caused by a source load: this is what
    // makes the first click/automatic selection visibly apply.
    apply()
    video.addEventListener('loadedmetadata', apply, { once: true })
    video.addEventListener('loadeddata', apply, { once: true })
    video.addEventListener('canplay', apply, { once: true })
    window.setTimeout(apply, 120)
    window.setTimeout(apply, 600)
  }

  function syncDirectTextSubtitle(video: HTMLVideoElement, start: number): void {
    debugSubtitleLifecycle(video, 'player:syncDirectTextSubtitle', {
      start,
      localTextSub: localTextSubRef.current || null,
      subRel: subRef.current,
      subBitmap: subBitmapRef.current,
      offset: baseOffset.current + subSyncRef.current,
      subSync: subSyncRef.current
    })
    if (localTextSubRef.current) {
      void showSidecarSubtitles(video, localTextSubRef.current, subSyncRef.current)
      return
    }
    if (subRef.current >= 0 && !subBitmapRef.current) {
      scheduleTextSubtitleMount(video, subRef.current, Math.max(0, start))
      return
    }
    hideSubtitles(video)
  }

  function disableSubtitles(): void {
    const video = videoRef.current
    debugSubtitleLifecycle(video, 'player:disableSubtitles:before', {
      subRel: subRef.current,
      subBitmap: subBitmapRef.current,
      localTextSub: localTextSubRef.current || null,
      subPath: subPathRef.current || null
    })
    hideSubtitles(video)
    const wasTextOverlay = !!localTextSubRef.current || (subRef.current >= 0 && !subBitmapRef.current)
    subRef.current = -1
    subBitmapRef.current = false
    subtitleMountRequestRef.current++
    setSubRel(-1)
    setLocalSubActive(null)
    localTextSubRef.current = ''
    setMenu('none')
    setShowInfo(false)
    setShowSpeed(false)
    debugSubtitleLifecycle(video, 'player:disableSubtitles:after', {
      wasTextOverlay,
      subRel: subRef.current,
      localTextSub: localTextSubRef.current || null
    })
    // A text sidecar was a pure overlay (nothing burned in) → just hide it, no
    // stream reload (avoids a needless seek/restart).
    if (wasTextOverlay) return
    load({ sub: -1, subBitmap: false, subPath: '' })
  }

  function chooseSubtitle(t: SubTrack, remember = true): void {
    if (remember) setSavedSubtitlePref(media.audioPrefKey, t)
    if (!t.bitmap) {
      enableRemoteTextSub(t)
      return
    }
    // Bitmap (DVB/PGS) subtitles still need the ffmpeg burn-in path.
    debugSubtitleLifecycle(videoRef.current, 'player:cc-change:bitmap', {
      rel: t.rel,
      label: subLabel(t)
    })
    hideSubtitles(videoRef.current)
    setLocalSubActive(null)
    localTextSubRef.current = ''
    subPathRef.current = ''
    load({ sub: t.rel, subBitmap: t.bitmap, subPath: '' })
  }

  function chooseAudio(rel: number, remember = true): void {
    const track = audioTracks.find((entry) => entry.rel === rel)
    if (track && remember && media.audioPrefKey) setSavedAudioPref(media.audioPrefKey, track)
    load({ audio: rel })
  }

  function shouldUseCompanionAudio(audio: number, nativeTrackCount: number): boolean {
    if (!media.local || media.isLive || isRemote(media.src)) return false
    const selectedAudio = audioTracksRef.current.find((track) => track.rel === audio)
    return needsCompanionAudio(selectedAudio?.codec, audio, nativeTrackCount)
  }

  function applyDirectSelections(video: HTMLVideoElement, audio: number, sub: number, start: number): boolean {
    const nativeAudioTracks = getNativeAudioTracks(video)
    const companionAudio = shouldUseCompanionAudio(audio, nativeAudioTracks.length)
    if (companionAudio) {
      nativeAudioTracks.forEach((track) => {
        track.enabled = false
      })
      startCompanionAudio(video, audio, start)
    } else if (nativeAudioTracks.length > 0) {
      if (audio < 0 || audio >= nativeAudioTracks.length) return false
      nativeAudioTracks.forEach((track, index) => {
        track.enabled = index === audio
      })
      stopCompanionAudio()
    } else if (audio !== 0) {
      return false
    } else {
      stopCompanionAudio()
    }

    const nativeTextTracks = getNativeTextTracks(video)
    nativeTextTracks.forEach((track) => {
      track.mode = 'disabled'
    })
    if (sub < 0) {
      stopBitmapSubtitle()
      return true
    }

    const selectedSub = subTracksRef.current.find((track) => track.rel === sub)
    if (!selectedSub) return false
    if (selectedSub.bitmap) {
      // Chromium has no native PGS/DVB decoder. Never overlay an ffmpeg video
      // over a direct movie: its failed alpha plane is the black screen users
      // were seeing. Keep the original movie strictly direct instead.
      stopBitmapSubtitle()
      return true
    }
    stopBitmapSubtitle()
    if (media.local && !isRemote(media.src)) return true
    const textSubIndex = subTracksRef.current
      .filter((track) => !track.bitmap)
      .findIndex((track) => track.rel === sub)
    if (textSubIndex < 0 || textSubIndex >= nativeTextTracks.length) return false
    nativeTextTracks[textSubIndex].mode = 'showing'
    return true
  }

  function canUseDirectPlayback(opts: {
    audio: number
    sub: number
    subBitmap: boolean
    subPath: string
    forceProxy?: boolean
  }): boolean {
    // Chromium cannot render PGS/DVB bitmap captions from a local file. Sending
    // this case through the proxy on the first selection avoids the former
    // "select it twice" behaviour (the first direct attempt showed nothing).
    if (opts.subBitmap) return false
    const info = videoInfoRef.current
    return canUseDirectLocalVideo({
      local: !!media.local,
      live: media.isLive,
      remote: isRemote(media.src),
      forceProxy: opts.forceProxy,
      externalSubtitleNeedsBurnIn: !!opts.subPath && !isTextSidecar(opts.subPath),
      videoCodec: info?.codec,
      videoCodecTag: info?.codecTag,
      videoBitDepth: info?.bitDepth
    })
  }

  function needsProxyVideoTranscode(): boolean {
    const info = videoInfoRef.current
    if (!info || !media.local || media.isLive || isRemote(media.src)) return false
    return !canDirectPlayVideoCodec(info.codec, info.codecTag, info.bitDepth)
  }

  // Sidecar subtitle file (local T7 media). Text formats (.srt/.vtt) render as a
  // zero-cost text track — no reload, no re-encode, so seeking stays fluid.
  // Styled .ass/.ssa keep the burn-in path (libass preserves their styling).
  function chooseLocalSub(sub: LocalSub): void {
    // Detect whether the current stream has a subtitle burned in BEFORE clearing
    // state — switching to a text-overlay sub requires a clean stream reload so
    // the old burned-in sub stops showing alongside the new one.
    const wasOverlay = !!localTextSubRef.current || (isRemote(media.src) && subRef.current >= 0 && !subBitmapRef.current)
    const needsStreamReload = !wasOverlay && (subBitmapRef.current || !!subPathRef.current || (!isRemote(media.src) && subRef.current >= 0))

    debugSubtitleLifecycle(videoRef.current, 'player:cc-change:sidecar:before', {
      path: sub.path,
      ext: sub.ext,
      isText: isTextSidecar(sub.path)
    })
    hideSubtitles(videoRef.current)
    subRef.current = -1
    subBitmapRef.current = false
    subtitleMountRequestRef.current++
    setSubRel(-1)
    setLocalSubActive(sub.path)
    setMenu('none')
    setShowInfo(false)
    setShowSpeed(false)
    const video = videoRef.current
    if (video && isTextSidecar(sub.path)) {
      // Text track: overlay onto the running stream, no ffmpeg restart.
      localTextSubRef.current = sub.path
      subPathRef.current = ''
      if (needsStreamReload) {
        // Previous sub was burned into the stream — reload without it.
        // load() re-applies localTextSubRef.current automatically after reload.
        load({ sub: -1, subBitmap: false, subPath: '' })
        return
      }
      void showSidecarSubtitles(video, sub.path, baseOffset.current + subSyncRef.current)
      return
    }
    localTextSubRef.current = ''
    load({ sub: -1, subBitmap: false, subPath: sub.path })
  }

  async function pickUploadSub(): Promise<void> {
    const path = await pickSubtitleFile()
    if (!path) return
    const name = path.split('/').pop() ?? path
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    const sub: LocalSub = { label: name, path, ext }
    setUploadedSubs((prev) => {
      if (prev.some((s) => s.path === path)) return prev
      return [...prev, sub]
    })
    chooseLocalSub(sub)
  }

  function load(next: {
    audio?: number
    sub?: number
    subBitmap?: boolean
    start?: number
    subPath?: string
    forceProxy?: boolean
    forceVideoTranscode?: boolean
    autoplay?: boolean
  }): void {
    const video = videoRef.current
    if (!video) return
    debugSubtitleLifecycle(video, 'player:load:begin', {
      next,
      currentSubRel: subRef.current,
      currentSubBitmap: subBitmapRef.current,
      currentLocalTextSub: localTextSubRef.current || null,
      currentSubPath: subPathRef.current || null
    })
    const audio = next.audio ?? audioRef.current
    const sub = next.sub ?? subRef.current
    const bitmap = next.subBitmap ?? subBitmapRef.current
    const subPath = next.subPath ?? subPathRef.current
    const start = media.isLive ? 0 : (next.start ?? baseOffset.current + video.currentTime)
    const shouldPlay = next.autoplay ?? true
    const textOverlaySub = sub >= 0 && !bitmap
    const streamSub = textOverlaySub ? -1 : sub
    audioRef.current = audio
    subRef.current = sub
    subBitmapRef.current = bitmap
    subPathRef.current = subPath
    baseOffset.current = Math.max(0, start)
    setAudioRel(audio)
    setSubRel(sub)
    setCur(Math.max(0, start))
    setSeekDraft(null)
    setLoading(true)
    setMenu('none')
    setShowInfo(false)
    setShowSpeed(false)
    setResumePrompt(null)
    const directPlayback = canUseDirectPlayback({
      audio,
      sub,
      subBitmap: bitmap,
      subPath,
      forceProxy: next.forceProxy
    })
    diag('player:load', { start, audio, sub, bitmap, subPath, directPlayback, forceProxy: !!next.forceProxy, forceVideoTranscode: !!next.forceVideoTranscode })

    if (directPlayback && playbackModeRef.current === 'direct' && video.currentSrc) {
      if (!applyDirectSelections(video, audio, sub, start)) {
        load({ audio, sub, subBitmap: bitmap, start, subPath, forceProxy: true })
        return
      }
      baseOffset.current = 0
      video.currentTime = Math.max(0, start)
      syncDirectTextSubtitle(video, start)
      video.playbackRate = playbackRate
      setLoading(false)
      if (shouldPlay) video.play().catch(() => undefined)
      return
    }

    // Fully reset the element before loading the new stream. The ffmpeg output
    // is provably A/V-synced, and a fresh open plays in sync — but reassigning
    // src on an already-playing element (seek / audio-track change) leaves
    // Chromium's audio renderer running ahead of the freshly-restarted video
    // (audio "ahead" by a few seconds, constant). pause()+load() tears the
    // pipeline down so the reload starts as cleanly as a first open.
    video.pause()
    hideSubtitles(video)
    playbackModeRef.current = directPlayback ? 'direct' : 'proxy'
    setPlaybackMode(directPlayback ? 'direct' : 'proxy')
    if (directPlayback) {
      directFallbackTriedRef.current = false
      stopCompanionAudio()
      stopBitmapSubtitle()
      baseOffset.current = 0
      const expectedSrc = localFileUrl(media.src)
      video.src = expectedSrc
      video.load()
      video.playbackRate = playbackRate
      const applyStart = (): void => {
        if (playbackModeRef.current !== 'direct' || video.currentSrc !== expectedSrc) return
        if (start > 0) {
          try {
            video.currentTime = Math.max(0, start)
          } catch {
            /* ignore */
          }
        }
        if (!applyDirectSelections(video, audio, sub, start)) {
          load({ audio, sub, subBitmap: bitmap, start, subPath, forceProxy: true })
          return
        }
        syncDirectTextSubtitle(video, start)
      }
      if (video.readyState >= 1) {
        applyStart()
      } else {
        video.addEventListener('loadedmetadata', applyStart, { once: true })
      }
    } else {
      stopCompanionAudio()
      stopBitmapSubtitle()
      video.src = proxyUrl(media.src, {
        live: media.isLive,
        start,
        audio,
        sub: streamSub,
        subBitmap: bitmap,
        subPath: subPath || undefined,
        transcodeVideo: !!next.forceVideoTranscode || needsProxyVideoTranscode()
      })
      video.load()
      video.playbackRate = playbackRate
    }
    // Re-show the text subtitles instantly (cached cues, re-timed to the new
    // rebase offset) so a seek or audio-track change never drops them.
    if (!directPlayback && sub >= 0 && !bitmap) {
      scheduleTextSubtitleMount(video, sub, Math.max(0, start))
    }
    if (!directPlayback && localTextSubRef.current) {
      void showSidecarSubtitles(video, localTextSubRef.current, Math.max(0, start) + subSyncRef.current)
    }
    if (shouldPlay) video.play().catch(() => undefined)
  }

  // ---- Open / change media (with resume) --------------------------------
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    clearPendingSkip()
    const resume = media.resumeKey && !media.isLive ? getProgress(media.resumeKey) : 0
    audioRef.current = 0
    subRef.current = -1
    subBitmapRef.current = false
    subtitleMountRequestRef.current++
    subPathRef.current = ''
    localTextSubRef.current = ''
    subSyncRef.current = 0
    playbackModeRef.current = 'proxy'
    directFallbackTriedRef.current = false
    stopCompanionAudio()
    stopBitmapSubtitle()
    hideSubtitles(video)
    setAudioRel(0)
    setSubRel(-1)
    setLocalSubActive(null)
    setUploadedSubs([])
    setShowSubSearch(false)
    setSubSync(0)
    setSubVertical(90)
    setSubtitleVerticalPosition(90)
    setShowQueue(false)
    setShowSpeed(false)
    setSeekHover(null)
    audioPrefAppliedRef.current = false
    setVideoInfo(null)
    videoInfoRef.current = null
    setShowInfo(false)
    setError(null)
    setPaused(false)
    setPlaybackMode('proxy')
    setDuration(media.durationSecs)
    audioTracksRef.current = []
    subTracksRef.current = []
    setAudioTracks([])
    setSubTracks([])
    setMenu('none')

    // Pre-read sidecar subtitle files into cache so first selection is instant.
    if (media.localSubs?.length) {
      for (const s of media.localSubs) prefetchSidecarCues(s.path)
    }

    let cancelled = false
    probeTracks(media.src).then(({ audio, subs, video, duration: probedDuration }) => {
      if (!cancelled) {
        audioTracksRef.current = audio
        subTracksRef.current = subs
        videoInfoRef.current = video
        setAudioTracks(audio)
        setSubTracks(subs)
        setVideoInfo(video)
        if (!media.isLive && probedDuration) setDuration(probedDuration)

        // Decide Direct versus Proxy before assigning a media source. Starting
        // direct then replacing it a moment later with a remux left Chromium's
        // old audio clock alive for some AC3 files, producing the large A/V
        // offset reported on Creed III and the other affected films.
        let initialAudio = 0
        let initialSub = -1
        let initialSubBitmap = false
        if (!audioPrefAppliedRef.current && media.audioPrefKey && audio.length > 1) {
          const saved = getSavedAudioPref(media.audioPrefKey)
          const preferredAudio = saved ? audio.find((track) => audioPrefSignature(track) === saved) : null
          if (preferredAudio) {
            initialAudio = preferredAudio.rel
          }
          audioPrefAppliedRef.current = true
        }
        // A manual subtitle choice is intentionally shared by every episode in a
        // series. On a resumed episode restore only that exact saved track; do
        // not newly enable an automatic French track halfway through a title.
        if (!media.isLive) {
          const preferred = resume > 0
            ? findSavedSubtitleTrack(subs, media.audioPrefKey)
            : pickInitialSubtitleTrack(subs, media.audioPrefKey)
          if (preferred) {
            initialSub = preferred.rel
            initialSubBitmap = preferred.bitmap
          }
        }

        audioRef.current = initialAudio
        subRef.current = initialSub
        subBitmapRef.current = initialSubBitmap
        setAudioRel(initialAudio)
        setSubRel(initialSub)

        if (resume > 0) {
          baseOffset.current = resume
          lastSave.current = resume
          setCur(resume)
          if (media.autoResume) {
            setResumePrompt(null)
            debugSubtitleLifecycle(videoRef.current, 'player:resume-auto', {
              resume,
              initialAudio,
              initialSub,
              initialSubBitmap,
              autoResume: media.autoResume,
              resumeKey: media.resumeKey
            })
            load({ audio: initialAudio, sub: initialSub, subBitmap: initialSubBitmap, start: resume })
          } else {
            setLoading(false)
            setResumePrompt(resume)
          }
        } else {
          setResumePrompt(null)
          load({ audio: initialAudio, sub: initialSub, subBitmap: initialSubBitmap, start: 0 })
        }
      }
    })
    if (media.fetchInfo) {
      media.fetchInfo().then((info) => {
        if (!cancelled && info.durationSecs) setDuration(info.durationSecs)
      })
    }
    return () => {
      cancelled = true
      clearPendingSkip()
      persist()
      closeSubtitles(video)
      stopCompanionAudio()
      stopBitmapSubtitle()
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media])

  // ---- Media element events ---------------------------------------------
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlaying = (): void => {
      void audioClockRef.current?.resume().catch(() => undefined)
      diag('media:playing')
      video.playbackRate = playbackRate
      const audio = companionAudioRef.current
      const overlay = bitmapSubtitleRef.current
      if (companionAudioActiveRef.current) syncCompanionAudio(video, true)
      if (bitmapSubtitleActiveRef.current && overlay?.readyState && overlay.paused) void overlay.play().catch(() => undefined)
      setLoading(false)
      setPaused(false)
    }
    const onMetadata = (): void => {
      diag('media:metadata')
      // A fragmented ffmpeg response has a duration for the current response,
      // not for the source file. Only direct media metadata may fill a missing
      // duration; the proxy duration always comes from the ffprobe result.
      if (!media.isLive && playbackModeRef.current === 'direct' && (!durRef.current || !duration)) {
        const nativeDuration = Number.isFinite(video.duration) && video.duration > 0
          ? baseOffset.current + video.duration
          : 0
        if (nativeDuration > 0) setDuration(nativeDuration)
      }
    }
    const onWaiting = (): void => { diag('media:waiting'); setLoading(true) }
    const onPause = (): void => {
      diag('media:pause')
      companionAudioRef.current?.pause()
      bitmapSubtitleRef.current?.pause()
      setPaused(true)
    }
    const onPlayEv = (): void => {
      diag('media:play')
      syncCompanionAudio(video, true)
      setPaused(false)
    }
    const onTime = (): void => {
      const now = performance.now()
      if (now - lastDiagTimeRef.current >= 1000) {
        lastDiagTimeRef.current = now
        diag('media:timeupdate')
      }
      const p = baseOffset.current + video.currentTime
      setCur(p)
      const syncOverlay = (element: HTMLMediaElement | null, active: boolean, base: number): void => {
        if (!active || !element || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
        const desired = video.currentTime - base
        const threshold = element === companionAudioRef.current ? 0.08 : 0.25
        if (desired < 0 || Math.abs(desired - element.currentTime) <= threshold) return
        if (element === companionAudioRef.current && !mediaCanSeekTo(element, desired)) return
        try { element.currentTime = desired } catch { /* stream not seekable yet */ }
      }
      syncOverlay(companionAudioRef.current, companionAudioActiveRef.current, companionAudioBaseRef.current)
      syncOverlay(bitmapSubtitleRef.current, bitmapSubtitleActiveRef.current, bitmapSubtitleBaseRef.current)
      if (media.resumeKey && !media.isLive && p - lastSave.current >= 5) {
        setProgress(media.resumeKey, p, durRef.current)
        lastSave.current = p
      }
      // Drives the position/duration shown on the PiP mini-window's scrubber.
      if (!media.isLive && durRef.current > 0) {
        try {
          navigator.mediaSession?.setPositionState?.({
            duration: durRef.current,
            position: Math.min(Math.max(p, 0), durRef.current),
            playbackRate: video.playbackRate || 1
          })
        } catch {
          /* ignore */
        }
      }
    }
    const onVolume = (): void => {
      if (companionAudioActiveRef.current) return
      logicalMutedRef.current = video.muted
      setMuted(video.muted)
    }
    const onEnded = (): void => {
      diag('media:ended')
      if (media.resumeKey && !media.isLive) {
        const nativeDur = Number.isFinite(video.duration) && video.duration > 0 ? baseOffset.current + video.duration : 0
        const effectiveDur = durRef.current > 0 ? durRef.current : nativeDur
        markCompleted(media.resumeKey, effectiveDur)
      }
    }
    const onErr = (): void => {
      diag('media:error', { error: video.error ? { code: video.error.code, message: video.error.message } : null })
      if (playbackModeRef.current === 'direct' && media.local && !directFallbackTriedRef.current) {
        directFallbackTriedRef.current = true
        setError(null)
        load({ start: video.currentTime || 0, forceProxy: true, forceVideoTranscode: true })
        return
      }
      setError('Lecture impossible (flux indisponible ou piste non gérée).')
      setLoading(false)
    }
    video.addEventListener('playing', onPlaying)
    video.addEventListener('loadedmetadata', onMetadata)
    video.addEventListener('durationchange', onMetadata)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('pause', onPause)
    video.addEventListener('play', onPlayEv)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('volumechange', onVolume)
    video.addEventListener('ended', onEnded)
    video.addEventListener('error', onErr)
    const diagEvents = ['loadstart', 'loadeddata', 'canplay', 'canplaythrough', 'seeking', 'seeked', 'stalled', 'suspend', 'progress', 'ratechange', 'emptied'] as const
    const onDiagEvent = (event: Event): void => diag(`media:${event.type}`)
    diagEvents.forEach((event) => video.addEventListener(event, onDiagEvent))
    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('loadedmetadata', onMetadata)
      video.removeEventListener('durationchange', onMetadata)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('play', onPlayEv)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('volumechange', onVolume)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onErr)
      diagEvents.forEach((event) => video.removeEventListener(event, onDiagEvent))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = playbackRate
    if (companionAudioRef.current) companionAudioRef.current.playbackRate = playbackRate
    if (bitmapSubtitleRef.current) bitmapSubtitleRef.current.playbackRate = playbackRate
  }, [playbackRate])

  // ---- Fullscreen sync --------------------------------------------------
  useEffect(() => {
    const onFs = (): void => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // ---- Native PiP sync (live streams only) ------------------------------
  useEffect(() => {
    if (!media.isLive) return
    const video = videoRef.current
    if (!video) return
    const onEnter = (): void => setPip(true)
    const onLeave = (): void => { setPip(false); focusWindow() }
    video.addEventListener('enterpictureinpicture', onEnter)
    video.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter)
      video.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [media.isLive])

  // Keep pipRef in sync so close() and key handlers always see the live value.
  useEffect(() => { pipRef.current = pip }, [pip])

  // ---- Media Session: drives the PiP mini-window's controls -------------
  // Registering these action handlers makes Chromium add the matching buttons
  // to the PiP window (seekforward/back show as ⏪/⏩; the seekto handler + a
  // valid setPositionState make a scrubber appear with the file's duration).
  useEffect(() => {
    const ms = navigator.mediaSession
    if (!ms) return
    try {
      ms.metadata = new MediaMetadata({
        title: media.title,
        artist: media.subtitle || ''
      })
    } catch {
      /* ignore */
    }
    const safe = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
      try {
        ms.setActionHandler(action, handler)
      } catch {
        /* unsupported actions throw on some Chromium builds */
      }
    }
    safe('play', () => {
      videoRef.current?.play().catch(() => undefined)
    })
    safe('pause', () => {
      videoRef.current?.pause()
    })
    if (!media.isLive) {
      safe('seekforward', (d) => {
        skip(d.seekOffset ?? 10)
      })
      safe('seekbackward', (d) => {
        skip(-(d.seekOffset ?? 10))
      })
      safe('seekto', (d) => {
        if (d.seekTime != null) seek(d.seekTime)
      })
    } else {
      safe('seekforward', null)
      safe('seekbackward', null)
      safe('seekto', null)
    }
    safe('nexttrack', hasNextItem() ? () => next() : null)
    safe('previoustrack', hasPrevItem() ? () => prev() : null)
    return () => {
      safe('play', null)
      safe('pause', null)
      safe('seekforward', null)
      safe('seekbackward', null)
      safe('seekto', null)
      safe('nexttrack', null)
      safe('previoustrack', null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media])

  const seekThumbnailSecond = seekHover && duration && !media.isLive
    ? Math.floor(seekHover.time / 8) * 8
    : null

  useEffect(() => {
    if (media.local || seekThumbnailSecond == null) {
      setThumbnailSecond(null)
      return
    }
    const timer = window.setTimeout(() => setThumbnailSecond(seekThumbnailSecond), 120)
    return () => window.clearTimeout(timer)
  }, [media.local, seekThumbnailSecond])

  useEffect(() => {
    const preview = seekPreviewVideoRef.current
    if (!preview || !media.local || media.isLive) {
      setLocalPreviewReady(false)
      seekPreviewRequestRef.current = () => undefined
      return
    }

    let active = true
    setLocalPreviewReady(false)
    seekPreviewTargetRef.current = null
    preview.muted = true
    preview.preload = 'auto'
    preview.src = localFileUrl(media.src)
    preview.load()

    const drawFrame = (): void => {
      const canvas = seekPreviewCanvasRef.current
      if (!active || !canvas || preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || preview.videoWidth === 0 || preview.videoHeight === 0) return
      const width = 360
      const height = Math.round(width * preview.videoHeight / preview.videoWidth)
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return
      context.drawImage(preview, 0, 0, width, height)
      setLocalPreviewReady(true)
    }
    const requestFrame = (time: number): void => {
      seekPreviewTargetRef.current = Math.max(0, Math.min(time, duration || time))
      if (preview.readyState < HTMLMediaElement.HAVE_METADATA || preview.seeking) return
      const target = seekPreviewTargetRef.current
      if (target == null) return
      if (Math.abs(preview.currentTime - target) < 0.25) {
        drawFrame()
        return
      }
      try {
        preview.currentTime = target
      } catch {
        /* the local decoder will retry on the next pointer update */
      }
    }
    const onMetadata = (): void => requestFrame(seekPreviewTargetRef.current ?? pos())
    const onLoadedData = (): void => drawFrame()
    const onSeeked = (): void => {
      const target = seekPreviewTargetRef.current
      if (target != null && Math.abs(preview.currentTime - target) > 0.35) {
        requestFrame(target)
        return
      }
      drawFrame()
    }
    preview.addEventListener('loadedmetadata', onMetadata)
    preview.addEventListener('loadeddata', onLoadedData)
    preview.addEventListener('seeked', onSeeked)
    seekPreviewRequestRef.current = requestFrame
    if (preview.readyState >= HTMLMediaElement.HAVE_METADATA) onMetadata()

    return () => {
      active = false
      preview.removeEventListener('loadedmetadata', onMetadata)
      preview.removeEventListener('loadeddata', onLoadedData)
      preview.removeEventListener('seeked', onSeeked)
      seekPreviewRequestRef.current = () => undefined
      preview.pause()
      preview.removeAttribute('src')
      preview.load()
    }
  }, [media.local, media.isLive, media.src])

  const seekHoverTime = seekHover?.time ?? null
  useEffect(() => {
    if (!media.local || seekHoverTime == null) return
    const timer = window.setTimeout(() => seekPreviewRequestRef.current(seekHoverTime), 35)
    return () => window.clearTimeout(timer)
  }, [media.local, seekHoverTime])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
      const tag = (active?.tagName || '').toUpperCase()
      const inputType = tag === 'INPUT' ? active?.type : ''
      const rangeFocused = tag === 'INPUT' && inputType === 'range'
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && inputType !== 'range')) return
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const shortcut = e.key.toLowerCase()
        if (shortcut === 'm') {
          e.preventDefault()
          toggleMute()
          return
        }
        if (shortcut === 'i' && videoInfoRef.current) {
          e.preventDefault()
          setMenu('none')
          setShowSpeed(false)
          setShowQueue(false)
          setShowInfo((value) => !value)
          return
        }
        if (shortcut === 'c' && !media.isLive) {
          e.preventDefault()
          setShowInfo(false)
          setShowSpeed(false)
          setShowQueue(false)
          setMenu((value) => value === 'sub' ? 'none' : 'sub')
          return
        }
      }
      if (e.key === 'Escape' && !document.fullscreenElement) {
        if (pipRef.current) void togglePip()
        else close()
      }
      else if (e.key === ' ') {
        e.preventDefault()
        if (rangeFocused) focusStage()
        togglePlay()
      } else if (e.key === 'ArrowRight' && !media.isLive) {
        e.preventDefault()
        if (rangeFocused) focusStage()
        if (e.metaKey) next()
        else skip(10)
      } else if (e.key === 'ArrowLeft' && !media.isLive) {
        e.preventDefault()
        if (rangeFocused) focusStage()
        if (e.metaKey) prev()
        else skip(-10)
      } else if (
        e.altKey &&
        (e.code === pipKeyCode.current || e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z' || e.key === 'Ω')
      ) {
        // Option+Z — toggle Picture-in-Picture. Match the layout-detected code
        // for the "z" key (covers AZERTY where it's KeyW), with fallbacks.
        e.preventDefault()
        void togglePip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media])

  function pos(): number {
    const video = videoRef.current
    return video ? baseOffset.current + video.currentTime : baseOffset.current
  }
  function focusStage(): void {
    stageRef.current?.focus({ preventScroll: true })
  }
  function togglePlay(): void {
    const video = videoRef.current
    if (!video) return
    clearPendingSkip()
    if (video.paused) video.play().catch(() => undefined)
    else video.pause()
  }
  function closeMiniMenus(): boolean {
    const open = menu !== 'none' || showInfo || showSpeed || showQueue
    if (!open) return false
    setMenu('none')
    setShowInfo(false)
    setShowSpeed(false)
    setShowQueue(false)
    return true
  }
  // Single click toggles play; double click toggles fullscreen (delay disambiguates).
  function onStageClick(): void {
    // A click on the playback area dismisses an open mini-window first. It
    // must never pause/resume playback in that case.
    if (closeMiniMenus()) return
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = undefined
      return
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = undefined
      togglePlay()
    }, 220)
  }
  function onStageDblClick(): void {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = undefined
    }
    if (pipRef.current) { void togglePip(); return }
    toggleFullscreen()
  }
  function seek(t: number): void {
    if (media.isLive) return
    clearPendingSkip()
    const target = clampSeek(t)
    if (seekDirectInPlace(target)) return
    load({ start: target, autoplay: !videoRef.current?.paused })
  }
  function clampSeek(t: number): number {
    return Math.max(0, duration ? Math.min(t, duration) : t)
  }
  function seekDirectInPlace(t: number): boolean {
    const video = videoRef.current
    if (!video || media.isLive) return false
    if (playbackModeRef.current !== 'direct' || !media.local || !video.currentSrc) return false
    const target = clampSeek(t)
    try {
      baseOffset.current = 0
      video.currentTime = target
      applyDirectSelections(video, audioRef.current, subRef.current, target)
      setCur(target)
      setSeekDraft(null)
      setLoading(false)
      syncDirectTextSubtitle(video, target)
      return true
    } catch {
      return false
    }
  }
  function previewSeek(t: number): void {
    if (media.isLive) return
    setSeekDraft(clampSeek(t))
  }
  function commitSeek(t: number): void {
    if (media.isLive) return
    clearPendingSkip()
    const target = clampSeek(t)
    if (seekDirectInPlace(target)) return
    load({ start: target, autoplay: !videoRef.current?.paused })
  }
  function clearPendingSkip(): void {
    const pending = pendingSkipRef.current
    if (pending?.timer != null) window.clearTimeout(pending.timer)
    pendingSkipRef.current = null
  }
  function skip(delta: number): void {
    const pending = pendingSkipRef.current
    const target = clampSeek((pending?.target ?? pos()) + delta)
    if (seekDirectInPlace(target)) return
    const request = pending ?? { target, shouldPlay: !videoRef.current?.paused, timer: null }
    request.target = target
    pendingSkipRef.current = request
    setCur(target)
    setSeekDraft(null)
    if (request.timer != null) return
    request.timer = window.setTimeout(() => {
      const next = pendingSkipRef.current
      pendingSkipRef.current = null
      if (next) load({ start: next.target, autoplay: next.shouldPlay })
    }, 90)
  }
  // Live only: restart the stream → ffmpeg reconnects at the current live edge,
  // discarding any buffer built up while paused/behind.
  function goLive(): void {
    if (!media.isLive) return
    load({ start: 0 })
  }
  function toggleMute(): void {
    const video = videoRef.current
    if (!video) return
    const next = !logicalMutedRef.current
    logicalMutedRef.current = next
    setMuted(next)
    if (companionAudioActiveRef.current) {
      video.muted = true
      if (companionAudioRef.current) companionAudioRef.current.muted = next
    } else {
      video.muted = next
    }
  }
  function updateSeekHover(clientX: number, rect: DOMRect): void {
    if (!duration) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    setSeekHover({ time: ratio * duration, ratio })
  }
  async function toggleFullscreen(): Promise<void> {
    if (pipRef.current) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await containerRef.current?.requestFullscreen()
    } catch {
      /* ignore */
    }
  }
  function onPipMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    if ((e.target as HTMLElement).closest('button, input')) return
    const startX = e.screenX
    const startY = e.screenY
    const winX = window.screenLeft
    const winY = window.screenTop
    let raf: number | null = null
    pipDraggedRef.current = false

    function onMove(ev: MouseEvent): void {
      const dx = ev.screenX - startX
      const dy = ev.screenY - startY
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return
      pipDraggedRef.current = true
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => movePipWindow(winX + dx, winY + dy))
    }
    function onUp(): void {
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  async function togglePip(): Promise<void> {
    // Live streams use native macOS PiP (no subtitle overlay needed for live TV).
    if (media.isLive) {
      const video = videoRef.current
      if (!video) return
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture()
        else await video.requestPictureInPicture()
      } catch {
        setError('Picture-in-Picture indisponible pour ce flux.')
      }
      return
    }
    if (pipRef.current) {
      await exitPip()
      setPip(false)
      document.body.classList.remove('pip-mode')
    } else {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen()
        } catch {
          /* ignore */
        }
      }
      const video = videoRef.current
      const aspectRatio =
        video && video.videoWidth > 0 && video.videoHeight > 0
          ? video.videoWidth / video.videoHeight
          : undefined
      await enterPip(aspectRatio)
      setPip(true)
      document.body.classList.add('pip-mode')
    }
  }
  function currentQueueIndex(items: MediaQueueItem[] | undefined): number {
    if (media.queueIndex != null) return media.queueIndex
    return items?.findIndex((item) => item.src === media.src) ?? -1
  }

  function next(): void {
    persist()
    const groups = media.queueGroups
    if (groups?.length) {
      const groupIndex = media.queueGroupIndex ?? 0
      const group = groups[groupIndex]
      const index = currentQueueIndex(group?.items)
      if (group && index + 1 < group.items.length) {
        media.onQueueSelect?.(index + 1, groupIndex)
      } else if (groupIndex + 1 < groups.length) {
        media.onQueueGroupSelect?.(groupIndex + 1)
      }
      return
    }
    const index = currentQueueIndex(media.queue)
    if (media.queue && index >= 0 && index + 1 < media.queue.length) {
      media.onQueueSelect?.(index + 1)
    }
  }
  function prev(): void {
    persist()
    if (media.onPrev) {
      media.onPrev()
      return
    }
    const groups = media.queueGroups
    if (groups?.length) {
      const groupIndex = media.queueGroupIndex ?? 0
      const group = groups[groupIndex]
      const index = currentQueueIndex(group?.items)
      if (group && index > 0) {
        media.onQueueSelect?.(index - 1, groupIndex)
      } else if (groupIndex > 0) {
        const prevGroup = groups[groupIndex - 1]
        if (prevGroup?.items.length) media.onQueueSelect?.(prevGroup.items.length - 1, groupIndex - 1)
      }
      return
    }
    const index = currentQueueIndex(media.queue)
    if (media.queue && index > 0) {
      media.onQueueSelect?.(index - 1)
    }
  }
  function close(): void {
    clearPendingSkip()
    persist()
    if (pipRef.current) {
      void exitPip()
      document.body.classList.remove('pip-mode')
    }
    docPipWinRef.current?.close()
    docPipWinRef.current = null
    onClose()
  }

  function reapplySubSync(delta: number): void {
    subSyncRef.current = delta
    const video = videoRef.current
    if (!video) return
    if (localTextSubRef.current) {
      debugSubtitleLifecycle(video, 'player:subSync:sidecar', {
        delta,
        path: localTextSubRef.current,
        offset: baseOffset.current + delta
      })
      void showSidecarSubtitles(video, localTextSubRef.current, baseOffset.current + delta)
    } else if (subRef.current >= 0 && !subBitmapRef.current) {
      debugSubtitleLifecycle(video, 'player:subSync:embedded-text', {
        delta,
        rel: subRef.current,
        offset: baseOffset.current + delta
      })
      showSubtitles(video, media.src, subRef.current, baseOffset.current + delta)
    }
  }

  function fmtBitrate(bps: number): string {
    if (bps <= 0) return ''
    if (bps >= 1_000_000) return ` · ${(bps / 1_000_000).toFixed(1)} Mbps`
    return ` · ${Math.round(bps / 1000)} Kbps`
  }

  function hasNextItem(): boolean {
    const groups = media.queueGroups
    if (groups?.length) {
      const groupIndex = media.queueGroupIndex ?? 0
      const group = groups[groupIndex]
      const index = currentQueueIndex(group?.items)
      return !!group && index >= 0 && (index + 1 < group.items.length || groupIndex + 1 < groups.length)
    }
    const index = currentQueueIndex(media.queue)
    return !!media.queue && index >= 0 && index + 1 < media.queue.length
  }

  function hasPrevItem(): boolean {
    if (media.onPrev) return true
    const groups = media.queueGroups
    if (groups?.length) {
      const groupIndex = media.queueGroupIndex ?? 0
      const group = groups[groupIndex]
      const index = currentQueueIndex(group?.items)
      return index > 0 || groupIndex > 0
    }
    return !!media.queue && currentQueueIndex(media.queue) > 0
  }

  function showCastNotice(message: string, timeout = 5000): void {
    if (castNoticeTimer.current) window.clearTimeout(castNoticeTimer.current)
    setCastNotice(message)
    castNoticeTimer.current = window.setTimeout(() => {
      setCastNotice(null)
      castNoticeTimer.current = null
    }, timeout)
  }

  async function castToDevice(device: CastDevice): Promise<void> {
    setCastBusy(true)
    setMenu('none')
    showCastNotice(`Connexion à ${device.name}…`)
    try {
      const video = videoRef.current
      const activeSubtitlePath = localTextSubRef.current || subPathRef.current || undefined
      const hasCastSubtitle = subRef.current >= 0 || !!activeSubtitlePath
      const includeSubtitles = castBurnSubtitles && hasCastSubtitle
      const result = await playOnCastDevice(
        device,
        media.src,
        media.title,
        video ? baseOffset.current + video.currentTime : cur,
        !!media.isLive,
        {
          audio: audioRef.current,
          sub: includeSubtitles ? subRef.current : -1,
          subBitmap: includeSubtitles ? subBitmapRef.current : false,
          subPath: includeSubtitles ? activeSubtitlePath : undefined
        }
      )
      if (result) {
        video?.pause()
        showCastNotice(`Lecture lancée sur ${device.name}${includeSubtitles ? ' avec sous-titres TV' : ''}. Le Mac sert le flux, garde IPTV Flow ouvert.`)
        return
      }
      const url = await startLocalCast(media.src)
      if (url) showCastNotice(`Impossible de lancer le receiver. Adresse copiée :\n${url}`, 8000)
    } catch (err) {
      console.error('Google Cast failed', err)
      const reason = err instanceof Error && err.message ? ` (${err.message})` : ''
      showCastNotice(`Impossible de caster vers ${device.name}${reason}.`)
    } finally {
      setCastBusy(false)
    }
  }

  async function openAirPlayPanel(): Promise<void> {
    setMenu('none')
    const opened = await openCastSettings()
    if (opened) {
      showCastNotice('Choisis ta Firestick dans Recopie de l’écran / AirPlay. Ce mode reflète le Mac, ce n’est pas un cast vidéo natif IPTV Flow.', 10000)
    } else {
      showCastNotice('Impossible d’ouvrir les réglages AirPlay. Ouvre le Centre de contrôle macOS puis Recopie de l’écran.', 10000)
    }
  }

  async function openCastMenu(): Promise<void> {
    setShowInfo(false)
    setShowSpeed(false)
    setShowQueue(false)
    setMenu('none')
    setCastBusy(true)
    showCastNotice('Recherche des appareils Google Cast…')
    try {
      const devices = await listCastDevices()
      setCastDevices(devices)
      if (devices.length === 0) {
        showCastNotice('Aucun Google Cast trouvé. Tu peux quand même essayer AirPlay / Recopie d’écran si ta Firestick le reçoit.', 7000)
        setMenu('cast')
        return
      }
      setCastNotice(null)
      setMenu('cast')
    } catch (err) {
      console.error('Google Cast discovery failed', err)
      const reason = err instanceof Error && err.message ? ` (${err.message})` : ''
      showCastNotice(`Impossible de rechercher les appareils Google Cast${reason}.`)
    } finally {
      setCastBusy(false)
    }
  }

  const displayCur = seekDraft ?? cur
  const speedOptions = [0.5, 1, 1.25, 1.5, 2, 2.5]
  const activeQueueGroup = media.queueGroups?.[queueViewGroupIndex]
  const queueItems = activeQueueGroup?.items ?? media.queue ?? []
  const queueIsEpisodes = !!queueItems[0]?.subtitle?.match(/^(S\d+|Spéciaux)/)

  return (
    <div className={`player ${controlsVisible ? '' : 'controls-hidden'} ${pip ? 'pip-mode' : ''}`} ref={containerRef} onMouseMove={wakeBar} onMouseEnter={pip ? () => { if (hideTimer.current) window.clearTimeout(hideTimer.current); setBarVisible(true) } : undefined} onMouseLeave={pip ? () => { if (hideTimer.current) window.clearTimeout(hideTimer.current); hideTimer.current = window.setTimeout(() => setBarVisible(false), 600) } : undefined}>
      {castNotice && (
        <div
          className="cast-notice"
          role="status"
          title="Cliquer pour copier le message"
          onClick={() => { void navigator.clipboard?.writeText(castNotice) }}
        >
          {castNotice}
        </div>
      )}
      <div className={`player-bar ${controlsVisible ? '' : 'player-bar--hidden'}`}>
        <button className="icon-btn top-ctrl-btn" onClick={close} title="Fermer (Échap)">
          {closeIcon}
        </button>
        <div className="player-title">
          <strong>{media.title}</strong>
          {media.subtitle && <span>{media.subtitle}</span>}
        </div>
        <div className="player-actions">
          {media.isLive && <span className="live-badge">● LIVE</span>}

          {canCast && (
            <div className="sub-wrap">
              <button
                className={`icon-btn top-ctrl-btn ${menu === 'cast' || castBusy ? 'active' : ''}`}
                onClick={() => { void openCastMenu() }}
                title="Caster"
              >
                {castIcon}
              </button>
              {menu === 'cast' && (
                <div className="sub-menu cast-device-menu">
                  {(subRel >= 0 || localSubActive) && (
                    <button
                      className={`sub-item ${castBurnSubtitles ? 'on' : ''}`}
                      onClick={() => setCastBurnSubtitles((value) => !value)}
                    >
                      Sous-titres TV : {castBurnSubtitles ? 'oui' : 'non'}
                    </button>
                  )}
                  {castDevices.length > 0 && <div className="cast-menu-label">Google Cast</div>}
                  {castDevices.map((device) => (
                    <button
                      key={`${device.id}-${device.host}`}
                      className="sub-item"
                      onClick={() => { void castToDevice(device) }}
                    >
                      {device.name}{device.model ? ` · ${device.model}` : ''}
                    </button>
                  ))}
                  {castDevices.length === 0 && (
                    <div className="cast-menu-empty">Aucun Google Cast trouvé</div>
                  )}
                  <button
                    className="sub-item"
                    onClick={() => { void openAirPlayPanel() }}
                  >
                    AirPlay / Recopie d’écran
                  </button>
                  <button
                    className="sub-item sub-upload"
                    onClick={() => { setMenu('none'); showCastNotice('Google Cast lance la vidéo sur l’appareil. AirPlay ici ouvre la recopie d’écran macOS : utile pour ta Firestick, mais moins propre qu’un vrai receiver Google Cast.', 10000) }}
                  >
                    Aide Firestick
                  </button>
                </div>
              )}
            </div>
          )}

          {audioTracks.length > 1 && (
            <div className="sub-wrap">
              <button
                className={`icon-btn top-ctrl-btn ${menu === 'audio' ? 'active' : ''}`}
                onClick={() => {
                  setShowInfo(false)
                  setShowSpeed(false)
                  setShowQueue(false)
                  setMenu(menu === 'audio' ? 'none' : 'audio')
                }}
                title="Piste audio"
              >
                {audioIcon}
              </button>
              {menu === 'audio' && (
                <div className="sub-menu">
                  {audioTracks.map((t) => (
                    <button
                      key={t.rel}
                      className={`sub-item ${audioRel === t.rel ? 'on' : ''}`}
                      onClick={() => chooseAudio(t.rel)}
                    >
                      {audioLabel(t)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {!media.isLive && (
            <div className="sub-wrap">
              <button
                className={`icon-btn top-ctrl-btn ${subRel >= 0 || localSubActive ? 'active' : ''}`}
                onClick={() => {
                  setShowInfo(false)
                  setShowSpeed(false)
                  setShowQueue(false)
                  setMenu(menu === 'sub' ? 'none' : 'sub')
                }}
                title="Sous-titres"
              >
                <span className="cc">CC</span>
              </button>
              {menu === 'sub' && (
                <div className="sub-menu">
                  <button
                    className={`sub-item ${subRel < 0 && !localSubActive ? 'on' : ''}`}
                    onClick={disableSubtitles}
                  >
                    Désactivés
                  </button>
                  {subTracks.map((t) => (
                    <button
                      key={t.rel}
                      className={`sub-item ${subRel === t.rel ? 'on' : ''}`}
                      onClick={() => chooseSubtitle(t)}
                    >
                      {subLabel(t)}
                    </button>
                  ))}
                  {media.localSubs?.map((s) => (
                    <button
                      key={s.path}
                      className={`sub-item ${localSubActive === s.path ? 'on' : ''}`}
                      onClick={() => chooseLocalSub(s)}
                    >
                      {s.label} · fichier
                    </button>
                  ))}
                  {uploadedSubs.map((s) => (
                    <button
                      key={s.path}
                      className={`sub-item ${localSubActive === s.path ? 'on' : ''}`}
                      onClick={() => chooseLocalSub(s)}
                    >
                      {s.label} · téléversé
                    </button>
                  ))}
                  <button className="sub-item sub-upload" onClick={() => { void pickUploadSub() }}>
                    + Téléverser un fichier…
                  </button>
                  <button className="sub-item sub-upload" onClick={() => { setShowSubSearch(true); setMenu('none') }}>
                    ↓ Télécharger en ligne…
                  </button>
                  {(subRel >= 0 || localSubActive) && (
                    <>
                    <div className="sub-sync-row">
                      <span className="sub-sync-lbl">Décalage</span>
                      <button
                        className="sub-sync-step"
                        onClick={() => { const v = Math.max(-10, subSync - 0.5); setSubSync(v); reapplySubSync(v) }}
                      >−</button>
                      <span className={`sub-sync-val ${subSync !== 0 ? 'sub-sync-val--active' : ''}`}>
                        {subSync === 0 ? '0s' : `${subSync > 0 ? '+' : ''}${subSync}s`}
                      </span>
                      <button
                        className="sub-sync-step"
                        onClick={() => { const v = Math.min(10, subSync + 0.5); setSubSync(v); reapplySubSync(v) }}
                      >+</button>
                      {subSync !== 0 && (
                        <button
                          className="sub-sync-reset"
                          onClick={() => { setSubSync(0); reapplySubSync(0) }}
                          title="Remettre à zéro"
                        >↺</button>
                      )}
                    </div>
                    <label className="sub-vertical-row">
                      <span className="sub-sync-lbl">Position</span>
                      <input
                        aria-label="Position verticale des sous-titres"
                        type="range"
                        min="5"
                        max="95"
                        value={subVertical}
                        onChange={(event) => {
                          const value = Number(event.target.value)
                          setSubVertical(value)
                          setSubtitleVerticalPosition(value)
                        }}
                      />
                    </label>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {videoInfo && (
            <div className="sub-wrap">
              <button
                className={`icon-btn top-ctrl-btn ${showInfo ? 'active' : ''}`}
                onClick={() => {
                  setMenu('none')
                  setShowSpeed(false)
                  setShowQueue(false)
                  setShowInfo(!showInfo)
                }}
                title="Infos codec"
              >
                <span className="cc">ℹ</span>
              </button>
              {showInfo && (
                <div className="sub-menu media-info-panel">
                  <div className="info-row">
                    <span className="info-lbl">Vidéo</span>
                    <span className="info-val">
                      {videoInfo.codec.toUpperCase()}
                      {videoInfo.encoder ? ` (${videoInfo.encoder})` : ''}
                      {videoInfo.width > 0 ? ` · ${videoInfo.width}×${videoInfo.height}` : ''}
                      {videoInfo.bitDepth > 8 ? ` · ${videoInfo.bitDepth}-bit` : ''}
                      {fmtBitrate(videoInfo.bitrate)}
                    </span>
                  </div>
                  {audioTracks.length > 0 && (
                    <div className="info-row">
                      <span className="info-lbl">Audio</span>
                      <span className="info-val">
                        {audioTracks[0].codec.toUpperCase()}
                        {audioTracks.length > 1 ? ` · ${audioTracks.length} pistes` : ''}
                      </span>
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-lbl">Lecture</span>
                    <span className="info-val">{playbackMode === 'direct' ? 'Direct' : 'Proxy / ffmpeg'}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          <button className={`icon-btn top-ctrl-btn ${pip ? 'active' : ''}`} onClick={togglePip} title="Picture-in-Picture">
            {pipIcon}
          </button>
        </div>
      </div>

      {media.local && !media.isLive && (
        <video ref={seekPreviewVideoRef} className="seek-preview-decoder" muted playsInline preload="auto" aria-hidden="true" />
      )}
      <div ref={stageRef} className="player-stage" tabIndex={-1} onClick={onStageClick} onDoubleClick={onStageDblClick}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} className="video" autoPlay playsInline />
        <audio ref={companionAudioRef} className="companion-audio" />
        {/* Transparent bitmap subtitle layer; it never replaces the real video. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={bitmapSubtitleRef} className="bitmap-subtitle-overlay" muted playsInline />
        {loading && !error && (
          <div className="player-spinner">
            <div className="spinner" />
          </div>
        )}
        {error && <div className="player-error">{error}</div>}
      </div>

      {pip && (
        <div
          className="pip-overlay"
          onMouseDown={onPipMouseDown}
          onClick={(e) => {
            if (pipDraggedRef.current) return
            if ((e.target as HTMLElement).closest('button, input')) return
            togglePlay()
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (!pipDraggedRef.current && !(e.target as HTMLElement).closest('button, input')) void togglePip()
          }}
        >
          {/* Top area: drag zone only — no buttons (macOS titlebar zone intercepts clicks here) */}
          <div className="pip-drag-zone" />

          <div className="pip-center">
            {!media.isLive && (
              <button className="pip-skip-btn" onClick={() => skip(-10)}>{back10Icon}</button>
            )}
            <button className="pip-play-btn" onClick={togglePlay}>
              {paused
                ? <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                : <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              }
            </button>
            {!media.isLive && (
              <button className="pip-skip-btn" onClick={() => skip(10)}>{fwd10Icon}</button>
            )}
          </div>

          <div className="pip-bottom">
            {!media.isLive && (
              <div
                className="pip-progress-track"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  commitSeek(((e.clientX - rect.left) / rect.width) * (duration || 0))
                }}
              >
                <div
                  className="pip-progress-fill"
                  style={{ width: duration ? `${(displayCur / duration) * 100}%` : '0%' }}
                />
              </div>
            )}
            <div className="pip-bottom-row">
              {media.isLive
                ? <span className="pip-live-badge">● LIVE</span>
                : <span className="pip-time">{fmt(displayCur)} / {fmt(duration || 0)}</span>
              }
              {!media.isLive && hasNextItem() && (
                <button className="pip-ctrl-btn pip-ctrl-btn--next" onClick={next} title="Épisode suivant">
                  {nextIcon}
                </button>
              )}
              <div className="pip-bottom-spacer" />
              <div className="pip-bottom-btns">
                {!media.isLive && (
                  <div className="pip-sub-wrap">
                    <button className={`pip-ctrl-btn ${menu === 'sub' ? 'active' : ''}`} onClick={() => setMenu(menu === 'sub' ? 'none' : 'sub')} title="Sous-titres">
                      <span className="cc">CC</span>
                    </button>
                    {menu === 'sub' && (
                      <div className="pip-sub-menu">
                        <button className={`sub-item ${subRel < 0 && !localSubActive ? 'on' : ''}`} onClick={disableSubtitles}>Désactivés</button>
                        {subTracks.map((track) => <button key={track.rel} className={`sub-item ${subRel === track.rel ? 'on' : ''}`} onClick={() => chooseSubtitle(track)}>{subLabel(track)}</button>)}
                        {media.localSubs?.map((sub) => <button key={sub.path} className={`sub-item ${localSubActive === sub.path ? 'on' : ''}`} onClick={() => chooseLocalSub(sub)}>{sub.label}</button>)}
                        {uploadedSubs.map((sub) => <button key={sub.path} className={`sub-item ${localSubActive === sub.path ? 'on' : ''}`} onClick={() => chooseLocalSub(sub)}>{sub.label}</button>)}
                        <button className="sub-item sub-upload" onClick={() => { void pickUploadSub() }}>+ Téléverser un fichier…</button>
                        <button className="sub-item sub-upload" onClick={() => { setShowSubSearch(true); setMenu('none') }}>↓ Télécharger en ligne…</button>
                        {(subRel >= 0 || localSubActive) && (
                          <div className="sub-sync-row">
                            <span className="sub-sync-lbl">Décalage</span>
                            <button className="sub-sync-step" onClick={() => { const value = Math.max(-10, subSync - 0.5); setSubSync(value); reapplySubSync(value) }}>−</button>
                            <span className={`sub-sync-val ${subSync !== 0 ? 'sub-sync-val--active' : ''}`}>{subSync === 0 ? '0s' : `${subSync > 0 ? '+' : ''}${subSync}s`}</span>
                            <button className="sub-sync-step" onClick={() => { const value = Math.min(10, subSync + 0.5); setSubSync(value); reapplySubSync(value) }}>+</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <button className="pip-ctrl-btn" onClick={togglePip} title="Agrandir (⌥Z)">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                  </svg>
                </button>
                <button className="pip-ctrl-btn" onClick={close} title="Fermer">✕</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className={`player-controls ${controlsVisible ? '' : 'player-bar--hidden'}`} onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn bottom-ctrl-btn" onClick={togglePlay} title={paused ? 'Lecture' : 'Pause'}>
          {paused ? '▶' : '⏸'}
        </button>
        {!media.isLive && (
          <>
            <button className="icon-btn bottom-ctrl-btn" onClick={() => skip(-10)} title="Reculer de 10 s (←)">
              {back10Icon}
            </button>
            <button className="icon-btn bottom-ctrl-btn" onClick={() => skip(10)} title="Avancer de 10 s (→)">
              {fwd10Icon}
            </button>
          </>
        )}
        {media.isLive ? (
          <button
            className={`btn-golive ${paused ? 'behind' : ''}`}
            onClick={goLive}
            title="Revenir au direct"
          >
            <span className="golive-dot" />
            {paused ? 'Revenir au direct' : 'EN DIRECT'}
          </button>
        ) : (
          <span className="time">
            {fmt(displayCur)}
            {duration ? ` / ${fmt(duration)}` : ''}
          </span>
        )}

        {!media.isLive ? (
          duration ? (
          <div className="seek-wrap">
            {seekHover && (
              <div className={`seek-preview${(media.local ? localPreviewReady : thumbnailSecond != null) ? ' seek-preview--image' : ''}`} style={{ left: `${seekHover.ratio * 100}%` }}>
                {media.local ? (
                  <canvas ref={seekPreviewCanvasRef} className="seek-preview-frame" style={{ display: localPreviewReady ? 'block' : 'none' }} />
                ) : thumbnailSecond != null ? (
                  <img src={thumbnailUrl(media.src, thumbnailSecond)} alt="" draggable={false} />
                ) : null}
                <span>{fmt(seekHover.time)}</span>
              </div>
            )}
            <input
              className="seek"
              type="range"
              min={0}
              max={Math.floor(duration)}
              step={1}
              value={Math.min(Math.floor(displayCur), Math.floor(duration))}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                previewSeek(Number(e.currentTarget.value))
              }}
              onPointerMove={(e) => updateSeekHover(e.clientX, e.currentTarget.getBoundingClientRect())}
              onPointerUp={(e) => {
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId)
                } catch {
                  /* pointer already released */
                }
                commitSeek(Number(e.currentTarget.value))
                focusStage()
              }}
              onPointerCancel={() => {
                setSeekDraft(null)
                focusStage()
              }}
              onMouseMove={(e) => updateSeekHover(e.clientX, e.currentTarget.getBoundingClientRect())}
              onMouseLeave={() => setSeekHover(null)}
              onChange={(e) => previewSeek(Number(e.currentTarget.value))}
              onKeyUp={(e) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                  commitSeek(Number(e.currentTarget.value))
                  focusStage()
                }
              }}
              onBlur={(e) => {
                setSeekHover(null)
                if (seekDraft != null) commitSeek(Number(e.currentTarget.value))
              }}
            />
          </div>
          ) : (
            <div className="seek-wrap seek-wrap--loading" aria-label="Chargement de la durée">
              <div className="seek-loading-track" />
            </div>
          )
        ) : (
          <div className="seek-spacer" />
        )}

        {!media.isLive && (
          <div className="sub-wrap">
            <button
              className={`icon-btn speed-btn bottom-ctrl-btn ${showSpeed ? 'active' : ''}`}
              onClick={() => {
                setMenu('none')
                setShowInfo(false)
                setShowQueue(false)
                setShowSpeed(!showSpeed)
              }}
              title="Vitesse de lecture"
            >
              {playbackRate}x
            </button>
            {showSpeed && (
              <div className="sub-menu speed-menu">
                {speedOptions.map((rate) => (
                  <button
                    key={rate}
                    className={`sub-item ${playbackRate === rate ? 'on' : ''}`}
                    onClick={() => {
                      setPlaybackRate(rate)
                      setShowSpeed(false)
                    }}
                  >
                    {String(rate).replace('.', ',')}x
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {queueItems.length > 1 && (
          <div className="sub-wrap">
            <button
              className={`icon-btn bottom-ctrl-btn ${showQueue ? 'active' : ''}`}
              onClick={() => {
                setMenu('none')
                setShowInfo(false)
                setShowSpeed(false)
                setShowQueue((value) => !value)
              }}
              title="Épisodes / films de la liste"
            >
              {queueIcon}
            </button>
            {showQueue && (
              <div className="sub-menu queue-menu">
                {media.queueGroups && media.queueGroups.length > 1 && (
                  <div className="queue-seasons">
                    {media.queueGroups.map((group, index) => (
                      <button
                        key={group.id}
                        className={`queue-season ${index === queueViewGroupIndex ? 'on' : ''}`}
                        onClick={() => setQueueViewGroupIndex(index)}
                      >
                        {group.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="queue-heading">{queueIsEpisodes ? 'Épisodes' : activeQueueGroup?.label === 'Fichiers ouverts' ? 'File de lecture' : 'Films de la collection'}</div>
                {queueItems.map((item, index) => (
                  <button
                    key={item.id}
                    className={`sub-item queue-item ${queueViewGroupIndex === (media.queueGroupIndex ?? 0) && index === (media.queueIndex ?? 0) ? 'on' : ''}`}
                    onClick={() => {
                      setShowQueue(false)
                      media.onQueueSelect?.(index, queueViewGroupIndex)
                    }}
                  >
                    <span>{queueIsEpisodes ? item.subtitle : item.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button className="icon-btn bottom-ctrl-btn" onClick={toggleMute} title={muted ? 'Activer le son' : 'Couper le son'}>
          {muted ? volumeOffIcon : volumeOnIcon}
        </button>
        <button className="icon-btn bottom-ctrl-btn" onClick={toggleFullscreen} title="Plein écran">
          {fullscreen ? fullscreenExitIcon : fullscreenEnterIcon}
        </button>
      </div>


      {resumePrompt != null && (
        <div className="resume-prompt">
          <div className="resume-card">
            <div className="resume-title">{media.title}</div>
            {media.subtitle && <div className="resume-sub">{media.subtitle}</div>}
            <p className="resume-text">
              Tu t'étais arrêté à <strong>{fmt(resumePrompt)}</strong>.
            </p>
            <div className="resume-actions">
              <button className="btn-primary" onClick={() => {
                debugSubtitleLifecycle(videoRef.current, 'player:resume-button', {
                  resume: resumePrompt,
                  subRel: subRef.current,
                  subBitmap: subBitmapRef.current,
                  localTextSub: localTextSubRef.current || null,
                  resumeKey: media.resumeKey
                })
                load({ sub: -1, subBitmap: false, subPath: '', start: resumePrompt })
              }}>
                Reprendre à {fmt(resumePrompt)}
              </button>
              <button className="btn-ghost" onClick={() => load({ start: 0 })}>
                Depuis le début
              </button>
            </div>
          </div>
        </div>
      )}

      {showSubSearch && (
        <SubtitleSearchModal
          initialQuery={media.title}
          initialSubtitle={media.subtitle}
          onClose={() => setShowSubSearch(false)}
          onLoaded={(path) => {
            const name = path.split('/').pop() ?? path
            const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'srt'
            const sub: LocalSub = { label: name, path, ext }
            setUploadedSubs((prev) => prev.some((s) => s.path === path) ? prev : [...prev, sub])
            chooseLocalSub(sub)
          }}
        />
      )}
    </div>
  )
}
