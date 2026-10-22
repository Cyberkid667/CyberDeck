import { ArrowDown, ArrowDownUp, ArrowUp, Blocks, Check, Gamepad2, LoaderCircle, Settings, type LucideIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { GamePlatform } from '../../../shared/types'
import { filterLabel, type Filter } from '../format'
import { useT } from '../i18n'
import { gamesWord, platformName, type LibraryFilter } from '../platformUi'
import { useScrollFade } from '../useScrollFade'
import { PlatformLogo } from './PlatformLogo'
import { Scope } from './Scope'

// Barre latérale en faux verre : une seule section « BIBLIOTHÈQUE » avec deux
// rubriques sur le même modèle, compteurs, point vivant quand un jeu tourne,
// oscilloscope « TRAFIC · 60 S ». Sous « Mes jeux », un filtre par
// plateforme qui a des jeux (logo de la plateforme, nom, nombre de jeux) ;
// sous « Torrents », En cours / Terminés / En partage quand ils contiennent quelque
// chose (ou que le filtre est choisi). La rubrique Torrents n'existe que si les torrents
// sont activés (Réglages), et l'oscilloscope n'apparaît que dans la vue Torrents. Puis
// « Plateformes » (fenêtre des lanceurs) et « Réglages » : toujours visibles, hors de la
// liste qui défile. Sous 1100 px : rail de 60 px (icône au-dessus du compteur,
// logo seul pour les plateformes, libellés en title), sans oscilloscope ni pied. Si la
// liste ne tient pas en hauteur, elle défile (sans barre visible, fondu en bas).

// Sous-rubriques des torrents ; l'icône reste seule dans le rail (< 1100 px).
const TORRENT_SUBS: { id: Exclude<Filter, 'all'>; icon: LucideIcon }[] = [
  { id: 'active', icon: ArrowDown },
  { id: 'done', icon: Check },
  { id: 'seeding', icon: ArrowUp }
]

export type View = 'torrents' | 'library'

export interface Traffic {
  /** réception globale (octets/s) */
  down: number
  /** émission globale (octets/s) */
  up: number
  /** heure du dernier instantané (0 = aucun) : un échantillon par instantané */
  stamp: number
}

export interface LibNavItem {
  id: GamePlatform
  /** jeux de cette plateforme dans la vue choisie (Installés / Tous) */
  count: number
}

interface Props {
  view: View
  filter: Filter
  counts: Record<Filter, number>
  /** jeux de la vue choisie (« Mes jeux ») */
  gameCount: number
  playing: boolean
  onFilter: (f: Filter) => void
  /** filtre de la bibliothèque (tous les jeux ou une plateforme) */
  libFilter: LibraryFilter
  /** plateformes qui ont des jeux, dans l'ordre fixe ; vide s'il n'y a qu'une sorte de jeux */
  libNav: LibNavItem[]
  onLibrary: (f: LibraryFilter) => void
  /** ouvre la fenêtre « Plateformes » */
  onPlatforms: () => void
  /** ouvre la fenêtre « Réglages » */
  onSettings: () => void
  /** une lecture des plateformes est en cours */
  syncing: boolean
  /** client torrent activé (Réglages) : sinon ni rubrique Torrents ni oscilloscope */
  torrentsEnabled: boolean
  traffic: Traffic
}

export function Sidebar({
  view,
  filter,
  counts,
  gameCount,
  playing,
  onFilter,
  libFilter,
  libNav,
  onLibrary,
  onPlatforms,
  onSettings,
  syncing,
  torrentsEnabled,
  traffic
}: Props): React.JSX.Element {
  const { t } = useT()
  const navRef = useRef<HTMLDivElement>(null)
  const torrentNav = torrentsEnabled ? TORRENT_SUBS.filter((s) => counts[s.id] > 0 || (view === 'torrents' && filter === s.id)) : []
  const treeSize = libNav.length + torrentNav.length
  useScrollFade(navRef, [...libNav.map((n) => n.id), ...torrentNav.map((s) => s.id)].join(','))

  // le filtre actif reste visible quand la liste défile
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('.nav.on')?.scrollIntoView({ block: 'nearest' })
  }, [view, filter, libFilter])

  return (
    <nav
      className={`sidebar${view === 'library' ? ' lib-view' : ''}`}
      aria-label={t('shell.sidebar.navigation')}
    >
      <div className="side-nav" ref={navRef}>
        <div className="side-sec">
          <span className="cap">{t('shell.sidebar.library')}</span>
          <span className="rule" />
        </div>
        <button
          type="button"
          className={`nav${view === 'library' && libFilter === 'all' ? ' on' : ''}`}
          title={playing ? t('shell.sidebar.myGamesPlaying') : t('shell.sidebar.myGames')}
          aria-current={view === 'library' && libFilter === 'all' ? 'page' : undefined}
          data-testid="nav-library"
          onClick={() => onLibrary('all')}
        >
          <Gamepad2 />
          <span className="label">{t('shell.sidebar.myGames')}</span>
          {playing && <span className="live-dot" title={t('shell.sidebar.gameRunning')} />}
          <span className="count">{gameCount}</span>
        </button>
        {libNav.length > 0 && (
          <div className="side-tree" role="group" aria-label={t('shell.sidebar.filterPlatform')}>
            {libNav.map((item) => {
              const on = view === 'library' && libFilter === item.id
              const name = platformName(item.id)
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`nav sub${on ? ' on' : ''}`}
                  title={`${name} · ${item.count} ${gamesWord(item.count)}`}
                  aria-label={`${name}, ${item.count} ${gamesWord(item.count)}`}
                  aria-current={on ? 'page' : undefined}
                  data-testid={`nav-platform-${item.id}`}
                  onClick={() => onLibrary(item.id)}
                >
                  <PlatformLogo platform={item.id} />
                  <span className="label">{name}</span>
                  <span className="count">{item.count}</span>
                </button>
              )
            })}
          </div>
        )}
        {torrentsEnabled && (
          <button
            type="button"
            className={`nav rubric${view === 'torrents' && filter === 'all' ? ' on' : ''}`}
            title="Torrents"
            aria-current={view === 'torrents' && filter === 'all' ? 'page' : undefined}
            data-testid="nav-filter-all"
            onClick={() => onFilter('all')}
          >
            <ArrowDownUp />
            <span className="label">Torrents</span>
            <span className="count">{counts.all}</span>
          </button>
        )}
        {torrentNav.length > 0 && (
          <div className="side-tree" role="group" aria-label={t('shell.sidebar.filterTorrents')}>
            {torrentNav.map((s) => {
              const on = view === 'torrents' && filter === s.id
              const label = filterLabel(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`nav sub${on ? ' on' : ''}`}
                  title={`${label} · ${counts[s.id]}`}
                  aria-label={`${label}, ${counts[s.id]}`}
                  aria-current={on ? 'page' : undefined}
                  data-testid={`nav-filter-${s.id}`}
                  onClick={() => onFilter(s.id)}
                >
                  <s.icon className="plogo" aria-hidden="true" />
                  <span className="label">{label}</span>
                  <span className="count">{counts[s.id]}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      {/* hors de la liste qui défile : toujours visible, même avec 11 plateformes dans une fenêtre basse */}
      <button
        type="button"
        className="nav plat-nav"
        title={syncing ? t('shell.sidebar.platformsSyncing') : t('shell.sidebar.platformsTitle')}
        aria-label={t('shell.sidebar.platforms')}
        data-testid="nav-platforms"
        onClick={onPlatforms}
      >
        {syncing ? <LoaderCircle className="spin" /> : <Blocks />}
        <span className="label">{t('shell.sidebar.platforms')}</span>
      </button>
      <button
        type="button"
        className="nav plat-nav set-nav"
        title={t('shell.sidebar.settingsTitle')}
        aria-label={t('shell.sidebar.settings')}
        data-testid="nav-settings"
        onClick={onSettings}
      >
        <Settings />
        <span className="label">{t('shell.sidebar.settings')}</span>
      </button>
      <div className="side-fill" />
      {/* vue Torrents seulement (masqué par le CSS dans la bibliothèque, l'historique des 60 s est gardé) */}
      {torrentsEnabled && <Scope down={traffic.down} up={traffic.up} stamp={traffic.stamp} />}
    </nav>
  )
}
