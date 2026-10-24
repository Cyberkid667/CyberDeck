import {
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
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
import type { Game, TwitchCategory, TwitchSignIn, TwitchState, TwitchStream, TwitchStreams } from '../../../shared/types'
import { errorText } from '../format'
import { useT } from '../i18n'
import { DialogFrame, DialogHead } from './AddDialog'

// Streams Twitch d'un jeu, dans sa page (encart « En direct sur Twitch ») :
//   - compte Twitch connecté par code d'appareil (l'app ne voit jamais le mot de passe :
//     l'utilisateur valide sur twitch.tv/activate dans son navigateur) ;
//   - catégorie Twitch trouvée par le nom du jeu, corrigeable (« Pas ce jeu ? ») ;
//   - tri (spectateurs, plus récents, chaînes suivies), filtre de langue (langue de l'app par
//     défaut s'il y a des streams dans cette langue), grille de cartes, « Afficher plus » ;
//   - clic sur une carte : salle de projection dans l'app, lecteur officiel de Twitch et chat
//     (à afficher ou masquer), volume réglé ici, plein écran, « Ouvrir sur Twitch », Échap ferme.
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

type Sort = 'viewers' | 'recent' | 'followed'

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
function languageName(code: string, locale: string, other: string): string {
  if (!code || code === 'other') return other
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
              : t('twitch.signin.failed', { error: signIn.error ?? '' })}
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
            <span className="nm">{state.user.displayName}</span>
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
              <span className="hint mute">{state.error ?? t('twitch.settings.hint')}</span>
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
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      setBusy(true)
      window.essaim
        .searchTwitchCategories(q)
        .then((r) => {
          if (alive) setResults(r)
        })
        .catch(() => {
          if (alive) setResults([])
        })
        .finally(() => {
          if (alive) setBusy(false)
        })
    }, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query])
  return (
    <div className="tw-picker" data-testid="twitch-category-picker">
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
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
              }
            }}
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

/** Script envoyé au lecteur : volume et sourdine du <video>, gardés quand Twitch change de flux (publicité, qualité). */
const volumeScript = (volume: number, muted: boolean): string => `(() => {
  window.__cdVol = { v: ${volume.toFixed(3)}, m: ${muted ? 'true' : 'false'} };
  const apply = () => document.querySelectorAll('video').forEach((el) => {
    if (Math.abs(el.volume - window.__cdVol.v) > 0.001) el.volume = window.__cdVol.v;
    if (el.muted !== window.__cdVol.m) el.muted = window.__cdVol.m;
  });
  if (!window.__cdHook) {
    window.__cdHook = true;
    document.addEventListener('playing', apply, true);
    document.addEventListener('loadedmetadata', apply, true);
  }
  apply();
  return document.querySelectorAll('video').length;
})()`

function TwitchTheater({ stream, onClose }: { stream: TwitchStream; onClose: () => void }): React.JSX.Element {
  const { t, locale } = useT()
  const boxRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<WebviewTag | null>(null)
  const [ready, setReady] = useState(false)
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

  // volume : appliqué au <video> du lecteur une fois la page prête, puis à chaque changement
  useEffect(() => {
    const el = playerRef.current
    if (!el || !ready) return
    el.executeJavaScript(volumeScript(volume, muted)).catch(() => {})
  }, [volume, muted, ready])

  useEffect(() => {
    const el = playerRef.current
    if (!el) return
    const onReady = (): void => setReady(true)
    el.addEventListener('dom-ready', onReady)
    return () => {
      el.removeEventListener('dom-ready', onReady)
    }
  }, [])

  useEffect(() => writePref(VOLUME_KEY, String(volume)), [volume])
  useEffect(() => writePref(MUTED_KEY, muted ? '1' : '0'), [muted])

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
      aria-label={t('twitch.theater.aria', { name: stream.userName })}
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
          <span className="tw-th-name">{stream.userName}</span>
          <span className="tw-th-title" title={stream.title}>
            {stream.title}
          </span>
        </div>
        <div className="tw-th-tools">
          <span className="tw-th-viewers cap" title={t('twitch.viewersTitle', { n: stream.viewers.toLocaleString(locale) })}>
            <Eye />
            {compact(stream.viewers, locale)}
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
          <webview ref={playerRef as unknown as React.Ref<HTMLWebViewElement>} partition="persist:twitch" src={playerSrc} data-testid="twitch-player" />
        </div>
        {chat && (
          <div className="tw-th-chat">
            <webview partition="persist:twitch" src={chatSrc} data-testid="twitch-chat" />
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
  const lang = languageName(stream.language, locale, t('twitch.language.other'))
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
  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const refreshNext = useRef(false)
  const req = useRef(0)

  // durées des streams à jour chaque minute
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // 1) langues présentes (échantillon des 100 streams les plus regardés) et langue par défaut
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

  // 2) streams affichés (langue et tri choisis) ; même lecture que (1) en cache chez le processus principal
  useEffect(() => {
    if (!signedIn || language === undefined) return
    const n = ++req.current
    const refresh = refreshNext.current
    refreshNext.current = false
    setLoading(true)
    window.essaim
      .getTwitchStreams(game.id, { language, followed: sort === 'followed', refresh })
      .then((r) => {
        if (n !== req.current) return
        setData(r)
        setMore([])
        setCursor(r.cursor)
        setShown(PAGE)
        setFailed(null)
      })
      .catch((err) => {
        if (n === req.current) setFailed(errorText(err))
      })
      .finally(() => {
        if (n === req.current) setLoading(false)
      })
  }, [game.id, signedIn, language, sort === 'followed', tick])

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

  async function showMore(): Promise<void> {
    if (shown < all.length) {
      setShown((s) => s + PAGE)
      return
    }
    if (!cursor || loading) return
    const n = ++req.current
    setLoading(true)
    try {
      const r = await window.essaim.getTwitchStreams(game.id, { language, cursor })
      if (n !== req.current) return
      setMore((m) => [...m, ...r.streams])
      setCursor(r.cursor)
      setShown((s) => s + PAGE)
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

  const langOptions = language && !languages.includes(language) ? [language, ...languages] : languages
  const category = data?.category ?? null
  const visible = all.slice(0, shown)
  const canMore = shown < all.length || (!!cursor && sort !== 'followed')

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
  else if (!tw.user)
    body = (
      <div className="tw-calm">
        <TwitchGlyph className="lg" />
        <div className="tw-calm-txt">
          <p className="tw-calm-title">{t('twitch.signedOut.title', { name: game.name })}</p>
          <p className="gd-quiet">{tw.error ?? t('twitch.signedOut.hint')}</p>
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
    body = <p className="gd-quiet">{t('twitch.category.notFound', { name: game.name })}</p>
  else if (data?.status === 'signed-out') body = <p className="gd-quiet">{t('twitch.signedOut.hint')}</p>
  else if (failed || data?.status === 'error')
    body = (
      <div className="gd-banner" role="alert">
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
        {sort === 'followed'
          ? t('twitch.empty.followed')
          : language
            ? t('twitch.empty.language', { language: languageName(language, locale, t('twitch.language.other')) })
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
        {ready && (
          <>
            {tw?.user && (
              <span className="tw-me" title={t('twitch.signedInAs', { name: tw.user.displayName })}>
                <span className="tw-av sm">
                  <Img src={tw.user.avatar} fallback={<UserRound />} />
                </span>
                <span className="nm">{tw.user.displayName}</span>
              </span>
            )}
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
          <label className="tw-sel" title={t('twitch.sort.aria')}>
            <span className="cap">{t('twitch.sort.cap')}</span>
            <span className="v">{t(`twitch.sort.${sort}`)}</span>
            <ChevronDown />
            <select value={sort} data-testid="twitch-sort" aria-label={t('twitch.sort.aria')} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="viewers">{t('twitch.sort.viewers')}</option>
              <option value="recent">{t('twitch.sort.recent')}</option>
              <option value="followed">{t('twitch.sort.followed')}</option>
            </select>
          </label>
          <label className="tw-sel" title={t('twitch.language.aria')}>
            <span className="cap">{t('twitch.language.cap')}</span>
            <span className="v">{language ? languageName(language, locale, t('twitch.language.other')) : t('twitch.language.all')}</span>
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
                  {languageName(code, locale, t('twitch.language.other'))}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {ready && (picker || data?.status === 'no-category') && (
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
      {playing && createPortal(<TwitchTheater stream={playing} onClose={() => setPlaying(null)} />, document.body)}
    </section>
  )
}
