import { Blocks, Download, FolderInput, FolderOpen, Gamepad2, LoaderCircle, PackageX, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { gameLastPlayedAt, gamePlayTimeSeconds } from '../../../shared/platforms'
import type { ActionResult, Game, LibraryState, PlatformsState } from '../../../shared/types'
import { errorText, formatClock, formatClockText, formatDay, formatPlayTime, formatWhen } from '../format'
import { barcodeCSS } from '../fx/barcode'
import { useCanvasHold } from '../fx/loop'
import { HERO_MATRIX_FILTER } from '../fx/pixelMatrix'
import { useT } from '../i18n'
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
import { UninstallDialog } from './UninstallDialog'
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

// clés des libellés (traduits au rendu)
const SORT_LABEL: Record<SortMode, string> = { recent: 'library.view.sortRecent', name: 'library.view.sortName' }
const SORTS: SortMode[] = ['recent', 'name']
const SHOWS: LibraryShow[] = ['installed', 'owned']
const SHOW_LABEL: Record<LibraryShow, string> = { installed: 'library.view.showInstalled', owned: 'library.view.showOwned' }
const SHOW_TITLE: Record<LibraryShow, string> = {
  installed: 'library.view.showInstalledTitle',
  owned: 'library.view.showOwnedTitle'
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
  const { t } = useT()
  const src = coverSrc(g)
  const live = state === 'running'
  const absent = state === 'installable' || state === 'absent' || state === 'downloading'
  const viaName = g.platform === 'local' ? null : platformName(g.platform)
  const session = startedAt !== null ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  const [h, m, s] = formatClock(session)
  const barcode = useMemo(() => barcodeCSS(g.id, 72), [g.id])
  const lastPlayed = gameLastPlayedAt(g)
  const label = live || state === 'launching' || lastPlayed ? t('library.hero.lastPlayed') : t('library.hero.lastAdded')
  // (la plateforme est sur l'étiquette au bout de la légende : pas de « via Steam » ici)
  const when =
    (startedAt !== null
      ? t('library.common.launched', { when: formatWhen(startedAt, now) })
      : state === 'launching' && launchedAt !== null
        ? t('library.hero.launchedWaiting', { when: formatWhen(launchedAt, now) })
        : lastPlayed
          ? t('library.hero.played', { when: formatWhen(lastPlayed, now) })
          : t('library.hero.added', { when: formatWhen(g.addedAt, now) })) +
    (state === 'updating' && viaName ? ` · ${t('library.hero.updatingBy', { platform: viaName })}` : '')
  const folder = gameFolder(g)
  const path = absent ? (viaName ? `${t('library.common.notInstalledHere')} · ${viaName}` : t('library.common.notInstalledHere')) : (folder ?? '')

  let main: React.ReactNode
  if (live)
    main = (
      <span className="live-chip" role="status" title={t('library.hero.runningTitle', { name: g.name })}>
        <span className="live-dot" />
        {t('library.state.running')}
      </span>
    )
  else if (state === 'launching' || state === 'downloading')
    main = (
      <span
        className="live-chip busy"
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
      </span>
    )
  else if (state === 'installable')
    main = (
      <button
        type="button"
        className="btn btn-line"
        data-testid="btn-hero-install"
        title={t('library.hero.installTitle', { name: g.name })}
        onClick={() => onInstall(g)}
      >
        <Download />
        {t('library.common.install')}
      </button>
    )
  else if (state === 'absent')
    main = (
      <span className="live-chip quiet" role="status">
        {t('library.state.notInstalled')}
      </span>
    )
  else
    main = (
      <button
        type="button"
        className="btn btn-primary"
        data-testid="btn-hero-play"
        title={viaName ? t('library.common.playGameVia', { name: g.name, platform: viaName }) : t('library.common.playGame', { name: g.name })}
        onClick={() => onPlay(g)}
      >
        <Play className="fill" />
        {t('library.common.play')}
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
            <span className="cap">{label}</span>
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
                title={t('library.hero.openFolderTitle')}
                aria-label={t('library.common.openFolder')}
                disabled={!folder}
                onClick={() => window.essaim.openGameFolder(g.id)}
              >
                <FolderOpen />
                <span className="lbl">{t('library.common.openFolder')}</span>
              </button>
            )}
            <button
              type="button"
              className="btn"
              title={viaName ? t('library.hero.editTitleVia', { platform: viaName }) : t('library.hero.editTitle')}
              aria-label={t('library.common.edit')}
              onClick={() => onEdit(g)}
            >
              <Pencil />
              <span className="lbl">{t('library.common.edit')}</span>
            </button>
          </div>
          <div className="hero-specs">
            <div>
              <span className="cap">{t('library.hero.playTime')}</span>
              <span className="v">{formatPlayTime(gamePlayTimeSeconds(g) + session)}</span>
            </div>
            <div>
              <span className="cap">{t('library.hero.addedOn')}</span>
              <span className="v">{formatDay(g.addedAt)}</span>
            </div>
          </div>
          {live && (
            <div className="hero-timer" role="timer" aria-label={t('library.hero.sessionAria', { time: `${h}:${m}:${s}` })}>
              <span className="cap">{t('library.hero.session')}</span>
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
  const { t, tn, locale } = useT()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState<Game | null>(null)
  const [uninstalling, setUninstalling] = useState<Game | null>(null)
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
    toast('info', g.platform === 'local' ? t('library.view.launchingGame') : t('library.view.launchingVia', { platform: platformName(g.platform) }), {
      detail: g.name
    })
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
    if (res.ok) toast('info', t('library.view.steamInstallOpening'), { detail: g.name })
    else toast('error', res.error ?? t('library.view.installFailed'), { detail: g.name })
  }, [])
  const edit = useCallback((g: Game) => latest.current.onEdit(g), [])
  const openMenu = useCallback((g: Game, x: number, y: number) => setMenu({ x, y, id: g.id }), [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const removeNow = (g: Game): void => {
    window.essaim.removeGame(g.id)
    onToast(
      'info',
      g.platform === 'local'
        ? t('library.view.removedLocal')
        : g.installed
          ? t('library.view.removedInstalled', { platform: platformName(g.platform) })
          : t('library.view.removed'),
      { detail: g.name }
    )
  }

  const menuGame = menu ? library.games.find((g) => g.id === menu.id) : undefined
  const menuItems = (g: Game): (MenuItem | 'sep')[] => {
    const s = gameState(g, library)
    const items: (MenuItem | 'sep')[] = []
    if (s === 'installable') items.push({ label: t('library.view.menuInstallSteam'), icon: <Download />, onClick: () => void install(g) })
    else if (s !== 'absent' && s !== 'downloading') items.push({ label: playLabel(g), icon: <Play />, disabled: !canPlayState(s), onClick: () => play(g) })
    if (g.platform === 'local' || onThisPc(g))
      items.push({ label: t('library.common.openFolder'), icon: <FolderOpen />, disabled: !gameFolder(g), onClick: () => window.essaim.openGameFolder(g.id) })
    items.push({ label: t('library.common.edit'), icon: <Pencil />, onClick: () => onEdit(g) })
    items.push('sep')
    if (g.installed && s !== 'downloading')
      items.push({ label: t('library.view.menuUninstall'), icon: <PackageX />, danger: true, disabled: s === 'running' || s === 'launching', onClick: () => setUninstalling(g) })
    items.push({
      label: g.platform === 'local' ? t('library.view.menuRemove') : t('library.view.menuRemoveAsk'),
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

  const title = filter === 'all' ? t('library.view.myGames') : platformName(filter)
  const absentCount = show === 'owned' ? listGames.filter((g) => !onThisPc(g)).length : 0
  // filtre de plateforme vide dans « Installés » alors que la plateforme a des jeux possédés
  const ownedElsewhere =
    canShowAll && show === 'installed' && filter !== 'all' && library.games.some((g) => g.platform === filter && inShow(g, 'owned'))

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label={t('library.view.toolbarAria')} ref={toolbarRef}>
        <ViewTitle cap={t('library.view.cap')} title={title} count={total} />
        <button
          type="button"
          className="btn btn-primary"
          data-testid="btn-add-game"
          title={t('library.view.addTitle')}
          onClick={onAdd}
        >
          <Plus />
          {t('library.view.add')}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="btn-import-folder"
          title={t('library.common.importFolder')}
          aria-label={t('library.view.importAria')}
          onClick={() => setImporting(true)}
        >
          <FolderInput />
          <span className="lbl">{t('library.view.importAria')}</span>
        </button>
        <div className="tsep" />
        <div className={`seg${noGames ? ' dis' : ''}`} role="radiogroup" aria-label={t('library.view.sortAria')} onKeyDown={segKeys(SORTS, sort, setSort)}>
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
              {t(SORT_LABEL[s])}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <SearchBox value={search} onChange={setSearch} placeholder={t('library.view.search')} testId="library-search" disabled={noGames} />
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
            <span className="cap">{t('library.view.emptyCap')}</span>
            <h2>{t('library.view.emptyTitle')}</h2>
            {torrentsEnabled ? (
              <p>
                {t('library.view.emptyTorrents')}
                <br />
                {t('library.view.emptyTorrents2')}
              </p>
            ) : (
              <p>{t('library.view.emptyNoTorrents')}</p>
            )}
            <div className="row-btns">
              <button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>
                <FolderInput />
                {t('library.common.importFolder')}
              </button>
              <button type="button" className="btn btn-line" onClick={onAdd}>
                <Plus />
                {t('library.view.add')}
              </button>
            </div>
            <div className="plat-note" aria-live="polite">
              {syncing ? (
                <>
                  <LoaderCircle className="spin" />
                  <span>{t('library.view.emptySyncing')}</span>
                </>
              ) : (
                <>
                  <span>{t('library.view.emptyAuto')}</span>
                  <button type="button" className="btn btn-sm" onClick={onOpenPlatforms}>
                    <Blocks />
                    {t('library.common.platforms')}
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
              <span className="cap">{filter === 'all' ? t('library.view.collection') : platformName(filter)}</span>
              <span className="cap">
                {query ? (
                  <>
                    <b>{games.length}</b> {gamesWord(games.length)} {t('library.view.ofTotal', { total })}
                  </>
                ) : (
                  <>
                    <b>{total}</b> {gamesWord(total)}
                    {absentCount > 0 && (
                      <>
                        {' '}
                        · <b>{absentCount}</b> {tn('library.view.notInstalledCount', absentCount)}
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
                  aria-label={t('library.view.showAria')}
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
                      title={t(SHOW_TITLE[s])}
                      data-testid={`library-show-${s}`}
                      onClick={() => onShow(s)}
                    >
                      {t(SHOW_LABEL[s])}
                    </button>
                  ))}
                </div>
              )}
              <span className="cap">{t('library.view.sortCap', { mode: t(SORT_LABEL[sort]).toLocaleLowerCase(locale) })}</span>
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
                  {t('library.view.noMatch')} <q>{query}</q>.
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
                  {t('library.view.clearSearch')}
                </button>
              </div>
            ) : (
              <div className="noresult">
                <span>
                  {filter === 'all'
                    ? t('library.view.noneInstalled')
                    : t(show === 'installed' ? 'library.view.nonePlatformInstalled' : 'library.view.nonePlatform', { platform: platformName(filter) })}
                </span>
                {ownedElsewhere || (filter === 'all' && canShowAll && show === 'installed') ? (
                  <button type="button" className="btn btn-line btn-sm" onClick={() => onShow('owned')}>
                    {t('library.view.seeNotInstalled')}
                  </button>
                ) : filter !== 'all' ? (
                  <button type="button" className="btn btn-line btn-sm" onClick={() => onFilter('all')}>
                    {t('library.view.seeAll')}
                  </button>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {menu && menuGame && <ContextMenu key={`${menu.id},${menu.x},${menu.y}`} x={menu.x} y={menu.y} items={menuItems(menuGame)} onClose={closeMenu} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onToast={onToast} />}
      {uninstalling && <UninstallDialog game={uninstalling} onClose={() => setUninstalling(null)} onToast={onToast} />}
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
