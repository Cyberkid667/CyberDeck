import { ArrowUpRight, Check, CircleAlert, Eye, EyeOff, LoaderCircle, RefreshCw, RotateCcw, Trash2, UserRound, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
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
const KEY_HINT = 'Une clé Steam fait 32 caractères (chiffres et lettres A à F).'
const normalizeKey = (k: string): string => k.replace(/\s+/g, '')

/** Bandeau du billet Steam : état du compte en capitales (vert jamais : « ✓ RELIÉ » en --tx-2, comme « ✓ VALIDE »). */
const BAND: Record<SteamAccountStatus, { text: string; tone: 'ok' | 'bad' | 'wait' }> = {
  'no-account': { text: 'Aucun compte', tone: 'wait' },
  'no-key': { text: 'Clé manquante', tone: 'wait' },
  checking: { text: 'Lecture…', tone: 'wait' },
  ok: { text: 'Relié', tone: 'ok' },
  'invalid-key': { text: 'Clé refusée', tone: 'bad' },
  private: { text: 'Profil privé', tone: 'bad' },
  offline: { text: 'Hors ligne', tone: 'wait' },
  error: { text: 'Erreur', tone: 'bad' },
  unavailable: { text: 'Indisponible', tone: 'bad' }
}

type NotGame = Exclude<PlatformSkipReason, 'local' | 'platform'>
const NOT_GAME: NotGame[] = ['tool', 'app', 'dlc', 'other']
/** mot de la raison : [singulier, pluriel] */
const REASON_WORD: Record<NotGame, [string, string]> = {
  tool: ['outil', 'outils'],
  app: ['logiciel', 'logiciels'],
  dlc: ['DLC', 'DLC'],
  other: ['autre', 'autres']
}
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
    const word = (r: NotGame, k: number): string => REASON_WORD[r][k > 1 ? 1 : 0]
    out.push({
      text: `${n} écarté${n > 1 ? 's' : ''}${groups.length ? ` : ${groups.map(([r, l]) => word(r, l.length)).join(', ')}` : ''}`,
      title: groups.length
        ? groups.map(([r, l]) => `${capFirst(word(r, l.length))} : ${l.map((s) => s.name).join(', ')}`).join('\n') +
          (n > listed ? `\net ${n - listed} autre${n - listed > 1 ? 's' : ''}` : '')
        : undefined
    })
  }
  const local = sk.filter((s) => s.reason === 'local')
  const other = sk.filter((s) => s.reason === 'platform')
  if (local.length) out.push({ text: `${local.length} déjà dans tes jeux locaux`, title: local.map((s) => s.name).join(', ') })
  if (other.length) {
    const plats = [...new Set(other.map((s) => s.other))]
    out.push({
      text: `${other.length} déjà sur ${plats.length === 1 && plats[0] ? platformName(plats[0]) : 'une autre plateforme'}`,
      title: other.map((s) => (s.other ? `${s.name} (${platformName(s.other)})` : s.name)).join(', ')
    })
  }
  if (!local.length && !other.length && p.duplicateCount) out.push({ text: `${p.duplicateCount} déjà dans la bibliothèque` })
  return out
}

function PlatformRow({ p }: { p: PlatformStatus }): React.JSX.Element {
  const details = skipDetails(p)
  return (
    <div
      className={`plat-row ${p.state}`}
      role="listitem"
      data-testid="platform-row"
      data-platform={p.id}
      data-state={p.state}
      title={p.clientPath ? `Lanceur : ${p.clientPath}` : undefined}
    >
      <span className="mark" aria-hidden="true" />
      <div className="pmain">
        <span className="nm">
          <PlatformLogo platform={p.id} />
          {p.name}
        </span>
        {p.state === 'error' ? (
          <span className="perr" title={p.error ?? undefined}>
            {p.error ?? 'Lecture impossible.'}
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
              Détectée · <b>{p.installedCount}</b> {gamesWord(p.installedCount)}
            </>
          ) : (
            'Détectée · aucun jeu'
          )
        ) : p.state === 'error' ? (
          'Erreur'
        ) : (
          'Pas installée'
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
      message: r.ok && !saving && r.gameCount !== undefined ? `Clé valide : ${r.gameCount} ${gamesWord(r.gameCount)} possédés.` : r.message,
      invalid: r.status === 'invalid-key'
    })
    // clé gardée par le processus principal (bonne, ou hors ligne / profil privé : il réessaiera) : le champ se vide
    if (saving && r.account?.hasKey && r.status !== 'invalid-key') {
      setKey('')
      setReveal(false)
      if (r.ok)
        onToast('success', 'Compte Steam relié', {
          title: 'Steam',
          detail: r.account.ownedCount !== null ? `${r.account.ownedCount} jeux possédés` : r.message,
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
      onToast('info', 'Clé Steam retirée.', { title: 'Steam', detail: 'Les jeux possédés pas installés quittent la bibliothèque.', detailKind: 'text' })
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
    <aside className="dplate steam-plate" aria-label="Compte Steam" data-testid="steam-account" data-status={status}>
      <div className="ticket">
        <div className="band">
          <span className="cap">Compte Steam</span>
          <span className={`cap state${band.tone === 'bad' ? ' bad' : band.tone === 'wait' ? ' wait' : ''}`}>
            {status === 'checking' || busy === 'save' ? (
              <LoaderCircle className="spin" />
            ) : band.tone === 'ok' ? (
              <Check />
            ) : band.tone === 'bad' ? (
              <X />
            ) : null}
            {busy === 'save' ? 'Vérification…' : band.text}
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
              {detected ? (steam?.personaName ?? 'Compte Steam') : 'Aucun compte trouvé'}
            </span>
            <span className="sid">{steam?.steamId ? `ID ${steam.steamId}` : 'Profil lu sur ce PC'}</span>
          </div>
        </div>

        <div className="perf" />

        <div className="info" ref={infoRef}>
          {note && <p className={`note${noteBad ? ' bad' : ''}`}>{note}</p>}

          <div className="kfield">
            <div className="lab">
              <label className="cap" htmlFor="steam-key">
                Clé Web API
              </label>
              <span className="cap" title={steam?.hasKey ? 'Gardée chiffrée par Windows sur ce PC' : undefined}>
                {steam?.hasKey ? 'Enregistrée' : 'Facultative'}
              </span>
            </div>
            <div className="krow">
              <input
                id="steam-key"
                ref={inputRef}
                className={`inp${bad ? ' invalid' : ''}`}
                type={reveal ? 'text' : 'password'}
                value={key}
                placeholder={steam?.hasKey ? 'Coller une autre clé' : '32 caractères'}
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
                aria-label={reveal ? 'Masquer la clé' : 'Afficher la clé'}
                title={reveal ? 'Masquer la clé' : 'Afficher la clé'}
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
                title={typed ? 'Vérifier cette clé auprès de Steam, sans l’enregistrer' : 'Vérifier la clé enregistrée'}
                data-testid="steam-key-test"
                onClick={test}
              >
                {busy === 'test' ? <LoaderCircle className="spin" /> : null}
                Tester
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canType || !typed}
                title="Vérifier la clé, l’enregistrer chiffrée et lire tes jeux possédés"
                data-testid="steam-key-save"
                onClick={save}
              >
                {busy === 'save' ? <LoaderCircle className="spin" /> : null}
                Enregistrer
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
                  <span className="cap">Jeux possédés</span>
                  <span className="big">{steam.ownedCount ?? '—'}</span>
                </div>
                <div>
                  <span className="cap">Pas installés</span>
                  <span className="big">{steam.ownedNotInstalledCount ?? '—'}</span>
                </div>
              </div>
              <span className="cap olast">
                {status === 'checking' || busy === 'refresh'
                  ? 'Lecture de la liste…'
                  : steam.lastRefreshAt
                    ? `Lue ${formatWhen(steam.lastRefreshAt)}`
                    : 'Liste pas encore lue'}
              </span>
              <div className="orow">
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  disabled={!!busy || syncing || status === 'checking'}
                  title="Relire maintenant la liste de tes jeux Steam"
                  data-testid="steam-refresh"
                  onClick={refresh}
                >
                  <RefreshCw className={busy === 'refresh' ? 'spin' : undefined} />
                  Actualiser
                </button>
                <button
                  type="button"
                  className={`btn btn-danger btn-sm${armed ? ' armed' : ''}`}
                  disabled={!!busy && busy !== 'clear'}
                  title="Oublier la clé : les jeux possédés pas installés quittent la bibliothèque"
                  data-testid="steam-key-clear"
                  onClick={clear}
                >
                  <Trash2 />
                  {armed ? 'Confirmer le retrait' : 'Retirer la clé'}
                </button>
              </div>
            </div>
          ) : (
            <div className="howto">
              <span className="cap">Comment avoir une clé</span>
              <ol>
                <li>
                  Ouvre{' '}
                  <button
                    type="button"
                    className="link"
                    title="Ouvrir https://steamcommunity.com/dev/apikey dans le navigateur"
                    onClick={() => window.essaim.openSteamApiKeyPage()}
                  >
                    steamcommunity.com/dev/apikey
                    <ArrowUpRight />
                  </button>{' '}
                  et connecte-toi.
                </li>
                <li>
                  Nom de domaine : écris <q>localhost</q>, accepte les conditions, clique sur Enregistrer.
                </li>
                <li>Copie la clé de 32 caractères et colle-la ici.</li>
              </ol>
              <p className="fine">Elle reste chiffrée sur ce PC et sert seulement à lire la liste de tes jeux.</p>
            </div>
          )}
          {steam?.hasKey && (
            <div className="pfoot">
              <span className="cap">Liste lue via Steam Web API</span>
              <span className="cap">Clé chiffrée sur ce PC</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

export function PlatformsDialog({ state, onClose, onResync, onToast }: Props): React.JSX.Element {
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
        n ? `${n} ${gamesWord(n)} remis dans la bibliothèque.` : 'Aucun jeu à remettre.',
        n
          ? { title: 'Plateformes', detail: n > 1 ? 'Ils reviennent avec la lecture des plateformes.' : 'Il revient avec la lecture des plateformes.', detailKind: 'text' }
          : { title: 'Plateformes' }
      )
    } catch (err) {
      onToast('error', errorText(err), { title: 'Plateformes' })
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
      <DialogHead id="plat-title" cap="02.5 · Plateformes" title="Plateformes de jeux" onClose={onClose} />
      <p className="dnote">Les jeux de tes lanceurs arrivent tout seuls dans la bibliothèque et se lancent par leur plateforme.</p>

      <div className="plat-sync">
        <div className="when">
          <span className="cap">{syncing ? 'Lecture en cours' : 'Dernière lecture'}</span>
          {syncing ? (
            <span className="scanbar" aria-hidden="true">
              <i />
            </span>
          ) : (
            <span className="v">{state?.lastSyncAt ? formatWhen(state.lastSyncAt) : 'Pas encore faite'}</span>
          )}
        </div>
        <span className="cap count">
          {detected} sur {platforms.length || 11} détectée{detected > 1 ? 's' : ''}
        </span>
        <button
          ref={resyncRef}
          type="button"
          className="btn btn-line"
          disabled={syncing}
          title="Relire tous les lanceurs maintenant (jeux installés, désinstallés, déplacés)"
          data-testid="btn-resync"
          onClick={resync}
        >
          <RefreshCw className={syncing ? 'spin' : undefined} />
          {syncing ? 'Lecture…' : 'Resynchroniser'}
        </button>
      </div>

      <div className="plat-list">
        <div className="plat-scroll" ref={listRef} role="list" aria-label="Plateformes" aria-busy={syncing || undefined}>
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
                  <span className="st">Pas installée{absent.length > 1 ? 's' : ''}</span>
                </div>
              )}
            </>
          ) : (
            <div className="plat-wait">
              <LoaderCircle className="spin" />
              Lecture des plateformes…
            </div>
          )}
        </div>
      </div>

      {!!state?.hiddenCount && (
        <div className="plat-hidden">
          <span>
            {state.hiddenCount > 1 ? (
              <>
                <b>{state.hiddenCount}</b> jeux retirés à la main ne reviennent plus tout seuls.
              </>
            ) : (
              <>
                <b>1</b> jeu retiré à la main ne revient plus tout seul.
              </>
            )}
          </span>
          <button
            type="button"
            className="btn btn-line btn-sm"
            disabled={restoring}
            title="Remettre les jeux retirés dans la bibliothèque"
            data-testid="btn-restore-hidden"
            onClick={restore}
          >
            {restoring ? <LoaderCircle className="spin" /> : <RotateCcw />}
            Remettre
          </button>
        </div>
      )}

      {/* espace d'au moins 18 px qui pousse le pied en bas quand le billet de droite est plus haut */}
      <div className="plat-fill" aria-hidden="true" />
      <div className="dfoot">
        <Keys keys={[['Échap', 'fermer']]} />
        <button type="button" className="btn btn-line" data-testid="dialog-cancel" onClick={onClose}>
          Fermer
        </button>
      </div>
    </DialogFrame>
  )
}
