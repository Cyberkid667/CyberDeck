// Pays d'une adresse IP, HORS LIGNE : table DB-IP « IP to Country Lite » (CC BY 4.0) livrée
// avec l'app (build/geo/ip-country.bin, générée par scripts/make-geo.mjs). Aucune adresse
// n'est envoyée nulle part : recherche dichotomique en mémoire, dans le processus du moteur.
//
// La table n'est lue qu'au premier pair (≈ 0,6 Mo compressés, ≈ 6 Mo en mémoire), puis
// gardée. Format : voir l'en-tête de scripts/make-geo.mjs.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { CENTROIDS } from '../shared/geoCentroids'

interface Table {
  codes: string[]
  /** débuts des plages IPv4 (croissants) et index du pays de chacune */
  v4: Uint32Array
  c4: Uint8Array
  /** débuts des plages IPv6, en préfixes /48 (entiers exacts < 2^48) */
  v6: Float64Array
  c6: Uint8Array
}

let table: Table | null | undefined
let file = ''

/** Chemin de la table (fixé au lancement du moteur) ; la lecture n'a lieu qu'au premier besoin. */
export function setGeoFile(path: string): void {
  file = path
}

function load(): Table | null {
  if (table !== undefined) return table
  table = null
  try {
    const raw = zlib.brotliDecompressSync(fs.readFileSync(file))
    if (raw.toString('ascii', 0, 4) !== 'CDIP' || raw[4] !== 1) throw new Error('format inconnu')
    let o = 5
    const nc = raw[o++]
    const codes: string[] = []
    for (let i = 0; i < nc; i++, o += 2) codes.push(raw.toString('ascii', o, o + 2))
    const section = <T extends Uint32Array | Float64Array>(make: (n: number) => T): [T, Uint8Array] => {
      const n = raw.readUInt32LE(o)
      o += 4
      const starts = make(n)
      let prev = 0
      for (let i = 0; i < n; i++) {
        let d = 0
        let mul = 1
        for (;;) {
          const b = raw[o++]
          d += (b & 0x7f) * mul
          if (b < 0x80) break
          mul *= 0x80
        }
        prev += d
        starts[i] = prev
      }
      const cc = raw.subarray(o, o + n)
      o += n
      return [starts, cc]
    }
    const [v4, c4] = section((n) => new Uint32Array(n))
    const [v6, c6] = section((n) => new Float64Array(n))
    table = { codes, v4, c4, v6, c6 }
  } catch (e) {
    console.error(`[geoip] table illisible : ${(e as Error).message}`)
  }
  return table
}

/** Index de la dernière plage dont le début est ≤ x (-1 si aucune). */
function bisect(starts: Uint32Array | Float64Array, x: number): number {
  let lo = 0
  let hi = starts.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= x) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

function parseV4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const p = m.slice(1).map(Number)
  if (p.some((n) => n > 255)) return null
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]
}

/** Préfixe /48 d'une IPv6 (les 3 premiers groupes), ou null si l'adresse est illisible. */
function parseV6Prefix(s: string): number | null {
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null]
  const h = head ? head.split(':') : []
  const t = tail === null ? [] : tail ? tail.split(':') : []
  if (h.length + t.length > 8) return null
  const parts = tail === null ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null
  return (parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16)) * 65536 + parseInt(parts[2], 16)
}

/** Hôte d'une adresse « 1.2.3.4:5678 », « [2a01::1]:51413 » ou « ::ffff:1.2.3.4:5678 ». */
export function hostOf(address: string): string {
  let a = address.trim()
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(a)
  if (br) a = br[1]
  else if (/^[\d.]+:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'))
  else {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/i.exec(a)
    if (mapped) a = mapped[1]
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a)
  return mapped ? mapped[1] : a
}

/** Code pays ISO 3166-1 alpha-2 d'une adresse IPv4 ou IPv6 (sans port), ou null (inconnue, réseau privé). */
export function countryOf(address: string): string | null {
  const tb = load()
  if (!tb) return null
  const host = hostOf(address)
  const v4 = parseV4(host)
  let i: number
  let cc: number
  if (v4 !== null) {
    i = bisect(tb.v4, v4)
    cc = i >= 0 ? tb.c4[i] : 0
  } else {
    const v6 = host.includes(':') ? parseV6Prefix(host) : null
    if (v6 === null) return null
    i = bisect(tb.v6, v6)
    cc = i >= 0 ? tb.c6[i] : 0
  }
  return cc > 0 ? (tb.codes[cc] ?? null) : null
}

/** Empreinte FNV-1a 32 bits (même calcul que fx/random.ts du rendu). */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface PeerGeo {
  country: string
  lat: number
  lon: number
}

const cache = new Map<string, PeerGeo | null>()

/**
 * Pays et position d'un pair : le point du pays, décalé d'un petit écart stable tiré de
 * l'adresse (jusqu'à ≈ 2,2°) pour que les pairs d'un même pays ne s'empilent pas.
 */
export function peerGeo(address: string): PeerGeo | null {
  const host = hostOf(address)
  if (!host || host === '—') return null
  const hit = cache.get(host)
  if (hit !== undefined) return hit
  const country = countryOf(host)
  const c = country ? CENTROIDS[country] : undefined
  let geo: PeerGeo | null = null
  if (country && c) {
    const h = hash(host)
    const ang = ((h & 0xffff) / 65536) * Math.PI * 2
    const rad = Math.sqrt((h >>> 16) / 65536) * 2.2
    const lat = Math.max(-85, Math.min(85, c[0] + Math.sin(ang) * rad))
    const lon = c[1] + (Math.cos(ang) * rad) / Math.max(0.3, Math.cos((lat * Math.PI) / 180))
    geo = { country, lat: Math.round(lat * 100) / 100, lon: Math.round((((lon + 540) % 360) - 180) * 100) / 100 }
  }
  if (cache.size > 4000) cache.clear()
  cache.set(host, geo)
  return geo
}
