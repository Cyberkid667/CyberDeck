import { ExternalLink, LoaderCircle, Trash2, TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import type { LauncherInfo, LauncherPlatform } from '../../../shared/types'
import { useT } from '../i18n'
import { ofName } from '../platformUi'
import { DialogFrame, DialogHead, Keys } from './AddDialog'
import { PlatformLogo } from './PlatformLogo'

// Confirmation avant de désinstaller un lanceur (540 px, même socle que « Désinstaller » un jeu) :
// combien de ses jeux sont installés sur ce PC (bibliothèque), et l'avertissement que son
// désinstalleur peut les supprimer aussi (Steam le fait). Focus d'ouverture sur Annuler, et
// Entrée sur Annuler annule : rien n'est lancé par mégarde.

interface Props {
  id: LauncherPlatform
  name: string
  uninstallKind: LauncherInfo['uninstallKind']
  /** jeux de ce lanceur installés sur ce PC */
  gameCount: number
  onCancel: () => void
  /** lance la désinstallation ; la fenêtre se ferme quand la promesse est tenue */
  onConfirm: () => Promise<void>
}

export function LauncherUninstallDialog({ id, name, uninstallKind, gameCount, onCancel, onConfirm }: Props): React.JSX.Element {
  const { t, tn } = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [ring, setRing] = useState(true)
  const [busy, setBusy] = useState(false)
  const of = ofName(name)
  const windows = uninstallKind === 'windows'

  async function confirm(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogFrame kind="launcher-uninstall" size="single" labelledBy="lch-uni-title" busy={busy} onClose={onCancel} initialFocus={cancelRef}>
      <div className="lch-confirm" data-testid="launcher-confirm-uninstall" data-platform={id} data-games={gameCount}>
        <DialogHead id="lch-uni-title" cap={t('library.launchers.confirm.cap')} title={t('library.launchers.confirm.title', { name })} onClose={onCancel} busy={busy} />
        <ul className="rm-list">
          <li>
            <PlatformLogo platform={id} />
            <span className="nm ell" title={name}>
              {name}
            </span>
            <span className="mono">
              {gameCount} {tn('library.games.word', gameCount)}
            </span>
          </li>
        </ul>
        <div className={`banner lch-warn${gameCount ? ' hot' : ''}`} data-testid="launcher-confirm-games">
          <TriangleAlert />
          <div>
            <p>
              <b>{gameCount ? tn('library.launchers.confirm.games', gameCount, { of, name }) : t('library.launchers.confirm.noGames', { of, name })}</b>
            </p>
            {gameCount > 0 && <p>{id === 'steam' ? t('library.launchers.confirm.deleteSteam') : t('library.launchers.confirm.deleteMay')}</p>}
          </div>
        </div>
        <p className="dnote">
          {windows ? t('library.launchers.confirm.howWindows', { name, of }) : t('library.launchers.confirm.howUninstaller', { name, of })}
        </p>
        <div className="dfoot">
          <Keys keys={[[t('library.common.keyEsc'), t('library.common.actCancel')]]} />
          <button
            ref={cancelRef}
            type="button"
            className={`btn btn-line${ring ? ' ring' : ''}`}
            data-testid="dialog-cancel"
            disabled={busy}
            onBlur={() => setRing(false)}
            onClick={onCancel}
          >
            {t('library.common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} data-testid="dialog-submit" onClick={() => void confirm()}>
            {busy ? <LoaderCircle className="spin" /> : windows ? <ExternalLink /> : <Trash2 />}
            {windows ? t('library.launchers.confirm.btnWindows') : t('library.launchers.uninstall')}
          </button>
        </div>
      </div>
    </DialogFrame>
  )
}
