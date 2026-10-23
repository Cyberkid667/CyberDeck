import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  Ellipsis,
  ExternalLink,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Newspaper,
  PackageX,
  Pencil,
  Play,
  RefreshCw,
  Trophy,
  TriangleAlert,
  UserRound
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { t } from '../../../shared/i18n'
import { gameLastPlayedAt, gamePlayTimeSeconds } from '../../../shared/platforms'
import type { DownloadProgress, Game, GameAchievement, GameDetails, GameFriend, GameLink, PlatformsState } from '../../../shared/types'
import { errorText, formatClock, formatDay, formatLastPlayed, formatPercent, formatPlayTime, formatWhen, percentVar } from '../format'
import { useT } from '../i18n'
import { gameFolder, onThisPc, platformName, type GameState } from '../platformUi'
import { coverSrc } from './Cover'
import { DownloadPanel, downloadFraction } from './DownloadPanel'
import { PlatformLogo } from './PlatformLogo'
import { PlatformTag } from './PlatformTag'

// Page détaillée d'un jeu (passe 3), façon page de jeu de Steam mais aux couleurs de l'app,
// ouverte dans la zone de la bibliothèque (la barre latérale reste) :
//   - barre d'outils : « ← Bibliothèque » (Échap, bouton « précédent » de la souris), nom du jeu ;
//   - bandeau : grande image (details.heroUrl ; sinon la jaquette floutée et assombrie), dégradé
//     sombre, logo du jeu (sinon son nom en mono 300), logo de la plateforme ;
//   - barre d'action : Jouer / Installer / Téléchargement / Mise à jour / En jeu (mêmes règles et
//     rappels que le bandeau de la bibliothèque), relevés DERNIÈRE PARTIE, TEMPS DE JEU, SUCCÈS x/y,
//     boutons Ouvrir le dossier, Modifier…, Désinstaller…, Actualiser, « … » (menu du jeu) ;
//   - téléchargement Steam en cours (DownloadPanel) ;
//   - rangée de liens (page du magasin, DLC, communauté…) ouverts par openExternalLink ;
//   - corps sur deux colonnes (une seule sous 1100 px) : À propos et Actualités à gauche ; Succès,
//     Amis qui y jouent et DLC à droite.
// Les infos viennent de getGameDetails (cache disque côté processus principal, et cache mémoire
// ici : une page déjà vue s'affiche tout de suite, puis se met à jour). Les images ont toutes des
// cases de taille fixe et disparaissent si elles ne se chargent pas : la mise en page ne bouge pas.

interface Props {
  game: Game
  state: GameState
  /** heure de début si le jeu tourne */
  startedAt: number | null
  now: number
  /** téléchargement Steam en cours (installation ou mise à jour) */
  download: DownloadProgress | null
  platforms: PlatformsState | null
  onBack: () => void
  onPlay: (game: Game) => void
  onInstall: (game: Game) => void
  onEdit: (game: Game) => void
  onUninstall: (game: Game) => void
  onMenu: (game: Game, x: number, y: number) => void
  onOpenPlatforms: () => void
}

/** Pages déjà lues pendant cette session (affichées tout de suite à la réouverture). */
const CACHE = new Map<string, GameDetails>()

/** Succès montrés en icônes (les autres : case « +N » qui ouvre la page des succès). */
const ACH_MAX = 24
/** Avatars des amis qui y ont joué. */
const FRIENDS_MAX = 18
/** Contenus additionnels listés. */
const DLC_MAX = 6

/** Ouvre un lien de la page (le processus principal n'accepte que http(s) et les protocoles des lanceurs). */
function openLink(url: string): void {
  try {
    window.essaim.openExternalLink(url)
  } catch {
    /* pont pas encore prêt */
  }
}

/** « Aujourd’hui », « Hier », « Il y a 3 jours », puis la date (« 12 oct. 2026 ») ; « Jamais ». */
function lastPlayedText(ts: number | null, now: number): string {
  if (!ts) return t('library.details.never')
  const day = (x: number): number => new Date(x).setHours(0, 0, 0, 0)
  const days = Math.round((day(now) - day(ts)) / 86_400_000)
  if (days >= 7) return formatDay(ts)
  const s = formatLastPlayed(ts, now, true)
  return s.charAt(0).toLocaleUpperCase() + s.slice(1)
}

/** Libellé d'un lien : « Page du magasin », « Ouvrir dans Epic Games »… */
const linkLabel = (link: GameLink, game: Game): string =>
  link.id === 'launcher' ? t('library.details.link.launcher', { platform: platformName(game.platform) }) : t(`library.details.link.${link.id}`)

/** Image distante : disparaît (et laisse la place à fallback) si elle ne se charge pas. */
function Img({ src, className, alt = '', fallback = null }: { src: string | null; className?: string; alt?: string; fallback?: React.ReactNode }): React.JSX.Element | null {
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) return <>{fallback}</>
  return <img className={className} src={src} alt={alt} loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(src)} />
}

/** En-tête d'un encart : légende, compteur, filet terminé par un petit trait, action à droite. */
function Panel({
  title,
  count,
  action,
  className = '',
  testId,
  children
}: {
  title: string
  count?: React.ReactNode
  action?: React.ReactNode
  className?: string
  testId?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={`gd-panel${className ? ` ${className}` : ''}`} data-testid={testId}>
      <header className="gd-ph">
        <h3 className="cap">{title}</h3>
        {count !== undefined && <span className="cap n">{count}</span>}
        <span className="rule" />
        {action}
      </header>
      {children}
    </section>
  )
}

/** Petit lien d'en-tête d'encart (« Tout voir ↗ »). */
function MoreLink({ url, label }: { url: string; label: string }): React.JSX.Element {
  return (
    <button type="button" className="gd-more" title={t('library.details.linkTitle', { url })} onClick={() => openLink(url)}>
      {label}
      <ArrowUpRight />
    </button>
  )
}

// ---------- Encarts ----------

function About({ details }: { details: GameDetails }): React.JSX.Element {
  const { t } = useT()
  const facts: [string, React.ReactNode][] = []
  if (details.developers.length) facts.push([t('library.details.developer'), details.developers.join(', ')])
  if (details.publishers.length) facts.push([t('library.details.publisher'), details.publishers.join(', ')])
  if (details.releaseDate) facts.push([t('library.details.released'), details.releaseDate])
  if (details.genres.length)
    facts.push([
      t('library.details.genres'),
      <span className="gd-genres">
        {details.genres.map((g) => (
          <span key={g} className="tag">
            {g}
          </span>
        ))}
      </span>
    ])
  return (
    <Panel title={t('library.details.about')} className="gd-about">
      {details.description ? <p className="gd-desc">{details.description}</p> : <p className="gd-quiet">{t('library.details.noDescription')}</p>}
      {facts.length > 0 && (
        <dl className="gd-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt className="cap">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {details.source !== 'none' && <div className="gd-source cap">{t(`library.details.source.${details.source}`)}</div>}
    </Panel>
  )
}

function News({ details }: { details: GameDetails }): React.JSX.Element {
  const { t } = useT()
  const all = details.links.find((l) => l.id === 'news')
  return (
    <Panel
      title={t('library.details.news')}
      count={details.news.length || undefined}
      className="gd-newsp"
      action={all ? <MoreLink url={all.url} label={t('library.details.allNews')} /> : undefined}
    >
      {details.news.length ? (
        <div className="gd-news-list">
          {details.news.map((n) => (
            <button
              key={n.id}
              type="button"
              className="gd-news"
              data-testid="detail-news-item"
              title={t('library.details.linkTitle', { url: n.url })}
              onClick={() => openLink(n.url)}
            >
              <span className="gd-news-img">
                <Img src={n.image} fallback={<Newspaper />} />
              </span>
              <span className="gd-news-txt">
                <span className="gd-news-cap">
                  {n.feed && <span className="cap feed">{n.feed}</span>}
                  <span className="cap">{formatDay(n.date)}</span>
                </span>
                <span className="gd-news-title">{n.title}</span>
                {n.excerpt && <span className="gd-news-ex">{n.excerpt}</span>}
              </span>
              <ExternalLink className="gd-news-go" />
            </button>
          ))}
        </div>
      ) : (
        <p className="gd-quiet">{t('library.details.noNews')}</p>
      )}
    </Panel>
  )
}

/** Bulle d'un succès : nom, description, date de déblocage (ou « Verrouillé »). */
function achTitle(a: GameAchievement): string {
  const when = a.achieved ? (a.unlockedAt ? t('library.details.achUnlockedOn', { date: formatDay(a.unlockedAt) }) : '') : t('library.details.achLocked')
  return [a.name, a.description, when].filter(Boolean).join('\n')
}

function Achievements({ data, link }: { data: NonNullable<GameDetails['achievements']>; link: GameLink | undefined }): React.JSX.Element {
  const { t } = useT()
  const p = data.total ? data.unlocked / data.total : 0
  // débloqués d'abord (du plus récent au plus ancien), puis verrouillés
  const items = [...data.items].sort((a, b) => Number(b.achieved) - Number(a.achieved) || (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0))
  const shown = items.slice(0, items.length > ACH_MAX ? ACH_MAX - 1 : ACH_MAX)
  const rest = items.length - shown.length
  return (
    <Panel
      title={t('library.details.achievements')}
      count={`${data.unlocked} / ${data.total}`}
      className="gd-ach"
      testId="detail-achievements"
      action={link ? <MoreLink url={link.url} label={t('library.details.achAll')} /> : undefined}
    >
      <div className="gd-ach-sum">
        <span className="v">{t('library.details.achUnlocked', { n: data.unlocked, total: data.total })}</span>
        <span className="pct">{formatPercent(p)}</span>
      </div>
      <div className="gd-meter">
        <i style={{ '--p': percentVar(p) } as CSSProperties} />
      </div>
      {shown.length > 0 && (
        <div className="gd-ach-grid">
          {shown.map((a) => (
            <span key={a.id} className={`ach${a.achieved ? ' on' : ''}`} title={achTitle(a)}>
              <Img src={a.icon} fallback={<Trophy />} />
            </span>
          ))}
          {rest > 0 &&
            (link ? (
              <button type="button" className="ach more" title={t('library.details.achMoreTitle', { n: rest })} onClick={() => openLink(link.url)}>
                +{rest}
              </button>
            ) : (
              <span className="ach more" title={t('library.details.achMoreTitle', { n: rest })}>
                +{rest}
              </span>
            ))}
        </div>
      )}
    </Panel>
  )
}

function Avatar({ friend, size = 'md' }: { friend: GameFriend; size?: 'md' | 'sm' }): React.JSX.Element {
  return (
    <span className={`gd-av ${size}`} title={friend.name}>
      <Img src={friend.avatar} fallback={<UserRound />} />
    </span>
  )
}

function Friends({ data }: { data: NonNullable<GameDetails['friends']> }): React.JSX.Element {
  const { t, tn } = useT()
  const played = data.played.slice(0, FRIENDS_MAX)
  const rest = data.played.length - played.length
  return (
    <Panel title={t('library.details.friends')} count={data.total || undefined} className="gd-friends" testId="detail-friends">
      {data.total === 0 && !data.playingNow.length && !data.played.length ? (
        <p className="gd-quiet">{t('library.details.friendsNone')}</p>
      ) : (
        <>
          <p className="gd-friends-sum">{tn('library.details.friendsCount', data.total)}</p>
          {data.playingNow.length > 0 && (
            <div className="gd-fgroup">
              <span className="cap">{t('library.details.friendsPlayingNow')}</span>
              <ul className="gd-flist">
                {data.playingNow.map((f) => (
                  <li key={f.steamid}>
                    <Avatar friend={f} />
                    <span className="nm">{f.name}</span>
                    <span className="sdot ingame" aria-label={t('library.state.running')} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {played.length > 0 && (
            <div className="gd-fgroup">
              <span className="cap">{t('library.details.friendsPlayed')}</span>
              <div className="gd-fwall">
                {played.map((f) => (
                  <Avatar key={f.steamid} friend={f} size="sm" />
                ))}
                {rest > 0 && <span className="gd-av sm more">+{rest}</span>}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

function Dlc({ details }: { details: GameDetails }): React.JSX.Element {
  const { t } = useT()
  const link = details.links.find((l) => l.id === 'dlc')
  const shown = details.dlc.slice(0, DLC_MAX)
  const rest = details.dlc.length - shown.length
  return (
    <Panel
      title={t('library.details.dlc')}
      count={details.dlc.length}
      className="gd-dlc"
      action={link ? <MoreLink url={link.url} label={t('library.details.achAll')} /> : undefined}
    >
      <ul className="gd-dlist">
        {shown.map((d) => {
          const url = `https://store.steampowered.com/app/${d.appid}/`
          return (
            <li key={d.appid}>
              <button type="button" title={t('library.details.dlcTitle', { name: d.name })} onClick={() => openLink(url)}>
                <span className="nm">{d.name}</span>
                <ArrowUpRight />
              </button>
            </li>
          )
        })}
      </ul>
      {rest > 0 &&
        (link ? (
          <button type="button" className="gd-more solo" onClick={() => openLink(link.url)}>
            {t('library.details.dlcMore', { n: rest })}
            <ArrowUpRight />
          </button>
        ) : (
          <span className="gd-quiet sm">{t('library.details.dlcMore', { n: rest })}</span>
        ))}
    </Panel>
  )
}

/** Squelette pendant le premier chargement : mêmes cases que la page, sans contenu. */
function Skeleton(): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="gd-body" aria-busy="true" aria-label={t('library.details.loading')}>
      <div className="gd-col">
        <section className="gd-panel">
          <header className="gd-ph">
            <span className="cap">{t('library.details.about')}</span>
            <span className="rule" />
          </header>
          <span className="sk line" style={{ width: '96%' }} />
          <span className="sk line" style={{ width: '88%' }} />
          <span className="sk line" style={{ width: '72%' }} />
          <span className="sk line" style={{ width: '40%', marginTop: 18 }} />
        </section>
        <section className="gd-panel">
          <header className="gd-ph">
            <span className="cap">{t('library.details.news')}</span>
            <span className="rule" />
          </header>
          {[0, 1, 2].map((i) => (
            <div key={i} className="sk-news">
              <span className="sk img" />
              <span className="sk-txt">
                <span className="sk line" style={{ width: '30%' }} />
                <span className="sk line" style={{ width: '80%' }} />
                <span className="sk line" style={{ width: '64%' }} />
              </span>
            </div>
          ))}
        </section>
      </div>
      <div className="gd-col side">
        <section className="gd-panel">
          <header className="gd-ph">
            <span className="cap">{t('library.details.achievements')}</span>
            <span className="rule" />
          </header>
          <span className="sk line" style={{ width: '60%' }} />
          <div className="gd-ach-grid">
            {Array.from({ length: 12 }, (_, i) => (
              <span key={i} className="sk ach" />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

// ---------- Page ----------

export function GameDetailView({
  game: g,
  state,
  startedAt,
  now,
  download,
  platforms,
  onBack,
  onPlay,
  onInstall,
  onEdit,
  onUninstall,
  onMenu,
  onOpenPlatforms
}: Props): React.JSX.Element {
  const { t } = useT()
  const [details, setDetails] = useState<GameDetails | null>(() => CACHE.get(g.id) ?? null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [heroFailed, setHeroFailed] = useState<string | null>(null)
  const [logoFailed, setLogoFailed] = useState<string | null>(null)
  // pendant l'ouverture, la page ignore les clics : le 2e clic d'un double-clic lent ne tombe sur rien
  const [opening, setOpening] = useState(true)
  const req = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const latest = useRef(onBack)
  latest.current = onBack

  const load = useCallback(
    (refresh: boolean) => {
      const n = ++req.current
      setLoading(true)
      let p: Promise<GameDetails>
      try {
        p = window.essaim.getGameDetails(g.id, refresh)
      } catch (err) {
        p = Promise.reject(err)
      }
      p.then(
        (d) => {
          if (n !== req.current) return
          CACHE.set(g.id, d)
          setDetails(d)
          setFailed(null)
        },
        (err) => {
          if (n === req.current) setFailed(errorText(err))
        }
      ).finally(() => {
        if (n === req.current) setLoading(false)
      })
    },
    [g.id]
  )

  useEffect(() => {
    setDetails(CACHE.get(g.id) ?? null)
    setFailed(null)
    scrollRef.current?.scrollTo({ top: 0 })
    scrollRef.current?.focus({ preventScroll: true })
    load(false)
    return () => {
      req.current++
    }
  }, [g.id, load])

  useEffect(() => {
    const timer = window.setTimeout(() => setOpening(false), 420)
    return () => clearTimeout(timer)
  }, [])

  // Échap ou bouton « précédent » de la souris : retour à la grille (pas pendant un dialogue, un menu, une saisie)
  useEffect(() => {
    const busy = (): boolean => !!document.querySelector('[role="dialog"], .ctxmenu')
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || busy()) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      latest.current()
    }
    const onMouse = (e: MouseEvent): void => {
      if (e.button !== 3 || busy()) return
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])

  const live = state === 'running'
  const viaName = g.platform === 'local' ? null : platformName(g.platform)
  const session = startedAt !== null ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  const [h, m, s] = formatClock(session)
  const folder = gameFolder(g)
  const cover = coverSrc(g)
  const heroUrl = details?.heroUrl && heroFailed !== details.heroUrl ? details.heroUrl : null
  const logoUrl = details?.logoUrl && logoFailed !== details.logoUrl ? details.logoUrl : null
  const ach = details?.achievements && details.achievements.total > 0 ? details.achievements : null
  const achP = ach ? ach.unlocked / ach.total : 0
  const steamKey = !!platforms?.steam?.hasKey
  const isSteam = g.platform === 'steam'
  const dl = download && (state === 'downloading' || state === 'updating') ? download : null
  const pct = dl ? formatPercent(downloadFraction(dl)) : null
  const error = failed ?? details?.error ?? null

  // ---- action principale (mêmes règles que le bandeau de la bibliothèque) ----
  let main: React.ReactNode
  if (live)
    main = (
      <div className="gd-live">
        <span className="live-chip" role="status" title={t('library.hero.runningTitle', { name: g.name })}>
          <span className="live-dot" />
          {t('library.state.running')}
        </span>
        <span className="gd-clock" role="timer" aria-label={t('library.hero.sessionAria', { time: `${h}:${m}:${s}` })}>
          {h}:{m}
          <span className="s">:{s}</span>
        </span>
      </div>
    )
  else if (state === 'launching' || state === 'downloading')
    main = (
      <span
        className="live-chip busy gd-chip"
        role="status"
        title={
          state === 'launching'
            ? viaName
              ? t('library.hero.startingVia', { platform: viaName })
              : t('library.hero.startingDefault')
            : viaName
              ? t('library.hero.installingVia', { platform: viaName })
              : t('library.hero.installingDefault')
        }
      >
        <LoaderCircle className="spin" />
        {state === 'launching' ? t('library.state.launching') : t('library.state.downloading')}
        {state === 'downloading' && pct && <span className="pct">{pct}</span>}
      </span>
    )
  else if (state === 'installable')
    main = (
      <button
        type="button"
        className="btn btn-line gd-play"
        data-testid="detail-install"
        title={t('library.hero.installTitle', { name: g.name })}
        onClick={() => onInstall(g)}
      >
        <Download />
        {t('library.common.install')}
      </button>
    )
  else if (state === 'absent')
    main = (
      <span className="live-chip quiet gd-chip" role="status">
        {t('library.state.notInstalled')}
      </span>
    )
  else
    main = (
      <>
        <button
          type="button"
          className="btn btn-primary gd-play"
          data-testid="detail-play"
          title={viaName ? t('library.common.playGameVia', { name: g.name, platform: viaName }) : t('library.common.playGame', { name: g.name })}
          onClick={() => onPlay(g)}
        >
          <Play className="fill" />
          {t('library.common.play')}
        </button>
        {state === 'updating' && (
          <span className="live-chip quiet gd-chip" role="status" title={viaName ? t('library.hero.updatingBy', { platform: viaName }) : undefined}>
            <RefreshCw />
            {t('library.state.updating')}
            {pct && <span className="pct">{pct}</span>}
          </span>
        )}
      </>
    )

  const links = details?.links ?? []
  const achLink = links.find((l) => l.id === 'achievements')
  const keyHint = isSteam && !steamKey && !!details && (details.achievements === null || details.friends === null)
  const friendsPrivate = isSteam && steamKey && !!details && details.friends === null
  const side =
    !!details && (keyHint || !!ach || !!details.friends || friendsPrivate || details.dlc.length > 0)

  return (
    <>
      <div className="toolbar gd-toolbar" role="toolbar" aria-label={t('library.details.aria', { name: g.name })}>
        <button type="button" className="btn btn-line" data-testid="detail-back" title={t('library.details.backTitle')} onClick={onBack}>
          <ArrowLeft />
          {t('library.details.back')}
        </button>
        <div className="tsep" />
        <div className="gd-crumb">
          <span className="cap">{t('library.details.cap')}</span>
          <span className="nm" title={g.name}>
            {g.name}
          </span>
        </div>
        <div className="spacer" />
        {loading && (
          <span className="scanbar gd-loading" role="status" aria-label={t('library.details.loading')}>
            <i />
          </span>
        )}
      </div>

      <div
        className={`gd${opening ? ' opening' : ''}`}
        ref={scrollRef}
        tabIndex={-1}
        data-testid="game-detail"
        data-id={g.id}
        data-state={state}
        aria-label={t('library.details.aria', { name: g.name })}
      >
        {/* ---- bandeau ---- */}
        <header className={`gd-hero${heroUrl ? ' img' : ' fb'}${live ? ' live' : ''}`}>
          {heroUrl ? (
            <img className="gd-hero-img" src={heroUrl} alt="" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setHeroFailed(heroUrl)} />
          ) : cover ? (
            <img className="gd-hero-blur" src={cover} alt="" decoding="async" draggable={false} />
          ) : null}
          <div className="gd-hero-shade" />
          <div className="gd-hero-frame brackets" />
          <div className="gd-hero-body">
            <div className="gd-hero-cap">
              <PlatformTag platform={g.platform} />
              {details?.releaseDate && <span className="cap">{details.releaseDate}</span>}
            </div>
            <h1 className={`gd-name${logoUrl ? ' logo' : ''}`} title={g.name}>
              {logoUrl ? (
                <img className="gd-logo" src={logoUrl} alt={g.name} decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setLogoFailed(logoUrl)} />
              ) : (
                <span className="gd-title">{g.name}</span>
              )}
            </h1>
          </div>
          <span className="gd-hero-plat" title={viaName ? t('library.platform.gameTitle', { platform: viaName }) : t('library.platform.localTitle')}>
            <PlatformLogo platform={g.platform} />
          </span>
        </header>

        {/* ---- barre d'action ---- */}
        <div className={`gd-bar${live ? ' live' : ''}`}>
          <div className="gd-main-act">{main}</div>
          <div className="gd-stats">
            <div>
              <span className="cap">{t('library.details.lastPlayed')}</span>
              <span className="v">{live ? t('library.details.now') : lastPlayedText(gameLastPlayedAt(g), now)}</span>
            </div>
            <div>
              <span className="cap">{t('library.details.playTime')}</span>
              {/* déjà lancé mais temps inconnu (plateforme qui ne le donne pas, ex. Battle.net) : « — » plutôt que « jamais joué » */}
              <span className="v">
                {gamePlayTimeSeconds(g) + session === 0 && gameLastPlayedAt(g) ? '—' : formatPlayTime(gamePlayTimeSeconds(g) + session)}
              </span>
            </div>
            {ach && (
              <div className="ach-stat">
                <span className="cap">{t('library.details.achievements')}</span>
                <span className="v">
                  {ach.unlocked}
                  <span className="tot"> / {ach.total}</span>
                </span>
                <span className="gd-meter sm">
                  <i style={{ '--p': percentVar(achP) } as CSSProperties} />
                </span>
              </div>
            )}
          </div>
          <div className="gd-tools">
            {(g.platform === 'local' || onThisPc(g)) && (
              <button
                type="button"
                className="btn btn-line gd-ibtn"
                title={t('library.hero.openFolderTitle')}
                aria-label={t('library.common.openFolder')}
                disabled={!folder}
                onClick={() => window.essaim.openGameFolder(g.id)}
              >
                <FolderOpen />
              </button>
            )}
            <button
              type="button"
              className="btn btn-line gd-ibtn"
              title={viaName ? t('library.hero.editTitleVia', { platform: viaName }) : t('library.hero.editTitle')}
              aria-label={t('library.common.edit')}
              onClick={() => onEdit(g)}
            >
              <Pencil />
            </button>
            {g.installed && state !== 'downloading' && (
              <button
                type="button"
                className="btn btn-line gd-ibtn"
                title={t('library.details.uninstallTitle', { name: g.name })}
                aria-label={t('library.details.uninstall')}
                disabled={state === 'running' || state === 'launching'}
                onClick={() => onUninstall(g)}
              >
                <PackageX />
              </button>
            )}
            <button
              type="button"
              className="btn btn-line gd-ibtn"
              data-testid="detail-refresh"
              title={t('library.details.refreshTitle')}
              aria-label={t('library.details.refresh')}
              disabled={loading}
              onClick={() => load(true)}
            >
              <RefreshCw className={loading ? 'spin' : undefined} />
            </button>
            <button
              type="button"
              className="btn btn-line gd-ibtn"
              title={t('library.details.more')}
              aria-label={t('library.details.more')}
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                onMenu(g, r.right - 264, r.bottom + 4)
              }}
            >
              <Ellipsis />
            </button>
          </div>
        </div>

        {dl && <DownloadPanel download={dl} update={state === 'updating'} />}

        {/* ---- liens ---- */}
        {links.length > 0 ? (
          <nav className="gd-links" aria-label={t('library.details.linksAria')}>
            {links.map((l) => (
              <button
                key={`${l.id}-${l.url}`}
                type="button"
                className={`gd-link${l.id === 'launcher' ? ' launcher' : ''}`}
                data-testid={`detail-link-${l.id}`}
                title={t('library.details.linkTitle', { url: l.url })}
                onClick={() => openLink(l.url)}
              >
                {linkLabel(l, g)}
                <ExternalLink />
              </button>
            ))}
          </nav>
        ) : !details && !failed ? (
          <div className="gd-links sk-links" aria-hidden="true">
            {[92, 48, 120, 96, 84, 64, 76, 64].map((w, i) => (
              <span key={i} className="sk pill" style={{ width: w }} />
            ))}
          </div>
        ) : null}

        {/* ---- erreur (on garde ce qui est en cache) ---- */}
        {error && (
          <div className="gd-banner" role="alert">
            <TriangleAlert />
            <span className="msg">
              {failed && !details ? `${t('library.details.failed')} ${failed}` : error}
              {details && details.fetchedAt > 0 && <span className="sub"> {t('library.details.savedInfo', { when: formatWhen(details.fetchedAt, now) })}</span>}
            </span>
            <button type="button" className="btn btn-line btn-sm" disabled={loading} onClick={() => load(true)}>
              <RefreshCw />
              {t('library.details.retry')}
            </button>
          </div>
        )}

        {/* ---- corps ---- */}
        {details ? (
          <div className={`gd-body${side ? '' : ' one'}`}>
            <div className="gd-col">
              <About details={details} />
              <News details={details} />
            </div>
            {side && (
              <div className="gd-col side">
                {keyHint && (
                  <div className="gd-hint">
                    <KeyRound />
                    <p>{t('library.details.keyHint')}</p>
                    <button type="button" className="btn btn-line btn-sm" onClick={onOpenPlatforms}>
                      {t('library.details.keyHintBtn')}
                    </button>
                  </div>
                )}
                {ach && <Achievements data={ach} link={achLink} />}
                {details.friends ? (
                  <Friends data={details.friends} />
                ) : friendsPrivate ? (
                  <Panel title={t('library.details.friends')} className="gd-friends" testId="detail-friends">
                    <p className="gd-quiet">{t('library.details.friendsPrivate')}</p>
                  </Panel>
                ) : null}
                {details.dlc.length > 0 && <Dlc details={details} />}
              </div>
            )}
          </div>
        ) : !failed ? (
          <Skeleton />
        ) : null}
      </div>
    </>
  )
}
