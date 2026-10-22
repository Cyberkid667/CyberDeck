import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { PLATFORM_INFO } from '../../../shared/platforms'
import type { Game } from '../../../shared/types'
import { DialogFrame, DialogHead, Keys } from './AddDialog'
import { PlatformTag } from './PlatformTag'

// Retirer un jeu de plateforme (540 px, même socle que « Supprimer ») : le jeu reste
// installé dans son lanceur, mais CyberDeck ne le rajoutera plus tout seul. On le
// dit avant, et on dit comment le remettre (fenêtre Plateformes). Focus initial sur Annuler.

interface Props {
  game: Game
  onCancel: () => void
  onConfirm: () => void
}

export function RemoveGameDialog({ game, onCancel, onConfirm }: Props): React.JSX.Element {
  const [ring, setRing] = useState(true)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const name = PLATFORM_INFO[game.platform].name
  return (
    <DialogFrame kind="remove-game" size="single" labelledBy="rmg-title" onClose={onCancel} initialFocus={cancelRef}>
      <DialogHead id="rmg-title" cap="02.3 · Retrait" title="Retirer ce jeu ?" onClose={onCancel} />
      <ul className="rm-list">
        <li>
          <PlatformTag platform={game.platform} />
          <span className="nm ell" title={game.name}>
            {game.name}
          </span>
        </li>
      </ul>
      <p className="dnote">
        {game.installed ? `Le jeu reste installé dans ${name}. ` : ''}
        CyberDeck ne l’ajoutera plus tout seul à la bibliothèque. Pour le remettre, ouvre <b>Plateformes</b> puis clique sur{' '}
        <b>Remettre</b>.
      </p>
      <div className="dfoot">
        <Keys keys={[['Échap', 'annuler']]} />
        <button
          ref={cancelRef}
          type="button"
          className={`btn btn-line${ring ? ' ring' : ''}`}
          data-testid="dialog-cancel"
          onBlur={() => setRing(false)}
          onClick={onCancel}
        >
          Annuler
        </button>
        <button type="button" className="btn btn-danger" data-testid="dialog-submit" onClick={onConfirm}>
          <Trash2 />
          Retirer
        </button>
      </div>
    </DialogFrame>
  )
}
