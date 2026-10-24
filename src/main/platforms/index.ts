// Détection de toutes les plateformes : un passage = une photo du registre
// (PowerShell) puis chaque plateforme lue à part. Une plateforme qui plante
// n'empêche pas les autres ; ses jeux ne sont alors pas marqués désinstallés.
import type { LauncherPlatform } from '../../shared/types'
import { platformsFor } from '../../shared/platforms'
import { scanAmazon } from './amazon'
import { scanBattlenet } from './battlenet'
import { scanEa } from './ea'
import { scanEpic } from './epic'
import { scanGog } from './gog'
import { scanItch } from './itch'
import { takeSnapshot, type RegistrySnapshot } from './registry'
import { scanRiot } from './riot'
import { scanRockstar } from './rockstar'
import { scanSteam, type SteamScanExtra } from './steam'
import type { PlatformScan, ScanContext } from './types'
import { scanUbisoft } from './ubisoft'
import { isInside, sameDir, skip } from './util'
import { t } from '../../shared/i18n'
import { scanXbox } from './xbox'

export type { DetectedGame, PlatformScan } from './types'

/** Plateformes lisibles sans le registre (fichiers seulement). */
const FILE_ONLY = new Set<LauncherPlatform>(['riot'])

export interface ScanOptions {
  /** photo du registre à réutiliser (passage partiel déclenché par un dossier surveillé) */
  reg?: RegistrySnapshot | null
  only?: LauncherPlatform[]
  steam: SteamScanExtra
  log: (message: string) => void
  tempDir: string
}

export async function scanPlatforms(opts: ScanOptions): Promise<{ reg: RegistrySnapshot; scans: PlatformScan[] }> {
  // Linux : Steam seul (les autres lanceurs n'existent que sous Windows)
  const supported = platformsFor(process.platform)
  const wanted = opts.only?.length ? supported.filter((p) => opts.only!.includes(p)) : supported
  const needAppx = wanted.includes('xbox')
  let reg = opts.reg ?? null
  if (!reg || (needAppx && reg.appx === null && reg.ok)) reg = await takeSnapshot(undefined, true)
  if (!reg.ok) opts.log(reg.error ?? 'Lecture du registre impossible')
  const ctx: ScanContext = { reg, log: opts.log, tempDir: opts.tempDir }

  const scanners: Record<LauncherPlatform, () => Promise<PlatformScan>> = {
    steam: () => scanSteam(ctx, opts.steam),
    epic: () => scanEpic(ctx),
    gog: () => scanGog(ctx),
    ea: () => scanEa(ctx),
    ubisoft: () => scanUbisoft(ctx),
    battlenet: () => scanBattlenet(ctx),
    rockstar: () => scanRockstar(ctx),
    xbox: () => scanXbox(ctx),
    itch: () => scanItch(ctx),
    amazon: () => scanAmazon(ctx),
    riot: () => scanRiot(ctx)
  }

  const scans: PlatformScan[] = []
  for (const p of wanted) {
    let scan: PlatformScan
    try {
      scan = await scanners[p]()
    } catch (err: any) {
      scan = { platform: p, ok: false, clientPath: null, detected: false, games: [], excluded: 0, error: t('main.scan.failed', { error: err?.message ?? String(err) }) }
    }
    // Sans le registre, l'absence d'un jeu ne prouve rien : on n'en retire aucun.
    if (!reg.ok && !FILE_ONLY.has(p)) {
      scan.ok = false
      scan.error = scan.error ?? reg.error
    }
    scans.push(scan)
  }

  // Un même dossier vu par deux plateformes (jeu Ubisoft acheté sur Steam…) : la
  // plateforme d'origine passe en premier (ordre de PLATFORM_ORDER).
  const kept: { dir: string; platform: LauncherPlatform }[] = []
  for (const scan of scans) {
    scan.games = scan.games.filter((g) => {
      if (!g.installed || !g.installDir) return true
      const dup = kept.find((k) => k.platform !== scan.platform && (sameDir(k.dir, g.installDir) || isInside(g.installDir, k.dir)))
      if (dup) {
        skip(scan, g.name, 'platform', dup.platform)
        return false
      }
      kept.push({ dir: g.installDir, platform: scan.platform })
      return true
    })
  }
  return { reg, scans }
}

export { takeSnapshot }
export type { RegistrySnapshot }
