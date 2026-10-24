import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import iconIco from '../../build/icon.ico?asset'
import iconPng from '../../build/icon.png?asset'
import type {
  AddRequest,
  AddResult,
  FromEngine,
  GameInput,
  Notice,
  Settings,
  SettingsPatch,
  Snapshot,
  StoreListKind,
  WorkshopSort,
  ToEngine,
  TorrentFileInfo,
  TwitchCategory,
  TwitchStreamsQuery,
  UpdateState
} from '../shared/types'
import {
  addGame,
  applyPlatformScans,
  defaultGamesFolder,
  forgetSteamOwned,
  hiddenCount,
  imageFileFor,
  importGames,
  scanGamesFolder,
  initLibrary,
  installFromTorrent,
  installPlatformGame,
  libraryState,
  openGameFolder,
  playGame,
  removeGame,
  restoreHiddenGames,
  searchCover,
  setCoverFromFile,
  steamOwnedCounts,
  stopAllSessions,
  uninstallGame,
  uninstallPlan,
  updateGame
} from './games'
import {
  clearSteamKey,
  initPlatforms,
  onWindowFocus,
  platformsState,
  protocolAvailable,
  refreshSteamOwned,
  setSteamKey,
  steamAvatarFile,
  stopPlatforms,
  syncPlatforms,
  testSteamKey
} from './platformSync'
import { fetchUpdate, openReleasePage } from './updates'
import { cancelLauncherOp, getLaunchers, initLaunchers, installLauncher, notifyLaunchers, uninstallLauncher } from './launchers'
import { forgetGameDetails, getGameDetails, initGameDetails, openExternalLink } from './gameDetails'
import { downloadsState, initSteamDownloads, onLibraryChanged, stopSteamDownloads } from './steamDownloads'
import { getSteamCollections } from './steamCollections'
import { getStoreApp, getStoreHome, getStoreList, initSteamStore, searchStore } from './steamStore'
import { getSteamFriends, getSteamProfile, initSteamProfile } from './steamProfile'
import { getCommunityArticle, getCommunityNews, getWorkshopGames, getWorkshopItem, getWorkshopPage, initSteamCommunity } from './steamCommunity'
import { isLang, setLang, t, tn } from '../shared/i18n'
import {
  cancelTwitchSignIn,
  getTwitchStreams,
  initTwitch,
  openTwitchActivate,
  searchTwitchCategories,
  secureTwitchWebviews,
  setTwitchCategory,
  startTwitchSignIn,
  twitchSignOut,
  twitchState
} from './twitch'

/** Nom public de l'app (fenêtre, journal, Gestionnaire des tâches). */
const APP_NAME = 'CyberDeck'
/** Icône de la fenêtre : .ico sous Windows, .png ailleurs (Linux ne lit pas les .ico). */
const icon = process.platform === 'win32' ? iconIco : iconPng

nativeTheme.themeSource = 'dark'
// Même identifiant que l'appId d'electron-builder.yml (regroupement dans la barre des tâches).
app.setAppUserModelId('app.cyberdeck.launcher')

// Données : %APPDATA%\CyberDeck, le dossier par défaut d'Electron pour le productName « CyberDeck ».
// Tests : CYBERDECK_USER_DATA=<dossier> lance l'app avec un profil séparé, sans toucher au vrai.
const testUserData = process.env.CYBERDECK_USER_DATA
if (testUserData) app.setPath('userData', testUserData)
// Tests (fenêtre hors écran) : Windows la croirait cachée et le lecteur Twitch ne démarrerait pas.
if (process.env.CYBERDECK_TEST_QUIET) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// ---------- Journal ----------

const logPath = (): string => path.join(app.getPath('userData'), 'cyberdeck.log')

// App lancée sans console (raccourci) ou console refermée : écrire dessus ne doit jamais planter.
process.stdout?.on?.('error', () => {})

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    process.stdout.write(line)
  } catch {
    // pas de console
  }
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.appendFileSync(logPath(), line)
  } catch {
    // le journal n'est qu'une aide
  }
}

// Erreur imprévue : notée dans le journal plutôt qu'une boîte d'erreur d'Electron (l'app continue).
process.on('uncaughtException', (err) => log(`Erreur imprévue : ${err?.stack ?? err}`))
process.on('unhandledRejection', (reason) => log(`Promesse rejetée sans traitement : ${(reason as Error)?.stack ?? reason}`))

function rotateLog(): void {
  try {
    if (fs.statSync(logPath()).size > 1_000_000) fs.renameSync(logPath(), logPath() + '.old')
  } catch {
    // pas encore de journal
  }
}

// ---------- Reprise des données des anciennes versions ----------

/** Anciens dossiers, du plus récent au plus ancien : CyberTorrent (versions 0.3 et 0.4, CyberLink compris), puis Essaim (0.1 et 0.2). */
const LEGACY_DIRS = ['CyberTorrent', 'Essaim']
/** Ce qui est repris. « Local State » garde la clé de chiffrement de Windows (safeStorage) :
 *  sans elle, la clé Steam Web API enregistrée dans platforms.json deviendrait illisible.
 *  « Local Storage » garde les préférences d'affichage (clés `essaim.*` : hauteur des détails,
 *  onglet, vue de la bibliothèque).
 *  settings.json en dernier : c'est sa présence qui marque la reprise comme faite. */
const LEGACY_ITEMS = ['state.json', 'library.json', 'platforms.json', 'covers', 'torrents', 'Local State', 'Local Storage', 'settings.json']
/** Simple confort : si la copie échoue (fichier verrouillé par l'ancienne version encore ouverte…),
 *  la copie partielle est retirée et la reprise continue sans ces préférences. */
const LEGACY_OPTIONAL = new Set(['Local Storage'])
const LEGACY_DATA = ['settings.json', 'state.json', 'library.json', 'platforms.json']

/**
 * Premier lancement de CyberDeck : si son dossier n'a pas encore de settings.json, on copie les données
 * de %APPDATA%\CyberTorrent s'il existe, sinon de %APPDATA%\Essaim. Les anciens dossiers ne sont ni
 * modifiés ni supprimés. Les dossiers lus sont les voisins du profil : un profil de test nommé
 * « CyberDeck » (CYBERDECK_USER_DATA) reprend donc les copies posées à côté de lui, jamais les vrais.
 */
function migrateLegacyData(): void {
  // anciennes versions : Windows seulement (Linux : ~/.config/CyberDeck dès la première version)
  if (process.platform !== 'win32') return
  const dir = app.getPath('userData')
  // seulement le dossier de CyberDeck (pas %APPDATA%\Electron d'un lancement de développement)
  if (path.basename(dir).toLowerCase() !== 'cyberdeck') return
  if (fs.existsSync(path.join(dir, 'settings.json'))) return
  const parent = path.dirname(dir)
  const from = LEGACY_DIRS.map((name) => path.join(parent, name)).find((old) =>
    LEGACY_DATA.some((item) => fs.existsSync(path.join(old, item)))
  )
  if (!from) return
  const copied: string[] = []
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const item of LEGACY_ITEMS) {
      const src = path.join(from, item)
      if (!fs.existsSync(src)) continue
      const dest = path.join(dir, item)
      try {
        fs.cpSync(src, dest, { recursive: true })
      } catch (err) {
        if (!LEGACY_OPTIONAL.has(item)) throw err
        try {
          fs.rmSync(dest, { recursive: true, force: true })
        } catch {
          // copie partielle laissée : Chromium recrée une base illisible
        }
        log(`Reprise de « ${item} » impossible, préférences d’affichage remises à zéro : ${(err as Error).message}`)
        continue
      }
      copied.push(item)
    }
    log(`Données reprises depuis ${from} : ${copied.join(', ')} (l’ancien dossier est gardé tel quel)`)
  } catch (err) {
    // l'app démarre quand même (avec ce qui a pu être copié) ; l'ancien dossier reste intact
    log(`Reprise des données de ${from} interrompue après ${copied.join(', ') || 'aucun fichier'} : ${(err as Error).message}`)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  migrateLegacyData()
}

// essaim://cover/<id> et essaim://icon/<id> : images de la bibliothèque.
protocol.registerSchemesAsPrivileged([
  { scheme: 'essaim', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let win: BrowserWindow | null = null
/** moteur torrent en marche (null : torrents désactivés, ou moteur en cours d'arrêt) */
let engine: UtilityProcess | null = null
/** arrêt du moteur en cours (torrents désactivés, fermeture de l'app) */
let engineStopping: Promise<void> | null = null
/** démarrages et arrêts du moteur demandés par les réglages, l'un après l'autre */
let engineOp: Promise<void> = Promise.resolve()
let engineRestarts = 0
let quitting = false
let settings: Settings
let lastSnapshot: Snapshot | null = null
let nextRequestId = 1
let onShutdownDone: (() => void) | null = null
/** Version comparée aux Releases (tests : CYBERDECK_TEST_VERSION fait passer l'app pour plus ancienne). */
const currentVersion = (): string => process.env.CYBERDECK_TEST_VERSION || app.getVersion()
let update: UpdateState = { status: 'idle', current: '', latest: null, url: null, checkedAt: null, error: null }
let updateCheck: Promise<UpdateState> | null = null
const UPDATE_PERIOD = 12 * 3600_000
const pendingAdds = new Map<number, (r: AddResult) => void>()
/** Garde-fou : un fichier plus gros ne peut pas être un vrai .torrent (les plus gros font quelques dizaines de Mo). */
const MAX_TORRENT_FILE = 200 * 1024 * 1024
const pendingReleases = new Map<number, (wasRunning: boolean) => void>()

// Met un torrent en pause le temps qu'un installateur ou un jeu utilise ses fichiers.
function releaseTorrent(id: string): Promise<boolean> {
  if (!engine) return Promise.resolve(false)
  const requestId = nextRequestId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingReleases.delete(requestId)
      resolve(false)
    }, 10_000)
    pendingReleases.set(requestId, (wasRunning) => {
      clearTimeout(timer)
      resolve(wasRunning)
    })
    toEngine({ type: 'release', requestId, id })
  })
}

// ---------- Réglages ----------

const settingsPath = (): string => path.join(app.getPath('userData'), 'settings.json')

/** Fichier JSON retouché à la main et enregistré « UTF-8 avec BOM » : il reste lisible. */
const stripBom = (text: string): string => text.replace(/^\uFEFF/, '')

/** La liste des torrents enregistrée (state.json) contient au moins un torrent. */
function hasSavedTorrents(): boolean {
  try {
    const raw = JSON.parse(stripBom(fs.readFileSync(path.join(app.getPath('userData'), 'state.json'), 'utf8')))
    return Array.isArray(raw?.torrents) && raw.torrents.length > 0
  } catch {
    return false
  }
}

/** Téléchargements de Windows ; dossier connu illisible (profil abîmé, redirection cassée) : <profil>\Downloads. */
function downloadsDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return path.join(app.getPath('home'), 'Downloads')
  }
}

function loadSettings(): Settings {
  const defaults: Settings = {
    defaultSavePath: downloadsDir(),
    port: 20000 + Math.floor(Math.random() * 40000),
    torrentsEnabled: false,
    gamesFolder: null,
    checkUpdates: true,
    language: 'en'
  }
  let saved: Partial<Settings> | null = null
  let text: string | null = null
  try {
    text = fs.readFileSync(settingsPath(), 'utf8')
  } catch {
    // pas encore de réglages (nouvelle installation)
  }
  if (text !== null) {
    try {
      const raw = JSON.parse(stripBom(text))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) saved = raw
      else throw new Error('contenu inattendu')
    } catch (err) {
      // fichier abîmé : gardé à côté avant d'être remplacé par les réglages par défaut
      const backup = `${settingsPath()}.illisible-${Date.now()}`
      try {
        fs.copyFileSync(settingsPath(), backup)
        log(`settings.json illisible (${(err as Error).message}) : copie gardée dans ${backup}, réglages par défaut`)
      } catch {
        log(`settings.json illisible (${(err as Error).message}) : réglages par défaut`)
      }
    }
  }
  const merged: Settings = { ...defaults, ...saved }
  if (typeof merged.defaultSavePath !== 'string' || !merged.defaultSavePath) merged.defaultSavePath = defaults.defaultSavePath
  if (typeof merged.gamesFolder !== 'string' || !merged.gamesFolder) merged.gamesFolder = null
  if (!Number.isInteger(merged.port) || merged.port < 1024 || merged.port > 65535) merged.port = defaults.port
  // réglage apparu en 0.5.7 : activé pour les profils d'avant
  if (typeof merged.checkUpdates !== 'boolean') merged.checkUpdates = true
  // réglage apparu en 0.6 : anglais par défaut, même pour les profils d'avant
  if (!isLang(merged.language)) merged.language = 'en'
  const known = typeof saved?.torrentsEnabled === 'boolean'
  if (!known) {
    // Nouvelle installation : torrents désactivés. Profil d'une version d'avant les torrents
    // facultatifs (repris de CyberTorrent ou d'Essaim) : activés seulement s'il a des torrents.
    merged.torrentsEnabled = hasSavedTorrents()
    if (saved) log(`Profil d’une version précédente : torrents ${merged.torrentsEnabled ? 'activés (liste non vide)' : 'désactivés (aucun torrent)'}`)
  }
  if (!saved || !known) {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true })
      fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2))
    } catch (err) {
      log(`Enregistrement des réglages impossible : ${(err as Error).message}`)
    }
  }
  return merged
}

/**
 * Vérifie s'il existe une version plus récente sur GitHub. Automatique : seulement si le réglage
 * est activé ; manuelle (bouton de Réglages) : toujours. Une seule vérification à la fois.
 */
function checkUpdates(manual: boolean): Promise<UpdateState> {
  if (!manual && !settings.checkUpdates) return Promise.resolve(update)
  if (updateCheck) return updateCheck
  update = { ...update, status: 'checking', current: currentVersion() }
  send('update', update)
  updateCheck = fetchUpdate(currentVersion())
    .then((u) => {
      update = u
      if (u.status === 'available') log(`Mise à jour disponible : ${u.latest} (installée : ${u.current})`)
      else if (u.status === 'error') log(`Vérification des mises à jour impossible : ${u.error}`)
      send('update', update)
      return update
    })
    .finally(() => (updateCheck = null))
  return updateCheck
}

function saveSettings(): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  } catch (err) {
    log(`Enregistrement des réglages impossible : ${(err as Error).message}`)
  }
}

/** Message pour l'interface, seulement si la fenêtre existe encore (fermeture en cours…). */
function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
}

/** Réglages à jour pour l'interface (fenêtre Réglages, rubrique Torrents). */
function sendSettings(): void {
  send('settings', settings)
}

// ---------- Moteur ----------
// Le client torrent est facultatif (settings.torrentsEnabled) : désactivé, le moteur ne démarre
// pas du tout, donc aucun port n'est ouvert sur le PC (pas d'alerte du pare-feu de Windows).

function toEngine(msg: ToEngine): void {
  engine?.postMessage(msg)
}

function sendNotice(notice: Notice): void {
  send('notice', notice)
}

/** Demandes en attente d'un moteur qui s'arrête : elles échouent proprement. */
function failPending(): void {
  for (const resolve of pendingAdds.values()) resolve({ ok: false, error: t('main.engine.stopped') })
  pendingAdds.clear()
  for (const resolve of pendingReleases.values()) resolve(false)
  pendingReleases.clear()
}

function startEngine(): void {
  // langue des textes du moteur (processus à part) : voir aussi « set-lang » dans settings:set
  const proc = utilityProcess.fork(path.join(__dirname, 'engine.js'), [`--lang=${settings.language}`], {
    serviceName: t('main.engine.serviceName', { app: APP_NAME }),
    stdio: 'pipe'
  })
  engine = proc
  proc.stdout?.on('data', (d) => log(`[moteur] ${String(d).trimEnd()}`))
  proc.stderr?.on('data', (d) => log(`[moteur:err] ${String(d).trimEnd()}`))
  proc.on('message', (msg: FromEngine) => {
    // moteur en cours d'arrêt : plus d'instantanés ni de messages pour l'interface
    const current = engine === proc && settings.torrentsEnabled
    switch (msg.type) {
      case 'snapshot':
        if (!current) break
        lastSnapshot = msg.snapshot
        send('snapshot', msg.snapshot)
        break
      case 'added':
        pendingAdds.get(msg.requestId)?.(msg.result)
        pendingAdds.delete(msg.requestId)
        break
      case 'notice':
        if (current) sendNotice(msg.notice)
        break
      case 'log':
        log(`[moteur] ${msg.message}`)
        break
      case 'trash':
        trashFiles(msg.files, msg.dirs)
        break
      case 'released':
        pendingReleases.get(msg.requestId)?.(msg.wasRunning)
        pendingReleases.delete(msg.requestId)
        break
      case 'shutdown-done':
        onShutdownDone?.()
        break
    }
  })
  proc.on('exit', (code) => {
    // arrêt voulu (torrents désactivés, fermeture) : déjà réglé par stopEngine
    if (engine !== proc) return
    engine = null
    lastSnapshot = null
    failPending()
    if (quitting) return
    log(`Moteur arrêté (code ${code})`)
    if (engineRestarts < 3) {
      engineRestarts++
      sendNotice({ level: 'error', message: t('main.engine.restarting') })
      setTimeout(() => {
        // entre-temps, l'app se ferme ou les torrents ont été désactivés
        if (!quitting && settings.torrentsEnabled && !engine && !engineStopping) startEngine()
      }, 1000)
    } else {
      sendNotice({ level: 'error', message: t('main.engine.noRestart', { app: APP_NAME }) })
    }
  })
  toEngine({
    type: 'init',
    dataDir: app.getPath('userData'),
    port: settings.port,
    defaultSavePath: settings.defaultSavePath
  })
}

// Met les fichiers d'un torrent supprimé à la corbeille (récupérables), puis
// retire les dossiers du torrent devenus vides.
async function trashFiles(files: string[], dirs: string[]): Promise<void> {
  let failed = 0
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    await shell.trashItem(file).catch((err) => {
      failed++
      log(`Corbeille impossible pour ${file} : ${err.message}`)
    })
  }
  for (const dir of dirs) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch {
      // dossier déjà absent ou pas vide : on le laisse
    }
  }
  if (failed) sendNotice({ level: 'error', message: tn('main.trash.failed', failed) })
}

/**
 * Arrête le moteur proprement : il enregistre la liste (state.json) et ferme ses connexions,
 * puis le processus est fermé (6 s au plus). Un seul arrêt à la fois.
 */
function stopEngine(): Promise<void> {
  if (engineStopping) return engineStopping
  const proc = engine
  if (!proc) return Promise.resolve()
  engine = null
  lastSnapshot = null
  engineStopping = new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      onShutdownDone = null
      proc.kill()
      failPending()
      engineStopping = null
      resolve()
    }
    const timer = setTimeout(done, 6000)
    onShutdownDone = done
    proc.postMessage({ type: 'shutdown' } satisfies ToEngine)
  })
  return engineStopping
}

/** Met le moteur dans l'état voulu par les réglages (activé : en marche ; désactivé : arrêté). */
function syncEngine(): Promise<void> {
  engineOp = engineOp
    .then(async () => {
      if (quitting) return
      if (!settings.torrentsEnabled) return stopEngine()
      if (engine) return
      if (engineStopping) await engineStopping
      if (quitting || !settings.torrentsEnabled || engine) return
      engineRestarts = 0
      startEngine()
    })
    .catch((err) => log(`Moteur : ${(err as Error)?.message ?? err}`))
  return engineOp
}

// Quelle que soit la façon de quitter, le moteur enregistre la liste avant de s'arrêter.
function quitGracefully(): void {
  if (quitting) return
  quitting = true
  stopPlatforms()
  stopSteamDownloads()
  stopAllSessions()
  if (win && !win.isDestroyed()) win.hide()
  stopEngine().then(() => app.exit(0))
}

// ---------- Fenêtre ----------

function createWindow(): void {
  // Tests automatiques : fenêtre discrète (hors écran, sans bouton dans la barre des tâches,
  // sans prendre le focus), pour ne jamais passer devant ce que fait l'utilisateur.
  const quiet = !!process.env.CYBERDECK_TEST_QUIET
  win = new BrowserWindow({
    ...(quiet ? { x: -20000, y: 0, skipTaskbar: true } : {}),
    width: 1320,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#000000',
    icon,
    title: APP_NAME,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#bdbdbd', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: false,
      // lecteur et chat Twitch de la page d'un jeu (verrouillés par secureTwitchWebviews)
      webviewTag: true,
      // hors écran, la fenêtre de test doit continuer à dessiner normalement
      backgroundThrottling: !quiet
    }
  })
  win.once('ready-to-show', () => (quiet ? win?.showInactive() : win?.show()))
  // retour sur la fenêtre : un jeu installé entre-temps dans un lanceur apparaît
  win.on('focus', () => onWindowFocus())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  secureTwitchWebviews(win.webContents, () => send('twitch:escape'))
  // Si l'affichage plante, on note la raison et on recharge la fenêtre
  // (le moteur et les téléchargements continuent pendant ce temps).
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`Affichage planté (${details.reason}, code ${details.exitCode})`)
    if (!quitting && details.reason !== 'clean-exit') setTimeout(() => win?.webContents.reload(), 800)
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    quitGracefully()
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings)

  // Fenêtre « Réglages » : torrents (démarre ou arrête le moteur), dossiers par défaut.
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as SettingsPatch
    if (typeof p.defaultSavePath === 'string' && p.defaultSavePath.trim() && p.defaultSavePath !== settings.defaultSavePath) {
      settings.defaultSavePath = p.defaultSavePath
      toEngine({ type: 'set-default-path', path: p.defaultSavePath })
    }
    if (p.gamesFolder === null || (typeof p.gamesFolder === 'string' && p.gamesFolder.trim())) settings.gamesFolder = p.gamesFolder
    if (isLang(p.language) && p.language !== settings.language) {
      settings.language = p.language
      setLang(p.language)
      // le moteur torrent (processus à part) suit la nouvelle langue
      engine?.postMessage({ type: 'set-lang', lang: p.language })
      log(`Langue de l’interface : ${p.language}`)
    }
    if (typeof p.checkUpdates === 'boolean' && p.checkUpdates !== settings.checkUpdates) {
      settings.checkUpdates = p.checkUpdates
      log(`Vérification des mises à jour ${settings.checkUpdates ? 'activée' : 'désactivée'}`)
      if (settings.checkUpdates && update.status === 'idle') void checkUpdates(false)
    }
    const toggled = typeof p.torrentsEnabled === 'boolean' && p.torrentsEnabled !== settings.torrentsEnabled
    if (toggled) {
      settings.torrentsEnabled = p.torrentsEnabled!
      if (!settings.torrentsEnabled) lastSnapshot = null
      log(`Torrents ${settings.torrentsEnabled ? 'activés' : 'désactivés'} dans les réglages`)
    }
    saveSettings()
    // l'arrêt (enregistrement de la liste compris) continue en arrière-plan : l'interface n'attend pas
    if (toggled) void syncEngine()
    sendSettings()
    return settings
  })

  ipcMain.handle('dialog:torrent-file', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: t('main.dialog.torrentTitle'),
      filters: [{ name: t('main.dialog.torrentFilter'), extensions: ['torrent'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:folder', async (_e, defaultPath: string, title?: unknown) => {
    const res = await dialog.showOpenDialog(win!, {
      title: typeof title === 'string' && title ? title : t('main.dialog.folderTitle'),
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('clipboard:magnet', async () => {
    const text = String(await clipboard.readText()).trim()
    return text.startsWith('magnet:?') ? text : null
  })

  // Lecture locale d'un .torrent pour le billet « Lecture du fichier » du dialogue d'ajout :
  // nom, taille, fichiers, pièces, empreinte. Rien n'est ajouté ni envoyé sur le réseau.
  ipcMain.handle('torrent:inspect', async (_e, file: unknown): Promise<TorrentFileInfo | null> => {
    try {
      if (typeof file !== 'string' || !/\.torrent$/i.test(file)) return null
      const stat = await fs.promises.stat(file)
      if (!stat.isFile() || stat.size > MAX_TORRENT_FILE) return null
      const buf = await fs.promises.readFile(file)
      const parseTorrent = (await import('parse-torrent')).default
      const t = await parseTorrent(buf)
      if (!t?.infoHash) return null
      return {
        name: String(t.name || path.basename(file, path.extname(file))),
        size: Number(t.length) || 0,
        files: Array.isArray(t.files) ? t.files.length : 0,
        pieces: Array.isArray(t.pieces) ? t.pieces.length : 0,
        infoHash: String(t.infoHash),
        fileSize: buf.length
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('torrent:add', (_e, request: AddRequest) => {
    if (!engine)
      return {
        ok: false,
        error: settings.torrentsEnabled ? t('main.engine.notReady') : t('main.engine.disabled')
      }
    if (request.savePath && request.savePath !== settings.defaultSavePath) {
      settings.defaultSavePath = request.savePath
      saveSettings()
      toEngine({ type: 'set-default-path', path: request.savePath })
      sendSettings()
    }
    const requestId = nextRequestId++
    return new Promise<AddResult>((resolve) => {
      pendingAdds.set(requestId, resolve)
      toEngine({ type: 'add', requestId, request })
    })
  })

  ipcMain.on('torrent:pause', (_e, ids: string[]) => toEngine({ type: 'pause', ids }))
  ipcMain.on('torrent:resume', (_e, ids: string[]) => toEngine({ type: 'resume', ids }))
  ipcMain.on('torrent:remove', (_e, ids: string[], deleteFiles: boolean) =>
    toEngine({ type: 'remove', ids, deleteFiles: !!deleteFiles })
  )
  ipcMain.on('torrent:select', (_e, id: string | null) => toEngine({ type: 'select', id }))

  ipcMain.on('torrent:open-folder', (_e, id: string) => {
    const t = lastSnapshot?.torrents.find((x) => x.id === id)
    if (!t) return
    const target = path.join(t.savePath, t.name)
    if (fs.existsSync(target)) shell.showItemInFolder(target)
    else shell.openPath(t.savePath)
  })

  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)))

  // ---------- Bibliothèque ----------

  ipcMain.handle('library:get', () => libraryState())
  ipcMain.on('library:install', (_e, torrentId: string) => {
    const t = lastSnapshot?.torrents.find((x) => x.id === torrentId)
    if (t) void installFromTorrent(t)
  })
  ipcMain.handle('library:add', (_e, input: GameInput) => addGame(input))
  ipcMain.handle('library:update', (_e, id: string, input: GameInput) => updateGame(id, input))
  // un jeu de plateforme retiré change le nombre de jeux retirés (fenêtre Plateformes, « Remettre »)
  ipcMain.on('library:remove', (_e, id: string) => {
    removeGame(id)
    forgetGameDetails(String(id))
    send('platforms', platformsState())
  })
  ipcMain.on('library:play', (_e, id: string) =>
    playGame(String(id)).catch((err) => {
      log(`Lancement impossible : ${(err as Error)?.stack ?? err}`)
      sendNotice({ level: 'error', message: t('main.play.failed', { error: (err as Error)?.message ?? String(err) }) })
    })
  )
  ipcMain.on('library:open-folder', (_e, id: string) => openGameFolder(id))
  ipcMain.handle('library:search-cover', (_e, id: string) => searchCover(id, true))
  ipcMain.handle('library:scan-folder', (_e, dir: string) => scanGamesFolder(dir))
  ipcMain.handle('library:import', (_e, inputs: GameInput[]) => importGames(inputs))
  // dossier choisi dans Réglages (s'il existe encore), sinon C:\Games ou Documents
  ipcMain.handle('library:default-folder', () =>
    settings.gamesFolder && fs.existsSync(settings.gamesFolder) ? settings.gamesFolder : defaultGamesFolder()
  )
  ipcMain.handle('library:cover-file', (_e, id: string, file: string) => setCoverFromFile(id, file))
  ipcMain.handle('library:install-game', (_e, id: string) => installPlatformGame(String(id)))
  ipcMain.handle('library:restore-hidden', () => {
    const n = restoreHiddenGames()
    if (n) {
      send('platforms', platformsState())
      void syncPlatforms({ full: true })
    }
    return n
  })

  // ---------- Plateformes et compte Steam ----------

  ipcMain.handle('platforms:get', () => platformsState())
  ipcMain.handle('platforms:sync', () => syncPlatforms({ full: true, refreshOwned: true }))
  ipcMain.handle('steam:set-key', (_e, key: unknown) => setSteamKey(typeof key === 'string' ? key : ''))
  ipcMain.handle('steam:test-key', (_e, key?: unknown) => testSteamKey(typeof key === 'string' ? key : undefined))
  ipcMain.handle('steam:clear-key', () => clearSteamKey())
  ipcMain.handle('steam:refresh-owned', () => refreshSteamOwned())
  ipcMain.on('steam:open-key-page', () => void shell.openExternal('https://steamcommunity.com/dev/apikey'))

  ipcMain.handle('library:uninstall-plan', (_e, id: unknown) => uninstallPlan(String(id)))
  ipcMain.handle('library:uninstall', (_e, id: unknown, removeFromList: unknown) => uninstallGame(String(id), removeFromList === true))

  // ---------- Page détaillée d'un jeu et téléchargements Steam ----------

  ipcMain.handle('details:get', (_e, id: unknown, refresh?: unknown) => getGameDetails(String(id), refresh === true))
  ipcMain.handle('downloads:get', () => downloadsState())
  // collections Steam du compte (Favoris, collections, cachés) : lecture seule du stockage cloud local
  ipcMain.handle('steam:collections', () => getSteamCollections())
  // adresses https et fiches des lanceurs seulement (vérifié par openExternalLink)
  ipcMain.on('link:open', (_e, url: unknown) => {
    if (typeof url === 'string') openExternalLink(url)
  })

  // ---------- Magasin Steam (adresses publiques de la boutique, sans compte ni cookie) ----------

  ipcMain.handle('store:home', (_e, refresh?: unknown) => getStoreHome(refresh === true))
  ipcMain.handle('store:list', (_e, kind: unknown, refresh?: unknown) => getStoreList(String(kind) as StoreListKind, refresh === true))
  ipcMain.handle('store:search', (_e, term: unknown) => searchStore(typeof term === 'string' ? term : ''))
  ipcMain.handle('store:app', (_e, appid: unknown, refresh?: unknown) => getStoreApp(Number(appid), refresh === true))

  // ---------- Profil Steam et amis (Web API, clé et SteamID de l'utilisateur seulement) ----------

  ipcMain.handle('steam:profile', (_e, refresh?: unknown) => getSteamProfile(refresh === true))
  ipcMain.handle('steam:friends', (_e, refresh?: unknown) => getSteamFriends(refresh === true))

  // ---------- Communauté Steam (actualités publiques ; Workshop avec la clé de l'utilisateur) ----------

  ipcMain.handle('community:news', (_e, refresh?: unknown) => getCommunityNews(refresh === true))
  ipcMain.handle('community:article', (_e, appid: unknown, id: unknown) => getCommunityArticle(Number(appid), String(id)))
  ipcMain.handle('community:workshop-games', (_e, refresh?: unknown) => getWorkshopGames(refresh === true))
  ipcMain.handle('community:workshop-page', (_e, appid: unknown, sort: unknown, cursor?: unknown, refresh?: unknown) =>
    getWorkshopPage(Number(appid), String(sort) as WorkshopSort, typeof cursor === 'string' ? cursor : null, refresh === true)
  )
  ipcMain.handle('community:workshop-item', (_e, id: unknown) => getWorkshopItem(String(id)))

  // ---------- Page Lanceurs (jamais d'installation sans clic) ----------

  ipcMain.handle('launchers:get', () => getLaunchers())
  ipcMain.handle('launchers:install', (_e, id: unknown) => installLauncher(id))
  ipcMain.handle('launchers:uninstall', (_e, id: unknown) => uninstallLauncher(id))
  ipcMain.on('launchers:cancel', (_e, id: unknown) => cancelLauncherOp(id))

  // ---------- Twitch (connexion par code d'appareil, streams du jeu) ----------

  ipcMain.handle('twitch:state', () => twitchState())
  ipcMain.handle('twitch:sign-in', () => startTwitchSignIn())
  ipcMain.on('twitch:cancel-sign-in', () => cancelTwitchSignIn())
  ipcMain.handle('twitch:sign-out', () => twitchSignOut())
  ipcMain.on('twitch:open-activate', () => openTwitchActivate())
  ipcMain.handle('twitch:streams', (_e, gameId: unknown, query?: unknown) =>
    getTwitchStreams(String(gameId), query && typeof query === 'object' ? (query as TwitchStreamsQuery) : {})
  )
  ipcMain.handle('twitch:search-categories', (_e, query: unknown) => searchTwitchCategories(typeof query === 'string' ? query : ''))
  ipcMain.handle('twitch:set-category', (_e, gameId: unknown, category: unknown) =>
    setTwitchCategory(String(gameId), category && typeof category === 'object' ? (category as TwitchCategory) : null)
  )

  ipcMain.handle('update:get', () => update)
  ipcMain.handle('update:check', () => checkUpdates(true))
  ipcMain.on('update:open', () => openReleasePage(update))

  ipcMain.handle('dialog:exe', async (_e, defaultPath?: string) => {
    const res = await dialog.showOpenDialog(win!, {
      title: t('main.dialog.exeTitle'),
      defaultPath,
      // Linux : binaires sans extension, AppImage, scripts : tous les fichiers
      ...(process.platform === 'win32' ? { filters: [{ name: t('main.dialog.exeFilter'), extensions: ['exe'] }] } : {}),
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:image', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: t('main.dialog.imageTitle'),
      filters: [{ name: t('main.dialog.imageFilter'), extensions: ['jpg', 'jpeg', 'png'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })
}

function registerImageProtocol(): void {
  protocol.handle('essaim', (req) => {
    const url = new URL(req.url)
    const name = url.pathname.replace(/^\//, '')
    // essaim://avatar/steam : avatar du compte Steam en cache sur ce PC
    const file = url.hostname === 'avatar' ? (name === 'steam' ? steamAvatarFile() : null) : imageFileFor(url.hostname, name)
    if (!file || !fs.existsSync(file)) return new Response(null, { status: 404 })
    // pathToFileURL encode les noms accentués (C:\Users\José…) ; fichier retiré entre-temps : 404
    return net.fetch(pathToFileURL(file).toString()).catch(() => new Response(null, { status: 404 }))
  })
}

// ---------- Démarrage ----------

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.whenReady().then(() => {
  rotateLog()
  log(`${APP_NAME} ${app.getVersion()} démarre`)
  settings = loadSettings()
  setLang(settings.language)
  Menu.setApplicationMenu(null)
  initGameDetails({ log })
  initSteamStore({ log })
  initSteamProfile({ log })
  initSteamCommunity({ log })
  initTwitch({ log, broadcast: (s) => send('twitch', s) })
  initSteamDownloads({
    log,
    send: (d) => send('downloads', d),
    resync: () => void syncPlatforms({ only: ['steam'] })
  })
  initLibrary({
    log,
    notice: sendNotice,
    broadcast: (s) => {
      send('library', s)
      // jeux Steam qui téléchargent : suivi de leur progression
      onLibraryChanged(s)
    },
    installDone: (r) => send('install-done', r),
    torrentById: (id) => lastSnapshot?.torrents.find((t) => t.id === id),
    releaseTorrent,
    resumeTorrent: (id) => toEngine({ type: 'resume', ids: [id] }),
    protocolAvailable
  })
  // les plateformes sont un plus : en cas d'échec, la fenêtre s'ouvre quand même
  try {
    initPlatforms({
      log,
      broadcast: (s) => {
        send('platforms', s)
        // lanceur apparu ou disparu : la page Lanceurs suit
        notifyLaunchers()
      },
      apply: applyPlatformScans,
      forgetOwned: forgetSteamOwned,
      hiddenCount,
      ownedCounts: steamOwnedCounts
    })
  } catch (err) {
    log(`Plateformes indisponibles : ${(err as Error)?.stack ?? err}`)
  }
  initLaunchers({ log, broadcast: (s) => send('launchers', s) })
  registerImageProtocol()
  registerIpc()
  createWindow()
  // téléchargement en cours au démarrage (état enregistré, confirmé par la première lecture de Steam)
  onLibraryChanged(libraryState())
  // torrents désactivés : aucun moteur, donc aucun port ouvert
  if (settings.torrentsEnabled) startEngine()
  else log('Torrents désactivés : moteur torrent non démarré')
  // Jeux des plateformes (Steam, Epic…) : première lecture juste après l'ouverture.
  setTimeout(() => void syncPlatforms({ full: true }), 1500)
  // Mises à jour : une vérification peu après l'ouverture, puis toutes les 12 h (si activé)
  update = { ...update, current: currentVersion() }
  setTimeout(() => void checkUpdates(false), 6000)
  setInterval(() => void checkUpdates(false), UPDATE_PERIOD)
})

app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  quitGracefully()
})

app.on('window-all-closed', () => quitGracefully())
