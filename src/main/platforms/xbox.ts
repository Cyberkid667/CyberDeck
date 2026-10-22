// Xbox / Microsoft Store : applications de l'utilisateur (Get-AppxPackage) qui
// sont des jeux (MicrosoftGame.config = jeu GDK, ou SDK Xbox Live = jeu UWP).
// Lancement : explorer.exe shell:AppsFolder\<AUMID>. Les paquets enregistrés à la
// main (mode développeur, paquet installé hors du Store) restent des jeux locaux.
import fs from 'node:fs'
import path from 'node:path'
import { protocolRegistered } from './registry'
import type { PlatformScan, ScanContext } from './types'
import { t } from '../../shared/i18n'
import { cleanTitle, isFile, localAppData, readText, skip, uniqueDirs } from './util'

const SYSTEM_PACKAGE = /^Microsoft\.(GamingApp|GamingServices|Xbox|XboxApp|XboxGamingOverlay|XboxGameOverlay|XboxIdentityProvider|XboxSpeechToTextOverlay|Xbox\.TCUI|XboxGameCallableUI|XboxDevices|Edge\.GameAssist)$/i

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  return m ? m[1] : null
}

const decode = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim()

const usable = (s: string | null | undefined): s is string => !!s && !/^ms-resource:/i.test(s.trim())

interface ManifestApp {
  id: string
  executable: string | null
  hidden: boolean
  /** VisualElements + DefaultTile (logos) */
  visual: string
}

/** Image d'un paquet : le fichier exact ou sa meilleure variante (Logo.scale-200.png…). */
function packageImage(root: string, rel: string | null): string | null {
  if (!rel || /^ms-resource:/i.test(rel)) return null
  const p = path.join(root, rel.replace(/\//g, '\\'))
  if (isFile(p)) return p
  const dir = path.dirname(p)
  const ext = path.extname(p).toLowerCase()
  const base = path.basename(p, path.extname(p)).toLowerCase()
  let best: { file: string; size: number } | null = null
  try {
    for (const f of fs.readdirSync(dir)) {
      const lower = f.toLowerCase()
      if (!lower.startsWith(base + '.') || !lower.endsWith(ext) || /lightunplated|contrast-/.test(lower)) continue
      const size = fs.statSync(path.join(dir, f)).size
      if (!best || size > best.size) best = { file: path.join(dir, f), size }
    }
  } catch {
    return null
  }
  return best?.file ?? null
}

function manifestApps(xml: string): ManifestApp[] {
  const out: ManifestApp[] = []
  const re = /<Application\b([^>]*)>([\s\S]*?)<\/Application>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attr(m[1], 'Id')
    if (!id) continue
    const visual = /<[\w:]*VisualElements\b[^>]*>/i.exec(m[2])?.[0] ?? ''
    const tile = /<[\w:]*DefaultTile\b[^>]*>/i.exec(m[2])?.[0] ?? ''
    out.push({ id, executable: attr(m[1], 'Executable'), hidden: /AppListEntry\s*=\s*"none"/i.test(visual), visual: visual + tile })
  }
  return out
}

export async function scanXbox(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'xbox', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  const packages = ctx.reg.appx
  if (packages === null) return { ...scan, ok: false, error: ctx.reg.error ?? t('main.scan.storeAppsUnreadableShort') }
  const gamingApp = packages.find((p) => /^Microsoft\.GamingApp$/i.test(p.name))
  if (gamingApp) {
    const exe = path.join(gamingApp.location, 'XboxPcApp.exe')
    scan.clientPath = isFile(exe) ? exe : gamingApp.location
  }
  const explorer = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')
  const startNames = new Map(ctx.reg.startApps.map((s) => [s.appId.toLowerCase(), s.name]))

  for (const pkg of packages) {
    if (!pkg.location || SYSTEM_PACKAGE.test(pkg.name)) continue
    const gdk = readText(path.join(pkg.location, 'MicrosoftGame.config'))
    const manifest = readText(path.join(pkg.location, 'AppxManifest.xml')) ?? ''
    const xboxLive = !gdk && (isFile(path.join(pkg.location, 'microsoft.xbox.services.dll')) || /Microsoft\.Xbox\.Services/i.test(manifest))
    if (!gdk && !xboxLive) continue
    const app = manifestApps(manifest).find((a) => !a.hidden)
    const propName = decode(/<Properties>[\s\S]*?<DisplayName>([^<]*)<\/DisplayName>/i.exec(manifest)?.[1] ?? '')
    // Paquet enregistré à la main (mode développeur, hors du Store) : c'est un jeu local, pas un jeu Xbox.
    if (pkg.dev || /^(None|Developer)$/i.test(pkg.signature)) {
      const startName = app ? startNames.get(`${pkg.family}!${app.id}`.toLowerCase()) : undefined
      skip(scan, cleanTitle([propName, startName].find(usable) ?? pkg.name), 'local')
      continue
    }
    if (!app) continue
    const aumid = `${pkg.family}!${app.id}`
    let realDir = pkg.location
    try {
      realDir = fs.realpathSync.native(pkg.location)
    } catch {
      // jonction illisible : on garde le dossier du paquet
    }
    let exe: string | null = null
    let name: string | null = null
    // logo carré du Store : jaquette de secours si Steam et Wikipédia n'ont rien
    let logo: string | null = null
    if (gdk) {
      const shell = /<ShellVisuals\b[^>]*>/i.exec(gdk)?.[0] ?? ''
      name = decode(attr(shell, 'DefaultDisplayName') ?? '')
      logo = packageImage(realDir, attr(shell, 'Square480x480Logo')) ?? packageImage(realDir, attr(shell, 'Square150x150Logo'))
      const exes = [...gdk.matchAll(/<Executable\b[^>]*>/gi)].map((x) => x[0])
      const pick = exes.find((t) => /TargetDeviceFamily\s*=\s*"PC"/i.test(t)) ?? exes[0]
      const exeName = pick ? attr(pick, 'Name') : null
      if (exeName) {
        const p = path.join(realDir, exeName.replace(/\//g, '\\'))
        if (isFile(p)) exe = p
      }
    } else if (app.executable) {
      const p = path.join(pkg.location, app.executable.replace(/\//g, '\\'))
      if (isFile(p)) exe = p
    }
    logo = logo ?? packageImage(pkg.location, attr(app.visual, 'Square310x310Logo')) ?? packageImage(pkg.location, attr(app.visual, 'Square150x150Logo'))
    const finalName = [name, startNames.get(aumid.toLowerCase()), propName].find(usable) ?? pkg.name
    scan.games.push({
      platform: 'xbox',
      platformId: aumid,
      name: cleanTitle(finalName),
      installDir: realDir,
      exePath: exe,
      launch: { kind: 'exe', target: explorer, args: `shell:AppsFolder\\${aumid}`, cwd: null },
      // le jeu peut tourner depuis WindowsApps ou depuis C:\XboxGames (jonction), et
      // le Minecraft Launcher lance Java depuis le cache local du paquet
      watchDirs: uniqueDirs([pkg.location, realDir, path.join(localAppData(), 'Packages', pkg.family, 'LocalCache')]),
      processNames: exe ? [path.basename(exe)] : [],
      installed: true,
      steamAppId: null,
      coverHint: logo,
      aumid,
      altDirs: uniqueDirs([pkg.location, realDir])
    })
  }
  scan.detected = !!gamingApp || scan.games.length > 0 || protocolRegistered(ctx.reg, 'msxbox')
  return scan
}
