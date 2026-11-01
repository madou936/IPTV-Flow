export interface DirectVideoDecision {
  local: boolean
  live: boolean
  remote: boolean
  forceProxy?: boolean
  externalSubtitleNeedsBurnIn?: boolean
  videoCodec?: string
  videoCodecTag?: string
  videoBitDepth?: number
}

/**
 * The eligibility of a local picture is a video decision only. Embedded audio
 * and subtitle tracks are rendered by independent tracks/companions, so they
 * must never demote an otherwise Chromium-compatible local video to ffmpeg.
 */
export function canUseDirectLocalVideo(input: DirectVideoDecision): boolean {
  return input.local &&
    !input.live &&
    !input.remote &&
    !input.forceProxy &&
    !input.externalSubtitleNeedsBurnIn &&
    canDirectPlayVideoCodec(input.videoCodec, input.videoCodecTag, input.videoBitDepth)
}

export function canDirectPlayVideoCodec(codec?: string, codecTag?: string, bitDepth?: number): boolean {
  const normalized = (codec || '').trim().toLowerCase()
  const tag = (codecTag || '').trim().toLowerCase()
  if (!normalized && !tag) return true
  if (normalized === 'h264' || tag === 'avc1') return (bitDepth ?? 8) <= 8
  if (['hevc', 'h265'].includes(normalized) || tag === 'hvc1' || tag === 'hev1') return true
  if (normalized === 'vp8' || normalized === 'vp9' || normalized === 'av1') return true
  return false
}

export function canDirectPlayAudioCodec(codec?: string): boolean {
  const normalized = (codec || '').trim().toLowerCase()
  if (!normalized) return true
  if (['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac'].includes(normalized)) return true
  return normalized.startsWith('pcm_')
}

/** An unsupported selected audio track is converted in an audio-only element. */
export function needsCompanionAudio(codec: string | undefined, audioIndex: number, nativeTrackCount: number): boolean {
  if (!canDirectPlayAudioCodec(codec)) return true
  return audioIndex !== 0 && nativeTrackCount <= audioIndex
}
