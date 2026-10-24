import { ArrowLeft, ChevronDown, CircleAlert, Info, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PLATFORM_INFO, PLATFORM_ORDER } from '../../../shared/platforms'
import type { LauncherOp, LauncherPlatform, LaunchersState, LibraryState, PlatformsState } from '../../../shared/types'
import { errorText, formatWhen } from '../format'
import { useT } from '../i18n'
import { cardStateOf, installKindOf, LauncherCard, opRunning } from './LauncherCard'
import { LauncherUninstallDialog } from './LauncherUninstallDialog'
import { SteamAccountPanel } from './SteamAccountPanel'
import type { ToastOptions } from './Toasts'

// Page « Lanceurs » (remplace la fenêtre « Plateformes »), version calme : barre d'outils
// (← Bibliothèque, titre, « 6 sur 11 installés », Resynchroniser compact avec la dernière lecture
// dans sa bulle), une phrase d'introduction, puis deux groupes de cartes simples (LauncherCard) :
// « Installés » d'abord, « Ajouter des lanceurs » ensuite ; les jeux retirés à la main dans une
// section repliée (seulement s'il y en a) et, à droite (dessous dans une fenêtre étroite), le
// compte Steam en bref, avec « Gérer la clé » qui déplie le formulaire de la clé Web API.
// Désinstaller demande d'abord une confirmation qui dit combien de jeux du lanceur sont installés
// (LauncherUninstallDialog). Échap : retour à la bibliothèque (géré par App).

const api = window.essaim

type Toast = (level: 'info' | 'success' | 'error', message: string, opts?: ToastOptions) => void

interface Props {
  platforms: PlatformsState | null
  library: LibraryState
  /** relit toutes les plateformes ; la page suit l'état reçu (syncing) */
  onResync: () => Promise<void>
  onBack: () => void
  onToast: Toast
  /** change à chaque demande « aller à la clé Steam » (0 : aucune) : la page y défile et donne le focus au champ */
  steamKeyFocus: number
}

export function LaunchersView({ platforms, library, onResync, onBack, onToast, steamKeyFocus }: Props): React.JSX.Element {
  const { t, tn } = useT()
  const [launchers, setLaunchers] = useState<LaunchersState | null>(null)
  /** installer / désinstaller indisponible (getLaunchers a échoué) */
  const [unavailable, setUnavailable] = useState(false)
  const [pending, setPending] = useState<Partial<Record<LauncherPlatform, true>>>({})
  const [confirmId, setConfirmId] = useState<LauncherPlatform | null>(null)
  const [resyncing, setResyncing] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [hiddenOpen, setHiddenOpen] = useState(false)
  /** formulaire de la clé Steam déplié (d'office quand on arrive par « Ajouter une clé Steam ») */
  const [steamOpen, setSteamOpen] = useState(steamKeyFocus > 0)
  const focusDone = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const steamRef = useRef<HTMLElement>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const syncing = !!platforms?.syncing || resyncing
  const statuses = platforms?.platforms ?? []
  const detected = statuses.filter((p) => p.state === 'detected').length
  const total = statuses.length || PLATFORM_ORDER.length

  // ---------- État des lanceurs (processus principal) ----------
  // Les appels peuvent manquer (preload d'une version d'avant) : la page reste utilisable,
  // seuls les boutons Installer / Désinstaller sont grisés.
  const latest = useRef<LaunchersState | null>(null)
  const take = useCallback(
    (s: LaunchersState) => {
      const prev = latest.current
      latest.current = s
      setLaunchers(s)
      setUnavailable(false)
      if (!prev) return // premier état : point de départ, aucun toast
      for (const id of PLATFORM_ORDER) {
        const op = s.ops[id]
        const before = prev.ops[id]
        if (!op || (before && before.phase === op.phase && before.startedAt === op.startedAt)) continue
        const name = PLATFORM_INFO[id].name
        if (op.phase === 'done')
          onToast(
            'success',
            t(op.kind === 'install' ? 'library.launchers.installed' : 'library.launchers.uninstalled', { name }),
            op.kind === 'install'
              ? {
                  title: t('library.launchers.cap'),
                  detail: t('library.launchers.installedDetail'),
                  detailKind: 'text'
                }
              : { title: t('library.launchers.cap') }
          )
        else if (op.phase === 'error')
          onToast('error', t(op.kind === 'install' ? 'library.launchers.installFailed' : 'library.launchers.uninstallFailed', { name }), {
            title: t('library.launchers.cap'),
            detail: op.message ?? undefined,
            detailKind: 'text'
          })
      }
    },
    [onToast, t]
  )
  useEffect(() => {
    let alive = true
    let off: () => void = () => {}
    try {
      if (typeof api.onLaunchers === 'function') off = api.onLaunchers((s) => alive && take(s))
    } catch {
      // pas encore branché côté processus principal
    }
    Promise.resolve()
      .then(() => api.getLaunchers())
      .then(
        (s) => alive && !latest.current && take(s),
        () => alive && !latest.current && setUnavailable(true)
      )
    return () => {
      alive = false
      off()
    }
  }, [take])

  const infoOf = (id: LauncherPlatform): LaunchersState['launchers'][number] | null => launchers?.launchers.find((l) => l.id === id) ?? null

  // jeux installés sur ce PC, par lanceur (bibliothèque)
  const gameCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of library.games) if (g.installed && g.platform !== 'local') m.set(g.platform, (m.get(g.platform) ?? 0) + 1)
    return m
  }, [library.games])

  const setBusy = (id: LauncherPlatform, on: boolean): void =>
    setPending((p) => {
      const next = { ...p }
      if (on) next[id] = true
      else delete next[id]
      return next
    })

  /** l'opération de ce lanceur a déjà dit son échec (pas de second toast pour la même erreur) */
  const opFailed = (id: LauncherPlatform): boolean => latest.current?.ops[id]?.phase === 'error'

  const install = useCallback(
    async (id: LauncherPlatform) => {
      const info = latest.current?.launchers.find((l) => l.id === id)
      const kind = installKindOf(info, latest.current?.winget ?? null)
      const name = PLATFORM_INFO[id].name
      setBusy(id, true)
      try {
        const r = await api.installLauncher(id)
        if (!r.ok) {
          if (!opFailed(id)) onToast('error', r.error ?? t('library.launchers.installFailed', { name }), { title: name })
        } else if (kind === 'store' || kind === 'website')
          onToast('info', t(kind === 'store' ? 'library.launchers.storeOpened' : 'library.launchers.siteOpened'), {
            title: name,
            detail: t('library.launchers.openedDetail', { name }),
            detailKind: 'text'
          })
      } catch (err) {
        onToast('error', errorText(err), { title: name })
      }
      setBusy(id, false)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onToast, t]
  )

  const askUninstall = useCallback((id: LauncherPlatform) => setConfirmId(id), [])
  const cancelOp = useCallback((id: LauncherPlatform) => {
    try {
      api.cancelLauncherOp(id)
    } catch {
      // rien à annuler
    }
  }, [])

  async function uninstall(id: LauncherPlatform): Promise<void> {
    const info = infoOf(id)
    const name = PLATFORM_INFO[id].name
    setBusy(id, true)
    try {
      const r = await api.uninstallLauncher(id)
      if (!r.ok) {
        if (!opFailed(id)) onToast('error', r.error ?? t('library.launchers.uninstallFailed', { name }), { title: name })
      } else
        onToast('info', t(info?.uninstallKind === 'windows' ? 'library.launchers.windowsOpened' : 'library.launchers.uninstallerOpened'), {
          title: name,
          detail: t(info?.uninstallKind === 'windows' ? 'library.launchers.windowsOpenedDetail' : 'library.launchers.uninstallerOpenedDetail', { name }),
          detailKind: 'text'
        })
    } catch (err) {
      onToast('error', errorText(err), { title: name })
    }
    setBusy(id, false)
    setConfirmId(null)
  }

  // ---------- Resynchroniser, jeux retirés ----------

  async function resync(): Promise<void> {
    if (syncing) return
    setResyncing(true)
    try {
      await onResync()
    } finally {
      setResyncing(false)
    }
  }

  async function restore(): Promise<void> {
    if (restoring) return
    setRestoring(true)
    try {
      const n = await api.restoreHiddenGames()
      onToast(
        n ? 'success' : 'info',
        n ? tn('library.platforms.restored', n) : t('library.platforms.nothingToRestore'),
        n
          ? {
              title: t('library.launchers.cap'),
              detail: tn('library.platforms.restoredDetail', n),
              detailKind: 'text'
            }
          : { title: t('library.launchers.cap') }
      )
    } catch (err) {
      onToast('error', errorText(err), { title: t('library.launchers.cap') })
    }
    setRestoring(false)
  }

  // ---------- « Ajouter une clé Steam » : la page déplie le formulaire, y défile, focus sur le champ ----------

  useLayoutEffect(() => {
    if (!steamKeyFocus) {
      scrollRef.current?.focus({ preventScroll: true })
      return
    }
    // d'abord déplier (le champ n'existe pas encore), puis au rendu suivant défiler et donner le focus
    if (!steamOpen) return setSteamOpen(true)
    if (focusDone.current === steamKeyFocus) return
    focusDone.current = steamKeyFocus
    steamRef.current?.scrollIntoView({ block: 'start' })
    const input = keyRef.current
    if (input && !input.disabled) input.focus({ preventScroll: true })
    else steamRef.current?.focus({ preventScroll: true })
    steamRef.current?.classList.remove('flash')
    void steamRef.current?.offsetWidth
    steamRef.current?.classList.add('flash')
  }, [steamKeyFocus, steamOpen])

  const confirmInfo = confirmId ? infoOf(confirmId) : null
  const order: LauncherPlatform[] = statuses.length ? statuses.map((p) => p.id) : PLATFORM_ORDER
  // deux groupes : présents sur ce PC (ou en erreur de lecture) d'abord, puis les autres
  const statusOf = (id: LauncherPlatform): PlatformsState['platforms'][number] | null => statuses.find((p) => p.id === id) ?? null
  const installedIds = order.filter((id) => cardStateOf(statusOf(id)) !== 'absent')
  const moreIds = order.filter((id) => cardStateOf(statusOf(id)) === 'absent')
  const lastScan = platforms?.lastSyncAt ? formatWhen(platforms.lastSyncAt) : t('library.platforms.notYet')
  const card = (id: LauncherPlatform): React.JSX.Element => (
    <LauncherCard
      key={id}
      id={id}
      status={statusOf(id)}
      info={infoOf(id)}
      op={launchers?.ops[id]}
      pending={!!pending[id]}
      winget={launchers?.winget ?? null}
      unavailable={unavailable || !launchers}
      gameCount={gameCounts.get(id) ?? 0}
      onInstall={install}
      onUninstall={askUninstall}
      onCancel={cancelOp}
    />
  )
  const anyRunning = !!launchers && Object.values(launchers.ops).some((op) => opRunning(op as LauncherOp))

  return (
    <>
      <div className="toolbar lch-toolbar" role="toolbar" aria-label={t('library.launchers.title')}>
        <button type="button" className="btn btn-line" data-testid="launchers-back" title={t('library.launchers.backTitle')} onClick={onBack}>
          <ArrowLeft />
          {t('library.launchers.back')}
        </button>
        <div className="tsep" />
        <div className="gd-crumb">
          <span className="cap">{t('library.launchers.cap')}</span>
          <span className="nm">{t('library.launchers.title')}</span>
        </div>
        <div className="spacer" />
        <span className="lch-count" data-testid="launchers-count">
          {tn('library.launchers.installedCount', detected, { total })}
        </span>
        <button
          type="button"
          className="btn btn-line btn-sm lch-resync"
          disabled={syncing}
          title={syncing ? t('library.platforms.scanningBtn') : t('library.launchers.resyncTip', { when: lastScan })}
          data-testid="launchers-resync"
          onClick={resync}
        >
          <RefreshCw className={syncing ? 'spin' : undefined} />
          {syncing ? t('library.platforms.scanningBtn') : t('library.platforms.resync')}
        </button>
      </div>

      <div className="lch" ref={scrollRef} tabIndex={-1} data-testid="launchers-view" aria-busy={syncing || anyRunning || undefined}>
        <p className="lch-intro">{t('library.launchers.subtitle')}</p>
        {unavailable ? (
          <p className="lch-note bad" data-testid="launchers-unavailable">
            <CircleAlert />
            {t('library.launchers.unavailable')}
          </p>
        ) : window.essaim?.os === 'linux' ? (
          <p className="lch-note" data-testid="launchers-linux-note">
            <Info />
            {t('library.launchers.linuxNote')}
          </p>
        ) : launchers?.winget === false ? (
          <p className="lch-note" data-testid="launchers-no-winget">
            <Info />
            {t('library.launchers.noWinget')}
          </p>
        ) : null}

        <div className="lch-body">
          <section className="lch-main" aria-label={t('library.launchers.title')}>
            {!platforms ? (
              <div className="plat-wait">
                <LoaderCircle className="spin" />
                {t('library.platforms.loading')}
              </div>
            ) : (
              <>
                <div className="lch-group" data-testid="launchers-group-installed">
                  <div className="sect">
                    <span className="cap">{t('library.launchers.group.installed')}</span>
                    <span className="rule" />
                  </div>
                  {installedIds.length ? (
                    <div className="lch-grid" role="list" aria-label={t('library.launchers.group.installed')}>
                      {installedIds.map(card)}
                    </div>
                  ) : (
                    <p className="lch-empty">{t('library.launchers.group.noneInstalled')}</p>
                  )}
                </div>

                <div className="lch-group" data-testid="launchers-group-more">
                  <div className="sect">
                    <span className="cap">{t('library.launchers.group.more')}</span>
                    <span className="rule" />
                  </div>
                  {moreIds.length ? (
                    <div className="lch-grid" role="list" aria-label={t('library.launchers.group.more')}>
                      {moreIds.map(card)}
                    </div>
                  ) : (
                    <p className="lch-empty">{t('library.launchers.group.allInstalled')}</p>
                  )}
                </div>
              </>
            )}

            {!!platforms?.hiddenCount && (
              <div className={`lch-hidden${hiddenOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="lch-disclose"
                  aria-expanded={hiddenOpen}
                  data-testid="launchers-hidden-toggle"
                  onClick={() => setHiddenOpen((v) => !v)}
                >
                  <ChevronDown />
                  <span className="cap">
                    {t('library.launchers.hiddenGames', {
                      n: platforms.hiddenCount
                    })}
                  </span>
                </button>
                {hiddenOpen && (
                  <div className="plat-hidden">
                    <span>
                      <b>{platforms.hiddenCount}</b> {tn('library.platforms.hidden', platforms.hiddenCount)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-line btn-sm"
                      disabled={restoring}
                      title={t('library.platforms.restoreTitle')}
                      data-testid="btn-restore-hidden"
                      onClick={restore}
                    >
                      {restoring ? <LoaderCircle className="spin" /> : <RotateCcw />}
                      {t('library.platforms.restore')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="lch-side" ref={steamRef} tabIndex={-1} aria-label={t('library.steam.account')} data-testid="steam-key-panel">
            <div className="sect">
              <span className="cap">{t('library.steam.account')}</span>
              <span className="rule" />
            </div>
            <SteamAccountPanel
              steam={platforms?.steam ?? null}
              syncing={syncing}
              inputRef={keyRef}
              onToast={onToast}
              open={steamOpen}
              onToggle={() => setSteamOpen((v) => !v)}
            />
          </section>
        </div>
      </div>

      {confirmId && (
        <LauncherUninstallDialog
          id={confirmId}
          name={PLATFORM_INFO[confirmId].name}
          uninstallKind={confirmInfo?.uninstallKind ?? null}
          gameCount={gameCounts.get(confirmId) ?? 0}
          onCancel={() => setConfirmId(null)}
          onConfirm={() => uninstall(confirmId)}
        />
      )}
    </>
  )
}
