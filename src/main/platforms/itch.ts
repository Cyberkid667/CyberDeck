// itch.io : jeux installés par l'application itch, lus dans sa base butler.db
// (copie temporaire, node:sqlite intégré). La table profiles (jeton du compte)
// n'est jamais lue. Pas d'adresse publique pour lancer un jeu : le programme du
// jeu est lancé directement (comme le fait l'application itch).
import fs from 'node:fs'
import path from 'node:path'
import type { PlatformScan, ScanContext } from './types'
import { withSqliteCopy, tableColumns } from './sqlite'
import { t } from '../../shared/i18n'
import { cleanDir, cleanTitle, isDir, isFile, largestExeSync, localAppData, normDir, roamingAppData, skip } from './util'

/**
 * Programme d'itch dans son dossier d'installation. Ancienne version : itch.exe à la racine ;
 * version actuelle (programme d'installation « itch-setup ») : app-<version>\itch.exe, la version
 * en cours étant notée dans state.json, et itch-setup.exe à la racine.
 */
function itchExeIn(dir: string): string | null {
  const root = path.join(dir, 'itch.exe')
  if (isFile(root)) return root
  let current: string | null = null
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { current?: unknown }
    current = typeof st.current === 'string' && st.current ? st.current : null
  } catch {
    // pas de state.json : on cherche le dossier app-* le plus récent
  }
  const versions: string[] = []
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && /^app-\d/i.test(e.name)) versions.push(e.name)
  } catch {
    return null
  }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const v of current ? [`app-${current}`, ...versions] : versions) {
    const exe = path.join(dir, v, 'itch.exe')
    if (isFile(exe)) return exe
  }
  const setup = path.join(dir, 'itch-setup.exe')
  return isFile(setup) ? setup : null
}

export function itchClient(ctx: ScanContext): string | null {
  const entry = ctx.reg.uninstall.find((e) => e.view === 'HKCU' && /^itch$/i.test(e.name.trim()))
  const dirs = [entry?.location ? cleanDir(entry.location) : null, path.join(localAppData(), 'itch')]
  for (const d of dirs) {
    if (!d || !isDir(d)) continue
    const exe = itchExeIn(d)
    if (exe) return exe
  }
  return null
}

interface Candidate {
  path?: string
  flavor?: string
  arch?: string
  depth?: number
}

function exeFromVerdict(installDir: string, verdict: unknown): string | null {
  let v: { basePath?: string; candidates?: Candidate[] } | null = null
  try {
    v = typeof verdict === 'string' && verdict ? JSON.parse(verdict) : null
  } catch {
    v = null
  }
  const list = (v?.candidates ?? []).filter((c) => c.path && /^windows/i.test(c.flavor ?? ''))
  list.sort((a, b) => (a.arch === 'amd64' ? 0 : 1) - (b.arch === 'amd64' ? 0 : 1) || (a.depth ?? 9) - (b.depth ?? 9))
  for (const c of list) {
    const p = path.join(installDir, c.path!.replace(/\//g, '\\'))
    if (isFile(p)) return p
  }
  return null
}

export async function scanItch(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'itch', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  scan.clientPath = itchClient(ctx)
  const db = path.join(roamingAppData(), 'itch', 'db', 'butler.db')
  if (!isFile(db)) {
    scan.detected = !!scan.clientPath
    return scan
  }
  scan.detected = true
  let rows: Record<string, unknown>[] | null
  try {
    rows = withSqliteCopy(db, ctx.tempDir, (query) => {
      const caves = tableColumns(query, 'caves')
      const games = tableColumns(query, 'games')
      if (!caves.has('game_id') || !games.has('id')) throw new Error(t('main.scan.unknownSchema'))
      const col = (set: Set<string>, table: string, name: string): string => (set.has(name) ? `${table}.${name}` : 'NULL')
      const locations = tableColumns(query, 'install_locations')
      const join = locations.has('id') && caves.has('install_location_id') ? 'LEFT JOIN install_locations l ON l.id = c.install_location_id' : ''
      return query(
        `SELECT c.id AS cave_id, c.game_id AS game_id, ${col(caves, 'c', 'verdict')} AS verdict,
                ${col(caves, 'c', 'custom_install_folder')} AS custom_folder, ${col(caves, 'c', 'install_folder_name')} AS folder_name,
                ${join ? 'l.path' : 'NULL'} AS location, ${col(games, 'g', 'title')} AS title,
                ${col(games, 'g', 'classification')} AS classification, ${col(games, 'g', 'cover_url')} AS cover_url
           FROM caves c JOIN games g ON g.id = c.game_id ${join}`
      )
    })
  } catch (err: any) {
    return { ...scan, ok: false, error: t('main.scan.itchUnreadable', { error: err.message }) }
  }
  if (rows === null) return { ...scan, ok: false, error: t('main.scan.itchNoSqlite') }

  const seen = new Set<string>()
  for (const r of rows) {
    const classification = String(r.classification ?? 'game')
    if (classification && classification !== 'game') {
      skip(scan, cleanTitle(String(r.title ?? '') || classification), classification === 'tool' ? 'tool' : classification === 'game_mod' ? 'dlc' : 'other')
      continue
    }
    const custom = typeof r.custom_folder === 'string' && r.custom_folder ? r.custom_folder : null
    const base = typeof r.location === 'string' && r.location ? r.location : path.join(roamingAppData(), 'itch', 'apps')
    const installDir = custom ? cleanDir(custom) : typeof r.folder_name === 'string' && r.folder_name ? cleanDir(path.join(base, r.folder_name)) : null
    if (!installDir || !isDir(installDir) || seen.has(normDir(installDir))) continue
    const exe = exeFromVerdict(installDir, r.verdict) ?? largestExeSync(installDir)
    if (!exe) continue // jeu navigateur (HTML) ou sans programme Windows
    seen.add(normDir(installDir))
    scan.games.push({
      platform: 'itch',
      platformId: String(r.cave_id ?? r.game_id),
      name: cleanTitle(String(r.title ?? '') || path.basename(installDir)),
      installDir,
      exePath: exe,
      launch: { kind: 'exe', target: exe, args: null, cwd: path.dirname(exe) },
      watchDirs: [installDir],
      processNames: [path.basename(exe)],
      installed: true,
      steamAppId: null,
      coverHint: typeof r.cover_url === 'string' && /^https:\/\//.test(r.cover_url) ? r.cover_url : null
    })
  }
  return scan
}
