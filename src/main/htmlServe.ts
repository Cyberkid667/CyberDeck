// Jeux web (HTML) : réponses du protocole cdgame:// et règles réseau, sans Electron (testé par
// tests/tools/html-checks.mjs). Un jeu ne lit que les fichiers de son dossier (contrôle des
// segments, puis chemin réel), les builds Unity compressés sont décompressés ici, et chaque
// requête de la page passe par requestVerdict (Internet coupé par défaut, réseau local jamais).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip } from 'node:zlib'
import { isInside } from './htmlFolder'

/** Hôte fixe des jeux : l'origine (cdgame://game) ne dit rien du dossier ni du compte Windows. */
export const GAME_HOST = 'game'

/** Adresse servie par CyberDeck pour un jeu (cdgame://game/…). */
export const isGameUrl = (u: string | null | undefined): boolean => !!u && (u === 'cdgame://game' || u.startsWith('cdgame://game/'))

/** Adresse de la page du jeu : cdgame://game/<segments encodés>. */
export function entryUrl(relEntry: string): string {
  const segs = relEntry.split(/[\\/]/).filter(Boolean)
  return 'cdgame://game/' + segs.map(encodeURIComponent).join('/')
}

export interface ServeCtx {
  realRoot: string
  isWin: boolean
  /** Linux : un nom écrit avec une autre casse est retrouvé s'il n'y a qu'une correspondance */
  caseFallback: boolean
  /** listes des dossiers lues par le repli de casse, gardées tant que la fenêtre est ouverte */
  dirCache: Map<string, string[]>
  /** Internet autorisé pour ce jeu (règle connect-src des pages et des workers) ; absent : coupé */
  network?: () => boolean
}

/**
 * Règle CSP des pages et scripts d'un jeu : fetch, WebSocket, WebTransport… seulement vers ses
 * propres fichiers, et vers https / wss si Internet est autorisé (le filtre réseau de la session
 * ne voit pas WebTransport).
 */
export const connectPolicy = (network: boolean): string => `connect-src 'self' cdgame: data: blob:${network ? ' https: wss:' : ''}`

export type Resolved = { file: string; size: number } | { status: 400 | 404 }

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/** Segment de chemin refusé (400) : remonte, contient un séparateur, un caractère de contrôle… */
function badSegment(s: string, isWin: boolean): boolean {
  if (s === '.' || s === '..') return true
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (ch === '/' || ch === '\\' || c < 0x20 || c === 0x7f) return true
  }
  if (isWin) {
    if (/[:<>"|?*]/.test(s)) return true
    if (/[. ]$/.test(s)) return true
    if (WIN_RESERVED.test(s)) return true
  }
  return false
}

/** Linux : retrouve un chemin écrit avec une autre casse (une seule correspondance par segment). */
async function caseResolve(root: string, segs: string[], cache: Map<string, string[]>): Promise<string | null> {
  let dir = root
  for (const seg of segs) {
    let names = cache.get(dir)
    if (!names) {
      try {
        names = await fsp.readdir(dir)
      } catch {
        return null
      }
      cache.set(dir, names)
    }
    if (names.includes(seg)) {
      dir = path.join(dir, seg)
      continue
    }
    const want = seg.normalize('NFC').toLowerCase()
    const hits = names.filter((n) => n.normalize('NFC').toLowerCase() === want)
    if (hits.length !== 1) return null
    dir = path.join(dir, hits[0])
  }
  return dir
}

/**
 * Fichier du jeu désigné par le chemin d'une adresse (url.pathname : requête et ancre ignorées).
 * 400 : chemin refusé ; 404 : absent, dossier, ou chemin réel hors du dossier du jeu (lien,
 * jonction, lecteur SUBST).
 */
export async function resolveGameFile(realRoot: string, pathname: string, ctx: { isWin: boolean; caseFallback: boolean; dirCache: Map<string, string[]> }): Promise<Resolved> {
  const parts = pathname.split('/')
  if (parts[0] === '') parts.shift()
  if (parts.length === 0) parts.push('')
  if (parts[parts.length - 1] === '') parts[parts.length - 1] = 'index.html'
  const segs: string[] = []
  for (const p of parts) {
    if (p === '') return { status: 400 }
    let s: string
    try {
      s = decodeURIComponent(p)
    } catch {
      return { status: 400 }
    }
    if (badSegment(s, ctx.isWin)) return { status: 400 }
    segs.push(s)
  }
  let candidate = path.join(realRoot, ...segs)
  if (!isInside(candidate, realRoot, ctx.isWin)) return { status: 400 }
  if (ctx.caseFallback) {
    const present = await fsp.lstat(candidate).then(
      () => true,
      () => false
    )
    if (!present) {
      const found = await caseResolve(realRoot, segs, ctx.dirCache)
      if (!found) return { status: 404 }
      candidate = found
    }
  }
  let real: string
  try {
    real = await fsp.realpath(candidate)
  } catch {
    return { status: 404 }
  }
  if (!isInside(real, realRoot, ctx.isWin)) return { status: 404 }
  try {
    const st = await fsp.stat(real)
    if (!st.isFile()) return { status: 404 }
    return { file: real, size: st.size }
  } catch {
    return { status: 404 }
  }
}

const TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  ktx2: 'image/ktx2',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mid: 'audio/midi',
  midi: 'audio/midi',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  atlas: 'text/plain; charset=utf-8',
  fnt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  csv: 'text/csv',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json'
}

const OCTET = 'application/octet-stream'

/**
 * Type d'un fichier, et décompression à faire : *.{js,wasm,data,mem}.gz / .br (builds Unity) sont
 * servis décompressés, avec le type de l'extension intérieure. Les autres .gz / .br sont bruts.
 */
export function mimeFor(file: string): { type: string; decode: 'gzip' | 'br' | null } {
  const name = path.basename(file).toLowerCase()
  const m = /\.(js|wasm|data|mem)\.(gz|br)$/.exec(name)
  if (m) return { type: TYPES[m[1]] ?? OCTET, decode: m[2] === 'gz' ? 'gzip' : 'br' }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return { type: TYPES[ext] ?? OCTET, decode: null }
}

/**
 * En-tête Range : une seule plage (bytes=a-b, bytes=a-, bytes=-n). null : absent, plusieurs plages
 * ou mal formé (fichier entier servi) ; 'unsatisfiable' : hors du fichier, n = 0 ou fichier vide.
 */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return null
  if (a === '') {
    const n = Number(b)
    if (!Number.isSafeInteger(n)) return null
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  if (!Number.isSafeInteger(start)) return null
  if (b !== '') {
    const end = Number(b)
    if (!Number.isSafeInteger(end) || end < start) return null
    if (start >= size) return 'unsatisfiable'
    return { start, end: Math.min(end, size - 1) }
  }
  if (start >= size) return 'unsatisfiable'
  return { start, end: size - 1 }
}

/** En-têtes de toutes les réponses, erreurs comprises (isolation : SharedArrayBuffer, wasm multi-cœurs). */
function baseHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-cache',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Referrer-Policy': 'no-referrer'
  })
}

const errorResponse = (status: number): Response => new Response(null, { status, headers: baseHeaders() })

/** La page déclare son jeu de caractères dans ses 1024 premiers octets. */
async function declaresCharset(file: string): Promise<boolean> {
  let fh: fsp.FileHandle | null = null
  try {
    fh = await fsp.open(file, 'r')
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    return /<meta[^>]+charset\s*=/i.test(buf.subarray(0, bytesRead).toString('latin1'))
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}

const toWeb = (s: NodeJS.ReadableStream): ReadableStream => Readable.toWeb(s as Readable) as unknown as ReadableStream

/** Réponse à une requête cdgame:// de la page d'un jeu (GET ou HEAD, hôte « game » seulement). */
export async function serveGameRequest(req: Request, ctx: ServeCtx): Promise<Response> {
  const method = req.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return errorResponse(405)
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return errorResponse(400)
  }
  if (url.host !== GAME_HOST) return errorResponse(404)
  const r = await resolveGameFile(ctx.realRoot, url.pathname, ctx)
  if ('status' in r) return errorResponse(r.status)
  const { type, decode } = mimeFor(r.file)
  const headers = baseHeaders()
  let contentType = type
  if (type === 'text/html') contentType = (await declaresCharset(r.file)) ? 'text/html' : 'text/html; charset=utf-8'
  headers.set('Content-Type', contentType)
  if (type === 'text/html' || type === 'application/xhtml+xml' || /javascript/.test(type))
    headers.set('Content-Security-Policy', connectPolicy(ctx.network?.() ?? false))
  const head = method === 'HEAD'
  if (decode) {
    if (head) return new Response(null, { status: 200, headers })
    const src = fs.createReadStream(r.file)
    const unzip = decode === 'gzip' ? createGunzip() : createBrotliDecompress()
    // une erreur (fichier abîmé) interrompt le flux : le jeu voit un échec de chargement
    const out = pipeline(src, unzip, () => {})
    return new Response(toWeb(out), { status: 200, headers })
  }
  headers.set('Accept-Ranges', 'bytes')
  const range = parseRange(req.headers.get('range'), r.size)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${r.size}`)
    return new Response(null, { status: 416, headers })
  }
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${r.size}`)
    headers.set('Content-Length', String(range.end - range.start + 1))
    if (head) return new Response(null, { status: 206, headers })
    return new Response(toWeb(fs.createReadStream(r.file, { start: range.start, end: range.end })), { status: 206, headers })
  }
  headers.set('Content-Length', String(r.size))
  if (head || r.size === 0) return new Response(head ? null : '', { status: 200, headers })
  return new Response(toWeb(fs.createReadStream(r.file)), { status: 200, headers })
}

// ---------- Réseau ----------

function ipv4Parts(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return null
  const p = m.slice(1).map(Number)
  return p.every((n) => n <= 255) ? p : null
}

function privateV4(p: number[]): boolean {
  const [a, b, c] = p
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a >= 224) return true // 224/4 (multidiffusion), 240/4 et 255.255.255.255
  return false
}

/** IPv6 en 8 groupes de 16 bits (forme « ::ffff:1.2.3.4 » comprise) ; null si ce n'en est pas une. */
function ipv6Groups(h: string): number[] | null {
  if (!h.includes(':')) return null
  let s = h.replace(/%.*$/, '')
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (v4) {
    const p = ipv4Parts(v4[1])
    if (!p) return null
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (x: string): number[] | null => {
    if (!x) return []
    const out: number[] = []
    for (const g of x.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const left = parse(halves[0])
  const right = halves.length === 2 ? parse(halves[1]) : []
  if (!left || !right) return null
  if (halves.length === 1) return left.length === 8 ? left : null
  const fill = 8 - left.length - right.length
  if (fill < 1) return null
  return [...left, ...new Array(fill).fill(0), ...right]
}

/**
 * Hôte du réseau local ou réservé : jamais joignable par un jeu web, même avec Internet autorisé
 * (box, NAS, imprimante, services de ce PC).
 */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  while (h.endsWith('.')) h = h.slice(0, -1)
  if (!h) return true
  const v4 = ipv4Parts(h)
  if (v4) return privateV4(v4)
  const g = ipv6Groups(h)
  if (g) {
    if (g.every((x) => x === 0)) return true // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
    const embedded = (): number[] => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]
    // ::ffff:a.b.c.d (IPv4 encapsulée) et 64:ff9b::/96 (NAT64) : contrôlées comme de l'IPv4
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(embedded())
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(embedded())
    // IPv4 compatible (::a.b.c.d, obsolète)
    if (g.slice(0, 6).every((x) => x === 0)) return true
    if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10
    if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true // 2001:db8::/32
    return false
  }
  if (h.includes(':')) return true // adresse IPv6 mal formée : refusée
  if (!h.includes('.')) return true // nom sans point (machine du réseau local)
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true
  return false
}

export type Verdict = 'allow' | 'offline' | 'private' | 'scheme'

/**
 * Décision pour une requête de la page d'un jeu : ses propres fichiers et les adresses internes
 * passent ; https et wss seulement si Internet est autorisé pour ce jeu, et jamais vers le réseau
 * local ; tout le reste (http, ws, file, essaim…) est refusé.
 */
export function requestVerdict(url: string, network: boolean): Verdict {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'scheme'
  }
  switch (u.protocol) {
    case 'cdgame:':
    case 'data:':
    case 'blob:':
    case 'about:':
    case 'devtools:':
    case 'chrome-devtools:':
      return 'allow'
    case 'https:':
    case 'wss:':
      if (!network) return 'offline'
      return isPrivateHost(u.hostname) ? 'private' : 'allow'
    default:
      return 'scheme'
  }
}

/**
 * Lien ouvert dans le navigateur depuis un jeu : https seulement, sans identifiants dans
 * l'adresse, Internet autorisé pour ce jeu, fenêtre du jeu active, clic ou touche de
 * l'utilisateur dans la dernière seconde, et une ouverture toutes les 3 s au plus.
 */
export function externalOpenAllowed(
  url: string,
  o: { focused: boolean; network: boolean; lastInputAt: number; lastOpenAt: number; now: number }
): boolean {
  if (typeof url !== 'string' || url.length > 2048) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  if (!o.focused || !o.network) return false
  if (o.now - o.lastInputAt > 1000) return false
  return o.now - o.lastOpenAt >= 3000
}

const DANGEROUS_EXT = new Set(
  (
    'exe com bat cmd ps1 psm1 psd1 vb vbs vbe js jse ws wsf wsh wsc sct hta msi msp mst msix msixbundle appx appxbundle ' +
    'appinstaller application gadget scr pif lnk url reg cpl inf scf jar dll sys ocx drv chm hlp xll iso img vhd vhdx ' +
    'library-ms search-ms settingcontent-ms sh desktop appimage run ' +
    'msc rdp appref-ms diagcab diagcfg diagpkg mht mhtml website theme themepack deskthemepack searchconnector-ms ' +
    'ps1xml ps2 ps2xml psc1 psc2 msh msh1 msh2 mshxml xbap vsto cab py pyw'
  ).split(' ')
)

/** Fichier qui pourrait lancer des programmes sur ce PC : jamais enregistré depuis un jeu. */
export function dangerousDownload(name: string): boolean {
  const base = String(name ?? '')
    .trim()
    .replace(/[. ]+$/, '')
    .toLowerCase()
  const i = base.lastIndexOf('.')
  if (i < 0) return false
  return DANGEROUS_EXT.has(base.slice(i + 1))
}
