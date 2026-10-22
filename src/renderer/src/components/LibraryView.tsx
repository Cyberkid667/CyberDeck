import { Blocks, Download, FolderInput, FolderOpen, Gamepad2, LoaderCircle, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { gameLastPlayedAt, gamePlayTimeSeconds } from '../../../shared/platforms'
import type { ActionResult, Game, LibraryState, PlatformsState } from '../../../shared/types'
import { errorText, formatClock, formatClockText, formatDay, formatPlayTime, formatWhen } from '../format'
import { barcodeCSS } from '../fx/barcode'
import { useCanvasHold } from '../fx/loop'
import { HERO_MATRIX_FILTER } from '../fx/pixelMatrix'
import {
  canPlayState,
  gameFolder,
  gamesWord,
  gameState,
  inFilter,
  inShow,
  onThisPc,
  platformName,
  playLabel,
  sortGames,
  type GameState,
  type LibraryFilter,
  type LibraryShow
} from '../platformUi'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Cover, coverSrc, ExeIcon } from './Cover'
import { Dust } from './Dust'
import { GameCard } from './GameCard'
import { ImportDialog } from './ImportDialog'
import { PixelMatrix } from './PixelMatrix'
import { PlatformTag } from './PlatformTag'
import { RemoveGameDialog } from './RemoveGameDialog'
import type { ToastOptions } from './Toasts'
import { SearchBox, ViewTitle } from './Toolbar'

// Bibliothèque (SPEC 5.10) : barre d'outils (Ajouter un jeu, Importer un dossier,
// tri « Joués récemment | Nom », recherche ; libellés toujours visibles jusqu'à 960 px),
// bandeau « dernière partie » (jeu lancé, sinon en train de démarrer, sinon dernier
// joué, sinon dernier ajouté ; masqué pendant une recherche), titre de section (avec la
// bascule compacte « Installés | Tous » quand un compte Steam est relié), grille de
// cartes-billets, menu d'un jeu, bibliothèque vide et recherche sans résultat. Le filtre
// de plateforme et la fenêtre « Plateformes » sont dans la barre latérale. Sous 760 px de
// haut, le bandeau tient sur une ligne de 64 px (CSS).

interface Props {
  library: LibraryState
  platforms: PlatformsState | null
  /** filtre de la barre latérale : tous les jeux ou une plateforme */
  filter: LibraryFilter
  /** vue choisie (« Installés » si la bascule n'est pas proposée) */
  show: LibraryShow
  /** la bascule « Installés | Tous » est proposée (compte Steam relié) */
  canShowAll: boolean
  /** client torrent activé (Réglages) : sinon la bibliothèque vide ne parle pas de torrents */
  torrentsEnabled: boolean
  onShow: (show: LibraryShow) => void
  onFilter: (filter: LibraryFilter) => void
  onAdd: () => void
  onEdit: (game: Game) => void
  onOpenPlatforms: () => void
  onToast: (level: 'info' | 'success' | 'error', message: string, opts?: ToastOptions) => void
}

type SortMode = 'recent' | 'name'

const SORT_LABEL: Record<SortMode, string> = { recent: 'Joués récemment', name: 'Nom' }
const SORTS: SortMode[] = ['recent', 'name']
const SHOWS: LibraryShow[] = ['installed', 'owned']
const SHOW_LABEL: Record<LibraryShow, string> = { installed: 'Installés', owned: 'Tous' }
const SHOW_TITLE: Record<LibraryShow, string> = {
  installed: 'Jeux installés sur ce PC',
  owned: 'Tous tes jeux : installés, et possédés sur Steam sans être installés'
}

/** Recherche sans accents ni casse : « pokemon » trouve « Pokémon ». */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')

const startOfDay = (t: number): number => new Date(t).setHours(0, 0, 0, 0)

/**
 * Jeu du bandeau, parmi les jeux affichés : le jeu lancé (le plus récent s'il y en a
 * plusieurs), sinon celui qui démarre, sinon le dernier joué (CyberDeck ou plateforme),
 * sinon le dernier ajouté qui est sur ce PC.
 */
function pickHero(games: Game[], lib: LibraryState): Game | null {
  if (!games.length) return null
  const launching = lib.launching ?? {}
  let best: Game | null = null
  for (const g of games) if (lib.running[g.id] !== undefined && (!best || lib.running[g.id] > lib.running[best.id])) best = g
  if (best) return best
  for (const g of games) if (launching[g.id] !== undefined && (!best || launching[g.id] > launching[best.id])) best = g
  if (best) return best
  let bestAt = 0
  for (const g of games) {
    const t = gameLastPlayedAt(g) ?? 0
    if (t > bestAt) {
      best = g
      bestAt = t
    }
  }
  if (best) return best
  for (const g of games) if (onThisPc(g) && (!best || g.addedAt > best.addedAt)) best = g
  return best
}

/**
 * Nouveau rendu à chaque changement de seconde du chrono de session (calé sur
 * l'heure de lancement), seulement quand un jeu tourne : le bandeau et la carte
 * du jeu lancé lisent la même heure, ils ne se décalent jamais.
 */
function useSessionTick(origin: number | null): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (origin === null) return
    let timer = 0
    const schedule = (): void => {
      const wait = 1000 - ((((Date.now() - origin) % 1000) + 1000) % 1000) + 8
      timer = window.setTimeout(() => {
        setTick((n) => n + 1)
        schedule()
      }, wait)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [origin])
}

// ---------- Bandeau « dernière partie » ----------

interface HeroProps {
  game: Game
  state: GameState
  /** heure de début si le jeu tourne */
  startedAt: number | null
  /** heure du clic si le jeu démarre par sa plateforme */
  launchedAt: number | null
  now: number
  onPlay: (game: Game) => void
  onInstall: (game: Game) => void
  onEdit: (game: Game) => void
}

function Hero({ game: g, state, startedAt, launchedAt, now, onPlay, onInstall, onEdit }: HeroProps): React.JSX.Element {
  const src = coverSrc(g)
  const live = state === 'running'
  const absent = state === 'installable' || state === 'absent' || state === 'downloading'
  const viaName = g.platform === 'local' ? null : platformName(g.platform)
  const session = startedAt !== null ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  const [h, m, s] = formatClock(session)
  const barcode = useMemo(() => barcodeCSS(g.id, 72), [g.id])
  const lastPlayed = gameLastPlayedAt(g)
  const label = live || state === 'launching' || lastPlayed ? 'Dernière partie' : 'Dernier ajout'
  // (la plateforme est sur l'étiquette au bout de la légende : pas de « via Steam » ici)
  const when =
    (startedAt !== null
      ? `Lancé ${formatWhen(startedAt, now)}`
      : state === 'launching' && launchedAt !== null
        ? `Lancé ${formatWhen(launchedAt, now)} · en attente du jeu`
        : lastPlayed
          ? `Joué ${formatWhen(lastPlayed, now)}`
          : `Ajouté ${formatWhen(g.addedAt, now)}`) + (state === 'updating' && viaName ? ` · mise à jour par ${viaName}` : '')
  const folder = gameFolder(g)
  const path = absent ? (viaName ? `Pas installé sur ce PC · ${viaName}` : 'Pas installé sur ce PC') : (folder ?? '')

  let main: React.ReactNode
  if (live)
    main = (
      <span className="live-chip" role="status" title={`${g.name} est en cours`}>
        <span className="live-dot" />
        En jeu
      </span>
    )
  else if (state === 'launching' || state === 'downloading')
    main = (
      <span
        className="live-chip busy"
        role="status"
        title={state === 'launching' ? `${viaName ?? 'Le lanceur'} démarre le jeu` : `${viaName ?? 'La plateforme'} installe le jeu`}
      >
        <LoaderCircle className="spin" />
        {state === 'launching' ? 'Démarrage…' : 'Téléchargement…'}
      </span>
    )
  else if (state === 'installable')
    main = (
      <button
        type="button"
        className="btn btn-line"
        data-testid="btn-hero-install"
        title={`Ouvrir l’installation de ${g.name} dans Steam`}
        onClick={() => onInstall(g)}
      >
        <Download />
        Installer
      </button>
    )
  else if (state === 'absent')
    main = (
      <span className="live-chip quiet" role="status">
        Non installé
      </span>
    )
  else
    main = (
      <button
        type="button"
        className="btn btn-primary"
        data-testid="btn-hero-play"
        title={viaName ? `Jouer à ${g.name} via ${viaName}` : `Jouer à ${g.name}`}
        onClick={() => onPlay(g)}
      >
        <Play className="fill" />
        Jouer
      </button>
    )

  return (
    <section
      className={`hero${live ? ' live' : ''}${absent ? ' absent' : ''}`}
      data-testid="library-hero"
      data-state={state}
      aria-label={label}
    >
      {src && <PixelMatrix className="hero-px" src={src} cell={6} filter={HERO_MATRIX_FILTER} focus={0.35} />}
      <div className="hero-topo" />
      <div className="hero-shade" />
      <Dust className="hero-dust" count={56} bias={0.45} />
      <div className="hero-frame brackets" />
      <div className="hero-body">
        {src ? (
          <img className="hero-mini" src={src} alt="" decoding="async" draggable={false} />
        ) : (
          <span className="hero-mini ph" aria-hidden="true">
            <ExeIcon game={g} className="mico" />
          </span>
        )}
        <div className="hero-headline">
          <div className="hero-cap">
            <span className="cap">02.1 · {label}</span>
            <span className="cap sep">—</span>
            <span className="cap when" title={when}>
              {when}
            </span>
            <PlatformTag platform={g.platform} />
          </div>
          <h2 className="hero-title" title={g.name}>
            <span className="nmx">{g.name}</span>
            <span className="lead" aria-hidden="true" />
          </h2>
        </div>
        <div className="hero-path" title={path}>
          <span className="gt">&gt;</span>
          {path}
        </div>
        <div className="hero-low">
          <div className="hero-actions">
            {main}
            {!absent && (
              <button
                type="button"
                className="btn btn-line"
                title="Ouvrir le dossier du jeu"
                aria-label="Ouvrir le dossier"
                disabled={!folder}
                onClick={() => window.essaim.openGameFolder(g.id)}
              >
                <FolderOpen />
                <span className="lbl">Ouvrir le dossier</span>
              </button>
            )}
            <button
              type="button"
              className="btn"
              title={viaName ? `Modifier le nom ou la jaquette (le jeu se lance par ${viaName})` : 'Modifier le nom, le programme ou la jaquette'}
              aria-label="Modifier…"
              onClick={() => onEdit(g)}
            >
              <Pencil />
              <span className="lbl">Modifier…</span>
            </button>
          </div>
          <div className="hero-specs">
            <div>
              <span className="cap">Temps de jeu</span>
              <span className="v">{formatPlayTime(gamePlayTimeSeconds(g) + session)}</span>
            </div>
            <div>
              <span className="cap">Ajouté le</span>
              <span className="v">{formatDay(g.addedAt)}</span>
            </div>
          </div>
          {live && (
            <div className="hero-timer" role="timer" aria-label={`Session en cours : ${h}:${m}:${s}`}>
              <span className="cap">Session en cours</span>
              <span className="t">
                {h}:{m}
                <span className="s">:{s}</span>
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="hero-ticket" aria-hidden="true">
        <Cover game={g} compact />
        <div className="stub">
          <span className="bc" style={{ backgroundImage: barcode }} />
        </div>
      </div>
    </section>
  )
}

// ---------- Vue ----------

export function LibraryView({
  library,
  platforms,
  filter,
  show,
  canShowAll,
  torrentsEnabled,
  onShow,
  onFilter,
  onAdd,
  onEdit,
  onOpenPlatforms,
  onToast
}: Props): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState<Game | null>(null)
  const launching = useRef(new Map<string, number>())
  const installing = useRef(new Map<string, number>())
  const toolbarRef = useRef<HTMLDivElement>(null)
  const libRef = useRef<HTMLDivElement>(null)

  // Autre plateforme ou autre vue : on repart du haut (bandeau compris)
  useEffect(() => {
    libRef.current?.scrollTo({ top: 0 })
  }, [filter, show])

  // Dernières props, pour des rappels stables : les cartes mémoïsées ne se
  // redessinent pas à chaque rendu de l'app (une fois par seconde).
  const latest = useRef({ library, onEdit, onToast })
  useLayoutEffect(() => {
    latest.current = { library, onEdit, onToast }
  })

  // Les canevas de l'arrière-plan (poussière du bandeau, oscilloscope…) restent figés
  // sous le menu d'un jeu et sous les dialogues propres à la bibliothèque.
  useCanvasHold(!!menu)
  useCanvasHold(importing || !!removing)

  const syncing = !!platforms?.syncing
  const query = search.trim()
  const launchingMap = library.launching ?? {}

  // Jeux de la vue choisie (Installés / Tous), puis du filtre de la barre latérale.
  const viewGames = useMemo(() => library.games.filter((g) => inShow(g, show)), [library.games, show])
  const listGames = useMemo(() => viewGames.filter((g) => inFilter(g, filter)), [viewGames, filter])
  // Rien à montrer dans aucune vue proposée : bibliothèque vide.
  const noGames = useMemo(
    () => !library.games.some((g) => inShow(g, canShowAll ? 'owned' : 'installed')),
    [library.games, canShowAll]
  )
  const total = listGames.length

  // Bibliothèque vidée pendant une recherche : la recherche (désactivée) repart à zéro.
  useEffect(() => {
    if (noGames) setSearch('')
  }, [noGames])

  const games = useMemo(() => {
    const k = fold(query)
    const list = k ? listGames.filter((g) => fold(g.name).includes(k)) : [...listGames]
    return sortGames(list, sort)
  }, [listGames, query, sort])

  const hero = useMemo(() => pickHero(listGames, library), [listGames, library])
  const heroState = hero ? gameState(hero, library) : 'ready'
  const heroStart = hero ? (library.running[hero.id] ?? null) : null
  const heroLaunch = hero ? (launchingMap[hero.id] ?? null) : null
  const firstStart = Object.values(library.running)[0] ?? null
  useSessionTick(heroStart ?? firstStart)
  const now = Date.now()
  const today = startOfDay(now)

  const play = useCallback((g: Game) => {
    const { library: lib, onToast: toast } = latest.current
    if (lib.running[g.id] !== undefined || lib.launching?.[g.id] !== undefined) return
    // double-clic + clic, Entrée répétée : un seul lancement en attendant que le jeu soit vu comme lancé
    const last = launching.current.get(g.id) ?? 0
    if (Date.now() - last < 1500) return
    launching.current.set(g.id, Date.now())
    window.essaim.playGame(g.id)
    toast('info', g.platform === 'local' ? 'Lancement du jeu…' : `Lancement via ${platformName(g.platform)}…`, { detail: g.name })
  }, [])
  const install = useCallback(async (g: Game) => {
    const { onToast: toast } = latest.current
    const last = installing.current.get(g.id) ?? 0
    if (Date.now() - last < 2000) return
    installing.current.set(g.id, Date.now())
    let res: ActionResult
    try {
      res = await window.essaim.installGame(g.id)
    } catch (err) {
      res = { ok: false, error: errorText(err) }
    }
    if (res.ok) toast('info', 'Steam ouvre sa fenêtre d’installation.', { detail: g.name })
    else toast('error', res.error ?? 'Installation impossible.', { detail: g.name })
  }, [])
  const edit = useCallback((g: Game) => latest.current.onEdit(g), [])
  const openMenu = useCallback((g: Game, x: number, y: number) => setMenu({ x, y, id: g.id }), [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const removeNow = (g: Game): void => {
    window.essaim.removeGame(g.id)
    onToast(
      'info',
      g.platform === 'local'
        ? 'Retiré de la bibliothèque. Le jeu reste installé.'
        : g.installed
          ? `Retiré de la bibliothèque. Le jeu reste installé dans ${platformName(g.platform)}.`
          : 'Retiré de la bibliothèque.',
      { detail: g.name }
    )
  }

  const menuGame = menu ? library.games.find((g) => g.id === menu.id) : undefined
  const menuItems = (g: Game): (MenuItem | 'sep')[] => {
    const s = gameState(g, library)
    const items: (MenuItem | 'sep')[] = []
    if (s === 'installable') items.push({ label: 'Installer via Steam', icon: <Download />, onClick: () => void install(g) })
    else if (s !== 'absent' && s !== 'downloading') items.push({ label: playLabel(g), icon: <Play />, disabled: !canPlayState(s), onClick: () => play(g) })
    if (g.platform === 'local' || onThisPc(g))
      items.push({ label: 'Ouvrir le dossier', icon: <FolderOpen />, disabled: !gameFolder(g), onClick: () => window.essaim.openGameFolder(g.id) })
    items.push({ label: 'Modifier…', icon: <Pencil />, onClick: () => onEdit(g) })
    items.push('sep')
    items.push({
      label: g.platform === 'local' ? 'Retirer de la bibliothèque' : 'Retirer de la bibliothèque…',
      icon: <Trash2 />,
      danger: true,
      onClick: () => (g.platform === 'local' ? removeNow(g) : setRemoving(g))
    })
    return items
  }

  // Bascules segmentées : flèches pour passer d'un choix à l'autre (radiogroup)
  const segKeys =
    <T,>(list: T[], current: T, set: (v: T) => void) =>
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const i = list.indexOf(current)
      const next =
        e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + list.length) % list.length
      set(list[next])
      e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
    }

  // Grille : flèches pour passer d'une carte à l'autre (haut / bas = rangée voisine), Début / Fin
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const card = e.target as HTMLElement
    if (!card.classList.contains('gcard') || e.altKey || e.ctrlKey || e.metaKey) return
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('.gcard')]
    const i = cards.indexOf(card)
    const cols = Math.max(1, getComputedStyle(e.currentTarget).gridTemplateColumns.split(' ').length)
    const target: Record<string, number> = {
      ArrowLeft: i - 1,
      ArrowRight: i + 1,
      ArrowUp: i - cols,
      ArrowDown: i + cols,
      Home: 0,
      End: cards.length - 1
    }
    let j = target[e.key]
    if (j === undefined || i === -1) return
    e.preventDefault()
    // flèche bas depuis l'avant-dernière rangée vers une dernière rangée incomplète : dernière carte
    if (e.key === 'ArrowDown' && j >= cards.length && Math.floor(i / cols) < Math.floor((cards.length - 1) / cols)) j = cards.length - 1
    if (j >= 0 && j < cards.length && j !== i) cards[j].focus()
  }

  const title = filter === 'all' ? 'Mes jeux' : platformName(filter)
  const absentCount = show === 'owned' ? listGames.filter((g) => !onThisPc(g)).length : 0
  // filtre de plateforme vide dans « Installés » alors que la plateforme a des jeux possédés
  const ownedElsewhere =
    canShowAll && show === 'installed' && filter !== 'all' && library.games.some((g) => g.platform === filter && inShow(g, 'owned'))

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="Actions de la bibliothèque" ref={toolbarRef}>
        <ViewTitle cap="02 · Bibliothèque" title={title} count={total} />
        <button
          type="button"
          className="btn btn-primary"
          data-testid="btn-add-game"
          title="Ajouter un jeu déjà installé"
          onClick={onAdd}
        >
          <Plus />
          Ajouter un jeu
        </button>
        <button
          type="button"
          className="btn"
          data-testid="btn-import-folder"
          title="Importer un dossier de jeux"
          aria-label="Importer un dossier"
          onClick={() => setImporting(true)}
        >
          <FolderInput />
          <span className="lbl">Importer un dossier</span>
        </button>
        <div className="tsep" />
        <div className={`seg${noGames ? ' dis' : ''}`} role="radiogroup" aria-label="Tri" onKeyDown={segKeys(SORTS, sort, setSort)}>
          {SORTS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={sort === s}
              tabIndex={sort === s ? 0 : -1}
              className={sort === s ? 'on' : undefined}
              data-testid={`library-sort-${s}`}
              disabled={noGames}
              onClick={() => setSort(s)}
            >
              {SORT_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <SearchBox value={search} onChange={setSearch} placeholder="Rechercher un jeu" testId="library-search" disabled={noGames} />
      </div>

      <div className="lib" ref={libRef}>
        {noGames ? (
          <div className="empty">
            <Dust className="dust" count={40} bias={0} />
            <div className="ghost-ticket" aria-hidden="true">
              <div className="c">
                <Gamepad2 />
              </div>
              <div className="s" />
            </div>
            <span className="cap">02 · Bibliothèque vide</span>
            <h2>Ta bibliothèque est vide</h2>
            {torrentsEnabled ? (
              <p>
                Quand un jeu a fini de se télécharger, clique sur « Installer » dans la liste des torrents.
                <br />
                Tu peux aussi ajouter les jeux déjà installés sur ton PC.
              </p>
            ) : (
              <p>Ajoute les jeux déjà installés sur ton PC : un par un, ou tout un dossier d’un coup.</p>
            )}
            <div className="row-btns">
              <button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>
                <FolderInput />
                Importer un dossier de jeux
              </button>
              <button type="button" className="btn btn-line" onClick={onAdd}>
                <Plus />
                Ajouter un jeu
              </button>
            </div>
            <div className="plat-note" aria-live="polite">
              {syncing ? (
                <>
                  <LoaderCircle className="spin" />
                  <span>Recherche des jeux de Steam, Epic Games, Xbox et des autres lanceurs…</span>
                </>
              ) : (
                <>
                  <span>Les jeux de Steam, Epic Games, Xbox et des autres lanceurs arrivent ici tout seuls.</span>
                  <button type="button" className="btn btn-sm" onClick={onOpenPlatforms}>
                    <Blocks />
                    Plateformes
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            {hero && !query && (
              <Hero
                game={hero}
                state={heroState}
                startedAt={heroStart}
                launchedAt={heroLaunch}
                now={now}
                onPlay={play}
                onInstall={install}
                onEdit={edit}
              />
            )}
            <div className="sect">
              <span className="cap">02.2 · {filter === 'all' ? 'Collection' : platformName(filter)}</span>
              <span className="cap">
                {query ? (
                  <>
                    <b>{games.length}</b> {gamesWord(games.length)} sur {total}
                  </>
                ) : (
                  <>
                    <b>{total}</b> {gamesWord(total)}
                    {absentCount > 0 && (
                      <>
                        {' '}
                        · <b>{absentCount}</b> pas installé{absentCount > 1 ? 's' : ''}
                      </>
                    )}
                  </>
                )}
              </span>
              <span className="rule" />
              {canShowAll && (
                // bascule compacte « Installés | Tous » (compte Steam relié) : au bout du filet, avant le tri
                <div
                  className="seg sm"
                  role="radiogroup"
                  aria-label="Jeux affichés"
                  data-testid="library-installed-switch"
                  onKeyDown={segKeys(SHOWS, show, onShow)}
                >
                  {SHOWS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={show === s}
                      tabIndex={show === s ? 0 : -1}
                      className={show === s ? 'on' : undefined}
                      title={SHOW_TITLE[s]}
                      data-testid={`library-show-${s}`}
                      onClick={() => onShow(s)}
                    >
                      {SHOW_LABEL[s]}
                    </button>
                  ))}
                </div>
              )}
              <span className="cap">Tri · {SORT_LABEL[sort].toLocaleLowerCase('fr')}</span>
            </div>
            {games.length ? (
              <div className="ggrid" onKeyDown={onGridKey}>
                {games.map((g) => {
                  const state = gameState(g, library)
                  const started = library.running[g.id]
                  return (
                    <GameCard
                      key={g.id}
                      game={g}
                      state={state}
                      session={state === 'running' ? formatClockText((now - started) / 1000) : null}
                      today={today}
                      menuOpen={menu?.id === g.id}
                      onPlay={play}
                      onInstall={install}
                      onMenu={openMenu}
                    />
                  )
                })}
              </div>
            ) : query ? (
              <div className="noresult">
                <span>
                  Aucun jeu ne correspond à <q>{query}</q>.
                </span>
                <button
                  type="button"
                  className="btn btn-line btn-sm"
                  onClick={() => {
                    setSearch('')
                    toolbarRef.current?.querySelector<HTMLInputElement>('.search input')?.focus()
                  }}
                >
                  <X />
                  Effacer la recherche
                </button>
              </div>
            ) : (
              <div className="noresult">
                <span>
                  {filter === 'all'
                    ? 'Aucun jeu installé pour l’instant.'
                    : `Aucun jeu ${platformName(filter)} ${show === 'installed' ? 'installé ' : ''}pour l’instant.`}
                </span>
                {ownedElsewhere || (filter === 'all' && canShowAll && show === 'installed') ? (
                  <button type="button" className="btn btn-line btn-sm" onClick={() => onShow('owned')}>
                    Voir aussi les jeux pas installés
                  </button>
                ) : filter !== 'all' ? (
                  <button type="button" className="btn btn-line btn-sm" onClick={() => onFilter('all')}>
                    Voir tous les jeux
                  </button>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {menu && menuGame && <ContextMenu key={`${menu.id},${menu.x},${menu.y}`} x={menu.x} y={menu.y} items={menuItems(menuGame)} onClose={closeMenu} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onToast={onToast} />}
      {removing && (
        <RemoveGameDialog
          game={removing}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            removeNow(removing)
            setRemoving(null)
          }}
        />
      )}
    </>
  )
}
