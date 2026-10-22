import { ArrowUpRight, Check, CircleAlert, Eye, EyeOff, LoaderCircle, RefreshCw, RotateCcw, Trash2, UserRound, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { t, tn } from '../../../shared/i18n'
import type {
  PlatformSkip,
  PlatformSkipReason,
  PlatformsState,
  PlatformStatus,
  SteamAccountState,
  SteamAccountStatus,
  SteamKeyResult
} from '../../../shared/types'
import { errorText, formatWhen } from '../format'
import { useT } from '../i18n'
import { gamesWord, platformName } from '../platformUi'
import { useScrollFade } from '../useScrollFade'
import { DialogFrame, DialogHead, Keys } from './AddDialog'
import { PlatformLogo } from './PlatformLogo'
import type { ToastOptions } from './Toasts'

// Fenêtre « Plateformes » (SPEC 5.12, 820 px avec billet ; 720 px sous 1100 px) :
// à gauche, les 11 plateformes toujours dans le même ordre, avec leur état
// (détectée · N jeux / pas installée / erreur) et le détail des éléments écartés (« 4 écartés :
// outils, logiciel », « 1 déjà dans tes jeux locaux », noms dans la bulle), la dernière lecture et
// « Resynchroniser » ; les jeux retirés à la main (« Remettre »). En-tête et pied restent fixes :
// seule la liste défile (fondu en bas) dans une fenêtre basse. À droite, le billet du compte
// Steam : profil trouvé sur ce PC, clé Web API (Tester / Enregistrer / Retirer), mode d'emploi
// court, jeux possédés ; seule sa partie basse défile. La place du message d'erreur est réservée :
// rien ne bouge quand une clé est refusée. La clé n'est jamais affichée en clair une fois
// enregistrée : le processus principal la garde chiffrée par Windows.

interface Props {
  state: PlatformsState | null
  onClose: () => void
  /** relit toutes les plateformes ; la fenêtre suit l'état reçu (syncing) */
  onResync: () => Promise<void>
  onToast: (level: 'info' | 'success' | 'error', message: string, opts?: ToastOptions) => void
}

const KEY_FORMAT = /^[0-9a-f]{32}$/i
const normalizeKey = (k: string): string => k.replace(/\s+/g, '')

/**
 * Bandeau du billet Steam : état du compte en capitales (vert jamais : « ✓ RELIÉ » en --tx-2, comme « ✓ VALIDE »).
 * text : clé du texte (traduit au rendu).
 */
const BAND: Record<SteamAccountStatus, { text: string; tone: 'ok' | 'bad' | 'wait' }> = {
  'no-account': { text: 'library.steam.band.noAccount', tone: 'wait' },
  'no-key': { text: 'library.steam.band.noKey', tone: 'wait' },
  checking: { text: 'library.steam.band.checking', tone: 'wait' },
  ok: { text: 'library.steam.band.ok', tone: 'ok' },
  'invalid-key': { text: 'library.steam.band.invalidKey', tone: 'bad' },
  private: { text: 'library.steam.band.private', tone: 'bad' },
  offline: { text: 'library.steam.band.offline', tone: 'wait' },
  error: { text: 'library.steam.band.error', tone: 'bad' },
  unavailable: { text: 'library.steam.band.unavailable', tone: 'bad' }
}

type NotGame = Exclude<PlatformSkipReason, 'local' | 'platform'>
const NOT_GAME: NotGame[] = ['tool', 'app', 'dlc', 'other']
const capFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Détail d'une plateforme : « 4 écartés : outils, logiciel », « 1 déjà dans tes jeux locaux »,
 * « 1 déjà sur Steam » ; la bulle donne les noms. Un état enregistré par une version d'avant
 * (sans noms) donne seulement les nombres.
 */
function skipDetails(p: PlatformStatus): { text: string; title?: string }[] {
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
        ? t('library.platforms.excludedList', { count, reasons: groups.map(([r, l]) => word(r, l.length)).join(', ') })
        : count,
      title: groups.length
        ? groups
            .map(([r, l]) => t('library.platforms.reasonLine', { reason: capFirst(word(r, l.length)), names: l.map((s) => s.name).join(', ') }))
            .join('\n') + (n > listed ? `\n${tn('library.platforms.andMore', n - listed)}` : '')
        : undefined
    })
  }
  const local = sk.filter((s) => s.reason === 'local')
  const other = sk.filter((s) => s.reason === 'platform')
  if (local.length) out.push({ text: t('library.platforms.inLocal', { n: local.length }), title: local.map((s) => s.name).join(', ') })
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
  if (!local.length && !other.length && p.duplicateCount) out.push({ text: t('library.platforms.inLibrary', { n: p.duplicateCount }) })
  return out
}

function PlatformRow({ p }: { p: PlatformStatus }): React.JSX.Element {
  const { t } = useT()
  const details = skipDetails(p)
  return (
    <div
      className={`plat-row ${p.state}`}
      role="listitem"
      data-testid="platform-row"
      data-platform={p.id}
      data-state={p.state}
      title={p.clientPath ? t('library.platforms.launcherTitle', { path: p.clientPath }) : undefined}
    >
      <span className="mark" aria-hidden="true" />
      <div className="pmain">
        <span className="nm">
          <PlatformLogo platform={p.id} />
          {p.name}
        </span>
        {p.state === 'error' ? (
          <span className="perr" title={p.error ?? undefined}>
            {p.error ?? t('library.platforms.readFailed')}
          </span>
        ) : details.length ? (
          <span className="sub" data-testid="platform-skipped">
            {details.map((d, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="deco"> · </span>}
                <span title={d.title}>{d.text}</span>
              </Fragment>
            ))}
          </span>
        ) : null}
      </div>
      <span className="st">
        {p.state === 'detected' ? (
          p.installedCount ? (
            <>
              {t('library.platforms.detected')} · <b>{p.installedCount}</b> {gamesWord(p.installedCount)}
            </>
          ) : (
            t('library.platforms.detectedNone')
          )
        ) : p.state === 'error' ? (
          t('library.platforms.error')
        ) : (
          tn('library.platforms.notInstalled', 1)
        )}
      </span>
    </div>
  )
}

interface SteamProps {
  steam: SteamAccountState | null
  syncing: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Entrée dans le champ de la clé : enregistrer */
  saveRef: React.MutableRefObject<() => void>
  onToast: Props['onToast']
}

/** Billet du compte Steam (colonne droite). */
function SteamPlate({ steam, syncing, inputRef, saveRef, onToast }: SteamProps): React.JSX.Element {
  const { t, tn } = useT()
  const KEY_HINT = t('library.steam.keyHint')
  const [key, setKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | 'clear' | 'refresh' | null>(null)
  /** résultat de la dernière action ; invalid : la clé tapée est en cause (champ en rouge) */
  const [result, setResult] = useState<{ ok: boolean; message: string; invalid?: boolean } | null>(null)
  const [armed, setArmed] = useState(false)
  // partie basse du billet : défile seule dans une fenêtre basse (fondu en bas)
  const infoRef = useRef<HTMLDivElement>(null)
  useScrollFade(infoRef, `${steam?.hasKey}|${steam?.status}|${!!result}`)

  // « Retirer la clé » armé : le second clic confirme ; sans second clic, il se désarme seul
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  const status: SteamAccountStatus = steam?.status ?? 'checking'
  const band = BAND[status]
  const detected = !!steam?.detected
  const canType = detected && !!steam?.canStoreKey && !busy
  const typed = normalizeKey(key)
  const bad = !!result?.invalid

  const apply = (r: SteamKeyResult, saving: boolean): void => {
    setResult({
      ok: r.ok,
      message: r.ok && !saving && r.gameCount !== undefined ? tn('library.steam.validKey', r.gameCount) : r.message,
      invalid: r.status === 'invalid-key'
    })
    // clé gardée par le processus principal (bonne, ou hors ligne / profil privé : il réessaiera) : le champ se vide
    if (saving && r.account?.hasKey && r.status !== 'invalid-key') {
      setKey('')
      setReveal(false)
      if (r.ok)
        onToast('success', t('library.steam.linked'), {
          title: 'Steam',
          detail: r.account.ownedCount !== null ? tn('library.steam.owned', r.account.ownedCount) : r.message,
          detailKind: r.account.ownedCount !== null ? 'name' : 'text'
        })
    }
  }

  async function test(): Promise<void> {
    if (busy) return
    if (typed && !KEY_FORMAT.test(typed)) return setResult({ ok: false, message: KEY_HINT, invalid: true })
    setBusy('test')
    setResult(null)
    try {
      apply(await window.essaim.testSteamApiKey(typed || undefined), false)
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
    }
    setBusy(null)
  }

  async function save(): Promise<void> {
    if (busy || !typed) return
    if (!KEY_FORMAT.test(typed)) {
      setResult({ ok: false, message: KEY_HINT, invalid: true })
      inputRef.current?.focus()
      return
    }
    setBusy('save')
    setResult(null)
    try {
      apply(await window.essaim.setSteamApiKey(typed), true)
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
    }
    setBusy(null)
  }
  saveRef.current = () => void save()

  async function clear(): Promise<void> {
    if (busy) return
    if (!armed) return setArmed(true)
    setArmed(false)
    setBusy('clear')
    try {
      await window.essaim.clearSteamApiKey()
      setResult(null)
      onToast('info', t('library.steam.keyRemoved'), { title: 'Steam', detail: t('library.steam.keyRemovedDetail'), detailKind: 'text' })
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
    }
    setBusy(null)
  }

  async function refresh(): Promise<void> {
    if (busy) return
    setBusy('refresh')
    setResult(null)
    try {
      const s = await window.essaim.refreshSteamOwned()
      if (s.status !== 'ok' && s.message) setResult({ ok: false, message: s.message })
    } catch (err) {
      setResult({ ok: false, message: errorText(err) })
    }
    setBusy(null)
  }

  // message d'état du compte (aide ou erreur) : il reste affiché avec le résultat d'une action
  // (sinon la hauteur du billet change et la fenêtre bouge), sauf s'il dit la même chose
  const note = status !== 'ok' && status !== 'checking' && steam?.message !== result?.message ? steam?.message : null
  const noteBad = band.tone === 'bad'

  return (
    <aside className="dplate steam-plate" aria-label={t('library.steam.account')} data-testid="steam-account" data-status={status}>
      <div className="ticket">
        <div className="band">
          <span className="cap">{t('library.steam.account')}</span>
          <span className={`cap state${band.tone === 'bad' ? ' bad' : band.tone === 'wait' ? ' wait' : ''}`}>
            {status === 'checking' || busy === 'save' ? (
              <LoaderCircle className="spin" />
            ) : band.tone === 'ok' ? (
              <Check />
            ) : band.tone === 'bad' ? (
              <X />
            ) : null}
            {busy === 'save' ? t('library.steam.checking') : t(band.text)}
          </span>
        </div>

        <div className="sprof">
          {steam?.avatarUrl ? (
            <img className="av" src={steam.avatarUrl} alt="" decoding="async" draggable={false} />
          ) : (
            <span className="av none" aria-hidden="true">
              <UserRound />
            </span>
          )}
          <div className="who">
            <span className="pn" title={steam?.personaName ?? undefined}>
              {detected ? (steam?.personaName ?? t('library.steam.account')) : t('library.steam.noAccountFound')}
            </span>
            <span className="sid">{steam?.steamId ? t('library.steam.steamId', { id: steam.steamId }) : t('library.steam.profileLocal')}</span>
          </div>
        </div>

        <div className="perf" />

        <div className="info" ref={infoRef}>
          {note && <p className={`note${noteBad ? ' bad' : ''}`}>{note}</p>}

          <div className="kfield">
            <div className="lab">
              <label className="cap" htmlFor="steam-key">
                {t('library.steam.keyLabel')}
              </label>
              <span className="cap" title={steam?.hasKey ? t('library.steam.keyStoredTitle') : undefined}>
                {steam?.hasKey ? t('library.steam.keySaved') : t('library.steam.keyOptional')}
              </span>
            </div>
            <div className="krow">
              <input
                id="steam-key"
                ref={inputRef}
                className={`inp${bad ? ' invalid' : ''}`}
                type={reveal ? 'text' : 'password'}
                value={key}
                placeholder={steam?.hasKey ? t('library.steam.pasteOther') : t('library.steam.keyChars')}
                spellCheck={false}
                autoComplete="off"
                disabled={!canType}
                aria-invalid={bad || undefined}
                data-testid="steam-key-input"
                onChange={(e) => {
                  setKey(e.target.value)
                  if (result && !result.ok) setResult(null)
                }}
              />
              <button
                type="button"
                className="eye"
                disabled={!canType || !key}
                aria-label={reveal ? t('library.steam.hideKey') : t('library.steam.showKey')}
                title={reveal ? t('library.steam.hideKey') : t('library.steam.showKey')}
                onClick={() => setReveal((v) => !v)}
              >
                {reveal ? <EyeOff /> : <Eye />}
              </button>
            </div>
            <div className="kbtns">
              <button
                type="button"
                className="btn btn-line"
                disabled={!detected || !!busy || (!typed && !steam?.hasKey)}
                title={typed ? t('library.steam.testTitleTyped') : t('library.steam.testTitleSaved')}
                data-testid="steam-key-test"
                onClick={test}
              >
                {busy === 'test' ? <LoaderCircle className="spin" /> : null}
                {t('library.steam.test')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canType || !typed}
                title={t('library.steam.saveTitle')}
                data-testid="steam-key-save"
                onClick={save}
              >
                {busy === 'save' ? <LoaderCircle className="spin" /> : null}
                {t('library.common.save')}
              </button>
            </div>
            <div className={`kmsg${result ? (result.ok ? ' ok' : ' bad') : ''}`} role="status" aria-live="polite">
              {result ? (
                <>
                  {result.ok ? <Check /> : <CircleAlert />}
                  <span>{result.message}</span>
                </>
              ) : null}
            </div>
          </div>

          {steam?.hasKey ? (
            <div className="owned">
              <div className="kv">
                <div>
                  <span className="cap">{t('library.steam.ownedGames')}</span>
                  <span className="big">{steam.ownedCount ?? '—'}</span>
                </div>
                <div>
                  <span className="cap">{t('library.steam.notInstalled')}</span>
                  <span className="big">{steam.ownedNotInstalledCount ?? '—'}</span>
                </div>
              </div>
              <span className="cap olast">
                {status === 'checking' || busy === 'refresh'
                  ? t('library.steam.readingList')
                  : steam.lastRefreshAt
                    ? t('library.steam.readWhen', { when: formatWhen(steam.lastRefreshAt) })
                    : t('library.steam.notReadYet')}
              </span>
              <div className="orow">
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  disabled={!!busy || syncing || status === 'checking'}
                  title={t('library.steam.refreshTitle')}
                  data-testid="steam-refresh"
                  onClick={refresh}
                >
                  <RefreshCw className={busy === 'refresh' ? 'spin' : undefined} />
                  {t('library.steam.refresh')}
                </button>
                <button
                  type="button"
                  className={`btn btn-danger btn-sm${armed ? ' armed' : ''}`}
                  disabled={!!busy && busy !== 'clear'}
                  title={t('library.steam.clearTitle')}
                  data-testid="steam-key-clear"
                  onClick={clear}
                >
                  <Trash2 />
                  {armed ? t('library.steam.confirmClear') : t('library.steam.clear')}
                </button>
              </div>
            </div>
          ) : (
            <div className="howto">
              <span className="cap">{t('library.steam.howto')}</span>
              <ol>
                <li>
                  {t('library.steam.howtoOpen')}{' '}
                  <button
                    type="button"
                    className="link"
                    title={t('library.steam.howtoOpenTitle')}
                    onClick={() => window.essaim.openSteamApiKeyPage()}
                  >
                    steamcommunity.com/dev/apikey
                    <ArrowUpRight />
                  </button>{' '}
                  {t('library.steam.howtoSignIn')}
                </li>
                <li>
                  {t('library.steam.howtoDomain')} <q>localhost</q>
                  {t('library.steam.howtoDomainAfter')}
                </li>
                <li>{t('library.steam.howtoPaste')}</li>
              </ol>
              <p className="fine">{t('library.steam.howtoFine')}</p>
            </div>
          )}
          {steam?.hasKey && (
            <div className="pfoot">
              <span className="cap">{t('library.steam.footList')}</span>
              <span className="cap">{t('library.steam.footKey')}</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

export function PlatformsDialog({ state, onClose, onResync, onToast }: Props): React.JSX.Element {
  const { t, tn } = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  // focus d'ouverture près du haut (sinon une fenêtre basse défile et cache le titre)
  const resyncRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<() => void>(() => {})
  const [resyncing, setResyncing] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const syncing = !!state?.syncing || resyncing
  const steam = state?.steam ?? null
  const platforms = state?.platforms ?? []
  const detected = platforms.filter((p) => p.state === 'detected').length
  const absent = platforms.filter((p) => p.state === 'absent')
  // Champ de la clé au premier plan s'il attend une clé ; sinon « Fermer »
  const [focusKey] = useState(() => !!steam?.detected && !steam.hasKey && steam.canStoreKey)
  // liste des plateformes : seule partie de la colonne qui défile (fenêtre basse), fondu en bas
  const listRef = useRef<HTMLDivElement>(null)
  useScrollFade(listRef, platforms.map((p) => `${p.id}:${p.state}:${p.skipped?.length ?? 0}`).join(','))

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
      const n = await window.essaim.restoreHiddenGames()
      onToast(
        n ? 'success' : 'info',
        n ? tn('library.platforms.restored', n) : t('library.platforms.nothingToRestore'),
        n
          ? { title: t('library.common.platforms'), detail: tn('library.platforms.restoredDetail', n), detailKind: 'text' }
          : { title: t('library.common.platforms') }
      )
    } catch (err) {
      onToast('error', errorText(err), { title: t('library.common.platforms') })
    }
    setRestoring(false)
  }

  return (
    <DialogFrame
      kind="platforms"
      labelledBy="plat-title"
      onClose={onClose}
      onEnter={() => {
        if (document.activeElement === inputRef.current) saveRef.current()
      }}
      initialFocus={focusKey ? inputRef : resyncRef}
      aside={<SteamPlate steam={steam} syncing={syncing} inputRef={inputRef} saveRef={saveRef} onToast={onToast} />}
    >
      <DialogHead id="plat-title" cap={t('library.common.platforms')} title={t('library.platforms.title')} onClose={onClose} />
      <p className="dnote">{t('library.platforms.intro')}</p>

      <div className="plat-sync">
        <div className="when">
          <span className="cap">{syncing ? t('library.platforms.syncingCap') : t('library.platforms.lastSync')}</span>
          {syncing ? (
            <span className="scanbar" aria-hidden="true">
              <i />
            </span>
          ) : (
            <span className="v">{state?.lastSyncAt ? formatWhen(state.lastSyncAt) : t('library.platforms.notYet')}</span>
          )}
        </div>
        <span className="cap count">{tn('library.platforms.detectedCount', detected, { total: platforms.length || 11 })}</span>
        <button
          ref={resyncRef}
          type="button"
          className="btn btn-line"
          disabled={syncing}
          title={t('library.platforms.resyncTitle')}
          data-testid="btn-resync"
          onClick={resync}
        >
          <RefreshCw className={syncing ? 'spin' : undefined} />
          {syncing ? t('library.platforms.scanningBtn') : t('library.platforms.resync')}
        </button>
      </div>

      <div className="plat-list">
        <div className="plat-scroll" ref={listRef} role="list" aria-label={t('library.common.platforms')} aria-busy={syncing || undefined}>
          {platforms.length ? (
            <>
              {platforms.filter((p) => p.state !== 'absent').map((p) => (
                <PlatformRow key={p.id} p={p} />
              ))}
              {absent.length > 0 && (
                // les lanceurs absents de ce PC tiennent sur une ligne (toujours dans le même ordre)
                <div className="plat-row absent" role="listitem" data-testid="platform-row-absent">
                  <span className="mark" aria-hidden="true" />
                  <div className="pmain">
                    <span className="nm names" title={absent.map((p) => p.name).join(' · ')}>
                      {absent.map((p, i) => (
                        <Fragment key={p.id}>
                          {i > 0 && <span className="deco"> · </span>}
                          <span className="pname" data-testid="platform-row" data-platform={p.id} data-state="absent">
                            {p.name}
                          </span>
                        </Fragment>
                      ))}
                    </span>
                  </div>
                  <span className="st">{tn('library.platforms.notInstalled', absent.length)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="plat-wait">
              <LoaderCircle className="spin" />
              {t('library.platforms.loading')}
            </div>
          )}
        </div>
      </div>

      {!!state?.hiddenCount && (
        <div className="plat-hidden">
          <span>
            <b>{state.hiddenCount}</b> {tn('library.platforms.hidden', state.hiddenCount)}
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

      {/* espace d'au moins 18 px qui pousse le pied en bas quand le billet de droite est plus haut */}
      <div className="plat-fill" aria-hidden="true" />
      <div className="dfoot">
        <Keys keys={[[t('library.common.keyEsc'), t('library.common.actClose')]]} />
        <button type="button" className="btn btn-line" data-testid="dialog-cancel" onClick={onClose}>
          {t('library.common.close')}
        </button>
      </div>
    </DialogFrame>
  )
}
