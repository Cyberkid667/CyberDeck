import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Notice } from '../../../shared/types'
import { formatTime } from '../format'

// Toasts en verre sombre, pile en bas à droite (4 au plus) : barre de 2 px à
// gauche (blanche = info, verte = succès, rouge = erreur), ligne du haut
// (catégorie ou titre + heure + ✕), message Inter 13, détail en mono 12 (nom de jeu
// ou de fichier) ou, pour une phrase (detailKind 'text'), en Inter 12 ; petit bouton
// d'action facultatif sous le message ; fil qui se vide pendant 4,5 s (8 s pour une
// erreur ou un toast avec action). La minuterie s'arrête au survol.

export interface Toast extends Notice {
  id: number
  /** heure de création (ms) ; par défaut l'heure d'affichage */
  at?: number
  /** remplace la catégorie (« INFO », « SUCCÈS », « ERREUR »), ex. « Jaquette » */
  title?: string
  /** ligne sous le message : nom de jeu, de fichier… (mono) ou phrase (detailKind 'text', Inter) */
  detail?: string
  /** 'name' (défaut) : nom de jeu ou de fichier en mono ; 'text' : phrase en Inter (SPEC 2.3) */
  detailKind?: 'name' | 'text'
  /** petit bouton sous le message (ex. « Activer les torrents… ») ; le toast se ferme au clic */
  action?: ToastAction
}

export interface ToastAction {
  label: string
  onClick: () => void
  testId?: string
}

export interface ToastOptions {
  title?: string
  detail?: string
  detailKind?: 'name' | 'text'
  action?: ToastAction
}

export const toastDuration = (level: Notice['level'], action = false): number => (level === 'error' || action ? 8000 : 4500)

const CATEGORY: Record<Notice['level'], string> = { info: 'Info', success: 'Succès', error: 'Erreur' }
const CLASS: Record<Notice['level'], string> = { info: '', success: ' ok', error: ' err' }

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }): React.JSX.Element {
  const duration = toastDuration(toast.level, !!toast.action)
  const remaining = useRef(duration)
  const startedAt = useRef(0)
  const timer = useRef(0)
  const dismiss = useRef(onDismiss)
  const at = useRef(toast.at ?? Date.now())
  useEffect(() => {
    dismiss.current = onDismiss
  })

  const run = (): void => {
    window.clearTimeout(timer.current)
    startedAt.current = Date.now()
    timer.current = window.setTimeout(() => dismiss.current(toast.id), Math.max(0, remaining.current))
  }
  const pause = (): void => {
    window.clearTimeout(timer.current)
    remaining.current -= Date.now() - startedAt.current
  }

  useEffect(() => {
    run()
    return () => window.clearTimeout(timer.current)
  }, [])

  return (
    <div
      className={`toast${CLASS[toast.level]}`}
      role={toast.level === 'error' ? 'alert' : 'status'}
      data-testid="toast"
      onMouseEnter={pause}
      onMouseLeave={run}
    >
      <div className="top">
        <span className="cap">{toast.title ?? CATEGORY[toast.level]}</span>
        <span className="cap t">{formatTime(at.current, true)}</span>
        <button type="button" className="x" aria-label="Fermer" title="Fermer" onClick={() => onDismiss(toast.id)}>
          <X />
        </button>
      </div>
      <div className="msg">
        {toast.message}
        {toast.detail && <em className={toast.detailKind === 'text' ? 'txt' : undefined}>{toast.detail}</em>}
      </div>
      {toast.action && (
        <div className="act">
          <button
            type="button"
            className="btn btn-line btn-sm"
            data-testid={toast.action.testId ?? 'toast-action'}
            onClick={() => {
              toast.action!.onClick()
              onDismiss(toast.id)
            }}
          >
            {toast.action.label}
          </button>
        </div>
      )}
      <div className="timer" style={{ animationDuration: `${duration}ms` }} />
    </div>
  )
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): React.JSX.Element {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
