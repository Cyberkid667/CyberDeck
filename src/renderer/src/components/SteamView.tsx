import {
  ArrowDownToLine,
  Blocks,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gamepad2,
  House,
  LoaderCircle,
  UserRound
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { gameLastPlayedAt } from '../../../shared/platforms'
import type { DownloadProgress, Game, LibraryState, PlatformsState, SteamCollections } from '../../../shared/types'
import { formatLastPlayed, formatPercent, formatSpeed } from '../format'
import { useT } from '../i18n'
import { canPlayState, gameState, onThisPc, type GameState } from '../platformUi'
import { CommunityView } from './CommunityView'
import { Cover, coverSrc, iconSrc } from './Cover'
import { downloadFraction, downloadMode, downloadPhaseLabel } from './DownloadPanel'
import { LiveBar } from './LiveProgress'
import { PlatformLogo } from './PlatformLogo'
import { ProfileView } from './ProfileView'
import { StoreView } from './StoreView'
import { SearchBox } from './Toolbar'

// Vue Steam de la bibliothèque (passe 1 de la refonte « Steam dans CyberDeck ») : la structure du
// client Steam, aux couleurs de l'app.
//   - barre du haut : MAGASIN · BIBLIOTHÈQUE · COMMUNAUTÉ · PROFIL (+ pseudo et avatar du compte) ;
//     Magasin (passe 2, StoreView), Profil (passe 3, ProfileView : profil, badges, succès, amis) et
//     Communauté (passe 4, CommunityView : actualités, Workshop, guides et discussions) ; le pseudo
//     et l'avatar ouvrent le Profil ;
//   - à gauche, la liste des jeux comme dans Steam : Accueil, recherche, filtre (Tous / Installés /
//     Pas installés), puis FAVORIS, les collections de l'utilisateur (lues dans le stockage cloud
//     local de Steam, en lecture seule), SANS CATÉGORIE et CACHÉS (replié) ; clic : page du jeu à
//     droite, double-clic : jouer / installer, clic droit : menu du jeu ;
//   - à droite, l'Accueil (étagères : jeux récents, téléchargements, collections) ou la page du jeu
//     (GameDetailView, passée par LibraryView) ;
//   - en bas, la barre des téléchargements (clic : page du jeu téléchargé).
// Sous 1024 px de large, la liste devient un rail d'icônes (CSS).

export type SteamTab = 'store' | 'library' | 'community' | 'profile'
const TABS: SteamTab[] = ['store', 'library', 'community', 'profile']

type ListFilter = 'all' | 'installed' | 'notInstalled'
const FILTERS: ListFilter[] = ['all', 'installed', 'notInstalled']

/** Jaquettes d'une étagère (le reste : « Tout voir » ouvre la liste). */
const SHELF_MAX = 40
/** Jeux récents montrés. */
const RECENT_MAX = 12

/** Groupes repliés de la liste : simple confort, mémorisé. Cachés : replié par défaut. */
const COLLAPSED_KEY = 'cyberdeck.steamCollapsed'
function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    // simple confort
  }
  return new Set(['hidden'])
}
function storeCollapsed(s: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]))
  } catch {
    // simple confort
  }
}

/** Recherche sans accents ni casse : « pokemon » trouve « Pokémon ». */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')

const appidOf = (g: Game): number | null => {
  const n = Number(g.platformId)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Ordre des téléchargements : celui qui avance d'abord. */
const PHASE_RANK: Record<DownloadProgress['phase'], number> = { downloading: 0, installing: 1, paused: 2, queued: 3 }

interface Group {
  id: string
  name: string
  games: Game[]
}

interface Props {
  /** jeux Steam de la bibliothèque (installés, en téléchargement ou possédés) */
  games: Game[]
  library: LibraryState
  platforms: PlatformsState | null
  downloads: Record<string, DownloadProgress>
  /** jeu dont la page est ouverte à droite (null : Accueil) */
  selectedId: string | null
  /** page du jeu (GameDetailView), quand un jeu est choisi */
  detail: React.ReactNode
  /** change à chaque clic sur l'entrée Steam de la barre latérale : retour à Bibliothèque / Accueil */
  navKey: number
  onOpen: (game: Game) => void
  onHome: () => void
  onPlay: (game: Game) => void
  onInstall: (game: Game) => void
  onMenu: (game: Game, x: number, y: number) => void
  onOpenLaunchers: (focus?: 'steam-key') => void
}

// ---------- Petits morceaux ----------

/** Petite icône d'une ligne : icône du programme, sinon la jaquette, sinon une manette. */
function RowIcon({ game }: { game: Game }): React.JSX.Element {
  const src = iconSrc(game) ?? coverSrc(game)
  const [failed, setFailed] = useState<string | null>(null)
  if (src && failed !== src) return <img className="stv-ico" src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />
  return (
    <span className="stv-ico none" aria-hidden="true">
      <Gamepad2 />
    </span>
  )
}

interface RowProps {
  game: Game
  state: GameState
  selected: boolean
  download: DownloadProgress | null
  onOpen: (g: Game) => void
  onPlay: (g: Game) => void
  onInstall: (g: Game) => void
  onMenu: (g: Game, x: number, y: number) => void
}

const Row = memo(function Row({ game: g, state, selected, download, onOpen, onPlay, onInstall, onMenu }: RowProps): React.JSX.Element {
  const { t } = useT()
  const busy = state === 'downloading' || state === 'updating'
  const pct = busy && download ? formatPercent(downloadFraction(download)) : null
  const action = canPlayState(state) ? t('steam.list.actPlay') : state === 'installable' ? t('steam.list.actInstall') : null
  return (
    <button
      type="button"
      className={`stv-row${selected ? ' on' : ''}${!onThisPc(g) ? ' absent' : ''} s-${state}`}
      data-testid="steam-row"
      data-appid={g.platformId ?? ''}
      data-id={g.id}
      data-state={state}
      aria-current={selected ? 'page' : undefined}
      title={action ? t('steam.list.rowTitle', { name: g.name, action }) : g.name}
      onClick={() => onOpen(g)}
      onDoubleClick={() => {
        if (canPlayState(state)) onPlay(g)
        else if (state === 'installable') onInstall(g)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(g, e.clientX, e.clientY)
      }}
    >
      <RowIcon game={g} />
      <span className="nm">{g.name}</span>
      {state === 'running' ? (
        <span className="st ingame" aria-label={t('library.state.running')}>
          <span className="sdot" />
        </span>
      ) : state === 'launching' ? (
        <LoaderCircle className="st spin" aria-label={t('library.state.launching')} />
      ) : busy ? (
        <span className="st dl">{pct ?? <LoaderCircle className="spin" />}</span>
      ) : null}
    </button>
  )
})

/** Étagère de l'accueil : légende, compteur, flèches, rangée de jaquettes qui défile de côté. */
function Shelf({
  id,
  title,
  games,
  library,
  now,
  recent = false,
  onOpen
}: {
  id: string
  title: string
  games: Game[]
  library: LibraryState
  now: number
  recent?: boolean
  onOpen: (g: Game) => void
}): React.JSX.Element {
  const { t } = useT()
  const strip = useRef<HTMLDivElement>(null)
  const scroll = (dir: 1 | -1): void => {
    const el = strip.current
    if (el) el.scrollBy({ left: dir * Math.max(200, el.clientWidth - 120), behavior: 'smooth' })
  }
  const shown = games.slice(0, SHELF_MAX)
  return (
    <section className={`stv-shelf${recent ? ' recent' : ''}`} data-testid="steam-shelf" data-shelf={id}>
      <header className="stv-sh">
        <h3 className="cap">{title}</h3>
        <span className="rule" />
        <button type="button" className="stv-arrow" aria-label={t('steam.home.prev')} title={t('steam.home.prev')} onClick={() => scroll(-1)}>
          <ChevronLeft />
        </button>
        <button type="button" className="stv-arrow" aria-label={t('steam.home.next')} title={t('steam.home.next')} onClick={() => scroll(1)}>
          <ChevronRight />
        </button>
      </header>
      <div className="stv-strip" ref={strip}>
        {shown.map((g) => {
          const state = gameState(g, library)
          const last = gameLastPlayedAt(g)
          const dl = state === 'downloading' || state === 'updating'
          return (
            <button
              key={g.id}
              type="button"
              className={`stv-tile s-${state}${onThisPc(g) ? '' : ' absent'}`}
              data-testid="steam-tile"
              data-id={g.id}
              title={t('steam.home.openTitle', { name: g.name })}
              onClick={() => onOpen(g)}
            >
              <Cover game={g} className="stv-cov">
                {state === 'running' && (
                  <span className="stv-chip ingame">
                    <span className="sdot" />
                    {t('library.state.running')}
                  </span>
                )}
                {dl && (
                  <span className="stv-chip dl">
                    <ArrowDownToLine />
                    {state === 'updating' ? t('library.state.updating') : t('library.state.downloading')}
                  </span>
                )}
              </Cover>
              <span className="nm">{g.name}</span>
              {recent && (
                <span className="sub cap">
                  {state === 'running'
                    ? t('library.state.running')
                    : last
                      ? t('steam.home.played', { when: formatLastPlayed(last, now) })
                      : t('steam.home.neverPlayed')}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}

// ---------- Vue ----------

export function SteamView({
  games,
  library,
  platforms,
  downloads,
  selectedId,
  detail,
  navKey,
  onOpen,
  onHome,
  onPlay,
  onInstall,
  onMenu,
  onOpenLaunchers
}: Props): React.JSX.Element {
  const { t, tn } = useT()
  const [tab, setTab] = useState<SteamTab>('library')
  // le magasin reste monté après la première visite : on y retrouve la page quittée
  const [storeSeen, setStoreSeen] = useState(false)
  // la communauté aussi (article ou objet du Workshop ouverts)
  const [communitySeen, setCommunitySeen] = useState(false)
  useEffect(() => {
    if (tab === 'store') setStoreSeen(true)
    if (tab === 'community') setCommunitySeen(true)
  }, [tab])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ListFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [cols, setCols] = useState<SteamCollections | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const steam = platforms?.steam
  const steamId = steam?.steamId ?? null

  // Entrée Steam de la barre latérale cliquée : retour à la bibliothèque
  useEffect(() => {
    if (navKey) setTab('library')
  }, [navKey])

  // Collections : lues à l'ouverture, quand le compte change et quand la fenêtre revient au premier
  // plan (le processus principal ne relit le fichier que s'il a changé)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      try {
        window.essaim.getSteamCollections().then(
          (c) => alive && setCols(c),
          () => {}
        )
      } catch {
        /* pont pas encore prêt */
      }
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.removeEventListener('focus', load)
    }
  }, [steamId])

  // Échap sur un autre onglet : retour à la bibliothèque
  useEffect(() => {
    if (tab === 'library') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"], .ctxmenu')) return
      e.preventDefault()
      setTab('library')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab])

  // la ligne du jeu ouvert reste visible dans la liste
  useEffect(() => {
    if (selectedId) listRef.current?.querySelector<HTMLElement>('.stv-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const toggleGroup = useCallback((id: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      storeCollapsed(next)
      return next
    })
  }, [])

  const now = Date.now()

  // ---- jeux par appid, cachés, collections ----
  const byAppid = useMemo(() => {
    const m = new Map<number, Game>()
    for (const g of games) {
      const id = appidOf(g)
      if (id !== null) m.set(id, g)
    }
    return m
  }, [games])
  const hiddenIds = useMemo(() => new Set(cols?.hidden ?? []), [cols])
  const isHidden = useCallback((g: Game) => hiddenIds.has(appidOf(g) ?? -1), [hiddenIds])
  const pick = useCallback(
    (ids: number[]): Game[] => {
      const out: Game[] = []
      for (const id of ids) {
        const g = byAppid.get(id)
        if (g && !hiddenIds.has(id)) out.push(g)
      }
      return out
    },
    [byAppid, hiddenIds]
  )
  const byName = useCallback((a: Game, b: Game) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }), [])
  const favorites = useMemo(() => pick(cols?.favorites ?? []).sort(byName), [pick, cols, byName])
  const collections = useMemo(
    () => (cols?.collections ?? []).map((c) => ({ id: c.id, name: c.name, games: pick(c.appids).sort(byName) })),
    [cols, pick, byName]
  )

  // ---- liste de gauche : groupes filtrés ----
  const query = fold(search.trim())
  const groups = useMemo<Group[]>(() => {
    const pass = (g: Game): boolean =>
      (filter === 'all' || (filter === 'installed' ? onThisPc(g) : !onThisPc(g))) && (!query || fold(g.name).includes(query))
    const inSome = new Set<string>()
    for (const g of favorites) inSome.add(g.id)
    for (const c of collections) for (const g of c.games) inSome.add(g.id)
    const hasCols = favorites.length > 0 || collections.length > 0
    const list: Group[] = []
    if (favorites.length) list.push({ id: 'favorites', name: t('steam.list.favorites'), games: favorites.filter(pass) })
    for (const c of collections) list.push({ id: `uc:${c.id}`, name: c.name, games: c.games.filter(pass) })
    list.push({
      id: 'uncategorized',
      name: hasCols ? t('steam.list.uncategorized') : t('steam.home.allGames'),
      games: games.filter((g) => !inSome.has(g.id) && !isHidden(g) && pass(g)).sort(byName)
    })
    list.push({ id: 'hidden', name: t('steam.list.hidden'), games: games.filter((g) => isHidden(g) && pass(g)).sort(byName) })
    return list.filter((gr) => gr.games.length > 0)
  }, [games, favorites, collections, filter, query, isHidden, byName, t])
  const shownCount = useMemo(() => new Set(groups.flatMap((g) => g.games.map((x) => x.id))).size, [groups])

  // ---- accueil ----
  const visibleGames = useMemo(() => games.filter((g) => !isHidden(g)), [games, isHidden])
  const recent = useMemo(() => {
    const running = (g: Game): number => library.running[g.id] ?? 0
    return visibleGames
      .filter((g) => running(g) || gameLastPlayedAt(g))
      .sort((a, b) => running(b) - running(a) || (gameLastPlayedAt(b) ?? 0) - (gameLastPlayedAt(a) ?? 0))
      .slice(0, RECENT_MAX)
  }, [visibleGames, library.running])
  const installed = useMemo(() => visibleGames.filter(onThisPc).sort(byName), [visibleGames, byName])

  // ---- téléchargements des jeux Steam ----
  const dls = useMemo(() => {
    const ids = new Map(games.map((g) => [g.id, g]))
    return Object.values(downloads)
      .filter((d) => ids.has(d.gameId))
      .sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase])
      .map((d) => ({ d, game: ids.get(d.gameId)! }))
  }, [downloads, games])
  const active = dls[0] ?? null

  const openGame = useCallback(
    (g: Game) => {
      setTab('library')
      onOpen(g)
    },
    [onOpen]
  )

  // Liste : flèches haut / bas pour passer d'une ligne à l'autre (Accueil compris)
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('.stv-home-entry, .stv-row')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (i === -1) return
    e.preventDefault()
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  // ---- rendu ----
  const home = (
    <div className="stv-home" data-testid="steam-home" aria-label={t('steam.home.aria')}>
      {!games.length ? (
        <div className="empty">
          <span className="cap">{t('steam.home.cap')}</span>
          <h2>{t('steam.home.emptyTitle')}</h2>
          <p>{t('steam.home.emptyText')}</p>
          <button type="button" className="btn btn-line" onClick={() => onOpenLaunchers()}>
            <Blocks />
            {t('steam.home.emptyBtn')}
          </button>
        </div>
      ) : (
        <>
          {recent.length > 0 ? (
            <Shelf id="recent" title={t('steam.home.recent')} games={recent} library={library} now={now} recent onOpen={openGame} />
          ) : (
            <section className="stv-shelf" data-testid="steam-shelf" data-shelf="recent">
              <header className="stv-sh">
                <h3 className="cap">{t('steam.home.recent')}</h3>
                <span className="rule" />
              </header>
              <p className="stv-quiet">{t('steam.home.noRecent')}</p>
            </section>
          )}
          {dls.length > 0 && (
            <section className="stv-shelf stv-dls" data-testid="steam-home-downloads">
              <header className="stv-sh">
                <h3 className="cap">{t('steam.home.downloads')}</h3>
                <span className="rule" />
              </header>
              <div className="stv-dl-list">
                {dls.map(({ d, game }) => (
                  <button key={d.gameId} type="button" className={`stv-dl-item ph-${d.phase}`} title={t('steam.dl.openTitle', { name: game.name })} onClick={() => openGame(game)}>
                    <RowIcon game={game} />
                    <span className="nm">{game.name}</span>
                    <span className="cap ph">{downloadPhaseLabel(d)}</span>
                    <LiveBar value={downloadFraction(d)} mode={downloadMode(d)} className="stv-dl-bar" label={downloadPhaseLabel(d)} />
                    <span className="pct">{formatPercent(downloadFraction(d))}</span>
                    <span className="spd">{d.phase === 'downloading' && d.speed > 0 ? formatSpeed(d.speed) : ''}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {favorites.length > 0 && <Shelf id="favorites" title={t('steam.list.favorites')} games={favorites} library={library} now={now} onOpen={openGame} />}
          {collections
            .filter((c) => c.games.length > 0)
            .map((c) => (
              <Shelf key={c.id} id={`uc:${c.id}`} title={c.name} games={c.games} library={library} now={now} onOpen={openGame} />
            ))}
          {installed.length > 0 && <Shelf id="installed" title={t('steam.home.installed')} games={installed} library={library} now={now} onOpen={openGame} />}
          {!favorites.length && !collections.length && <p className="stv-quiet foot">{t('steam.home.collectionsHint')}</p>}
        </>
      )}
    </div>
  )

  return (
    <div className="stv" data-testid="steam-view" data-tab={tab}>
      {/* ---- barre du haut, comme celle du client Steam ---- */}
      <header className="stv-top" data-testid="steam-topbar">
        <span className="stv-brand" aria-hidden="true">
          <PlatformLogo platform="steam" />
        </span>
        <nav className="stv-tabs" role="tablist" aria-label={t('steam.top.aria')}>
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`stv-tab${tab === id ? ' on' : ''}`}
              data-testid={`steam-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {t(`steam.tab.${id}`)}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {steam?.personaName && (
          <button
            type="button"
            className={`stv-me${tab === 'profile' ? ' on' : ''}`}
            data-testid="steam-persona"
            title={t('steam.top.persona', { name: steam.personaName })}
            onClick={() => setTab('profile')}
          >
            {steam.avatarUrl ? (
              <img className="av" src={steam.avatarUrl} alt="" draggable={false} />
            ) : (
              <span className="av none">
                <UserRound />
              </span>
            )}
            <span className="nm">{steam.personaName}</span>
          </button>
        )}
      </header>

      {tab === 'library' ? (
        <div className="stv-body">
          {/* ---- liste des jeux ---- */}
          <aside className="stv-list" data-testid="steam-list" aria-label={t('steam.list.aria')} onKeyDown={onListKey}>
            <button
              type="button"
              className={`stv-home-entry${selectedId ? '' : ' on'}`}
              data-testid="steam-list-home"
              aria-current={selectedId ? undefined : 'page'}
              title={t('steam.list.home')}
              onClick={onHome}
            >
              <House />
              <span className="nm">{t('steam.list.home')}</span>
            </button>
            <div className="stv-tools">
              <SearchBox value={search} onChange={setSearch} placeholder={t('steam.list.search')} testId="steam-search" />
              <div className="seg sm stv-filter" role="radiogroup" aria-label={t('steam.list.filterAria')}>
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={filter === f}
                    className={filter === f ? 'on' : undefined}
                    title={t(`steam.list.filter.${f}Title`)}
                    data-testid={`steam-filter-${f}`}
                    onClick={() => setFilter(f)}
                  >
                    {t(`steam.list.filter.${f}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="stv-groups" ref={listRef}>
              {groups.map((gr) => {
                const closed = collapsed.has(gr.id) && !query
                return (
                  <div key={gr.id} className="stv-group" data-group={gr.id}>
                    <button
                      type="button"
                      className={`stv-gh${closed ? ' closed' : ''}`}
                      aria-expanded={!closed}
                      title={t(closed ? 'steam.list.expand' : 'steam.list.collapse', { name: gr.name })}
                      data-testid="steam-group"
                      onClick={() => toggleGroup(gr.id)}
                    >
                      <ChevronDown />
                      <span className="cap nm">{gr.name}</span>
                    </button>
                    {!closed &&
                      gr.games.map((g) => (
                        <Row
                          key={g.id}
                          game={g}
                          state={gameState(g, library)}
                          selected={selectedId === g.id}
                          download={downloads[g.id] ?? null}
                          onOpen={openGame}
                          onPlay={onPlay}
                          onInstall={onInstall}
                          onMenu={onMenu}
                        />
                      ))}
                  </div>
                )
              })}
              {!shownCount && (
                <p className="stv-quiet">
                  {query ? (
                    <>
                      {t('steam.list.noMatch')} <q>{search.trim()}</q>.
                    </>
                  ) : (
                    t('steam.list.none')
                  )}
                </p>
              )}
              {!!cols?.dynamicCount && <p className="stv-quiet sm">{tn('steam.list.dynamic', cols.dynamicCount)}</p>}
            </div>
          </aside>

          {/* ---- accueil ou page du jeu ---- */}
          <section className="stv-pane">{detail ?? home}</section>
        </div>
      ) : tab === 'profile' ? (
        <div className="stv-profile">
          <ProfileView platforms={platforms} owned={byAppid} active onOpenGame={openGame} onOpenLaunchers={onOpenLaunchers} />
        </div>
      ) : null}
      {(communitySeen || tab === 'community') && (
        <div className="stv-community" hidden={tab !== 'community'}>
          <CommunityView active={tab === 'community'} games={games} onOpenLaunchers={onOpenLaunchers} />
        </div>
      )}
      {(storeSeen || tab === 'store') && (
        <div className="stv-store" hidden={tab !== 'store'}>
          <StoreView active={tab === 'store'} owned={byAppid} library={library} onPlay={onPlay} onInstall={onInstall} onOpenGame={openGame} />
        </div>
      )}

      {/* ---- barre des téléchargements, comme en bas du client Steam ---- */}
      <button
        type="button"
        className={`stv-dlbar${active ? ' on' : ''}`}
        data-testid="steam-downloads-bar"
        aria-label={t('steam.dl.aria')}
        title={active ? t('steam.dl.openTitle', { name: active.game.name }) : undefined}
        disabled={!active}
        onClick={() => active && openGame(active.game)}
      >
        <ArrowDownToLine className="lead" />
        <span className="cap k">{t('steam.dl.cap')}</span>
        {active ? (
          <>
            <span className="txt">
              <span className="ph">{downloadPhaseLabel(active.d)}</span> <span className="nm">{active.game.name}</span>
            </span>
            <LiveBar value={downloadFraction(active.d)} mode={downloadMode(active.d)} className="stv-dlbar-bar" label={downloadPhaseLabel(active.d)} />
            <span className="pct">{formatPercent(downloadFraction(active.d))}</span>
            {active.d.phase === 'downloading' && active.d.speed > 0 && <span className="spd">{formatSpeed(active.d.speed)}</span>}
            {dls.length > 1 && <span className="cap more">{tn('steam.dl.more', dls.length - 1)}</span>}
          </>
        ) : (
          <span className="txt idle">{t('steam.dl.idle')}</span>
        )}
      </button>
    </div>
  )
}
