// Jeux web (HTML) : chaque jeu se joue dans sa propre fenêtre CyberDeck, protégée (sandbox, sans
// preload ni Node), avec sa propre session (persist:cdgame-<clé>) : ses sauvegardes ne touchent
// ni CyberDeck, ni Twitch, ni un autre jeu. Ses fichiers sont servis par cdgame://game/… (voir
// htmlServe.ts) seulement pendant que sa fenêtre est ouverte ; Internet est coupé sauf
// autorisation (filtre des requêtes, proxy fermé pour WebRTC / WebTransport, règle CSP), le réseau
// local jamais joignable (adresses et noms résolus). Le surveillant a la forme du script PowerShell
// (lignes « launched », « ended:<ms> », codes 0 / 3) : games.ts le suit avec le même code.
import { app, BrowserWindow, dialog, session } from 'electron'
import type { DownloadItem, Event as ElectronEvent, Session, WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { t } from '../shared/i18n'
import type { Notice } from '../shared/types'
import {
  dangerousDownload,
  entryUrl,
  externalOpenAllowed,
  isGameUrl,
  isPrivateHost,
  requestVerdict,
  serveGameRequest,
  type ServeCtx,
  type Verdict
} from './htmlServe'

interface Deps {
  log: (message: string) => void
  notice: (n: Notice) => void
  /** icône de CyberDeck (fenêtre d'un jeu sans icône à lui) */
  appIcon: string
  /** lien https ouvert dans le navigateur par défaut (jamais transformé en lien steam:// …) */
  openExternal: (url: string) => void
  /** tests automatiques : fenêtre hors écran, jamais active, sans boîte de confirmation */
  quiet: boolean
  /** F12 : outils de développement (version de développement seulement) */
  devTools: boolean
}

let deps: Deps

const IS_WIN = process.platform === 'win32'
const KEY_RE = /^[a-f0-9]{32}$/
/** Seules permissions accordées à un jeu ; tout le reste (caméra, micro, position, clavier…) est refusé. */
const ALLOWED = new Set<string>(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'persistent-storage', 'screen-wake-lock'])

export const partitionFor = (key: string): string => `persist:cdgame-${key}`

/** Ce qui est servi pour une clé pendant que la fenêtre de son jeu est ouverte. */
interface Served {
  gameId: string
  name: string
  ctx: ServeCtx
  /** Internet autorisé : réglage du jeu à l'ouverture de la fenêtre ET réglage actuel */
  network: () => boolean
  /** réglage réseau posé sur la session (proxy, WebRTC) */
  netApplied: boolean | null
  wc: WebContents
  netNoticeSent: boolean
  blockedLogged: number
}

const served = new Map<string, Served>()
/** sessions déjà préparées (gestionnaires posés une seule fois) */
const prepared = new Map<string, Session>()
/** fenêtre ouverte de chaque jeu */
const windows = new Map<string, { w: BrowserWindow; key: string; force: () => void }>()
/** un téléchargement à la fois par jeu */
const downloading = new Set<string>()
let lastDownloadNotice = 0
/** fermeture de CyberDeck en cours : un plantage n'est plus signalé */
let appClosing = false

export function initHtmlGames(d: Deps): void {
  deps = d
  // certificat client TLS demandé par une session de jeu, ou sans fenêtre (worker…) : aucun envoyé
  app.on('select-client-certificate', (e, wc, _url, _list, cb) => {
    if (wc && ![...prepared.values()].includes(wc.session)) return
    e.preventDefault()
    cb()
  })
}

/** Téléchargements de l'utilisateur ; dossier connu illisible : <profil>/Downloads. */
function downloadsDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return path.join(app.getPath('home'), 'Downloads')
  }
}

/** Requête bloquée : journal (20 lignes au plus par fenêtre) et message au premier blocage hors ligne. */
function noteBlocked(key: string, verdict: Verdict, url: string): void {
  const s = served.get(key)
  if (s) {
    if (s.blockedLogged < 20) {
      s.blockedLogged++
      deps.log(`Jeu web ${s.name} : requête bloquée (${verdict}) ${url.slice(0, 300)}`)
    }
    if (verdict === 'offline' && !s.netNoticeSent) {
      s.netNoticeSent = true
      deps.notice({ level: 'info', message: t('main.html.netBlocked', { name: s.name }) })
    }
  }
}

/** Requête de la page d'un jeu : permise ou non (d'après l'adresse seulement). */
function allowed(key: string, url: string): boolean {
  const verdict = requestVerdict(url, served.get(key)?.network() ?? false)
  if (verdict === 'allow') return true
  noteBlocked(key, verdict, url)
  return false
}

/** Nom d'hôte (pas une adresse IP) d'une requête https / wss : à résoudre avant de la laisser partir. */
function hostToResolve(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'wss:') return null
  const h = u.hostname
  // URL écrit déjà les adresses IPv4 sous leur forme normale (0x7f.1 → 127.0.0.1)
  if (h.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null
  return h
}

/** Résultat de la résolution des noms (une minute) : un nom public qui mène au réseau local est refusé. */
const resolved = new Map<string, { at: number; priv: boolean }>()

async function resolvesPrivate(ses: Session, host: string): Promise<boolean> {
  const known = resolved.get(host)
  if (known && Date.now() - known.at < 60_000) return known.priv
  let priv: boolean
  try {
    const r = await ses.resolveHost(host)
    priv = !r.endpoints.length || r.endpoints.some((x) => isPrivateHost(x.address))
  } catch {
    // nom introuvable : la requête échouerait de toute façon
    priv = true
  }
  if (resolved.size > 500) resolved.clear()
  resolved.set(host, { at: Date.now(), priv })
  return priv
}

/** Proxy fermé (port 9 de ce PC, rien n'y répond) : WebRTC par TURN, WebTransport et QUIC n'ont aucune sortie. */
const NO_INTERNET_PROXY = {
  mode: 'fixed_servers' as const,
  proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9',
  // sans « <-loopback> », 127.0.0.1 passerait à côté du proxy
  proxyBypassRules: '<-loopback>'
}

/**
 * Pose le réglage réseau sur la session et la page d'un jeu : Internet coupé, proxy fermé et UDP
 * hors proxy interdit à WebRTC ; Internet autorisé, connexion directe et WebRTC limité à
 * l'interface publique. Rappelé à chaque changement du réglage pendant la partie.
 */
async function applyNetwork(key: string): Promise<void> {
  const s = served.get(key)
  const ses = prepared.get(key)
  if (!s || !ses) return
  const on = s.network()
  if (s.netApplied === on) return
  s.netApplied = on
  if (!s.wc.isDestroyed()) s.wc.setWebRTCIPHandlingPolicy(on ? 'default_public_interface_only' : 'disable_non_proxied_udp')
  await ses.setProxy(on ? { mode: 'direct' } : NO_INTERNET_PROXY)
  // Internet recoupé : les connexions déjà ouvertes (WebSocket…) sont fermées
  if (!on) await ses.closeAllConnections().catch(() => {})
}

/** Réglage « Internet » d'un jeu changé : appliqué tout de suite aux fenêtres ouvertes. */
export function refreshHtmlNetwork(): void {
  for (const key of served.keys())
    void applyNetwork(key).catch((err) => deps.log(`Jeu web : réglage réseau non appliqué (${(err as Error).message})`))
}

/** Fichier enregistré depuis un jeu : fenêtre « Enregistrer sous » imposée, programmes bloqués. */
function onGameDownload(key: string, e: ElectronEvent, item: DownloadItem): void {
  const s = served.get(key)
  const name = s?.name ?? 'CyberDeck'
  const file = item.getFilename()
  if (!s || dangerousDownload(file)) {
    e.preventDefault()
    item.cancel()
    deps.log(`Jeu web ${name} : téléchargement bloqué (${file})`)
    if (s && Date.now() - lastDownloadNotice > 3000) {
      lastDownloadNotice = Date.now()
      deps.notice({ level: 'error', message: t('main.html.downloadBlocked', { name, file: path.basename(file) }) })
    }
    return
  }
  if (downloading.has(key)) {
    e.preventDefault()
    item.cancel()
    return
  }
  downloading.add(key)
  item.once('done', () => downloading.delete(key))
  item.setSaveDialogOptions({
    title: t('main.dialog.saveFromGame', { name }),
    defaultPath: path.join(downloadsDir(), path.basename(file))
  })
}

/** Session du jeu (une par clé) : permissions, appareils, réseau et protocole cdgame. */
function prepareGameSession(key: string): Session {
  const known = prepared.get(key)
  if (known) return known
  if (!KEY_RE.test(key)) throw new Error('clé de jeu web invalide')
  const ses = session.fromPartition(partitionFor(key))
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|CyberDeck|cyberdeck)\/\S+/g, ''))
  ses.setSpellCheckerEnabled(false)
  ses.setPermissionRequestHandler((_wc, p, cb, d) => cb(ALLOWED.has(p) && isGameUrl(d.requestingUrl)))
  ses.setPermissionCheckHandler((_wc, p, origin) => ALLOWED.has(p) && origin === 'cdgame://game')
  ses.setDevicePermissionHandler(() => false)
  ses.on('select-hid-device', (e, _d, cb) => {
    e.preventDefault()
    cb()
  })
  ses.on('select-usb-device', (e, _d, cb) => {
    e.preventDefault()
    cb()
  })
  ses.on('select-serial-port', (e, _l, _wc, cb) => {
    e.preventDefault()
    cb('')
  })
  // Bluetooth : aucun écouteur select-bluetooth-device (sans écouteur, Electron annule la demande)
  ses.on('will-download', (e, item) => onGameDownload(key, e, item))
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    if (!allowed(key, d.url)) return cb({ cancel: true })
    // Internet autorisé : un nom public qui mène au réseau local (rebinding, *.nip.io) est refusé
    const host = hostToResolve(d.url)
    if (!host) return cb({})
    void resolvesPrivate(ses, host).then((priv) => {
      if (priv) noteBlocked(key, 'private', d.url)
      cb({ cancel: priv })
    })
  })
  ses.protocol.handle('cdgame', (req) => {
    const s = served.get(key)
    return s ? serveGameRequest(req, s.ctx) : new Response(null, { status: 404 })
  })
  prepared.set(key, ses)
  return ses
}

/**
 * Surveillant d'un jeu web, au format du processus du script PowerShell (stdout, stderr,
 * « close », kill) : « launched » dès la création, « ended:<ms> » puis code 0 à la fermeture de
 * la fenêtre, code 3 avec le message si la page ne se charge pas. N'émet jamais « error ».
 */
export class HtmlGameWatcher extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private closed = false
  private readonly onKill: () => void

  constructor(onKill: () => void) {
    super()
    this.onKill = onKill
    this.stdout.write('launched\n')
  }

  private close(code: number): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    // les dernières lignes passent avant « close » (comme pour un vrai processus)
    setTimeout(() => this.emit('close', code), 50)
  }

  /** Fenêtre fermée : fin normale de la partie. */
  end(): void {
    if (this.closed) return
    this.stdout.write(`ended:${Date.now()}\n`)
    this.close(0)
  }

  /** Page impossible à charger : code 3 avec le message. */
  fail(message: string): void {
    if (this.closed) return
    this.stderr.write(message)
    this.close(3)
  }

  /** Arrêter : fermeture forcée mais propre (le « unload » du jeu s'exécute). */
  kill(): boolean {
    this.onKill()
    return true
  }
}

export interface HtmlBounds {
  width: number | null
  height: number | null
  fullscreen: boolean
}

export interface OpenHtmlOptions {
  gameId: string
  name: string
  key: string
  realRoot: string
  relEntry: string
  iconFile: string | null
  bounds: HtmlBounds
  network: () => boolean
  onBounds: (b: HtmlBounds) => void
}

/** Ouvre la fenêtre d'un jeu web ; erreur si elle est déjà ouverte. */
export function openHtmlGame(o: OpenHtmlOptions): HtmlGameWatcher {
  if (windows.has(o.gameId)) throw new Error('fenêtre du jeu déjà ouverte')
  if (served.has(o.key)) throw new Error('jeu web déjà ouvert')
  const ses = prepareGameSession(o.key)
  const quiet = deps.quiet
  const b = o.bounds
  const w = new BrowserWindow({
    ...(quiet ? { x: -20000, y: 0, skipTaskbar: true } : {}),
    width: b.width ?? 1280,
    height: b.height ?? 720,
    useContentSize: true,
    minWidth: 320,
    minHeight: 240,
    show: false,
    backgroundColor: '#000000',
    title: o.name,
    icon: o.iconFile ?? deps.appIcon,
    autoHideMenuBar: true,
    fullscreenable: true,
    webPreferences: {
      partition: partitionFor(o.key),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      enableWebSQL: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: !quiet,
      devTools: deps.devTools
    }
  })
  const wc = w.webContents
  let closing = false
  let forced = false
  let loaded = false
  let lastOpenAt = 0
  // dernier clic, touche ou toucher de l'utilisateur dans la fenêtre du jeu
  let lastInputAt = 0
  let size: { width: number; height: number } | null = b.width && b.height ? { width: b.width, height: b.height } : null
  let fullscreen = b.fullscreen
  let resizeTimer: NodeJS.Timeout | null = null
  let destroyTimer: NodeJS.Timeout | null = null

  const force = (): void => {
    if (w.isDestroyed()) return
    forced = true
    w.close()
    if (!destroyTimer)
      destroyTimer = setTimeout(() => {
        if (!w.isDestroyed()) w.destroy()
      }, 3000)
  }
  const watcher = new HtmlGameWatcher(force)
  // Internet autorisé seulement s'il l'était à l'ouverture (le message « coupé » demande de relancer
  // le jeu) et s'il l'est toujours ; recoupé pendant la partie, il l'est tout de suite
  const netAtOpen = o.network()
  const network = (): boolean => netAtOpen && o.network()
  served.set(o.key, {
    gameId: o.gameId,
    name: o.name,
    ctx: { realRoot: o.realRoot, isWin: IS_WIN, caseFallback: !IS_WIN, dirCache: new Map(), network },
    network,
    netApplied: null,
    wc,
    netNoticeSent: false,
    blockedLogged: 0
  })
  windows.set(o.gameId, { w, key: o.key, force })

  const maybeOpenOutside = (url: string): void => {
    const now = Date.now()
    if (externalOpenAllowed(url, { focused: !w.isDestroyed() && w.isFocused(), network: network(), lastInputAt, lastOpenAt, now })) {
      lastOpenAt = now
      deps.log(`Jeu web ${o.name} : lien ouvert dans le navigateur ${url.slice(0, 300)}`)
      deps.openExternal(url)
    } else deps.log(`Jeu web ${o.name} : lien refusé ${String(url).slice(0, 300)}`)
  }
  const rememberSize = (): void => {
    if (w.isDestroyed() || w.isFullScreen() || w.isMinimized() || w.isMaximized()) return
    const [width, height] = w.getContentSize()
    if (width > 0 && height > 0) size = { width, height }
  }

  w.setMenu(null)
  // politique WebRTC la plus stricte jusqu'à ce que le réglage réseau soit posé (applyNetwork)
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  // certificat client TLS (magasin Windows) : jamais envoyé à un serveur choisi par le jeu
  wc.on('select-client-certificate', (e, _url, _list, cb) => {
    e.preventDefault()
    ;(cb as (c?: Electron.Certificate) => void)()
  })
  wc.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'rawKeyDown' || input.type === 'touchStart' || input.type === 'gestureTap')
      lastInputAt = Date.now()
  })
  wc.setWindowOpenHandler(({ url }) => {
    maybeOpenOutside(url)
    return { action: 'deny' }
  })
  const guardNav = (e: { preventDefault: () => void }, url: string): void => {
    if (isGameUrl(url)) return
    e.preventDefault()
    maybeOpenOutside(url)
  }
  /** Adresse permise dans une iframe du jeu (jamais ouverte dans le navigateur). */
  const subframeOk = (u: string): boolean =>
    isGameUrl(u) || u === 'about:blank' || u === 'about:srcdoc' || u.startsWith('blob:') || u.startsWith('data:') || (u.startsWith('https:') && network())
  wc.on('will-navigate', (e, url) => guardNav(e, url))
  wc.on('will-redirect', (details) => {
    // redirection d'une iframe : même règle que sa navigation, pas celle de la fenêtre
    if (!details.isMainFrame) {
      if (!subframeOk(details.url)) details.preventDefault()
      return
    }
    guardNav(details, details.url)
  })
  wc.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    if (!subframeOk(details.url)) details.preventDefault()
  })
  // fetch / WebSocket arrêtés par la règle CSP (connect-src) avant le filtre réseau : notés pareil
  // (journal, message « Internet coupé ») d'après l'avertissement de Chromium dans la console
  wc.on('console-message', (details) => {
    const m = /^(?:Refused to connect to|Connecting to) '([^']{1,2048})'.*Content Security Policy/s.exec(details.message ?? '')
    if (!m) return
    const verdict = requestVerdict(m[1], network())
    noteBlocked(o.key, verdict === 'allow' ? 'offline' : verdict, m[1])
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
  w.on('page-title-updated', (e) => e.preventDefault())
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11' || (input.alt && input.key === 'Enter')) {
      e.preventDefault()
      w.setFullScreen(!w.isFullScreen())
    } else if (input.key === 'F12' && deps.devTools) {
      e.preventDefault()
      wc.toggleDevTools()
    }
  })

  w.on('close', () => {
    closing = true
    rememberSize()
  })
  wc.on('will-prevent-unload', (e) => {
    // navigation ou rechargement : jamais bloqué par le jeu
    if (!closing || forced || quiet) {
      e.preventDefault()
      return
    }
    // croix de la fenêtre : la fermeture est annulée, notre boîte demande
    void dialog
      .showMessageBox(w, {
        type: 'question',
        title: t('main.html.leaveTitle', { name: o.name }),
        message: t('main.html.leaveTitle', { name: o.name }),
        detail: t('main.html.leaveDetail'),
        buttons: [t('main.html.leave'), t('main.html.stay')],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      .then((r) => {
        if (r.response === 0) force()
        else closing = false
      })
      .catch(() => {
        closing = false
      })
  })

  wc.on('did-finish-load', () => {
    loaded = true
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    if (!loaded) {
      watcher.fail(t('main.html.loadFailed', { error: desc || String(code) }))
      if (!w.isDestroyed()) w.destroy()
    } else deps.log(`Jeu web ${o.name} : chargement impossible (${desc || code}) ${String(url).slice(0, 300)}`)
  })
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || appClosing) return
    deps.log(`Jeu web ${o.name} : page arrêtée (${details.reason}, code ${details.exitCode})`)
    deps.notice({ level: 'error', message: t('main.html.crashed', { name: o.name }) })
    if (!w.isDestroyed()) w.destroy()
  })

  w.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(rememberSize, 500)
  })
  w.on('enter-full-screen', () => (fullscreen = true))
  w.on('leave-full-screen', () => (fullscreen = false))
  w.on('closed', () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    if (destroyTimer) clearTimeout(destroyTimer)
    served.delete(o.key)
    windows.delete(o.gameId)
    try {
      ses.flushStorageData()
    } catch {
      // session déjà fermée (fin de l'app)
    }
    try {
      o.onBounds({ width: size?.width ?? null, height: size?.height ?? null, fullscreen })
    } catch (err) {
      deps.log(`Jeu web ${o.name} : taille non enregistrée (${(err as Error).message})`)
    }
    watcher.end()
  })

  let shown = false
  const show = (): void => {
    if (shown || w.isDestroyed()) return
    shown = true
    if (quiet) w.showInactive()
    else w.show()
    if (b.fullscreen) w.setFullScreen(true)
  }
  w.once('ready-to-show', show)
  setTimeout(show, 1500)

  // réglage réseau (proxy, WebRTC) posé avant le chargement de la page
  applyNetwork(o.key).then(
    () => {
      if (w.isDestroyed()) return
      wc.loadURL(entryUrl(o.relEntry)).catch(() => {
        // échec déjà traité par did-fail-load
      })
    },
    (err) => {
      // sans son réglage réseau, la page ne se charge pas
      watcher.fail(t('main.html.loadFailed', { error: (err as Error).message }))
      if (!w.isDestroyed()) w.destroy()
    }
  )
  return watcher
}

/** Met la fenêtre d'un jeu au premier plan (réduite : restaurée). */
export function focusHtmlGame(gameId: string): boolean {
  const entry = windows.get(gameId)
  if (!entry || entry.w.isDestroyed()) return false
  const w = entry.w
  if (w.isMinimized()) w.restore()
  if (deps.quiet) w.showInactive()
  else {
    w.show()
    w.focus()
  }
  return true
}

/** La fenêtre d'un jeu de cette clé est ouverte. */
export const isKeyOpen = (key: string): boolean => served.has(key)

/**
 * Fermeture de CyberDeck : chaque fenêtre de jeu est fermée proprement (le « unload » du jeu
 * s'exécute), puis détruite au bout du délai ; les sauvegardes sont écrites sur le disque.
 */
export async function closeAllHtmlGames(timeoutMs: number): Promise<void> {
  appClosing = true
  const list = [...windows.values()].filter((e) => !e.w.isDestroyed())
  await new Promise<void>((resolve) => {
    if (!list.length) return resolve()
    let left = list.length
    const timer = setTimeout(resolve, timeoutMs)
    for (const e of list) {
      e.w.once('closed', () => {
        if (--left === 0) {
          clearTimeout(timer)
          resolve()
        }
      })
      e.force()
    }
  })
  for (const e of list) if (!e.w.isDestroyed()) e.w.destroy()
  for (const ses of prepared.values()) {
    try {
      ses.flushStorageData()
    } catch {
      // session indisponible
    }
  }
}

/**
 * Efface les sauvegardes d'un jeu web (partition persist:cdgame-<clé>). Session jamais ouverte
 * pendant cette exécution : son dossier est simplement supprimé. Session ouverte : ses données
 * sont effacées par Chromium (son dossier reste, ses fichiers sont tenus ouverts).
 */
export async function clearHtmlSaves(key: string): Promise<void> {
  if (!KEY_RE.test(key)) throw new Error('clé de jeu web invalide')
  if (isKeyOpen(key)) throw new Error('jeu web ouvert')
  const dir = path.join(app.getPath('userData'), 'Partitions', `cdgame-${key}`)
  const ses = prepared.get(key)
  if (ses) {
    await ses.clearStorageData()
    await ses.clearCache()
    await ses.clearCodeCaches({})
    ses.flushStorageData()
    return
  }
  // fromPartition créerait le dossier : rien à faire s'il n'existe pas
  if (!fs.existsSync(dir)) return
  await fsp.rm(dir, { recursive: true, force: true }).catch((err) => deps.log(`Sauvegardes de ${key} : dossier pas entièrement supprimé (${(err as Error).message})`))
}
