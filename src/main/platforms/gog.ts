// GOG : jeux du registre (GOG.com\Games, écrit par les installateurs GOG avec ou
// sans Galaxy) et clés de désinstallation <id>_is1 ; programme d'après
// goggame-<id>.info. Lancement par GOG Galaxy s'il est installé, sinon le jeu
// directement (les jeux GOG sont sans DRM).
import path from 'node:path'
import { protocolRegistered, regString, regSubkeys } from './registry'
import type { DetectedGame, PlatformScan, ScanContext } from './types'
import { cleanDir, cleanTitle, exeFromIcon, fixSlashes, isDir, isFile, largestExeSync, normDir, readJson, skip } from './util'

interface PlayTask {
  isPrimary?: boolean
  type?: string
  category?: string
  path?: string
  workingDir?: string
  arguments?: string
}

interface GogInfo {
  gameId?: string
  rootGameId?: string
  name?: string
  playTasks?: PlayTask[]
}

export function gogClient(ctx: ScanContext): string | null {
  const dir = regString(ctx.reg, 'gog.paths', 'client')
  const exeName = regString(ctx.reg, 'gog.client', 'clientExecutable') ?? 'GalaxyClient.exe'
  const exe = dir ? path.join(fixSlashes(dir), exeName) : null
  return isFile(exe) ? exe : null
}

/** Tâche « jouer » principale du fichier goggame-<id>.info. */
function primaryTask(installDir: string, gameId: string): { exe: string; args: string; cwd: string } | null {
  const info = readJson<GogInfo>(path.join(installDir, `goggame-${gameId}.info`))
  const tasks = (info?.playTasks ?? []).filter((t) => (t.type ?? 'FileTask') === 'FileTask' && t.path)
  const task = tasks.find((t) => t.isPrimary) ?? tasks.find((t) => (t.category ?? 'game') === 'game') ?? tasks[0]
  if (!task?.path) return null
  const exe = path.join(installDir, fixSlashes(task.path))
  if (!isFile(exe)) return null
  const cwd = task.workingDir ? path.join(installDir, fixSlashes(task.workingDir)) : path.dirname(exe)
  return { exe, args: task.arguments ?? '', cwd }
}

export async function scanGog(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'gog', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  const client = gogClient(ctx)
  scan.clientPath = client
  const galaxyUsable = !!client

  // id → { nom, dossier, exe du registre }
  const found = new Map<string, { name: string; dir: string; exe: string | null; args: string; cwd: string | null }>()
  for (const [key, v] of Object.entries(regSubkeys(ctx.reg, 'gog.games'))) {
    const id = String(v.gameID ?? key).trim()
    if (!/^\d+$/.test(id)) continue
    if (String(v.dependsOn ?? '').trim()) {
      skip(scan, cleanTitle(String(v.gameName ?? '').trim() || id), 'dlc')
      continue
    }
    const dir = typeof v.path === 'string' && v.path.trim() ? cleanDir(v.path) : ''
    if (!isDir(dir)) continue
    const exe = typeof v.exe === 'string' && isFile(fixSlashes(v.exe)) ? fixSlashes(v.exe) : null
    found.set(id, {
      name: String(v.gameName ?? '').trim(),
      dir,
      exe,
      args: typeof v.launchParam === 'string' ? v.launchParam : '',
      cwd: typeof v.workingDir === 'string' && v.workingDir ? fixSlashes(v.workingDir) : null
    })
  }
  for (const e of ctx.reg.uninstall) {
    const m = /^(\d+)_is1$/.exec(e.key)
    if (!m || !/gog/i.test(e.publisher) || /^GOGPACK/i.test(e.name)) continue
    if (found.has(m[1])) continue
    const dir = e.location.trim() ? cleanDir(e.location) : ''
    if (!isDir(dir)) continue
    const iconExe = exeFromIcon(e.icon)
    found.set(m[1], { name: e.name, dir, exe: isFile(iconExe) && /\.exe$/i.test(iconExe) ? iconExe : null, args: '', cwd: null })
  }

  const seenDirs = new Set<string>()
  for (const [id, g] of found) {
    const info = readJson<GogInfo>(path.join(g.dir, `goggame-${id}.info`))
    if (info?.rootGameId && info.gameId && info.rootGameId !== info.gameId) {
      skip(scan, cleanTitle(g.name || info.name || id), 'dlc')
      continue
    }
    if (seenDirs.has(normDir(g.dir))) continue
    seenDirs.add(normDir(g.dir))
    const task = primaryTask(g.dir, id)
    const exe = task?.exe ?? g.exe ?? largestExeSync(g.dir)
    // dossier resté après une désinstallation (sauvegardes, journaux) : aucun programme, pas un jeu installé
    if (!exe) continue
    let launch: DetectedGame['launch'] | null = null
    if (galaxyUsable) launch = { kind: 'exe', target: client!, args: `/command=runGame /gameId=${id} /path="${g.dir}"`, cwd: path.dirname(client!) }
    else if (task) launch = { kind: 'exe', target: task.exe, args: task.args || null, cwd: task.cwd }
    else if (exe) launch = { kind: 'exe', target: exe, args: g.args || null, cwd: g.cwd ?? path.dirname(exe) }
    if (!launch) continue
    scan.games.push({
      platform: 'gog',
      platformId: id,
      name: cleanTitle(g.name || info?.name || path.basename(g.dir)),
      installDir: g.dir,
      exePath: exe,
      launch,
      watchDirs: [g.dir],
      processNames: exe ? [path.basename(exe)] : [],
      installed: true,
      steamAppId: null,
      coverHint: null
    })
  }
  scan.detected = !!client || scan.games.length > 0 || protocolRegistered(ctx.reg, 'goggalaxy')
  return scan
}
