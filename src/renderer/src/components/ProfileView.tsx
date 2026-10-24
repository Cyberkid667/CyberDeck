import { Award, ExternalLink, Gamepad2, KeyRound, LoaderCircle, Lock, RefreshCw, UserRound, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Game,
  PlatformsState,
  SteamFriend,
  SteamFriendsState,
  SteamPresence,
  SteamProfile,
  SteamProfileAchievement,
  SteamProfileBadge,
  SteamProfileGame,
  SteamProfileState
} from '../../../shared/types'
import { formatDay, formatLastPlayed } from '../format'
import { useT } from '../i18n'

// Onglet PROFIL de la vue Steam (passe 3 de la refonte « Steam dans CyberDeck ») : la structure
// d'une page de profil Steam, aux couleurs de l'app.
//   - en-tête : grand avatar, pseudo, nom réel et pays (seulement s'ils sont publics), présence,
//     « membre depuis », pastille du niveau Steam, bouton « Voir sur Steam » ;
//   - colonne principale : rangée de chiffres (jeux possédés, heures), activité récente (clic : page
//     du jeu dans la bibliothèque), vitrine des succès (les plus rares, les plus récents), badges ;
//   - à droite, la liste d'amis comme dans Steam : En jeu (vert, avec le jeu), En ligne, Hors ligne
//     (vu en ligne…) ; relue toutes les 60 s quand l'onglet est visible ; liste privée : marche à
//     suivre et bouton vers les paramètres de confidentialité. Pas de chat (Valve n'offre pas
//     d'API) : clic sur un ami = son profil dans Steam.
// Toutes les données viennent du processus principal (steamProfile.ts).

const FRIENDS_POLL = 60_000
const PRIVACY_URL = 'https://steamcommunity.com/my/edit/settings'
const ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps'

function openLink(url: string): void {
  try {
    window.essaim.openExternalLink(url)
  } catch {
    /* pont pas encore prêt */
  }
}

const hours = (minutes: number): string => {
  const h = minutes / 60
  return h >= 100 ? Math.round(h).toLocaleString() : h.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

const friendUrl = (id: string): string => `https://steamcommunity.com/profiles/${id}/`

/** Groupe d'un ami dans la liste. */
const groupOf = (s: SteamPresence): 'ingame' | 'online' | 'offline' => (s === 'ingame' ? 'ingame' : s === 'offline' ? 'offline' : 'online')

interface Props {
  platforms: PlatformsState | null
  /** jeux Steam de la bibliothèque, par appid */
  owned: Map<number, Game>
  /** l'onglet est affiché (les amis ne sont relus que dans ce cas) */
  active: boolean
  onOpenGame: (game: Game) => void
  onOpenLaunchers: (focus?: 'steam-key') => void
}

// ---------- Petits morceaux ----------

/** Image qui disparaît (ou passe à la suivante) si elle ne charge pas. */
function Img({ srcs, classes = [], alt = '' }: { srcs: (string | null | undefined)[]; classes?: string[]; alt?: string }): React.JSX.Element | null {
  const list: { src: string; cls: string | undefined }[] = []
  srcs.forEach((src, n) => {
    if (src) list.push({ src, cls: classes[n] || undefined })
  })
  const [i, setI] = useState(0)
  const cur = list[i]
  if (!cur) return null
  return <img className={cur.cls} src={cur.src} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setI((n) => n + 1)} />
}

function Avatar({ src, className }: { src: string | null | undefined; className: string }): React.JSX.Element {
  const [failed, setFailed] = useState<string | null>(null)
  if (src && failed !== src) return <img className={className} src={src} alt="" draggable={false} onError={() => setFailed(src)} />
  return (
    <span className={`${className} none`} aria-hidden="true">
      <UserRound />
    </span>
  )
}

function Section({ id, title, testId, children }: { id: string; title: string; testId: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className={`prf-sec sec-${id}`} data-testid={testId}>
      <header className="prf-sh">
        <h3 className="cap">{title}</h3>
        <span className="rule" />
      </header>
      {children}
    </section>
  )
}

/** Panneau calme centré (pas de clé, erreur, liste d'amis privée). */
function Calm({ testId, icon, cap, title, text, children }: { testId: string; icon: React.ReactNode; cap?: string; title: string; text: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="prf-calm" data-testid={testId}>
      <div className="box brackets">
        {icon}
        {cap && <span className="cap">{cap}</span>}
        <h2>{title}</h2>
        <p>{text}</p>
        {children}
      </div>
    </div>
  )
}

// ---------- Amis ----------

function FriendRow({ f, now }: { f: SteamFriend; now: number }): React.JSX.Element {
  const { t } = useT()
  const group = groupOf(f.status)
  const line =
    f.status === 'ingame'
      ? f.game ?? t('friends.ingame')
      : group === 'online'
        ? t(`profile.status.${f.status}`)
        : f.lastOnline
          ? t('friends.lastOnline', { when: formatLastPlayed(f.lastOnline, now, true) })
          : t('friends.offline')
  return (
    <button
      type="button"
      className={`prf-friend st-${group}`}
      data-testid="friend-row"
      data-state={group}
      title={t('friends.openTitle', { name: f.name })}
      onClick={() => openLink(friendUrl(f.steamid))}
    >
      <Avatar src={f.avatar} className="av" />
      <span className="txt">
        <span className="nm">{f.name}</span>
        <span className="sub">{line}</span>
      </span>
    </button>
  )
}

function Friends({ state, now }: { state: SteamFriendsState | null; now: number }): React.JSX.Element {
  const { t } = useT()
  const groups = useMemo(() => {
    const byName = (a: SteamFriend, b: SteamFriend): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    const list = state?.friends ?? []
    return [
      { id: 'ingame' as const, items: list.filter((f) => f.status === 'ingame').sort(byName) },
      { id: 'online' as const, items: list.filter((f) => groupOf(f.status) === 'online').sort(byName) },
      { id: 'offline' as const, items: list.filter((f) => f.status === 'offline').sort((a, b) => (b.lastOnline ?? 0) - (a.lastOnline ?? 0) || byName(a, b)) }
    ].filter((g) => g.items.length > 0)
  }, [state])

  let body: React.ReactNode
  if (!state) {
    body = (
      <p className="prf-quiet">
        <LoaderCircle className="spin" /> {t('friends.loading')}
      </p>
    )
  } else if (state.error === 'private') {
    body = (
      <div className="prf-private" data-testid="friends-private">
        <Lock className="big" />
        <span className="cap">{t('friends.private.cap')}</span>
        <h4>{t('friends.private.title')}</h4>
        <p>{t('friends.private.text')}</p>
        <ol>
          <li>{t('friends.private.step1')}</li>
          <li>{t('friends.private.step2')}</li>
          <li>{t('friends.private.step3')}</li>
        </ol>
        <button type="button" className="btn btn-line btn-sm" data-testid="friends-privacy" onClick={() => openLink(PRIVACY_URL)}>
          <ExternalLink />
          {t('friends.private.btn')}
        </button>
      </div>
    )
  } else if (!state.friends.length) {
    body = <p className="prf-quiet">{state.error ? t('friends.error') : t('friends.none')}</p>
  } else {
    body = (
      <>
        {state.error && <p className="prf-stale cap">{t('profile.stale')}</p>}
        {groups.map((g) => (
          <div key={g.id} className={`prf-fgroup g-${g.id}`} data-group={g.id}>
            <span className="cap gh">{t(`friends.${g.id}`)}</span>
            {g.items.map((f) => (
              <FriendRow key={f.steamid} f={f} now={now} />
            ))}
          </div>
        ))}
        <p className="prf-quiet sm">{t('friends.note')}</p>
      </>
    )
  }
  return (
    <aside className="prf-friends" data-testid="steam-friends" aria-label={t('friends.aria')}>
      <header className="prf-sh">
        <h3 className="cap">{t('friends.title')}</h3>
        <span className="rule" />
      </header>
      <div className="prf-flist">{body}</div>
    </aside>
  )
}

// ---------- Sections du profil ----------

function Recent({ games, owned, now, onOpenGame }: { games: SteamProfileGame[]; owned: Map<number, Game>; now: number; onOpenGame: (g: Game) => void }): React.JSX.Element {
  const { t } = useT()
  return (
    <Section id="recent" title={t('profile.recent')} testId="profile-recent">
      {!games.length ? (
        <p className="prf-quiet">{t('profile.recent.none')}</p>
      ) : (
        <div className="prf-recent-list">
          {games.map((g) => {
            const game = owned.get(g.appid)
            return (
              <button
                key={g.appid}
                type="button"
                className="prf-game"
                data-appid={g.appid}
                title={game ? t('profile.recent.openTitle', { name: g.name }) : t('profile.recent.storeTitle', { name: g.name })}
                onClick={() => (game ? onOpenGame(game) : openLink(`https://store.steampowered.com/app/${g.appid}/`))}
              >
                <span className="art">
                  <Img srcs={[`${ASSETS}/${g.appid}/header.jpg`, g.icon]} classes={['', 'small']} />
                  <Gamepad2 className="ph" />
                </span>
                <span className="txt">
                  <span className="nm">{g.name}</span>
                  <span className="sub">
                    {t('profile.recent.total', { h: hours(g.minutesTotal) })}
                    {g.lastPlayedAt ? <> · {t('profile.recent.last', { when: formatLastPlayed(g.lastPlayedAt, now, true) })}</> : null}
                  </span>
                </span>
                <span className="wk">{t('profile.recent.past2w', { h: hours(g.minutes2Weeks) })}</span>
              </button>
            )
          })}
        </div>
      )}
    </Section>
  )
}

function AchIcon({ a }: { a: SteamProfileAchievement }): React.JSX.Element {
  const { t } = useT()
  const pct = a.percent !== null ? a.percent.toLocaleString(undefined, { maximumFractionDigits: 1 }) : null
  const title = pct ? t('profile.ach.titlePct', { name: a.name, game: a.game, pct }) : t('profile.ach.title', { name: a.name, game: a.game })
  return (
    <span className="prf-ach" title={a.description ? `${title}\n${a.description}` : title}>
      <span className="ico">
        <Img srcs={[a.icon]} />
        <Award className="ph" />
      </span>
      {pct && <span className="pct">{t('profile.ach.pct', { pct })}</span>}
    </span>
  )
}

function Achievements({ p }: { p: SteamProfile }): React.JSX.Element {
  const { t } = useT()
  const none = !p.rarest.length && !p.latest.length
  return (
    <Section id="achievements" title={t('profile.achievements')} testId="profile-achievements">
      {none ? (
        <p className="prf-quiet">{t('profile.ach.none')}</p>
      ) : (
        <div className="prf-ach-rows">
          {p.rarest.length > 0 && (
            <div className="prf-ach-row">
              <span className="cap k">{t('profile.ach.rarest')}</span>
              <div className="icons">
                {p.rarest.map((a) => (
                  <AchIcon key={`${a.appid}:${a.id}`} a={a} />
                ))}
              </div>
            </div>
          )}
          {p.latest.length > 0 && (
            <div className="prf-ach-row">
              <span className="cap k">{t('profile.ach.latest')}</span>
              <div className="icons">
                {p.latest.map((a) => (
                  <AchIcon key={`${a.appid}:${a.id}`} a={a} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function badgeName(b: SteamProfileBadge, t: (k: string) => string): string {
  if (b.appid) return b.gameName ?? `App ${b.appid}`
  return [1, 2, 13].includes(b.badgeId) ? t(`profile.badge.id.${b.badgeId}`) : t('profile.badge.steam')
}

const formatMonth = (ts: number, locale: string): string => new Date(ts).toLocaleDateString(locale, { month: 'short', year: 'numeric' })

function Badges({ p }: { p: SteamProfile }): React.JSX.Element {
  const { t, tn, locale } = useT()
  const known = p.level !== null
  return (
    <Section id="badges" title={t('profile.badges')} testId="profile-badges">
      {!known ? (
        <p className="prf-quiet">{t('profile.badges.private')}</p>
      ) : (
        <>
          <p className="prf-badge-sum">
            <span className="hi">{t('profile.badges.summary', { level: p.level!, xp: (p.xp ?? 0).toLocaleString() })}</span>
            {p.badgeCount !== null && <span> · {tn('profile.badges.earned', p.badgeCount)}</span>}
            {p.xpToNext ? <span> · {t('profile.badges.toNext', { xp: p.xpToNext.toLocaleString(), next: p.level! + 1 })}</span> : null}
          </p>
          {!p.badges.length ? (
            <p className="prf-quiet">{t('profile.badges.none')}</p>
          ) : (
            <div className="prf-badges">
              {p.badges.map((b) => (
                <span key={`${b.badgeId}:${b.appid ?? 0}:${b.foil ? 1 : 0}`} className={`prf-badge${b.foil ? ' foil' : ''}`} title={b.earnedAt ? t('profile.badge.earned', { date: formatDay(b.earnedAt) }) : undefined}>
                  <span className="ico">
                    <Img srcs={[b.icon]} />
                    <Award className="ph" />
                  </span>
                  <span className="txt">
                    <span className="nm">{badgeName(b, t)}</span>
                    <span className="sub">
                      {t('profile.badge.level', { n: b.level })} · {t('profile.badge.xp', { xp: b.xp.toLocaleString() })}
                      {b.foil ? <> · {t('profile.badge.foil')}</> : null}
                      {b.earnedAt ? <> · {formatMonth(b.earnedAt, locale)}</> : null}
                    </span>
                  </span>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  )
}

// ---------- Vue ----------

export function ProfileView({ platforms, owned, active, onOpenGame, onOpenLaunchers }: Props): React.JSX.Element {
  const { t, locale } = useT()
  const steam = platforms?.steam
  const [state, setState] = useState<SteamProfileState | null>(null)
  const [friends, setFriends] = useState<SteamFriendsState | null>(null)
  const [busy, setBusy] = useState(false)
  const keyed = !!steam?.hasKey
  const steamId = steam?.steamId ?? null

  const load = useCallback((refresh: boolean) => {
    setBusy(true)
    let alive = true
    try {
      window.essaim.getSteamProfile(refresh).then(
        (s) => {
          if (!alive) return
          setState(s)
          setBusy(false)
        },
        () => alive && setBusy(false)
      )
      if (refresh) window.essaim.getSteamFriends(true).then((f) => alive && setFriends(f), () => {})
    } catch {
      setBusy(false)
    }
    return () => {
      alive = false
    }
  }, [])

  // profil : lu à l'ouverture et quand la clé ou le compte changent
  useEffect(() => load(false), [load, keyed, steamId])

  // amis : lus tout de suite, puis toutes les 60 s tant que l'onglet est visible
  useEffect(() => {
    if (!active || state?.error === 'no-key' || state?.error === 'no-account') return
    let alive = true
    const read = (): void => {
      if (document.visibilityState !== 'visible') return
      try {
        window.essaim.getSteamFriends().then((f) => alive && setFriends(f), () => {})
      } catch {
        /* pont pas encore prêt */
      }
    }
    read()
    const timer = window.setInterval(read, FRIENDS_POLL)
    document.addEventListener('visibilitychange', read)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [active, keyed, steamId, state?.error])

  const now = Date.now()
  const country = useMemo(() => {
    const cc = state?.profile?.country
    if (!cc) return null
    try {
      return new Intl.DisplayNames([locale], { type: 'region' }).of(cc) ?? cc
    } catch {
      return cc
    }
  }, [state?.profile?.country, locale])

  // ---- pas de clé / pas de compte ----
  const err = state?.error ?? null
  if (err === 'no-key' || (!state && steam && !steam.hasKey && steam.detected)) {
    return (
      <div className="prf" data-testid="steam-profile" data-state="no-key">
        <Calm testId="profile-no-key" icon={<KeyRound className="big" />} cap={t('profile.noKey.cap')} title={t('profile.noKey.title')} text={t('profile.noKey.text')}>
          <button type="button" className="btn btn-line" data-testid="profile-add-key" onClick={() => onOpenLaunchers('steam-key')}>
            <KeyRound />
            {t('profile.noKey.btn')}
          </button>
        </Calm>
      </div>
    )
  }
  if (err === 'no-account') {
    return (
      <div className="prf" data-testid="steam-profile" data-state="no-account">
        <Calm testId="profile-no-account" icon={<UserRound className="big" />} title={t('profile.noAccount.title')} text={t('profile.noAccount.text')}>
          <button type="button" className="btn btn-line" onClick={() => onOpenLaunchers()}>
            {t('profile.noAccount.btn')}
          </button>
        </Calm>
      </div>
    )
  }

  const p = state?.profile ?? null
  if (state && !p) {
    const kind = err === 'invalid-key' ? 'invalid-key' : err === 'offline' ? 'offline' : 'unavailable'
    return (
      <div className="prf" data-testid="steam-profile" data-state="error">
        <Calm testId="profile-error" icon={kind === 'offline' ? <WifiOff className="big" /> : <UserRound className="big" />} title={t(`profile.error.${kind}.title`)} text={t(`profile.error.${kind}.text`)}>
          <div className="row">
            <button type="button" className="btn btn-line" disabled={busy} onClick={() => load(true)}>
              <RefreshCw className={busy ? 'spin' : undefined} />
              {t('profile.retry')}
            </button>
            {kind === 'invalid-key' && (
              <button type="button" className="btn btn-line" onClick={() => onOpenLaunchers('steam-key')}>
                <KeyRound />
                {t('profile.noKey.btn')}
              </button>
            )}
          </div>
        </Calm>
      </div>
    )
  }

  // ---- profil (ou en-tête provisoire pendant le chargement) ----
  const name = p?.personaName || steam?.personaName || ''
  const avatar = p?.avatar ?? steam?.avatarUrl ?? null
  const status: SteamPresence = p?.status ?? 'offline'
  const group = groupOf(status)
  const profileUrl = p?.profileUrl ?? (steamId ? friendUrl(steamId) : 'https://steamcommunity.com/my/')
  const statusLine = !p
    ? null
    : status === 'ingame' && p.gameName
      ? t('profile.playing', { game: p.gameName })
      : group === 'offline' && p.lastOnline
        ? t('profile.lastOnline', { when: formatLastPlayed(p.lastOnline, now, true) })
        : t(`profile.status.${status}`)
  const recentMinutes = p ? p.recent.reduce((s, g) => s + g.minutes2Weeks, 0) : 0

  return (
    <div className="prf" data-testid="steam-profile" data-state={p ? 'ok' : 'loading'} aria-label={t('profile.aria')}>
      <div className="prf-scroll">
        {/* ---- en-tête ---- */}
        <header className={`prf-head st-${group}`} data-testid="profile-header">
          {avatar && <span className="prf-head-bg" style={{ backgroundImage: `url("${avatar}")` }} aria-hidden="true" />}
          <span className="prf-avatar">
            <Avatar src={avatar} className="img" />
          </span>
          <div className="prf-id">
            <span className="cap">{t('profile.cap')}</span>
            <h1 className="nm">{name}</h1>
            {(p?.realName || country) && (
              <p className="real">
                {p?.realName}
                {p?.realName && country ? ' · ' : ''}
                {country}
              </p>
            )}
            {statusLine && (
              <p className={`status st-${group}`}>
                <span className="sdot" />
                {statusLine}
              </p>
            )}
            {p?.memberSince && <p className="since">{t('profile.memberSince', { date: formatDay(p.memberSince) })}</p>}
          </div>
          <div className="prf-side">
            {p?.level !== null && p?.level !== undefined && (
              <span className="prf-level" aria-label={t('profile.levelAria', { level: p.level })}>
                <span className="cap">{t('profile.level')}</span>
                <span className="ring">{p.level}</span>
              </span>
            )}
            <div className="acts">
              <button type="button" className="btn btn-line btn-sm" data-testid="profile-refresh" title={t('profile.refresh')} aria-label={t('profile.refresh')} disabled={busy} onClick={() => load(true)}>
                <RefreshCw className={busy ? 'spin' : undefined} />
              </button>
              <button type="button" className="btn btn-line" data-testid="profile-open-steam" title={t('profile.viewOnSteamTitle')} onClick={() => openLink(profileUrl)}>
                <ExternalLink />
                {t('profile.viewOnSteam')}
              </button>
            </div>
          </div>
        </header>
        {err && p && <p className="prf-stale cap">{t('profile.stale')}</p>}

        <div className="prf-body">
          <div className="prf-main">
            {!p ? (
              <div className="prf-loading">
                <span className="scanbar">
                  <i />
                </span>
                <span className="cap">{t('profile.loading')}</span>
              </div>
            ) : (
              <>
                <div className="prf-stats" data-testid="profile-stats">
                  {p.gamesOwned !== null && (
                    <span className="stat">
                      <span className="v">{p.gamesOwned.toLocaleString()}</span>
                      <span className="cap">{t('profile.stats.games')}</span>
                    </span>
                  )}
                  {p.totalMinutes !== null && (
                    <span className="stat">
                      <span className="v">{Math.round(p.totalMinutes / 60).toLocaleString()}</span>
                      <span className="cap">{t('profile.stats.hours')}</span>
                    </span>
                  )}
                  <span className="stat">
                    <span className="v">{hours(recentMinutes)}</span>
                    <span className="cap">{t('profile.stats.recent')}</span>
                  </span>
                </div>
                <Recent games={p.recent} owned={owned} now={now} onOpenGame={onOpenGame} />
                <Achievements p={p} />
                <Badges p={p} />
              </>
            )}
          </div>
          <Friends state={friends} now={now} />
        </div>
      </div>
    </div>
  )
}
