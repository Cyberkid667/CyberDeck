import { memo, type CSSProperties } from 'react'
import type { TorrentStatus, TorrentSummary } from '../../../shared/types'
import { formatPercent, percentVar, statusText } from '../format'
import { useT } from '../i18n'

// Barres segmentées (SPEC 5.4) : piste + remplissage découpés en segments par un
// masque CSS ; seule la variable --p change chaque seconde (aucune mise en page).
// La couleur vient de la classe s-<statut> posée sur un parent (.td.prog).

const fill = (value: number): CSSProperties => ({ '--p': percentVar(value) }) as CSSProperties

/** Barre segmentée seule (.bar > i), de largeur --bar-w (ou 40 px dans .mini). */
export function ProgressBar({ value, status }: { value: number; status?: TorrentStatus }): React.JSX.Element {
  const bar = (
    <div className="bar">
      <i style={fill(value)} />
    </div>
  )
  // compatibilité : avec un statut, la barre prend la couleur de cet état
  return status ? <div className={`s-${status}`}>{bar}</div> : bar
}

/**
 * Cellule « Progression et statut » du tableau : ligne 1 = point 5 px + statut en
 * capitales (+ cause d'une erreur) + pourcentage à droite ; ligne 2 = barre segmentée.
 * Le message complet d'une erreur est dans le title de la cellule.
 */
export const StatusProgress = memo(function StatusProgress({
  status,
  progress,
  error
}: Pick<TorrentSummary, 'status' | 'progress' | 'error'>): React.JSX.Element {
  const { t } = useT()
  // « En attente de pairs » devient « En attente » sous 1100 px (barre de 160 px) au lieu d'être coupé
  const label =
    status === 'stalled' ? (
      <>
        {t('shell.status.stalledShort')}
        <span className="st-more">{t('shell.status.stalledMore')}</span>
      </>
    ) : (
      statusText({ status, error })
    )
  return (
    <div className={`td prog s-${status}`} role="gridcell" title={status === 'error' && error ? error : undefined}>
      <div className="prog-top">
        <span className="sdot" />
        <span className="st">{label}</span>
        <span className="pct">{formatPercent(progress)}</span>
      </div>
      <div className="bar">
        <i style={fill(progress)} />
      </div>
    </div>
  )
})

/** Mini-barre de 40 px (5 segments) + pourcentage : blanc en cours, vert à 100 %. */
export function MiniProgress({ value }: { value: number }): React.JSX.Element {
  useT() // pourcentage dans la langue en cours
  return (
    <div className={`mini${value >= 1 ? ' full' : ''}`}>
      <div className="bar">
        <i style={fill(value)} />
      </div>
      <span>{formatPercent(value)}</span>
    </div>
  )
}
