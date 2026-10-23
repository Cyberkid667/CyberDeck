// Téléchargements Steam en cours, suivis en direct comme dans la page « Téléchargements » de Steam.
//
// Steam n'écrit l'appmanifest qu'au début et à la fin d'un téléchargement : il ne sert qu'en
// secours. Les vraies sources :
// - le journal logs\content_log.txt du client Steam, écrit en direct : début de la mise à jour
//   et totaux (« update started : download 0/7814185328, … stage 0/12975519490 »), fichiers
//   réservés d'avance (« preallocated 29 files (12374 MB, 8581 MB as sparse files) »), phase
//   (« App update changed : Running Update,Downloading,Staging, »), pause, file d'attente, fin ;
// - la place réellement occupée sur le disque par steamapps\downloading\<appid> (stat.blocks) :
//   Steam réserve les fichiers d'avance (taille apparente déjà complète), mais la partie
//   « creuse » ne prend de la place qu'au fur et à mesure de l'écriture. Ce qui a été écrit dans
//   cette partie, rapporté à sa taille, donne l'avancement.
// Relevé toutes les 1,5 s pendant un téléchargement ; sinon, le journal est surveillé toutes les
// 3 s (simple taille du fichier) pour voir démarrer un téléchargement lancé depuis Steam.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DownloadProgress, Game, LibraryState } from '../shared/types'
import { cachedSteamClient, steamLibraries } from './platforms/steam'
import { readText } from './platforms/util'
import { parseVdf, vdfObj, vdfStr } from './platforms/vdf'

interface Deps {
  log: (message: string) => void
  /** envoie les téléchargements à l'interface */
  send: (record: Record<string, DownloadProgress>) => void
  /** relecture de Steam (le jeu terminé passe « installé ») */
  resync: () => void
}

const TICK = 1500
const IDLE_TICK = 3000
/** à la première lecture, la fin du journal suffit à connaître l'état des téléchargements */
const FIRST_READ = 512 * 1024
const HISTORY = 60
/** lissage de la vitesse (moyenne glissante exponentielle) */
const ALPHA = 0.35
const MAX_FOLDER_FILES = 20_000
const MB = 1024 * 1024

// StateFlags de l'appmanifest (secours quand le journal ne dit rien) : 4 installé, 512 en pause.
const PAUSED = 512

/** État d'un jeu d'après le journal de Steam. */
interface LogState {
  /** mise à jour lancée (« Update Running »), pas encore finie */
  running: boolean
  paused: boolean
  queued: boolean
  /** mots de la dernière ligne « App update changed » (Downloading, Staging, Committing…) */
  update: Set<string>
  /** totaux de la ligne « update started » (octets) */
  dlDone: number
  dlTotal: number
  stageDone: number
  stageTotal: number
  /** réservation d'avance (Mo) : total et partie « creuse » */
  prealloc: { totalMB: number; sparseMB: number } | null
  /** la fin vient d'être lue (« finished update ») */
  finished: boolean
  /** heure de la fin : la lecture de Steam peut encore dire « mise à jour » un moment */
  doneAt: number
}

interface Track {
  gameId: string
  appid: number
  name: string
  installDir: string | null
  /** dossier steamapps de la bibliothèque du jeu */
  steamapps: string | null
  phase: DownloadProgress['phase']
  downloaded: number
  total: number
  staged: number
  toStage: number
  speed: number
  history: number[]
  lastAt: number
  lastDownloaded: number
  folderBusy: boolean
}

let deps: Deps
/** jeux Steam de la bibliothèque : appid → jeu */
let steamGames = new Map<number, Game>()
/** jeux dont Steam signale une opération (platformState) */
let flagged = new Set<number>()
const logStates = new Map<number, LogState>()
const tracks = new Map<number, Track>()
let logFile: string | null = null
let logOffset = -1
let logRest = ''
let timer: NodeJS.Timeout | null = null
let polling = false
let stopped = false
let lastSent = '{}'

export function initSteamDownloads(d: Deps): void {
  deps = d
}

export function stopSteamDownloads(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}

/** Téléchargements en cours, par id de jeu. */
export function downloadsState(): Record<string, DownloadProgress> {
  const out: Record<string, DownloadProgress> = {}
  for (const tr of tracks.values()) {
    const remaining = Math.max(0, tr.total - tr.downloaded)
    const speed = tr.phase === 'downloading' ? Math.round(tr.speed) : 0
    out[tr.gameId] = {
      gameId: tr.gameId,
      phase: tr.phase,
      downloaded: Math.round(tr.downloaded),
      total: tr.total,
      staged: Math.round(tr.staged),
      toStage: tr.toStage,
      speed,
      eta: speed > 0 && remaining > 0 ? Math.round(remaining / speed) : null,
      history: tr.history.slice()
    }
  }
  return out
}

/** Bibliothèque à jour : liste des jeux Steam et de ceux que Steam signale occupés. */
export function onLibraryChanged(s: LibraryState): void {
  if (stopped || !deps) return
  steamGames = new Map()
  flagged = new Set()
  for (const g of s.games) {
    if (g.platform !== 'steam' || !/^\d+$/.test(g.platformId ?? '')) continue
    const appid = Number(g.platformId)
    steamGames.set(appid, g)
    if (g.platformState) flagged.add(appid)
  }
  if (!timer && !polling) schedule(0)
}

function schedule(delay: number): void {
  if (stopped) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void poll()
  }, delay)
}

// ---------- Journal de Steam ----------

const LINE = /^\[[^\]]+\] AppID (\d+) (.*)$/

function stateFor(appid: number): LogState {
  let st = logStates.get(appid)
  if (!st) {
    st = { running: false, paused: false, queued: false, update: new Set(), dlDone: 0, dlTotal: 0, stageDone: 0, stageTotal: 0, prealloc: null, finished: false, doneAt: 0 }
    logStates.set(appid, st)
  }
  return st
}

function parseLine(line: string): void {
  const m = LINE.exec(line)
  if (!m) return
  const appid = Number(m[1])
  if (!steamGames.has(appid)) return
  const text = m[2]
  const st = stateFor(appid)
  let x: RegExpExecArray | null
  if ((x = /^update started : download (\d+)\/(\d+), .*stage (\d+)\/(\d+)/.exec(text))) {
    st.dlDone = Number(x[1])
    st.dlTotal = Number(x[2])
    st.stageDone = Number(x[3])
    st.stageTotal = Number(x[4])
    st.running = true
    st.paused = false
    st.finished = false
  } else if ((x = /^preallocated \d+ files \((\d+) MB, (\d+) MB as sparse files\)/.exec(text))) {
    st.prealloc = { totalMB: Number(x[1]), sparseMB: Number(x[2]) }
  } else if ((x = /^App update changed : (.*)$/.exec(text))) {
    st.update = new Set(
      x[1]
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean)
    )
  } else if ((x = /^state changed : (.*)$/.exec(text))) {
    const s = x[1]
    st.running = /Update Running/.test(s)
    st.paused = /Update Paused/.test(s)
    st.queued = /Update Queued/.test(s) && !st.running
    // plus aucune opération : l'état « installé » suffit
    if (!/Update/.test(s)) {
      st.running = false
      st.queued = false
    }
  } else if (/^finished update\b/.test(text)) {
    st.running = false
    st.paused = false
    st.queued = false
    st.finished = true
  } else if (/^update canceled\b|^update failed\b/i.test(text)) {
    st.running = false
    st.queued = false
  }
}

/** Lit ce que Steam a ajouté au journal depuis la dernière fois. */
async function readLog(): Promise<boolean> {
  const client = cachedSteamClient()
  const file = client ? path.join(client.dir, 'logs', 'content_log.txt') : null
  if (file !== logFile) {
    logFile = file
    logOffset = -1
    logRest = ''
  }
  if (!logFile) return false
  let size: number
  try {
    size = (await fsp.stat(logFile)).size
  } catch {
    return false
  }
  // journal recommencé (Steam le tourne quand il devient gros)
  if (logOffset > size) {
    logOffset = 0
    logRest = ''
  }
  if (logOffset === size) return false
  const first = logOffset < 0
  const start = first ? Math.max(0, size - FIRST_READ) : logOffset
  const fh = await fsp.open(logFile, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    let text = logRest + buf.toString('utf8')
    // première lecture au milieu du fichier : la ligne coupée est ignorée
    if (first && start > 0) text = text.slice(text.indexOf('\n') + 1)
    const lines = text.split(/\r?\n/)
    logRest = lines.pop() ?? ''
    for (const l of lines) parseLine(l)
  } finally {
    await fh.close()
  }
  logOffset = size
  return true
}

// ---------- Avancement ----------

/** Dossier steamapps de la bibliothèque du jeu (là où sont son appmanifest et downloading\). */
function steamappsFor(appid: number, installDir: string | null): string | null {
  const dirs: string[] = []
  // <bibliothèque>\steamapps\common\<installdir>
  if (installDir) dirs.push(path.dirname(path.dirname(installDir)))
  const client = cachedSteamClient()
  if (client) dirs.push(...steamLibraries(client.dir).map((l) => path.join(l, 'steamapps')))
  for (const d of dirs) if (fs.existsSync(path.join(d, `appmanifest_${appid}.acf`))) return d
  return null
}

function readManifest(file: string): { flags: number; downloaded: number; total: number; staged: number; toStage: number } | null {
  const text = readText(file)
  if (!text || !text.trimEnd().endsWith('}')) return null
  const st = vdfObj(parseVdf(text), 'AppState')
  if (!st) return null
  const num = (k: string): number => Number(vdfStr(st, k) ?? 0) || 0
  return {
    flags: num('StateFlags'),
    downloaded: num('BytesDownloaded'),
    total: num('BytesToDownload'),
    staged: num('BytesStaged'),
    toStage: num('BytesToStage')
  }
}

/** Place réellement occupée sur le disque (octets) par le dossier ; null s'il n'existe pas. */
async function allocatedSize(dir: string): Promise<number | null> {
  let total = 0
  let files = 0
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files > MAX_FOLDER_FILES) return
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        files++
        try {
          // blocks : place allouée (Windows : AllocationSize), pas la taille apparente
          const s = await fsp.stat(p)
          total += Number.isFinite(s.blocks) && s.blocks > 0 ? s.blocks * 512 : 0
        } catch {
          // fichier retiré entre-temps
        }
      }
    }
  }
  try {
    if (!(await fsp.stat(dir)).isDirectory()) return null
  } catch {
    return null
  }
  await walk(dir)
  return total
}

function newTrack(appid: number, g: Game): Track {
  deps.log(`Téléchargement Steam suivi : ${g.name} (${appid})`)
  return {
    gameId: g.id,
    appid,
    name: g.name,
    installDir: g.installDir,
    steamapps: steamappsFor(appid, g.installDir),
    phase: 'queued',
    downloaded: 0,
    total: 0,
    staged: 0,
    toStage: 0,
    speed: 0,
    history: [],
    lastAt: 0,
    lastDownloaded: -1,
    folderBusy: false
  }
}

/** Phase d'après le journal (sinon d'après le manifeste). */
function phaseOf(st: LogState | undefined, manifestFlags: number): DownloadProgress['phase'] {
  if (st && (st.running || st.paused || st.queued)) {
    if (st.paused) return 'paused'
    if (st.update.has('Downloading')) return 'downloading'
    if (st.update.has('Staging') || st.update.has('Committing')) return 'installing'
    return 'queued'
  }
  return manifestFlags & PAUSED ? 'paused' : 'queued'
}

async function measure(tr: Track, now: number): Promise<void> {
  const st = logStates.get(tr.appid)
  if (!tr.steamapps) tr.steamapps = steamappsFor(tr.appid, tr.installDir)
  const man = tr.steamapps ? readManifest(path.join(tr.steamapps, `appmanifest_${tr.appid}.acf`)) : null
  tr.phase = phaseOf(st, man?.flags ?? 0)
  // totaux : journal, sinon manifeste
  tr.total = st?.dlTotal || man?.total || 0
  tr.toStage = st?.stageTotal || man?.toStage || 0
  let fraction: number | null = null
  if (st?.running && tr.steamapps && !tr.folderBusy) {
    tr.folderBusy = true
    try {
      const alloc = await allocatedSize(path.join(tr.steamapps, 'downloading', String(tr.appid)))
      if (alloc !== null) {
        // la partie réservée « pleine » est allouée tout de suite : seule la partie creuse grandit
        const reserved = st.prealloc ? (st.prealloc.totalMB - st.prealloc.sparseMB) * MB : 0
        const sparse = st.prealloc ? st.prealloc.sparseMB * MB : tr.toStage
        if (sparse > 0) fraction = Math.min(1, Math.max(0, (alloc - reserved) / sparse))
      }
    } finally {
      tr.folderBusy = false
    }
  }
  if (fraction !== null) {
    tr.staged = Math.max(tr.staged, fraction * tr.toStage)
    // téléchargement fini quand Steam ne fait plus qu'écrire
    tr.downloaded = tr.phase === 'downloading' ? Math.max(tr.downloaded, fraction * tr.total) : tr.phase === 'installing' ? tr.total : tr.downloaded
  } else if (!st?.running && man) {
    // en pause ou en attente : dernières valeurs connues du manifeste
    tr.downloaded = man.downloaded
    tr.staged = man.staged
  }
  // vitesse : octets téléchargés depuis le relevé précédent, lissée
  if (tr.lastAt && tr.lastDownloaded >= 0 && now > tr.lastAt) {
    const rate = tr.phase === 'downloading' ? Math.max(0, tr.downloaded - tr.lastDownloaded) / ((now - tr.lastAt) / 1000) : 0
    tr.speed = tr.history.length ? tr.speed * (1 - ALPHA) + rate * ALPHA : rate
    if (tr.speed < 1) tr.speed = 0
    tr.history.push(tr.phase === 'downloading' ? Math.round(tr.speed) : 0)
    if (tr.history.length > HISTORY) tr.history.splice(0, tr.history.length - HISTORY)
  }
  tr.lastAt = now
  tr.lastDownloaded = tr.downloaded
}

async function poll(): Promise<void> {
  if (polling || stopped) return
  polling = true
  try {
    await readLog().catch(() => false)
    const now = Date.now()
    // fin lue dans le journal : Steam est relu (le jeu passe « installé »)
    let finished = false
    for (const [appid, st] of logStates) {
      if (!st.finished) continue
      st.finished = false
      st.doneAt = now
      const tr = tracks.get(appid)
      if (tr) {
        tracks.delete(appid)
        deps.log(`Téléchargement Steam terminé : ${tr.name} (${appid})`)
      }
      finished = true
    }
    if (finished) deps.resync()
    // à suivre : opération en cours d'après le journal, ou signalée par la lecture de Steam
    const wanted = new Set<number>()
    for (const [appid, st] of logStates) if (steamGames.has(appid) && (st.running || st.paused || st.queued)) wanted.add(appid)
    for (const appid of flagged) {
      const st = logStates.get(appid)
      // fini il y a moins d'une minute : la relecture de Steam n'est pas encore passée
      if (steamGames.has(appid) && !(st && !st.running && now - st.doneAt < 60_000)) wanted.add(appid)
    }
    for (const appid of [...tracks.keys()]) if (!wanted.has(appid)) tracks.delete(appid)
    for (const appid of wanted) if (!tracks.has(appid)) tracks.set(appid, newTrack(appid, steamGames.get(appid)!))
    await Promise.all([...tracks.values()].map((tr) => measure(tr, now).catch(() => {})))
    broadcast()
  } finally {
    polling = false
  }
  schedule(tracks.size ? TICK : IDLE_TICK)
}

/** Envoie l'état seulement s'il a changé. */
function broadcast(): void {
  const state = downloadsState()
  const json = JSON.stringify(state)
  if (json === lastSent) return
  lastSent = json
  deps.send(state)
}
