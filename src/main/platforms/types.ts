// Types internes de la détection des plateformes (processus principal).
import type { GameLaunch, LauncherPlatform, PlatformSkip } from '../../shared/types'
import type { RegistrySnapshot } from './registry'

/** Un jeu trouvé sur une plateforme. */
export interface DetectedGame {
  platform: LauncherPlatform
  /** identifiant stable sur la plateforme (appid, AppName, AUMID, uid…) */
  platformId: string
  name: string
  installDir: string | null
  /** programme du jeu (icône, nom de processus) ; null si inconnu */
  exePath: string | null
  launch: GameLaunch
  /** dossiers surveillés pour « En jeu » */
  watchDirs: string[]
  /** noms de processus de repli (chemin illisible) */
  processNames: string[]
  ignoreNames?: string[]
  installed: boolean
  /** Steam : présent dans la liste des jeux possédés ; undefined = inconnu */
  owned?: boolean
  steamAppId?: number | null
  coverHint?: string | null
  iconHint?: string | null
  playTimeSeconds?: number | null
  lastPlayedAt?: number | null
  state?: 'downloading' | 'updating' | null
  /** Xbox : AUMID, pour reconnaître un jeu local lancé par shell:AppsFolder */
  aumid?: string
  /** autres dossiers qui désignent le même jeu (jonction WindowsApps → C:\XboxGames) */
  altDirs?: string[]
}

export interface PlatformScan {
  platform: LauncherPlatform
  /** false : la lecture a échoué ; on ne marque alors aucun jeu comme désinstallé */
  ok: boolean
  clientPath: string | null
  /** lanceur présent ou jeux trouvés */
  detected: boolean
  games: DetectedGame[]
  /** éléments écartés parce que ce ne sont pas des jeux (outils, redistribuables, serveurs, logiciels, DLC) */
  excluded: number
  /** détail des éléments écartés et des doublons (voir skip() dans util.ts) */
  skipped?: PlatformSkip[]
  error: string | null
  /** Steam : la liste des jeux possédés a été lue avec succès pendant ce passage */
  ownedKnown?: boolean
  /** jeux dont le fichier n'a pas pu être lu ce passage (en cours d'écriture…) : jamais marqués désinstallés */
  keep?: string[]
  /** lecture incomplète (fichier illisible dont on ignore le jeu) : aucun jeu marqué désinstallé ce passage */
  partial?: boolean
  /** relire bientôt cette plateforme (fichier en cours d'écriture) */
  retry?: boolean
}

export interface ScanContext {
  reg: RegistrySnapshot
  log: (message: string) => void
  /** dossier temporaire pour les copies de bases SQLite */
  tempDir: string
}
