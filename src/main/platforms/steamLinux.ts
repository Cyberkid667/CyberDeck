// Steam sous Linux : dossier du client (installation native, Flatpak, Snap) et jeu que Steam
// est en train de lancer (registry.vdf). Aucun appel à Electron : les tests (tests/tools/
// linux-checks.mjs) appellent ces fonctions avec un faux dossier personnel.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseVdf, vdfStr } from './vdf'

const FLATPAK = path.join('.var', 'app', 'com.valvesoftware.Steam')

/** Dossiers possibles du client Steam, du plus courant au plus rare. */
export function linuxSteamCandidates(home: string, env: NodeJS.ProcessEnv = {}): string[] {
  const list = [
    // liens posés par Steam lui-même vers le vrai dossier
    path.join(home, '.steam', 'steam'),
    path.join(home, '.steam', 'root'),
    // installation native (paquet de la distribution, steam-installer)
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'Steam') : null,
    path.join(home, '.local', 'share', 'Steam'),
    // Debian/Ubuntu anciennes versions
    path.join(home, '.steam', 'debian-installation'),
    // Flatpak (Flathub) et Snap
    path.join(home, FLATPAK, '.local', 'share', 'Steam'),
    path.join(home, FLATPAK, 'data', 'Steam'),
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam')
  ]
  return list.filter((p): p is string => !!p)
}

const isDirSync = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const isFileSync = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

const mtime = (p: string): number => {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/** Un vrai dossier de client Steam : des bibliothèques (steamapps) ou sa configuration. */
export function isSteamRoot(dir: string): boolean {
  return isDirSync(path.join(dir, 'steamapps')) || isFileSync(path.join(dir, 'config', 'libraryfolders.vdf'))
}

export interface LinuxSteamClient {
  dir: string
  /** script de lancement du client (affiché dans la page Lanceurs) ; le dossier s'il manque */
  exe: string
}

/**
 * Client Steam de ce compte Linux. Plusieurs installations (native et Flatpak) : celle dont la
 * liste des comptes a été écrite le plus récemment (celle que l'utilisateur utilise).
 */
export function findLinuxSteamClient(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): LinuxSteamClient | null {
  const seen = new Set<string>()
  const roots: string[] = []
  for (const c of linuxSteamCandidates(home, env)) {
    if (!isSteamRoot(c)) continue
    let real = c
    try {
      real = fs.realpathSync(c)
    } catch {
      // lien cassé : le chemin tel quel
    }
    if (seen.has(real)) continue
    seen.add(real)
    roots.push(real)
  }
  if (!roots.length) return null
  const score = (d: string): number => Math.max(mtime(path.join(d, 'config', 'loginusers.vdf')), mtime(path.join(d, 'steamapps')))
  const dir = roots.length === 1 ? roots[0] : [...roots].sort((a, b) => score(b) - score(a))[0]
  const exe = [path.join(dir, 'steam.sh'), path.join(dir, 'ubuntu12_32', 'steam')].find(isFileSync) ?? dir
  return { dir, exe }
}

/** registry.vdf : le « registre » que Steam tient sous Linux (RunningAppID, ActiveUser…). */
export function linuxSteamRegistryFiles(home: string = os.homedir()): string[] {
  return [path.join(home, '.steam', 'registry.vdf'), path.join(home, FLATPAK, '.steam', 'registry.vdf')]
}

function registryValue(home: string, name: string, files?: string[]): number {
  for (const file of files ?? linuxSteamRegistryFiles(home)) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    try {
      const v = Number(vdfStr(parseVdf(text), 'Registry', 'HKCU', 'Software', 'Valve', 'Steam', name) ?? 0)
      if (Number.isFinite(v) && v > 0) return v
    } catch {
      // fichier en cours d'écriture
    }
  }
  return 0
}

/** Jeu que Steam prépare ou lance (0 : aucun). Raison d'attendre, jamais une preuve qu'il tourne. */
export const linuxSteamRunningAppId = (home: string = os.homedir(), files?: string[]): number => registryValue(home, 'RunningAppID', files)
