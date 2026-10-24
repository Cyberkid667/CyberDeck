// Génère les données géographiques hors ligne du globe des pairs (à relancer à la main,
// par exemple une fois par an ; rien n'est téléchargé par l'app) :
//
//   node scripts/make-geo.mjs <dbip-country-lite-AAAA-MM.csv.gz> <ne_50m_land.geojson> <ne_50m_admin_0_countries.geojson>
//
// Sources (voir ATTRIBUTION.md) :
//   - DB-IP « IP to Country Lite » (CC BY 4.0) : https://db-ip.com/db/download/ip-to-country-lite
//   - Natural Earth 1:50m « Land » et « Admin 0 – Countries » (domaine public) : https://www.naturalearthdata.com
//
// Sorties :
//   - build/geo/ip-country.bin       : table IP → pays (IPv4 + préfixes IPv6 /48), compressée en Brotli
//   - src/shared/geoCentroids.ts        : point « étiquette » de chaque pays (lat, lon), d'après Natural Earth
//   - src/renderer/src/fx/landMask.ts : masque des terres 0,5° (720 × 360), lignes codées en longueurs de plages
//
// Format de ip-country.bin (après décompression Brotli), entiers en petit-boutiste :
//   "CDIP" | u8 version (1) | u8 nombre de pays C | C × 2 octets ASCII (index 0 = « ?? » inconnu)
//   u32 n4 | n4 × varint (écart avec le début précédent, adresse IPv4) | n4 × u8 index du pays
//   u32 n6 | n6 × varint (écart avec le début précédent, préfixe IPv6 /48) | n6 × u8 index du pays
// Chaque entrée est le DÉBUT d'une plage qui court jusqu'au début suivant (recherche dichotomique).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [csvPath, landPath, countriesPath] = process.argv.slice(2)
if (!csvPath || !landPath || !countriesPath) {
  console.error('usage: node scripts/make-geo.mjs <dbip-country-lite.csv.gz> <ne_50m_land.geojson> <ne_50m_admin_0_countries.geojson>')
  process.exit(1)
}

// ---------- 1. Table IP → pays ----------

const csv = zlib.gunzipSync(fs.readFileSync(csvPath)).toString('utf8')
const codes = ['??']
const codeIndex = new Map([['ZZ', 0]])
const idx = (cc) => {
  if (!/^[A-Z]{2}$/.test(cc)) return 0
  let i = codeIndex.get(cc)
  if (i === undefined) {
    i = codes.length
    codes.push(cc)
    codeIndex.set(cc, i)
  }
  return i
}

const v4 = [] // [début, fin, pays]
const v6 = [] // [début BigInt, fin BigInt, pays]
const ip4 = (s) => s.split('.').reduce((a, b) => a * 256 + Number(b), 0)
function ip6(s) {
  let [head, tail] = s.includes('::') ? s.split('::') : [s, null]
  const h = head ? head.split(':') : []
  const t = tail === null ? [] : tail ? tail.split(':') : []
  const parts = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return parts.reduce((a, p) => (a << 16n) + BigInt(parseInt(p || '0', 16)), 0n)
}
for (const line of csv.split('\n')) {
  if (!line) continue
  const [a, b, cc] = line.trim().split(',')
  if (a.includes(':')) v6.push([ip6(a), ip6(b), idx(cc)])
  else v4.push([ip4(a), ip4(b), idx(cc)])
}
if (codes.length > 255) throw new Error('trop de pays')

/** Débuts de plages : fusionne les plages voisines du même pays, comble les trous avec « inconnu ». */
function starts(list, one, zero) {
  list.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
  const out = []
  let end = zero - one
  for (const [a, b, c] of list) {
    if (a > end + one && (!out.length || out[out.length - 1][1] !== 0)) out.push([end + one, 0])
    if (!out.length || out[out.length - 1][1] !== c) out.push([a, c])
    end = b
  }
  return out
}
const s4 = starts(v4, 1, 0)
// IPv6 : préfixes /48 (assez fins pour un pays, et un nombre entier exact en JavaScript) ;
// deux débuts dans le même /48 → le dernier gagne
const s6raw = starts(v6, 1n, 0n).map(([a, c]) => [Number(a >> 80n), c])
const s6 = []
for (const e of s6raw) {
  if (s6.length && s6[s6.length - 1][0] === e[0]) s6[s6.length - 1] = e
  else if (!s6.length || s6[s6.length - 1][1] !== e[1]) s6.push(e)
}

const chunks = []
const u8 = (n) => chunks.push(Buffer.from([n]))
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  chunks.push(b)
}
chunks.push(Buffer.from('CDIP', 'ascii'))
u8(1)
u8(codes.length)
chunks.push(Buffer.from(codes.join(''), 'ascii'))
/** Débuts croissants en écarts varint (nombres entiers < 2^53), puis l'index du pays de chacun. */
function section(list) {
  u32(list.length)
  const bytes = []
  let prev = 0
  for (const [a] of list) {
    let d = a - prev
    prev = a
    while (d >= 0x80) {
      bytes.push((d % 0x80) | 0x80)
      d = Math.floor(d / 0x80)
    }
    bytes.push(d)
  }
  chunks.push(Buffer.from(bytes), Buffer.from(list.map((e) => e[1])))
}
section(s4)
section(s6)
const raw = Buffer.concat(chunks)
const packed = zlib.brotliCompressSync(raw, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length }
})
fs.mkdirSync(path.join(root, 'build/geo'), { recursive: true })
fs.writeFileSync(path.join(root, 'build/geo/ip-country.bin'), packed)
const month = /(\d{4}-\d{2})/.exec(path.basename(csvPath))?.[1] ?? '?'
console.log(`ip-country.bin : ${s4.length} plages IPv4, ${s6.length} plages IPv6, ${codes.length - 1} pays, ${raw.length} → ${packed.length} octets (DB-IP ${month})`)

// ---------- 2. Points des pays (Natural Earth, LABEL_Y / LABEL_X) ----------

const countries = JSON.parse(fs.readFileSync(countriesPath, 'utf8'))
const centroids = new Map()
for (const f of countries.features) {
  const p = f.properties
  const cc = p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : p.ISO_A2
  if (!/^[A-Z]{2}$/.test(cc)) continue
  // un même code pour plusieurs entités (territoires) : on garde la plus peuplée
  const prev = centroids.get(cc)
  if (prev && prev.pop >= (p.POP_EST ?? 0)) continue
  centroids.set(cc, { lat: p.LABEL_Y, lon: p.LABEL_X, pop: p.POP_EST ?? 0 })
}
// Territoires absents de l'échelle 1:50m de Natural Earth : coordonnées géographiques du
// CIA World Factbook (domaine public), arrondies au dixième de degré.
const EXTRA = {
  AQ: [-75, 0], BV: [-54.4, 3.4], BQ: [12.2, -68.3], CC: [-12.1, 96.8], CX: [-10.5, 105.6], GF: [4, -53], GI: [36.1, -5.4],
  GP: [16.3, -61.6], MQ: [14.7, -61], RE: [-21.1, 55.6], YT: [-12.8, 45.2], TK: [-9, -172], SJ: [78, 20], UM: [19.3, 166.6],
  GS: [-54.5, -37], HM: [-53.1, 72.5], IO: [-6, 71.5], TF: [-49.3, 69.2], TV: [-8, 178], SX: [18, -63.1], BL: [17.9, -62.8],
  MF: [18.1, -63], CW: [12.2, -69], AW: [12.5, -69.97], MV: [3.2, 73], MT: [35.9, 14.4], SG: [1.35, 103.8], BH: [26, 50.55],
  MC: [43.73, 7.42], SM: [43.94, 12.46], VA: [41.9, 12.45], LI: [47.16, 9.55], AD: [42.5, 1.5], NR: [-0.53, 166.92], PW: [7.5, 134.5],
  MH: [7.1, 171.2], KI: [1.4, 173], FM: [6.9, 158.2], WS: [-13.8, -172.1], TO: [-21.2, -175.2], NU: [-19.05, -169.87], CK: [-21.2, -159.8],
  PN: [-25.07, -130.1], WF: [-13.3, -176.2], NF: [-29.03, 167.95], GU: [13.44, 144.79], MP: [15.2, 145.75], AS: [-14.3, -170.7],
  KY: [19.5, -80.5], TC: [21.75, -71.58], VG: [18.5, -64.5], VI: [18.34, -64.93], AI: [18.25, -63.17], MS: [16.75, -62.2],
  KN: [17.33, -62.75], AG: [17.05, -61.8], DM: [15.42, -61.33], LC: [13.88, -60.97], VC: [13.25, -61.2], GD: [12.12, -61.67],
  BB: [13.17, -59.53], BM: [32.33, -64.75], PM: [46.83, -56.33], FO: [62, -7], GG: [49.47, -2.58], JE: [49.25, -2.17], IM: [54.25, -4.5],
  AX: [60.12, 19.9], SH: [-15.95, -5.7], ST: [1, 7], CV: [16, -24], KM: [-12.17, 44.25], SC: [-4.58, 55.67], MU: [-20.28, 57.55],
  HK: [22.25, 114.17], MO: [22.17, 113.55], BN: [4.5, 114.67], TL: [-8.83, 125.92], PF: [-15, -140], NC: [-21.5, 165.5], FK: [-51.75, -59],
  GL: [72, -40], EH: [24.5, -13], PS: [31.9, 35.2], XK: [42.6, 20.9], PR: [18.25, -66.5]
}
for (const [cc, [lat, lon]] of Object.entries(EXTRA)) if (!centroids.has(cc)) centroids.set(cc, { lat, lon, pop: 0 })
const missing = codes.slice(1).filter((cc) => !centroids.has(cc))
if (missing.length) console.warn('pays sans point :', missing.join(' '))
const r2 = (n) => Math.round(n * 100) / 100
const lines = [...centroids.entries()]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([cc, c]) => `${cc}:[${r2(c.lat)},${r2(c.lon)}]`)
const rows = []
for (let i = 0; i < lines.length; i += 8) rows.push('  ' + lines.slice(i, i + 8).join(','))
fs.writeFileSync(
  path.join(root, 'src/shared/geoCentroids.ts'),
  `// Fichier généré par scripts/make-geo.mjs : ne pas modifier à la main.
// Point « étiquette » de chaque pays [latitude, longitude] en degrés : Natural Earth 1:50m
// (domaine public, LABEL_Y / LABEL_X), complété pour les petits territoires par les
// coordonnées du CIA World Factbook (domaine public).
export const CENTROIDS: Record<string, [number, number]> = {
${rows.join(',\n')}
}
`
)
console.log(`geoCentroids.ts : ${centroids.size} pays`)

// ---------- 3. Masque des terres 0,5° ----------

const land = JSON.parse(fs.readFileSync(landPath, 'utf8'))
const W = 720
const H = 360
const rings = []
for (const f of land.features) {
  const g = f.geometry
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  for (const poly of polys) for (const ring of poly) rings.push(ring)
}
const mask = new Uint8Array(W * H)
for (let row = 0; row < H; row++) {
  const lat = 90 - (row + 0.5) * (180 / H)
  const xs = []
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i]
      const [x2, y2] = ring[j]
      if (y1 > lat !== y2 > lat) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1))
    }
  xs.sort((a, b) => a - b)
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const c0 = Math.max(0, Math.ceil((xs[k] + 180) / (360 / W) - 0.5))
    const c1 = Math.min(W - 1, Math.floor((xs[k + 1] + 180) / (360 / W) - 0.5))
    for (let c = c0; c <= c1; c++) mask[row * W + c] ^= 1
  }
}
// Longueurs de plages alternées (mer, terre, mer…) par ligne, en varint, puis base64.
const rle = []
const push = (n) => {
  while (n >= 0x80) {
    rle.push((n & 0x7f) | 0x80)
    n >>= 7
  }
  rle.push(n)
}
let landCells = 0
for (let row = 0; row < H; row++) {
  let cur = 0
  let run = 0
  for (let c = 0; c < W; c++) {
    const v = mask[row * W + c]
    landCells += v
    if (v === cur) run++
    else {
      push(run)
      cur = v
      run = 1
    }
  }
  push(run)
}
const b64 = Buffer.from(rle).toString('base64')
const b64Lines = b64.match(/.{1,120}/g).map((l) => `  '${l}'`)
fs.writeFileSync(
  path.join(root, 'src/renderer/src/fx/landMask.ts'),
  `// Fichier généré par scripts/make-geo.mjs : ne pas modifier à la main.
// Masque des terres émergées, cases de 0,5° (720 colonnes de -180° à 180°, 360 lignes de 90° à -90°),
// tiré de Natural Earth 1:50m « Land » (domaine public). Chaque ligne : longueurs de plages
// alternées en varint, en commençant par la mer (la première peut valoir 0) ; leur somme vaut 720.
export const LAND_W = ${W}
export const LAND_H = ${H}
export const LAND_RLE =
${b64Lines.join(' +\n')}
`
)
console.log(`landMask.ts : ${rle.length} octets RLE, ${b64.length} en base64, ${((landCells / (W * H)) * 100).toFixed(1)} % de cases de terre`)
