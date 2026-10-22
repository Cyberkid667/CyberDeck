import { ArrowDownToLine, FolderOpen, PowerOff, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { version as APP_VERSION } from '../../../../package.json'
import type { Settings, SettingsPatch, TorrentSummary, UpdateState } from '../../../shared/types'
import { errorText, formatBytes, isRunning } from '../format'
import { CheckMark, DialogFrame, DialogHead } from './AddDialog'
import type { ToastOptions } from './Toasts'

// Réglages (SPEC 5.12, 540 px, même socle que les autres dialogues) : client torrent
// (facultatif, désactivé sur une nouvelle installation), dossier de téléchargement (torrents
// activés), dossier proposé par « Importer un dossier », mises à jour (vérification sur GitHub,
// bouton « Vérifier maintenant »), version. Chaque réglage s'applique
// tout de suite : pas de bouton Enregistrer. Désactiver les torrents pendant que certains
// tournent demande une confirmation ; le moteur enregistre alors la liste et s'arrête, et les
// torrents reprennent quand on les réactive.

interface Props {
  settings: Settings
  /** torrents de la liste (pour compter ceux qui tournent) */
  torrents: TorrentSummary[]
  /** espace libre dans le dossier de téléchargement (moteur en marche), sinon null */
  freeSpace: number | null
  /** applique et enregistre ; rejette si le processus principal refuse */
  onChange: (patch: SettingsPatch) => Promise<void>
  onClose: () => void
  onToast: (level: 'info' | 'success' | 'error', message: string, opts?: ToastOptions) => void
  /** dernière vérification des mises à jour (null : pas encore reçue) */
  update: UpdateState | null
  /** vérifie maintenant, même si la vérification automatique est désactivée */
  onCheckUpdate: () => Promise<UpdateState>
}

/** Une ligne sur l'état des mises à jour, sous l'interrupteur. */
function updateLine(u: UpdateState | null): string {
  if (!u || u.status === 'idle') return 'Pas encore vérifié.'
  if (u.status === 'checking') return 'Vérification en cours…'
  if (u.status === 'available') return `Nouvelle version disponible : ${u.latest} (tu as la ${u.current}).`
  if (u.status === 'current') return 'CyberDeck est à jour.'
  return `Vérification impossible (${u.error ?? 'erreur inconnue'}).`
}

export function SettingsDialog({ settings, torrents, freeSpace, onChange, onClose, onToast, update, onCheckUpdate }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  // confirmation avant d'arrêter des torrents qui tournent
  const [confirmOff, setConfirmOff] = useState(false)
  // dossier réellement proposé par « Importer un dossier » (choisi ici, sinon C:\Games ou Documents)
  const [gamesFolder, setGamesFolder] = useState<string | null>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const on = settings.torrentsEnabled
  const active = torrents.filter(isRunning).length

  useEffect(() => {
    let alive = true
    window.essaim
      .defaultGamesFolder()
      .then((dir) => {
        if (alive) setGamesFolder(dir)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [settings.gamesFolder])

  // la confirmation prend le focus sur « Annuler » (choix par défaut, comme pour une suppression)
  useEffect(() => {
    if (confirmOff) keepRef.current?.focus()
  }, [confirmOff])

  async function apply(patch: SettingsPatch): Promise<void> {
    setBusy(true)
    try {
      await onChange(patch)
    } catch (err) {
      onToast('error', `Réglage impossible : ${errorText(err)}`, { title: 'Réglages' })
    } finally {
      setBusy(false)
    }
  }

  function toggleTorrents(next: boolean): void {
    if (busy) return
    if (!next && active > 0) {
      setConfirmOff(true)
      return
    }
    setConfirmOff(false)
    void apply({ torrentsEnabled: next })
  }

  async function pickDownloads(): Promise<void> {
    const dir = await window.essaim.pickFolder(settings.defaultSavePath, 'Dossier de téléchargement')
    if (dir) void apply({ defaultSavePath: dir })
  }

  async function pickGames(): Promise<void> {
    const dir = await window.essaim.pickFolder(gamesFolder ?? '', 'Dossier de tes jeux')
    if (dir) void apply({ gamesFolder: dir })
  }

  const freeLabel = on && freeSpace !== null && freeSpace >= 0 ? `${formatBytes(freeSpace)} libres` : null

  return (
    <DialogFrame kind="settings" size="single" labelledBy="set-title" onClose={onClose}>
      <DialogHead id="set-title" cap="04 · Réglages" title="Réglages" onClose={onClose} />

      <label className={`check set-toggle${on ? ' on' : ''}`}>
        <span className="cbox">
          <input
            type="checkbox"
            role="switch"
            checked={on}
            disabled={busy}
            data-testid="settings-torrents-toggle"
            onChange={(e) => toggleTorrents(e.target.checked)}
            // interrupteur : Entrée bascule aussi (Espace est déjà géré par la case)
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.repeat || e.nativeEvent.isComposing) return
              e.preventDefault()
              toggleTorrents(!on)
            }}
          />
          <CheckMark />
        </span>
        <span className="txt">
          Torrents
          <small>Client torrent intégré. Désactivé, aucun port n’est ouvert.</small>
        </span>
      </label>

      {confirmOff && (
        <div className="banner set-confirm" role="group" aria-label="Désactiver les torrents ?" data-testid="settings-torrents-confirm-box">
          <TriangleAlert />
          <div className="set-confirm-body">
            <span>
              {active > 1
                ? `${active} torrents sont en cours. Ils s’arrêtent maintenant et reprendront quand tu réactiveras les torrents.`
                : '1 torrent est en cours. Il s’arrête maintenant et reprendra quand tu réactiveras les torrents.'}
            </span>
            <div className="row-btns">
              <button ref={keepRef} type="button" className="btn btn-line btn-sm" data-testid="settings-torrents-keep" onClick={() => setConfirmOff(false)}>
                Annuler
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                data-testid="settings-torrents-confirm"
                onClick={() => {
                  setConfirmOff(false)
                  void apply({ torrentsEnabled: false })
                }}
              >
                <PowerOff />
                Désactiver
              </button>
            </div>
          </div>
        </div>
      )}

      {on && (
        <div className="field">
          <div className="lab">
            <span className="cap">Dossier de téléchargement</span>
            {freeLabel && (
              <span className="cap" title="Espace libre dans ce dossier">
                {freeLabel}
              </span>
            )}
          </div>
          <div className="path-row">
            <input
              className="inp ro"
              type="text"
              readOnly
              tabIndex={-1}
              value={settings.defaultSavePath}
              title={settings.defaultSavePath}
              aria-label="Dossier de téléchargement"
            />
            <button type="button" className="btn btn-line" disabled={busy} data-testid="settings-downloads-pick" onClick={pickDownloads}>
              <FolderOpen />
              Parcourir…
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <div className="lab">
          <span className="cap">Dossier de tes jeux</span>
          {!settings.gamesFolder && <span className="cap">Par défaut</span>}
        </div>
        <div className="path-row">
          <input
            className="inp ro"
            type="text"
            readOnly
            tabIndex={-1}
            value={gamesFolder ?? ''}
            title={gamesFolder ?? undefined}
            aria-label="Dossier de tes jeux"
          />
          <button type="button" className="btn btn-line" disabled={busy} data-testid="settings-games-pick" onClick={pickGames}>
            <FolderOpen />
            Parcourir…
          </button>
        </div>
        <div className="hint mute">Ouvert par « Importer un dossier » dans Mes jeux.</div>
      </div>

      <label className={`check set-toggle${settings.checkUpdates ? ' on' : ''}`}>
        <span className="cbox">
          <input
            type="checkbox"
            role="switch"
            checked={settings.checkUpdates}
            disabled={busy}
            data-testid="settings-updates-toggle"
            onChange={(e) => void apply({ checkUpdates: e.target.checked })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.repeat || e.nativeEvent.isComposing) return
              e.preventDefault()
              void apply({ checkUpdates: !settings.checkUpdates })
            }}
          />
          <CheckMark />
        </span>
        <span className="txt">
          Mises à jour
          <small>Vérifie sur GitHub, au démarrage, si une nouvelle version est sortie. Rien n’est installé sans toi.</small>
        </span>
      </label>
      <div className="set-update" data-testid="settings-update-status">
        <span className={`hint${update?.status === 'available' ? '' : ' mute'}`}>{updateLine(update)}</span>
        <div className="row-btns">
          {update?.status === 'available' && (
            <button type="button" className="btn btn-line btn-sm" data-testid="settings-update-download" onClick={() => window.essaim.openUpdate()}>
              <ArrowDownToLine />
              Télécharger
            </button>
          )}
          <button
            type="button"
            className="btn btn-line btn-sm"
            disabled={update?.status === 'checking'}
            data-testid="settings-update-check"
            onClick={() => void onCheckUpdate()}
          >
            <RefreshCw className={update?.status === 'checking' ? 'spin' : undefined} />
            Vérifier maintenant
          </button>
        </div>
      </div>

      <div className="dfoot">
        <span className="cap set-ver" data-testid="settings-version">
          CyberDeck · version <b>{APP_VERSION}</b>
        </span>
        <button type="button" className="btn btn-line" data-testid="dialog-cancel" onClick={onClose}>
          Fermer
        </button>
      </div>
    </DialogFrame>
  )
}
