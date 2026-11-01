import { useEffect, useRef, useState } from 'react'
import type {
  ContentSection,
  Credentials,
  Episode,
  LiveStream,
  LocalEpisode,
  LocalMovie,
  LocalShow,
  MediaTarget,
  MediaQueueItem,
  MediaQueueGroup,
  Section,
  Series,
  UserInfo,
  VodStream
} from './types'
import { authenticate, getLiveCategories, getSeriesCategories, getVodCategories, getVodInfo, liveStreamUrl, seriesStreamUrl, vodStreamUrl } from './api/xtream'
import { durationToSecs, exportXtreamOrganisation } from './lib/proxy'
import { clearCatalog } from './lib/catalog'
import { FavoritesProvider, useFavorites } from './lib/favorites'
import { DownloadsProvider, useDownloads } from './lib/downloads'
import { T7Provider, useT7, probeT7Duration } from './lib/t7'
import LoginScreen from './components/LoginScreen'
import Sidebar, { T7MinimalSidebar } from './components/Sidebar'
import ContentBrowser from './components/ContentBrowser'
import SeriesDetail from './components/SeriesDetail'
import Player from './components/Player'
import Downloads from './components/Downloads'
import T7Browser from './components/T7Browser'
import AppSettingsModal from './components/AppSettingsModal'
import T7AssetPreloader from './components/T7AssetPreloader'
import Streamly from './components/Streamly'
import { revealInContinue } from './lib/progress'
import { loadPrefs } from './lib/categories'
import { getActiveProfile, listProfiles, removeProfile, saveProfile, updateProfile } from './lib/profiles'
import type { IPTVProfile } from './lib/profiles'

function hostDebugMediaPath(): string {
  return (window as unknown as { host?: { debugMediaPath?: string } }).host?.debugMediaPath || ''
}

function titleFromPath(path: string): string {
  return decodeURIComponent(path.split('/').pop() || path || 'Debug media')
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function naturallySortPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => fileName(a).localeCompare(fileName(b), 'fr', { numeric: true, sensitivity: 'base' }))
}

function orderedLocalSeasons(show: LocalShow): LocalShow['seasons'] {
  return [...show.seasons.filter((s) => s.season !== 0), ...show.seasons.filter((s) => s.season === 0)]
}

function AppInner(): JSX.Element {
  const [booting, setBooting] = useState(true)
  const [t7Only, setT7Only] = useState(false)
  const [creds, setCreds] = useState<Credentials | null>(null)
  const [profiles, setProfiles] = useState<IPTVProfile[]>(() => listProfiles())
  const [account, setAccount] = useState<UserInfo | null>(null)
  const [profileName, setProfileName] = useState('')
  const [section, setSection] = useState<Section>(() => {
    const saved = sessionStorage.getItem('iptv:active-section')
    return saved && ['live', 'movies', 'series', 'downloads', 't7flix', 'streamly'].includes(saved) ? saved as Section : 'live'
  })
  const [media, setMedia] = useState<MediaTarget | null>(null)
  const [seriesDetail, setSeriesDetail] = useState<Series | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [streamlyMenuOpen, setStreamlyMenuOpen] = useState(false)
  const [streamlyFullScreen, setStreamlyFullScreen] = useState(false)
  function selectSection(next: Section): void {
    if (next === 'streamly' && section === 'streamly') setStreamlyMenuOpen((open) => !open)
    else { setStreamlyMenuOpen(false); if (next !== 'streamly') setStreamlyFullScreen(false); setSection(next) }
  }
  useEffect(() => { sessionStorage.setItem('iptv:active-section', section) }, [section])
  useEffect(() => {
    const host = (window as unknown as { host?: { onOpenSettings?: (fn: () => void) => () => void } }).host
    if (!host?.onOpenSettings) return
    return host.onOpenSettings(() => setSettingsOpen(true))
  }, [])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebar_collapsed') === '1'
  )
  function toggleSidebar(): void {
    setSidebarCollapsed((v) => {
      localStorage.setItem('sidebar_collapsed', v ? '0' : '1')
      return !v
    })
  }
  const exporterRef = useRef<(() => void) | null>(null)
  const debugMediaLoadedRef = useRef(false)
  const { available: t7Available } = useT7()
  const { favorites } = useFavorites()

  useEffect(() => {
    const debugPath = hostDebugMediaPath()
    if (!debugPath || debugMediaLoadedRef.current) return
    debugMediaLoadedRef.current = true
    setBooting(false)
    setMedia({
      title: titleFromPath(debugPath),
      subtitle: 'Diagnostic local',
      isLive: false,
      src: debugPath,
      local: true,
      autoResume: false,
      fetchInfo: () => probeT7Duration(debugPath).then((d) => ({ durationSecs: d }))
    })
  }, [])

  // If the T7 is unplugged: fall back to Live (so we never sit on a dead
  // section) and stop any playback that was reading a file off the SSD.
  useEffect(() => {
    if (!t7Available && !hostDebugMediaPath()) {
      if (section === 't7flix') setSection('live')
      if (media?.requiresT7) setMedia(null)
    }
  }, [section, t7Available, media])

  // T7Flix is the preferred home whenever the SSD is already mounted, whether
  // the Xtream account is configured or not.
  useEffect(() => {
    if (!t7Available) return
    setT7Only(!creds)
    setSection('t7flix')
  }, [t7Available, creds])

  useEffect(() => {
    const activeProfile = getActiveProfile()
    if (!activeProfile) {
      setBooting(false)
      return
    }
    authenticate(activeProfile.credentials)
      .then((res) => {
        setCreds(activeProfile.credentials)
        setAccount(res.user_info)
        setProfileName(activeProfile.label)
      })
      .catch(() => undefined)
      .finally(() => setBooting(false))
  }, [])

  function handleLogin(c: Credentials, user: UserInfo, profileLabel: string, profileId?: string): void {
    if (profileId) updateProfile(profileId, c, profileLabel)
    else saveProfile(c, profileLabel)
    setProfiles(listProfiles())
    setCreds(c)
    setAccount(user)
    setProfileName(profileLabel)
    setT7Only(false)
  }

  function handleSwitchProfile(): void {
    clearCatalog()
    setCreds(null)
    setAccount(null)
    setProfileName('')
    setMedia(null)
    setSeriesDetail(null)
    setSection('live')
  }

  function handleRemoveProfile(profileId: string): void {
    removeProfile(profileId)
    setProfiles(listProfiles())
  }

  async function exportOrganisation(): Promise<void> {
    if (!creds) return
    const [live, movies, series] = await Promise.all([
      getLiveCategories(creds),
      getVodCategories(creds),
      getSeriesCategories(creds)
    ])
    const sections = [
      ['live', 'TV en Direct', live],
      ['movies', 'Films', movies],
      ['series', 'Séries', series]
    ].map(([id, label, categories]) => {
      const list = categories as import('./types').Category[]
      const prefs = loadPrefs(id as ContentSection)
      const byId = new Map(list.map((category) => [category.category_id, category.category_name]))
      return {
        id,
        label,
        order: prefs.order.map((category_id) => ({ category_id, category_name: byId.get(category_id) || category_id })),
        hidden: prefs.hidden.map((category_id) => ({ category_id, category_name: byId.get(category_id) || category_id })),
        visible_categories: list
          .filter((category) => !prefs.hidden.includes(category.category_id))
          .map((category) => ({ category_id: category.category_id, category_name: category.category_name }))
      }
    })
    await exportXtreamOrganisation(JSON.stringify({
      exported_at: new Date().toISOString(),
      app: 'IPTV Flow',
      sections,
      favorites: favorites.filter((favorite) => ['live', 'movie', 'series'].includes(favorite.kind))
    }, null, 2))
  }

  function playLive(stream: LiveStream): void {
    if (!creds) return
    setMedia({
      title: stream.name,
      subtitle: 'En direct',
      isLive: true,
      src: liveStreamUrl(creds, stream.stream_id, 'ts')
    })
  }

  function playVod(vod: VodStream): void {
    if (!creds) return
    setMedia({
      title: vod.name,
      isLive: false,
      src: vodStreamUrl(creds, vod.stream_id, vod.container_extension || 'mp4'),
      resumeKey: `movie-${vod.stream_id}`,
      fetchInfo: () =>
        getVodInfo(creds, vod.stream_id).then((r) => ({
          durationSecs: durationToSecs(r.info as Record<string, never>)
        }))
    })
  }

  const { start: startDownload } = useDownloads()

  function downloadVod(vod: VodStream): void {
    if (!creds) return
    const ext = vod.container_extension || 'mp4'
    void startDownload({
      id: `movie-${vod.stream_id}`,
      title: vod.name,
      src: vodStreamUrl(creds, vod.stream_id, ext),
      ext,
      durationSecs: undefined
    })
  }

  function playDownload(item: import('./types').DownloadItem): void {
    setMedia({
      title: item.title,
      subtitle: item.subtitle,
      isLive: false,
      src: item.filePath,
      durationSecs: item.durationSecs,
      resumeKey: `download-${item.id}`
    })
  }

  function playLocalFiles(chosen: string[]): void {
    if (!chosen.length) return
    if (section === 'streamly') setSection(t7Available ? 't7flix' : 'live')
    const paths = naturallySortPaths(chosen)
    const hasEpisodeNumbers = paths.length > 1 && paths.every((path) => /(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3})/i.test(fileName(path)))
    const queue: MediaQueueItem[] = paths.map((path) => {
      const name = fileName(path).replace(/\.[^.]+$/, '')
      const episode = name.match(/(?:s(\d{1,2})\s*e(\d{1,3})|(\d{1,2})x(\d{1,3}))/i)
      const subtitle = hasEpisodeNumbers && episode
        ? `S${Number(episode[1] ?? episode[3])} · E${Number(episode[2] ?? episode[4])} · ${name}`
        : undefined
      return { id: `external-${path}`, title: name, subtitle, src: path, resumeKey: `external-${path}`, local: true }
    })
    const groups: MediaQueueGroup[] = [{ id: 'opened-files', label: 'Fichiers ouverts', items: queue }]
    const play = (index: number): void => {
      const item = queue[index]
      if (!item) return
      setMedia({
        title: item.title,
        subtitle: item.subtitle,
        isLive: false,
        src: item.src,
        resumeKey: item.resumeKey,
        local: true,
        autoResume: false,
        queue,
        queueIndex: index,
        queueGroups: queue.length > 1 ? groups : undefined,
        queueGroupIndex: 0,
        onQueueSelect: (next) => play(next),
        fetchInfo: () => probeT7Duration(item.src).then((durationSecs) => ({ durationSecs }))
      })
    }
    play(0)
  }

  async function openLocalFiles(): Promise<void> {
    const host = (window as unknown as { host?: { mediaFiles?: { pick: () => Promise<string[]> } } }).host
    const chosen = await host?.mediaFiles?.pick()
    if (chosen?.length) playLocalFiles(chosen)
  }

  useEffect(() => {
    const host = (window as unknown as { host?: { mediaFiles?: { onOpen: (fn: (paths: string[]) => void) => () => void } } }).host
    return host?.mediaFiles?.onOpen((paths) => playLocalFiles(paths))
  }, [])

  function downloadEpisode(ep: Episode, seriesName: string, season: number): void {
    if (!creds) return
    const ext = ep.container_extension || 'mp4'
    void startDownload({
      id: `ep-${ep.id}`,
      title: seriesName,
      subtitle: `S${season} E${ep.episode_num} · ${ep.title}`,
      src: seriesStreamUrl(creds, ep.id, ext),
      ext,
      durationSecs: durationToSecs(ep.info as Record<string, never>)
    })
  }

  function playEpisode(episodes: Episode[], index: number, seriesName: string, season: number, seriesId?: number): void {
    if (!creds) return
    const ep = episodes[index]
    setMedia({
      title: seriesName,
      subtitle: `S${season} E${ep.episode_num} · ${ep.title}`,
      isLive: false,
      src: seriesStreamUrl(creds, ep.id, ep.container_extension),
      durationSecs: durationToSecs(ep.info as Record<string, never>),
      resumeKey: `ep-${ep.id}`,
      audioPrefKey: `xtream-series-${seriesId ?? seriesName}`,
      onPrev:
        index > 0
          ? () => playEpisode(episodes, index - 1, seriesName, season, seriesId)
          : undefined
    })
  }

  function playLocalQueueItem(item: MediaQueueItem, queue: MediaQueueItem[], index: number, autoResume = true, queueGroups?: MediaQueueGroup[], queueGroupIndex = 0): void {
    revealInContinue(item.resumeKey || '')
    setMedia({
      title: item.title,
      subtitle: item.subtitle,
      isLive: false,
      src: item.src,
      durationSecs: item.durationSecs,
      resumeKey: item.resumeKey,
      autoResume,
      local: true,
      requiresT7: item.requiresT7,
      localSubs: item.localSubs,
      audioPrefKey: item.audioPrefKey,
      queue,
      queueIndex: index,
      queueGroups,
      queueGroupIndex,
      onQueueSelect: (next, nextGroup = queueGroupIndex) => {
        const group = queueGroups?.[nextGroup]
        const targetQueue = group?.items ?? queue
        const target = targetQueue[next]
        if (target) playLocalQueueItem(target, targetQueue, next, true, queueGroups, nextGroup)
      },
      onQueueGroupSelect: (nextGroup) => {
        const group = queueGroups?.[nextGroup]
        if (group?.items.length) playLocalQueueItem(group.items[0], group.items, 0, true, queueGroups, nextGroup)
      },
      fetchInfo: () => probeT7Duration(item.src).then((d) => ({ durationSecs: d }))
    })
  }

  function playLocalMovie(m: LocalMovie, autoResume = false, displayTitle?: string, queue?: MediaQueueItem[], queueIndex = 0): void {
    revealInContinue(`t7-${m.id}`)
    if (queue && queue.length > 1) {
      playLocalQueueItem(queue[queueIndex] || queue[0], queue, queueIndex, autoResume)
      return
    }
    setMedia({
      title: displayTitle || m.title,
      isLive: false,
      src: m.filePath,
      resumeKey: `t7-${m.id}`,
      autoResume,
      local: true,
      requiresT7: true,
      localSubs: m.subs,
      fetchInfo: () => probeT7Duration(m.filePath).then((d) => ({ durationSecs: d }))
    })
  }

  function playLocalEpisode(
    eps: LocalEpisode[],
    index: number,
    showTitle: string,
    season: number,
    autoResume = false,
    show?: LocalShow,
    episodeTitle?: string,
    displayShowTitle?: string,
    queue?: MediaQueueItem[],
    queueIndex = 0,
    queueGroups?: MediaQueueGroup[],
    queueGroupIndex = 0
  ): void {
    const ep = eps[index]
    revealInContinue(`t7-${ep.id}`)
    if (queue && queue.length > 1) {
      playLocalQueueItem(queue[queueIndex] || queue[0], queue, queueIndex, autoResume, queueGroups, queueGroupIndex)
      return
    }
    const flattened = show
      ? orderedLocalSeasons(show).flatMap((seasonEntry) =>
          seasonEntry.episodes.map((episode, seasonIndex) => ({
            season: seasonEntry.season,
            episodes: seasonEntry.episodes,
            index: seasonIndex,
            episode
          }))
        )
      : []
    const flatIndex = flattened.findIndex((entry) => entry.episode.id === ep.id)
    const prevEntry = flatIndex > 0 ? flattened[flatIndex - 1] : null
    setMedia({
      title: displayShowTitle || showTitle,
      subtitle: `${season === 0 ? 'Spéciaux' : `S${season}`} · E${ep.episode}${episodeTitle || ep.title ? ` · ${episodeTitle || ep.title}` : ''}`,
      isLive: false,
      src: ep.filePath,
      resumeKey: `t7-${ep.id}`,
      audioPrefKey: `t7-series-${showTitle.trim().toLowerCase()}`,
      autoResume,
      local: true,
      requiresT7: true,
      localSubs: ep.subs,
      fetchInfo: () => probeT7Duration(ep.filePath).then((d) => ({ durationSecs: d })),
      onPrev:
        prevEntry
          ? () => playLocalEpisode(prevEntry.episodes, prevEntry.index, showTitle, prevEntry.season, false, show)
          : undefined
    })
  }

  let content: JSX.Element
  if (booting) {
    content = (
      <div className="boot">
        <div className="boot-logo">IPTV FLOW</div>
        <div className="spinner" />
      </div>
    )
  } else if ((t7Only || section === 'streamly') && !creds) {
    content = (
      <div className="body">
        <T7MinimalSidebar
          onLogin={() => { setT7Only(false); setSection('live') }}
          onExport={() => exporterRef.current?.()}
          onSettings={() => setSettingsOpen(true)}
          section={section === 'streamly' ? 'streamly' : 't7flix'}
          onSection={selectSection}
          t7Available={t7Available}
        />
        {section === 'streamly' ? <Streamly menuOpen={streamlyMenuOpen} onMenuClose={() => setStreamlyMenuOpen(false)} covered={settingsOpen} onFullScreenChange={setStreamlyFullScreen} /> : <T7Browser
          onPlayMovie={playLocalMovie}
          onPlayEpisode={playLocalEpisode}
          onBackToLogin={() => setT7Only(false)}
          exporterRef={exporterRef}
        />}
      </div>
    )
  } else if (!creds || !account) {
    content = <LoginScreen onLogin={handleLogin} onT7Only={() => setT7Only(true)} onStreamly={() => setSection('streamly')} profiles={profiles} onRemoveProfile={handleRemoveProfile} />
  } else {
    const contentSection =
      section !== 'downloads' && section !== 't7flix' && section !== 'streamly' ? (section as ContentSection) : null
    content = (
      <div className="body">
        <div className="sidebar-wrap">
          <Sidebar
            section={section}
            account={account}
            onSection={selectSection}
            onSwitchProfile={handleSwitchProfile}
            onSettings={() => setSettingsOpen(true)}
            onExport={section === 't7flix' ? () => exporterRef.current?.() : contentSection ? () => { void exportOrganisation() } : undefined}
            profileName={profileName}
            collapsed={sidebarCollapsed}
          />
          <button
            className="sidebar-edge-toggle"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? 'Déplier le menu' : 'Replier le menu'}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              {sidebarCollapsed
                ? <polyline points="9 18 15 12 9 6" />
                : <polyline points="15 18 9 12 15 6" />}
            </svg>
          </button>
        </div>
        {section === 'downloads' ? (
          <Downloads onPlay={playDownload} />
        ) : section === 't7flix' ? (
          <T7Browser onPlayMovie={playLocalMovie} onPlayEpisode={playLocalEpisode} exporterRef={exporterRef} />
        ) : section === 'streamly' ? (
          <Streamly menuOpen={streamlyMenuOpen} onMenuClose={() => setStreamlyMenuOpen(false)} covered={settingsOpen} onFullScreenChange={setStreamlyFullScreen} />
        ) : (
          <ContentBrowser
            key={contentSection!}
            creds={creds}
            section={contentSection!}
            onPlayLive={playLive}
            onPlayVod={playVod}
            onOpenSeries={setSeriesDetail}
            onDownloadVod={downloadVod}
          />
        )}
      </div>
    )
  }

  return (
    <div className={`app${section === 'streamly' && streamlyFullScreen ? ' streamly-fullscreen' : ''}`}>
      <div className="window-drag" />
      {content}

      {seriesDetail && creds && (
        <SeriesDetail
          creds={creds}
          series={seriesDetail}
          onClose={() => setSeriesDetail(null)}
          onPlayEpisode={playEpisode}
          onDownloadEpisode={downloadEpisode}
        />
      )}

      {media && <Player media={media} onClose={() => setMedia(null)} />}

      {settingsOpen && <AppSettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <FavoritesProvider>
      <DownloadsProvider>
        <T7Provider>
          <T7AssetPreloader />
          <AppInner />
        </T7Provider>
      </DownloadsProvider>
    </FavoritesProvider>
  )
}
