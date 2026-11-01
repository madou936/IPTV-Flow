import type { Credentials } from '../types'

export interface IPTVProfile {
  id: string
  label: string
  credentials: Credentials
  lastUsedAt: number
}

const PROFILES_KEY = 'iptv_profiles_v1'
const ACTIVE_PROFILE_KEY = 'iptv_active_profile_v1'
const LEGACY_CREDENTIALS_KEY = 'iptv_creds'
const LEGACY_PREFILL_KEY = 'iptv_prefill'

function isCredentials(value: unknown): value is Credentials {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return ['url', 'username', 'password'].every((key) => typeof candidate[key] === 'string' && candidate[key].trim())
}

function isProfile(value: unknown): value is IPTVProfile {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string' && typeof candidate.label === 'string' &&
    typeof candidate.lastUsedAt === 'number' && isCredentials(candidate.credentials)
}

function readJson(key: string): unknown {
  try {
    const saved = localStorage.getItem(key)
    return saved ? JSON.parse(saved) : null
  } catch {
    return null
  }
}

function sameCredentials(a: Credentials, b: Credentials): boolean {
  return a.url.trim().replace(/\/+$/, '').toLowerCase() === b.url.trim().replace(/\/+$/, '').toLowerCase() &&
    a.username.trim() === b.username.trim() && a.password === b.password
}

function writeProfiles(profiles: IPTVProfile[]): void {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
}

function legacyProfile(): IPTVProfile | null {
  const legacy = readJson(LEGACY_CREDENTIALS_KEY) ?? readJson(LEGACY_PREFILL_KEY)
  if (!isCredentials(legacy)) return null
  return {
    id: `legacy-${Date.now()}`,
    label: legacy.username.trim() || 'Compte IPTV',
    credentials: legacy,
    lastUsedAt: Date.now()
  }
}

/** Returns all valid locally saved IPTV profiles, migrating the prior single-account setup once. */
export function listProfiles(): IPTVProfile[] {
  const parsed = readJson(PROFILES_KEY)
  if (Array.isArray(parsed)) return parsed.filter(isProfile).sort((a, b) => b.lastUsedAt - a.lastUsedAt)

  const legacy = legacyProfile()
  if (!legacy) return []
  writeProfiles([legacy])
  localStorage.setItem(ACTIVE_PROFILE_KEY, legacy.id)
  return [legacy]
}

export function getActiveProfile(): IPTVProfile | null {
  const activeId = localStorage.getItem(ACTIVE_PROFILE_KEY)
  const profiles = listProfiles()
  return profiles.find((profile) => profile.id === activeId) ?? null
}

export function saveProfile(credentials: Credentials, requestedLabel?: string): IPTVProfile {
  const profiles = listProfiles()
  const now = Date.now()
  const existing = profiles.find((profile) => sameCredentials(profile.credentials, credentials))
  const profile: IPTVProfile = {
    id: existing?.id ?? `${now}-${Math.random().toString(36).slice(2, 9)}`,
    label: requestedLabel?.trim() || existing?.label || credentials.username.trim() || 'Compte IPTV',
    credentials: {
      url: credentials.url.trim(),
      username: credentials.username.trim(),
      password: credentials.password
    },
    lastUsedAt: now
  }
  writeProfiles([profile, ...profiles.filter((item) => item.id !== profile.id)])
  localStorage.setItem(ACTIVE_PROFILE_KEY, profile.id)
  return profile
}

/** Replace a named profile after its edited credentials have been validated. */
export function updateProfile(id: string, credentials: Credentials, requestedLabel?: string): IPTVProfile {
  const profiles = listProfiles()
  const current = profiles.find((profile) => profile.id === id)
  if (!current) return saveProfile(credentials, requestedLabel)

  const now = Date.now()
  const profile: IPTVProfile = {
    id,
    label: requestedLabel?.trim() || current.label || credentials.username.trim() || 'Compte IPTV',
    credentials: {
      url: credentials.url.trim(),
      username: credentials.username.trim(),
      password: credentials.password
    },
    lastUsedAt: now
  }
  // Editing a profile into credentials that already exist merges the duplicate
  // instead of leaving two indistinguishable choices on the welcome screen.
  writeProfiles([profile, ...profiles.filter((item) => item.id !== id && !sameCredentials(item.credentials, profile.credentials))])
  localStorage.setItem(ACTIVE_PROFILE_KEY, profile.id)
  return profile
}

export function removeProfile(id: string): void {
  const remaining = listProfiles().filter((profile) => profile.id !== id)
  writeProfiles(remaining)
  if (localStorage.getItem(ACTIVE_PROFILE_KEY) === id) localStorage.removeItem(ACTIVE_PROFILE_KEY)
}
