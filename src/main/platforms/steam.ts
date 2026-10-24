// Steam : client, bibliothèques, jeux installés (appmanifest_*.acf), type des
// applications (appinfo.vdf) pour écarter outils / redistribuables / serveurs,
// compte connecté (SteamID64), temps de jeu local, jeux possédés (liste fournie
// par steamOwned.ts) et images locales.
import fs from 'node:fs'
import path from 'node:path'
import type { PlatformSkipReason } from '../../shared/types'
import { protocolCommand, regNumber, regString } from './registry'
import type { RegistrySnapshot } from './registry'
import type { OwnedGamesResult } from './steamOwned'
import type { DetectedGame, PlatformScan, ScanContext } from './types'
import { findLinuxSteamClient } from './steamLinux'
import { cleanTitle, exeFromCommand, fixSlashes, isDir, isFile, isWindows, largestExeSync, normDir, readText, skip } from './util'
import { kvGet, parseVdf, readAppInfo, vdfGet, vdfObj, vdfStr, type KvMap } from './vdf'

const STEAM_ID_BASE = 76561197960265728n

/** Identifiants jamais montrés (outils connus), quand appinfo.vdf ne dit rien. */
const KNOWN_TOOLS = new Set([228980, 250820, 431960, 1070560, 1391110, 1628350, 1493710, 1826330, 2180100, 1161040, 1580130, 2805730])
/** Parmi eux, des logiciels (Wallpaper Engine) plutôt que des outils. */
const KNOWN_APPS = new Set([431960])
const TOOL_NAME =
  /redistributable|steamvr|wallpaper engine|dedicated server|\bserver\b|soundtrack|\bost\b|\bsdk\b|proton|steam linux runtime|benchmark|\beditor\b|steamworks|mod tools?|authoring tools?/i
const OTHER_NAME = /soundtrack|\bost\b|artbook|\bvideo\b/i

/** Fichier VDF texte complet : il se termine par l'accolade de son objet racine (sinon : en cours d'écriture). */
const vdfComplete = (text: string): boolean => text.trimEnd().endsWith('}')

// ---------- Client ----------

export interface SteamClient {
  dir: string
  exe: string
}

let lastClient: SteamClient | null = null
export const cachedSteamClient = (): SteamClient | null => lastClient

export function findSteamClient(reg: RegistrySnapshot): SteamClient | null {
  // Linux : pas de registre ; dossiers connus (~/.steam/steam, ~/.local/share/Steam, Flatpak, Snap)
  if (!isWindows()) return findLinuxSteamClient()
  const candidates = [
    regString(reg, 'steam.machine', 'InstallPath'),
    regString(reg, 'steam.machine64', 'InstallPath'),
    regString(reg, 'steam.user', 'SteamPath'),
    (() => {
      const exe = regString(reg, 'steam.user', 'SteamExe') ?? exeFromCommand(protocolCommand(reg, 'steam'))
      return exe ? path.dirname(fixSlashes(exe)) : null
    })(),
    // registre illisible (PowerShell bloqué…) : dossiers par défaut
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Steam')
  ]
  for (const c of candidates) {
    if (!c) continue
    const dir = fixSlashes(c)
    const exe = path.join(dir, 'steam.exe')
    if (isFile(exe)) return { dir, exe }
  }
  return null
}

// ---------- Bibliothèques et manifestes ----------

/**
 * Bibliothèques Steam (dossier de Steam + libraryfolders.vdf). suspect : le fichier existe mais
 * semble coupé (en cours d'écriture) : des bibliothèques peuvent manquer à cette lecture.
 */
export function steamLibrariesInfo(steamDir: string): { dirs: string[]; suspect: boolean } {
  const dirs = [steamDir]
  let suspect = false
  for (const file of [path.join(steamDir, 'steamapps', 'libraryfolders.vdf'), path.join(steamDir, 'config', 'libraryfolders.vdf')]) {
    const text = readText(file)
    if (text === null) continue
    const root = vdfComplete(text) ? vdfObj(parseVdf(text), 'libraryfolders') : null
    if (!root) {
      suspect = true
      continue // copie coupée : on essaie l'autre exemplaire (config\libraryfolders.vdf)
    }
    suspect = false
    for (const v of Object.values(root)) {
      if (typeof v === 'string') {
        if (/^[a-z]:\\/i.test(v) || (!isWindows() && v.startsWith('/'))) dirs.push(v) // ancien format : "1" "D:\\SteamLibrary"
      } else {
        const p = vdfStr(v, 'path')
        if (p) dirs.push(p)
      }
    }
    break
  }
  const seen = new Set<string>()
  const out = dirs
    .map(fixSlashes)
    .filter((d) => {
      const k = normDir(d)
      if (seen.has(k) || !isDir(path.join(d, 'steamapps'))) return false
      seen.add(k)
      return true
    })
  return { dirs: out, suspect }
}

export const steamLibraries = (steamDir: string): string[] => steamLibrariesInfo(steamDir).dirs

export interface SteamManifest {
  appid: number
  name: string
  installdir: string
  library: string
  stateFlags: number
  lastPlayed: number
  sizeOnDisk: number
  /** build installé (0 : jamais installé complètement) */
  buildid: number
  /** dernière mise à jour terminée (secondes Unix ; 0 : jamais) */
  lastUpdated: number
  /** dépôts déjà installés */
  depots: number
}

/**
 * Manifestes appmanifest_*.acf de toutes les bibliothèques. unreadable : appid dont le fichier
 * existe mais n'a pas pu être lu (vide, coupé, verrouillé, sans appid ni installdir) : Steam est
 * sans doute en train de l'écrire ; ce n'est pas une désinstallation.
 */
export function readManifests(libraries: string[]): { manifests: SteamManifest[]; unreadable: number[] } {
  const out: SteamManifest[] = []
  const unreadable = new Set<number>()
  const seen = new Set<number>()
  for (const lib of libraries) {
    const dir = path.join(lib, 'steamapps')
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const m = /^appmanifest_(\d+)\.acf$/i.exec(f)
      if (!m) continue
      const fileId = Number(m[1])
      const text = readText(path.join(dir, f))
      const st = text && vdfComplete(text) ? vdfObj(parseVdf(text), 'AppState') : null
      const appid = st ? Number(vdfStr(st, 'appid') ?? m[1]) : 0
      const installdir = st ? (vdfStr(st, 'installdir') ?? '') : ''
      if (!st || !appid || !installdir) {
        if (fileId) unreadable.add(fileId)
        continue
      }
      if (seen.has(appid)) continue
      seen.add(appid)
      const num = (k: string): number => Number(vdfStr(st, k) ?? 0) || 0
      const depots = vdfObj(st, 'InstalledDepots')
      out.push({
        appid,
        name: vdfStr(st, 'name') ?? '',
        installdir,
        library: lib,
        stateFlags: num('StateFlags'),
        lastPlayed: num('LastPlayed'),
        sizeOnDisk: num('SizeOnDisk'),
        buildid: num('buildid'),
        lastUpdated: num('LastUpdated'),
        depots: depots && typeof depots === 'object' ? Object.keys(depots).length : 0
      })
    }
  }
  // un manifeste lu dans une autre bibliothèque compte (copie en double d'un même jeu)
  for (const id of seen) unreadable.delete(id)
  return { manifests: out, unreadable: [...unreadable] }
}

// ---------- appinfo.vdf ----------

export interface SteamLaunchEntry {
  executable: string
  /** options de lancement (ex. « -exe DayZ_x64.exe ») */
  arguments: string
  type: string
  oslist: string
  osarch: string
  betaKey: string
  ownsDlc: string
}

export interface SteamAppInfo {
  type: string | null
  name: string | null
  parent: number | null
  icon: string | null
  /** chemin de la jaquette portrait (2x de préférence) sous store_item_assets/steam/apps/<appid>/ */
  capsule: string | null
  /** bandeau de la bibliothèque (library_hero), même dossier ; null si inconnu */
  hero: string | null
  /** logo de la bibliothèque (library_logo), même dossier ; null si inconnu */
  logo: string | null
  launch: SteamLaunchEntry[]
}

let appInfoCache: { stamp: string; apps: Map<number, SteamAppInfo | null> } | null = null

function toAppInfo(kv: KvMap): SteamAppInfo {
  const common = kvGet(kv, 'appinfo', 'common') as KvMap | undefined
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null)
  const assetOf = (asset: string, k: string): string | null => {
    const node = kvGet(common, 'library_assets_full', asset, k) as KvMap | undefined
    if (!node || typeof node !== 'object') return null
    return str(node.english) ?? str(Object.values(node)[0])
  }
  const capsuleOf = (k: string): string | null => assetOf('library_capsule', k)
  const launchNode = kvGet(kv, 'appinfo', 'config', 'launch')
  const launch: SteamLaunchEntry[] = []
  if (launchNode && typeof launchNode === 'object') {
    for (const e of Object.values(launchNode as KvMap)) {
      if (!e || typeof e !== 'object') continue
      launch.push({
        executable: str(kvGet(e, 'executable')) ?? '',
        arguments: str(kvGet(e, 'arguments')) ?? '',
        type: (str(kvGet(e, 'type')) ?? '').toLowerCase(),
        oslist: (str(kvGet(e, 'config', 'oslist')) ?? '').toLowerCase(),
        osarch: str(kvGet(e, 'config', 'osarch')) ?? '',
        betaKey: str(kvGet(e, 'config', 'BetaKey')) ?? '',
        ownsDlc: str(kvGet(e, 'config', 'ownsdlc')) ?? ''
      })
    }
  }
  const parent = Number(str(kvGet(common, 'parent')) ?? NaN)
  return {
    type: str(kvGet(common, 'type'))?.toLowerCase() ?? null,
    name: str(kvGet(common, 'name')),
    parent: Number.isFinite(parent) && parent > 0 ? parent : null,
    icon: str(kvGet(common, 'icon')),
    capsule: capsuleOf('image2x') ?? capsuleOf('image'),
    hero: assetOf('library_hero', 'image') ?? assetOf('library_hero', 'image2x'),
    logo: assetOf('library_logo', 'image2x') ?? assetOf('library_logo', 'image'),
    launch
  }
}

/** Infos appinfo.vdf des appid demandés ; error si le fichier est absent ou illisible. */
export function steamAppInfo(steamDir: string, appids: number[]): { apps: Map<number, SteamAppInfo | null>; error: string | null } {
  const file = path.join(steamDir, 'appcache', 'appinfo.vdf')
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return { apps: new Map(), error: 'appinfo.vdf absent' }
  }
  const stamp = `${stat.size}:${stat.mtimeMs}`
  if (!appInfoCache || appInfoCache.stamp !== stamp) appInfoCache = { stamp, apps: new Map() }
  const missing = appids.filter((id) => !appInfoCache!.apps.has(id))
  if (missing.length) {
    // Steam réécrit parfois le fichier pendant la lecture : on réessaie une fois.
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const found = readAppInfo(fs.readFileSync(file), new Set(missing))
        for (const id of missing) {
          const kv = found.get(id)
          appInfoCache.apps.set(id, kv ? toAppInfo(kv) : null)
        }
        lastErr = null
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (lastErr) return { apps: new Map(), error: `appinfo.vdf illisible : ${(lastErr as Error).message}` }
  }
  const apps = new Map<number, SteamAppInfo | null>()
  for (const id of appids) apps.set(id, appInfoCache.apps.get(id) ?? null)
  return { apps, error: null }
}

/** Jeu (ou démo) d'après appinfo ; sinon d'après la liste d'outils connus et le nom. */
export function isSteamGame(appid: number, name: string, info: SteamAppInfo | null | undefined, allowDemo = true): boolean {
  if (info?.type) return info.type === 'game' || (allowDemo && info.type === 'demo')
  return !KNOWN_TOOLS.has(appid) && !TOOL_NAME.test(name)
}

/** Raison affichée pour une application Steam écartée (fenêtre Plateformes). */
export function steamSkipReason(appid: number, name: string, info: SteamAppInfo | null | undefined, storeType?: number | null): PlatformSkipReason {
  const t = info?.type
  if (t) return t === 'tool' || t === 'config' ? 'tool' : t === 'application' ? 'app' : t === 'dlc' ? 'dlc' : 'other'
  // types de la boutique : 4 DLC, 6 logiciel (les autres : vidéo, musique, matériel…)
  if (storeType === 4) return 'dlc'
  if (storeType === 6) return 'app'
  if (KNOWN_APPS.has(appid) || /wallpaper engine/i.test(name)) return 'app'
  if (OTHER_NAME.test(name)) return 'other'
  if (KNOWN_TOOLS.has(appid) || TOOL_NAME.test(name)) return 'tool'
  return 'other'
}

/** Système d'une entrée de lancement : Windows seul sous Windows ; Linux ou Windows (Proton) sous Linux. */
const oslistOk = (oslist: string): boolean => {
  const l = oslist.split(',')
  return l.includes('windows') || (!isWindows() && l.includes('linux'))
}
/** Sous Linux : entrée Linux (jeu natif) avant l'entrée Windows (jeu Proton). */
const linuxFirst = (e: SteamLaunchEntry): number => (e.oslist.split(',').includes('linux') ? 0 : 10)

/** Programme du jeu (icône, surveillance) d'après les entrées de lancement d'appinfo. */
export function steamExe(installDir: string, info: SteamAppInfo | null | undefined): string | null {
  const rank = (e: SteamLaunchEntry): number => {
    let r = e.type === 'default' ? 0 : e.type === '' || e.type === 'none' ? 1 : /^option\d+$/.test(e.type) ? 2 + Number(e.type.slice(6)) / 100 : 9
    if (e.osarch === '32') r += 0.5
    return r
  }
  const entries = (info?.launch ?? [])
    .filter(
      (e) =>
        e.executable &&
        !/^steam:/i.test(e.executable) &&
        (isWindows() ? /\.exe$/i.test(e.executable) : true) &&
        !e.betaKey &&
        !e.ownsDlc &&
        (!e.oslist || oslistOk(e.oslist))
    )
    .sort((a, b) => rank(a) - rank(b) + (isWindows() ? 0 : linuxFirst(a) - linuxFirst(b)))
  for (const e of entries) {
    const p = path.join(installDir, fixSlashes(e.executable))
    if (isFile(p)) return p
  }
  return largestExeSync(installDir)
}

/** Programmes d'infrastructure jamais pris pour le jeu (noms de repli). */
const NOT_GAME_PROCESS = /^(unins\d*|uninstall.*|setup.*|.*redist.*|dxsetup|.*crash.*|.*report.*|.*helper.*|ue\d?prereq.*|dotnet.*|.*webhelper.*)\.exe$/i

/**
 * Noms de processus de repli (chemin d'un processus illisible : jeu protégé par un anti-triche) :
 * tous les programmes de lancement d'appinfo qui existent (lanceur, option1, option2…), le
 * programme passé par « -exe nom.exe » (DayZ_BE.exe -exe DayZ_x64.exe) et le programme retenu.
 */
export function steamProcessNames(installDir: string, info: SteamAppInfo | null | undefined, exe: string | null): string[] {
  const names = new Set<string>()
  const add = (p: string | null): void => {
    if (!p || !isFile(p)) return
    const base = path.basename(p)
    // Linux : programmes natifs (sans .exe) aussi
    if ((/\.exe$/i.test(base) || !isWindows()) && !NOT_GAME_PROCESS.test(/\.exe$/i.test(base) ? base : base + '.exe')) names.add(base)
  }
  add(exe)
  for (const e of info?.launch ?? []) {
    if (!e.executable || /^steam:/i.test(e.executable) || (isWindows() && !/\.exe$/i.test(e.executable))) continue
    if (e.oslist && !oslistOk(e.oslist)) continue
    const p = path.join(installDir, fixSlashes(e.executable))
    add(p)
    const target = /(?:^|\s)-exe\s+("([^"]+)"|(\S+))/i.exec(e.arguments)
    const rel = target?.[2] ?? target?.[3]
    if (rel) {
      add(path.join(path.dirname(p), fixSlashes(rel)))
      add(path.join(installDir, fixSlashes(rel)))
    }
  }
  return [...names].slice(0, 12)
}

// ---------- Compte ----------

export interface SteamAccount {
  steamId: string
  accountId: number
  personaName: string | null
  avatarFile: string | null
}

export function steamAccount(reg: RegistrySnapshot, steamDir: string | null): SteamAccount | null {
  let steamId: bigint | null = null
  const active = regNumber(reg, 'steam.active', 'ActiveUser')
  if (active && active > 0) steamId = STEAM_ID_BASE + BigInt(active)

  let users: Record<string, unknown> = {}
  const text = steamDir ? readText(path.join(steamDir, 'config', 'loginusers.vdf')) : null
  if (text) users = (vdfObj(parseVdf(text), 'users') as Record<string, unknown>) ?? {}
  if (!steamId) {
    const ids = Object.keys(users).filter((k) => /^\d{17}$/.test(k))
    const auto = (regString(reg, 'steam.user', 'AutoLoginUser') ?? '').toLowerCase()
    const pick =
      ids.find((id) => auto && (vdfStr(users[id], 'AccountName') ?? '').toLowerCase() === auto) ??
      ids.find((id) => vdfStr(users[id], 'MostRecent') === '1') ??
      ids.find((id) => vdfStr(users[id], 'AutoLogin') === '1') ??
      ids.sort((a, b) => Number(vdfStr(users[b], 'Timestamp') ?? 0) - Number(vdfStr(users[a], 'Timestamp') ?? 0))[0]
    if (pick) steamId = BigInt(pick)
  }
  if (!steamId || steamId <= STEAM_ID_BASE) return null
  const id = steamId.toString()
  const avatar = steamDir ? path.join(steamDir, 'config', 'avatarcache', `${id}.png`) : null
  return {
    steamId: id,
    accountId: Number(steamId - STEAM_ID_BASE),
    personaName: vdfStr(users[id], 'PersonaName'),
    avatarFile: avatar && isFile(avatar) ? avatar : null
  }
}

// Temps de jeu de ce compte sur ce PC (localconfig.vdf) : seul le sous-arbre
// « apps » est lu ; le reste du fichier (jetons, sessions) n'est jamais gardé.
let playtimeCache: { file: string; stamp: string; map: Map<number, { minutes: number; lastPlayed: number }> } | null = null

export function steamLocalPlaytime(steamDir: string, accountId: number): Map<number, { minutes: number; lastPlayed: number }> {
  const file = path.join(steamDir, 'userdata', String(accountId), 'config', 'localconfig.vdf')
  let stamp = ''
  try {
    const st = fs.statSync(file)
    stamp = `${st.size}:${st.mtimeMs}`
  } catch {
    return new Map()
  }
  if (playtimeCache && playtimeCache.file === file && playtimeCache.stamp === stamp) return playtimeCache.map
  const map = new Map<number, { minutes: number; lastPlayed: number }>()
  try {
    const text = readText(file)
    if (text) {
      const apps = vdfGet(parseVdf(text), 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps')
      if (apps && typeof apps === 'object') {
        for (const [k, v] of Object.entries(apps as Record<string, unknown>)) {
          const appid = Number(k)
          if (!Number.isInteger(appid) || appid <= 0 || appid >= 2 ** 31) continue
          const minutes = Number(vdfStr(v, 'Playtime') ?? 0) || 0
          const lastPlayed = Number(vdfStr(v, 'LastPlayed') ?? 0) || 0
          if (minutes || lastPlayed) map.set(appid, { minutes, lastPlayed })
        }
      }
    }
  } catch {
    // fichier illisible : pas de temps de jeu local
  }
  playtimeCache = { file, stamp, map }
  return map
}

// ---------- Images locales ----------

/** Jaquette en cache dans Steam (300×450), utile hors ligne. */
export function steamLocalCover(appid: number): string | null {
  const client = lastClient
  if (!client) return null
  const root = path.join(client.dir, 'appcache', 'librarycache', String(appid))
  const wanted = ['library_600x900.jpg', 'library_capsule.jpg', 'header.jpg', 'library_header.jpg']
  const found = new Map<string, string>()
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory() && depth < 2) walk(path.join(dir, e.name), depth + 1)
      else if (e.isFile() && wanted.includes(e.name.toLowerCase()) && !found.has(e.name.toLowerCase())) found.set(e.name.toLowerCase(), path.join(dir, e.name))
    }
  }
  walk(root, 0)
  for (const w of wanted) if (found.has(w)) return found.get(w)!
  return null
}

export const steamCapsuleUrl = (appid: number, capsule: string): string =>
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/${capsule.replace(/^\/+/, '')}`

export const steamIconUrl = (appid: number, hash: string): string =>
  `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`

// ---------- Passage complet ----------

const launchFor = (appid: number): DetectedGame['launch'] => ({ kind: 'uri', target: `steam://rungameid/${appid}`, args: null, cwd: null })

// StateFlags : 2 mise à jour requise, 4 entièrement installé, 256 mise à jour en cours, 512 en pause,
// 1024 commencée, 2048 désinstallation, 131072 validation, 1048576 téléchargement, 2097152
// préparation, 4194304 écriture. Un jeu qui se met à jour peut perdre le bit 4 le temps de la mise à jour.
const UPDATE_BUSY = 256 | 512 | 1024 | 131072 | 1048576 | 2097152 | 4194304
const UPDATE_ANY = 2 | UPDATE_BUSY
const UNINSTALLING = 2048

/** Installé : entièrement (bit 4), ou déjà installé une fois et en cours de mise à jour (dossier présent, build connu). */
export function steamInstalled(m: SteamManifest, installDir: string | null): boolean {
  if (m.stateFlags & 4) return true
  if (m.stateFlags & UNINSTALLING || !(m.stateFlags & UPDATE_ANY)) return false
  return isDir(installDir) && (m.buildid > 0 || m.lastUpdated > 0 || m.depots > 0)
}

/**
 * Opération en cours : 'updating' seulement si une mise à jour tourne (ou est en pause), ou si le
 * jeu a perdu le bit 4 pendant sa mise à jour ; « mise à jour requise » seule (bit 2, mise à jour
 * en file d'attente ou automatique coupée) n'affiche rien.
 */
function stateOf(flags: number, installed: boolean): DetectedGame['state'] {
  if (!(flags & 4)) return installed ? 'updating' : 'downloading'
  if (flags & UPDATE_BUSY) return 'updating'
  return null
}

export interface SteamScanExtra {
  /** liste des jeux possédés (null : pas de clé ou pas de compte) */
  owned: OwnedGamesResult | null
  /** types de la boutique pour les appid absents d'appinfo.vdf (0 = jeu) */
  storeTypes?: (appids: number[]) => Promise<Map<number, number | null>>
}

export async function scanSteam(ctx: ScanContext, extra: SteamScanExtra): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'steam', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  const client = findSteamClient(ctx.reg)
  lastClient = client
  if (!client) {
    // sans client, pas de manifeste lisible ; la liste possédée seule n'a pas de sens
    return scan
  }
  scan.clientPath = client.exe
  scan.detected = true

  const { dirs: libraries, suspect } = steamLibrariesInfo(client.dir)
  const { manifests, unreadable } = readManifests(libraries)
  // Fichier en cours d'écriture : ses jeux ne sont pas « désinstallés », on relit bientôt.
  if (unreadable.length) {
    scan.keep = unreadable.map(String)
    scan.retry = true
    ctx.log(`Steam : ${unreadable.length} manifeste(s) illisible(s) pour l’instant (${unreadable.join(', ')}), nouvelle lecture bientôt`)
  }
  if (suspect) {
    // libraryfolders.vdf coupé : une bibliothèque peut manquer, aucun jeu n'est marqué désinstallé
    scan.partial = true
    scan.retry = true
    ctx.log('Steam : libraryfolders.vdf illisible pour l’instant, nouvelle lecture bientôt')
  }
  const account = steamAccount(ctx.reg, client.dir)
  const owned = extra.owned?.status === 'ok' ? extra.owned.games : null
  const ownedIds = owned ? new Set(owned.map((g) => g.appid)) : null
  const allIds = [...new Set([...manifests.map((m) => m.appid), ...(owned ?? []).map((g) => g.appid)])]
  const { apps, error } = steamAppInfo(client.dir, allIds)
  if (error) ctx.log(`Steam : ${error} (repli sur le nom pour écarter les outils)`)
  const local = account ? steamLocalPlaytime(client.dir, account.accountId) : new Map()
  const ownedById = new Map((owned ?? []).map((g) => [g.appid, g]))

  const installedIds = new Set<number>()
  /** applications installées écartées (pas des jeux) : pas comptées une seconde fois avec la liste possédée */
  const skippedIds = new Set<number>()
  for (const m of manifests) {
    const info = apps.get(m.appid)
    const name = cleanTitle(info?.name || m.name || `App ${m.appid}`)
    if (!isSteamGame(m.appid, m.name || name, info)) {
      skip(scan, name, steamSkipReason(m.appid, m.name || name, info))
      skippedIds.add(m.appid)
      continue
    }
    const installDir = m.installdir ? path.join(m.library, 'steamapps', 'common', fixSlashes(m.installdir)) : null
    if (!installDir || !isDir(installDir)) continue
    // première installation en cours : ajouté quand elle sera finie (ou par la liste possédée) ;
    // un jeu déjà installé qui se met à jour reste installé (« Mise à jour »)
    const installed = steamInstalled(m, installDir)
    if (!installed) continue
    installedIds.add(m.appid)
    const exe = steamExe(installDir, info)
    const o = ownedById.get(m.appid)
    const lp = local.get(m.appid)
    scan.games.push({
      platform: 'steam',
      platformId: String(m.appid),
      name,
      installDir,
      exePath: exe,
      launch: launchFor(m.appid),
      watchDirs: [installDir],
      processNames: steamProcessNames(installDir, info, exe),
      installed: true,
      owned: ownedIds ? ownedIds.has(m.appid) : undefined,
      steamAppId: m.appid,
      coverHint: info?.capsule ? steamCapsuleUrl(m.appid, info.capsule) : null,
      iconHint: info?.icon ? steamIconUrl(m.appid, info.icon) : null,
      playTimeSeconds: o ? o.playtimeMinutes * 60 : lp ? lp.minutes * 60 : null,
      lastPlayedAt: Math.max(m.lastPlayed, lp?.lastPlayed ?? 0, o?.lastPlayed ?? 0) * 1000 || null,
      state: stateOf(m.stateFlags, installed)
    })
  }

  if (owned) {
    scan.ownedKnown = true
    const pending = manifests.filter((m) => !installedIds.has(m.appid) && !(m.stateFlags & 4))
    const unknown = owned.filter((g) => !installedIds.has(g.appid) && !apps.get(g.appid)?.type).map((g) => g.appid)
    let storeTypes = new Map<number, number | null>()
    if (unknown.length && extra.storeTypes) {
      try {
        storeTypes = await extra.storeTypes(unknown)
      } catch {
        // boutique injoignable : repli sur le nom
      }
    }
    for (const g of owned) {
      if (installedIds.has(g.appid) || skippedIds.has(g.appid)) continue
      const info = apps.get(g.appid)
      const storeType = storeTypes.get(g.appid)
      // la boutique classe SteamVR comme un jeu (type 0) : le nom sert aussi de filtre.
      // Inconnu de la boutique (null : outil caché, serveur, app retirée) : gardé seulement s'il a
      // déjà été joué. Boutique injoignable (undefined) : repli sur le nom.
      const isGame = info?.type
        ? isSteamGame(g.appid, g.name, info, false)
        : storeType === 0 || storeType === undefined
          ? isSteamGame(g.appid, g.name, null, false)
          : storeType === null
            ? g.playtimeMinutes > 0 && isSteamGame(g.appid, g.name, null, false)
            : false
      if (!isGame) {
        skip(scan, cleanTitle(g.name || info?.name || `App ${g.appid}`), steamSkipReason(g.appid, g.name, info, storeType))
        continue
      }
      const m = pending.find((p) => p.appid === g.appid)
      const lp = local.get(g.appid)
      const icon = g.iconHash || info?.icon || null
      scan.games.push({
        platform: 'steam',
        platformId: String(g.appid),
        name: cleanTitle(g.name || info?.name || `App ${g.appid}`),
        installDir: null,
        exePath: null,
        launch: launchFor(g.appid),
        watchDirs: [],
        processNames: [],
        installed: false,
        owned: true,
        steamAppId: g.appid,
        coverHint: info?.capsule ? steamCapsuleUrl(g.appid, info.capsule) : null,
        iconHint: icon ? steamIconUrl(g.appid, icon) : null,
        playTimeSeconds: g.playtimeMinutes * 60,
        lastPlayedAt: Math.max(g.lastPlayed ?? 0, lp?.lastPlayed ?? 0) * 1000 || null,
        state: m ? 'downloading' : null
      })
    }
  }
  return scan
}

/** Dossiers steamapps à surveiller (nouveaux manifestes, désinstallations). */
export function steamWatchDirs(): string[] {
  if (!lastClient) return []
  return steamLibraries(lastClient.dir).map((l) => path.join(l, 'steamapps'))
}
