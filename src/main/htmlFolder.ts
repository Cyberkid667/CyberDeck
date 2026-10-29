// Jeux web (HTML) : analyse du dossier d'un jeu, sans Electron (testé par tests/tools/html-checks.mjs).
// Page à lancer (index.html, www/index.html de RPG Maker, histoire Twine…), nom du jeu
// (System.json de RPG Maker, <title>, dossier), icône et jaquette posées dans le dossier, garde-fous
// sur le dossier lisible par le jeu, et clé de la partition de ses sauvegardes.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { cleanGameName } from '../shared/gameName'

/** Page web (.html ou .htm). */
export const isHtmlPage = (p: string | null | undefined): boolean => !!p && /\.html?$/i.test(p)

const pathFor = (isWin: boolean): typeof path.posix => (isWin ? path.win32 : path.posix)

/**
 * child est parent lui-même ou un de ses descendants. Sans casse sous Windows seulement
 * (Linux : « Game » et « game » sont deux dossiers différents).
 */
export function isInside(child: string, parent: string, isWin: boolean): boolean {
  const P = pathFor(isWin)
  const a = isWin ? child.toLowerCase() : child
  const b = isWin ? parent.toLowerCase() : parent
  const rel = P.relative(b, a)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel)
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

const isFileSync = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Nom réel (casse du disque) d'un fichier du dossier, cherché sans casse. */
function findName(entries: fs.Dirent[], wanted: string, kind: 'file' | 'dir'): string | null {
  const w = wanted.toLowerCase()
  const exact = entries.find((e) => e.name === wanted && (kind === 'dir' ? e.isDirectory() : e.isFile()))
  if (exact) return exact.name
  const loose = entries.find((e) => e.name.toLowerCase() === w && (kind === 'dir' ? e.isDirectory() : e.isFile()))
  return loose?.name ?? null
}

/** Sous-dossiers jamais pris pour le jeu (exports macOS, modules, gabarit d'Unity). */
const SKIP_SUBDIR = /^(__macosx|node_modules|templatedata)$/i
/** Pages d'accompagnement, jamais la page du jeu. */
const SIDE_PAGE = /^(readme|licen[cs]e|credits|changelog|eula|manual|instructions)/i

/**
 * Page à lancer dans un dossier, dans cet ordre : index.html (ou .htm), www/index.html (RPG Maker
 * MV/MZ), un seul sous-dossier direct avec index.html, une seule page à la racine (histoire Twine,
 * pages d'accompagnement ignorées). null : rien de sûr.
 */
export function findHtmlEntry(dir: string): string | null {
  const top = listDir(dir)
  for (const n of ['index.html', 'index.htm']) {
    const f = findName(top, n, 'file')
    if (f) return path.join(dir, f)
  }
  const www = findName(top, 'www', 'dir')
  if (www) {
    const f = findName(listDir(path.join(dir, www)), 'index.html', 'file')
    if (f) return path.join(dir, www, f)
  }
  const subs = top.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_SUBDIR.test(e.name))
  const withIndex = subs
    .map((e) => {
      const f = findName(listDir(path.join(dir, e.name)), 'index.html', 'file')
      return f ? path.join(dir, e.name, f) : null
    })
    .filter((p): p is string => !!p)
  if (withIndex.length === 1) return withIndex[0]
  if (withIndex.length > 1) return null
  const pages = top.filter((e) => e.isFile() && isHtmlPage(e.name) && !SIDE_PAGE.test(e.name))
  return pages.length === 1 ? path.join(dir, pages[0].name) : null
}

/** Début d'un fichier texte (les gros fichiers ne sont pas lus en entier). */
function readHead(file: string, max: number): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(max)
    const n = fs.readSync(fd, buf, 0, max, 0)
    return buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** System.json de RPG Maker (2 Mo au plus) : null s'il est absent, trop gros ou illisible. */
function rpgSystem(pageDir: string): Record<string, unknown> | null {
  const file = path.join(pageDir, 'data', 'System.json')
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Entités HTML les plus courantes d'un <title>. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d: string) => safeChar(parseInt(d, 10), m))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function safeChar(code: number, fallback: string): string {
  try {
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback
  } catch {
    return fallback
  }
}

/** Titres posés par les moteurs ou les modèles de page, jamais le nom du jeu. */
const GENERIC_TITLES = new Set([
  'index',
  'game',
  'untitled',
  'document',
  'html5',
  'html5 game',
  'godot',
  'godot engine',
  'phaser',
  'phaser game',
  'construct',
  'construct 3',
  'unity webgl player',
  'gdevelop',
  'gamemaker',
  'rpg maker',
  'rpg maker mv',
  'rpg maker mz',
  'project1',
  'my game',
  'new project',
  'project',
  'twine'
])

/** Dossiers d'export, jamais le nom du jeu. */
const GENERIC_DIRS = new Set(['www', 'web', 'html', 'html5', 'html5game', 'build', 'builds', 'dist', 'public', 'export', 'webgl', 'game', 'bin', 'release', 'output'])

/** <title> utile de la page (256 premiers Ko), ou null. */
export function pageTitle(entry: string): string | null {
  const head = readHead(entry, 256 * 1024)
  const m = head ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) : null
  if (!m) return null
  const title = decodeEntities(m[1])
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^unity web(gl)? player\s*\|\s*/i, '')
    .trim()
  if (!title || GENERIC_TITLES.has(title.toLowerCase())) return null
  return title
}

/**
 * Nom du jeu : gameTitle de RPG Maker, sinon <title> utile, sinon nom du dossier de la page
 * (dossier d'export générique « www », « build »… : son parent), nettoyé par cleanGameName.
 */
export function htmlGameName(entry: string, root: string): string {
  const pageDir = path.dirname(entry)
  const sys = rpgSystem(pageDir)
  let raw = typeof sys?.gameTitle === 'string' ? sys.gameTitle.trim() : ''
  if (!raw) raw = pageTitle(entry) ?? ''
  if (!raw) {
    let dir = pageDir
    if (GENERIC_DIRS.has(path.basename(dir).toLowerCase())) dir = path.dirname(dir)
    raw = path.basename(dir) || path.basename(root)
  }
  const clean = cleanGameName(raw).trim()
  return clean || path.basename(entry).replace(/\.html?$/i, '')
}

/** Fichier existant dont le chemin réel reste dans root, hors du gabarit TemplateData d'Unity. */
function artFile(root: string, realRoot: string, rel: string, isWin: boolean): string | null {
  const p = path.join(root, rel)
  if (!isInside(path.resolve(p), path.resolve(root), isWin)) return null
  let real: string
  try {
    real = fs.realpathSync.native(p)
  } catch {
    return null
  }
  if (!isInside(real, realRoot, isWin) || !isFileSync(real)) return null
  const relReal = path.relative(realRoot, real).split(/[\\/]/)
  if (relReal.some((s) => s.toLowerCase() === 'templatedata')) return null
  return real
}

const ICON_EXT = /\.(png|jpe?g|ico)$/i

/** href des <link rel="icon" | "shortcut icon" | "apple-touch-icon"> de la page (relatifs seulement). */
function linkedIcons(entry: string): string[] {
  const head = readHead(entry, 256 * 1024)
  if (!head) return []
  const out: string[] = []
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    if (!rel || !href) continue
    const relValue = (rel[1] ?? rel[2] ?? rel[3] ?? '').trim().toLowerCase()
    if (!['icon', 'shortcut icon', 'apple-touch-icon'].includes(relValue)) continue
    let h = decodeEntities(href[1] ?? href[2] ?? href[3] ?? '').trim()
    // adresses absolues (https:, data:, //serveur) : jamais lues
    if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) continue
    h = h.replace(/[?#].*$/, '')
    try {
      h = decodeURIComponent(h)
    } catch {
      continue
    }
    if (ICON_EXT.test(h)) out.push(h)
  }
  return out
}

/**
 * Icônes et jaquettes posées dans le dossier du jeu (chemins réels déjà vérifiés : dans root,
 * fichiers existants, hors TemplateData). Le splash de Godot (index.png) n'est pas pris : c'est
 * souvent le logo du moteur.
 */
export function localArt(root: string, entry: string, isWin = process.platform === 'win32'): { icons: string[]; covers: string[] } {
  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(root)
  } catch {
    return { icons: [], covers: [] }
  }
  const pageDir = path.dirname(entry)
  const relPage = path.relative(root, pageDir)
  const pageBase = path.basename(entry).replace(/\.html?$/i, '')
  const icons: string[] = []
  const covers: string[] = []
  const add = (list: string[], rel: string): void => {
    const f = artFile(root, realRoot, rel, isWin)
    if (f && !list.some((x) => x.toLowerCase() === f.toLowerCase())) list.push(f)
  }
  for (const h of linkedIcons(entry)) add(icons, h.startsWith('/') ? h.replace(/^\/+/, '') : path.join(relPage, h))
  const iconNames = [
    'icon.png',
    'icon/icon.png',
    'icons/icon-256.png',
    'icons/icon-512.png',
    'icons/icon-128.png',
    'favicon.png',
    'favicon.ico',
    `${pageBase}.icon.png`,
    `${pageBase}.apple-touch-icon.png`
  ]
  for (const n of iconNames) add(icons, path.join(relPage, n))
  if (relPage) for (const n of iconNames) add(icons, n)
  for (const dir of relPage ? [relPage, ''] : ['']) {
    for (const base of ['cover', 'capsule', 'thumbnail']) for (const ext of ['png', 'jpg', 'jpeg']) add(covers, path.join(dir, `${base}.${ext}`))
  }
  const sys = rpgSystem(pageDir)
  const title1 = typeof sys?.title1Name === 'string' ? sys.title1Name : ''
  if (title1 && !/[\\/]|\.\./.test(title1)) add(covers, path.join(relPage, 'img', 'titles1', `${title1}.png`))
  return { icons, covers }
}

/**
 * Dossier refusé pour un jeu web (il pourrait tout y lire) : racine d'un disque ou racine UNC,
 * un dossier de « ancestors » ou un de ses parents (C:\Users, /home), un dossier de « exact » ou
 * un de ses parents (Bureau, Téléchargements…, mais un de leurs sous-dossiers est accepté), ou
 * l'intérieur d'un dossier de « inside » (Windows, données de CyberDeck).
 */
export function rootRefusal(realRoot: string, dirs: { ancestors: string[]; exact: string[]; inside: string[] }, isWin: boolean): boolean {
  const P = pathFor(isWin)
  const r = P.resolve(realRoot)
  const root = P.parse(r).root
  const trim = (s: string): string => s.replace(/[\\/]+$/, '')
  if (r === root || trim(r).toLowerCase() === trim(root).toLowerCase()) return true
  if (dirs.ancestors.some((a) => !!a && isInside(P.resolve(a), r, isWin))) return true
  // le dossier connu lui-même et ses parents (Documents déplacé dans OneDrive : OneDrive refusé)
  if (dirs.exact.some((e) => !!e && isInside(P.resolve(e), r, isWin))) return true
  if (dirs.inside.some((d) => !!d && isInside(r, P.resolve(d), isWin))) return true
  return false
}

/**
 * Clé de la partition des sauvegardes (persist:cdgame-<clé>) : empreinte du dossier réel et de la
 * page, 32 caractères hexadécimaux. Sans casse sous Windows. Le même jeu rajouté retrouve donc
 * ses sauvegardes ; le jeu, lui, ne voit jamais cette clé.
 */
export function htmlKey(realRoot: string, relEntry: string, isWin: boolean): string {
  const P = pathFor(isWin)
  let root = P.resolve(realRoot)
  while (root.length > P.parse(root).root.length && /[\\/]$/.test(root)) root = root.slice(0, -1)
  let rel = relEntry.split(isWin ? /[\\/]/ : '/').join('/')
  if (isWin) {
    root = root.toLowerCase()
    rel = rel.toLowerCase()
  }
  return createHash('sha256')
    .update(root + '\n' + rel)
    .digest('hex')
    .slice(0, 32)
}
