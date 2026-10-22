import { Download, Ellipsis, LoaderCircle, Play, RefreshCw } from 'lucide-react'
import { memo } from 'react'
import { gameLastPlayedAt, gamePlayTimeSeconds } from '../../../shared/platforms'
import type { Game } from '../../../shared/types'
import { formatLastPlayed, formatPlayTimeShort } from '../format'
import { platformName, type GameState } from '../platformUi'
import { Cover } from './Cover'
import { PlatformLogo } from './PlatformLogo'

// Carte-billet d'un jeu (SPEC 5.10) : jaquette 2:3 + talon perforé (nom Inter
// 500 13/16, relevé mono 11 « 3 h 05 · hier »), sans code-barres ni numéro.
// L'étiquette de plateforme (STEAM, EPIC… LOCAL) est posée à cheval sur la perforation.
// Survol / focus clavier : la carte monte de 3 px, voile avec « ▶ JOUER » et
// bouton « … » (menu du jeu). Jeu lancé : bord blanc + halo, puce « ● EN JEU »
// en haut à gauche, relevé en direct « ● En jeu · 00:14:36 » (même chrono que
// le bandeau). Jeu de plateforme lancé, en attente de son processus : puce
// « DÉMARRAGE… ». Jeu pas installé : billet fantôme (bord en tirets, jaquette
// éteinte en gris) et « INSTALLER » (contour) à la place de « JOUER ».
// Entrée ou double-clic = action principale ; clic droit, « … », touche Menu
// ou Maj+F10 = menu. Mémoïsée : seule la carte du jeu lancé se redessine chaque seconde.

interface Props {
  game: Game
  state: GameState
  /** chrono de la session en cours (« 00:14:36 ») quand le jeu tourne */
  session: string | null
  /** jour courant : change à minuit pour que « aujourd’hui » devienne « hier » */
  today: number
  /** le menu de ce jeu est ouvert : la carte garde son aspect survolé */
  menuOpen: boolean
  onPlay: (game: Game) => void
  onInstall: (game: Game) => void
  onMenu: (game: Game, x: number, y: number) => void
}

/**
 * Relevé du talon : « < 1 min · aujourd’hui », « 3 h 05 · hier », « 235 h · il y a 2 j »,
 * « Jamais joué ». full : texte complet pour la bulle (« 235 h 49 · il y a 2 jours »).
 */
export function cardMeta(g: Game, full = false): string {
  const seconds = gamePlayTimeSeconds(g)
  const last = formatLastPlayed(gameLastPlayedAt(g), Date.now(), full)
  if (!seconds) return last ? `Lancé ${last}` : formatPlayTimeShort(0)
  const time = formatPlayTimeShort(seconds, full)
  return last ? `${time} · ${last}` : time
}

/**
 * Relevé d'un jeu pas installé : « Pas installé », « Pas installé · 42 min », « Pas installé · 12 h »
 * (heures seules : le talon le plus étroit tient 21 caractères). full : « Pas installé · 12 h 30 » (bulle).
 */
function absentMeta(g: Game, full = false): string {
  const seconds = gamePlayTimeSeconds(g)
  if (!seconds || (!full && seconds < 60)) return 'Pas installé'
  if (full) return `Pas installé · ${formatPlayTimeShort(seconds, true)}`
  const m = Math.round(seconds / 60)
  return `Pas installé · ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`}`
}

const stop = (e: React.SyntheticEvent): void => e.stopPropagation()

/** Puce d'état en haut à gauche de la jaquette (EN JEU, DÉMARRAGE…, TÉLÉCHARGEMENT…, MISE À JOUR). */
function StateChip({ state }: { state: GameState }): React.JSX.Element | null {
  if (state === 'running')
    return (
      <span className="live-chip sm badge" aria-hidden="true">
        <span className="live-dot" />
        En jeu
      </span>
    )
  if (state === 'launching' || state === 'downloading')
    return (
      <span className="live-chip sm badge busy" aria-hidden="true">
        <LoaderCircle className="spin" />
        {state === 'launching' ? 'Démarrage…' : 'Téléchargement…'}
      </span>
    )
  if (state === 'updating')
    return (
      <span className="live-chip sm badge quiet" aria-hidden="true">
        <RefreshCw />
        Mise à jour
      </span>
    )
  return null
}

function GameCardBase({ game: g, state, session, menuOpen, onPlay, onInstall, onMenu }: Props): React.JSX.Element {
  const menuAt = (el: HTMLElement, fromButton: boolean): void => {
    const r = el.getBoundingClientRect()
    if (fromButton) onMenu(g, r.left, r.bottom + 4)
    else onMenu(g, r.left + 12, r.top + 12)
  }
  const live = state === 'running'
  const absent = state === 'installable' || state === 'absent' || state === 'downloading'
  const via = g.platform === 'local' ? '' : ` via ${platformName(g.platform)}`
  /** action principale (Entrée, double-clic) */
  const primary = (): void => {
    if (state === 'installable') onInstall(g)
    else if (state === 'ready' || state === 'updating') onPlay(g)
  }
  const label =
    state === 'running'
      ? `${g.name}, en jeu`
      : state === 'launching'
        ? `${g.name}, démarrage${via}`
        : state === 'downloading'
          ? `${g.name}, téléchargement en cours`
          : absent
            ? `${g.name}, pas installé`
            : g.name

  let overlay: React.ReactNode
  if (state === 'running')
    overlay = (
      <span className="live-chip">
        <span className="live-dot" />
        En jeu
      </span>
    )
  else if (state === 'launching' || state === 'downloading')
    overlay = (
      <span className="live-chip busy">
        <LoaderCircle className="spin" />
        {state === 'launching' ? 'Démarrage…' : 'Téléchargement…'}
      </span>
    )
  else if (state === 'installable')
    overlay = (
      <button
        type="button"
        className="playbtn install"
        data-testid="game-install"
        tabIndex={-1}
        title={`Installer ${g.name} avec Steam`}
        aria-label={`Installer ${g.name}`}
        onClick={(e) => {
          e.stopPropagation()
          onInstall(g)
        }}
        onDoubleClick={stop}
      >
        <Download />
        Installer
      </button>
    )
  else if (state === 'absent')
    overlay = <span className="live-chip quiet">Non installé</span>
  else
    overlay = (
      <button
        type="button"
        className="playbtn"
        data-testid="game-play"
        tabIndex={-1}
        title={`Jouer à ${g.name}${via}`}
        aria-label={`Jouer à ${g.name}${via}`}
        onClick={(e) => {
          e.stopPropagation()
          onPlay(g)
        }}
        onDoubleClick={stop}
      >
        <Play />
        Jouer
      </button>
    )

  return (
    <article
      className={`gcard${live ? ' live' : ''}${state === 'launching' ? ' launching' : ''}${absent ? ' absent' : ''}${menuOpen ? ' hover' : ''}`}
      data-testid="game-card"
      data-id={g.id}
      data-platform={g.platform}
      data-state={state}
      tabIndex={0}
      title={g.name}
      aria-label={label}
      onDoubleClick={primary}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(g, e.clientX, e.clientY)
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') {
          e.preventDefault()
          primary()
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault()
          menuAt(e.currentTarget, false)
        }
      }}
    >
      <Cover game={g}>
        <StateChip state={state} />
        <button
          type="button"
          className="more"
          title="Plus d’actions"
          aria-label={`Plus d’actions pour ${g.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation()
            menuAt(e.currentTarget, true)
          }}
          onDoubleClick={stop}
        >
          <Ellipsis />
        </button>
        <div className="ov">{overlay}</div>
        {/* grand logo de la plateforme, sans cadre : on voit d'un coup d'œil où le jeu est installé */}
        <span
          className="pbig"
          data-testid="platform-badge"
          data-platform={g.platform}
          title={g.platform === 'local' ? 'Jeu local : lancé directement par CyberDeck' : `Jeu ${platformName(g.platform)}`}
        >
          <PlatformLogo platform={g.platform} />
        </span>
      </Cover>
      <div className="stub">
        <div className="gname">{g.name}</div>
        {live ? (
          <div className="gmeta live">
            <span className="live-dot" />
            <span className="t">En jeu · {session}</span>
          </div>
        ) : state === 'launching' ? (
          // mêmes mots que la puce ; la plateforme est sur l'étiquette du talon (et dans la bulle)
          <div className="gmeta live">
            <span className="t" title={`Démarrage${via}…`}>
              Démarrage…
            </span>
          </div>
        ) : state === 'downloading' ? (
          <div className="gmeta">
            <span className="t" title={g.platform === 'local' ? 'Téléchargement…' : `Téléchargement par ${platformName(g.platform)}…`}>
              Téléchargement…
            </span>
          </div>
        ) : (
          <div className="gmeta">
            <span className="t" title={absent ? absentMeta(g, true) : cardMeta(g, true)}>
              {absent ? absentMeta(g) : cardMeta(g)}
            </span>
          </div>
        )}
      </div>
    </article>
  )
}

export const GameCard = memo(GameCardBase)
