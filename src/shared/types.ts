// Types partagés entre le moteur, le processus principal et l'interface.
import type { Lang } from './i18n'

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
  /**
   * Pays du pair (ISO 3166-1 alpha-2, « FR »), trouvé HORS LIGNE dans la table DB-IP livrée
   * avec l'app (main/geoip.ts) ; absent pour une adresse inconnue, privée ou une source web.
   */
  country?: string
  /** position sur le globe (degrés) : point du pays + petit écart stable tiré de l'adresse */
  lat?: number
  lon?: number
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
  /** langue de l'interface (anglais par défaut) */
  language: Lang
}

/** Réglages modifiables depuis la fenêtre « Réglages » (le reste est géré par l'app). */
export type SettingsPatch = Partial<Pick<Settings, 'torrentsEnabled' | 'defaultSavePath' | 'gamesFolder' | 'checkUpdates' | 'language'>>

// ---------- Page détaillée d'un jeu (passe 3) ----------

/**
 * Lien de la page d'un jeu. Le libellé est traduit par l'interface d'après l'id (le nom de la
 * plateforme est ajouté pour 'launcher'). Ouvert par openExternalLink : les pages Steam s'ouvrent
 * dans le client Steam quand il est installé.
 */
export type GameLinkId =
  | 'store' // page du jeu sur la boutique de sa plateforme
  | 'dlc' // contenus additionnels
  | 'hub' // centre de la communauté
  | 'points' // boutique des points
  | 'discussions'
  | 'guides'
  | 'workshop' // seulement si le jeu le propose
  | 'support'
  | 'news' // toutes les actualités
  | 'achievements' // « mes succès » (profil Steam)
  | 'website' // site officiel du jeu
  | 'launcher' // ouvrir le jeu dans son lanceur (Epic, GOG Galaxy, Battle.net, Microsoft Store…)

export interface GameLink {
  id: GameLinkId
  url: string
}

export interface GameNewsItem {
  id: string
  title: string
  url: string
  /** date de publication (ms) */
  date: number
  /** type d'actualité tel que donné par la source (« Patch notes », « Community Announcements »…) */
  feed: string
  /** début du texte, sans balises, quelques phrases */
  excerpt: string
  /** image d'illustration (hôte de IMAGE_HOSTS) ou null */
  image: string | null
}

export interface GameAchievement {
  id: string
  name: string
  description: string
  /** icône (couleur si débloqué, grisée sinon), hôte de IMAGE_HOSTS */
  icon: string | null
  achieved: boolean
  /** date de déblocage (ms) ou null */
  unlockedAt: number | null
}

export interface GameFriend {
  steamid: string
  name: string
  avatar: string | null
}

export interface GameDetails {
  gameId: string
  /** appid Steam d'où viennent les infos (jeu Steam, ou jeu d'une autre plateforme trouvé sur Steam) ; 0 si aucun */
  steamAppId: number
  /** grande image de fond (bandeau) ; null : l'interface utilise la jaquette floutée */
  heroUrl: string | null
  /** logo du jeu (titre dessiné) ; null : l'interface écrit le nom */
  logoUrl: string | null
  /** présentation courte, texte brut */
  description: string | null
  developers: string[]
  publishers: string[]
  /** date de sortie telle que donnée par la source (texte) */
  releaseDate: string | null
  genres: string[]
  links: GameLink[]
  /** actualités récentes (5 au plus), de la plus récente à la plus ancienne */
  news: GameNewsItem[]
  /** null : pas de clé d'API Steam, jeu sans succès, ou plateforme sans succès lisibles */
  achievements: { unlocked: number; total: number; items: GameAchievement[] } | null
  /** null : pas de clé d'API Steam ou liste d'amis privée */
  friends: { playingNow: GameFriend[]; played: GameFriend[]; total: number } | null
  /** contenus additionnels connus (nom), le plus récent d'abord */
  dlc: { appid: number; name: string }[]
  /** d'où viennent la présentation et les images */
  source: 'steam' | 'wikipedia' | 'none'
  fetchedAt: number
  /** problème rencontré (hors ligne…), déjà traduit, ou null */
  error: string | null
}

// ---------- Magasin Steam (vue Steam, onglet MAGASIN) ----------

/** Listes du magasin (barre du magasin) : Offres, Meilleures ventes, Nouveautés, Prochainement. */
export type StoreListKind = 'specials' | 'topsellers' | 'newreleases' | 'comingsoon'

/** 'offline' : pas de réseau ; 'unavailable' : réponse inattendue de Steam ; 'notFound' : jeu absent du magasin (ou pas vendu dans ce pays). */
export type StoreError = 'offline' | 'unavailable' | 'notFound'

/** Prix tel que formaté par Steam dans la devise du pays (choisi par Steam d'après l'adresse IP). */
export interface StorePrice {
  free: boolean
  /** prix payé (« CHF 16.79 ») ; null si gratuit */
  final: string | null
  /** prix avant réduction, seulement s'il y a une réduction */
  original: string | null
  /** réduction en pour cent (0 : aucune) */
  discount: number
}

/** Article du magasin (tuiles, listes, résultats de recherche). Images : hôtes de IMAGE_HOSTS. */
export interface StoreItem {
  appid: number
  name: string
  type: 'game' | 'dlc' | 'demo' | 'software' | 'other'
  /** en-tête 460×215 */
  header: string | null
  /** grande capsule 616×353 (vitrine) */
  capsule: string | null
  /** petite capsule 231×87 (listes) */
  small: string | null
  /** bandeau de la bibliothèque (fond) */
  hero: string | null
  /** null : prix inconnu (pas encore en vente…) */
  price: StorePrice | null
  comingSoon: boolean
  /** date de sortie (ms) ou null */
  releaseDate: number | null
  /** texte de sortie donné par l'éditeur (« Prochainement », « 2027 »…) */
  releaseText: string | null
  /** évaluations des joueurs (libellé traduit par Steam : « Très positives ») ; null : pas assez */
  review: { score: number; label: string; percent: number } | null
  tags: string[]
  description: string | null
  /** quelques captures (vitrine seulement) */
  screenshots: string[]
  platforms: { windows: boolean; mac: boolean; linux: boolean }
  /** contenu pour adultes (filtré par le processus principal, jamais montré) */
  adult: boolean
}

export interface StoreHome {
  /** grand carrousel de la vitrine */
  hero: StoreItem[]
  shelves: Record<StoreListKind, StoreItem[]>
  fetchedAt: number
  error: StoreError | null
}

export interface StoreList {
  kind: StoreListKind
  items: StoreItem[]
  fetchedAt: number
  error: StoreError | null
}

export interface StoreSearch {
  term: string
  items: StoreItem[]
  fetchedAt: number
  error: StoreError | null
}

/** Page d'un jeu du magasin. */
export interface StoreApp {
  appid: number
  name: string
  /** article (évaluations, étiquettes, images) ; null si GetItems n'a rien rendu */
  item: StoreItem | null
  description: string | null
  screenshots: { thumb: string; full: string }[]
  /** bandes-annonces : vignette seulement (lecture sur Steam) */
  movies: { thumb: string; name: string }[]
  background: string | null
  genres: string[]
  /** fonctionnalités (Solo, Multijoueur, Succès Steam…) */
  categories: string[]
  developers: string[]
  publishers: string[]
  /** date de sortie telle que donnée par Steam (texte) */
  releaseDate: string | null
  comingSoon: boolean
  metacritic: { score: number; url: string | null } | null
  platforms: { windows: boolean; mac: boolean; linux: boolean }
  price: StorePrice | null
  requiredAge: number
  dlc: StoreItem[]
  fetchedAt: number
  error: StoreError | null
}

// ---------- Profil Steam et amis (vue Steam, onglet PROFIL) ----------

/**
 * Présence Steam (GetPlayerSummaries) : 'ingame' quand un jeu est indiqué ; 'online' regroupe
 * en ligne, « cherche à échanger » et « cherche à jouer ».
 */
export type SteamPresence = 'ingame' | 'online' | 'away' | 'busy' | 'snooze' | 'offline'

/** 'no-account' : aucun compte Steam sur ce PC ; 'no-key' : pas de clé Web API ; 'invalid-key' : clé refusée ;
 *  'private' : liste d'amis privée ; 'offline' : Steam injoignable ; 'unavailable' : réponse inattendue. */
export type SteamProfileError = 'no-account' | 'no-key' | 'invalid-key' | 'private' | 'offline' | 'unavailable'

export interface SteamProfileGame {
  appid: number
  name: string
  /** petite icône du jeu (hôte de IMAGE_HOSTS) */
  icon: string | null
  /** temps de jeu des deux dernières semaines, minutes */
  minutes2Weeks: number
  /** temps de jeu total, minutes */
  minutesTotal: number
  /** dernière partie (ms) ou null */
  lastPlayedAt: number | null
}

export interface SteamProfileBadge {
  badgeId: number
  /** badge d'un jeu (cartes à échanger) : appid ; sinon null */
  appid: number | null
  /** nom du jeu (badge de jeu) ; null pour les badges Steam (l'interface les nomme d'après badgeId) */
  gameName: string | null
  /** icône du jeu (badge de jeu) ; null pour les badges Steam */
  icon: string | null
  level: number
  xp: number
  /** date d'obtention (ms) ou null */
  earnedAt: number | null
  /** brillant (badge « métallique » d'un jeu) */
  foil: boolean
}

export interface SteamProfileAchievement {
  appid: number
  game: string
  id: string
  name: string
  description: string
  icon: string | null
  unlockedAt: number | null
  /** part des joueurs qui l'ont (0 à 100) ; null si inconnue */
  percent: number | null
}

export interface SteamProfile {
  steamId: string
  personaName: string
  /** grand avatar (hôte de IMAGE_HOSTS) */
  avatar: string | null
  /** seulement si l'utilisateur l'a rendu public */
  realName: string | null
  /** code pays ISO (« FR ») seulement s'il est public */
  country: string | null
  profileUrl: string
  /** création du compte (ms) ou null */
  memberSince: number | null
  status: SteamPresence
  /** jeu en cours (statut 'ingame') */
  gameName: string | null
  /** dernière déconnexion (ms) ou null */
  lastOnline: number | null
  /** niveau Steam, XP et XP à gagner pour le niveau suivant ; null : inconnus (profil privé) */
  level: number | null
  xp: number | null
  xpToNext: number | null
  badgeCount: number | null
  /** badges mis en avant : les plus récents d'abord (12 au plus) */
  badges: SteamProfileBadge[]
  /** jeux possédés et temps de jeu total (minutes) ; null : détails des jeux privés */
  gamesOwned: number | null
  totalMinutes: number | null
  /** jeux des deux dernières semaines, le plus joué d'abord */
  recent: SteamProfileGame[]
  /** succès débloqués des jeux récents : les plus rares d'abord */
  rarest: SteamProfileAchievement[]
  /** succès débloqués des jeux récents : les plus récents d'abord */
  latest: SteamProfileAchievement[]
}

export interface SteamProfileState {
  profile: SteamProfile | null
  error: SteamProfileError | null
  fetchedAt: number
}

export interface SteamFriend {
  steamid: string
  name: string
  /** avatar moyen (64 px) */
  avatar: string | null
  status: SteamPresence
  /** jeu en cours (statut 'ingame') */
  game: string | null
  /** dernière déconnexion (ms) ou null (pas publique) */
  lastOnline: number | null
  /** ami depuis (ms) ou null */
  friendSince: number | null
}

export interface SteamFriendsState {
  friends: SteamFriend[]
  error: SteamProfileError | null
  fetchedAt: number
}

// ---------- Communauté Steam (vue Steam, onglet COMMUNAUTÉ) ----------

/** 'no-key' : pas de clé Web API (Workshop) ; 'invalid-key' : clé refusée ; 'offline' : Steam injoignable ;
 *  'unavailable' : réponse inattendue ; 'notFound' : article ou objet introuvable. */
export type CommunityError = 'no-key' | 'invalid-key' | 'offline' | 'unavailable' | 'notFound'

/** Texte riche d'un article ou d'une description (BBCode / HTML de Steam nettoyé dans le processus principal). */
export interface RichSpan {
  text: string
  b?: boolean
  i?: boolean
  u?: boolean
  s?: boolean
  /** lien https (ouvert par openExternalLink) */
  href?: string
}

export type RichBlock =
  | { t: 'p'; spans: RichSpan[] }
  | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'list'; ordered: boolean; items: RichSpan[][] }
  /** image d'un hôte de IMAGE_HOSTS ; href : lien autour de l'image */
  | { t: 'img'; src: string; href?: string }
  | { t: 'quote'; spans: RichSpan[] }
  | { t: 'video'; href: string }
  | { t: 'hr' }

export interface CommunityGame {
  appid: number
  name: string
  /** en-tête 460×215 du magasin (hôte de IMAGE_HOSTS) ; null : inconnu */
  header: string | null
}

export interface CommunityNewsItem {
  /** gid de l'actualité Steam */
  id: string
  appid: number
  game: string
  title: string
  /** page de l'actualité (Steam pour les annonces officielles) */
  url: string
  /** date de publication (ms) */
  date: number
  /** 'patch' : notes de mise à jour ; 'announcement' : annonce officielle ; 'press' : article relayé (feed : nom du site) */
  kind: 'patch' | 'announcement' | 'press'
  feed: string
  author: string | null
  excerpt: string
  /** première image de l'article (hôte de IMAGE_HOSTS) ou null : l'interface montre l'en-tête du jeu */
  image: string | null
}

export interface CommunityNews {
  /** jeux du fil (les plus joués et les plus récents), ordre : partie la plus récente d'abord */
  games: CommunityGame[]
  /** actualités, la plus récente d'abord */
  items: CommunityNewsItem[]
  error: CommunityError | null
  fetchedAt: number
}

export interface CommunityArticle {
  item: CommunityNewsItem
  body: RichBlock[]
}

export type WorkshopSort = 'trend' | 'popular' | 'recent'

export interface WorkshopGames {
  /** jeux Steam installés qui ont un Workshop */
  games: CommunityGame[]
  error: CommunityError | null
}

export interface WorkshopItem {
  id: string
  appid: number
  title: string
  /** image d'aperçu (hôte de IMAGE_HOSTS) */
  preview: string | null
  /** petite image de la grille (même image, redimensionnée par Steam) */
  thumb: string | null
  author: string | null
  /** abonnés actuels ; null : inconnu */
  subscriptions: number | null
  favorites: number | null
  /** note des joueurs, 0 à 1 ; null : pas assez de votes */
  score: number | null
  votes: number
  /** résumé sans balises */
  short: string
  tags: string[]
  createdAt: number | null
  updatedAt: number | null
  /** taille du fichier (octets) ; null : inconnue */
  size: number | null
}

export interface WorkshopPage {
  appid: number
  sort: WorkshopSort
  items: WorkshopItem[]
  /** curseur de la page suivante ; null : fin de la liste */
  next: string | null
  error: CommunityError | null
  fetchedAt: number
}

export interface WorkshopDetail {
  item: WorkshopItem | null
  /** autres images (hôtes de IMAGE_HOSTS) */
  previews: string[]
  body: RichBlock[]
  error: CommunityError | null
}

/** Hôtes d'images autorisés dans la fenêtre (CSP img-src) : les autres images ne sont pas renvoyées. */
export const IMAGE_HOSTS = [
  'https://*.steamstatic.com',
  'https://*.akamaihd.net',
  'https://*.steampowered.com',
  'https://*.steamusercontent.com',
  'https://upload.wikimedia.org',
  // avatar du compte itch.io
  'https://img.itch.zone',
  // Twitch : aperçus des streams, jaquettes des catégories, avatars
  'https://static-cdn.jtvnw.net'
] as const

// ---------- Twitch (streams d'un jeu sur sa page) ----------

export interface TwitchUser {
  id: string
  login: string
  displayName: string
  /** avatar (static-cdn.jtvnw.net) ou null */
  avatar: string | null
}

/** Connexion par code d'appareil en cours : code à saisir sur twitch.tv/activate. */
export interface TwitchSignIn {
  userCode: string
  /** adresse à ouvrir (twitch.tv/activate) */
  verificationUri: string
  /** expiration du code (ms) */
  expiresAt: number
  /** 'starting' : demande du code ; 'waiting' : en attente de l'accord sur twitch.tv */
  status: 'starting' | 'waiting' | 'expired' | 'denied' | 'error'
  error: string | null
}

export interface TwitchState {
  /** faux : pas d'identifiant d'application Twitch dans cette version (TWITCH_CLIENT_ID vide) */
  configured: boolean
  /** faux : Windows ne peut pas chiffrer les jetons (connexion impossible) */
  canStore: boolean
  user: TwitchUser | null
  signIn: TwitchSignIn | null
  /** dernier problème (session expirée…) ou null */
  error: string | null
}

export interface TwitchCategory {
  id: string
  name: string
  /** jaquette 52×72 ou null */
  boxArt: string | null
}

export interface TwitchStream {
  id: string
  userId: string
  userLogin: string
  userName: string
  title: string
  viewers: number
  /** code de langue ISO 639-1 (« en », « fr »…) ou « other » */
  language: string
  /** début du stream (ms) */
  startedAt: number
  /** aperçu 440×248 (static-cdn.jtvnw.net) */
  thumbnail: string
  tags: string[]
  mature: boolean
}

export type TwitchStreamsStatus = 'ok' | 'not-configured' | 'signed-out' | 'no-category' | 'error'

export interface TwitchStreamsQuery {
  /** code de langue, ou null pour toutes */
  language?: string | null
  /** page suivante (curseur de la réponse précédente) */
  cursor?: string | null
  /** seulement les chaînes suivies par le compte connecté */
  followed?: boolean
  /** relit maintenant (sinon cache de 60 s) */
  refresh?: boolean
}

export interface TwitchStreams {
  status: TwitchStreamsStatus
  /** catégorie Twitch du jeu (trouvée par son nom, ou choisie par l'utilisateur) */
  category: TwitchCategory | null
  /** vrai : catégorie choisie à la main (« Pas ce jeu ? ») */
  manual: boolean
  /** triés par spectateurs (ordre de Twitch) */
  streams: TwitchStream[]
  /** page suivante, null : plus rien */
  cursor: string | null
  error: string | null
  fetchedAt: number
}

/** Téléchargement en cours d'un jeu Steam (lu dans son appmanifest, relevé toutes les 1,5 s). */
export interface DownloadProgress {
  gameId: string
  /** 'installing' : fichiers téléchargés, Steam les écrit (staging) */
  phase: 'downloading' | 'installing' | 'paused' | 'queued'
  /** octets téléchargés / à télécharger */
  downloaded: number
  total: number
  /** octets écrits / à écrire (installation) */
  staged: number
  toStage: number
  /** octets/s, moyenne glissante ; 0 si inconnu */
  speed: number
  /** secondes restantes estimées ; null si inconnu */
  eta: number | null
  /** vitesses des 60 derniers relevés (octets/s), la plus ancienne d'abord (courbe façon Steam) */
  history: number[]
}

/**
 * Collections Steam du compte de ce PC, lues dans le stockage cloud local du client Steam
 * (userdata/<compte>/config/cloudstorage/cloud-storage-namespace-1.json), en lecture seule.
 */
export interface SteamCollections {
  /** appids de la collection « Favoris » */
  favorites: number[]
  /** appids cachés par l'utilisateur dans Steam */
  hidden: number[]
  /** collections de l'utilisateur (statiques), triées par nom */
  collections: { id: string; name: string; appids: number[] }[]
  /** collections dynamiques (règles de filtre de Steam) non montrées */
  dynamicCount: number
}

// ---------- Page Launchers (installer / désinstaller les lanceurs) ----------

/** Ce que CyberDeck sait faire pour un lanceur (l'état installé / absent vient de PlatformsState). */
export interface LauncherInfo {
  id: LauncherPlatform
  /**
   * Installation : 'winget' (CyberDeck télécharge et installe le paquet officiel, avec progression),
   * 'store' (ouvre la page du Microsoft Store), 'website' (ouvre la page de téléchargement officielle).
   */
  installKind: 'winget' | 'store' | 'website'
  /** identifiant du paquet winget (ex. « Valve.Steam ») ; null si aucun */
  wingetId: string | null
  /** page de téléchargement officielle (secours, ou installation pour 'website') */
  website: string
  /**
   * Désinstallation : 'uninstaller' (programme de désinstallation du lanceur, avec sa propre fenêtre),
   * 'windows' (« Applications installées » de Windows), null si impossible (lanceur absent, désinstalleur introuvable).
   */
  uninstallKind: 'uninstaller' | 'windows' | null
  /**
   * Compte connecté, lu sur le PC sans mot de passe ni jeton : BattleTag (cache de Battle.net),
   * nom et avatar itch.io (profil de l'app itch). null : rien de lisible (les autres lanceurs
   * chiffrent leurs données de compte ; Steam a sa propre carte).
   */
  account: { name: string; avatar: string | null } | null
}

/** Installation ou désinstallation de lanceur en cours (ou juste terminée). */
export interface LauncherOp {
  id: LauncherPlatform
  kind: 'install' | 'uninstall'
  /** 'waiting' : désinstalleur ouvert, CyberDeck attend que le lanceur disparaisse */
  phase: 'starting' | 'downloading' | 'installing' | 'waiting' | 'done' | 'error'
  /** 0..1 si connu */
  progress: number | null
  /** octets reçus / total pendant le téléchargement, si connus */
  received: number | null
  total: number | null
  /** message déjà traduit (erreur, ou précision comme « Windows demande l'autorisation ») */
  message: string | null
  startedAt: number
}

export interface LaunchersState {
  /** winget disponible sur ce PC (null : pas encore vérifié) */
  winget: boolean | null
  /** les 11 lanceurs, dans l'ordre de PLATFORM_ORDER */
  launchers: LauncherInfo[]
  /** opérations en cours ou terminées depuis moins d'une minute, par lanceur */
  ops: Partial<Record<LauncherPlatform, LauncherOp>>
}

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

/**
 * Comment CyberDeck désinstallerait un jeu (montré dans la fenêtre de confirmation) :
 * 'launcher' : la plateforme ouvre sa propre fenêtre de désinstallation (Steam) ;
 * 'uninstaller' : programme de désinstallation déclaré par le jeu dans Windows ;
 * 'open-launcher' : la plateforme ne se laisse pas piloter, CyberDeck l'ouvre et dit quoi cliquer ;
 * 'folder' : aucun désinstalleur, CyberDeck ouvre le dossier (jamais de suppression automatique) ;
 * 'none' : impossible (raison dans error).
 */
export interface UninstallPlan {
  kind: 'launcher' | 'uninstaller' | 'open-launcher' | 'folder' | 'none'
  /** nom du lanceur (« Steam », « Epic Games ») ou de la fenêtre Windows à ouvrir */
  launcher: string | null
  /** programme de désinstallation ('uninstaller') ou dossier du jeu ('folder') */
  target: string | null
  error: string | null
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
  /** système (process.platform) : 'win32', 'linux'… ; absent dans un preload d'avant la version Linux */
  readonly os?: string
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

  // ---- Désinstallation ----
  /** comment le jeu serait désinstallé (lit le registre de Windows) */
  uninstallPlan(id: string): Promise<UninstallPlan>
  /** lance la désinstallation décrite par uninstallPlan ; removeFromList : 'folder' seulement */
  uninstallGame(id: string, removeFromList: boolean): Promise<ActionResult>

  // ---- Page détaillée d'un jeu et téléchargements ----
  /** infos de la page d'un jeu (cache sur le disque ; refresh : relit tout) */
  getGameDetails(id: string, refresh?: boolean): Promise<GameDetails>
  /** téléchargements Steam en cours, par id de jeu */
  getDownloads(): Promise<Record<string, DownloadProgress>>
  onDownloads(cb: (d: Record<string, DownloadProgress>) => void): () => void
  /** ouvre un lien d'une page de jeu (adresses http(s) et protocoles des lanceurs seulement) */
  openExternalLink(url: string): void
  /** collections Steam du compte de ce PC (lecture seule) ; null : pas de compte ou fichier illisible */
  getSteamCollections(): Promise<SteamCollections | null>

  // ---- Magasin Steam (adresses publiques de la boutique, sans compte ; cache 15 à 60 min) ----
  /** vitrine : grand carrousel et étagères (refresh : relit maintenant) */
  getStoreHome(refresh?: boolean): Promise<StoreHome>
  /** liste du magasin (offres, meilleures ventes, nouveautés, prochainement) */
  getStoreList(kind: StoreListKind, refresh?: boolean): Promise<StoreList>
  /** recherche dans le magasin */
  searchStore(term: string): Promise<StoreSearch>
  /** page d'un jeu du magasin */
  getStoreApp(appid: number, refresh?: boolean): Promise<StoreApp>

  // ---- Profil Steam et amis (Web API avec la clé et le SteamID de l'utilisateur ; cache 10 min / 45 s) ----
  /** profil du compte de ce PC : en-tête, niveau, badges, activité récente, succès */
  getSteamProfile(refresh?: boolean): Promise<SteamProfileState>
  /** liste d'amis avec leur présence (error 'private' : liste d'amis privée) */
  getSteamFriends(refresh?: boolean): Promise<SteamFriendsState>

  // ---- Communauté Steam (actualités sans compte ; Workshop avec la clé de l'utilisateur ; cache 30 min) ----
  /** fil des actualités des jeux les plus joués et les plus récents */
  getCommunityNews(refresh?: boolean): Promise<CommunityNews>
  /** article complet d'une actualité du fil ; null : introuvable */
  getCommunityArticle(appid: number, id: string): Promise<CommunityArticle | null>
  /** jeux Steam installés qui ont un Workshop (error 'no-key' : pas de clé) */
  getWorkshopGames(refresh?: boolean): Promise<WorkshopGames>
  /** une page d'objets du Workshop d'un jeu (cursor : null pour la première) */
  getWorkshopPage(appid: number, sort: WorkshopSort, cursor?: string | null, refresh?: boolean): Promise<WorkshopPage>
  /** fiche d'un objet du Workshop */
  getWorkshopItem(id: string): Promise<WorkshopDetail>

  // ---- Page Launchers : installer / désinstaller les lanceurs ----
  getLaunchers(): Promise<LaunchersState>
  onLaunchers(cb: (s: LaunchersState) => void): () => void
  /** winget (paquet officiel), sinon page du Microsoft Store (Xbox) ou site officiel (Riot, winget absent) */
  installLauncher(id: LauncherPlatform): Promise<ActionResult>
  /** lance le désinstalleur officiel du lanceur (ou « Applications installées » de Windows pour Xbox) */
  uninstallLauncher(id: LauncherPlatform): Promise<ActionResult>
  /** annule une installation winget en cours */
  cancelLauncherOp(id: LauncherPlatform): void

  // ---- Twitch (connexion par code d'appareil : l'app ne voit jamais le mot de passe) ----
  getTwitchState(): Promise<TwitchState>
  onTwitch(cb: (s: TwitchState) => void): () => void
  /** demande un code d'appareil puis attend l'accord sur twitch.tv/activate */
  twitchSignIn(): Promise<TwitchState>
  twitchCancelSignIn(): void
  /** révoque les jetons chez Twitch et les efface de ce PC */
  twitchSignOut(): Promise<TwitchState>
  /** ouvre twitch.tv/activate (adresse de la connexion en cours) dans le navigateur */
  twitchOpenActivate(): void
  /** streams en direct du jeu (catégorie trouvée par son nom ; cache 60 s) */
  getTwitchStreams(gameId: string, query?: TwitchStreamsQuery): Promise<TwitchStreams>
  /** recherche de catégories (« Pas ce jeu ? ») */
  searchTwitchCategories(query: string): Promise<TwitchCategory[]>
  /** catégorie choisie pour le jeu ; null : revient à la recherche automatique */
  setTwitchCategory(gameId: string, category: TwitchCategory | null): Promise<void>
  /** Échap pressé dans le lecteur ou le chat Twitch (le clavier y reste sinon) */
  onTwitchEscape(cb: () => void): () => void
}
