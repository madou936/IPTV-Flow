import { FormEvent, useState } from 'react'
import type { Credentials, UserInfo } from '../types'
import { authenticate } from '../api/xtream'
import type { IPTVProfile } from '../lib/profiles'

interface Props {
  onLogin: (creds: Credentials, user: UserInfo, profileLabel: string, profileId?: string) => void
  onT7Only: () => void
  onStreamly: () => void
  profiles: IPTVProfile[]
  onRemoveProfile: (profileId: string) => void
}

export default function LoginScreen({ onLogin, onT7Only, onStreamly, profiles, onRemoveProfile }: Props): JSX.Element {
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [profileLabel, setProfileLabel] = useState('')
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const creds: Credentials = { url: url.trim(), username: username.trim(), password: password.trim() }
    try {
      const res = await authenticate(creds)
      onLogin(creds, res.user_info, profileLabel.trim() || username.trim(), editingProfileId ?? undefined)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function editProfile(profile: IPTVProfile): void {
    setEditingProfileId(profile.id)
    setProfileLabel(profile.label)
    setUrl(profile.credentials.url)
    setUsername(profile.credentials.username)
    setPassword(profile.credentials.password)
    setError(null)
  }

  function cancelEdit(): void {
    setEditingProfileId(null)
    setProfileLabel('')
    setUrl('')
    setUsername('')
    setPassword('')
    setError(null)
  }

  async function connectSavedProfile(profile: IPTVProfile): Promise<void> {
    setError(null)
    setLoading(true)
    try {
      const res = await authenticate(profile.credentials)
      onLogin(profile.credentials, res.user_info, profile.label)
    } catch (err) {
      setError(`${profile.label} : ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        {profiles.length > 0 && (
          <section className="saved-profiles" aria-label="Profils enregistrés">
            <div className="saved-profiles-title">Profils enregistrés</div>
            {profiles.map((profile) => (
              <div className="saved-profile" key={profile.id}>
                <button type="button" className="saved-profile-connect" onClick={() => void connectSavedProfile(profile)} disabled={loading}>
                  <span className="saved-profile-avatar">{profile.label.slice(0, 1).toUpperCase()}</span>
                  <span className="saved-profile-copy">
                    <strong>{profile.label}</strong>
                    <small>{profile.credentials.username} · {profile.credentials.url.replace(/^https?:\/\//, '')}</small>
                  </span>
                  <span className="saved-profile-arrow">›</span>
                </button>
                <button type="button" className="saved-profile-edit" onClick={() => editProfile(profile)} disabled={loading} title={`Modifier ${profile.label}`} aria-label={`Modifier ${profile.label}`}>✎</button>
                <button type="button" className="saved-profile-remove" onClick={() => onRemoveProfile(profile.id)} disabled={loading} title={`Supprimer ${profile.label}`} aria-label={`Supprimer ${profile.label}`}>×</button>
              </div>
            ))}
          </section>
        )}

        <div className="login-section-label">
          {editingProfileId ? 'Modifier le profil Xtream' : profiles.length ? 'Ajouter un autre compte Xtream' : 'Connexion Xtream Codes'}
        </div>

        <label className="field">
          <span>Nom du profil <em>(facultatif)</em></span>
          <input
            type="text"
            placeholder="ex. Salon, Compte famille"
            value={profileLabel}
            onChange={(e) => setProfileLabel(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Identifiant</span>
          <input
            type="text"
            placeholder="ton identifiant"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>

        <label className="field">
          <span>Mot de passe</span>
          <input
            type="password"
            placeholder="ton mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <label className="field">
          <span>URL du serveur</span>
          <input
            type="text"
            placeholder="http://exemple.com:8080"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="btn-primary" type="submit" disabled={loading || !url || !username || !password}>
          {loading ? 'Connexion…' : editingProfileId ? 'Enregistrer et connecter' : 'Se connecter'}
        </button>

        {editingProfileId && (
          <button type="button" className="btn-t7only" onClick={cancelEdit} disabled={loading}>
            Annuler la modification
          </button>
        )}

        <button type="button" className="btn-t7only" onClick={onT7Only}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: 6}}>
            <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          Accéder à T7Flix sans connexion
        </button>
        <button type="button" className="btn-t7only" onClick={onStreamly}>Accéder à Streamly sans compte IPTV</button>
      </form>
    </div>
  )
}
