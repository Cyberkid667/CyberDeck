// Types partagés entre le moteur, le processus principal et l'interface.

export type TorrentStatus =
  | 'metadata' // lien magnet : on récupère les infos du torrent
  | 'checking' // vérification des données déjà présentes
  | 'downloading'
  | 'stalled' // en cours mais aucun pair pour l'instant
  | 'seeding'
  | 'paused'
  | 'completed' // terminé et arrêté
  | 'error'

export interface TorrentSummary {
  id: string
  name: string
  size: number
  progress: number
  downloadedTotal: number
  uploadedTotal: number
  downloadSpeed: number
  uploadSpeed: number
  eta: number | null
  status: TorrentStatus
  seeds: number
  seedsTotal: number | null
  peers: number
  peersTotal: number | null
  ratio: number
  savePath: string
  magnetURI: string
  // installateur trouvé dans les fichiers du torrent (chemin complet), sinon null
  installer: string | null
  addedAt: number
  completedAt: number | null
  error: string | null
}

export interface FileInfo {
  name: string
  path: string
  size: number
  progress: number
}

export interface PeerInfo {
  address: string
  client: string
  connection: string
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  isSeeder: boolean
}

export interface TrackerInfo {
  url: string
  status: string
  seeds: number | null
  peers: number | null
  lastUpdate: number | null
}

export interface TorrentDetails {
  id: string
  magnetURI: string
  comment: string | null
  createdBy: string | null
  createdAt: number | null
  pieceCount: number
  pieceLength: number
  files: FileInfo[]
  peers: PeerInfo[]
  trackers: TrackerInfo[]
}

export interface GlobalStats {
  downloadSpeed: number
  uploadSpeed: number
  dhtNodes: number
  peers: number
  port: number
  freeSpace: number | null
}

export interface Snapshot {
  torrents: TorrentSummary[]
  global: GlobalStats
  details: TorrentDetails | null
}

export interface Notice {
  level: 'info' | 'success' | 'error'
  message: string
}

export type AddSource = { kind: 'magnet'; magnet: string } | { kind: 'file'; filePath: string }

export interface AddRequest {
  source: AddSource
  savePath: string
}

export interface AddResult {
  ok: boolean
  error?: string
  id?: string
}

/** Ce que le processus principal lit d'un fichier .torrent, sans rien ajouter (billet du dialogue d'ajout). */
export interface TorrentFileInfo {
  name: string
  /** taille totale du contenu (octets) */
  size: number
  /** nombre de fichiers */
  files: number
  /** nombre de pièces */
  pieces: number
  infoHash: string
  /** taille du fichier .torrent lui-même (octets), si connue */
  fileSize?: number
}

export interface Settings {
  /** dossier de téléchargement proposé par « Ajouter un torrent » */
  defaultSavePath: string
  port: number
  /**
   * Client torrent (fonction facultative). false : le moteur ne démarre pas (aucun port
   * ouvert, donc pas d'alerte du pare-feu de Windows), la rubrique Torrents est masquée.
   * Nouvelle installation : false ; profil repris d'une ancienne version : true seulement
   * si sa liste (state.json) contient au moins un torrent.
   */
  torrentsEnabled: boolean
  /** dossier proposé par « Importer un dossier » ; null = C:\Games s'il existe, sinon Documents */
  gamesFolder: string | null
  /** vérifier au démarrage (puis toutes les 12 h) si une nouvelle version est publiée sur GitHub */
  checkUpdates: boolean
}

/** Réglages modifiables depuis la fenêtre « Réglages » (le reste est géré par l'app). */
export type SettingsPatch = Partial<Pick<Settings, 'torrentsEnabled' | 'defaultSavePath' | 'gamesFolder' | 'checkUpdates'>>

/** Dernière vérification des mises à jour (Release la plus récente du dépôt GitHub). */
export interface UpdateState {
  /** 'idle' : pas encore vérifié ; 'available' : une version plus récente est publiée */
  status: 'idle' | 'checking' | 'current' | 'available' | 'error'
  /** version installée */
  current: string
  /** dernière version publiée (sans « v ») ; null si inconnue */
  latest: string | null
  /** page de la Release à ouvrir pour télécharger */
  url: string | null
  checkedAt: number | null
  error: string | null
}

// ---------- Plateformes de jeux ----------

/**
 * Plateforme d'un jeu de la bibliothèque. 'local' = jeu ajouté à la main, importé
 * d'un dossier ou installé depuis un torrent (comportement d'avant la 0.4).
 */
export type GamePlatform =
  | 'local'
  | 'steam'
  | 'epic'
  | 'gog'
  | 'ea'
  | 'ubisoft'
  | 'battlenet'
  | 'rockstar'
  | 'xbox'
  | 'itch'
  | 'amazon'
  | 'riot'

/** Plateformes détectées automatiquement (toutes sauf 'local'). */
export type LauncherPlatform = Exclude<GamePlatform, 'local'>

/** Comment le processus principal lance un jeu de plateforme. */
export interface GameLaunch {
  /** 'uri' : adresse ouverte par Windows (steam://…, com.epicgames.launcher://…) ;
   *  'exe' : programme + options (lanceur de la plateforme, explorer.exe shell:AppsFolder\…,
   *  ou le jeu lui-même pour GOG sans Galaxy et itch.io). */
  kind: 'uri' | 'exe'
  target: string
  /** ligne d'options brute pour 'exe' */
  args: string | null
  cwd: string | null
}

/** Ce que le processus principal surveille pour savoir si un jeu de plateforme tourne. */
export interface GameWatch {
  /** un processus dont le chemin commence par l'un de ces dossiers = le jeu tourne */
  dirs: string[]
  /** repli quand Windows ne donne pas le chemin d'un processus (jeu lancé en administrateur) */
  names: string[]
  /** processus du dossier à ignorer (ex. éditeur fourni avec le jeu) */
  ignore: string[]
}

// ---------- Bibliothèque de jeux ----------

export interface Game {
  id: string
  name: string
  /** Jeu local : programme lancé. Jeu de plateforme : programme du jeu, seulement pour l'icône
   *  et la surveillance ('' si inconnu, ex. jeu Steam possédé mais pas installé). */
  exePath: string
  // options de lancement (ex. le fichier du jeu pour un émulateur) — jeux locaux seulement
  args: string | null
  installDir: string | null
  torrentId: string | null
  // 0 = pas encore d'image ; change à chaque nouvelle image (évite le cache).
  coverVersion: number
  coverShape: 'portrait' | 'landscape' | null
  iconVersion: number
  // appid Steam : pour un jeu local, sert seulement à trouver la jaquette ; 0 = pas sur Steam
  steamAppId: number | null
  // adresse d'une image à utiliser si Steam n'a pas le jeu (jeux de plateforme : essayée en premier)
  coverHint: string | null
  coverTriedAt: number | null
  addedAt: number
  /** dernière partie lancée depuis CyberDeck (ms) */
  lastPlayedAt: number | null
  /** temps de jeu compté par CyberDeck (secondes) */
  playTimeSeconds: number

  // ---- Plateformes (0.4) : valeurs par défaut pour les jeux d'avant ----
  /** 'local' pour les jeux ajoutés à la main / importés / installés depuis un torrent */
  platform: GamePlatform
  /** identifiant sur la plateforme (appid Steam, AppName Epic, AUMID Xbox, uid Battle.net…) ; null si local */
  platformId: string | null
  /** false : jeu possédé mais pas installé (Steam), ou désinstallé depuis (temps de jeu gardé) */
  installed: boolean
  /** Steam : présent dans la liste des jeux possédés du compte (clé Web API) ; null = inconnu */
  owned: boolean | null
  /** lancement par la plateforme ; null = jeu local (exePath + args, comme avant) */
  launch: GameLaunch | null
  /** surveillance « En jeu » d'un jeu de plateforme ; null = jeu local (dossier du jeu) */
  watch: GameWatch | null
  /** temps de jeu total connu de la plateforme (Steam : compte ou ce PC), secondes ; null = inconnu */
  platformPlayTimeSeconds: number | null
  /** dernière partie connue de la plateforme (ms) ; null = inconnu */
  platformLastPlayedAt: number | null
  /** opération en cours côté plateforme (Steam : téléchargement ou mise à jour) */
  platformState: 'downloading' | 'updating' | null
  /** icône à télécharger quand il n'y a pas de programme (jeu Steam possédé non installé) */
  iconHint: string | null
}

export interface LibraryState {
  games: Game[]
  // jeu en cours → heure de début (processus du jeu vu)
  running: Record<string, number>
  // jeu de plateforme lancé mais pas encore vu (le lanceur démarre, jusqu'à 2 min) → heure du clic
  launching: Record<string, number>
  // torrents dont l'installateur tourne
  installing: string[]
}

// ---------- État des plateformes (« 02 · Bibliothèque ») ----------

/**
 * Pourquoi un élément trouvé sur une plateforme n'est pas devenu un jeu de la bibliothèque :
 * tool : outil, redistribuable, serveur, SDK ; app : logiciel ; dlc : DLC, extension ;
 * other : vidéo, musique, démo, inconnu ; local : déjà dans les jeux locaux ;
 * platform : déjà ajouté par une autre plateforme.
 */
export type PlatformSkipReason = 'tool' | 'app' | 'dlc' | 'other' | 'local' | 'platform'

export interface PlatformSkip {
  name: string
  reason: PlatformSkipReason
  /** reason 'platform' : la plateforme qui a déjà ce jeu */
  other?: GamePlatform
}

export interface PlatformStatus {
  id: LauncherPlatform
  /** nom affiché (« Steam », « Epic Games »…) */
  name: string
  /** 'detected' : lanceur ou jeux trouvés ; 'absent' : rien sur ce PC ; 'error' : lecture impossible */
  state: 'detected' | 'absent' | 'error'
  /** programme du lanceur trouvé, null si absent */
  clientPath: string | null
  /** jeux installés trouvés au dernier passage (outils, doublons et jeux masqués exclus) */
  installedCount: number
  /** éléments écartés car ce ne sont pas des jeux : outils, redistribuables, serveurs, logiciels, DLC */
  excludedCount: number
  /** jeux déjà dans la bibliothèque (jeux locaux ou autre plateforme) : pas ajoutés une seconde fois */
  duplicateCount: number
  /** détail des éléments écartés et des doublons, avec la raison (40 noms au plus) */
  skipped: PlatformSkip[]
  /** message en français si state = 'error' */
  error: string | null
  scannedAt: number | null
}

export type SteamAccountStatus =
  | 'no-account' // aucun compte Steam trouvé sur ce PC
  | 'no-key' // compte trouvé, pas de clé Web API enregistrée
  | 'checking' // lecture de la liste en cours
  | 'ok'
  | 'invalid-key' // clé refusée par Steam
  | 'private' // profil ou « détails des jeux » privés
  | 'offline' // Steam injoignable (pas d'Internet)
  | 'error' // autre erreur (message)
  | 'unavailable' // Windows ne peut pas chiffrer la clé : impossible de l'enregistrer

export interface SteamAccountState {
  /** un compte Steam a été trouvé sur ce PC */
  detected: boolean
  /** SteamID64 (texte : dépasse la précision des nombres JavaScript) */
  steamId: string | null
  /** pseudo Steam lu sur ce PC */
  personaName: string | null
  /** essaim://avatar/steam?v=… si l'avatar est en cache sur ce PC */
  avatarUrl: string | null
  hasKey: boolean
  /** false : safeStorage indisponible, la clé ne peut pas être enregistrée */
  canStoreKey: boolean
  status: SteamAccountStatus
  /** phrase en français à afficher (erreur ou résumé) */
  message: string | null
  /** jeux possédés (outils et logiciels exclus) ; null = inconnu */
  ownedCount: number | null
  /** dont pas installés sur ce PC */
  ownedNotInstalledCount: number | null
  lastRefreshAt: number | null
}

export interface PlatformsState {
  /** les 11 plateformes, toujours dans le même ordre (PLATFORM_ORDER) */
  platforms: PlatformStatus[]
  /** une lecture des plateformes est en cours */
  syncing: boolean
  lastSyncAt: number | null
  steam: SteamAccountState
  /** jeux de plateforme retirés de la bibliothèque par l'utilisateur (non rajoutés) */
  hiddenCount: number
}

export interface SteamKeyResult {
  ok: boolean
  status: SteamAccountStatus
  /** phrase en français */
  message: string
  /** nombre de jeux possédés lus avec cette clé */
  gameCount?: number
  account: SteamAccountState
}

export interface ActionResult {
  ok: boolean
  error?: string
}

export interface GameInput {
  name: string
  exePath: string
  args?: string | null
  installDir?: string | null
  torrentId?: string | null
  steamAppId?: number | null
  coverHint?: string | null
}

// Un sous-dossier trouvé par « Importer un dossier ».
export interface ScanCandidate {
  folder: string
  kind: 'game' | 'installer' | 'tool' | 'empty'
  name: string
  exePath: string | null
  args: string | null
  exeOptions: string[]
  installDir: string
  alreadyInLibrary: boolean
}

export interface InstallResult {
  torrentId: string
  ok: boolean
  error?: string
  guess: { name: string; exePath: string | null; installDir: string | null }
}

// Messages entre le processus principal et le moteur (utilityProcess).
export type ToEngine =
  | { type: 'init'; dataDir: string; port: number; defaultSavePath: string }
  | { type: 'add'; requestId: number; request: AddRequest }
  | { type: 'pause'; ids: string[] }
  | { type: 'resume'; ids: string[] }
  | { type: 'remove'; ids: string[]; deleteFiles: boolean }
  | { type: 'select'; id: string | null }
  | { type: 'set-default-path'; path: string }
  // Ferme les fichiers d'un torrent (pause) pour qu'un installateur ou un jeu puisse les utiliser.
  | { type: 'release'; requestId: number; id: string }
  | { type: 'shutdown' }

export type FromEngine =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'added'; requestId: number; result: AddResult }
  | { type: 'notice'; notice: Notice }
  | { type: 'log'; message: string }
  | { type: 'trash'; files: string[]; dirs: string[] }
  | { type: 'released'; requestId: number; wasRunning: boolean }
  | { type: 'shutdown-done' }

// API exposée à l'interface par le preload (window.essaim).
export interface EssaimApi {
  onSnapshot(cb: (s: Snapshot) => void): () => void
  onNotice(cb: (n: Notice) => void): () => void
  getSettings(): Promise<Settings>
  /** applique et enregistre des réglages (torrents : démarre ou arrête le moteur) ; renvoie les réglages à jour */
  setSettings(patch: SettingsPatch): Promise<Settings>
  /** réglages changés (fenêtre Réglages, dossier choisi dans « Ajouter un torrent »…) */
  onSettings(cb: (s: Settings) => void): () => void
  pickTorrentFile(): Promise<string | null>
  /** title : titre de la fenêtre de Windows (par défaut « Dossier de destination ») */
  pickFolder(defaultPath: string, title?: string): Promise<string | null>
  readClipboardMagnet(): Promise<string | null>
  pathForFile(file: File): string
  /** lecture locale d'un .torrent (nom, taille, fichiers, pièces, empreinte) ; null s'il est illisible */
  inspectTorrentFile(path: string): Promise<TorrentFileInfo | null>
  add(req: AddRequest): Promise<AddResult>
  pause(ids: string[]): void
  resume(ids: string[]): void
  remove(ids: string[], deleteFiles: boolean): void
  select(id: string | null): void
  openFolder(id: string): void
  copyText(text: string): void

  getLibrary(): Promise<LibraryState>
  onLibrary(cb: (s: LibraryState) => void): () => void
  onInstallDone(cb: (r: InstallResult) => void): () => void
  installTorrent(torrentId: string): void
  addGame(input: GameInput): Promise<Game>
  updateGame(id: string, input: GameInput): Promise<Game | null>
  removeGame(id: string): void
  playGame(id: string): void
  openGameFolder(id: string): void
  searchCover(id: string): Promise<boolean>
  setCoverFromFile(id: string, file: string): Promise<boolean>
  pickExe(defaultPath?: string): Promise<string | null>
  pickImage(): Promise<string | null>
  scanGamesFolder(dir: string): Promise<ScanCandidate[]>
  importGames(inputs: GameInput[]): Promise<number>
  defaultGamesFolder(): Promise<string>

  // ---- Plateformes (Steam, Epic, GOG, EA, Ubisoft, Battle.net, Rockstar, Xbox, itch.io, Amazon, Riot) ----
  getPlatforms(): Promise<PlatformsState>
  onPlatforms(cb: (s: PlatformsState) => void): () => void
  /** relit toutes les plateformes (et la liste Steam possédée) ; répond quand c'est fini */
  syncPlatforms(): Promise<PlatformsState>
  /** jeu Steam possédé non installé : ouvre la fenêtre d'installation de Steam */
  installGame(id: string): Promise<ActionResult>
  /** remet dans la bibliothèque les jeux de plateforme retirés à la main ; renvoie leur nombre */
  restoreHiddenGames(): Promise<number>
  /** vérifie la clé auprès de Steam, l'enregistre chiffrée si elle est bonne, puis lit les jeux possédés */
  setSteamApiKey(key: string): Promise<SteamKeyResult>
  /** teste une clé (ou la clé enregistrée si key est absent) sans rien enregistrer */
  testSteamApiKey(key?: string): Promise<SteamKeyResult>
  /** oublie la clé et retire les jeux possédés non installés (sans historique) */
  clearSteamApiKey(): Promise<SteamAccountState>
  /** relit la liste des jeux possédés maintenant */
  refreshSteamOwned(): Promise<SteamAccountState>
  /** ouvre https://steamcommunity.com/dev/apikey dans le navigateur */
  openSteamApiKeyPage(): void

  // ---- Mises à jour (Release la plus récente sur GitHub) ----
  getUpdate(): Promise<UpdateState>
  onUpdate(cb: (u: UpdateState) => void): () => void
  /** vérifie maintenant, même si la vérification automatique est désactivée */
  checkUpdate(): Promise<UpdateState>
  /** ouvre la page de téléchargement dans le navigateur */
  openUpdate(): void
}
