import test from 'node:test'
import assert from 'node:assert/strict'
import { buildArgs } from '../src/main/proxy'

const base = { live: false, start: 0, audio: 0, sub: -1, subBitmap: false, subPath: '', forceVideoTranscode: false }

test('proxy audio fallback preserves the source video bitstream', () => {
  const args = buildArgs('/tmp/movie.mkv', base, false)
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'copy'])
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'aac'])
  assert.equal(args.includes('-avoid_negative_ts'), false)
})

test('video is transcoded only after a direct video rejection', () => {
  const args = buildArgs('/tmp/legacy.mp4', { ...base, forceVideoTranscode: true }, true)
  assert.ok(args.includes('h264_videotoolbox'))
})

test('live AAC keeps the source audio and video timestamps together', () => {
  const args = buildArgs('http://localhost/live.ts', { ...base, live: true }, true)
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'copy'])
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'copy'])
  assert.deepEqual(args.slice(args.indexOf('-bsf:a'), args.indexOf('-bsf:a') + 2), ['-bsf:a', 'aac_adtstoasc'])
  assert.equal(args.join(' ').includes('nobuffer'), false)
})

test('live non-AAC audio is resampled against its source timestamps', () => {
  const args = buildArgs('http://localhost/live.ts', { ...base, live: true }, false)
  assert.deepEqual(args.slice(args.indexOf('-af'), args.indexOf('-af') + 2), ['-af', 'aresample=async=1000'])
  assert.equal(args.join(' ').includes('first_pts=0'), false)
})
