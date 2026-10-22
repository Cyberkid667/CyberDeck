// Ubisoft Connect : Launcher\Installs\<id> (InstallDir) et « Uplay Install <id> »
// (nom, icône). Lancement par uplay://launch/<id>/0.
import path from 'node:path'
import { protocolRegistered, regString, regSubkeys } from './registry'
import type { PlatformScan, ScanContext } from './types'
import { cleanDir, cleanTitle, exeFromIcon, isDir, isFile, largestExeSync, normDir } from './util'

export function ubisoftClient(ctx: ScanContext): string | null {
  const dir = regString(ctx.reg, 'ubisoft.launcher', 'InstallDir')
  if (!dir) return null
  for (const name of ['UbisoftConnect.exe', 'upc.exe']) {
    const exe = path.join(cleanDir(dir), name)
    if (isFile(exe)) return exe
  }
  return null
}

export async function scanUbisoft(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'ubisoft', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  scan.clientPath = ubisoftClient(ctx)
  const names = new Map<string, { name: string; icon: string }>()
  for (const e of ctx.reg.uninstall) {
    const m = /^Uplay Install (\d+)$/i.exec(e.key)
    if (m) names.set(m[1], { name: e.name, icon: e.icon })
  }
  const seen = new Set<string>()
  for (const [id, v] of Object.entries(regSubkeys(ctx.reg, 'ubisoft.installs'))) {
    if (!/^\d+$/.test(id)) continue
    const raw = typeof v.InstallDir === 'string' ? v.InstallDir : ''
    if (!raw.trim()) continue
    const installDir = cleanDir(raw)
    if (!isDir(installDir) || seen.has(normDir(installDir))) continue
    seen.add(normDir(installDir))
    const meta = names.get(id)
    const iconExe = exeFromIcon(meta?.icon)
    const exe = isFile(iconExe) && /\.exe$/i.test(iconExe) ? iconExe : largestExeSync(installDir)
    scan.games.push({
      platform: 'ubisoft',
      platformId: id,
      name: cleanTitle(meta?.name || path.basename(installDir)),
      installDir,
      exePath: exe,
      launch: { kind: 'uri', target: `uplay://launch/${id}/0`, args: null, cwd: null },
      watchDirs: [installDir],
      processNames: exe ? [path.basename(exe)] : [],
      installed: true,
      steamAppId: null,
      coverHint: null
    })
  }
  scan.detected = !!scan.clientPath || scan.games.length > 0 || protocolRegistered(ctx.reg, 'uplay')
  return scan
}
