import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve4 } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import { createServer, Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'

const unpack = (p?: string | null): string | undefined => p?.replace('app.asar', 'app.asar.unpacked')
const ffmpegPath = unpack(ffmpegStatic as unknown as string)

const { Client, DefaultMediaReceiver } = require('castv2-client') as {
  Client: new () => CastClient
  DefaultMediaReceiver: unknown
}
const multicastDns = require('multicast-dns') as () => MdnsBrowser

interface CastClient {
  connect: (options: { host: string; port: number }, cb: () => void) => void
  launch: (receiver: unknown, cb: (err: Error | null, player?: CastPlayer) => void) => void
  close: () => void
  on: (event: 'error', cb: (err: Error) => void) => void
}

interface CastPlayer {
  load: (media: CastMedia, opts: { autoplay: boolean; currentTime?: number }, cb: (err: Error | null, status?: { playerState?: string }) => void) => void
  on: (event: 'status', cb: (status: { playerState?: string }) => void) => void
}

interface MdnsRecord {
  name: string
  type: 'PTR' | 'SRV' | 'A' | 'AAAA' | 'TXT' | string
  data: string | Buffer[] | { port: number; target: string } | unknown
}

interface MdnsPacket {
  answers?: MdnsRecord[]
  additionals?: MdnsRecord[]
}

interface MdnsBrowser {
  on: (event: 'response', cb: (packet: MdnsPacket) => void) => void
  query: (packet: { questions: Array<{ name: string; type: string }> }) => void
  destroy: () => void
}

export interface CastDevice {
  id: string
  name: string
  host: string
  port: number
  model?: string
}

interface CastMedia {
  contentId: string
  contentType: string
  streamType: 'BUFFERED' | 'LIVE'
  metadata: {
    type: 0
    metadataType: 0
    title: string
  }
}

interface CastStreamOptions {
  audio?: number
  sub?: number
  subBitmap?: boolean
  subPath?: string
}

let server: Server | null = null
let token = ''
let port = 0
let currentPath = ''
let currentOptions: CastStreamOptions = {}
let activeClient: CastClient | null = null

function localPath(src: string): string | null {
  if (src.startsWith('file://')) {
    try { return fileURLToPath(src) } catch { return null }
  }
  // T7 entries are normally absolute paths, while remote IPTV URLs are not
  // eligible for this local file server.
  return /^[\\/]/.test(src) ? src : null
}

function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function contentTypeFor(src: string): string {
  switch (extname(src.split('?')[0]).toLowerCase()) {
    case '.mp4':
    case '.m4v': return 'video/mp4'
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    case '.m3u8': return 'application/x-mpegURL'
    case '.mpd': return 'application/dash+xml'
    case '.mkv': return 'video/x-matroska'
    default: return 'video/mp4'
  }
}

function txtValues(data: unknown): string[] {
  if (!Array.isArray(data)) return []
  return data
    .map((part) => Buffer.isBuffer(part) ? part.toString('utf8') : String(part))
    .filter(Boolean)
}

function parseTxt(data: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const value of txtValues(data)) {
    const idx = value.indexOf('=')
    if (idx > 0) out[value.slice(0, idx)] = value.slice(idx + 1)
  }
  return out
}

function escapeSubtitlePath(path: string): string {
  return path
    .replace(/'/g, "\\\\'")
    .replace(/:/g, '\\\\:')
    .replace(/,/g, '\\\\,')
    .replace(/\[/g, '\\\\[')
    .replace(/\]/g, '\\\\]')
}

function streamCastMedia(path: string, start: number, opts: CastStreamOptions, res: import('node:http').ServerResponse): void {
  if (!ffmpegPath) {
    res.writeHead(500).end('ffmpeg introuvable')
    return
  }
  const args = ['-loglevel', 'error', '-nostdin']
  if (start > 0) args.push('-ss', String(Math.floor(start)))
  args.push('-i', path)
  const audio = Number.isFinite(opts.audio) && (opts.audio ?? 0) >= 0 ? Math.floor(opts.audio ?? 0) : 0
  const sub = Number.isFinite(opts.sub) && (opts.sub ?? -1) >= 0 ? Math.floor(opts.sub ?? -1) : -1
  const subPath = opts.subPath || ''
  const burning = sub >= 0 || !!subPath
  if (burning) {
    if (opts.subBitmap && sub >= 0) {
      args.push('-filter_complex', `[0:v:0][0:s:${sub}]overlay[v]`, '-map', '[v]')
    } else {
      const subFile = subPath || path
      const filter = subPath
        ? `subtitles=${escapeSubtitlePath(subFile)}`
        : `subtitles=${escapeSubtitlePath(subFile)}:si=${sub}`
      const vf = start > 0
        ? `setpts=PTS+${Math.floor(start)}/TB,${filter},setpts=PTS-${Math.floor(start)}/TB`
        : filter
      args.push('-map', '0:v:0', '-vf', vf)
    }
    args.push('-map', `0:a:${audio}?`, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-crf', '21')
  } else {
    args.push('-map', '0:v:0', '-map', `0:a:${audio}?`, '-c:v', 'copy')
  }
  args.push(
    '-c:a', 'aac',
    '-ac', '2',
    '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets',
    '-frag_duration', '500000',
    '-f', 'mp4',
    'pipe:1'
  )
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  ff.stdout.pipe(res)
  const kill = (): void => {
    try { ff.kill('SIGKILL') } catch { /* gone */ }
  }
  res.on('close', kill)
  ff.on('error', () => res.end())
  ff.on('exit', () => res.end())
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} a expiré`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export async function startLocalCast(src: string, start = 0, opts: CastStreamOptions = {}): Promise<{ url: string; contentType: string } | null> {
  if (/^https?:\/\//i.test(src)) return { url: src, contentType: contentTypeFor(src) }

  const path = localPath(src)
  if (!path) return null
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return null

  currentPath = path
  currentOptions = opts
  token = randomBytes(18).toString('hex')
  if (!server) {
    server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname !== '/media' || url.searchParams.get('token') !== token) {
        res.writeHead(404).end()
        return
      }
      const current = await stat(currentPath).catch(() => null)
      if (!current?.isFile()) { res.writeHead(404).end(); return }
      streamCastMedia(currentPath, Number(url.searchParams.get('start') || '0'), currentOptions, res)
    })
    const activeServer = server
    try {
      await new Promise<void>((resolve, reject) => {
        activeServer.once('error', reject)
        activeServer.listen(0, '0.0.0.0', () => {
          activeServer.removeListener('error', reject)
          resolve()
        })
      })
      port = (activeServer.address() as { port: number }).port
    } catch (error) {
      server.close(() => undefined)
      server = null
      throw error
    }
  }
  const url = new URL(`http://${lanAddress()}:${port}/media`)
  url.searchParams.set('token', token)
  if (start > 0) url.searchParams.set('start', String(Math.floor(start)))
  return { url: url.toString(), contentType: 'video/mp4' }
}

export function discoverCastDevices(timeoutMs = 3500): Promise<CastDevice[]> {
  return new Promise((resolve) => {
    const mdns = multicastDns()
    const serviceByName = new Map<string, { host?: string; port?: number; address?: string; txt?: Record<string, string> }>()
    const query = (name: string, type: string): void => {
      try { mdns.query({ questions: [{ name, type }] }) } catch { /* ignore mdns send errors */ }
    }
    const ingest = (records: MdnsRecord[] = []): void => {
      for (const record of records) {
        if (record.type === 'PTR' && record.name === '_googlecast._tcp.local' && typeof record.data === 'string') {
          if (!serviceByName.has(record.data)) serviceByName.set(record.data, {})
          query(record.data, 'SRV')
          query(record.data, 'TXT')
        } else if (record.type === 'SRV' && typeof record.data === 'object' && record.data && 'target' in record.data) {
          const data = record.data as { port: number; target: string }
          const service = serviceByName.get(record.name) ?? {}
          service.host = data.target
          service.port = data.port
          serviceByName.set(record.name, service)
          query(data.target, 'A')
        } else if ((record.type === 'A' || record.type === 'AAAA') && typeof record.data === 'string') {
          for (const service of serviceByName.values()) {
            if (service.host === record.name && !service.address) service.address = record.data
          }
        } else if (record.type === 'TXT') {
          const service = serviceByName.get(record.name) ?? {}
          service.txt = { ...service.txt, ...parseTxt(record.data) }
          serviceByName.set(record.name, service)
        }
      }
    }

    mdns.on('response', (packet) => {
      ingest(packet.answers)
      ingest(packet.additionals)
    })

    query('_googlecast._tcp.local', 'PTR')
    const interval = setInterval(() => query('_googlecast._tcp.local', 'PTR'), 900)
    setTimeout(() => {
      clearInterval(interval)
      mdns.destroy()
      const devices = Array.from(serviceByName.entries())
        .map(([serviceName, service]) => ({
          id: service.txt?.id || service.address || serviceName,
          name: service.txt?.fn || serviceName.replace(/\._googlecast\._tcp\.local\.?$/i, ''),
          host: service.address || '',
          port: service.port || 8009,
          model: service.txt?.md
        }))
        .filter((device) => !!device.host)
      discoverDnsSdCastDevices(timeoutMs)
        .then((fallback) => resolve(mergeDevices(devices, fallback)))
        .catch(() => resolve(devices))
    }, timeoutMs)
  })
}

function mergeDevices(primary: CastDevice[], fallback: CastDevice[]): CastDevice[] {
  const seen = new Set<string>()
  const out: CastDevice[] = []
  for (const device of [...primary, ...fallback]) {
    const key = device.id || `${device.host}:${device.port}`
    if (!device.host || seen.has(key)) continue
    seen.add(key)
    out.push(device)
  }
  return out
}

function runDnsSd(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/dns-sd', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (data) => { out += data.toString('utf8') })
    child.stderr.on('data', (data) => { out += data.toString('utf8') })
    const finish = (): void => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolve(out)
    }
    const timer = setTimeout(finish, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(out)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

function parseBrowse(output: string): string[] {
  const names = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\sAdd\s+\d+\s+\d+\s+local\.\s+_googlecast\._tcp\.\s+(.+)$/)
    if (match?.[1]) names.add(match[1].trim())
  }
  return Array.from(names)
}

function parseTxtPairs(output: string): Record<string, string> {
  const txt: Record<string, string> = {}
  const normalized = output.replace(/\\\[/g, '[').replace(/\\\]/g, ']')
  for (const match of normalized.matchAll(/\s([a-z]{2})=([^\s]+)/gi)) {
    txt[match[1]] = match[2]
  }
  return txt
}

async function resolveDnsSdAddress(host: string): Promise<string> {
  const normalized = host.replace(/\.$/, '')
  try {
    const ips = await resolve4(normalized)
    if (ips[0]) return ips[0]
  } catch {
    // mDNS names often do not resolve through Node's DNS path on macOS.
  }
  const output = await runDnsSd(['-G', 'v4', normalized], 1400)
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\sAdd\s+\d+\s+\d+\s+(.+)$/)
    const ip = match?.[1]?.trim()
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip
  }
  return normalized
}

async function discoverDnsSdCastDevices(timeoutMs: number): Promise<CastDevice[]> {
  if (process.platform !== 'darwin') return []
  const browse = await runDnsSd(['-B', '_googlecast._tcp', 'local'], Math.max(1200, Math.min(timeoutMs, 2600)))
  const serviceNames = parseBrowse(browse)
  const devices: CastDevice[] = []
  for (const name of serviceNames) {
    const details = await runDnsSd(['-L', name, '_googlecast._tcp', 'local'], 1600)
    const endpoint = details.match(/can be reached at\s+(.+?):(\d+)/)
    if (!endpoint) continue
    const host = endpoint[1].trim()
    const portNumber = Number(endpoint[2])
    const txt = parseTxtPairs(details)
    const address = await resolveDnsSdAddress(host)
    devices.push({
      id: txt.id || address || name,
      name: txt.fn || name,
      host: address,
      port: Number.isFinite(portNumber) ? portNumber : 8009,
      model: txt.md
    })
  }
  return devices
}

export async function castMedia(device: CastDevice, src: string, title: string, currentTime: number, isLive: boolean, opts: CastStreamOptions = {}): Promise<{ url: string; playerState?: string }> {
  const castStart = isLive ? 0 : Math.max(0, currentTime || 0)
  const local = await startLocalCast(src, castStart, opts)
  if (!local) throw new Error('Ce contenu ne peut pas être servi au réseau local.')

  if (activeClient) {
    try { activeClient.close() } catch { /* ignore stale clients */ }
    activeClient = null
  }

  const client = new Client()
  activeClient = client
  client.on('error', () => {
    if (activeClient === client) activeClient = null
    try { client.close() } catch { /* ignore */ }
  })

  await withTimeout(new Promise<void>((resolve, reject) => {
    client.on('error', reject)
    client.connect({ host: device.host, port: device.port || 8009 }, resolve)
  }), 9000, 'La connexion Google Cast')
  const player = await withTimeout(new Promise<CastPlayer>((resolve, reject) => {
    client.launch(DefaultMediaReceiver, (err, launched) => {
      if (err || !launched) reject(err || new Error('Receiver Google Cast introuvable.'))
      else resolve(launched)
    })
  }), 9000, 'Le lancement du receiver')
  const media: CastMedia = {
    contentId: local.url,
    contentType: local.contentType,
    streamType: isLive ? 'LIVE' : 'BUFFERED',
    metadata: { type: 0, metadataType: 0, title }
  }
  const status = await withTimeout(new Promise<{ playerState?: string }>((resolve, reject) => {
    player.load(media, { autoplay: true, currentTime: 0 }, (err, nextStatus) => {
      if (err) reject(err)
      else resolve(nextStatus ?? {})
    })
  }), 12000, 'Le chargement de la vidéo sur AirScreen')
  return { url: local.url, playerState: status.playerState }
}
