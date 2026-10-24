// Noms des plateformes et petites règles d'affichage communes au processus
// principal et à l'interface.
import type { Game, GamePlatform, LauncherPlatform } from './types'

/** Ordre fixe des plateformes (filtres de la barre latérale, état des plateformes). */
export const PLATFORM_ORDER: LauncherPlatform[] = [
  'steam',
  'epic',
  'gog',
  'ea',
  'ubisoft',
  'battlenet',
  'rockstar',
  'xbox',
  'itch',
  'amazon',
  'riot'
]

/** Plateformes lues sur ce système (process.platform) : toutes sous Windows, Steam seul ailleurs (Linux). */
export const platformsFor = (os: string): LauncherPlatform[] => (os === 'win32' ? PLATFORM_ORDER : ['steam'])

/** name : nom complet ; short : badge en capitales (IBM Plex Mono). */
export const PLATFORM_INFO: Record<GamePlatform, { name: string; short: string }> = {
  local: { name: 'Local', short: 'LOCAL' },
  steam: { name: 'Steam', short: 'STEAM' },
  epic: { name: 'Epic Games', short: 'EPIC' },
  gog: { name: 'GOG', short: 'GOG' },
  ea: { name: 'EA app', short: 'EA' },
  ubisoft: { name: 'Ubisoft Connect', short: 'UBISOFT' },
  battlenet: { name: 'Battle.net', short: 'BATTLE.NET' },
  rockstar: { name: 'Rockstar Games', short: 'ROCKSTAR' },
  xbox: { name: 'Xbox', short: 'XBOX' },
  itch: { name: 'itch.io', short: 'ITCH.IO' },
  amazon: { name: 'Amazon Games', short: 'AMAZON' },
  riot: { name: 'Riot Games', short: 'RIOT' }
}

/** Vue « Installés » : le jeu est sur ce PC. */
export const isInstalledGame = (g: Game): boolean => g.installed

/** Vue « Tous (possédés) » : installé, ou possédé sur Steam (compte relié). Les jeux
 *  désinstallés qui ne sont plus possédés restent dans library.json (historique) mais
 *  ne sont montrés dans aucune vue. */
export const isOwnedGame = (g: Game): boolean => g.installed || g.owned === true

/** Bouton « Installer » : jeu Steam possédé mais pas installé. */
export const canInstallGame = (g: Game): boolean => !g.installed && g.platform === 'steam' && !!g.platformId

/** Temps de jeu à afficher : le plus grand entre CyberDeck et la plateforme
 *  (une partie lancée par CyberDeck passe par Steam : pas d'addition). */
export const gamePlayTimeSeconds = (g: Game): number => Math.max(g.playTimeSeconds, g.platformPlayTimeSeconds ?? 0)

/** Dernière partie connue (CyberDeck ou plateforme). */
export function gameLastPlayedAt(g: Game): number | null {
  const a = g.lastPlayedAt ?? 0
  const b = g.platformLastPlayedAt ?? 0
  return Math.max(a, b) || null
}
