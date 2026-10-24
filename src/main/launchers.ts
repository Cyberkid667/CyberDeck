// Page Lanceurs : installer un lanceur (paquet officiel par winget, avec progression ; sinon
// page du Microsoft Store ou site officiel) et lancer son propre désinstalleur.
// Rien ne s'installe ni ne se désinstalle sans un clic de l'utilisateur (jamais au démarrage).
import { net, shell } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PLATFORM_INFO, PLATFORM_ORDER, platformsFor } from '../shared/platforms'
import { t } from '../shared/i18n'
import type { ActionResult, LauncherInfo, LauncherOp, LauncherPlatform, LaunchersState, PlatformStatus } from '../shared/types'
import { splitCommand, startUninstaller } from './games'
import { withSqliteCopy, tableColumns } from './platforms/sqlite'
import { localAppData, roamingAppData } from './platforms/util'
import { lastRegistry, platformsState, protocolAvailable, syncPlatforms } from './platformSync'
import { takeSnapshot, type RegistrySnapshot, type UninstallEntry } from './platforms/registry'

interface Deps {
  log: (message: string) => void
  broadcast: (s: LaunchersState) => void
}

interface CatalogEntry {
  /** paquet winget (source « winget ») ; null : pas de paquet */
  winget: string | null
  /** page de téléchargement officielle */
  website: string
  /** nom affiché (DisplayName) ou nom de clé de l'entrée « Programmes installés » du lanceur */
  uninstall: RegExp | null
}

// Identifiants winget vérifiés avec « winget show --id <id> -e --source winget ».
// Riot : pas de lanceur seul (le Riot Client vient avec chaque jeu) ; Xbox : Microsoft Store.
const CATALOG: Record<LauncherPlatform, CatalogEntry> = {
  steam: { winget: 'Valve.Steam', website: 'https://store.steampowered.com/about/', uninstall: /^steam$/i },
  epic: { winget: 'EpicGames.EpicGamesLauncher', website: 'https://store.epicgames.com/download', uninstall: /^epic games launcher$/i },
  gog: { winget: 'GOG.Galaxy', website: 'https://www.gog.com/galaxy', uninstall: /^gog galaxy$/i },
  ea: { winget: 'ElectronicArts.EADesktop', website: 'https://www.ea.com/ea-app', uninstall: /^ea app$/i },
  ubisoft: { winget: 'Ubisoft.Connect', website: 'https://www.ubisoft.com/en-us/ubisoft-connect/download', uninstall: /^(ubisoft connect|uplay)$/i },
  battlenet: { winget: 'Blizzard.BattleNet', website: 'https://download.battle.net/', uninstall: /^battle\.net$/i },
  rockstar: { winget: 'RockstarGames.Launcher', website: 'https://www.rockstargames.com/downloads', uninstall: /^rockstar games launcher$/i },
  xbox: { winget: null, website: 'https://www.xbox.com/apps/xbox-app-on-pc', uninstall: null },
  itch: { winget: 'ItchIo.Itch', website: 'https://itch.io/app', uninstall: /^itch$/i },
  amazon: { winget: 'Amazon.Games', website: 'https://gaming.amazon.com/amazon-games-app', uninstall: /^amazon games$/i },
  riot: { winget: null, website: 'https://www.riotgames.com/en', uninstall: /^riot client$/i }
}

/** Page de l'application Xbox dans le Microsoft Store. */
const XBOX_STORE = 'ms-windows-store://pdp/?ProductId=9MV0B5HZVK9Z'

const KEEP_FINISHED = 60_000
const UNINSTALL_POLL = 5000
const UNINSTALL_MAX_WAIT = 15 * 60_000
/** temps laissé pour répondre à la fenêtre UAC du désinstalleur */
const UAC_WAIT = 120_000

/** Opération en cours (processus winget, surveillance d'une désinstallation). */
interface Job {
  op: LauncherOp
  child: ChildProcess | null
  timers: NodeJS.Timeout[]
  cancelled: boolean
  // ---- installation winget ----
  wingetId: string
  /** texte pas encore terminé par un retour à la ligne (barre de progression redessinée) */
  buf: string
  /** adresse du programme d'installation (ligne « Téléchargement en cours https://… ») */
  url: string | null
  textReceived: number | null
  textTotal: number | null
  textPercent: number | null
  /** taille du fichier en cours de téléchargement dans %TEMP%\WinGet */
  fileBytes: number
  /** taille annoncée par le serveur (requête HEAD sur l'adresse) */
  headTotal: number | null
  lastLines: string[]
}

let deps: Deps | null = null
let wingetOk: boolean | null = null
let wingetCheck: Promise<boolean> | null = null
const ops: Partial<Record<LauncherPlatform, LauncherOp>> = {}
const jobs = new Map<LauncherPlatform, Job>()
let broadcastTimer: NodeJS.Timeout | null = null

export function initLaunchers(d: Deps): void {
  deps = d
}

const log = (message: string): void => deps?.log(message)
const nameOf = (id: LauncherPlatform): string => PLATFORM_INFO[id].name
/** Linux : pas de winget, de registre ni de désinstalleur ; Steam s'installe depuis son site. */
const IS_WIN = process.platform === 'win32'
const isLauncher = (v: unknown): v is LauncherPlatform => typeof v === 'string' && (PLATFORM_ORDER as string[]).includes(v)

// ---------- Compte connecté (lu sur le PC, sans mot de passe) ----------

/** Base locale où le lanceur garde le compte connecté. */
const ACCOUNT_DB: Partial<Record<LauncherPlatform, () => string>> = {
  // table login_cache : BattleTag en clair (l'adresse e-mail n'est jamais lue)
  battlenet: () => path.join(localAppData(), 'Battle.net', 'CachedData.db'),
  // table profiles : seule la colonne user (nom, avatar) est lue, jamais api_key
  itch: () => path.join(roamingAppData(), 'itch', 'db', 'butler.db')
}

/** Résultat gardé tant que la base (et son -wal) ne change pas. */
const accountCache = new Map<LauncherPlatform, { stamp: string; value: LauncherInfo['account'] }>()

const stampOf = (file: string): string | null => {
  try {
    const wal = fs.existsSync(file + '-wal') ? fs.statSync(file + '-wal').mtimeMs : 0
    return `${fs.statSync(file).mtimeMs}:${wal}`
  } catch {
    return null
  }
}

function readAccount(id: LauncherPlatform, file: string): LauncherInfo['account'] {
  return withSqliteCopy(file, os.tmpdir(), (query) => {
    if (id === 'battlenet') {
      if (!tableColumns(query, 'login_cache').has('battle_tag')) return null
      const tag = query('SELECT battle_tag FROM login_cache')
        .map((r) => (typeof r.battle_tag === 'string' ? r.battle_tag.trim() : ''))
        .find(Boolean)
      return tag ? { name: tag, avatar: null } : null
    }
    const cols = tableColumns(query, 'profiles')
    if (!cols.has('user')) return null
    const order = cols.has('last_connected') ? ' ORDER BY last_connected DESC' : ''
    const row = query(`SELECT user FROM profiles${order} LIMIT 1`)[0]
    let user: { username?: unknown; displayName?: unknown; coverUrl?: unknown } | null = null
    try {
      user = typeof row?.user === 'string' ? JSON.parse(row.user) : null
    } catch {
      user = null
    }
    const name = typeof user?.displayName === 'string' && user.displayName.trim() ? user.displayName.trim() : typeof user?.username === 'string' ? user.username : ''
    if (!name) return null
    const cover = typeof user?.coverUrl === 'string' && user.coverUrl.startsWith('https://img.itch.zone/') ? user.coverUrl : null
    return { name, avatar: cover }
  })
}

/** Compte connecté du lanceur, s'il est lisible sur le PC (null sinon, jamais d'erreur). */
function launcherAccount(id: LauncherPlatform, detected: boolean): LauncherInfo['account'] {
  const file = ACCOUNT_DB[id]?.()
  if (!detected || !file) return null
  const stamp = stampOf(file)
  if (!stamp) return null
  const cached = accountCache.get(id)
  if (cached?.stamp === stamp) return cached.value
  let value: LauncherInfo['account'] = null
  try {
    value = readAccount(id, file)
  } catch (err) {
    log(`Compte ${nameOf(id)} illisible : ${(err as Error).message}`)
  }
  accountCache.set(id, { stamp, value })
  return value
}

// ---------- État ----------

function launcherInfo(id: LauncherPlatform, platforms: PlatformStatus[], reg: RegistrySnapshot | null): LauncherInfo {
  const c = CATALOG[id]
  const detected = platforms.find((p) => p.id === id)?.state === 'detected'
  // Linux : site officiel pour installer, gestionnaire de paquets pour désinstaller (expliqué par la page)
  if (!IS_WIN) return { id, installKind: 'website', wingetId: null, website: c.website, uninstallKind: null, account: null }
  // dernière photo du registre gardée par platformSync : pas de PowerShell à chaque appel
  const uninstallKind = id === 'xbox' ? (detected ? 'windows' : null) : detected && findUninstaller(reg, id) ? 'uninstaller' : null
  return {
    id,
    installKind: c.winget && wingetOk !== false ? 'winget' : id === 'xbox' ? 'store' : 'website',
    wingetId: c.winget,
    website: c.website,
    uninstallKind,
    account: launcherAccount(id, detected)
  }
}

function launchersState(): LaunchersState {
  let platforms: PlatformStatus[] = []
  try {
    platforms = platformsState().platforms
  } catch {
    // plateformes indisponibles : rien à désinstaller
  }
  const reg = lastRegistry()
  return { winget: wingetOk, launchers: platformsFor(process.platform).map((id) => launcherInfo(id, platforms, reg)), ops: { ...ops } }
}

function broadcastNow(): void {
  if (broadcastTimer) clearTimeout(broadcastTimer)
  broadcastTimer = null
  deps?.broadcast(launchersState())
}

/** Progression : 4 envois par seconde au plus. */
function broadcastSoon(): void {
  if (!broadcastTimer) broadcastTimer = setTimeout(broadcastNow, 250)
}

/** Les plateformes ont été relues (lanceur apparu ou disparu) : la page se met à jour. */
export function notifyLaunchers(): void {
  if (deps) broadcastSoon()
}

export function getLaunchers(): LaunchersState {
  if (IS_WIN) void checkWinget()
  return launchersState()
}

// ---------- winget ----------

/** winget.exe est un alias d'application (WindowsApps) : fs.existsSync le voit absent, lstat le trouve. */
function wingetPath(): string {
  const p = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'winget.exe')
  try {
    fs.lstatSync(p)
    return p
  } catch {
    return 'winget'
  }
}

/** Vérifié une seule fois (5 s au plus) ; sans winget, les lanceurs s'installent depuis leur site. */
function checkWinget(): Promise<boolean> {
  if (!wingetCheck)
    wingetCheck = new Promise<boolean>((resolve) => {
      const done = (ok: boolean, detail: string): void => {
        wingetOk = ok
        log(ok ? `winget disponible (${detail})` : `winget indisponible : ${detail}`)
        broadcastNow()
        resolve(ok)
      }
      try {
        execFile(wingetPath(), ['--version'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
          const version = String(stdout ?? '').trim()
          if (!err && /^v?\d+\.\d+/.test(version)) done(true, version)
          else done(false, err?.message ?? (version || 'réponse inattendue'))
        })
      } catch (err) {
        done(false, (err as Error).message)
      }
    })
  return wingetCheck
}

// ---------- Opérations ----------

function newOp(id: LauncherPlatform, kind: LauncherOp['kind']): LauncherOp {
  return { id, kind, phase: 'starting', progress: null, received: null, total: null, message: null, startedAt: Date.now() }
}

function newJob(op: LauncherOp, wingetId = ''): Job {
  return {
    op,
    child: null,
    timers: [],
    cancelled: false,
    wingetId,
    buf: '',
    url: null,
    textReceived: null,
    textTotal: null,
    textPercent: null,
    fileBytes: 0,
    headTotal: null,
    lastLines: []
  }
}

function stopJob(job: Job): void {
  for (const tm of job.timers) {
    clearTimeout(tm)
    clearInterval(tm)
  }
  job.timers = []
  if (jobs.get(job.op.id) === job) jobs.delete(job.op.id)
}

/** Opération retirée sans trace (annulée, ou refusée avant de commencer : l'erreur part dans ActionResult). */
function dropJob(job: Job): void {
  stopJob(job)
  if (ops[job.op.id] === job.op) delete ops[job.op.id]
  broadcastNow()
}

/** Fin d'une opération : gardée une minute dans `ops` pour que la page affiche le résultat. */
function finish(job: Job, phase: 'done' | 'error', message: string | null): void {
  const { op } = job
  if (ops[op.id] !== op || op.phase === 'done' || op.phase === 'error') return
  stopJob(job)
  op.phase = phase
  op.message = message
  if (phase === 'done') op.progress = 1
  broadcastNow()
  setTimeout(() => {
    if (ops[op.id] === op) {
      delete ops[op.id]
      broadcastNow()
    }
  }, KEEP_FINISHED).unref?.()
}

export async function installLauncher(raw: unknown): Promise<ActionResult> {
  if (!isLauncher(raw)) return { ok: false, error: t('main.launchers.unknown') }
  const id = raw
  if (jobs.has(id)) return { ok: false, error: t('main.launchers.busy', { name: nameOf(id) }) }
  const c = CATALOG[id]
  if (!IS_WIN && !platformsFor(process.platform).includes(id)) return { ok: false, error: t('main.linux.windowsOnly') }
  if (IS_WIN && c.winget && (await checkWinget())) {
    // vérification de winget pendant laquelle un autre clic a pu partir
    if (jobs.has(id)) return { ok: false, error: t('main.launchers.busy', { name: nameOf(id) }) }
    return installWithWinget(id, c.winget)
  }
  const target = id === 'xbox' && protocolAvailable('ms-windows-store') ? XBOX_STORE : c.website
  try {
    await shell.openExternal(target)
    log(`Lanceur ${id} : page d'installation ouverte (${target})`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: t('main.launchers.cantOpen', { error: (err as Error).message }) }
  }
}

function installWithWinget(id: LauncherPlatform, wingetId: string): ActionResult {
  const op = newOp(id, 'install')
  const job = newJob(op, wingetId)
  ops[id] = op
  jobs.set(id, job)
  const args = [
    'install',
    '--id',
    wingetId,
    '-e',
    '--source',
    'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity'
  ]
  let child: ChildProcess
  try {
    child = spawn(wingetPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    dropJob(job)
    return { ok: false, error: t('main.launchers.cantStart', { error: (err as Error).message }) }
  }
  job.child = child
  log(`Installation de ${id} par winget (${wingetId})`)
  broadcastNow()
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => onOutput(job, d))
  child.stderr?.on('data', (d: string) => onOutput(job, d))
  child.on('error', (err) => {
    log(`winget (${id}) : ${err.message}`)
    if (job.cancelled) dropJob(job)
    else finish(job, 'error', t('main.launchers.cantStart', { error: err.message }))
  })
  child.on('close', (code) => onWingetExit(job, code))
  // winget n'affiche pas sa barre de progression quand sa sortie est lue par un programme :
  // on suit la taille du fichier qu'il télécharge dans %TEMP%\WinGet.
  job.timers.push(setInterval(() => pollDownload(job), 500))
  return { ok: true }
}

// ---------- Lecture de la sortie de winget ----------

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
/** « 12.3 MB / 45.6 MB », « 1,5 Go / 2 Go », « 512 KB / 6.40 MB » (unités anglaises ou françaises). */
const BYTES = /(\d+(?:[.,]\d+)?)\s*([KMGT]?i?B|[kKMGT]?o)\s*\/\s*(\d+(?:[.,]\d+)?)\s*([KMGT]?i?B|[kKMGT]?o)\b/
const PERCENT = /(\d{1,3}(?:[.,]\d+)?)\s*%/
/** adresse en fin de ligne, sans deux-points dans le texte qui la précède */
const DOWNLOAD_RE = /^[^:]*?\s(https?:\/\/\S+)$/i

function toBytes(n: string, unit: string): number {
  const v = Number(n.replace(',', '.'))
  const pow = { '': 0, K: 1, M: 2, G: 3, T: 4 }[unit.charAt(0).toUpperCase().replace(/[BO]/, '') as '' | 'K' | 'M' | 'G' | 'T'] ?? 0
  return Math.round(v * 1024 ** pow)
}

function onOutput(job: Job, chunk: string): void {
  job.buf += chunk
  // \r seul : barre de progression redessinée sur la même ligne
  const parts = job.buf.split(/\r\n|\r|\n/)
  job.buf = parts.pop() ?? ''
  for (const p of parts) onLine(job, p, true)
  if (job.buf) onLine(job, job.buf, false)
}

function onLine(job: Job, raw: string, complete: boolean): void {
  const line = raw.replace(ANSI, '').trim()
  if (!line) return
  const { op } = job
  if (complete && /[a-z]{3}/i.test(line)) {
    job.lastLines.push(line)
    if (job.lastLines.length > 6) job.lastLines.shift()
  }
  if (op.phase === 'done' || op.phase === 'error') return
  const url = DOWNLOAD_RE.exec(line)
  if (url) {
    // « Téléchargement en cours https://… » / « Downloading https://… » (les adresses des
    // contrats, « Licence : https://… », ont un deux-points avant : pas un téléchargement)
    if (!job.url) {
      job.url = url[1]
      void fetchTotal(job)
    }
    if (op.phase === 'starting') setPhase(job, 'downloading')
    return
  }
  // Seuls les nombres comptent : le texte de winget suit la langue de Windows.
  const bytes = BYTES.exec(line)
  if (bytes) {
    job.textReceived = toBytes(bytes[1], bytes[2])
    job.textTotal = toBytes(bytes[3], bytes[4]) || null
    if (op.phase === 'starting') setPhase(job, 'downloading')
    updateProgress(job)
    return
  }
  const pct = PERCENT.exec(line)
  if (pct && op.phase !== 'installing') {
    const v = Number(pct[1].replace(',', '.'))
    if (v >= 0 && v <= 100) {
      job.textPercent = v / 100
      if (op.phase === 'starting') setPhase(job, 'downloading')
      updateProgress(job)
    }
    return
  }
  // Après le téléchargement : « Le code de hachage … vérifié », « Démarrage de l'installation du package… »
  if (complete && job.url && op.phase !== 'installing' && /install|hach|hash/i.test(line)) setPhase(job, 'installing')
}

function setPhase(job: Job, phase: 'downloading' | 'installing'): void {
  const { op } = job
  if (op.phase === phase) return
  op.phase = phase
  if (phase === 'installing') {
    op.progress = null
    // l'installateur du lanceur peut demander les droits administrateur
    op.message = t('main.launchers.uacHint')
  }
  broadcastNow()
}

function updateProgress(job: Job): void {
  const { op } = job
  if (op.phase !== 'downloading') return
  const received = Math.max(job.textReceived ?? 0, job.fileBytes)
  const total = job.textTotal ?? job.headTotal
  op.received = received || null
  op.total = total || null
  op.progress = total ? Math.min(1, received / total) : job.textPercent
  if (total && received >= total) setPhase(job, 'installing')
  else broadcastSoon()
}

/** Taille du programme d'installation en cours de téléchargement (%TEMP%\WinGet\<id>.<version>\<empreinte>). */
function pollDownload(job: Job): void {
  const { op } = job
  if (op.phase !== 'downloading' && op.phase !== 'starting') return
  const root = path.join(os.tmpdir(), 'WinGet')
  const prefix = `${job.wingetId}.`.toLowerCase()
  let best = 0
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.toLowerCase().startsWith(prefix)) continue
      const dir = path.join(root, d.name)
      // dossier laissé par une installation précédente : ignoré s'il n'a pas bougé depuis le clic
      if (fs.statSync(dir).mtimeMs < op.startedAt - 2000) continue
      let size = 0
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isFile()) size += fs.statSync(path.join(dir, f.name)).size
      best = Math.max(best, size)
    }
  } catch {
    // dossier absent (pas encore créé) ou fichier en cours de renommage
  }
  if (best > job.fileBytes) {
    job.fileBytes = best
    if (op.phase === 'starting') setPhase(job, 'downloading')
    updateProgress(job)
  }
}

/** Taille annoncée par le serveur (winget ne l'écrit pas quand sa sortie est lue par un programme). */
async function fetchTotal(job: Job): Promise<void> {
  const url = job.url
  if (!url) return
  try {
    const head = await net.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    let n = Number(head.headers.get('content-length'))
    if (!(n > 0)) {
      // serveur qui ne répond pas à HEAD : un seul octet demandé, taille lue dans Content-Range
      const res = await net.fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(10_000) })
      const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')
      n = m ? Number(m[1]) : 0
      await res.body?.cancel().catch(() => undefined)
    }
    if (n > 0) {
      job.headTotal = n
      updateProgress(job)
    }
  } catch {
    // taille inconnue : la page affiche les octets reçus sans pourcentage
  }
}

// ---------- Fin de winget ----------

/** Codes de sortie de winget (« winget error <code> ») → message traduit. */
const WINGET_ERRORS: Record<number, string> = {
  0x8a15002b: 'main.launchers.err.alreadyInstalled', // aucune mise à jour applicable (déjà installé et à jour)
  0x8a150061: 'main.launchers.err.alreadyInstalled', // une version du paquet est déjà installée
  0x8a15010d: 'main.launchers.err.alreadyInstalled', // une autre version est déjà installée
  0x8a150014: 'main.launchers.err.notFound', // aucun paquet trouvé
  0x8a150010: 'main.launchers.err.notForThisPc', // aucun installateur applicable
  0x8a150008: 'main.launchers.err.download', // échec du téléchargement
  0x8a150011: 'main.launchers.err.hash', // empreinte différente du manifeste
  0x8a150107: 'main.launchers.err.noNetwork',
  0x8a150105: 'main.launchers.err.diskFull',
  0x8a150101: 'main.launchers.err.inUse', // application en cours d'exécution
  0x8a150103: 'main.launchers.err.inUse', // fichiers utilisés
  0x8a150102: 'main.launchers.err.busy', // autre installation en cours
  0x8a15010a: 'main.launchers.err.rebootFirst',
  0x8a15010c: 'main.launchers.err.cancelled', // annulée par l'utilisateur
  0x800704c7: 'main.launchers.err.cancelled', // ERROR_CANCELLED : fenêtre UAC refusée
  0x8a15010f: 'main.launchers.err.policy',
  0x8a150006: 'main.launchers.err.installer', // l'installateur a renvoyé une erreur
  0x8a150005: 'main.launchers.err.interrupted' // signal d'annulation reçu
}
const REBOOT_TO_FINISH = 0x8a150109

function onWingetExit(job: Job, rawCode: number | null): void {
  const { op } = job
  const id = op.id
  if (job.cancelled) {
    log(`Installation de ${id} annulée`)
    dropJob(job)
    return
  }
  if (ops[id] !== op || op.phase === 'done' || op.phase === 'error') return
  const code = rawCode === null ? null : rawCode >>> 0
  const hex = code === null ? 'null' : `0x${code.toString(16).toUpperCase()}`
  if (code === 0 || code === REBOOT_TO_FINISH) {
    log(`Lanceur ${id} installé par winget${code ? ' (redémarrage nécessaire)' : ''}`)
    finish(job, 'done', code ? t('main.launchers.rebootToFinish') : null)
  } else {
    const key = code !== null ? WINGET_ERRORS[code] : undefined
    log(`Installation de ${id} par winget échouée (${hex}) : ${job.lastLines.join(' | ')}`)
    finish(job, 'error', key ? t(key, { name: nameOf(id) }) : t('main.launchers.err.code', { code: hex }))
  }
  // lanceur installé (ou déjà là) : la page et la bibliothèque le montrent
  void syncPlatforms({ full: true }).then(() => broadcastSoon())
}

export function cancelLauncherOp(raw: unknown): void {
  if (!isLauncher(raw)) return
  const job = jobs.get(raw)
  if (!job || job.cancelled) return
  job.cancelled = true
  const pid = job.child?.pid
  if (job.child && pid && job.child.exitCode === null && !IS_WIN) {
    job.child.kill()
    job.timers.push(setTimeout(() => dropJob(job), 5000))
  } else if (job.child && pid && job.child.exitCode === null) {
    // tout l'arbre : winget et l'installateur qu'il a lancé (un installateur élevé par l'UAC peut résister)
    execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, (err) => {
      if (err) log(`Annulation de ${raw} : ${err.message.trim()}`)
    })
    // processus qui ne se termine pas : la page est libérée quand même
    job.timers.push(setTimeout(() => dropJob(job), 5000))
  } else dropJob(job)
}

// ---------- Désinstallation ----------

const isMsi = (cmd: string): boolean => /^\s*"?(?:[^"]*\\)?msiexec(?:\.exe)?"?(?:\s|$)/i.test(cmd)

/** Entrée « Programmes installés » du lanceur : son propre programme d'abord, paquet MSI ensuite (EA app a les deux). */
function findUninstaller(reg: RegistrySnapshot | null, id: LauncherPlatform): UninstallEntry | null {
  const re = CATALOG[id].uninstall
  if (!re || !reg?.ok) return null
  const found = reg.uninstall.filter((e) => e.uninstall.trim() && (re.test(e.name.trim()) || re.test(e.key.trim())))
  return found.find((e) => !isMsi(e.uninstall)) ?? found[0] ?? null
}

// Options silencieuses retirées : le désinstalleur doit montrer sa propre confirmation
// (certains lanceurs proposent d'effacer aussi leurs jeux).
const SILENT = /(^|\s)(?:\/|--?)(?:s|silent|verysilent|quiet|q[nbr]?[+-]?|passive|suppressmsgboxes)(?=\s|$)/gi

function uninstallCommand(e: UninstallEntry): { exe: string; args: string } | null {
  if (isMsi(e.uninstall)) {
    // « MsiExec.exe /I{…} » (modifier) ou « /X{…} » : toujours /X, sans /quiet (fenêtre de Windows Installer)
    const guid = /\{[0-9a-f-]{36}\}/i.exec(e.uninstall)
    const msiexec = path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'msiexec.exe')
    return guid ? { exe: msiexec, args: `/X${guid[0]}` } : null
  }
  const cmd = splitCommand(e.uninstall)
  return cmd ? { exe: cmd.exe, args: cmd.args.replace(SILENT, ' ').replace(/\s+/g, ' ').trim() } : null
}

export async function uninstallLauncher(raw: unknown): Promise<ActionResult> {
  if (!isLauncher(raw)) return { ok: false, error: t('main.launchers.unknown') }
  const id = raw
  const name = nameOf(id)
  if (jobs.has(id)) return { ok: false, error: t('main.launchers.busy', { name }) }
  // Linux : rien à lancer, le paquet se retire avec le gestionnaire de paquets (ou Flatpak / Snap)
  if (!IS_WIN) return { ok: false, error: t('main.linux.launcherUninstall', { name }) }
  if (id === 'xbox') {
    try {
      await shell.openExternal('ms-settings:appsfeatures')
      log('Désinstallation de Xbox : « Applications installées » de Windows ouvert')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: t('main.launchers.cantOpen', { error: (err as Error).message }) }
    }
  }
  const op = newOp(id, 'uninstall')
  const job = newJob(op)
  ops[id] = op
  jobs.set(id, job)
  broadcastNow()
  // photo fraîche (sans les clés des lanceurs ni les applications du Store : rapide)
  const fresh = await takeSnapshot([], false)
  const entry = findUninstaller(fresh.ok ? fresh : lastRegistry(), id)
  const cmd = entry ? uninstallCommand(entry) : null
  if (!entry || !cmd) {
    dropJob(job)
    return { ok: false, error: t('main.launchers.noUninstaller', { name }) }
  }
  if (job.cancelled) return { ok: true }
  let clientPath: string | null = null
  try {
    clientPath = platformsState().platforms.find((p) => p.id === id)?.clientPath ?? null
  } catch {
    clientPath = null
  }
  op.message = t('main.launchers.uacHint')
  broadcastNow()
  const started = await startUninstaller(cmd.exe, cmd.args, UAC_WAIT)
  if (!started.ok) {
    dropJob(job)
    return started
  }
  log(`Désinstalleur du lanceur ${id} lancé : ${cmd.exe}${cmd.args ? ' ' + cmd.args : ''}`)
  if (job.cancelled) return { ok: true }
  op.phase = 'waiting'
  op.message = t('main.launchers.followUninstaller', { name })
  broadcastNow()
  watchUninstall(job, entry, clientPath)
  return { ok: true }
}

/** Toutes les 5 s (15 min au plus) : le lanceur a disparu quand son entrée et son programme ne sont plus là. */
function watchUninstall(job: Job, entry: UninstallEntry, clientPath: string | null): void {
  const { op } = job
  const name = nameOf(op.id)
  const tick = async (): Promise<void> => {
    if (job.cancelled || ops[op.id] !== op) return
    if (Date.now() - op.startedAt > UNINSTALL_MAX_WAIT) {
      log(`Désinstallation du lanceur ${op.id} : toujours présent après 15 min`)
      finish(job, 'error', t('main.launchers.stillInstalled', { name }))
      void syncPlatforms({ full: true }).then(() => broadcastSoon())
      return
    }
    const snap = await takeSnapshot([], false)
    const entryGone = snap.ok && !snap.uninstall.some((e) => e.view === entry.view && e.key === entry.key)
    let clientGone = true
    if (clientPath)
      try {
        fs.lstatSync(clientPath)
        clientGone = false
      } catch {
        clientGone = true
      }
    if (entryGone && clientGone) {
      await syncPlatforms({ full: true })
      if (job.cancelled) return
      log(`Lanceur ${op.id} désinstallé`)
      finish(job, 'done', null)
      return
    }
    if (!job.cancelled) job.timers.push(setTimeout(() => void tick(), UNINSTALL_POLL))
  }
  job.timers.push(setTimeout(() => void tick(), UNINSTALL_POLL))
}
