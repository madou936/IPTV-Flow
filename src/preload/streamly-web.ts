import { contextBridge } from 'electron'

// Run before YouTube's scripts in the page's own world. Only remove fields
// used for advertising from player responses; media and caption data stay intact.
if (location.hostname === 'youtube.com' || location.hostname.endsWith('.youtube.com')) {
  contextBridge.executeInMainWorld({ func: () => {
    const clean = (value: unknown, depth = 0): unknown => {
      if (!value || typeof value !== 'object' || depth > 5) return value
      const object = value as Record<string, unknown>
      if (object.videoDetails || object.streamingData || object.playabilityStatus) {
        delete object.playerAds
        delete object.adPlacements
        delete object.adSlots
      }
      for (const key of ['playerResponse', 'player', 'response']) if (object[key]) clean(object[key], depth + 1)
      return value
    }
    const originalParse = JSON.parse
    JSON.parse = function (...args: Parameters<typeof JSON.parse>): ReturnType<typeof JSON.parse> {
      const parsed = originalParse.apply(JSON, args)
      const text = args[0]
      return typeof text === 'string' && (text.includes('"adPlacements"') || text.includes('"playerAds"') || text.includes('"adSlots"')) ? clean(parsed) : parsed
    }
    const originalJson = Response.prototype.json
    Response.prototype.json = function (): Promise<unknown> { return originalJson.call(this).then((value) => clean(value)) }
    try {
      let initial: unknown
      Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get: () => initial, set: (value: unknown) => { initial = clean(value) } })
    } catch { /* YouTube may have defined the property first. */ }
  } })
}

if (location.hostname === 'netflix.com' || location.hostname.endsWith('.netflix.com')) {
  contextBridge.executeInMainWorld({ func: () => {
    const clean = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value
      const result = (value as { result?: unknown }).result
      if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'adverts')) {
        delete (result as { adverts?: unknown }).adverts
      }
      return value
    }
    const parse = JSON.parse
    JSON.parse = function (...args: Parameters<typeof JSON.parse>): ReturnType<typeof JSON.parse> {
      return clean(parse.apply(JSON, args))
    }
    const json = Response.prototype.json
    Response.prototype.json = function (): Promise<unknown> { return json.call(this).then(clean) }
  } })
}
