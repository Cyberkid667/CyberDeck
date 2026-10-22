// Battle.net : installations d'après product.db (protobuf de l'agent Blizzard) et
// clés « Blizzard Uninstaller.exe --uid=… » (nom, programme). Lancement par
// Battle.net.exe --exec="launch_uid <uid>".
import fs from 'node:fs'
import path from 'node:path'
import { protocolCommand, protocolRegistered } from './registry'
import type { PlatformScan, ScanContext } from './types'
import { pbAll, pbFields, pbMessage, pbNumber, pbString } from './protobuf'
import { t } from '../../shared/i18n'
import { cleanDir, cleanTitle, exeFromCommand, exeFromIcon, isDir, isFile, largestExeSync, programData, readJson, roamingAppData } from './util'

const SKIP_UIDS = new Set(['agent', 'battle.net', 'bna'])
const FALLBACK: Record<string, { exe: string; name: string }> = {
  wow: { exe: 'Wow.exe', name: 'World of Warcraft' },
  wow_classic: { exe: 'WowClassic.exe', name: 'World of Warcraft Classic' },
  wow_classic_era: { exe: 'WowClassic.exe', name: 'World of Warcraft Classic Era' },
  wow_ptr: { exe: 'WowT.exe', name: 'World of Warcraft PTR' },
  wow_beta: { exe: 'WowB.exe', name: 'World of Warcraft Beta' }
}

export function battlenetClient(ctx: ScanContext): string | null {
  const entry = ctx.reg.uninstall.find((e) => /--uid=battle\.net\b/i.test(e.uninstall) || (e.key === 'Battle.net' && e.location))
  const candidates = [
    entry?.location ? path.join(cleanDir(entry.location), 'Battle.net.exe') : null,
    exeFromCommand(protocolCommand(ctx.reg, 'battlenet')),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Battle.net', 'Battle.net.exe')
  ]
  for (const c of candidates) if (isFile(c)) return c
  return null
}

interface ProductInstall {
  uid: string
  productCode: string
  installPath: string
  subfolder: string
  installed: boolean
  hidden: boolean
}

/** null si le fichier est absent ; lève une erreur s'il est illisible. */
export function readProductDb(file: string): ProductInstall[] | null {
  let buf: Buffer
  try {
    buf = fs.readFileSync(file)
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const out: ProductInstall[] = []
  for (const f of pbAll(pbFields(buf), 1)) {
    if (!f.bytes) continue
    let fields
    try {
      fields = pbFields(f.bytes)
    } catch {
      continue
    }
    const settings = pbMessage(fields, 3)
    const base = pbMessage(pbMessage(fields, 4), 1)
    out.push({
      uid: pbString(fields, 1),
      productCode: pbString(fields, 2),
      installPath: pbString(settings, 1),
      subfolder: pbString(settings, 13),
      installed: pbNumber(base, 1) === 1,
      hidden: pbNumber(fields, 7) === 1
    })
  }
  return out
}

export const productDbFile = (): string => path.join(programData(), 'Battle.net', 'Agent', 'product.db')

export async function scanBattlenet(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'battlenet', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  const client = battlenetClient(ctx)
  scan.clientPath = client
  const byUid = new Map<string, { name: string; exe: string | null }>()
  for (const e of ctx.reg.uninstall) {
    if (!/Blizzard Uninstaller\.exe/i.test(e.uninstall)) continue
    const uid = /--uid=([^\s"]+)/i.exec(e.uninstall)?.[1]
    if (!uid || SKIP_UIDS.has(uid.toLowerCase())) continue
    const exe = exeFromIcon(e.icon)
    byUid.set(uid.toLowerCase(), { name: e.name, exe: isFile(exe) && /\.exe$/i.test(exe) ? exe : null })
  }
  let installs: ProductInstall[] | null
  try {
    installs = readProductDb(productDbFile())
  } catch (err: any) {
    // lecture ratée (fichier en cours d'écriture…) : on ne touche à rien cette fois
    return { ...scan, ok: false, detected: !!client, error: t('main.scan.battlenetUnreadable', { error: err.message }) }
  }
  if (!installs) {
    // Pas de product.db : repli sur les clés de désinstallation (programme = DisplayIcon)
    installs = [...byUid.entries()]
      .filter(([, m]) => m.exe)
      .map(([uid, m]) => ({ uid, productCode: uid, installPath: path.dirname(m.exe!), subfolder: '', installed: true, hidden: false }))
  }
  // Dernière partie (Battle.net.config) : seule la section Games est lue (le fichier contient aussi l'adresse e-mail du compte).
  const config = readJson<{ Games?: Record<string, { LastPlayed?: string }> }>(path.join(roamingAppData(), 'Battle.net', 'Battle.net.config'))
  const lastPlayed = (uid: string): number | null => {
    const v = Number(config?.Games?.[uid]?.LastPlayed ?? 0)
    return v > 0 ? v * 1000 : null
  }

  const seen = new Set<string>()
  for (const p of installs) {
    const uid = p.uid.toLowerCase()
    if (!uid || SKIP_UIDS.has(uid) || SKIP_UIDS.has(p.productCode.toLowerCase())) continue
    if (p.hidden || !p.installed || !p.installPath || seen.has(uid)) continue
    const installDir = cleanDir(p.subfolder ? path.join(p.installPath, p.subfolder) : p.installPath)
    if (!isDir(installDir)) continue
    seen.add(uid)
    const meta = byUid.get(uid)
    const fallback = FALLBACK[uid]
    const exe =
      meta?.exe && meta.exe.toLowerCase().startsWith(installDir.toLowerCase() + '\\')
        ? meta.exe
        : fallback && isFile(path.join(installDir, fallback.exe))
          ? path.join(installDir, fallback.exe)
          : largestExeSync(installDir, 1)
    scan.games.push({
      platform: 'battlenet',
      platformId: p.uid,
      name: cleanTitle(meta?.name || fallback?.name || p.uid),
      installDir,
      exePath: exe,
      launch: client
        ? { kind: 'exe', target: client, args: `--exec="launch_uid ${p.uid}"`, cwd: path.dirname(client) }
        : { kind: 'uri', target: `battlenet://${p.productCode || p.uid}`, args: null, cwd: null },
      watchDirs: [installDir],
      processNames: exe ? [path.basename(exe)] : [],
      // BlizzardError.exe (rapport de plantage) n'est pas le jeu
      ignoreNames: ['BlizzardError.exe'],
      installed: true,
      steamAppId: null,
      coverHint: null,
      lastPlayedAt: lastPlayed(p.uid)
    })
  }
  scan.detected = !!client || scan.games.length > 0 || protocolRegistered(ctx.reg, 'battlenet')
  return scan
}

export const battlenetWatchDirs = (): string[] => {
  const dir = path.dirname(productDbFile())
  return isDir(dir) ? [dir] : []
}
