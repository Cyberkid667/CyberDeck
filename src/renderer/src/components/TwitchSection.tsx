import {
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  Heart,
  LoaderCircle,
  LogOut,
  Maximize,
  MessageSquare,
  MessageSquareOff,
  Minimize,
  RefreshCw,
  Search,
  TriangleAlert,
  UserRound,
  Volume1,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { WebviewTag } from 'electron'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { siTwitch } from 'simple-icons'
import type { Game, TwitchCategory, TwitchSignIn, TwitchState, TwitchStream, TwitchStreams, TwitchUser } from '../../../shared/types'
import { errorText } from '../format'
import { useT } from '../i18n'
import { DialogFrame, DialogHead } from './AddDialog'

// Streams Twitch d'un jeu, dans sa page (encart « En direct sur Twitch ») :
//   - compte Twitch connecté par code d'appareil (l'app ne voit jamais le mot de passe :
//     l'utilisateur valide sur twitch.tv/activate dans son navigateur) ;
//   - catégorie Twitch trouvée par le nom du jeu, corrigeable (« Pas ce jeu ? ») ;
//   - tri (spectateurs, plus récents), filtre « Chaînes suivies » à part, filtre de langue (toutes
//     les langues de Twitch ; celle de l'app par défaut s'il y a des streams dans cette langue),
//     grille de cartes, « Afficher plus » ;
//   - clic sur une carte : salle de projection dans l'app, lecteur officiel de Twitch et chat en
//     lecture seule (à afficher ou masquer), volume réglé ici et suivi depuis le lecteur, plein
//     écran, « Ouvrir sur Twitch », Échap ferme.
// Le lecteur et le chat sont des <webview> chargées comme pages principales (parent=twitch.tv,
// comme le lecteur « popout » de Twitch) et verrouillées par le processus principal (twitch.ts).

/** Cartes ajoutées par « Afficher plus ». */
const PAGE = 12
/** Préférences d'affichage gardées sur ce PC (clés « essaim.* », reprises avec le profil). */
const VOLUME_KEY = 'essaim.twitch.volume'
const MUTED_KEY = 'essaim.twitch.muted'
const CHAT_KEY = 'essaim.twitch.chat'
/** Sous cette largeur, le chat est masqué par défaut. */
const CHAT_MIN_WIDTH = 1100
/** Valeur attendue par le lecteur pour une page chargée hors d'un site intégrant (lecteur « popout »). */
const PARENT = 'twitch.tv'
/** « Plus récents » : Twitch ne trie que par spectateurs ; on lit jusqu'à ce nombre de pages pour trier. */
const RECENT_PAGES = 5
/** Spectateurs et titre du stream regardé : relus à ce rythme (cache de 60 s chez le processus principal). */
const LIVE_REFRESH = 90_000
/**
 * Sans cet attribut, une <webview> bloque toute nouvelle fenêtre avant même le processus principal :
 * les liens des spectateurs et « Se connecter pour discuter » ne feraient rien. Les fenêtres sont
 * toutes refusées par le processus principal (twitch.ts), qui ouvre les liens permis dans le navigateur.
 */
const POPUPS = { allowpopups: 'true' } as Record<string, string>
/** Préfixe des messages du lecteur (console) : volume changé dans le lecteur lui-même. */
const VOL_TAG = '__cyberdeck_volume:'
/**
 * Langues des streams sur Twitch (filtre language= de l'API) : toutes proposées, même celles
 * absentes des premiers streams chargés. « asl » : langue des signes américaine.
 */
const TWITCH_LANGUAGES = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'ja', 'ko', 'zh', 'zh-hk', 'th', 'vi', 'id', 'ms', 'tl', 'hi', 'sv', 'no', 'da', 'fi', 'cs', 'sk', 'hu', 'ro', 'bg', 'el', 'ca', 'asl', 'other']

type Sort = 'viewers' | 'recent'

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // stockage indisponible : la préférence ne sera pas gardée
  }
}

/** Logo de Twitch (Simple Icons, CC0), seul accent violet de la rubrique. */
export function TwitchGlyph({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg className={`tw-glyph${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={siTwitch.path} />
    </svg>
  )
}

/** État Twitch du processus principal (compte, connexion en cours), suivi en direct. */
export function useTwitch(): TwitchState | null {
  const [state, setState] = useState<TwitchState | null>(null)
  useEffect(() => {
    let alive = true
    try {
      window.essaim
        .getTwitchState()
        .then((s) => {
          if (alive) setState(s)
        })
        .catch(() => {})
      const off = window.essaim.onTwitch(setState)
      return () => {
        alive = false
        off()
      }
    } catch {
      return () => {
        alive = false
      }
    }
  }, [])
  return state
}

/** « 12,3 k » / « 12.3K » spectateurs. */
function compact(n: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  } catch {
    return String(n)
  }
}

/** Nom d'une langue dans la langue de l'app (« Français », « English »…). */
function languageName(code: string, locale: string, other: string, sign = ''): string {
  if (!code || code === 'other') return other
  if (code === 'asl') return sign || 'ASL'
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

/** Durée depuis le début du stream : « 2 h 14 » / « 2h 14m ». */
function uptime(startedAt: number, now: number, t: ReturnType<typeof useT>['t']): string {
  const min = Math.max(0, Math.floor((now - startedAt) / 60_000))
  const h = Math.floor(min / 60)
  return h ? t('twitch.uptime.hm', { h, m: String(min % 60).padStart(2, '0') }) : t('twitch.uptime.m', { m: min })
}

/** Nom affiché du compte (profil pas encore lu : son login, sinon le texte de repli). */
const accountName = (u: TwitchUser, fallback: string): string => u.displayName || u.login || fallback

/** Image distante qui disparaît si elle ne se charge pas. */
function Img({ src, className, fallback = null }: { src: string | null; className?: string; fallback?: React.ReactNode }): React.JSX.Element {
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) return <>{fallback}</>
  return <img className={className} src={src} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(src)} />
}

// ---------- Connexion (code d'appareil) ----------

/** Code à saisir sur twitch.tv/activate, attente de l'accord, erreurs. Dans Réglages et dans la fenêtre de connexion. */
export function TwitchCodeBox({ signIn, onRetry }: { signIn: TwitchSignIn; onRetry: () => void }): React.JSX.Element {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (signIn.status !== 'waiting') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [signIn.status])

  if (signIn.status === 'starting')
    return (
      <div className="tw-code-box" role="status">
        <p className="tw-wait">
          <LoaderCircle className="spin" />
          {t('twitch.signin.starting')}
        </p>
      </div>
    )
  if (signIn.status !== 'waiting')
    return (
      <div className="tw-code-box" role="alert">
        <p className="tw-wait err">
          <TriangleAlert />
          {signIn.status === 'expired'
            ? t('twitch.signin.expired')
            : signIn.status === 'denied'
              ? t('twitch.signin.denied')
              : t('twitch.signin.failed', { error: signIn.error ? t(signIn.error) : '' })}
        </p>
        <div className="row-btns">
          <button type="button" className="btn btn-line btn-sm" data-testid="twitch-retry" onClick={onRetry}>
            <RefreshCw />
            {t('twitch.signin.newCode')}
          </button>
        </div>
      </div>
    )
  const left = Math.max(0, Math.round((signIn.expiresAt - now) / 1000))
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  return (
    <div className="tw-code-box">
      <p className="tw-steps">{t('twitch.signin.steps')}</p>
      <div className="tw-code-row">
        <span className="cap">{t('twitch.signin.yourCode')}</span>
        <output className="tw-code" data-testid="twitch-code" aria-live="polite">
          {signIn.userCode}
        </output>
      </div>
      <div className="row-btns tw-code-btns">
        <button type="button" className="btn btn-primary" data-testid="twitch-open-activate" onClick={() => window.essaim.twitchOpenActivate()}>
          <ExternalLink />
          {t('twitch.signin.open')}
        </button>
        <button
          type="button"
          className="btn btn-line"
          onClick={() => {
            window.essaim.copyText(signIn.userCode)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          }}
        >
          <Copy />
          {copied ? t('twitch.signin.copied') : t('twitch.signin.copy')}
        </button>
      </div>
      <p className="tw-wait" role="status">
        <span className="tw-pulse" />
        {t('twitch.signin.waiting')}
        <span className="cap tw-expire">{t('twitch.signin.expiresIn', { time: clock })}</span>
      </p>
      <p className="tw-privacy">{t('twitch.signin.privacy')}</p>
    </div>
  )
}

/** Fenêtre de connexion ouverte depuis la page d'un jeu ; se ferme seule une fois connecté. */
function TwitchSignInDialog({ state, onClose }: { state: TwitchState; onClose: () => void }): React.JSX.Element {
  const { t } = useT()
  const done = !!state.user
  useEffect(() => {
    if (done) onClose()
  }, [done, onClose])
  const close = (): void => {
    window.essaim.twitchCancelSignIn()
    onClose()
  }
  return (
    <DialogFrame kind="twitch-signin" size="single" labelledBy="tw-signin-title" onClose={close}>
      <DialogHead id="tw-signin-title" cap="Twitch" title={t('twitch.signin.title')} onClose={close} />
      <div className="tw-dialog-body" data-testid="twitch-signin-dialog">
        {state.signIn ? (
          <TwitchCodeBox signIn={state.signIn} onRetry={() => void window.essaim.twitchSignIn()} />
        ) : (
          <p className="tw-wait" role="status">
            <LoaderCircle className="spin" />
            {t('twitch.signin.starting')}
          </p>
        )}
      </div>
      <div className="dfoot">
        <span className="keys" />
        <button type="button" className="btn btn-line" data-testid="dialog-cancel" onClick={close}>
          {t('shell.common.cancel')}
        </button>
      </div>
    </DialogFrame>
  )
}

/** Bloc « Twitch » de Réglages : compte connecté, connexion, déconnexion. */
export function TwitchSettingsBlock(): React.JSX.Element {
  const { t } = useT()
  const state = useTwitch()
  const [busy, setBusy] = useState(false)
  if (!state) return <div className="field tw-set" />
  return (
    <div className="field tw-set" data-testid="settings-twitch">
      <div className="lab">
        <span className="cap">Twitch</span>
      </div>
      {!state.configured ? (
        <div className="hint mute">{t('twitch.notConfigured')}</div>
      ) : state.user ? (
        <div className="tw-account">
          <span className="tw-av">
            <Img src={state.user.avatar} fallback={<UserRound />} />
          </span>
          <span className="tw-account-txt">
            <span className="nm">{accountName(state.user, 'Twitch')}</span>
            <span className="cap">{t('twitch.settings.signedIn')}</span>
          </span>
          <button
            type="button"
            className="btn btn-line btn-sm"
            data-testid="twitch-signout"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void window.essaim.twitchSignOut().finally(() => setBusy(false))
            }}
          >
            <LogOut />
            {t('twitch.settings.signOut')}
          </button>
        </div>
      ) : state.signIn ? (
        <>
          <TwitchCodeBox signIn={state.signIn} onRetry={() => void window.essaim.twitchSignIn()} />
          <div className="row-btns">
            <button type="button" className="btn btn-line btn-sm" onClick={() => window.essaim.twitchCancelSignIn()}>
              {t('shell.common.cancel')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="tw-account">
            <TwitchGlyph className="lg" />
            <span className="tw-account-txt">
              <span className="hint mute">{state.error ? t(state.error) : t('twitch.settings.hint')}</span>
            </span>
            <button type="button" className="btn btn-line btn-sm" data-testid="twitch-signin" disabled={!state.canStore} onClick={() => void window.essaim.twitchSignIn()}>
              {t('twitch.signin.button')}
            </button>
          </div>
          {!state.canStore && <div className="hint mute">{t('twitch.error.cantEncrypt')}</div>}
        </>
      )}
    </div>
  )
}

// ---------- Choix de la catégorie (« Pas ce jeu ? ») ----------

function CategoryPicker({
  gameName,
  manual,
  onPick,
  onAuto,
  onClose
}: {
  gameName: string
  manual: boolean
  onPick: (c: TwitchCategory) => void
  onAuto: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useT()
  const [query, setQuery] = useState(gameName)
  const [results, setResults] = useState<TwitchCategory[] | null>(null)
  // panne (hors ligne, limite d'appels…) : dite telle quelle, avec « Réessayer »
  const [searchError, setSearchError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearchError(null)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      setBusy(true)
      window.essaim
        .searchTwitchCategories(q)
        .then((r) => {
          if (!alive) return
          setSearchError(r.ok ? null : r.error)
          setResults(r.ok ? r.categories : null)
        })
        .catch((err) => {
          if (!alive) return
          setSearchError(errorText(err))
          setResults(null)
        })
        .finally(() => {
          if (alive) setBusy(false)
        })
    }, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, attempt])
  return (
    // Échap ferme le choix où que soit le focus (champ, X, un résultat), jamais toute la page du jeu
    <div
      className="tw-picker"
      data-testid="twitch-category-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="tw-picker-row">
        <span className="tw-search">
          <Search />
          <input
            ref={inputRef}
            className="inp sans"
            type="text"
            value={query}
            placeholder={t('twitch.category.search')}
            aria-label={t('twitch.category.search')}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        {manual && (
          <button type="button" className="gd-more" onClick={onAuto}>
            {t('twitch.category.auto')}
          </button>
        )}
        <button type="button" className="btn btn-line gd-ibtn tw-ibtn" aria-label={t('shell.common.close')} onClick={onClose}>
          <X />
        </button>
      </div>
      {busy && !results ? (
        <p className="gd-quiet">{t('twitch.category.searching')}</p>
      ) : searchError ? (
        <div className="gd-banner" role="alert" data-testid="twitch-category-error">
          <TriangleAlert />
          <span className="msg">{searchError}</span>
          <button type="button" className="btn btn-line btn-sm" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw />
            {t('library.details.retry')}
          </button>
        </div>
      ) : results && results.length === 0 ? (
        <p className="gd-quiet">{t('twitch.category.none')}</p>
      ) : results ? (
        <ul className="tw-cats">
          {results.slice(0, 10).map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onPick(c)}>
                <span className="tw-box">
                  <Img src={c.boxArt} />
                </span>
                <span className="nm">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// ---------- Salle de projection : lecteur + chat ----------

/**
 * Script envoyé au lecteur à chaque chargement de sa page et à chaque changement : volume et
 * sourdine du <video>, gardés quand Twitch change de flux (publicité, qualité). Un changement fait
 * dans le lecteur lui-même (geste de l'utilisateur juste avant) est renvoyé à l'app par la console
 * (VOL_TAG) ; un changement sans geste (le lecteur reprend son propre réglage) est annulé.
 */
const volumeScript = (volume: number, muted: boolean): string => `(() => {
  const w = window;
  w.__cdVol = { v: ${volume.toFixed(3)}, m: ${muted ? 'true' : 'false'} };
  if (!w.__cdHook) {
    w.__cdHook = true;
    w.__cdInput = 0;
    w.__cdFix = [];
    const mark = () => { w.__cdInput = Date.now(); };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'input']) document.addEventListener(type, mark, true);
    w.__cdApply = () => document.querySelectorAll('video').forEach((el) => {
      if (Math.abs(el.volume - w.__cdVol.v) > 0.001) el.volume = w.__cdVol.v;
      if (el.muted !== w.__cdVol.m) el.muted = w.__cdVol.m;
    });
    document.addEventListener('playing', () => w.__cdApply(), true);
    document.addEventListener('loadedmetadata', () => w.__cdApply(), true);
    document.addEventListener('volumechange', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLMediaElement)) return;
      if (Math.abs(el.volume - w.__cdVol.v) <= 0.001 && el.muted === w.__cdVol.m) return;
      if (Date.now() - w.__cdInput < 1500) {
        w.__cdVol = { v: el.volume, m: el.muted };
        console.log('${VOL_TAG}' + JSON.stringify(w.__cdVol));
        return;
      }
      // pas de bras de fer si le lecteur insiste : quelques corrections par seconde au plus
      const now = Date.now();
      w.__cdFix = w.__cdFix.filter((x) => now - x < 1000);
      if (w.__cdFix.length >= 4) return;
      w.__cdFix.push(now);
      w.__cdApply();
    }, true);
  }
  w.__cdApply();
  return document.querySelectorAll('video').length;
})()`

function TwitchTheater({ stream, gameId, onClose }: { stream: TwitchStream; gameId: string; onClose: () => void }): React.JSX.Element {
  const { t, locale } = useT()
  const boxRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<WebviewTag | null>(null)
  /** augmente à chaque chargement de la page du lecteur (le script doit être renvoyé) */
  const [loads, setLoads] = useState(0)
  const [live, setLive] = useState(stream)
  const [volume, setVolume] = useState(() => {
    const v = Number(readPref(VOLUME_KEY))
    return readPref(VOLUME_KEY) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5
  })
  const [muted, setMuted] = useState(() => readPref(MUTED_KEY) === '1')
  const [chat, setChat] = useState(() => {
    const saved = readPref(CHAT_KEY)
    return saved === null ? window.innerWidth >= CHAT_MIN_WIDTH : saved === '1'
  })
  const [full, setFull] = useState(false)
  const latest = useRef(onClose)
  latest.current = onClose
  const login = encodeURIComponent(stream.userLogin.toLowerCase())
  // adresses fixées à l'ouverture : changer le volume ne recharge pas le lecteur
  const [playerSrc] = useState(() => `https://player.twitch.tv/?channel=${login}&parent=${PARENT}&autoplay=true&muted=${muted ? 'true' : 'false'}`)
  const chatSrc = `https://www.twitch.tv/embed/${login}/chat?parent=${PARENT}&darkpopout`

  // volume : appliqué au <video> du lecteur à chaque chargement de sa page, puis à chaque changement
  useEffect(() => {
    const el = playerRef.current
    if (!el || !loads) return
    el.executeJavaScript(volumeScript(volume, muted)).catch(() => {})
  }, [volume, muted, loads])

  useEffect(() => {
    const el = playerRef.current
    if (!el) return
    const onReady = (): void => setLoads((n) => n + 1)
    // volume changé dans le lecteur lui-même : le curseur de l'app le suit
    const onConsole = (e: Event): void => {
      const msg = (e as Event & { message?: unknown }).message
      if (typeof msg !== 'string' || !msg.startsWith(VOL_TAG)) return
      try {
        const v = JSON.parse(msg.slice(VOL_TAG.length)) as { v?: unknown; m?: unknown }
        if (typeof v.v !== 'number' || !Number.isFinite(v.v)) return
        setVolume(Math.min(1, Math.max(0, v.v)))
        setMuted(v.m === true)
      } catch {
        // message abîmé : ignoré
      }
    }
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('console-message', onConsole)
    return () => {
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('console-message', onConsole)
    }
  }, [])

  useEffect(() => writePref(VOLUME_KEY, String(volume)), [volume])
  useEffect(() => writePref(MUTED_KEY, muted ? '1' : '0'), [muted])

  // spectateurs et titre relus de temps en temps (le stream reste ouvert longtemps)
  useEffect(() => {
    let alive = true
    const timer = window.setInterval(() => {
      window.essaim
        .getTwitchStreams(gameId, { language: stream.language })
        .then((r) => {
          const s = r.streams.find((x) => x.userLogin === stream.userLogin)
          if (alive && s) setLive(s)
        })
        .catch(() => {})
    }, LIVE_REFRESH)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [gameId, stream])

  // Échap : quitte le plein écran, sinon ferme (aussi quand le clavier est dans le lecteur ou le chat)
  useEffect(() => {
    const escape = (): void => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      else latest.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('.overlay [role="dialog"]')) return
      e.preventDefault()
      e.stopPropagation()
      escape()
    }
    const onFull = (): void => setFull(!!document.fullscreenElement)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('fullscreenchange', onFull)
    let off = (): void => {}
    try {
      off = window.essaim.onTwitchEscape(escape)
    } catch {
      /* pont pas encore prêt */
    }
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('fullscreenchange', onFull)
      off()
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [])

  // le focus va dans la salle (lecteurs d'écran, Échap)
  useEffect(() => {
    boxRef.current?.focus({ preventScroll: true })
  }, [])

  const toggleChat = (): void => {
    setChat((c) => {
      writePref(CHAT_KEY, c ? '0' : '1')
      return !c
    })
  }
  const toggleFull = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void boxRef.current?.requestFullscreen().catch(() => {})
  }
  const shownVolume = muted ? 0 : volume
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <div
      ref={boxRef}
      className={`tw-theater${chat ? ' chat' : ''}${full ? ' full' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('twitch.theater.aria', { name: live.userName })}
      tabIndex={-1}
      data-testid="twitch-theater"
      data-channel={stream.userLogin}
    >
      <header className="tw-th-bar">
        <div className="tw-th-who">
          <span className="tw-live">
            <i className="tw-dot" />
            {t('twitch.live')}
          </span>
          <span className="tw-th-name">{live.userName}</span>
          <span className="tw-th-title" title={live.title} data-testid="twitch-theater-title">
            {live.title}
          </span>
        </div>
        <div className="tw-th-tools">
          <span className="tw-th-viewers cap" title={t('twitch.viewersTitle', { n: live.viewers.toLocaleString(locale) })}>
            <Eye />
            {compact(live.viewers, locale)}
          </span>
          <span className="tsep" />
          <button
            type="button"
            className="btn btn-line gd-ibtn tw-ibtn"
            data-testid="twitch-mute"
            aria-pressed={muted}
            title={muted ? t('twitch.theater.unmute') : t('twitch.theater.mute')}
            aria-label={muted ? t('twitch.theater.unmute') : t('twitch.theater.mute')}
            onClick={() => {
              if (muted && volume === 0) setVolume(0.5)
              setMuted(!muted)
            }}
          >
            <VolIcon />
          </button>
          <input
            className="tw-vol"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(shownVolume * 100)}
            style={{ '--v': `${Math.round(shownVolume * 100)}%` } as CSSProperties}
            data-testid="twitch-volume"
            aria-label={t('twitch.theater.volume')}
            title={t('twitch.theater.volumeTitle', { n: Math.round(shownVolume * 100) })}
            onChange={(e) => {
              const v = Number(e.target.value) / 100
              setVolume(v)
              setMuted(v === 0)
            }}
          />
          <span className="tsep" />
          <button
            type="button"
            className={`btn btn-line gd-ibtn tw-ibtn${chat ? ' on' : ''}`}
            data-testid="twitch-chat-toggle"
            aria-pressed={chat}
            title={chat ? t('twitch.theater.hideChat') : t('twitch.theater.showChat')}
            aria-label={chat ? t('twitch.theater.hideChat') : t('twitch.theater.showChat')}
            onClick={toggleChat}
          >
            {chat ? <MessageSquare /> : <MessageSquareOff />}
          </button>
          <button
            type="button"
            className="btn btn-line gd-ibtn tw-ibtn"
            data-testid="twitch-fullscreen"
            title={full ? t('twitch.theater.exitFullscreen') : t('twitch.theater.fullscreen')}
            aria-label={full ? t('twitch.theater.exitFullscreen') : t('twitch.theater.fullscreen')}
            onClick={toggleFull}
          >
            {full ? <Minimize /> : <Maximize />}
          </button>
          <button
            type="button"
            className="btn btn-line btn-sm tw-open"
            data-testid="twitch-open"
            title={t('twitch.theater.openTitle', { url: `twitch.tv/${stream.userLogin}` })}
            onClick={() => window.essaim.openExternalLink(`https://www.twitch.tv/${login}`)}
          >
            <ExternalLink />
            {t('twitch.theater.open')}
          </button>
          <button type="button" className="xbtn tw-close" data-testid="twitch-close" aria-label={t('shell.common.close')} title={t('twitch.theater.closeTitle')} onClick={onClose}>
            <span className="cap">{t('shell.keys.esc')}</span>
            <X />
          </button>
        </div>
      </header>
      <div className="tw-th-body">
        <div className="tw-th-player">
          <webview ref={playerRef as unknown as React.Ref<HTMLWebViewElement>} partition="persist:twitch" src={playerSrc} data-testid="twitch-player" {...POPUPS} />
        </div>
        {chat && (
          <div className="tw-th-chat">
            {/* le compte Twitch de l'app ne connecte pas le chat web : on le dit, et on renvoie vers twitch.tv pour écrire */}
            <div className="tw-chat-note" data-testid="twitch-chat-readonly">
              <span className="cap">{t('twitch.theater.chatReadOnly')}</span>
              <button
                type="button"
                className="gd-more"
                data-testid="twitch-chat-write"
                title={t('twitch.theater.chatWriteTitle')}
                onClick={() => window.essaim.openExternalLink(`https://www.twitch.tv/popout/${login}/chat`)}
              >
                <ExternalLink />
                {t('twitch.theater.chatWrite')}
              </button>
            </div>
            <div className="tw-chat-view">
              <webview partition="persist:twitch" src={chatSrc} data-testid="twitch-chat" {...POPUPS} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- Encart de la page du jeu ----------

function StreamCard({ stream, now, onOpen, version }: { stream: TwitchStream; now: number; onOpen: () => void; version: number }): React.JSX.Element {
  const { t, locale } = useT()
  // les aperçus de Twitch changent toutes les 5 min environ : adresse renouvelée à chaque lecture
  const thumb = stream.thumbnail ? `${stream.thumbnail}?v=${version}` : null
  const lang = languageName(stream.language, locale, t('twitch.language.other'), t('twitch.language.asl'))
  // la langue est déjà affichée à droite du nom : pas de mot-clé « English » en double
  const own = languageName(stream.language, stream.language, '')
  const same = (tag: string): boolean => [lang, own, stream.language].some((x) => x && tag.toLocaleLowerCase() === x.toLocaleLowerCase())
  const tags = stream.tags.filter((tag) => !same(tag))
  return (
    <button type="button" className="tw-card" data-testid="twitch-card" data-channel={stream.userLogin} title={stream.title} onClick={onOpen}>
      <span className="tw-thumb">
        <Img src={thumb} fallback={<TwitchGlyph className="ph" />} />
        <span className="tw-live">
          <i className="tw-dot" />
          {t('twitch.live')}
        </span>
        {stream.mature && <span className="tw-18 cap">18+</span>}
        <span className="tw-over">
          <span className="tw-viewers">{t('twitch.viewers', { n: compact(stream.viewers, locale) })}</span>
          {stream.startedAt > 0 && <span className="tw-up">{uptime(stream.startedAt, now, t)}</span>}
        </span>
      </span>
      <span className="tw-meta">
        <span className="tw-name">{stream.userName}</span>
        <span className="cap tw-lang">{lang}</span>
      </span>
      <span className="tw-title">{stream.title || '—'}</span>
      {tags.length > 0 && (
        <span className="tw-tags">
          {tags.slice(0, 3).map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

/** Encart « En direct sur Twitch » de la page d'un jeu (clé : l'id du jeu, l'état repart à zéro). */
export function TwitchSection({ game }: { game: Game }): React.JSX.Element {
  const { t, lang: appLang, locale } = useT()
  const tw = useTwitch()
  const signedIn = !!tw?.user
  const [askSignIn, setAskSignIn] = useState(false)
  const [sort, setSort] = useState<Sort>('viewers')
  /** filtre « Chaînes suivies », indépendant du tri */
  const [followed, setFollowed] = useState(false)
  /** undefined : pas encore choisie (langue de l'app s'il y a des streams dans cette langue) */
  const [language, setLanguage] = useState<string | null | undefined>(undefined)
  const [languages, setLanguages] = useState<string[]>([])
  const [data, setData] = useState<TwitchStreams | null>(null)
  const [more, setMore] = useState<TwitchStream[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  const [playing, setPlaying] = useState<TwitchStream | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const refreshNext = useRef(false)
  const req = useRef(0)

  // durées des streams à jour chaque minute
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // 1) langues présentes (échantillon des 100 streams les plus regardés, mises en tête de la liste) et langue par défaut
  useEffect(() => {
    if (!signedIn) return
    let alive = true
    window.essaim
      .getTwitchStreams(game.id, { refresh: refreshNext.current })
      .then((all) => {
        if (!alive) return
        const counts = new Map<string, number>()
        for (const s of all.streams) counts.set(s.language, (counts.get(s.language) ?? 0) + 1)
        const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code)
        setLanguages(list)
        setLanguage((cur) => (cur !== undefined ? cur : counts.has(appLang) ? appLang : null))
      })
      .catch(() => {
        if (alive) setLanguage((cur) => (cur !== undefined ? cur : null))
      })
    return () => {
      alive = false
    }
  }, [game.id, signedIn, tick, appLang])

  // 2) streams affichés (langue, tri et filtre choisis) ; même lecture que (1) en cache chez le processus principal
  useEffect(() => {
    if (!signedIn || language === undefined) return
    const n = ++req.current
    const refresh = refreshNext.current
    refreshNext.current = false
    setLoading(true)
    void (async () => {
      try {
        const r = await window.essaim.getTwitchStreams(game.id, { language, followed, refresh })
        if (n !== req.current) return
        // « Plus récents » : Twitch ne renvoie les streams que par spectateurs ; quelques pages de
        // plus sont lues d'un coup pour trier un plus grand ensemble (la grille ne saute pas ensuite)
        let extra: TwitchStream[] = []
        let next = r.cursor
        if (sort === 'recent' && !followed && r.status === 'ok') {
          for (let page = 1; page < RECENT_PAGES && next; page++) {
            const p = await window.essaim.getTwitchStreams(game.id, { language, cursor: next, refresh })
            if (n !== req.current) return
            if (p.status !== 'ok') break
            extra = [...extra, ...p.streams]
            next = p.cursor
          }
        }
        setData(r)
        setMore(extra)
        setCursor(next)
        setShown(PAGE)
        setFailed(null)
      } catch (err) {
        if (n === req.current) setFailed(errorText(err))
      } finally {
        if (n === req.current) setLoading(false)
      }
    })()
  }, [game.id, signedIn, language, sort, followed, tick])

  // aucune catégorie trouvée : le choix s'ouvre de lui-même (et peut être refermé)
  useEffect(() => {
    if (data?.status === 'no-category') setPicker(true)
  }, [data])

  const closeSignIn = useCallback(() => setAskSignIn(false), [])

  const reload = useCallback(() => {
    refreshNext.current = true
    setTick((x) => x + 1)
  }, [])

  const all = useMemo(() => {
    const list = [...(data?.streams ?? []), ...more]
    // un stream peut passer d'une page à l'autre pendant la lecture : pas de doublon
    const seen = new Set<string>()
    const unique = list.filter((s) => (seen.has(s.userLogin) ? false : (seen.add(s.userLogin), true)))
    return sort === 'recent' ? unique.sort((a, b) => b.startedAt - a.startedAt) : unique
  }, [data, more, sort])

  // « Plus récents » : tout est déjà lu (voir 2) ; « Afficher plus » ne fait que dévoiler la suite
  const canFetch = !!cursor && sort === 'viewers' && !followed

  async function showMore(): Promise<void> {
    if (shown < all.length) {
      setShown((s) => s + PAGE)
      return
    }
    if (!canFetch || loading) return
    const n = ++req.current
    setLoading(true)
    try {
      const r = await window.essaim.getTwitchStreams(game.id, { language, cursor })
      if (n !== req.current) return
      if (r.status === 'error') setFailed(r.error ?? '')
      else {
        setMore((m) => [...m, ...r.streams])
        setCursor(r.cursor)
        setShown((s) => s + PAGE)
      }
    } catch (err) {
      if (n === req.current) setFailed(errorText(err))
    } finally {
      if (n === req.current) setLoading(false)
    }
  }

  async function pickCategory(c: TwitchCategory | null): Promise<void> {
    setPicker(false)
    try {
      await window.essaim.setTwitchCategory(game.id, c)
    } catch {
      /* rien de grave : la liste reste celle d'avant */
    }
    setLanguage(undefined)
    setLanguages([])
    reload()
  }

  const otherLabel = t('twitch.language.other')
  const signLabel = t('twitch.language.asl')
  // langues présentes dans ce jeu d'abord, puis toutes les autres langues de Twitch par ordre alphabétique
  const langOptions = useMemo(() => {
    const present = (language && !languages.includes(language) ? [language, ...languages] : languages).filter((code) => code !== 'other')
    const rest = TWITCH_LANGUAGES.filter((code) => !present.includes(code) && code !== 'other').sort((a, b) =>
      languageName(a, locale, otherLabel, signLabel).localeCompare(languageName(b, locale, otherLabel, signLabel), locale)
    )
    // « Autre » toujours en dernier
    return [...present, ...rest, 'other']
  }, [language, languages, locale, otherLabel, signLabel])
  const category = data?.category ?? null
  const visible = all.slice(0, shown)
  const canMore = shown < all.length || canFetch
  const user = tw?.user ?? null
  const userName = user ? accountName(user, t('twitch.settings.signedIn')) : ''

  // ---- contenu selon l'état ----
  let body: React.ReactNode
  if (!tw) body = <div className="tw-grid sk-grid" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="sk tw-sk" />)}</div>
  else if (!tw.configured)
    body = (
      <div className="tw-calm" data-testid="twitch-not-configured">
        <TwitchGlyph className="lg mute" />
        <div>
          <p className="tw-calm-title">{t('twitch.notConfigured')}</p>
          <p className="gd-quiet">{t('twitch.notConfiguredHint')}</p>
        </div>
      </div>
    )
  // jetons illisibles (trousseau verrouillé, clé de chiffrement changée) : même bloc, avec le bouton
  else if (!tw.user || data?.status === 'signed-out')
    body = (
      <div className="tw-calm" data-testid="twitch-signed-out">
        <TwitchGlyph className="lg" />
        <div className="tw-calm-txt">
          <p className="tw-calm-title">{t('twitch.signedOut.title', { name: game.name })}</p>
          {/* chiffrement impossible (Linux sans trousseau…) : la raison du bouton grisé est dite ici aussi */}
          <p className="gd-quiet" data-testid="twitch-signed-out-hint">
            {!tw.canStore ? t('twitch.error.cantEncrypt') : tw.error ? t(tw.error) : t('twitch.signedOut.hint')}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-line"
          data-testid="twitch-signin"
          disabled={!tw.canStore}
          onClick={() => {
            setAskSignIn(true)
            void window.essaim.twitchSignIn()
          }}
        >
          <TwitchGlyph />
          {t('twitch.signin.button')}
        </button>
      </div>
    )
  else if (!data && !failed)
    body = (
      <div className="tw-grid" aria-busy="true" aria-label={t('twitch.loading')}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className="tw-card sk-card">
            <span className="sk tw-sk" />
            <span className="sk line" style={{ width: '50%' }} />
            <span className="sk line" style={{ width: '86%' }} />
          </span>
        ))}
      </div>
    )
  else if (data?.status === 'no-category')
    body = (
      <p className="gd-quiet" data-testid="twitch-no-category">
        {t('twitch.category.notFound', { name: game.name })}
      </p>
    )
  else if (failed || data?.status === 'error')
    body = (
      <div className="gd-banner" role="alert" data-testid="twitch-error">
        <TriangleAlert />
        <span className="msg">{t('twitch.error.load', { error: failed ?? data?.error ?? '' })}</span>
        <button type="button" className="btn btn-line btn-sm" disabled={loading} onClick={reload}>
          <RefreshCw />
          {t('library.details.retry')}
        </button>
      </div>
    )
  else if (!all.length)
    body = (
      <p className="gd-quiet" data-testid="twitch-empty">
        {followed
          ? t('twitch.empty.followed')
          : language
            ? t('twitch.empty.language', { language: languageName(language, locale, otherLabel, signLabel) })
            : t('twitch.empty.all', { name: category?.name ?? game.name })}
      </p>
    )
  else
    body = (
      <>
        <div className="tw-grid">
          {visible.map((s) => (
            <StreamCard key={s.userLogin} stream={s} now={now} version={Math.floor((data?.fetchedAt ?? 0) / 60_000)} onOpen={() => setPlaying(s)} />
          ))}
        </div>
        {sort === 'recent' && !followed && !!cursor && (
          <p className="gd-quiet tw-note" data-testid="twitch-recent-note">
            {t('twitch.sort.recentNote')}
          </p>
        )}
        {canMore && (
          <button type="button" className="btn btn-line btn-sm tw-more" data-testid="twitch-more" disabled={loading} onClick={() => void showMore()}>
            {loading ? <LoaderCircle className="spin" /> : <ChevronDown />}
            {t('twitch.more')}
          </button>
        )}
      </>
    )

  const ready = !!tw?.configured && signedIn

  return (
    <section className="gd-panel tw-panel" data-testid="twitch-section">
      <header className="gd-ph">
        <TwitchGlyph />
        <h3 className="cap">{t('twitch.section')}</h3>
        <span className="rule" />
        {ready && user && (
          <>
            <span className="tw-me" title={t('twitch.signedInAs', { name: userName })} data-testid="twitch-me">
              <span className="tw-av sm">
                <Img src={user.avatar} fallback={<UserRound />} />
              </span>
              <span className="nm">{userName}</span>
            </span>
            <button
              type="button"
              className="btn btn-line gd-ibtn tw-ibtn"
              data-testid="twitch-section-signout"
              title={t('twitch.settings.signOut')}
              aria-label={t('twitch.settings.signOut')}
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true)
                void window.essaim.twitchSignOut().finally(() => setSigningOut(false))
              }}
            >
              <LogOut />
            </button>
            <button
              type="button"
              className="btn btn-line gd-ibtn tw-ibtn"
              data-testid="twitch-refresh"
              title={t('twitch.refresh')}
              aria-label={t('twitch.refresh')}
              disabled={loading}
              onClick={reload}
            >
              <RefreshCw className={loading ? 'spin' : undefined} />
            </button>
          </>
        )}
      </header>

      {ready && data && data.status !== 'signed-out' && (
        <div className="tw-bar">
          <span className="tw-cat" title={category ? t('twitch.category.title', { name: category.name }) : undefined}>
            {category?.boxArt && (
              <span className="tw-box sm">
                <Img src={category.boxArt} />
              </span>
            )}
            <span className="tw-cat-txt">
              <span className="cap">{t('twitch.category.cap')}</span>
              <span className="nm">{category?.name ?? t('twitch.category.unknown')}</span>
            </span>
          </span>
          <button type="button" className="gd-more" data-testid="twitch-category-change" onClick={() => setPicker((p) => !p)}>
            <Search />
            {t('twitch.category.change')}
          </button>
          <span className="spacer" />
          <button
            type="button"
            className={`tw-tog${followed ? ' on' : ''}`}
            data-testid="twitch-followed"
            aria-pressed={followed}
            title={t('twitch.followedTitle')}
            onClick={() => setFollowed((f) => !f)}
          >
            <Heart />
            {t('twitch.followed')}
          </button>
          <label className="tw-sel" title={t('twitch.sort.aria')}>
            <span className="cap">{t('twitch.sort.cap')}</span>
            <span className="v">{t(`twitch.sort.${sort}`)}</span>
            <ChevronDown />
            <select value={sort} data-testid="twitch-sort" aria-label={t('twitch.sort.aria')} onChange={(e) => setSort(e.target.value === 'recent' ? 'recent' : 'viewers')}>
              <option value="viewers">{t('twitch.sort.viewers')}</option>
              <option value="recent">{t('twitch.sort.recent')}</option>
            </select>
          </label>
          <label className="tw-sel" title={t('twitch.language.aria')}>
            <span className="cap">{t('twitch.language.cap')}</span>
            <span className="v">{language ? languageName(language, locale, otherLabel, signLabel) : t('twitch.language.all')}</span>
            <ChevronDown />
            <select
              value={language ?? ''}
              data-testid="twitch-language"
              aria-label={t('twitch.language.aria')}
              onChange={(e) => setLanguage(e.target.value || null)}
            >
              <option value="">{t('twitch.language.all')}</option>
              {langOptions.map((code) => (
                <option key={code} value={code}>
                  {languageName(code, locale, otherLabel, signLabel)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {ready && picker && (
        <CategoryPicker
          gameName={game.name}
          manual={!!data?.manual}
          onPick={(c) => void pickCategory(c)}
          onAuto={() => void pickCategory(null)}
          onClose={() => setPicker(false)}
        />
      )}

      {body}

      {/* hors de la page qui défile (animée, donc repère des éléments « fixed ») */}
      {askSignIn && tw && !tw.user && createPortal(<TwitchSignInDialog state={tw} onClose={closeSignIn} />, document.body)}
      {playing && createPortal(<TwitchTheater stream={playing} gameId={game.id} onClose={() => setPlaying(null)} />, document.body)}
    </section>
  )
}
