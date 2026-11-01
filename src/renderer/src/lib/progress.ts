interface Entry {
  pos: number
  dur: number
  ts: number
  completed?: boolean
}

const KEY = 'iptv_progress'
const EVENT = 'iptv-progress-changed'
const HIDDEN_KEY = 'iptv_continue_hidden'
const NEAR_END = 0.95 // treat as "finished" past this fraction
const BADGE_PROGRESS = 0.8
const MIN_SAVE = 5 // don't bother saving the first few seconds
const MAX_ENTRIES = 400
const MIN_RESUME = 180 // 3 minutes — don't offer resume for very short watches

function loadAll(): Record<string, Entry> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Entry>
  } catch {
    return {}
  }
}

function saveAll(map: Record<string, Entry>): void {
  const keys = Object.keys(map)
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => map[a].ts - map[b].ts)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete map[k])
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* ignore */
  }
}

function loadHidden(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) || '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function saveHidden(map: Record<string, number>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(map))
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* ignore */
  }
}

export interface ProgressEntry {
  pos: number
  dur: number
  ts: number
  completed?: boolean
}

export interface ProgressState {
  pos: number
  dur: number
  pct: number
  seen: boolean
  completed: boolean
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Saved resume position in seconds (0 = start from the beginning). */
export function getProgress(key: string): number {
  const e = loadAll()[key]
  if (!e) return 0
  if (e.completed || (e.dur && e.pos >= e.dur * NEAR_END)) return 0
  return e.pos > MIN_RESUME ? e.pos : 0
}

/** Remove a progress entry (e.g. user dismisses from "En cours"). */
export function removeProgress(key: string): void {
  const all = loadAll()
  delete all[key]
  saveAll(all)
}

/** Hide an item from "En cours" without deleting its resume position. */
export function hideFromContinue(keys: string[]): void {
  const hidden = loadHidden()
  for (const key of keys) hidden[key] = Date.now()
  saveHidden(hidden)
}

/** Playing an item makes it eligible to appear in "En cours" again. */
export function revealInContinue(key: string): void {
  const hidden = loadHidden()
  if (!(key in hidden)) return
  delete hidden[key]
  saveHidden(hidden)
}

export function isHiddenFromContinue(key: string): boolean {
  return key in loadHidden()
}

export function setProgress(key: string, pos: number, dur: number): void {
  const all = loadAll()
  if (dur && pos >= dur * NEAR_END) {
    all[key] = { pos: dur, dur, ts: Date.now(), completed: true }
  } else if (pos > MIN_SAVE) {
    all[key] = { pos, dur, ts: Date.now(), completed: false }
  } else {
    return
  }
  saveAll(all)
}

export function markCompleted(key: string, dur = 0): void {
  const all = loadAll()
  const prev = all[key]
  const finalDur = dur > 0 ? dur : prev?.dur ?? 0
  const finalPos = finalDur > 0 ? finalDur : Math.max(prev?.pos ?? 0, MIN_SAVE)
  all[key] = { pos: finalPos, dur: finalDur, ts: Date.now(), completed: true }
  saveAll(all)
}

export function setSeen(key: string, seen: boolean, dur = 0): void {
  if (!seen) {
    removeProgress(key)
    return
  }
  markCompleted(key, dur)
}

/** Returns all stored progress entries (keyed by resumeKey). */
export function getAllProgress(): Record<string, ProgressEntry> {
  return loadAll()
}

export function getProgressState(key: string): ProgressState {
  const e = loadAll()[key]
  if (!e) return { pos: 0, dur: 0, pct: 0, seen: false, completed: false }
  const completed = !!e.completed
  const pct = completed ? 1 : (e.dur > 0 ? clamp01(e.pos / e.dur) : 0)
  return {
    pos: e.pos,
    dur: e.dur,
    pct,
    seen: completed || pct >= BADGE_PROGRESS,
    completed
  }
}

export function hasEpisodeBadge(key: string): boolean {
  return getProgressState(key).seen
}

export function onProgressChange(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
