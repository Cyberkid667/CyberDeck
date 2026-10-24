// Surveillance « En jeu » sous Linux : l'équivalent du script PowerShell PLAY_SCRIPT de games.ts,
// sans aucun programme externe. Toutes les quelques secondes, /proc est lu : un processus du jeu
// tourne si son programme (/proc/<pid>/exe) ou un argument de sa ligne de commande (chemin Linux,
// ou chemin Wine « Z:\… » pour un jeu Proton) est dans un dossier surveillé, ou (jeu Steam) si
// c'est le lanceur de Steam pour cet appid (« SteamLaunch AppId=<id> ») ou un processus qui en a
// hérité l'environnement (SteamAppId=<id>).
// Le surveillant se présente comme le processus du script Windows (lignes « launched »,
// « started:<ms> », « expired:<s> », « ended:<ms> » sur stdout, codes de sortie 0 / 3 / 5) : games.ts
// le suit avec le même code. Aucun appel à Electron : testé par tests/tools/linux-checks.mjs.
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'

const posix = path.posix

export interface ProcInfo {
  pid: number
  /** programme (lien /proc/<pid>/exe) ; null si illisible (processus d'un autre compte) */
  exe: string | null
  cmdline: string[]
  /** nom court du processus (15 caractères au plus) */
  comm: string
  /** heure de démarrage (ms) ; null si inconnue */
  startMs: number | null
  /** variables d'environnement, lues seulement si besoin */
  environ: () => string[]
}

/** Accès aux fichiers : les tests passent un faux /proc (les liens exe y sont de simples fichiers). */
export interface ProcIo {
  readdir(p: string): string[]
  readFile(p: string): string
  readlink(p: string): string
}

export const realProcIo: ProcIo = {
  readdir: (p) => fs.readdirSync(p),
  readFile: (p) => fs.readFileSync(p, 'latin1'),
  readlink: (p) => fs.readlinkSync(p)
}

/** Durée d'un « tick » d'horloge de /proc/<pid>/stat (USER_HZ, 100 sur tous les Linux courants). */
const TICK_MS = 10

function bootTimeMs(procRoot: string, io: ProcIo): number | null {
  try {
    const m = /^btime\s+(\d+)/m.exec(io.readFile(path.join(procRoot, 'stat')))
    return m ? Number(m[1]) * 1000 : null
  } catch {
    return null
  }
}

/** Processus visibles dans /proc (ceux qui disparaissent pendant la lecture sont ignorés). */
export function listProcesses(procRoot = '/proc', io: ProcIo = realProcIo): ProcInfo[] {
  let names: string[]
  try {
    names = io.readdir(procRoot)
  } catch {
    return []
  }
  const boot = bootTimeMs(procRoot, io)
  const out: ProcInfo[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const dir = path.join(procRoot, name)
    let cmdline: string[]
    try {
      cmdline = io.readFile(path.join(dir, 'cmdline')).split('\0').filter(Boolean)
    } catch {
      continue // processus terminé entre-temps
    }
    let exe: string | null = null
    try {
      exe = io.readlink(path.join(dir, 'exe')).replace(/ \(deleted\)$/, '').trim() || null
    } catch {
      exe = null
    }
    let comm = ''
    try {
      comm = io.readFile(path.join(dir, 'comm')).trim()
    } catch {
      // sans nom court
    }
    let startMs: number | null = null
    try {
      // champs après la parenthèse fermante du nom : état (3e champ)… starttime (22e champ)
      const stat = io.readFile(path.join(dir, 'stat'))
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ticks = Number(fields[19])
      if (boot !== null && Number.isFinite(ticks)) startMs = boot + ticks * TICK_MS
    } catch {
      // heure inconnue
    }
    const environ = (): string[] => {
      try {
        return io.readFile(path.join(dir, 'environ')).split('\0')
      } catch {
        return []
      }
    }
    out.push({ pid: Number(name), exe, cmdline, comm, startMs, environ })
  }
  return out
}

/** « Z:\home\moi\Jeu\jeu.exe » (Wine / Proton) → « /home/moi/Jeu/jeu.exe » ; null si ce n'en est pas un. */
export function wineToPosix(arg: string): string | null {
  const m = /^(?:\\\\\?\\)?([a-z]):\\(.*)$/i.exec(arg.trim())
  if (!m || m[1].toLowerCase() !== 'z') return null
  return '/' + m[2].replace(/\\/g, '/')
}

const cleanDir = (d: string): string => {
  let r = posix.normalize(d)
  while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1)
  return r
}

export const insideAny = (p: string, dirs: string[]): boolean => {
  const n = posix.normalize(p)
  return dirs.some((d) => n.startsWith(cleanDir(d) + '/'))
}

// installateurs de prérequis lancés depuis le dossier du jeu : pas le jeu (comme le script Windows)
const SKIP_DIR = /\/(_?CommonRedist|_?Redist|Redistributables?|__Installer|DirectX|Prereq[^/]*|Support)\//i
const SKIP_EXE = /^(dxsetup|vc_?redist.*|vcredist.*|ue\d?prereqsetup.*|dotnetfx.*|ndp\d.*|oalinst|physx.*)\.exe$/i
/** Steam lui-même et ses outils : ne prouvent jamais qu'un jeu tourne. */
const STEAM_INFRA = /^(steam|steam\.sh|steamwebhelper|steamerrorreporter|gameoverlayui|fossilize_replay|wineserver|xdg-open|gio)$/i

export interface MatchSpec {
  dirs: string[]
  /** noms de programmes de repli (en minuscules), quand le chemin d'un processus est illisible */
  names: string[]
  /** programmes jamais comptés (en minuscules) */
  ignore: string[]
  /** jeu de plateforme : le lanceur reste ouvert, seuls le dossier et l'appid comptent */
  platform: boolean
  /** jeu Steam : appid (0 sinon) */
  steamAppId: number
  /** processus de CyberDeck (jamais compté) */
  selfPid: number
}

const baseOf = (p: ProcInfo): string => {
  if (p.exe) return posix.basename(p.exe).toLowerCase()
  const first = p.cmdline[0]
  if (first) return posix.basename(wineToPosix(first) ?? first.replace(/\\/g, '/')).toLowerCase()
  return p.comm.toLowerCase()
}

/** Ce processus appartient-il au jeu ? */
export function matchProcess(p: ProcInfo, spec: MatchSpec): boolean {
  if (p.pid === spec.selfPid) return false
  const base = baseOf(p)
  if (spec.ignore.includes(base)) return false
  if (spec.platform && (SKIP_EXE.test(base) || STEAM_INFRA.test(base))) return false
  const skipped = (file: string): boolean => spec.platform && SKIP_DIR.test(file)
  if (p.exe && !skipped(p.exe) && insideAny(p.exe, spec.dirs)) return true
  // ligne de commande : script (sh jeu.sh), java -jar, programme Windows sous Proton (Z:\…)
  for (const arg of p.cmdline) {
    const a = wineToPosix(arg) ?? arg
    if (a.startsWith('/') && !skipped(a) && insideAny(a, spec.dirs)) return true
  }
  if (spec.steamAppId > 0) {
    const id = String(spec.steamAppId)
    // lanceur de Steam (reaper SteamLaunch AppId=<id> -- …) : vit exactement autant que le jeu
    if (p.cmdline.includes('SteamLaunch') && p.cmdline.includes(`AppId=${id}`)) return true
    const env = p.environ()
    if (env.includes(`SteamAppId=${id}`) || env.includes(`SteamGameId=${id}`)) return true
  }
  // programme illisible (autre compte) : repli sur le nom, comme sous Windows
  if (!p.exe && spec.names.length) {
    const comm = p.comm.toLowerCase()
    if (spec.names.includes(base) || (comm && spec.names.some((n) => n.slice(0, 15) === comm))) return true
  }
  return false
}

/** Premier processus du jeu trouvé (avec son heure de démarrage) ; null si aucun. */
export function findGameProcess(procs: ProcInfo[], spec: MatchSpec): ProcInfo | null {
  return procs.find((p) => matchProcess(p, spec)) ?? null
}

// ---------- Surveillant ----------

export interface WatchOptions {
  mode: 'local' | 'platform'
  dirs: string[]
  names?: string[]
  ignore?: string[]
  steamAppId?: number
  /** jeu local : processus lancé par CyberDeck (suivi jusqu'à sa fin, puis le dossier) */
  child?: ChildProcess
  graceSeconds?: number
  maxWaitSeconds?: number
  intervalMs?: number
  /** Steam prépare ou lance ce jeu (registry.vdf) : prolonge l'attente visible */
  steamBusy?: () => boolean
  procRoot?: string
  io?: ProcIo
}

/**
 * Surveillant au format d'un processus enfant (stdout, stderr, « close », kill) : games.ts le
 * suit comme le script PowerShell. platform : « launched » est écrit par markLaunched() quand
 * l'adresse steam:// a été ouverte ; local : quand le programme du jeu a démarré.
 */
export class ProcWatcher extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private launchedSaid = false
  private readonly spec: MatchSpec
  private readonly opts: WatchOptions

  constructor(opts: WatchOptions) {
    super()
    this.opts = opts
    this.spec = {
      dirs: opts.dirs,
      names: (opts.names ?? []).map((n) => n.toLowerCase()),
      ignore: (opts.ignore ?? []).map((n) => n.toLowerCase()),
      platform: opts.mode === 'platform',
      steamAppId: opts.steamAppId ?? 0,
      selfPid: process.pid
    }
  }

  private say(line: string): void {
    if (!this.closed) this.stdout.write(line + '\n')
  }

  private alive(): ProcInfo | null {
    return findGameProcess(listProcesses(this.opts.procRoot, this.opts.io), this.spec)
  }

  private close(code: number | null): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.stdout.end()
    this.stderr.end()
    // les dernières lignes passent avant « close » (comme pour un vrai processus)
    setTimeout(() => this.emit('close', code), 50)
  }

  /** Le jeu (ou l'adresse steam://) est lancé. */
  markLaunched(): void {
    if (this.launchedSaid) return
    this.launchedSaid = true
    this.say('launched')
  }

  /** Lancement impossible : code 3 avec le message (comme le script Windows). */
  fail(message: string): void {
    if (this.closed) return
    this.stderr.write(message)
    this.close(3)
  }

  kill(): boolean {
    this.close(null)
    return true
  }

  start(): this {
    const { opts } = this
    const interval = opts.intervalMs ?? 3000
    const tick = (fn: () => void): void => {
      if (!this.closed) this.timer = setTimeout(fn, interval)
    }
    if (opts.mode === 'local') {
      let childAlive = !!opts.child
      const child = opts.child
      if (child) {
        child.once('spawn', () => this.markLaunched())
        child.once('error', (err) => {
          childAlive = false
          if (!this.launchedSaid) this.fail(err.message)
        })
        child.once('exit', () => (childAlive = false))
      } else this.markLaunched()
      let empty = 0
      let last = Date.now()
      const loop = (): void => {
        if (this.closed) return
        if (childAlive) {
          empty = 0
          last = Date.now()
        } else if (this.alive()) {
          empty = 0
          last = Date.now()
        } else empty++
        if (empty >= 2) {
          this.say('ended:' + last)
          return this.close(0)
        }
        tick(loop)
      }
      tick(loop)
      return this
    }
    const grace = opts.graceSeconds ?? 120
    const maxWait = Math.max(grace, opts.maxWaitSeconds ?? 900)
    const t0 = Date.now()
    let started = false
    let expired = false
    let empty = 0
    let last = 0
    const loop = (): void => {
      if (this.closed) return
      const hit = this.alive()
      if (hit) {
        empty = 0
        last = Date.now()
        if (!started) {
          started = true
          const from = hit.startMs && hit.startMs > 0 && hit.startMs < last ? hit.startMs : last
          this.say('started:' + Math.round(from))
        }
      } else if (started) {
        empty++
        if (empty >= 3) {
          this.say('ended:' + last)
          return this.close(0)
        }
      } else {
        const waited = (Date.now() - t0) / 1000
        if (waited >= maxWait) return this.close(5)
        if (!expired && waited >= grace && !opts.steamBusy?.()) {
          expired = true
          this.say('expired:' + Math.floor(waited))
        }
      }
      tick(loop)
    }
    loop()
    return this
  }
}

/** Démarre un surveillant (voir ProcWatcher). */
export const startProcWatcher = (opts: WatchOptions): ProcWatcher => new ProcWatcher(opts).start()
