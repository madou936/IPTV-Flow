import test from 'node:test'
import assert from 'node:assert/strict'
import { canDirectPlayVideoCodec, canUseDirectLocalVideo, needsCompanionAudio } from '../src/shared/playbackPolicy'

test('embedded audio and subtitles never disqualify a compatible local video', () => {
  assert.equal(canUseDirectLocalVideo({ local: true, live: false, remote: false }), true)
})

test('only an external burn-in subtitle keeps the legacy proxy path', () => {
  assert.equal(canUseDirectLocalVideo({ local: true, live: false, remote: false, externalSubtitleNeedsBurnIn: true }), false)
})

test('unsupported embedded audio is handled independently of the picture', () => {
  assert.equal(needsCompanionAudio('eac3', 0, 0), true)
  assert.equal(needsCompanionAudio('aac', 0, 1), false)
})

test('legacy mp4v video is not treated as Chromium-direct compatible', () => {
  assert.equal(canDirectPlayVideoCodec('mpeg4', 'mp4v', 8), false)
  assert.equal(canUseDirectLocalVideo({ local: true, live: false, remote: false, videoCodec: 'mpeg4', videoCodecTag: 'mp4v' }), false)
})

test('common Chromium video codecs keep the direct path', () => {
  assert.equal(canDirectPlayVideoCodec('h264', 'avc1', 8), true)
  assert.equal(canDirectPlayVideoCodec('hevc', 'hvc1', 10), true)
  assert.equal(canDirectPlayVideoCodec('h264', 'avc1', 10), false)
})
