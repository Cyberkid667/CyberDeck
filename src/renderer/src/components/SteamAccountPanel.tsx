import { ArrowUpRight, Check, ChevronDown, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, Trash2, UserRound, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SteamAccountState, SteamAccountStatus, SteamKeyResult } from '../../../shared/types'
import { errorText, formatWhen } from '../format'
import { useT } from '../i18n'
import type { ToastOptions } from './Toasts'

// Compte Steam de la page Lanceurs, en bref : avatar, pseudo, « Relié » / « Non relié », jeux
// possédés, et un bouton « Gérer la clé » (« Ajouter une clé » sans clé) qui déplie le formulaire
// de la clé Web API (Tester / Enregistrer / Retirer, mode d'emploi court, liste des jeux possédés).
// La page le déplie d'office quand on arrive par « Ajouter une clé Steam » (open / onToggle). La place du message d'erreur est réservée : rien ne bouge
// quand une clé est refusée. La clé n'est jamais affichée en clair une fois enregistrée : le
// processus principal la garde chiffrée par Windows. Entrée dans le champ : enregistrer.

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

interface Props {
  steam: SteamAccountState | null
  syncing: boolean
  /** champ de la clé (la page y amène le focus depuis « Ajouter une clé Steam ») */
  inputRef: React.RefObject<HTMLInputElement | null>
  onToast: (level: 'info' | 'success' | 'error', message: string, opts?: ToastOptions) => void
  /** formulaire de la clé déplié */
  open: boolean
  onToggle: () => void
}

export function SteamAccountPanel({ steam, syncing, inputRef, onToast, open, onToggle }: Props): React.JSX.Element {
  const { t, tn } = useT()
  const KEY_HINT = t('library.steam.keyHint')
  const [key, setKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | 'clear' | 'refresh' | null>(null)
  /** résultat de la dernière action ; invalid : la clé tapée est en cause (champ en rouge) */
  const [result, setResult] = useState<{
    ok: boolean
    message: string
    invalid?: boolean
  } | null>(null)
  const [armed, setArmed] = useState(false)

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

  async function clear(): Promise<void> {
    if (busy) return
    if (!armed) return setArmed(true)
    setArmed(false)
    setBusy('clear')
    try {
      await window.essaim.clearSteamApiKey()
      setResult(null)
      onToast('info', t('library.steam.keyRemoved'), {
        title: 'Steam',
        detail: t('library.steam.keyRemovedDetail'),
        detailKind: 'text'
      })
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
  // (sinon la hauteur du billet change et la page bouge), sauf s'il dit la même chose
  const note = status !== 'ok' && status !== 'checking' && steam?.message !== result?.message ? steam?.message : null
  const noteBad = band.tone === 'bad'

  // ligne d'état du compte, en bref
  const stText = busy === 'save' ? t('library.steam.checking') : status === 'no-key' ? t('library.steam.notLinked') : t(band.text)
  const stTone = status === 'ok' ? 'ok' : band.tone
  const formId = 'steam-key-form'

  return (
    <div className={`lch-steam${open ? ' open' : ''}`} aria-label={t('library.steam.account')} data-testid="steam-account" data-status={status}>
      <div className="sa-top">
        {steam?.avatarUrl ? (
          <img className="av" src={steam.avatarUrl} alt="" decoding="async" draggable={false} />
        ) : (
          <span className="av none" aria-hidden="true">
            <UserRound />
          </span>
        )}
        <div className="who">
          <span className="pn" title={steam?.steamId ? t('library.steam.steamId', { id: steam.steamId }) : undefined}>
            {detected ? (steam?.personaName ?? t('library.steam.account')) : t('library.steam.noAccountFound')}
          </span>
          <span className={`sa-st ${stTone}`}>
            {status === 'checking' || busy === 'save' ? <LoaderCircle className="spin" /> : stTone === 'ok' ? <Check /> : stTone === 'bad' ? <X /> : null}
            <span className="cap">{stText}</span>
          </span>
        </div>
      </div>
      {steam?.hasKey && steam.ownedCount !== null && (
        <p className="sa-owned">
          {tn('library.steam.owned', steam.ownedCount)}
          {steam.ownedNotInstalledCount !== null && (
            <span className="sub">
              {' · '}
              {steam.ownedNotInstalledCount} {t('library.steam.notInstalled').toLowerCase()}
            </span>
          )}
        </p>
      )}
      <button
        type="button"
        className={`btn btn-line btn-sm sa-manage${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-controls={formId}
        disabled={!detected && !open}
        title={t('library.steam.manageTitle')}
        data-testid="steam-key-manage"
        onClick={onToggle}
      >
        <KeyRound />
        <span className="lbl">{open ? t('library.steam.closeKey') : steam?.hasKey ? t('library.steam.manageKey') : t('library.steam.addKey')}</span>
        <ChevronDown className="chev" />
      </button>

      {open && (
        <div className="sa-form" id={formId}>
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
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void save()
                  }
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
                    ? t('library.steam.readWhen', {
                        when: formatWhen(steam.lastRefreshAt)
                      })
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
                  <button type="button" className="link" title={t('library.steam.howtoOpenTitle')} onClick={() => window.essaim.openSteamApiKeyPage()}>
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
      )}
    </div>
  )
}
