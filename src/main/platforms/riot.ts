// Riot Games : RiotClientInstalls.json (client) et Metadata\<produit>.<branche>\
// *.product_settings.yaml (dossier du jeu). Lancement par
// RiotClientServices.exe --launch-product=<produit> --launch-patchline=<branche>.
import fs from 'node:fs'
import path from 'node:path'
import type { PlatformScan, ScanContext } from './types'
import { cleanDir, cleanTitle, exeFromIcon, isDir, isFile, largestExeSync, programData, readJson, readText } from './util'

const NAMES: Record<string, { name: string; exe: string[] }> = {
  league_of_legends: { name: 'League of Legends', exe: ['LeagueClient.exe'] },
  valorant: { name: 'VALORANT', exe: ['VALORANT.exe'] },
  bacon: { name: 'Legends of Runeterra', exe: ['LoR.exe'] },
  lion: { name: '2XKO', exe: [] }
}

export function riotClient(): string | null {
  const json = readJson<Record<string, unknown>>(path.join(programData(), 'Riot Games', 'RiotClientInstalls.json'))
  for (const k of ['rc_default', 'rc_live', 'rc_beta']) {
    const p = typeof json?.[k] === 'string' ? (json[k] as string).replace(/\//g, '\\') : null
    if (isFile(p)) return p
  }
  return null
}

export async function scanRiot(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'riot', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  const client = riotClient()
  scan.clientPath = client
  const meta = path.join(programData(), 'Riot Games', 'Metadata')
  let folders: string[] = []
  try {
    folders = fs.readdirSync(meta)
  } catch {
    // pas de jeu Riot
  }
  const found: { product: string; patchline: string; dir: string }[] = []
  for (const f of folders) {
    const m = /^([a-z0-9_]+)\.([a-z0-9_]+)$/i.exec(f)
    if (!m || /^riot_client$/i.test(m[1])) continue
    const yaml = readText(path.join(meta, f, `${f}.product_settings.yaml`))
    const line = yaml ? /^product_install_full_path:\s*"?(.+?)"?\s*$/m.exec(yaml) : null
    if (!line) continue
    const dir = cleanDir(line[1])
    if (isDir(dir)) found.push({ product: m[1].toLowerCase(), patchline: m[2].toLowerCase(), dir })
  }
  // une seule branche par produit : « live » si elle est installée
  const byProduct = new Map<string, (typeof found)[number]>()
  for (const f of found) {
    const cur = byProduct.get(f.product)
    if (!cur || (f.patchline === 'live' && cur.patchline !== 'live')) byProduct.set(f.product, f)
  }
  for (const f of byProduct.values()) {
    const entry = ctx.reg.uninstall.find((e) => e.key.toLowerCase() === `riot game ${f.product}.${f.patchline}`)
    const known = NAMES[f.product]
    const iconExe = exeFromIcon(entry?.icon)
    const exe =
      (isFile(iconExe) && /\.exe$/i.test(iconExe) ? iconExe : null) ??
      known?.exe.map((n) => path.join(f.dir, n)).find((p) => isFile(p)) ??
      largestExeSync(f.dir, 1)
    scan.games.push({
      platform: 'riot',
      platformId: `${f.product}.${f.patchline}`,
      name: cleanTitle(entry?.name || known?.name || f.product),
      installDir: f.dir,
      exePath: exe,
      launch: client
        ? { kind: 'exe', target: client, args: `--launch-product=${f.product} --launch-patchline=${f.patchline}`, cwd: path.dirname(client) }
        : { kind: 'exe', target: '', args: null, cwd: null },
      // le Riot Client et Vanguard sont hors du dossier du jeu : jamais comptés
      watchDirs: [f.dir],
      processNames: exe ? [path.basename(exe)] : [],
      installed: true,
      steamAppId: null,
      coverHint: null
    })
  }
  scan.detected = !!client || scan.games.length > 0
  return scan
}
