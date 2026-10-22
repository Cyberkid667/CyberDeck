// Rockstar Games Launcher : jeux d'après les clés de désinstallation
// (uninstall.exe … -uninstall=<titre>) et Rockstar Games\<clé>\InstallFolder.
// Les fichiers du lanceur sont chiffrés : on ne les lit pas. Lancement par
// Launcher.exe -launchTitleInFolder "<dossier>".
import path from 'node:path'
import type { LauncherPlatform } from '../../shared/types'
import { protocolCommand, protocolRegistered, regSubkeys } from './registry'
import type { PlatformScan, ScanContext } from './types'
import { cleanDir, cleanTitle, exeFromCommand, exeFromIcon, isDir, isFile, largestExeSync, normDir, sameDir, skip } from './util'

export function rockstarClient(ctx: ScanContext): string | null {
  const launcherKey = regSubkeys(ctx.reg, 'rockstar.keys')['Launcher']
  const folder = typeof launcherKey?.InstallFolder === 'string' ? launcherKey.InstallFolder : null
  const candidates = [folder ? path.join(cleanDir(folder), 'Launcher.exe') : null, exeFromCommand(protocolCommand(ctx.reg, 'rockstar'))]
  for (const c of candidates) if (isFile(c)) return c
  return null
}

export async function scanRockstar(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'rockstar', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  const client = rockstarClient(ctx)
  scan.clientPath = client
  const keys = regSubkeys(ctx.reg, 'rockstar.keys')
  // dossiers de jeux Rockstar achetés sur une autre plateforme (Steam, Epic, Xbox) : pas pour nous
  const OTHER: [string, LauncherPlatform][] = [
    ['InstallFolderSteam', 'steam'],
    ['InstallFolderEpic', 'epic'],
    ['InstallFolderXboxPc', 'xbox']
  ]
  const otherPlatformDirs = Object.values(keys).flatMap((v) =>
    OTHER.map(([k, platform]) => ({ dir: typeof v[k] === 'string' ? String(v[k]) : '', platform })).filter((o) => o.dir)
  )
  const rockstarDirs = Object.entries(keys)
    .filter(([name]) => !/^(launcher|rockstar games social club)$/i.test(name))
    .map(([, v]) => (typeof v.InstallFolder === 'string' ? v.InstallFolder : ''))
    .filter(Boolean)

  const seen = new Set<string>()
  for (const e of ctx.reg.uninstall) {
    // lanceur installé ailleurs que dans « Rockstar Games » : l'éditeur suffit (avec -uninstall=)
    if (!/\\Rockstar Games\\/i.test(e.uninstall) && !/^Rockstar Games/i.test(e.publisher.trim())) continue
    const titleId = /-uninstall=([A-Za-z0-9_]+)/.exec(e.uninstall)?.[1]
    if (!titleId || titleId.toLowerCase() === 'launcher') continue
    const iconExe = exeFromIcon(e.icon)
    const installDir = e.location.trim() ? cleanDir(e.location) : iconExe ? path.dirname(iconExe) : null
    if (!installDir || !isDir(installDir) || seen.has(normDir(installDir))) continue
    const other = otherPlatformDirs.find((d) => sameDir(d.dir, installDir))
    if (other && !rockstarDirs.some((d) => sameDir(d, installDir))) {
      // jeu Rockstar acheté sur Steam, Epic ou Xbox : il appartient à cette plateforme
      skip(scan, cleanTitle(e.name || path.basename(installDir)), 'platform', other.platform)
      continue
    }
    seen.add(normDir(installDir))
    // le dossier peut contenir des mods : le programme vient de DisplayIcon, pas de la taille des fichiers
    const exe = isFile(iconExe) && /\.exe$/i.test(iconExe) ? iconExe : largestExeSync(installDir, 1)
    scan.games.push({
      platform: 'rockstar',
      platformId: titleId,
      name: cleanTitle(e.name || path.basename(installDir)),
      installDir,
      exePath: exe,
      launch: client
        ? { kind: 'exe', target: client, args: `-launchTitleInFolder "${installDir}"`, cwd: path.dirname(client) }
        : // lanceur absent : le jeu ne démarre pas sans lui (message au lancement)
          { kind: 'exe', target: '', args: null, cwd: null },
      watchDirs: [installDir],
      processNames: exe ? [path.basename(exe), path.basename(exe, '.exe') + '_BE.exe'] : [],
      installed: true,
      steamAppId: null,
      coverHint: null
    })
  }
  scan.detected = !!client || scan.games.length > 0 || protocolRegistered(ctx.reg, 'rockstar')
  return scan
}
