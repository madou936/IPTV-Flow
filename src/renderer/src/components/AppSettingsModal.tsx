import { useEffect, useState } from 'react'
import { getOsubSettings, setOsubCredentials } from '../lib/opensubtitles'
import { getOmdbKey, setOmdbKey, getTmdbToken, setTmdbToken } from '../lib/metadata'
import { getT7TvUrl, pickXtreamOrganisation, startT7Tv } from '../lib/proxy'
import { savePrefs } from '../lib/categories'
import type { Favorite, FavoriteKind } from '../types'

interface Props {
  onClose: () => void
}

type ImportedSection = {
  id?: unknown
  order?: Array<{ category_id?: unknown }>
  hidden?: Array<{ category_id?: unknown }>
}

type ImportedOrganisation = {
  app?: unknown
  sections?: ImportedSection[]
  favorites?: unknown
}

const XTREAM_SECTIONS = new Set(['live', 'movies', 'series'])

function categoryIds(rows: ImportedSection['order'] | ImportedSection['hidden']): string[] {
  if (!Array.isArray(rows)) return []
  return [...new Set(rows
    .map((row) => row?.category_id)
    .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
    .map(String))]
}

function importedFavorites(value: unknown): Favorite[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set<FavoriteKind>(['live', 'movie', 'series'])
  return value.flatMap((entry): Favorite[] => {
    if (!entry || typeof entry !== 'object') return []
    const favorite = entry as Partial<Favorite>
    const id = Number(favorite.id)
    if (!allowed.has(favorite.kind as FavoriteKind) || !Number.isFinite(id) || typeof favorite.name !== 'string' || typeof favorite.image !== 'string') return []
    return [{
      kind: favorite.kind as FavoriteKind,
      id,
      name: favorite.name,
      image: favorite.image,
      ...(typeof favorite.ext === 'string' ? { ext: favorite.ext } : {})
    }]
  })
}

function visibilityIcon(hidden: boolean): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="3" />
      {hidden && <path d="M4 4l16 16" />}
    </svg>
  )
}

export default function AppSettingsModal({ onClose }: Props): JSX.Element {
  // OpenSubtitles
  const [osubUser, setOsubUser] = useState('')
  const [osubPass, setOsubPass] = useState('')
  const [showOsubPass, setShowOsubPass] = useState(false)
  const [osubHasPass, setOsubHasPass] = useState(false)
  const [osubSaved, setOsubSaved] = useState(false)

  // OMDb
  const [omdbKey, setOmdbKeyState] = useState('')
  const [omdbSaved, setOmdbSaved] = useState(false)

  // TMDB
  const [tmdbToken, setTmdbTokenState] = useState('')
  const [showTmdbToken, setShowTmdbToken] = useState(false)
  const [tmdbSaved, setTmdbSaved] = useState(false)
  const [t7Backdrops, setT7Backdrops] = useState(
    () => localStorage.getItem('t7_backdrops') !== '0'
  )
  const [t7TvUrl, setT7TvUrl] = useState('')
  const [t7TvCopied, setT7TvCopied] = useState(false)
  const [xtreamImportStatus, setXtreamImportStatus] = useState('')
  const [autoFrenchSubtitles, setAutoFrenchSubtitles] = useState(
    () => localStorage.getItem('iptv_auto_french_subtitles') !== '0'
  )
  const [streamlyRestorePage, setStreamlyRestorePage] = useState(() => localStorage.getItem('streamly:restore-page') !== '0')
  const [streamlyAlwaysShowTabs, setStreamlyAlwaysShowTabs] = useState(() => localStorage.getItem('streamly:youtube-tabs-always') === '1')

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  useEffect(() => {
    getOsubSettings().then(({ username, password, hasPassword }) => {
      setOsubUser(username)
      setOsubPass(password)
      setOsubHasPass(hasPassword)
    })
    getOmdbKey().then(setOmdbKeyState)
    getTmdbToken().then(setTmdbTokenState)
    getT7TvUrl().then(setT7TvUrl).catch(() => undefined)
  }, [])

  async function saveOsub(): Promise<void> {
    await setOsubCredentials(osubUser, osubPass)
    setOsubHasPass(!!(osubUser && osubPass))
    setOsubSaved(true)
    setTimeout(() => setOsubSaved(false), 1800)
  }

  async function saveOmdb(): Promise<void> {
    await setOmdbKey(omdbKey)
    setOmdbSaved(true)
    setTimeout(() => setOmdbSaved(false), 1800)
  }

  async function saveTmdb(): Promise<void> {
    await setTmdbToken(tmdbToken)
    setTmdbSaved(true)
    setTimeout(() => setTmdbSaved(false), 1800)
  }

  async function copyT7TvUrl(): Promise<void> {
    const url = t7TvUrl || await startT7Tv()
    setT7TvUrl(url)
    await navigator.clipboard?.writeText(url)
    setT7TvCopied(true)
    setTimeout(() => setT7TvCopied(false), 1800)
  }

  async function importXtreamOrganisation(): Promise<void> {
    setXtreamImportStatus('')
    const contents = await pickXtreamOrganisation()
    if (!contents) return
    let parsed: ImportedOrganisation
    try {
      parsed = JSON.parse(contents) as ImportedOrganisation
    } catch {
      setXtreamImportStatus('Fichier JSON illisible.')
      return
    }
    if (parsed.app !== 'IPTV Flow' || !Array.isArray(parsed.sections)) {
      setXtreamImportStatus('Ce fichier n’est pas un export IPTV Flow Xtream.')
      return
    }
    const sections = parsed.sections.filter((entry) => typeof entry.id === 'string' && XTREAM_SECTIONS.has(entry.id))
    if (!sections.length) {
      setXtreamImportStatus('Aucune organisation Xtream trouvée dans ce fichier.')
      return
    }
    const favoriteList = importedFavorites(parsed.favorites)
    if (!window.confirm(`Importer ${sections.length} section(s) et ${favoriteList.length} favori(s) ?\nCette action remplace l’organisation Xtream actuelle.`)) return
    for (const entry of sections) {
      const id = entry.id as 'live' | 'movies' | 'series'
      savePrefs(id, { order: categoryIds(entry.order), hidden: categoryIds(entry.hidden) })
    }
    localStorage.setItem('iptv_favorites', JSON.stringify(favoriteList))
    setXtreamImportStatus('Organisation importée ✓ Redémarrage…')
    window.setTimeout(() => window.location.reload(), 700)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal app-settings-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2 className="settings-title">Réglages</h2>

        <section className="appsettings-section">
          <h3 className="appsettings-heading">Organisation Xtream Codes</h3>
          <p className="settings-sub appsettings-hint">
            Restaure l’ordre, les catégories masquées et les favoris depuis un export IPTV Flow. À utiliser avec le même compte Xtream.
          </p>
          <div className="appsettings-actions">
            <button className="btn-ghost appsettings-save" onClick={() => void importXtreamOrganisation()}>Importer</button>
            {xtreamImportStatus && <span className="appsettings-status">{xtreamImportStatus}</span>}
          </div>
        </section>

        <section className="appsettings-section">
          <h3 className="appsettings-heading">T7Flix TV / Firestick</h3>
          <p className="settings-sub appsettings-hint">
            IPTV Flow doit rester ouvert sur le Mac avec le SSD branché. La Firestick se connecte à cette adresse sur le même Wi-Fi.
          </p>
          <div className="appsettings-url-row">
            <code>{t7TvUrl || 'Démarrage du serveur TV…'}</code>
            <button className="btn-ghost appsettings-save" onClick={() => void copyT7TvUrl()}>
              {t7TvCopied ? 'Copié ✓' : 'Copier'}
            </button>
          </div>
        </section>

        {/* OpenSubtitles */}
        <section className="appsettings-section">
          <h3 className="appsettings-heading">Sous-titres en ligne (OpenSubtitles)</h3>
          <p className="settings-sub appsettings-hint">
            Compte gratuit sur opensubtitles.com — nécessaire pour télécharger (20 sous-titres/jour).
          </p>
          <div className="appsettings-row">
            <label className="appsettings-label">Identifiant</label>
            <input
              className="search appsettings-input"
              type="text"
              placeholder="nom d'utilisateur"
              value={osubUser}
              onChange={(e) => setOsubUser(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div className="appsettings-row">
            <label className="appsettings-label">Mot de passe</label>
            <div className="appsettings-secret">
              <input
                className="search appsettings-input"
                type={showOsubPass ? 'text' : 'password'}
                placeholder={osubHasPass ? '••••••••' : 'mot de passe'}
                value={osubPass}
                onChange={(e) => setOsubPass(e.target.value)}
                autoComplete="current-password"
              />
              <button
                className="secret-toggle"
                type="button"
                onClick={() => setShowOsubPass((v) => !v)}
                title={showOsubPass ? 'Masquer' : 'Afficher'}
              >
                {visibilityIcon(!showOsubPass)}
              </button>
            </div>
          </div>
          <div className="appsettings-actions">
            <button
              className="btn-ghost appsettings-save"
              onClick={() => void saveOsub()}
              disabled={!osubUser}
            >
              {osubSaved ? 'Enregistré ✓' : 'Enregistrer'}
            </button>
            {osubHasPass && !osubSaved && (
              <span className="appsettings-status">Identifiants configurés ✓</span>
            )}
          </div>
        </section>

        {/* TMDB */}
        <section className="appsettings-section">
          <h3 className="appsettings-heading">Token TMDB (métadonnées + affiches)</h3>
          <p className="settings-sub appsettings-hint">
            Fournisseur principal. Token lecture v4 disponible sur themoviedb.org → API.
          </p>
          <div className="appsettings-row">
            <label className="appsettings-label">Token Bearer</label>
            <div className="appsettings-secret">
              <input
                className="search appsettings-input"
                type={showTmdbToken ? 'text' : 'password'}
                placeholder="eyJhbGci…"
                value={tmdbToken}
                onChange={(e) => setTmdbTokenState(e.target.value)}
              />
              <button
                className="secret-toggle"
                type="button"
                onClick={() => setShowTmdbToken((v) => !v)}
                title={showTmdbToken ? 'Masquer' : 'Afficher'}
              >
                {visibilityIcon(!showTmdbToken)}
              </button>
            </div>
          </div>
          <div className="appsettings-actions">
            <button className="btn-ghost appsettings-save" onClick={() => void saveTmdb()}>
              {tmdbSaved ? 'Enregistré ✓' : 'Enregistrer'}
            </button>
          </div>
        </section>

        {/* OMDb */}
        <section className="appsettings-section">
          <h3 className="appsettings-heading">Clé OMDb (secours IMDb)</h3>
          <p className="settings-sub appsettings-hint">
            Source de secours basée sur IMDb, utilisée seulement si TMDB ne trouve pas.
          </p>
          <div className="appsettings-row">
            <label className="appsettings-label">Clé API</label>
            <input
              className="search appsettings-input"
              type="text"
              placeholder="ex. d6e39373"
              value={omdbKey}
              onChange={(e) => setOmdbKeyState(e.target.value)}
            />
          </div>
          <div className="appsettings-actions">
            <button className="btn-ghost appsettings-save" onClick={() => void saveOmdb()}>
              {omdbSaved ? 'Enregistré ✓' : 'Enregistrer'}
            </button>
          </div>
        </section>

        <section className="appsettings-section">
          <h3 className="appsettings-heading">Sous-titres embarqués</h3>
          <p className="settings-sub appsettings-hint">
            Recherche et sélectionne automatiquement une piste française au lancement. Les choix mémorisés pour une série ou un anime restent appliqués même si cette option est désactivée.
          </p>
          <label className="appsettings-toggle-row">
            <span>Sélection automatique des sous-titres français</span>
            <input
              type="checkbox"
              checked={autoFrenchSubtitles}
              onChange={(event) => {
                const enabled = event.target.checked
                setAutoFrenchSubtitles(enabled)
                localStorage.setItem('iptv_auto_french_subtitles', enabled ? '1' : '0')
              }}
            />
          </label>
        </section>

        <section className="appsettings-section">
          <h3 className="appsettings-heading">Fonds d’écran T7Flix</h3>
          <p className="settings-sub appsettings-hint">
            Affiche un fond TMDB discret et fixe dans les fiches T7Flix. Xtream Codes n’est pas concerné.
          </p>
          <label className="appsettings-toggle-row">
            <span>Activer les fonds d’écran</span>
            <input
              type="checkbox"
              checked={t7Backdrops}
              onChange={(event) => {
                const enabled = event.target.checked
                setT7Backdrops(enabled)
                localStorage.setItem('t7_backdrops', enabled ? '1' : '0')
              }}
            />
          </label>
        </section>

        <section className="appsettings-section streamly-settings-section">
          <h3 className="appsettings-heading">Streamly</h3>
          <div className="appsettings-toggle-row streamly-settings-row"><span>Mode PiP</span><strong>Automatique</strong></div>
          <label className="appsettings-toggle-row streamly-settings-row"><span>Rouvrir la dernière page</span><input type="checkbox" checked={streamlyRestorePage} onChange={(event) => { setStreamlyRestorePage(event.target.checked); localStorage.setItem('streamly:restore-page', event.target.checked ? '1' : '0') }} /></label>
          <label className="appsettings-toggle-row streamly-settings-row"><span>Toujours afficher les onglets YouTube</span><input type="checkbox" checked={streamlyAlwaysShowTabs} onChange={(event) => { setStreamlyAlwaysShowTabs(event.target.checked); localStorage.setItem('streamly:youtube-tabs-always', event.target.checked ? '1' : '0'); window.dispatchEvent(new Event('streamly:tabs-preference')) }} /></label>
          <div className="streamly-settings-shortcuts"><span>Changer de plateforme <kbd>⌥ 1–0</kbd></span><span>Picture-in-Picture <kbd>⌥ Z</kbd></span></div>
        </section>
      </div>
    </div>
  )
}
