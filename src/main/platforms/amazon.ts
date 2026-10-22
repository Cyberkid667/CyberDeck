// Amazon Games : base GameInstallInfo.sqlite du client (copie temporaire,
// node:sqlite intégré), programme d'après fuel.json. Lancement par
// amazon-games://play/<Id>.
import path from 'node:path'
import type { PlatformScan, ScanContext } from './types'
import { withSqliteCopy, tableColumns } from './sqlite'
import { t } from '../../shared/i18n'
import { cleanDir, cleanTitle, isDir, isFile, largestExeSync, localAppData, normDir, readJson } from './util'

export function amazonClient(ctx: ScanContext): string | null {
  const entry = ctx.reg.uninstall.find((e) => /^Amazon Games$/i.test(e.name.trim()) && e.uninstall)
  const candidates = [
    entry?.location ? path.join(cleanDir(entry.location), 'App', 'Amazon Games.exe') : null,
    // InstallLocation peut déjà désigner le dossier App
    entry?.location ? path.join(cleanDir(entry.location), 'Amazon Games.exe') : null,
    path.join(localAppData(), 'Amazon Games', 'App', 'Amazon Games.exe')
  ]
  for (const c of candidates) if (isFile(c)) return c
  return null
}

export async function scanAmazon(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'amazon', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  scan.clientPath = amazonClient(ctx)
  const db = path.join(localAppData(), 'Amazon Games', 'Data', 'Games', 'Sql', 'GameInstallInfo.sqlite')
  if (!isFile(db)) {
    scan.detected = !!scan.clientPath
    return scan
  }
  scan.detected = true
  let rows: Record<string, unknown>[] | null
  try {
    rows = withSqliteCopy(db, ctx.tempDir, (query) => {
      const cols = tableColumns(query, 'DbSet')
      if (!cols.has('Id') || !cols.has('InstallDirectory')) throw new Error(t('main.scan.unknownSchema'))
      const title = cols.has('ProductTitle') ? 'ProductTitle' : 'NULL'
      const installed = cols.has('Installed') ? 'Installed' : '1'
      return query(`SELECT Id AS id, InstallDirectory AS dir, ${title} AS title, ${installed} AS installed FROM DbSet`)
    })
  } catch (err: any) {
    return { ...scan, ok: false, error: t('main.scan.amazonUnreadable', { error: err.message }) }
  }
  if (rows === null) return { ...scan, ok: false, error: t('main.scan.amazonNoSqlite') }

  const seen = new Set<string>()
  for (const r of rows) {
    if (Number(r.installed) !== 1) continue
    const id = String(r.id ?? '')
    const installDir = typeof r.dir === 'string' && r.dir ? cleanDir(r.dir) : null
    if (!id || !installDir || !isDir(installDir) || seen.has(normDir(installDir))) continue
    seen.add(normDir(installDir))
    const fuel = readJson<{ Main?: { Command?: string } }>(path.join(installDir, 'fuel.json'))
    const cmd = fuel?.Main?.Command ? path.join(installDir, fuel.Main.Command.replace(/\//g, '\\')) : null
    const exe = isFile(cmd) ? cmd : largestExeSync(installDir)
    scan.games.push({
      platform: 'amazon',
      platformId: id,
      name: cleanTitle(String(r.title ?? '') || path.basename(installDir)),
      installDir,
      exePath: exe,
      launch: { kind: 'uri', target: `amazon-games://play/${id}`, args: null, cwd: null },
      watchDirs: [installDir],
      processNames: exe ? [path.basename(exe)] : [],
      installed: true,
      steamAppId: null,
      coverHint: null
    })
  }
  return scan
}
