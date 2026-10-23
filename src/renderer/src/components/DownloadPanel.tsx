import { Clock, LoaderCircle, Pause } from 'lucide-react'
import { memo, type CSSProperties } from 'react'
import { t } from '../../../shared/i18n'
import type { DownloadProgress } from '../../../shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed, percentVar } from '../format'
import { useT } from '../i18n'

// Téléchargement d'un jeu Steam, façon page « Téléchargements » de Steam, aux couleurs de l'app :
// phase (Téléchargement / Installation des fichiers / En pause / En file d'attente), pourcentage,
// barre segmentée, « 3,50 Go / 5,90 Go », vitesse, temps restant et petit graphique des derniers
// relevés (barres blanches, la plus récente à droite). Le processus principal relève l'appmanifest
// toutes les 1,5 s : seule la variable --p et la hauteur des barres changent.
//   compact : version du bandeau de la bibliothèque (une ligne de relevés, petit graphique à droite).

/** Part faite : écriture des fichiers pendant l'installation, sinon téléchargement. */
export function downloadFraction(d: DownloadProgress): number {
  if (d.phase === 'installing' && d.toStage > 0) return d.staged / d.toStage
  return d.total > 0 ? d.downloaded / d.total : 0
}

/** Libellé de la phase dans la langue en cours. */
export const downloadPhaseLabel = (d: DownloadProgress): string => t(`library.download.${d.phase}`)

/** Octets faits / à faire selon la phase (écrits pendant l'installation). */
export function downloadBytes(d: DownloadProgress): { done: number; total: number } {
  return d.phase === 'installing' && d.toStage > 0 ? { done: d.staged, total: d.toStage } : { done: d.downloaded, total: d.total }
}

/** Bulle d'un téléchargement (carte) : « Téléchargement · 42,0 % · 2,48 Go / 5,90 Go ». */
export function downloadTitle(d: DownloadProgress): string {
  const { done, total } = downloadBytes(d)
  return t('library.download.cardTitle', {
    phase: downloadPhaseLabel(d),
    pct: formatPercent(downloadFraction(d)),
    done: formatBytes(done),
    total: formatBytes(total)
  })
}

const fill = (value: number): CSSProperties => ({ '--p': percentVar(value) }) as CSSProperties

const SLOTS = 60

/** Graphique des vitesses (barres blanches, la plus récente à droite ; cases vides à gauche au début). */
const SpeedGraph = memo(function SpeedGraph({ history, compact }: { history: number[]; compact: boolean }): React.JSX.Element {
  const { t } = useT()
  const slots = compact ? 30 : SLOTS
  const list = history.slice(-slots)
  const peak = Math.max(0, ...list)
  const pad = slots - list.length
  return (
    <div className="dlp-graph" role="img" aria-label={t('library.download.graphAria')}>
      <div className="dlp-graph-top">
        <span className="cap">{t('library.download.network')}</span>
        {peak > 0 && <span className="cap peak">{t('library.download.peak', { speed: formatSpeed(peak) })}</span>}
      </div>
      <div className="dlp-bars" style={{ '--n': slots } as CSSProperties}>
        {Array.from({ length: pad }, (_, i) => (
          <i key={`p${i}`} className="empty" />
        ))}
        {list.map((v, i) => (
          <i
            key={i}
            className={i === list.length - 1 ? 'last' : undefined}
            style={{ height: peak > 0 && v > 0 ? `${Math.max(4, Math.round((v / peak) * 100))}%` : undefined }}
          />
        ))}
      </div>
    </div>
  )
})

interface Props {
  download: DownloadProgress
  /** mise à jour d'un jeu installé (sinon première installation) */
  update?: boolean
  compact?: boolean
}

export function DownloadPanel({ download: d, update = false, compact = false }: Props): React.JSX.Element {
  const { t } = useT()
  const p = downloadFraction(d)
  const { done, total } = downloadBytes(d)
  const phase = downloadPhaseLabel(d)
  const active = d.phase === 'downloading' || d.phase === 'installing'
  const pct = formatPercent(p)
  const speed = active && d.phase === 'downloading' ? d.speed : 0
  return (
    <section
      className={`dlp${compact ? ' compact' : ''} ph-${d.phase}`}
      data-testid="download-panel"
      data-phase={d.phase}
      aria-label={t('library.download.aria', { phase, pct })}
    >
      <div className="dlp-main">
        <div className="dlp-head">
          {active ? <LoaderCircle className="spin" /> : d.phase === 'paused' ? <Pause /> : <Clock />}
          <span className="cap st">
            {update && <span className="upd">{t('library.download.update')} · </span>}
            {phase}
          </span>
          <span className="pct">{pct}</span>
        </div>
        <div className="dlp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} aria-label={phase}>
          <i style={fill(p)} />
        </div>
        <div className="dlp-stats">
          <div>
            <span className="cap">{d.phase === 'installing' && d.toStage > 0 ? t('library.download.written') : t('library.download.downloaded')}</span>
            <span className="v">
              {formatBytes(done)}
              <span className="tot"> / {formatBytes(total)}</span>
            </span>
          </div>
          <div>
            <span className="cap">{t('library.download.speed')}</span>
            <span className={`v${speed ? '' : ' nil'}`}>{formatSpeed(speed)}</span>
          </div>
          <div>
            <span className="cap">{t('library.download.eta')}</span>
            <span className={`v${active && d.eta !== null ? '' : ' nil'}`}>{formatEta(active ? d.eta : null)}</span>
          </div>
        </div>
      </div>
      <SpeedGraph history={d.history ?? []} compact={compact} />
    </section>
  )
}
