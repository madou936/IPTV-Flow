import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

// ---------------------------------------------------------------------------
// Sidecar subtitle reader (phase 2). Text subs (.srt/.vtt) next to a local T7
// file are turned into WebVTT and handed to the renderer, which attaches them
// as a programmatic <track> — NO ffmpeg re-encode, so seeking stays the light
// remux path (the burn-in route is kept only for styled .ass/.ssa).
// ---------------------------------------------------------------------------

/** True for subtitle formats we can render as a text track (vs. burn-in). */
export function isTextSub(path: string): boolean {
  const e = extname(path).toLowerCase()
  return e === '.srt' || e === '.vtt'
}

function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r+/g, '')
    .replace(/^﻿/, '')
    // SRT uses comma decimals in timestamps; WebVTT wants dots.
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim()
  return `WEBVTT\n\n${body}\n`
}

/** Read a sidecar .srt/.vtt and return WebVTT text. Resolves '' on any failure
 * (caller falls back to the burn-in path). Handles UTF-8, UTF-16 LE/BE, and
 * Latin-1 encodings — OpenSubtitles files can arrive in any of these. */
export async function readSidecarVtt(path: string): Promise<string> {
  try {
    if (!isTextSub(path)) return ''
    const buf = await readFile(path)
    let raw: string
    if (buf[0] === 0xFF && buf[1] === 0xFE) {
      // UTF-16 LE BOM
      raw = buf.slice(2).toString('utf16le')
    } else if (buf[0] === 0xFE && buf[1] === 0xFF) {
      // UTF-16 BE BOM — swap byte pairs then decode as LE
      const content = buf.slice(2)
      const swapped = Buffer.alloc(content.length)
      for (let i = 0; i + 1 < content.length; i += 2) {
        swapped[i] = content[i + 1]
        swapped[i + 1] = content[i]
      }
      raw = swapped.toString('utf16le')
    } else {
      // UTF-8 (with or without BOM) or Latin-1
      raw = buf.toString('utf8').replace(/^﻿/, '')
    }
    return extname(path).toLowerCase() === '.vtt' ? raw : srtToVtt(raw)
  } catch {
    return ''
  }
}
