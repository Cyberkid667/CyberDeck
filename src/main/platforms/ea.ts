// EA app : jeux d'après leurs clés de désinstallation (EAInstaller\…\Cleanup.exe)
// et __Installer\installerdata.xml (identifiant de contenu, nom). La liste
// interne de l'EA app est chiffrée : on ne la lit pas.
import path from 'node:path'
import { protocolCommand, protocolRegistered, regString } from './registry'
import type { PlatformScan, ScanContext } from './types'
import { cleanDir, cleanTitle, exeFromCommand, exeFromIcon, isDir, isFile, largestExeSync, normDir, readText } from './util'

export function eaClient(ctx: ScanContext): string | null {
  for (const id of ['ea.64', 'ea.32']) {
    for (const name of ['DesktopAppPath', 'ClientPath', 'LauncherAppPath']) {
      const p = regString(ctx.reg, id, name)
      if (isFile(p)) return p
    }
  }
  const fromProtocol = exeFromCommand(protocolCommand(ctx.reg, 'origin2'))
  return isFile(fromProtocol) ? fromProtocol : null
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()

interface EaManifest {
  contentId: string | null
  title: string | null
}

function readInstallerData(installDir: string): EaManifest | null {
  const xml = readText(path.join(installDir, '__Installer', 'installerdata.xml'))
  if (!xml) return null
  const ids = /<contentIDs>([\s\S]*?)<\/contentIDs>/i.exec(xml)?.[1] ?? ''
  const contentId = /<contentID>\s*([^<]+?)\s*<\/contentID>/i.exec(ids)?.[1] ?? null
  const titles = /<gameTitles>([\s\S]*?)<\/gameTitles>/i.exec(xml)?.[1] ?? ''
  const title =
    /<gameTitle\s+locale="en_US"\s*>([^<]*)<\/gameTitle>/i.exec(titles)?.[1] ?? /<gameTitle[^>]*>([^<]*)<\/gameTitle>/i.exec(titles)?.[1] ?? null
  return { contentId: contentId ? decode(contentId) : null, title: title ? decode(title) : null }
}

export async function scanEa(ctx: ScanContext): Promise<PlatformScan> {
  const scan: PlatformScan = { platform: 'ea', ok: true, clientPath: null, detected: false, games: [], excluded: 0, error: null }
  scan.clientPath = eaClient(ctx)
  const seen = new Set<string>()
  for (const e of ctx.reg.uninstall) {
    if (!/\\EAInstaller\\/i.test(e.uninstall) || /^EA app$/i.test(e.name.trim())) continue
    const installDir = e.location.trim() ? cleanDir(e.location) : null
    if (!installDir || !isDir(installDir) || seen.has(normDir(installDir))) continue
    const manifest = readInstallerData(installDir)
    if (!manifest?.contentId) continue // sans installerdata.xml : pas une installation de l'EA app
    seen.add(normDir(installDir))
    const iconExe = exeFromIcon(e.icon)
    const exe = isFile(iconExe) && /\.exe$/i.test(iconExe) ? iconExe : largestExeSync(installDir)
    scan.games.push({
      platform: 'ea',
      platformId: manifest.contentId,
      name: cleanTitle(e.name || manifest.title || path.basename(installDir)),
      installDir,
      exePath: exe,
      launch: { kind: 'uri', target: `origin2://game/launch?offerIds=${encodeURIComponent(manifest.contentId)}`, args: null, cwd: null },
      watchDirs: [installDir],
      // pas de repli par nom : un mod ou un jeu de fan peut aussi contenir un Skate.exe
      processNames: [],
      installed: true,
      steamAppId: null,
      coverHint: null
    })
  }
  scan.detected = !!scan.clientPath || scan.games.length > 0 || protocolRegistered(ctx.reg, 'origin2')
  return scan
}
