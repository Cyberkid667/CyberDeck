import { ArrowUpRight, Check, ChevronDown, CircleAlert, CircleUserRound, Download, LoaderCircle, Store, Trash2, X } from 'lucide-react'
import { memo, useId, useState } from 'react'
import { t, tn } from '../../../shared/i18n'
import { PLATFORM_INFO } from '../../../shared/platforms'
import type { LauncherInfo, LauncherOp, LauncherPlatform, PlatformSkip, PlatformSkipReason, PlatformStatus } from '../../../shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed } from '../format'
import { useT } from '../i18n'
import { ofName, platformName } from '../platformUi'
import { formatClock, LiveBar, useElapsed, useRate, type LiveMode } from './LiveProgress'
import { PlatformLogo } from './PlatformLogo'

// Carte d'un lanceur sur la page Lanceurs, version calme : logo en couleur, nom, UNE ligne d'état
// (« 8 jeux installés », « Aucun jeu pour l'instant », « Pas installé », erreur en rouge) et UNE
// action : Installer (ou Ouvrir le Microsoft Store / le site) pour un lanceur absent, un discret
// « Désinstaller » pour un lanceur présent. Le reste (façon d'installer, programme trouvé, éléments
// écartés, erreur de lecture, façon de désinstaller) est replié derrière le bouton « Détails » du
// coin. Pendant une opération, la carte montre la progression vivante (barre bleue, pourcentage,
// Mo reçus / total, débit et temps restant calculés ici, compteur de temps quand la part faite est
// inconnue, Annuler). Aucun numéro de carte.

type NotGame = Exclude<PlatformSkipReason, 'local' | 'platform'>
const NOT_GAME: NotGame[] = ['tool', 'app', 'dlc', 'other']
const capFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Détail d'une plateforme : « 4 écartés : outils, logiciel », « 1 déjà dans tes jeux locaux »,
 * « 1 déjà sur Steam » ; la bulle donne les noms. Un état enregistré par une version d'avant
 * (sans noms) donne seulement les nombres.
 */
export function skipDetails(p: PlatformStatus): { text: string; title?: string }[] {
  const out: { text: string; title?: string }[] = []
  const sk: PlatformSkip[] = p.skipped ?? []
  if (p.excludedCount) {
    const n = p.excludedCount
    const groups = NOT_GAME.map((r) => [r, sk.filter((s) => s.reason === r)] as const).filter(([, l]) => l.length > 0)
    const listed = groups.reduce((a, [, l]) => a + l.length, 0)
    // mot de la raison (« outil », « outils »…)
    const word = (r: NotGame, k: number): string => tn(`library.platforms.reason.${r}`, k)
    const count = tn('library.platforms.excluded', n)
    out.push({
      text: groups.length
        ? t('library.platforms.excludedList', {
            count,
            reasons: groups.map(([r, l]) => word(r, l.length)).join(', ')
          })
        : count,
      title: groups.length
        ? groups
            .map(([r, l]) =>
              t('library.platforms.reasonLine', {
                reason: capFirst(word(r, l.length)),
                names: l.map((s) => s.name).join(', ')
              })
            )
            .join('\n') + (n > listed ? `\n${tn('library.platforms.andMore', n - listed)}` : '')
        : undefined
    })
  }
  const local = sk.filter((s) => s.reason === 'local')
  const other = sk.filter((s) => s.reason === 'platform')
  if (local.length)
    out.push({
      text: t('library.platforms.inLocal', { n: local.length }),
      title: local.map((s) => s.name).join(', ')
    })
  if (other.length) {
    const plats = [...new Set(other.map((s) => s.other))]
    out.push({
      text: t('library.platforms.onPlatform', {
        n: other.length,
        platform: plats.length === 1 && plats[0] ? platformName(plats[0]) : t('library.platforms.anotherPlatform')
      }),
      title: other.map((s) => (s.other ? `${s.name} (${platformName(s.other)})` : s.name)).join(', ')
    })
  }
  if (!local.length && !other.length && p.duplicateCount)
    out.push({
      text: t('library.platforms.inLibrary', { n: p.duplicateCount })
    })
  return out
}

/** Opération qui occupe encore la carte (ni finie ni en échec). */
export const opRunning = (op: LauncherOp | undefined): boolean => !!op && op.phase !== 'done' && op.phase !== 'error'

/** Façon d'installer réellement : sans winget sur ce PC, le site officiel. */
export function installKindOf(info: LauncherInfo | undefined, winget: boolean | null): LauncherInfo['installKind'] | null {
  if (!info) return null
  return info.installKind === 'winget' && winget === false ? 'website' : info.installKind
}

export type CardState = 'installed' | 'absent' | 'error'

/** État de la carte d'après la dernière lecture des plateformes. */
export const cardStateOf = (status: PlatformStatus | null): CardState =>
  status?.state === 'detected' ? 'installed' : status?.state === 'error' ? 'error' : 'absent'

interface Props {
  id: LauncherPlatform
  /** état lu par la dernière lecture des plateformes ; null : pas encore lu */
  status: PlatformStatus | null
  /** ce que CyberDeck sait faire pour ce lanceur ; null : pas encore connu ou indisponible */
  info: LauncherInfo | null
  op: LauncherOp | undefined
  /** clic envoyé, réponse du processus principal pas encore reçue */
  pending: boolean
  winget: boolean | null
  /** installer / désinstaller indisponible (l'appel a échoué) */
  unavailable: boolean
  /** jeux de ce lanceur installés sur ce PC (bibliothèque) */
  gameCount: number
  onInstall: (id: LauncherPlatform) => void
  onUninstall: (id: LauncherPlatform) => void
  onCancel: (id: LauncherPlatform) => void
}

/** Phase en capitales au-dessus de la barre. */
function phaseLabel(op: LauncherOp): string {
  if (op.phase === 'done') return t(op.kind === 'install' ? 'library.launchers.phase.doneInstall' : 'library.launchers.phase.doneUninstall')
  return t(`library.launchers.phase.${op.phase}`)
}

/**
 * Progression d'une opération : part connue (téléchargement) → barre bleue rayée, grand
 * pourcentage, « 120 Mo / 252 Mo · 8,4 Mo/s · encore 14 s » ; part inconnue (démarrage,
 * installation par winget, attente du désinstalleur) → balayage bleu et compteur « 0:42 ».
 * Le message (« Windows peut demander l'autorisation… ») a sa propre ligne (2 lignes au plus,
 * le texte entier dans la bulle).
 */
function OpProgress({ op, canCancel, onCancel }: { op: LauncherOp; canCancel: boolean; onCancel: () => void }): React.JSX.Element {
  const { t } = useT()
  const running = opRunning(op)
  const downloading = op.phase === 'downloading'
  const known = downloading && op.progress !== null
  const mode: LiveMode = op.phase === 'error' ? 'error' : op.phase === 'done' ? 'done' : known ? 'active' : 'ind'
  // compteur : depuis le début de l'opération pour la première phase, depuis le changement de phase ensuite
  const firstPhase = op.phase === 'starting' || op.phase === 'waiting'
  const elapsed = useElapsed(running && !known ? `${op.id}:${op.startedAt}:${op.phase}` : null, firstPhase ? op.startedAt : undefined)
  const speed = useRate(downloading ? op.received : null, downloading ? `${op.id}:${op.startedAt}` : null)
  const eta = known && speed > 0 && op.total && op.received !== null ? Math.max(0, (op.total - op.received) / speed) : null
  const bytes = op.received !== null && op.total ? `${formatBytes(op.received)} / ${formatBytes(op.total)}` : op.received ? formatBytes(op.received) : null
  const hint =
    op.message ?? (op.phase === 'waiting' ? t('library.launchers.waitingHint') : op.phase === 'installing' ? t('library.launchers.installingHint') : null)
  const label = phaseLabel(op)
  return (
    <div className={`lch-op ph-${op.phase}`} data-testid="launcher-progress" data-phase={op.phase} data-kind={op.kind} role="status" aria-live="polite">
      <div className="lch-op-top">
        {op.phase === 'error' ? <CircleAlert /> : op.phase === 'done' ? <Check /> : <LoaderCircle className="spin" />}
        {/* pas de « … » en capitales mono (il s'y lit « _ ») : le compteur montre déjà que ça vit */}
        <span className="cap ph" title={label}>
          {label.replace(/…$/, '')}
        </span>
        {known ? (
          <span className="big">{formatPercent(op.progress ?? 0)}</span>
        ) : running ? (
          <span className="big clock" title={t('library.launchers.elapsed')}>
            {formatClock(elapsed)}
          </span>
        ) : null}
      </div>
      <LiveBar value={op.phase === 'error' && op.progress === null ? 1 : (op.progress ?? 0)} mode={mode} className="lch-bar" label={label} />
      {downloading && bytes ? (
        <div className="lch-op-stats">
          <span className="mono">{bytes}</span>
          <span className={`mono${speed ? '' : ' nil'}`}>{formatSpeed(speed)}</span>
          {eta !== null && <span className="mono eta">{t('library.launchers.left', { eta: formatEta(eta) })}</span>}
        </div>
      ) : op.phase === 'installing' && op.total ? (
        <div className="lch-op-stats">
          <span className="mono done">
            <Check />
            {t('library.launchers.downloadedSize', {
              size: formatBytes(op.total)
            })}
          </span>
        </div>
      ) : null}
      {hint && (
        <p className={`lch-op-msg${op.phase === 'error' ? ' bad' : ''}`} title={hint}>
          {hint}
        </p>
      )}
      {canCancel && (
        <div className="lch-actions">
          <button
            type="button"
            className="btn btn-sm lch-quiet"
            title={op.phase === 'waiting' ? t('library.launchers.cancelWaitTitle') : t('library.launchers.cancelTitle')}
            data-testid="launcher-cancel"
            onClick={onCancel}
          >
            <X />
            {t('library.launchers.cancel')}
          </button>
        </div>
      )}
    </div>
  )
}

export const LauncherCard = memo(function LauncherCard({
  id,
  status,
  info,
  op,
  pending,
  winget,
  unavailable,
  gameCount,
  onInstall,
  onUninstall,
  onCancel
}: Props): React.JSX.Element {
  const { t, tn } = useT()
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const name = status?.name ?? PLATFORM_INFO[id].name
  const of = ofName(name)
  const state = cardStateOf(status)
  // le lanceur lui-même est là (programme trouvé, ou désinstalleur connu) ; sinon seulement des jeux
  const hasLauncher = state !== 'absent' && (!!status?.clientPath || !!info?.uninstallKind)
  const kind = installKindOf(info ?? undefined, winget)
  const running = opRunning(op)
  const busy = running || pending
  const details = status ? skipDetails(status) : []
  // Annuler : installation winget (seule sorte qui crée une opération), ou attente d'un désinstalleur
  // (sinon CyberDeck attendrait jusqu'à 15 min un désinstalleur fermé sans rien faire)
  const canCancel = !!op && running && (op.kind === 'install' || op.phase === 'waiting')

  // une seule ligne d'état
  const stateText =
    state === 'error'
      ? t('library.launchers.status.error')
      : state === 'absent'
        ? t('library.launchers.state.absent')
        : !hasLauncher
          ? tn('library.launchers.status.gamesOnly', gameCount || status?.installedCount || 0)
          : gameCount
            ? tn('library.launchers.status.games', gameCount)
            : t('library.launchers.status.noGames')

  const installLabel =
    kind === 'store' ? t('library.launchers.openStore') : kind === 'website' ? t('library.launchers.openSite') : t('library.launchers.install')
  const installTitle = unavailable
    ? t('library.launchers.unavailableTitle')
    : kind === 'store'
      ? t('library.launchers.openStoreTitle', { name, of })
      : kind === 'website'
        ? t('library.launchers.openSiteTitle', { url: info?.website ?? '' })
        : t('library.launchers.installTitle', { name, of })
  const uninstallTitle = unavailable
    ? t('library.launchers.unavailableTitle')
    : info?.uninstallKind === 'windows'
      ? t('library.launchers.uninstallWindowsTitle', { name })
      : info?.uninstallKind === 'uninstaller'
        ? t('library.launchers.uninstallTitle', { name, of })
        : window.essaim?.os === 'linux'
          ? t('library.launchers.uninstallLinux', { name, of })
          : t('library.launchers.uninstallNone', { name, of })

  const source = kind === 'winget' ? (info?.wingetId ? `winget · ${info.wingetId}` : 'winget') : kind ? t(`library.launchers.kind.${kind}`) : '—'
  const showOp = !!op && (running || op.phase === 'error' || op.phase === 'done')

  return (
    <article
      className={`lch-card ${state}${hasLauncher ? ' has-launcher' : ''}${busy ? ' busy' : ''}${op?.phase === 'error' ? ' op-error' : ''}${open ? ' open' : ''}`}
      role="listitem"
      aria-label={`${name} · ${stateText}`}
      data-testid="launcher-card"
      data-platform={id}
      data-state={state}
      data-op={op?.phase}
    >
      <header className="lch-head">
        <span className="lch-logo" aria-hidden="true">
          <PlatformLogo platform={id} />
        </span>
        <div className="lch-name">
          <h3 title={name}>{name}</h3>
          <span className={`lch-state ${state}${hasLauncher ? '' : ' nolauncher'}`} title={state === 'error' ? (status?.error ?? undefined) : undefined}>
            <span className="mark" aria-hidden="true" />
            <span className="txt">{stateText}</span>
          </span>
          {/* compte connecté lu sur le PC (BattleTag, nom itch.io) : rien n'est demandé à l'utilisateur */}
          {hasLauncher && info?.account && (
            <span className="lch-account" title={t('library.launchers.accountTitle', { name: info.account.name })} data-testid="launcher-account">
              {info.account.avatar ? (
                <img src={info.account.avatar} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
              ) : (
                <CircleUserRound />
              )}
              <span className="nm">{info.account.name}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          className={`lch-more${open ? ' on' : ''}`}
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={open ? t('library.launchers.detailsHide') : t('library.launchers.detailsShow')}
          title={open ? t('library.launchers.detailsHide') : t('library.launchers.detailsShow')}
          data-testid="launcher-details-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown />
        </button>
      </header>

      <dl className="lch-details" id={detailsId} hidden={!open} data-testid="launcher-details">
        <div>
          <dt className="cap">{t('library.launchers.source')}</dt>
          <dd className="mono" title={kind === 'website' && info?.website ? info.website : undefined}>
            {source}
          </dd>
        </div>
        {state !== 'absent' && (
          <div>
            <dt className="cap">{t('library.launchers.detail.uninstall')}</dt>
            <dd className="mono">
              {info?.uninstallKind === 'windows'
                ? t('library.launchers.detail.windows')
                : info?.uninstallKind === 'uninstaller'
                  ? t('library.launchers.detail.uninstaller')
                  : t('library.launchers.detail.none')}
            </dd>
          </div>
        )}
        {status?.clientPath && (
          <div>
            <dt className="cap">{t('library.launchers.detail.program')}</dt>
            <dd className="mono path" title={status.clientPath}>
              {status.clientPath}
            </dd>
          </div>
        )}
        {details.length > 0 && (
          <div>
            <dt className="cap">{t('library.launchers.detail.skipped')}</dt>
            <dd className="mono" data-testid="platform-skipped">
              {details.map((d, i) => (
                <span key={i} className="line" title={d.title}>
                  {d.text}
                </span>
              ))}
            </dd>
          </div>
        )}
        {state === 'error' && (
          <div>
            <dt className="cap">{t('library.launchers.state.error')}</dt>
            <dd className="err">{status?.error ?? t('library.platforms.readFailed')}</dd>
          </div>
        )}
      </dl>

      <div className="lch-foot">
        {showOp && op ? <OpProgress op={op} canCancel={canCancel} onCancel={() => onCancel(id)} /> : null}
        {!running && (
          <div className="lch-actions">
            {hasLauncher ? (
              <button
                type="button"
                className="btn btn-sm lch-quiet lch-uninstall"
                disabled={unavailable || !info?.uninstallKind || pending}
                title={uninstallTitle}
                data-testid="launcher-uninstall"
                onClick={() => onUninstall(id)}
              >
                {pending ? <LoaderCircle className="spin" /> : <Trash2 />}
                {t('library.launchers.uninstall')}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-line lch-install"
                disabled={unavailable || !kind || pending}
                title={installTitle}
                data-testid="launcher-install"
                data-kind={kind ?? undefined}
                onClick={() => onInstall(id)}
              >
                {pending ? <LoaderCircle className="spin" /> : kind === 'store' ? <Store /> : kind === 'website' ? <ArrowUpRight /> : <Download />}
                {installLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
})
