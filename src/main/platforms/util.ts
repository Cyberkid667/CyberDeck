// Petits outils partagés par les modules de plateformes (sans Electron).
import fs from 'node:fs'
import path from 'node:path'
import type { GamePlatform, PlatformSkipReason } from '../../shared/types'
import type { PlatformScan } from './types'

/**
 * Note un élément écarté (pas un jeu) ou un doublon (jeu déjà là). Seuls les « pas un jeu »
 * comptent dans scan.excluded ; les doublons sont comptés à part par l'état des plateformes.
 */
export function skip(scan: PlatformScan, name: string, reason: PlatformSkipReason, other?: GamePlatform): void {
  ;(scan.skipped ??= []).push(other ? { name, reason, other } : { name, reason })
  if (reason !== 'local' && reason !== 'platform') scan.excluded++
}

/** Windows. Hors Windows (Linux) : chemins POSIX, casse respectée. */
export const isWindows = (): boolean => process.platform === 'win32'

/** Chemin comparable : absolu, minuscules, sans séparateur final (Linux : casse gardée, barres « / »). */
export function normDir(p: string): string {
  if (!isWindows()) {
    let u = path.resolve(p)
    while (u.length > 1 && u.endsWith('/')) u = u.slice(0, -1)
    return u
  }
  let r = path.resolve(p.replace(/\//g, '\\')).toLowerCase()
  while (r.length > 3 && r.endsWith('\\')) r = r.slice(0, -1)
  return r
}

export const sameDir = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && normDir(a) === normDir(b)

/** file est dans dir (ou un de ses sous-dossiers). */
export const isInside = (file: string | null | undefined, dir: string | null | undefined): boolean =>
  !!file && !!dir && normDir(file).startsWith(normDir(dir) + (isWindows() ? '\\' : '/'))

/** Barres du système (Linux : les « \ » des chemins Windows d'appinfo.vdf deviennent « / »). */
export const fixSlashes = (p: string): string =>
  isWindows() ? path.normalize(p.replace(/\//g, '\\')) : path.normalize(p.replace(/\\/g, '/'))

/** Dossier propre : barres Windows, absolu, sans séparateur final (sûr entre guillemets). */
export const cleanDir = (p: string): string =>
  isWindows() ? path.resolve(p.trim().replace(/^"|"$/g, '').replace(/\//g, '\\')) : path.resolve(p.trim().replace(/^"|"$/g, ''))

export function isDir(p: string | null | undefined): p is string {
  if (!p) return false
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function isFile(p: string | null | undefined): p is string {
  if (!p) return false
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Lit un fichier texte UTF-8 (sans BOM) ; null s'il est absent ou illisible. */
export function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

export function readJson<T = any>(p: string): T | null {
  const t = readText(p)
  if (t === null) return null
  try {
    return JSON.parse(t) as T
  } catch {
    return null
  }
}

/** "C:\x\y.exe",0 → C:\x\y.exe */
export function exeFromIcon(icon: string | null | undefined): string | null {
  if (!icon) return null
  const s = icon
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/,\s*-?\d+$/, '')
    .replace(/^"|"$/g, '')
    .trim()
  return s || null
}

/** Premier chemin entre guillemets d'une ligne de commande, sinon le premier mot. */
export function exeFromCommand(cmd: string | null | undefined): string | null {
  if (!cmd) return null
  const q = cmd.match(/^\s*"([^"]+)"/)
  if (q) return q[1]
  const m = cmd.trim().match(/^(\S+\.exe)\b/i)
  return m ? m[1] : null
}

/** Nom propre : sans ®, ™, ©, espaces en double. */
export function cleanTitle(name: string): string {
  return name
    .replace(/[\u00ae\u2122\u00a9]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Dossier qu'on peut surveiller sans risque : existe et n'est pas la racine d'un disque. */
export function watchable(dir: string | null | undefined): dir is string {
  if (!dir) return false
  const r = path.resolve(dir)
  return r !== path.parse(r).root
}

export function uniqueDirs(dirs: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    if (!watchable(d)) continue
    const k = normDir(d)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(path.resolve(d))
  }
  return out
}

const NOT_GAME_EXE =
  /(unins\d*|uninstall|setup|install|redist|dxsetup|vc_?redist|crash|report|helper|prereq|dotnet|physx|7z|update|anticheat|easyanticheat|battleye|be_service|cefprocess|webhelper|launcherpatcher|ue4prereq|dxwebsetup)/i

/** Le plus gros .exe d'un dossier (3 niveaux), pour l'icône d'un jeu dont le programme est inconnu. */
export function largestExeSync(root: string, maxDepth = 3): string | null {
  let best: { p: string; size: number } | null = null
  let budget = 3000
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (--budget < 0) return
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth && !/(redist|directx|support|_commonredist|tools|__installer|prereq)/i.test(e.name)) walk(p, depth + 1)
      } else if (/\.exe$/i.test(e.name) && !NOT_GAME_EXE.test(e.name)) {
        let size = 0
        try {
          size = fs.statSync(p).size
        } catch {
          // illisible
        }
        if (!best || size > best.size) best = { p, size }
      }
    }
  }
  walk(root, 0)
  return (best as { p: string } | null)?.p ?? null
}

export const env = (name: string, fallback: string): string => process.env[name] || fallback
export const programData = (): string => env('ProgramData', 'C:\\ProgramData')
export const localAppData = (): string => env('LOCALAPPDATA', path.join(env('USERPROFILE', 'C:\\Users\\Default'), 'AppData', 'Local'))
export const roamingAppData = (): string => env('APPDATA', path.join(env('USERPROFILE', 'C:\\Users\\Default'), 'AppData', 'Roaming'))
