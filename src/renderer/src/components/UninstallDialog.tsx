import { ExternalLink, FolderOpen, LoaderCircle, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { Game, UninstallPlan } from '../../../shared/types'
import { errorText } from '../format'
import { useT } from '../i18n'
import { CheckMark, DialogFrame, DialogHead, Keys } from './AddDialog'
import { PlatformTag } from './PlatformTag'
import type { ToastOptions } from './Toasts'

// Désinstaller un jeu (540 px, même socle que « Retirer ») : on demande d'abord au processus
// principal comment faire (Steam, désinstalleur déclaré dans Windows, lanceur à ouvrir, ou
// dossier), on le dit clairement, puis on lance au clic. CyberDeck ne supprime jamais un dossier
// lui-même : un gros dossier peut dépasser la Corbeille et être effacé pour de bon.
// Focus initial sur Annuler.

interface Props {
  game: Game
  onClose: () => void
  onToast: (level: 'info' | 'success' | 'error', message: string, opts?: ToastOptions) => void
}

/** Texte de la fenêtre selon la méthode. */
function explain(plan: UninstallPlan, game: Game): string {
  const after = game.platform === 'local' ? t('library.uninstall.afterLocal') : t('library.uninstall.afterPlatform')
  const launcher = plan.launcher ?? ''
  switch (plan.kind) {
    case 'launcher':
      return t('library.uninstall.explainLauncher', { launcher, after })
    case 'uninstaller':
      return plan.launcher
        ? t('library.uninstall.explainUninstallerOf', { launcher, after })
        : t('library.uninstall.explainUninstaller', { after })
    case 'open-launcher':
      return game.platform === 'xbox'
        ? t('library.uninstall.explainXbox', { name: game.name })
        : t('library.uninstall.explainOpenLauncher', { launcher, name: game.name })
    case 'folder':
      return t('library.uninstall.explainFolder')
    default:
      return plan.error ?? t('library.uninstall.failed')
  }
}

/** Clé du libellé du bouton selon la méthode. */
const BUTTON: Record<UninstallPlan['kind'], string> = {
  launcher: 'library.uninstall.btnUninstall',
  uninstaller: 'library.uninstall.btnUninstall',
  'open-launcher': 'library.uninstall.btnOpen',
  folder: 'library.common.openFolder',
  none: ''
}

export function UninstallDialog({ game, onClose, onToast }: Props): React.JSX.Element {
  const { t } = useT()
  const [plan, setPlan] = useState<UninstallPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [removeFromList, setRemoveFromList] = useState(true)
  const [ring, setRing] = useState(true)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let alive = true
    window.essaim
      .uninstallPlan(game.id)
      .then((p) => alive && setPlan(p))
      .catch((err) => alive && setPlan({ kind: 'none', launcher: null, target: null, error: errorText(err) }))
    return () => {
      alive = false
    }
  }, [game.id])

  async function confirm(): Promise<void> {
    if (!plan || busy) return
    setBusy(true)
    try {
      const res = await window.essaim.uninstallGame(game.id, removeFromList)
      if (!res.ok) {
        onToast('error', res.error ?? t('library.uninstall.failed'), { detail: game.name })
        return setBusy(false)
      }
      const msg =
        plan.kind === 'launcher'
          ? t('library.uninstall.doneLauncher', { launcher: plan.launcher ?? '' })
          : plan.kind === 'uninstaller'
            ? t('library.uninstall.doneUninstaller')
            : plan.kind === 'open-launcher'
              ? t('library.uninstall.doneOpenLauncher', { launcher: plan.launcher ?? '' })
              : removeFromList
                ? t('library.uninstall.doneFolderRemoved')
                : t('library.uninstall.doneFolder')
      onToast('info', msg, { detail: game.name })
      onClose()
    } catch (err) {
      onToast('error', errorText(err), { detail: game.name })
      setBusy(false)
    }
  }

  const label =
    plan?.kind === 'open-launcher'
      ? t('library.uninstall.btnOpenLauncher', { launcher: plan.launcher ?? '' })
      : plan && BUTTON[plan.kind]
        ? t(BUTTON[plan.kind])
        : ''
  return (
    <DialogFrame kind="uninstall" size="single" labelledBy="uni-title" onClose={onClose} initialFocus={cancelRef}>
      <DialogHead id="uni-title" cap={t('library.uninstall.cap')} title={t('library.uninstall.title')} onClose={onClose} />
      <ul className="rm-list">
        <li>
          <PlatformTag platform={game.platform} />
          <span className="nm ell" title={game.name}>
            {game.name}
          </span>
        </li>
      </ul>
      {!plan ? (
        <p className="dnote" data-testid="uninstall-loading">
          <LoaderCircle className="spin" /> {t('library.uninstall.loading')}
        </p>
      ) : (
        <>
          <p className="dnote" data-testid="uninstall-plan" data-kind={plan.kind}>
            {explain(plan, game)}
          </p>
          {plan.target && (
            <p className="dnote mono ell" title={plan.target}>
              {plan.target}
            </p>
          )}
          {plan.kind === 'folder' && (
            <label className={`check${removeFromList ? ' on' : ''}`}>
              <span className="cbox">
                <input
                  type="checkbox"
                  checked={removeFromList}
                  data-testid="uninstall-remove-from-list"
                  onChange={(e) => setRemoveFromList(e.target.checked)}
                />
                <CheckMark />
              </span>
              <span className="txt">{t('library.uninstall.removeFromList')}</span>
            </label>
          )}
        </>
      )}
      <div className="dfoot">
        <Keys keys={[[t('library.common.keyEsc'), t('library.common.actCancel')]]} />
        <button
          ref={cancelRef}
          type="button"
          className={`btn btn-line${ring ? ' ring' : ''}`}
          data-testid="dialog-cancel"
          onBlur={() => setRing(false)}
          onClick={onClose}
        >
          {plan?.kind === 'none' ? t('library.common.close') : t('library.common.cancel')}
        </button>
        {plan && plan.kind !== 'none' && (
          <button type="button" className="btn btn-danger" disabled={busy} data-testid="dialog-submit" onClick={() => void confirm()}>
            {plan.kind === 'folder' ? <FolderOpen /> : plan.kind === 'open-launcher' ? <ExternalLink /> : <Trash2 />}
            {label}
          </button>
        )}
      </div>
    </DialogFrame>
  )
}
