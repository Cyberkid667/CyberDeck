import { getLang, locale, t, tn } from '../../shared/i18n'
import { canInstallGame, gameLastPlayedAt, PLATFORM_INFO, PLATFORM_ORDER } from '../../shared/platforms'
import type { Game, GamePlatform, LibraryState, PlatformsState } from '../../shared/types'

// Règles d'affichage des plateformes propres à l'interface : vues « Installés » /
// « Tous », filtres de la barre latérale, état d'un jeu (carte, bandeau, menu),
// tri « Joués récemment ».

/** « Installés » : jeux sur ce PC ; « Tous » : avec les jeux Steam possédés mais pas installés. */
export type LibraryShow = 'installed' | 'owned'
/** Filtre de la bibliothèque : tous les jeux ou une plateforme (dont « Local »). */
export type LibraryFilter = 'all' | GamePlatform

/** Ordre des filtres de la barre latérale : les lanceurs (ordre fixe), puis les jeux locaux. */
export const FILTER_ORDER: GamePlatform[] = [...PLATFORM_ORDER, 'local']

export const platformName = (p: GamePlatform): string => PLATFORM_INFO[p].name

/**
 * Français : « de Steam », « d’Epic Games », « d’Ubisoft Connect » (élision devant une voyelle) ;
 * anglais : « from Steam ».
 */
export const ofName = (name: string): string =>
  getLang() !== 'fr' ? `from ${name}` : /^[aeiouyàâéèêîôû]/i.test(name) ? `d’${name}` : `de ${name}`

/**
 * Jeu sur ce PC, ou en cours d'installation par sa plateforme (Steam le télécharge) :
 * le jeu reste visible dans « Installés » avec « Téléchargement… » pendant l'installation.
 */
export const onThisPc = (g: Game): boolean => g.installed || g.platformState === 'downloading'

/** Le jeu fait partie de la vue choisie (« Installés » ou « Tous (possédés) »). */
export const inShow = (g: Game, show: LibraryShow): boolean => onThisPc(g) || (show === 'owned' && g.owned === true)

/** Le jeu passe le filtre de la barre latérale. */
export const inFilter = (g: Game, filter: LibraryFilter): boolean => filter === 'all' || g.platform === filter

/** Nombre de jeux par plateforme dans la vue choisie. */
export function platformCounts(games: Game[], show: LibraryShow): Map<GamePlatform, number> {
  const counts = new Map<GamePlatform, number>()
  for (const g of games) if (inShow(g, show)) counts.set(g.platform, (counts.get(g.platform) ?? 0) + 1)
  return counts
}

/**
 * Bascule « Installés / Tous » : seulement quand un compte Steam est relié (clé enregistrée)
 * et qu'il y a quelque chose à montrer en plus (liste possédée lue, ou jeux possédés déjà là).
 */
export function canShowOwned(platforms: PlatformsState | null, games: Game[]): boolean {
  const steam = platforms?.steam
  if (!steam?.hasKey) return false
  return steam.ownedCount !== null || games.some((g) => !onThisPc(g) && g.owned === true)
}

/**
 * État d'un jeu pour l'interface :
 * running : son processus tourne ; launching : lancé par sa plateforme, en attente du jeu (2 min au plus) ;
 * downloading : la plateforme l'installe ; updating : installé, mise à jour demandée ou en cours ;
 * ready : prêt à jouer ; installable : jeu Steam possédé, pas installé ; absent : pas installé, rien à proposer.
 */
export type GameState = 'running' | 'launching' | 'downloading' | 'updating' | 'ready' | 'installable' | 'absent'

export function gameState(g: Game, lib: Pick<LibraryState, 'running' | 'launching'>): GameState {
  if (lib.running[g.id] !== undefined) return 'running'
  if (lib.launching?.[g.id] !== undefined) return 'launching'
  if (g.platformState === 'downloading') return 'downloading'
  if (!g.installed) return canInstallGame(g) ? 'installable' : 'absent'
  if (g.platformState === 'updating') return 'updating'
  return 'ready'
}

/** On peut demander à jouer (le jeu est installé, rien ne tourne déjà). */
export const canPlayState = (s: GameState): boolean => s === 'ready' || s === 'updating'

/** « Jouer via Steam » pour un jeu de plateforme, « Jouer » pour un jeu local. */
export const playLabel = (g: Game): string =>
  g.platform === 'local' ? t('library.common.play') : t('library.common.playVia', { platform: platformName(g.platform) })

/** Dossier du jeu à montrer (bandeau, fiche) : dossier d'installation d'abord (l'exe peut être vide). */
export const gameFolder = (g: Game): string | null => (g.platform === 'local' ? g.exePath || g.installDir : g.installDir || g.exePath || null)

const byName = (a: Game, b: Game): number => a.name.localeCompare(b.name, locale(), { sensitivity: 'base', numeric: true })

/**
 * Tri « Joués récemment » : d'abord les jeux déjà joués, de la dernière partie (CyberDeck ou
 * plateforme) à la plus ancienne ; puis les jeux jamais joués qui sont sur ce PC, du plus récemment
 * ajouté au plus ancien (un jeu tout juste détecté ne passe pas devant la partie d'hier) ; enfin les
 * jeux seulement possédés, par nom (des centaines de jeux possédés ne passent pas devant les jeux installés).
 */
function byRecent(a: Game, b: Game): number {
  const la = gameLastPlayedAt(a) ?? 0
  const lb = gameLastPlayedAt(b) ?? 0
  if (la || lb) return lb - la || byName(a, b)
  const ia = onThisPc(a) ? 1 : 0
  const ib = onThisPc(b) ? 1 : 0
  return ib - ia || (ia ? b.addedAt - a.addedAt : 0) || byName(a, b)
}

export const sortGames = (list: Game[], mode: 'recent' | 'name'): Game[] => list.sort(mode === 'name' ? byName : byRecent)

/** « 1 jeu », « 6 jeux » ; « 1 game », « 6 games » */
export const gamesWord = (n: number): string => tn('library.games.word', n)
