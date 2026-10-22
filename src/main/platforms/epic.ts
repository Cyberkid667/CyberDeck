// Epic Games : manifestes JSON des installations (<AppDataPath>\Manifests\*.item),
// lancement par com.epicgames.launcher://, jaquettes du cache du catalogue.
import fs from 'node:fs'
import path from 'node:path'
import { protocolCommand, regString, type RegistrySnapshot } from './registry'
import type { DetectedGame, PlatformScan, ScanContext } from './types'
import { cleanDir, cleanTitle, exeFromCommand, fixSlashes, isDir, isFile, largestExeSync, programData, readJson, readText, skip } from './util'

/** Programmes d'infrastructure jamais pris pour le jeu (noms de repli). */
const NOT_GAME_PROCESS = /(crash|report|unins|setup|redist|prereq|helper|cefprocess|webhelper)/i

/**
 * Noms de processus de repli (chemin illisible : jeu protégé par un anti-triche) : ProcessNames du
 * manifeste, programme de lancement et tous les .exe de son dossier (Fortnite : le bootstrapper lance
 * FortniteClient-Win64-Shipping.exe, absent de ProcessNames), sauf IgnoredProcessNames.
 */
function epicProcessNames(it: EpicItem, exePath: string | null): string[] {
  const ignored = new Set((it.IgnoredProcessNames ?? []).filter((n) => typeof n === 'string').map((n) => n.toLowerCase()))
  const names = new Set<string>()
  const add = (n: unknown): void => {
    if (typeof n !== 'string' || !n.trim()) return
    const base = path.basename(n.trim())
    if (!/\.exe$/i.test(base) || ignored.has(base.toLowerCase()) || NOT_GAME_PROCESS.test(base)) return
    names.add(base)
  }
  for (const n of it.ProcessNames ?? []) add(n)
  if (exePath) {
    add(exePath)
    try {
      for (const f of fs.readdirSync(path.dirname(exePath))) add(f)
    } catch {
      // dossier illisible : le programme de lancement suffit
    }
  }
  return [...names].slice(0, 12)
}

interface EpicItem {
  DisplayName?: string
  AppName?: string
  CatalogNamespace?: string
  CatalogItemId?: string
  InstallLocation?: string
  LaunchExecutable?: string
  AppCategories?: string[]
  bIsIncompleteInstall?: boolean
  bIsExecutable?: boolean
  MainGameAppName?: string
  ProcessNames?: string[]
  IgnoredProcessNames?: string[]
}

let catalogCache: { stamp: string; byId: Map<string, { type: string; url: string }[]> } | null = null

function catalogImages(dataDir: string): Map<string, { type: string; url: string }[]> {
  const file = path.join(dataDir, 'Catalog', 'catcache.bin')
  let stamp = ''
  try {
    const st = fs.statSync(file)
    stamp = `${st.size}:${st.mtimeMs}`
  } catch {
    return new Map()
  }
  if (catalogCache?.stamp === stamp) return catalogCache.byId
  const byId = new Map<string, { type: string; url: string }[]>()
  try {
    const raw = readText(file) ?? ''
    const items = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'))
    if (Array.isArray(items))
      for (const it of items) {
        if (it && typeof it.id === 'string' && Array.isArray(it.keyImages))
          byId.set(
            it.id,
            it.keyImages.filter((k: any) => typeof k?.url === 'string').map((k: any) => ({ type: String(k.type ?? ''), url: String(k.url) }))
          )
      }
  } catch {
    // cache illisible : pas de jaquette Epic, la recherche par nom prendra le relais
  }
  catalogCache = { stamp, byId }
  return byId
}

export function epicDataDir(reg: RegistrySnapshot): string | null {
  const candidates = [
    regString(reg, 'epic.64', 'AppDataPath'),
    regString(reg, 'epic.32', 'AppDataPath'),
    path.join(programData(), 'Epic', 'EpicGamesLauncher', 'Data')
  ]
  for (const c of candidates) if (c && isDir(path.join(c, 'Manifests'))) return path.resolve(c)
  return null
}

const launchUri = (ns: string, itemId: string, appName: string): string =>
  ns && itemId
    ? `com.epicgames.launcher://apps/${encodeURIComponent(ns)}%3A${encodeURIComponent(itemId)}%3A${encodeURIComponent(appName)}?action=launch&silent=true`
    : `com.epicgames.launcher://apps/${encodeURIComponent(appName)}?action=launch&silent=true`

export async function scanEpic(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'epic', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  const clientExe = exeFromCommand(protocolCommand(ctx.reg, 'com.epicgames.launcher'))
  if (isFile(clientExe)) scan.clientPath = clientExe
  const dataDir = epicDataDir(ctx.reg)
  const items: EpicItem[] = []
  if (dataDir) {
    const dir = path.join(dataDir, 'Manifests')
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err: any) {
      // dossier refusé (EACCES / EPERM) ou disparu entre-temps : rien n'est retiré ce passage
      return { ...scan, ok: false, detected: !!scan.clientPath, error: `Manifestes Epic illisibles : ${err.code ?? err.message}` }
    }
    for (const f of entries) {
      // le sous-dossier Pending contient des mises à jour en cours : ignoré
      if (!f.isFile() || !/\.item$/i.test(f.name)) continue
      const file = path.join(dir, f.name)
      const item = readJson<EpicItem>(file)
      if (item) {
        items.push(item)
        continue
      }
      // Manifeste vide ou coupé (le lanceur l'écrit) : ce n'est pas une désinstallation.
      // Son jeu reste installé (AppName lu dans le texte brut) ; sinon, rien n'est retiré ce passage.
      const appName = /"AppName"\s*:\s*"([^"]+)"/.exec(readText(file) ?? '')?.[1]
      if (appName) (scan.keep ??= []).push(appName)
      // Fichier abîmé depuis longtemps (plantage, disque plein) : le lanceur ne l'écrit plus. Il
      // ne doit pas bloquer pour toujours le retrait des jeux désinstallés.
      let recent = true
      try {
        recent = Date.now() - fs.statSync(file).mtimeMs < 10 * 60_000
      } catch {
        // disparu entre-temps : traité comme récent
      }
      if (!recent) {
        ctx.log(`Epic Games : manifeste ${f.name} abîmé, ignoré`)
        continue
      }
      if (!appName) scan.partial = true
      scan.retry = true
      ctx.log(`Epic Games : manifeste ${f.name} illisible pour l’instant, nouvelle lecture bientôt`)
    }
  } else {
    // Repli : liste du lanceur Unreal (peut contenir des entrées périmées)
    const dat = readJson<{ InstallationList?: { InstallLocation?: string; NamespaceId?: string; ItemId?: string; AppName?: string }[] }>(
      path.join(programData(), 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')
    )
    for (const e of dat?.InstallationList ?? [])
      items.push({ AppName: e.AppName, CatalogNamespace: e.NamespaceId, CatalogItemId: e.ItemId, InstallLocation: e.InstallLocation, AppCategories: ['games'] })
  }
  scan.detected = !!scan.clientPath || items.length > 0
  const images = dataDir ? catalogImages(dataDir) : new Map<string, { type: string; url: string }[]>()
  const seen = new Set<string>()
  for (const it of items) {
    const appName = it.AppName ?? ''
    if (!appName || seen.has(appName)) continue
    const isDlc = !!it.MainGameAppName && it.MainGameAppName !== appName
    // manifeste ancien sans catégories : pris pour un jeu (les moteurs UE_ sont écartés plus bas)
    const isGame = !Array.isArray(it.AppCategories) || !it.AppCategories.length || it.AppCategories.some((c) => String(c).toLowerCase() === 'games')
    if (isDlc || !isGame || /^UE_/i.test(appName) || it.bIsExecutable === false) {
      const label = cleanTitle(it.DisplayName || appName)
      skip(scan, label, isDlc ? 'dlc' : /^UE_/i.test(appName) ? 'tool' : !isGame ? 'app' : 'other')
      continue
    }
    if (it.bIsIncompleteInstall) continue
    const installDir = it.InstallLocation?.trim() ? cleanDir(it.InstallLocation) : null
    if (!installDir || !isDir(installDir)) continue
    seen.add(appName)
    const exe = it.LaunchExecutable ? path.join(installDir, fixSlashes(it.LaunchExecutable)) : null
    const exePath = isFile(exe) ? exe : largestExeSync(installDir)
    const keyImages = images.get(it.CatalogItemId ?? '') ?? []
    const cover =
      keyImages.find((k) => k.type === 'DieselGameBoxTall') ?? keyImages.find((k) => k.type === 'OfferImageTall') ?? keyImages.find((k) => k.type === 'DieselGameBox')
    const game: DetectedGame = {
      platform: 'epic',
      platformId: appName,
      name: cleanTitle(it.DisplayName || appName),
      installDir,
      exePath,
      launch: { kind: 'uri', target: launchUri(it.CatalogNamespace ?? '', it.CatalogItemId ?? '', appName), args: null, cwd: null },
      watchDirs: [installDir],
      processNames: epicProcessNames(it, exePath),
      ignoreNames: (it.IgnoredProcessNames ?? []).filter((n) => typeof n === 'string'),
      installed: true,
      steamAppId: null,
      coverHint: cover?.url ?? null
    }
    scan.games.push(game)
  }
  return scan
}

/** Dossier des manifestes à surveiller (installation, désinstallation). */
export function epicWatchDirs(reg: RegistrySnapshot | null): string[] {
  const d = reg ? epicDataDir(reg) : null
  return d ? [path.join(d, 'Manifests')] : []
}
