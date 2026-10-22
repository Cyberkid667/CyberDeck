import { Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { TorrentStatus, TorrentSummary } from '../../../shared/types'
import { DASH, formatBytes, formatPercent, isHashName, statusText } from '../format'
import { useT } from '../i18n'
import { CheckMark, DialogFrame, DialogHead, Keys } from './AddDialog'

// Supprimer (SPEC 5.12, 540 px) : liste des torrents visés (point de couleur de
// l'état, nom, « 9,84 Go · 42,0 % », 5 lignes au plus), case « Mettre aussi les
// fichiers téléchargés à la corbeille ». Bouton en contour neutre (icône rouge) ;
// case cochée : l'encart passe au rouge et le bouton devient rouge plein.
// Focus initial sur Annuler (Entrée annule).

interface Props {
  torrents: TorrentSummary[]
  onCancel: () => void
  onConfirm: (deleteFiles: boolean) => void
}

/** Couleur du point d'état (la même que le statut au-dessus de la barre). */
const DOT: Record<TorrentStatus, string> = {
  downloading: 'var(--lum)',
  stalled: 'var(--tx-2)',
  metadata: 'var(--tx-2)',
  checking: 'var(--tx-2)',
  seeding: 'var(--ok)',
  completed: 'var(--ok)',
  paused: 'var(--tx-3)',
  error: 'var(--err)'
}

const MAX_ROWS = 5

export function RemoveDialog({ torrents, onCancel, onConfirm }: Props): React.JSX.Element {
  const { t, tn } = useT()
  const [deleteFiles, setDeleteFiles] = useState(false)
  // anneau de focus sur Annuler dès l'ouverture, même ouvert à la souris : c'est le choix par défaut
  const [ring, setRing] = useState(true)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const n = torrents.length
  const many = n > 1
  const rest = n - MAX_ROWS

  return (
    <DialogFrame kind="remove" size="single" labelledBy="rm-title" onClose={onCancel} initialFocus={cancelRef}>
      <DialogHead
        id="rm-title"
        cap={t('shell.remove.cap')}
        title={many ? t('shell.remove.titleMany', { n }) : t('shell.remove.titleOne')}
        onClose={onCancel}
      />

      {n > 0 && (
        <ul className="rm-list">
          {torrents.slice(0, MAX_ROWS).map((tr) => {
            const hash = isHashName(tr)
            return (
              <li key={tr.id}>
                <span className="sdot" style={{ color: DOT[tr.status] }} title={statusText(tr)} aria-label={statusText(tr)} />
                <span className={`nm ell${hash ? ' hash' : ''}`} title={tr.name}>
                  {hash ? tr.id : tr.name}
                </span>
                <span className="mono">
                  {tr.size > 0 ? formatBytes(tr.size) : DASH} · {formatPercent(tr.progress)}
                </span>
              </li>
            )
          })}
          {rest > 0 && (
            <li>
              <span className="more">{tn('shell.remove.more', rest)}</span>
            </li>
          )}
        </ul>
      )}

      <label className={`check${deleteFiles ? ' on danger' : ''}`}>
        <span className="cbox">
          <input
            type="checkbox"
            checked={deleteFiles}
            data-testid="remove-delete-files"
            onChange={(e) => setDeleteFiles(e.target.checked)}
          />
          <CheckMark />
        </span>
        <span className="txt">
          {t('shell.remove.deleteFiles')}
          <small>{many ? t('shell.remove.keepFilesMany') : t('shell.remove.keepFilesOne')}</small>
        </span>
      </label>

      <div className="dfoot">
        <Keys keys={[[t('shell.keys.esc'), t('shell.keys.cancel')]]} />
        <button
          ref={cancelRef}
          type="button"
          className={`btn btn-line${ring ? ' ring' : ''}`}
          data-testid="dialog-cancel"
          onBlur={() => setRing(false)}
          onClick={onCancel}
        >
          {t('shell.common.cancel')}
        </button>
        <button
          type="button"
          className={`btn btn-danger${deleteFiles ? ' armed' : ''}`}
          data-testid="dialog-submit"
          onClick={() => onConfirm(deleteFiles)}
        >
          <Trash2 />
          {deleteFiles ? t('shell.remove.submitWithFiles') : t('shell.remove.submit')}
        </button>
      </div>
    </DialogFrame>
  )
}
