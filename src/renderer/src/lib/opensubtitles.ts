import type { DownloadSubResult, OsubResult } from '../types'

interface OsubBridge {
  getSettings: () => Promise<{ username: string; password: string; hasPassword: boolean }>
  setCredentials: (username: string, password: string) => Promise<void>
  search: (query: string, lang: string, year?: number) => Promise<OsubResult[]>
  download: (fileId: number, fileName: string) => Promise<DownloadSubResult>
}

function bridge(): OsubBridge | undefined {
  return (window as unknown as { host?: { osub?: OsubBridge } }).host?.osub
}

export function getOsubSettings(): Promise<{ username: string; password: string; hasPassword: boolean }> {
  return bridge()?.getSettings() ?? Promise.resolve({ username: '', password: '', hasPassword: false })
}

export function setOsubCredentials(username: string, password: string): Promise<void> {
  return bridge()?.setCredentials(username, password) ?? Promise.resolve()
}

export function searchSubtitles(
  query: string,
  lang: string,
  year?: number
): Promise<OsubResult[]> {
  return bridge()?.search(query, lang, year) ?? Promise.resolve([])
}

export function downloadSubtitle(fileId: number, fileName: string): Promise<DownloadSubResult> {
  return bridge()?.download(fileId, fileName) ?? Promise.resolve({ error: 'Non disponible' })
}
