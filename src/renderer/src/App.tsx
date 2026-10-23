import { ArrowDownToLine, Copy, FolderOpen, Gamepad2, LoaderCircle, Package, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cleanGameName } from '../../shared/gameName'
import { PLATFORM_INFO } from '../../shared/platforms'
import type { Game, GamePlatform, LibraryState, PlatformsState, Settings, SettingsPatch, Snapshot, TorrentSummary, UpdateState } from '../../shared/types'
import { AddDialog, readMagnet, type AddPreset } from './components/AddDialog'
import { ContextMenu, type MenuItem } from './components/ContextMenu'
import { DetailsPanel } from './components/DetailsPanel'
import { Dust } from './components/Dust'
import { GameDialog, type GameDialogState } from './components/GameDialog'
import { LibraryView } from './components/LibraryView'
import { MarkAnim } from './components/MarkAnim'
import { MarkSmall } from './components/MarkSmall'
import { PlatformsDialog } from './components/PlatformsDialog'
import { RemoveDialog } from './components/RemoveDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar, type LibNavItem, type View } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { Toasts, type Toast, type ToastOptions } from './components/Toasts'
import { Toolbar } from './components/Toolbar'
import { sortValue, TorrentTable, type Sort, type SortKey } from './components/TorrentTable'
import { errorText, filterLabel, FILTERS, formatClockText, isRunning, matchesFilter, type Filter } from './format'
import { useCanvasHold } from './fx/loop'
import { LangProvider } from './i18n'
// App fixe la langue (setLang) avant de se dessiner : t et tn y sont lus directement
import { locale, setLang, t, tn } from '../../shared/i18n'
import { prefersReducedMotion } from './fx/motion'
import {
  canShowOwned,
  FILTER_ORDER,
  ofName,
  platformCounts,
  platformName,
  type LibraryFilter,
  type LibraryShow
} from './platformUi'

const api = window.essaim

/** Version courte affichée dans la bande de titre et le pied de la barre latérale : « 0.3 ». */

const DETAILS_KEY = 'essaim.detailsHeight'
const DETAILS_MIN = 150
/** Écran de démarrage : jusqu'au premier instantané du moteur (torrents désactivés : jusqu'à la
 *  lecture de la bibliothèque), 3 s au plus. */
const SPLASH_MAX_MS = 3000
/** Bouton du toast « Les torrents sont désactivés. » (sert aussi à retrouver ces toasts). */
const ENABLE_TORRENTS_ACTION = 'toast-enable-torrents'

/** Liste vide pour ce filtre : « Aucun torrent en cours pour l’instant. » (clé shell.empty.<filtre>). */
const filterEmpty = (f: Filter): string => t(`shell.empty.${f}`)

/** Vue de la bibliothèque mémorisée (« Installés » ou « Tous ») : simple confort, par défaut « Tous ». */
const SHOW_KEY = 'essaim.libraryShow'
function readStoredShow(): LibraryShow {
  try {
    return localStorage.getItem(SHOW_KEY) === 'installed' ? 'installed' : 'owned'
  } catch {
    return 'owned'
  }
}
function storeShow(show: LibraryShow): void {
  try {
    localStorage.setItem(SHOW_KEY, show)
  } catch {
    // simple confort
  }
}

/** Barre latérale repliée (bouton en haut à gauche ou Ctrl+B) : simple confort, mémorisé. */
const SIDE_KEY = 'cyberdeck.sideClosed'
function readSideClosed(): boolean {
  try {
    return localStorage.getItem(SIDE_KEY) === '1'
  } catch {
    return false
  }
}
function storeSideClosed(closed: boolean): void {
  try {
    if (closed) localStorage.setItem(SIDE_KEY, '1')
    else localStorage.removeItem(SIDE_KEY)
  } catch {
    // simple confort
  }
}

/** Largeur de la barre latérale choisie à la souris (bord droit) : simple confort, mémorisé. */
const SIDE_W_KEY = 'cyberdeck.sideWidth'
const SIDE_W_MIN = 180
const SIDE_W_MAX = 420
/** relâchée plus à gauche que ça, la barre se ferme complètement (comme le bouton en haut à gauche) */
const SIDE_CLOSE_AT = 110
function readSideWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(SIDE_W_KEY))
    return v >= SIDE_W_MIN && v <= SIDE_W_MAX ? v : null
  } catch {
    return null
  }
}
function storeSideWidth(w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(SIDE_W_KEY)
    else localStorage.setItem(SIDE_W_KEY, String(Math.round(w)))
  } catch {
    // simple confort
  }
}

/** Changements apportés par les lectures des plateformes, regroupés en un toast par sorte. */
interface PlatformChanges {
  /** nouveaux jeux sur ce PC (ou en cours d'installation) */
  added: Game[]
  /** jeux Steam seulement possédés, ajoutés à la vue « Tous » */
  owned: Game[]
  /** jeux que la plateforme a commencé à télécharger */
  downloading: Game[]
  installed: Game[]
  uninstalled: Game[]
  /** jeux retirés à la main puis remis (la fenêtre Plateformes l'a déjà dit) */
  restored: number
}
const noChanges = (): PlatformChanges => ({ added: [], owned: [], downloading: [], installed: [], uninstalled: [], restored: 0 })

/** « DayZ, Rust, Deadlock et 2 autres » (« DayZ, Rust, Deadlock and 2 more ») */
function namesOf(games: Game[], max = 3): string {
  const names = games.slice(0, max).map((g) => g.name)
  const rest = games.length - names.length
  return rest > 0 ? tn('shell.app.namesMore', rest, { names: names.join(', ') }) : names.join(', ')
}

/** Plateformes concernées, la plus fournie d'abord : [plateforme, nombre] */
function byPlatform(games: Game[]): [GamePlatform, number][] {
  const m = new Map<GamePlatform, number>()
  for (const g of games) m.set(g.platform, (m.get(g.platform) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])
}

function readStoredHeight(): number | null {
  try {
    const v = Number(localStorage.getItem(DETAILS_KEY))
    return v > 0 ? v : null
  } catch {
    return null
  }
}

function storeHeight(h: number | null): void {
  try {
    if (h === null) localStorage.removeItem(DETAILS_KEY)
    else localStorage.setItem(DETAILS_KEY, String(Math.round(h)))
  } catch {
    // simple confort
  }
}

/** Suit une media query (nouveau rendu seulement quand elle bascule). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (): void => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/**
 * Hauteur du panneau de détails : celle choisie au séparateur, sinon 320 px (300 sous 1360 px
 * de large, 232 sous 760 px de haut). Le plafond « zone principale − 200 » est appliqué par le
 * CSS (.details { max-height }), sans nouveau rendu pendant le redimensionnement de la fenêtre.
 */
function useDetailsHeight(chosen: number | null): number {
  const low = useMediaQuery('(max-height: 759px)')
  const compact = useMediaQuery('(max-width: 1359px)')
  return Math.max(DETAILS_MIN, Math.round(chosen ?? (low ? 232 : compact ? 300 : 320)))
}

function isTyping(e: Event): boolean {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** Un menu contextuel est ouvert (celui des torrents ou celui d'un jeu, propre à la bibliothèque). */
const menuShown = (): boolean => !!document.querySelector('.ctxmenu')

export function App(): React.JSX.Element {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [lastSnapAt, setLastSnapAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [settings, setSettings] = useState<Settings | null>(null)
  // langue de l'interface (anglais tant que les réglages ne sont pas lus) : fixée avant tout texte
  const lang = settings?.language ?? 'en'
  setLang(lang)
  // dernière vérification des mises à jour ; le toast n'apparaît qu'une fois par nouvelle version
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const updateToasted = useRef<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<Sort>({ key: 'addedAt', dir: 1 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [addPreset, setAddPreset] = useState<AddPreset | null>(null)
  const [removeIds, setRemoveIds] = useState<string[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [chosenDetailsHeight, setChosenDetailsHeight] = useState<number | null>(readStoredHeight)
  const [dragOver, setDragOver] = useState(false)
  // La bibliothèque de jeux est l'écran d'accueil ; les torrents sont une rubrique de la barre latérale.
  const [view, setView] = useState<View>('library')
  const [library, setLibrary] = useState<LibraryState>({ games: [], running: {}, launching: {}, installing: [] })
  const [gameDialog, setGameDialog] = useState<GameDialogState | null>(null)
  const [platforms, setPlatforms] = useState<PlatformsState | null>(null)
  const [platformsOpen, setPlatformsOpen] = useState(false)
  // clic sur une entrée « Bibliothèque » de la barre latérale : la page d'un jeu ouverte se ferme
  const [libNavKey, setLibNavKey] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [libFilter, setLibFilter] = useState<LibraryFilter>('all')
  const [libShow, setLibShow] = useState<LibraryShow>(readStoredShow)
  const [sideClosed, setSideClosed] = useState(readSideClosed)
  // largeur choisie (null = largeur par défaut) ; ignorée sous 1100 px, où la barre devient un rail
  const [sideWidth, setSideWidth] = useState(readSideWidth)
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1100px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1100px)')
    const on = (): void => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  // glisser le bord droit de la barre latérale ; tout à gauche : la barre se ferme ; double-clic : largeur par défaut
  const startSideResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing-side')
    let last: number | null = null
    let closing = false
    const move = (ev: PointerEvent): void => {
      closing = ev.clientX < SIDE_CLOSE_AT
      // la barre pâlit : la relâcher ici la ferme
      document.body.classList.toggle('side-closing', closing)
      if (closing) return
      last = Math.min(SIDE_W_MAX, Math.max(SIDE_W_MIN, ev.clientX))
      setSideWidth(last)
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing-side', 'side-closing')
      if (last !== null) storeSideWidth(last)
      if (closing) {
        setSideClosed(true)
        storeSideClosed(true)
      }
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }, [])
  const resetSideWidth = useCallback(() => {
    setSideWidth(null)
    storeSideWidth(null)
  }, [])
  const toggleSide = useCallback(() => {
    setSideClosed((c) => {
      storeSideClosed(!c)
      return !c
    })
  }, [])
  const [splash, setSplash] = useState<'on' | 'out' | 'off'>('on')
  const nextToast = useRef(1)
  const mainRef = useRef<HTMLElement>(null)
  const detailsHeight = useDetailsHeight(chosenDetailsHeight)
  // la bibliothèque a été lue au moins une fois (avant : liste vide provisoire, pas « 54 nouveaux jeux »)
  const libraryReady = useRef(false)
  // Client torrent facultatif (Réglages) : désactivé, aucune trace de torrents dans l'interface.
  const torrentsOn = !!settings?.torrentsEnabled
  // réglages connus et torrents désactivés (avant la lecture des réglages, on ne présume rien)
  const torrentsOff = useRef(false)
  useLayoutEffect(() => {
    torrentsOff.current = !!settings && !settings.torrentsEnabled
  }, [settings])
  // ajout de torrent (lien collé, fichier déposé, Ctrl+N) en attente pendant que Réglages est
  // ouvert depuis le toast « torrents désactivés » : il reprend si les torrents sont activés
  const pendingAdd = useRef<AddPreset | null>(null)

  // Les canevas animés derrière un dialogue, le menu ou le dépôt restent figés (une image).
  useCanvasHold(!!(addPreset || removeIds || gameDialog || platformsOpen || settingsOpen))
  useCanvasHold(!!menu)
  useCanvasHold(dragOver)

  const toast = useCallback((level: Toast['level'], message: string, opts: ToastOptions = {}) => {
    const id = nextToast.current++
    setToasts((t) => [...t.slice(-3), { id, level, message, at: Date.now(), ...opts }])
  }, [])
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  /** Torrents désactivés : un toast le dit, avec un bouton qui ouvre Réglages (l'ajout reprend ensuite). */
  const torrentsOffToast = useCallback(
    (preset: AddPreset, detail?: string) => {
      toast('info', t('shell.app.torrentsOff'), {
        title: t('shell.settings.torrents'),
        detail,
        action: {
          label: t('shell.app.enableTorrents'),
          testId: ENABLE_TORRENTS_ACTION,
          onClick: () => {
            pendingAdd.current = preset
            setSettingsOpen(true)
          }
        }
      })
    },
    [toast]
  )
  // Torrents activés : les autres toasts « torrents désactivés » encore affichés (Ctrl+N, lien
  // collé, fichier déposé…) ne disent plus vrai, ils partent tout de suite.
  useEffect(() => {
    if (!torrentsOn) return
    setToasts((t) => {
      const kept = t.filter((x) => x.action?.testId !== ENABLE_TORRENTS_ACTION)
      return kept.length === t.length ? t : kept
    })
  }, [torrentsOn])

  // ---------- Données du moteur ----------

  useEffect(() => {
    api.getSettings().then(setSettings)
    const offSettings = api.onSettings(setSettings)
    const offSnap = api.onSnapshot((s) => {
      // dernier instantané d'un moteur qui s'arrête (torrents désactivés) : ignoré
      if (torrentsOff.current) return
      setSnap(s)
      setLastSnapAt(Date.now())
    })
    const offNotice = api.onNotice((n) => toast(n.level, n.message))
    const takeLibrary = (l: LibraryState): void => {
      libraryReady.current = true
      setLibrary(l)
    }
    api.getLibrary().then(takeLibrary)
    const offLibrary = api.onLibrary(takeLibrary)
    // Plateformes (Steam, Epic…) : état des lanceurs et du compte Steam
    api
      .getPlatforms()
      .then((s) => setPlatforms((cur) => cur ?? s))
      .catch(() => {})
    const offPlatforms = api.onPlatforms(setPlatforms)
    // Fin d'un installateur : on propose d'ajouter le jeu détecté à la bibliothèque.
    const offInstall = api.onInstallDone((r) => {
      if (!r.ok) return toast('error', r.error ?? t('shell.app.installFailed'))
      setGameDialog({
        mode: 'add',
        preset: { ...r.guess, torrentId: r.torrentId },
        banner: r.guess.exePath ? t('shell.app.installDone') : t('shell.app.installDoneNoExe')
      })
    })
    api.getUpdate().then(setUpdate)
    const offUpdate = api.onUpdate(setUpdate)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      offUpdate()
      offSettings()
      offSnap()
      offNotice()
      offLibrary()
      offPlatforms()
      offInstall()
      clearInterval(timer)
    }
  }, [toast])

  // Nouvelle version publiée : un toast (une fois par version) avec « Télécharger » ; l'étiquette
  // de la bande du haut reste ensuite visible.
  useEffect(() => {
    if (update?.status !== 'available' || !update.latest || updateToasted.current === update.latest) return
    updateToasted.current = update.latest
    toast('info', t('shell.update.toast', { latest: update.latest }), {
      title: t('shell.update.title'),
      detail: t('shell.update.toastDetail', { current: update.current }),
      detailKind: 'text',
      action: { label: t('shell.update.download'), onClick: () => api.openUpdate(), testId: 'toast-update' }
    })
  }, [update, toast])

  // ---------- Plateformes : un toast par lecture qui change quelque chose ----------
  // Jeux trouvés (« 3 nouveaux jeux trouvés sur Steam »), jeux possédés ajoutés, téléchargements
  // commencés, jeux installés ou désinstallés. Calculé ici en comparant deux états de la
  // bibliothèque, regroupé sur 1,2 s (une lecture envoie plusieurs mises à jour).

  const seenGames = useRef<Map<string, { key: string | null; installed: boolean; downloading: boolean }> | null>(null)
  /** jeux de plateforme retirés de la bibliothèque (s'ils reviennent : remis, pas nouveaux) */
  const goneKeys = useRef(new Set<string>())
  const changes = useRef<PlatformChanges>(noChanges())
  const flushTimer = useRef(0)
  /** nombre de toasts « changement » déjà montrés (pour « rien de nouveau » après Resynchroniser) */
  const changeCount = useRef(0)

  const flushChanges = useCallback(() => {
    const ch = changes.current
    changes.current = noChanges()
    const title = t('shell.sidebar.platforms')
    let n = ch.restored
    if (ch.added.length) {
      const groups = byPlatform(ch.added)
      const k = ch.added.length
      const where = groups.length === 1 ? t('shell.app.onPlatform', { name: PLATFORM_INFO[groups[0][0]].name }) : t('shell.app.onYourPlatforms')
      toast('success', tn('shell.app.newGames', k, { where }), {
        title,
        detail: groups.length === 1 ? namesOf(ch.added) : groups.map(([p, c]) => `${PLATFORM_INFO[p].name} ${c}`).join(' · ')
      })
      n++
    }
    if (ch.owned.length) {
      const k = ch.owned.length
      toast('info', tn('shell.app.ownedAdded', k), {
        title: 'Steam',
        detail: tn('shell.app.ownedDetail', k),
        detailKind: 'text'
      })
      n++
    }
    if (ch.downloading.length) {
      const k = ch.downloading.length
      const name = PLATFORM_INFO[ch.downloading[0].platform].name
      toast('info', tn('shell.app.downloading', k, { name }), { title, detail: namesOf(ch.downloading) })
      n++
    }
    if (ch.installed.length) {
      const k = ch.installed.length
      toast('success', tn('shell.app.installed', k, { name: ch.installed[0].name }), {
        title,
        detail: k === 1 ? t('shell.app.readyToPlay', { name: PLATFORM_INFO[ch.installed[0].platform].name }) : namesOf(ch.installed),
        detailKind: k === 1 ? 'text' : 'name'
      })
      n++
    }
    if (ch.uninstalled.length) {
      const k = ch.uninstalled.length
      toast('info', tn('shell.app.uninstalled', k, { name: ch.uninstalled[0].name }), {
        title,
        detail: k === 1 ? t('shell.app.uninstalledDetail', { of: ofName(PLATFORM_INFO[ch.uninstalled[0].platform].name) }) : namesOf(ch.uninstalled),
        detailKind: k === 1 ? 'text' : 'name'
      })
      n++
    }
    changeCount.current += n
  }, [toast])

  useEffect(() => {
    if (!libraryReady.current) return
    const prev = seenGames.current
    const next = new Map(
      library.games.map((g) => [
        g.id,
        {
          key: g.platform !== 'local' && g.platformId ? `${g.platform}:${g.platformId}` : null,
          installed: g.installed,
          downloading: g.platformState === 'downloading'
        }
      ])
    )
    seenGames.current = next
    if (!prev) return // première lecture : point de départ, aucun toast
    const ch = changes.current
    let any = false
    for (const g of library.games) {
      if (g.platform === 'local') continue // ajouts à la main : ils ont leurs propres messages
      const before = prev.get(g.id)
      const now = next.get(g.id)!
      if (!before) {
        if (now.key && goneKeys.current.delete(now.key)) ch.restored++
        else if (now.installed || now.downloading) ch.added.push(g)
        else if (g.owned === true) ch.owned.push(g)
        else continue
        any = true
      } else if (!before.installed && now.installed) {
        ch.installed.push(g)
        any = true
      } else if (before.installed && !now.installed && !now.downloading) {
        ch.uninstalled.push(g)
        any = true
      } else if (!before.downloading && now.downloading && !now.installed) {
        ch.downloading.push(g)
        any = true
      }
    }
    // jeu installé qui quitte la bibliothèque = retiré à la main (les jeux seulement possédés partent
    // quand la clé Steam est oubliée : s'ils reviennent, ce sont bien des « jeux possédés ajoutés »).
    // Le nombre de jeux retirés de la fenêtre Plateformes arrive par le message « platforms ».
    for (const [id, before] of prev) if (!next.has(id) && before.key && before.installed) goneKeys.current.add(before.key)
    if (!any) return
    clearTimeout(flushTimer.current)
    flushTimer.current = window.setTimeout(flushChanges, 1200)
  }, [library.games, flushChanges])
  useEffect(() => () => clearTimeout(flushTimer.current), [])

  // Lecture d'une plateforme devenue impossible : dit une fois (pas à chaque relecture)
  const prevPlatforms = useRef<PlatformsState | null>(null)
  useEffect(() => {
    const prev = prevPlatforms.current
    prevPlatforms.current = platforms
    if (!prev || !platforms) return
    for (const p of platforms.platforms) {
      const before = prev.platforms.find((x) => x.id === p.id)
      if (p.state === 'error' && before && before.state !== 'error')
        toast('error', t('shell.app.platformFailed', { name: p.name, of: ofName(p.name) }), {
          title: t('shell.sidebar.platforms'),
          detail: p.error ?? undefined,
          detailKind: 'text'
        })
    }
  }, [platforms, toast])

  /** « Resynchroniser » : relit tout ; si rien n'a changé, on le dit (sinon les toasts ci-dessus parlent). */
  const resyncPlatforms = useCallback(async () => {
    const before = changeCount.current
    try {
      setPlatforms(await api.syncPlatforms())
    } catch (err) {
      toast('error', t('shell.app.platformsFailed', { error: errorText(err) }), { title: t('shell.sidebar.platforms') })
      return
    }
    await new Promise((r) => setTimeout(r, 1400))
    if (changeCount.current === before) toast('info', t('shell.app.nothingNew'), { title: t('shell.sidebar.platforms') })
  }, [toast])

  // ---------- Bibliothèque : vue (Installés / Tous) et filtres de plateforme ----------

  const canShowAll = useMemo(() => canShowOwned(platforms, library.games), [platforms, library.games])
  const libView: LibraryShow = canShowAll ? libShow : 'installed'
  const viewCounts = useMemo(() => platformCounts(library.games, libView), [library.games, libView])
  const libCount = useMemo(() => [...viewCounts.values()].reduce((a, b) => a + b, 0), [viewCounts])
  // Un filtre par plateforme qui a des jeux (et le filtre actif, même vide) ; rien s'il n'y a qu'une sorte de jeux.
  const libNav = useMemo<LibNavItem[]>(() => {
    const items = FILTER_ORDER.filter((p) => (viewCounts.get(p) ?? 0) > 0 || p === libFilter).map((p) => ({ id: p, count: viewCounts.get(p) ?? 0 }))
    return items.filter((i) => i.count > 0).length >= 2 || libFilter !== 'all' ? items : []
  }, [viewCounts, libFilter])
  const chooseShow = useCallback((s: LibraryShow) => {
    setLibShow(s)
    storeShow(s)
  }, [])
  /** Fenêtre « Plateformes » : ouverte avec un état relu (jeux retirés, compte Steam). */
  const openPlatforms = useCallback(() => {
    setPlatformsOpen(true)
    api.getPlatforms().then(setPlatforms, () => {})
  }, [])

  // ---------- Écran de démarrage : jusqu'au premier instantané (3 s au plus), puis fondu de 200 ms ----------
  // Torrents désactivés : pas de moteur, l'écran part dès que la bibliothèque est lue.

  useEffect(() => {
    const timer = setTimeout(() => setSplash((s) => (s === 'on' ? 'out' : s)), SPLASH_MAX_MS)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (splash !== 'on' || !settings) return
    if (settings.torrentsEnabled ? snap : libraryReady.current) setSplash('out')
  }, [splash, snap, settings, library])

  // ---------- Torrents désactivés (au démarrage ou dans Réglages) : la vue Torrents disparaît ----------

  const settingsKnown = !!settings
  useEffect(() => {
    if (!settingsKnown || torrentsOn) return
    setView((v) => (v === 'torrents' ? 'library' : v))
    setSnap(null)
    setLastSnapAt(0)
    setSelected(new Set())
    setFocusId(null)
    setAnchorId(null)
    setAddPreset(null)
    setRemoveIds(null)
    setMenu(null)
  }, [settingsKnown, torrentsOn])
  useEffect(() => {
    if (splash !== 'out') return
    const timer = setTimeout(() => setSplash('off'), prefersReducedMotion() ? 0 : 220)
    return () => clearTimeout(timer)
  }, [splash])

  const gameByTorrent = useMemo(() => {
    const m = new Map<string, Game>()
    for (const g of library.games) if (g.torrentId) m.set(g.torrentId, g)
    return m
  }, [library.games])
  const installing = useMemo(() => new Set(library.installing), [library.installing])

  const torrents = useMemo(() => snap?.torrents ?? [], [snap])
  const byId = useMemo(() => new Map(torrents.map((x) => [x.id, x])), [torrents])
  const numbers = useMemo(() => new Map(torrents.map((x, i) => [x.id, i + 1])), [torrents])

  const counts = useMemo(() => {
    const c = { all: 0, active: 0, done: 0, seeding: 0 } as Record<Filter, number>
    for (const x of torrents) for (const f of FILTERS) if (matchesFilter(x, f.id)) c[f.id]++
    return c
  }, [torrents])

  const query = search.trim()
  const visible = useMemo(() => {
    const q = query.toLocaleLowerCase('fr')
    const list = torrents.filter((x) => matchesFilter(x, filter) && (!q || x.name.toLocaleLowerCase('fr').includes(q)))
    const loc = locale(lang)
    return list.sort((a, b) => {
      const va = sortValue(a, sort.key)
      const vb = sortValue(b, sort.key)
      const cmp = typeof va === 'string' ? va.localeCompare(vb as string, loc) : (va as number) - (vb as number)
      return cmp * sort.dir || a.addedAt - b.addedAt
    })
  }, [torrents, filter, query, sort, lang])

  // La sélection et la ligne dont on voit les détails restent dans la liste affichée : un
  // torrent supprimé, ou masqué par le filtre ou la recherche, quitte la sélection. Ainsi
  // Suppr, les boutons de la barre d'outils et le pied de liste ne visent jamais une ligne
  // invisible.
  const visibleIds = useMemo(() => new Set(visible.map((x) => x.id)), [visible])
  useEffect(() => {
    if (!snap) return
    setSelected((sel) => {
      const kept = [...sel].filter((id) => visibleIds.has(id))
      return kept.length === sel.size ? sel : new Set(kept)
    })
    if (focusId && !visibleIds.has(focusId)) setFocusId(null)
  }, [snap, visibleIds, focusId])

  useEffect(() => {
    api.select(focusId)
  }, [focusId])

  const selectedList = useMemo(() => [...selected].map((id) => byId.get(id)).filter(Boolean) as TorrentSummary[], [selected, byId])
  const canResume = selectedList.some((x) => !isRunning(x))
  const canPause = selectedList.some(isRunning)

  // ---------- Actions ----------

  const openAdd = useCallback((preset: AddPreset = {}) => setAddPreset(preset), [])
  const resume = (ids = [...selected]): void => api.resume(ids)
  const pause = (ids = [...selected]): void => api.pause(ids)
  const askRemove = (ids = [...selected]): void => {
    if (ids.length) setRemoveIds(ids)
  }
  const openFolder = (id = focusId ?? [...selected][0]): void => {
    if (id) api.openFolder(id)
  }
  const copy = (text: string, what: string): void => {
    api.copyText(text)
    toast('info', what)
  }
  const isDone = (tor: TorrentSummary): boolean => tor.progress >= 1
  const install = (tor: TorrentSummary): void => {
    api.installTorrent(tor.id)
    toast('info', t('shell.app.installerOpening'))
  }
  const play = (g: Game): void => {
    if (library.running[g.id]) return
    api.playGame(g.id)
    toast('info', t('shell.app.launching'), { detail: g.name })
  }
  const addToLibrary = async (tor: TorrentSummary): Promise<void> => {
    const exe = await api.pickExe(`${tor.savePath}\\${tor.name}`)
    if (exe) setGameDialog({ mode: 'add', preset: { name: cleanGameName(tor.name), exePath: exe, installDir: null, torrentId: tor.id } })
  }
  const addManualGame = async (): Promise<void> => {
    const exe = await api.pickExe()
    if (exe) setGameDialog({ mode: 'add', preset: { name: '', exePath: exe, installDir: null, torrentId: null } })
  }

  // Pastille à droite du nom (SPEC 5.5) : installateur ouvert → INSTALLATION… ; jeu de la
  // bibliothèque lié au torrent → EN JEU s'il tourne, sinon JOUER ; fini avec installateur → INSTALLER.
  // Un clic sur une pastille ne change pas la sélection.
  const renderAction = (tor: TorrentSummary): React.ReactNode => {
    const game = gameByTorrent.get(tor.id)
    const stop = (e: React.MouseEvent): void => e.stopPropagation()
    if (installing.has(tor.id))
      return (
        <span
          className="pill busy"
          title={t('shell.pill.installerOpen')}
          aria-label={t('shell.pill.installingLabel')}
          data-testid="row-pill"
          data-kind="installing"
        >
          <LoaderCircle className="spin" />
          <span className="lbl">{t('shell.pill.installing')}</span>
        </span>
      )
    if (game)
      return library.running[game.id] ? (
        <span className="pill live" title={t('shell.pill.runningTitle', { name: game.name })} aria-label={t('shell.pill.running')} data-testid="row-pill" data-kind="running">
          <span className="live-dot" />
          <span className="lbl">{t('shell.pill.running')}</span>
        </span>
      ) : (
        <button
          type="button"
          className="pill play"
          title={t('shell.pill.playTitle', { name: game.name })}
          aria-label={t('shell.pill.playTitle', { name: game.name })}
          data-testid="row-pill"
          data-kind="play"
          onMouseDown={stop}
          onDoubleClick={stop}
          onClick={() => play(game)}
        >
          <Play />
          <span className="lbl">{t('shell.pill.play')}</span>
        </button>
      )
    if (tor.installer && isDone(tor))
      return (
        <button
          type="button"
          className="pill"
          title={t('shell.pill.installTitle')}
          aria-label={t('shell.pill.install')}
          data-testid="row-pill"
          data-kind="install"
          onMouseDown={stop}
          onDoubleClick={stop}
          onClick={() => install(tor)}
        >
          <Package />
          <span className="lbl">{t('shell.pill.install')}</span>
        </button>
      )
    return null
  }

  function onRowClick(id: string, e: React.MouseEvent): void {
    if (e.shiftKey && anchorId) {
      const ids = visible.map((x) => x.id)
      const a = ids.indexOf(anchorId)
      const b = ids.indexOf(id)
      if (a !== -1 && b !== -1) {
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1)
        setSelected(new Set(e.ctrlKey ? [...selected, ...range] : range))
        setFocusId(id)
        return
      }
    }
    if (e.ctrlKey) {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelected(next)
    } else {
      setSelected(new Set([id]))
    }
    setFocusId(id)
    setAnchorId(id)
  }

  function onRowContextMenu(id: string, e: React.MouseEvent): void {
    e.preventDefault()
    if (!selected.has(id)) {
      setSelected(new Set([id]))
      setAnchorId(id)
    }
    setFocusId(id)
    setMenu({ x: e.clientX, y: e.clientY })
  }

  // Menu d'un torrent (SPEC 5.13) : (jeu lié : Jouer) ou (terminé : Installer, Ajouter à la
  // bibliothèque…) ; Reprendre, Pause ; Ouvrir le dossier, Copier le lien magnet ; Supprimer…
  const menuItems = (): (MenuItem | 'sep')[] => {
    const focus = focusId ? byId.get(focusId) : undefined
    const game = focus ? gameByTorrent.get(focus.id) : undefined
    const gameItems: (MenuItem | 'sep')[] = []
    if (focus && game)
      gameItems.push({ label: t('shell.pill.play'), icon: <Gamepad2 />, disabled: !!library.running[game.id], onClick: () => play(game) }, 'sep')
    else if (focus && isDone(focus)) {
      if (focus.installer)
        gameItems.push({ label: t('shell.pill.install'), icon: <Package />, disabled: installing.has(focus.id), onClick: () => install(focus) })
      gameItems.push({ label: t('shell.menu.addToLibrary'), icon: <Gamepad2 />, onClick: () => addToLibrary(focus) }, 'sep')
    }
    return [
      ...gameItems,
      { label: t('shell.toolbar.resume'), icon: <Play />, disabled: !canResume, onClick: () => resume() },
      { label: t('shell.toolbar.pause'), icon: <Pause />, disabled: !canPause, onClick: () => pause() },
      'sep',
      { label: t('shell.toolbar.openFolder'), icon: <FolderOpen />, onClick: () => openFolder() },
      {
        label: t('shell.menu.copyMagnet'),
        icon: <Copy />,
        disabled: !focus,
        onClick: () => focus && copy(focus.magnetURI, t('shell.details.magnetCopied'))
      },
      'sep',
      { label: t('shell.menu.remove'), icon: <Trash2 />, danger: true, shortcut: t('shell.keys.del'), onClick: () => askRemove() }
    ]
  }

  // ---------- Clavier, coller, glisser-déposer ----------

  useEffect(() => {
    // Raccourcis de la fenêtre : rien pendant un dialogue ou un menu (le menu resterait
    // affiché par-dessus le dialogue d'ajout).
    const onKey = (e: KeyboardEvent): void => {
      if (addPreset || removeIds || gameDialog || platformsOpen || settingsOpen || menu || menuShown()) return
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        if (!e.repeat) toggleSide()
        return
      }
      if (e.ctrlKey && (e.key === 'n' || e.key === 'o')) {
        e.preventDefault()
        if (torrentsOn) openAdd()
        else if (settingsKnown && !e.repeat) torrentsOffToast({})
        return
      }
      if (isTyping(e) || view !== 'torrents' || !torrentsOn) return
      if (e.key === 'Delete' && selected.size) {
        e.preventDefault()
        setRemoveIds([...selected])
      } else if (e.ctrlKey && e.key === 'a') {
        e.preventDefault()
        setSelected(new Set(visible.map((x) => x.id)))
      } else if (e.key === 'Escape') {
        setSelected(new Set())
        setFocusId(null)
      }
    }
    const onPaste = (e: ClipboardEvent): void => {
      if (addPreset || removeIds || gameDialog || platformsOpen || settingsOpen || menu || menuShown() || isTyping(e)) return
      const text = e.clipboardData?.getData('text')?.trim() ?? ''
      if (!text.startsWith('magnet:?')) return
      // Le collage natif est annulé : le dialogue s'ouvre pendant l'événement et donne le focus
      // au champ du lien, où le navigateur collerait le texte une seconde fois (lien doublé).
      e.preventDefault()
      if (torrentsOn) openAdd({ magnet: text })
      else if (settingsKnown) torrentsOffToast({ magnet: text }, readMagnet(text).name ?? undefined)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('paste', onPaste)
    }
  }, [
    addPreset,
    removeIds,
    gameDialog,
    platformsOpen,
    settingsOpen,
    menu,
    view,
    selected,
    visible,
    openAdd,
    torrentsOn,
    settingsKnown,
    torrentsOffToast,
    toggleSide
  ])

  // Torrents désactivés : pas de zone de dépôt ; un .torrent déposé donne le toast « torrents désactivés ».
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth++
      if (torrentsOn) setDragOver(true)
    }
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragOver(false)
    }
    const onOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      depth = 0
      setDragOver(false)
      const all = [...(e.dataTransfer?.files ?? [])]
      const files = all.filter((f) => f.name.toLowerCase().endsWith('.torrent'))
      if (!torrentsOn) {
        if (files.length && settingsKnown) torrentsOffToast({ filePath: api.pathForFile(files[0]) }, files[0].name)
        return
      }
      if (!files.length) {
        if (all.length) toast('error', t('shell.app.dropTorrent'), { detail: all[0].name })
        return
      }
      openAdd({ filePath: api.pathForFile(files[0]) })
      if (all.length > 1) toast('info', t('shell.app.oneFile'), { detail: files[0].name })
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openAdd, toast, torrentsOn, settingsKnown, torrentsOffToast])

  // ---------- Séparateur redimensionnable (150 px au moins, zone principale − 200 au plus ; mémorisé) ----------

  function startResize(e: React.MouseEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    e.preventDefault()
    const splitter = e.currentTarget
    const startY = e.clientY
    // hauteur réellement affichée (le CSS peut l'avoir plafonnée dans une petite fenêtre)
    const panel = splitter.nextElementSibling as HTMLElement | null
    const startH = panel ? Math.round(panel.getBoundingClientRect().height) : detailsHeight
    const max = Math.max(DETAILS_MIN, (mainRef.current?.clientHeight ?? 700) - 200)
    let h = startH
    const onMove = (ev: MouseEvent): void => {
      h = Math.max(DETAILS_MIN, Math.min(max, startH + startY - ev.clientY))
      setChosenDetailsHeight(h)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing')
      splitter.classList.remove('drag')
      if (h !== startH) storeHeight(h)
    }
    document.body.classList.add('resizing')
    splitter.classList.add('drag')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ---------- Rendu ----------

  const focus = focusId ? (byId.get(focusId) ?? null) : null
  const connected = now - lastSnapAt < 3000
  const hasTorrents = torrents.length > 0

  // Avant le premier instantané, la liste n'est pas « vide » : le moteur démarre encore.
  const empty = !snap ? (
    <div className="noresult waiting" aria-busy="true">
      <span className="cap">{t('shell.app.engineStarting')}</span>
      <span className="scanbar">
        <i />
      </span>
    </div>
  ) : !hasTorrents ? (
    <div className="empty">
      <Dust className="dust" count={40} bias={0} />
      <MarkAnim className="mark-anim" />
      <span className="cap">{t('shell.app.noTorrent')}</span>
      <h2>{t('shell.app.firstTorrent')}</h2>
      <p>{t('shell.app.firstTorrentHint')}</p>
      <button type="button" className="btn btn-primary" onClick={() => openAdd()}>
        <Plus />
        {t('shell.add.title')}
      </button>
      <div className="keys">
        <kbd className="k">Ctrl</kbd>
        <kbd className="k">V</kbd>
        <span className="cap">{t('shell.app.pasteLink')}</span>
        <span className="cap deco">·</span>
        <kbd className="k">Ctrl</kbd>
        <kbd className="k">N</kbd>
        <span className="cap">{t('shell.keys.add')}</span>
      </div>
    </div>
  ) : query ? (
    <div className="noresult">
      <span>
        {t('shell.app.noMatch')} <q>{query}</q>.
      </span>
      <button type="button" className="btn btn-line btn-sm" onClick={() => setSearch('')}>
        <X />
        {t('shell.search.clear')}
      </button>
    </div>
  ) : (
    <div className="noresult">
      <span>{filterEmpty(filter)}</span>
      <button type="button" className="btn btn-line btn-sm" onClick={() => setFilter('all')}>
        {t('shell.app.seeAll')}
      </button>
    </div>
  )

  // Données supplémentaires pour les vues réécrites (à déclarer dans leurs Props pour s'en servir).
  const tableExtra = { focusId, total: torrents.length, query, filter }
  const detailsExtra = { number: focus ? (numbers.get(focus.id) ?? null) : null }
  const addExtra = { freeSpace: snap?.global.freeSpace ?? null }
  // Jeu lancé le plus récemment : étiquette verte « EN JEU » dans la bande de titre.
  const liveGame = Object.entries(library.running)
    .map(([id, startedAt]) => ({ game: library.games.find((g) => g.id === id), startedAt }))
    .filter((x): x is { game: (typeof library.games)[number]; startedAt: number } => !!x.game)
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  // Vue Torrents seulement si les torrents sont activés ; la barre d'état et l'oscilloscope
  // du trafic n'existent que dans cette vue (la bibliothèque n'a ni l'un ni l'autre).
  const showTorrents = view === 'torrents' && torrentsOn

  /** Réglages ouverts depuis la barre latérale : pas d'ajout de torrent en attente. */
  const openSettings = useCallback(() => {
    pendingAdd.current = null
    setSettingsOpen(true)
  }, [])
  const closeSettings = (): void => {
    setSettingsOpen(false)
    const preset = pendingAdd.current
    pendingAdd.current = null
    // ouverts depuis le toast « torrents désactivés » et torrents activés : l'ajout reprend
    if (preset && torrentsOn) openAdd(preset)
  }
  const changeSettings = useCallback(async (patch: SettingsPatch) => {
    setSettings(await api.setSettings(patch))
  }, [])

  return (
    <LangProvider lang={lang}>
      <div
        className={`app${showTorrents ? '' : ' no-status'}${sideClosed ? ' side-closed' : ''}`}
        style={sideWidth !== null && wide && !sideClosed ? ({ '--side-w': `${sideWidth}px` } as React.CSSProperties) : undefined}
      >
        <header className="titlebar">
          <button
            type="button"
            className="tb-side"
            data-testid="titlebar-side"
            title={sideClosed ? t('shell.title.showSideKey') : t('shell.title.hideSideKey')}
            aria-label={sideClosed ? t('shell.title.showSide') : t('shell.title.hideSide')}
            aria-pressed={!sideClosed}
            onClick={toggleSide}
          >
            {sideClosed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
          <MarkSmall />
          <span className="wordmark">CYBERDECK</span>
          {update?.status === 'available' && (
            <button
              type="button"
              className="tb-update"
              data-testid="titlebar-update"
              title={t('shell.update.chipTitle', { latest: update.latest ?? '', current: update.current })}
              onClick={() => api.openUpdate()}
            >
              <ArrowDownToLine />
              <span>{t('shell.update.chip', { latest: update.latest ?? '' })}</span>
            </button>
          )}
          <span className="crumb">
            {!showTorrents ? (
              <span className="cap">
                {t('shell.sidebar.library')} / <b>{libFilter === 'all' ? t('shell.sidebar.myGames') : platformName(libFilter)}</b>
              </span>
            ) : (
              <span className="cap">
                Torrents / <b>{filterLabel(filter)}</b>
              </span>
            )}
          </span>
          {liveGame && (
            <button
              type="button"
              className="tb-live"
              data-testid="titlebar-live"
              title={t('shell.title.liveTitle', { name: liveGame.game.name })}
              onClick={() => {
                setLibFilter('all')
                setView('library')
              }}
            >
              <span className="live-dot" />
              <span className="k">{t('shell.pill.running')}</span>
              <span className="n">{liveGame.game.name}</span>
              <span className="t">{formatClockText(Math.max(0, (now - liveGame.startedAt) / 1000))}</span>
            </button>
          )}
        </header>

        {/* bord droit de la barre latérale : glisser pour la largeur, double-clic pour la largeur par défaut */}
        {wide && !sideClosed && (
          <div
            className="side-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('shell.title.sideWidth')}
            title={t('shell.title.sideWidthTitle')}
            data-testid="side-resize"
            onPointerDown={startSideResize}
            onDoubleClick={resetSideWidth}
          />
        )}
        <Sidebar
          view={showTorrents ? 'torrents' : 'library'}
          filter={filter}
          counts={counts}
          gameCount={libCount}
          playing={Object.keys(library.running).length > 0}
          onFilter={(f) => {
            setFilter(f)
            setView('torrents')
          }}
          libFilter={libFilter}
          libNav={libNav}
          onLibrary={(f) => {
            setLibFilter(f)
            setView('library')
            setLibNavKey((n) => n + 1)
          }}
          onPlatforms={openPlatforms}
          onSettings={openSettings}
          syncing={!!platforms?.syncing}
          torrentsEnabled={torrentsOn}
          traffic={{ down: snap?.global.downloadSpeed ?? 0, up: snap?.global.uploadSpeed ?? 0, stamp: lastSnapAt }}
        />

        {!showTorrents ? (
          <main className="main" ref={mainRef}>
            <LibraryView
              library={library}
              platforms={platforms}
              filter={libFilter}
              show={libView}
              canShowAll={canShowAll}
              torrentsEnabled={torrentsOn}
              onShow={chooseShow}
              onFilter={setLibFilter}
              onAdd={addManualGame}
              onEdit={(game) => setGameDialog({ mode: 'edit', game })}
              onOpenPlatforms={openPlatforms}
              onToast={toast}
              navKey={libNavKey}
            />
          </main>
        ) : (
          <main className="main" ref={mainRef}>
            <Toolbar
              title={filterLabel(filter)}
              count={counts[filter]}
              empty={!hasTorrents}
              canResume={canResume}
              canPause={canPause}
              hasSelection={selected.size > 0}
              search={search}
              onSearch={setSearch}
              onAdd={() => openAdd()}
              onResume={() => resume()}
              onPause={() => pause()}
              onRemove={() => askRemove()}
              onOpenFolder={() => openFolder()}
            />
            <TorrentTable
              torrents={visible}
              numbers={numbers}
              selected={selected}
              sort={sort}
              onSort={(key: SortKey) =>
                setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : key === 'name' || key === 'addedAt' ? 1 : -1 }))
              }
              onRowClick={onRowClick}
              onRowDoubleClick={(id) => openFolder(id)}
              onRowContextMenu={onRowContextMenu}
              renderAction={renderAction}
              empty={empty}
              {...tableExtra}
            />
            {hasTorrents && (
              <div
                className="splitter"
                role="separator"
                aria-orientation="horizontal"
                aria-label={t('shell.title.detailsHeight')}
                title={t('shell.title.detailsHeightTitle')}
                onMouseDown={startResize}
                onDoubleClick={() => {
                  setChosenDetailsHeight(null)
                  storeHeight(null)
                }}
              >
                <span className="grip" />
              </div>
            )}
            {hasTorrents && (
              <DetailsPanel
                torrent={focus}
                details={snap?.details ?? null}
                height={detailsHeight}
                onCopy={copy}
                onOpenFolder={(id) => openFolder(id)}
                {...detailsExtra}
              />
            )}
          </main>
        )}

        {showTorrents && <StatusBar stats={snap?.global ?? null} connected={connected} />}

        {addPreset && settings && (
          <AddDialog
            preset={addPreset}
            defaultSavePath={settings.defaultSavePath}
            onClose={() => {
              setAddPreset(null)
              api.getSettings().then(setSettings)
            }}
            onAdded={(name) => {
              toast('success', t('shell.app.torrentAdded'), name && name !== t('shell.add.magnetLink') ? { detail: name } : {})
              setView('torrents')
            }}
            {...addExtra}
          />
        )}
        {gameDialog && (
          <GameDialog
            key={gameDialog.game?.id ?? gameDialog.preset?.exePath ?? gameDialog.preset?.torrentId ?? 'nouveau'}
            {...gameDialog}
            game={gameDialog.game && (library.games.find((g) => g.id === gameDialog.game!.id) ?? gameDialog.game)}
            onClose={() => setGameDialog(null)}
            onToast={toast}
          />
        )}
        {platformsOpen && (
          <PlatformsDialog state={platforms} onClose={() => setPlatformsOpen(false)} onResync={resyncPlatforms} onToast={toast} />
        )}
        {settingsOpen && settings && (
          <SettingsDialog
            settings={settings}
            torrents={torrents}
            freeSpace={snap?.global.freeSpace ?? null}
            onChange={changeSettings}
            onClose={closeSettings}
            onToast={toast}
            update={update}
            onCheckUpdate={() => api.checkUpdate()}
          />
        )}
        {removeIds && (
          <RemoveDialog
            torrents={removeIds.map((id) => byId.get(id)).filter(Boolean) as TorrentSummary[]}
            onCancel={() => setRemoveIds(null)}
            onConfirm={(deleteFiles) => {
              api.remove(removeIds, deleteFiles)
              setRemoveIds(null)
              setSelected(new Set())
              setFocusId(null)
              toast('info', deleteFiles ? t('shell.app.removedWithFiles') : t('shell.app.removed'))
            }}
          />
        )}
        {menu && <ContextMenu key={`${menu.x},${menu.y}`} x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}
        {dragOver && (
          <div className="drop" data-testid="drop-overlay">
            <div className="zone brackets" />
            <div className="box">
              <MarkAnim holdable={false} />
              <span className="cap">{t('shell.app.dropCap')}</span>
              <h2>{t('shell.app.dropTitle')}</h2>
            </div>
          </div>
        )}
        <Toasts toasts={toasts} onDismiss={dismissToast} />
        {splash !== 'off' && (
          <div className={`splash${splash === 'out' ? ' out' : ''}`} aria-hidden={splash === 'out' ? true : undefined}>
            <div className="in">
              <MarkAnim holdable={false} />
              <span className="wm">CYBERDECK</span>
              <span className="cap">
                {!settings ? t('shell.app.starting') : settings.torrentsEnabled ? t('shell.app.engineStarting') : t('shell.app.loadingLibrary')}
              </span>
            </div>
          </div>
        )}
        <div className="grain" aria-hidden="true" />
      </div>
    </LangProvider>
  )
}
