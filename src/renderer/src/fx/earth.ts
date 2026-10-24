// Globe interactif des pairs (onglet Pairs) : vraie Terre en points (masque des terres de
// Natural Earth, voir landMask.ts), projection orthographique en canvas 2D, pairs placés
// à leur pays (table DB-IP hors ligne du moteur, voir main/geoip.ts).
//
//   - glisser : rotation, avec inertie au lâcher ; molette / pincement : zoom (borné) ;
//     double-clic : retour à la vue de départ ; clic sur un pair : le globe se tourne vers lui ;
//     clavier (le canevas prend le focus) : flèches, + / −, 0 ;
//   - rotation lente quand on ne touche à rien, en pause pendant le survol ou le glisser,
//     arrêtée après IDLE_STOP sans geste (et jamais en mouvement réduit) ;
//   - pairs : disque plein = source complète, anneau = pair ; taille selon le débit,
//     pulsation pendant un échange ; arcs depuis « vous » (pays de la langue du système) ;
//   - jour / nuit d'après l'heure UTC (ligne du terminateur discrète, côté nuit plus sombre).
//
// Coût : la boucle bridée de loop.ts (arrêt hors écran, fenêtre cachée, dialogue ouvert,
// onglet caché) ; 60 images/s seulement pendant un geste ou une animation, 30 pendant la
// rotation lente, 12 quand seuls des pairs pulsent, et aucune image (dessin figé) sinon.

import { glowSprite } from './glow'
import { LAND_H, LAND_RLE, LAND_W } from './landMask'
import { createLoop } from './loop'
import { canvasDpr, MONO_FONT, onReducedMotionChange, prefersReducedMotion } from './motion'
import { hashStr } from './random'

export interface EarthPeer {
  /** clé stable du pair (adresse) */
  key: string
  /** position en degrés (pays + petit écart, calculés par le moteur) */
  lat: number
  lon: number
  /** débit relatif 0..1 : taille du point */
  w: number
  /** source complète : disque plein ; sinon anneau */
  seed: boolean
  /** échange en cours (réception ou émission) : le point pulse */
  active: boolean
  /** on lui envoie plus qu'il ne nous envoie : particules de « vous » vers lui */
  up: boolean
}

export interface EarthOptions {
  /** survol d'un pair (sa clé) ou null quand le pointeur le quitte */
  onHover?: (key: string | null) => void
  /** bulle HTML placée par le globe près du pair survolé (variables --x / --y, data-side) */
  tooltip?: HTMLElement | null
  /** pays de l'utilisateur (langue / fuseau du système), ou null */
  home?: { lat: number; lon: number } | null
  /** libellé du repère « vous » (« YOU ») */
  homeLabel?: string
}

export interface Earth {
  setPeers(list: EarthPeer[]): void
  setHome(home: { lat: number; lon: number } | null, label?: string): void
  /** tourne le globe vers le pair (et zoome un peu) */
  focus(key: string): void
  /** vue de départ */
  reset(): void
  relayout(): void
  hold(on: boolean, reason?: string): void
  stop(): void
}

const DEG = Math.PI / 180
const ZOOM_MIN = 1
const ZOOM_MAX = 6
/** rotation lente : 3°/s (un tour en 2 min) */
const AUTO_SPEED = 3 * DEG
/** la rotation lente démarre 1,5 s après le dernier geste et s'arrête au bout de 2 min sans geste */
const AUTO_DELAY = 1500
const IDLE_STOP = 120_000
const LAT_MAX = 80 * DEG
/** nombre de points de la sphère (avant le masque des terres) selon le zoom : densité à l'écran à peu près constante */
const LEVELS: [number, number][] = [
  [0, 10_000],
  [1.9, 30_000],
  [3.4, 80_000],
  [4.8, 160_000]
]
/** arcs dessinés au plus (les pairs les plus rapides) et points par arc */
const MAX_ARCS = 28
const ARC_STEPS = 24

// ---------- Masque des terres (décodé une fois) ----------

let mask: Uint8Array | null = null
function landMask(): Uint8Array {
  if (mask) return mask
  const bin = atob(LAND_RLE)
  const m = new Uint8Array(LAND_W * LAND_H)
  let o = 0
  const varint = (): number => {
    let n = 0
    let mul = 1
    for (;;) {
      const b = bin.charCodeAt(o++)
      n += (b & 0x7f) * mul
      if (b < 0x80) return n
      mul *= 0x80
    }
  }
  for (let row = 0; row < LAND_H; row++) {
    let c = 0
    let v = 0
    while (c < LAND_W) {
      const n = varint()
      if (v) m.fill(1, row * LAND_W + c, row * LAND_W + Math.min(LAND_W, c + n))
      c += n
      v ^= 1
    }
  }
  mask = m
  return m
}

/** Points de terre d'une sphère de Fibonacci de n points : x, y, z (repère terrestre) par point. */
const dotCache = new Map<number, Float32Array>()
function landDots(n: number): Float32Array {
  const hit = dotCache.get(n)
  if (hit) return hit
  const m = landMask()
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2
    const r = Math.sqrt(1 - y * y)
    const th = golden * i
    const x = Math.cos(th) * r
    const z = Math.sin(th) * r
    const lat = Math.asin(y) / DEG
    const lon = Math.atan2(x, z) / DEG
    const row = Math.min(LAND_H - 1, Math.floor(((90 - lat) / 180) * LAND_H))
    const col = Math.min(LAND_W - 1, Math.floor(((lon + 180) / 360) * LAND_W))
    if (m[row * LAND_W + col]) out.push(x, y, z)
  }
  const arr = new Float32Array(out)
  dotCache.set(n, arr)
  return arr
}

/** Vecteur unitaire (repère terrestre) d'une latitude / longitude en radians. */
function vec(lat: number, lon: number): [number, number, number] {
  const c = Math.cos(lat)
  return [c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon)]
}

/** Direction du Soleil (repère terrestre) : déclinaison saisonnière, longitude d'après l'heure UTC. */
function sunVector(d: Date): [number, number, number] {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1)
  const day = (d.getTime() - start) / 86_400_000
  const decl = -23.44 * DEG * Math.cos(((2 * Math.PI) / 365) * (day + 10))
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60
  return vec(decl, (12 - hours) * 15 * DEG)
}

const wrap = (a: number): number => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const ease = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)

interface PeerState extends EarthPeer {
  x: number
  y: number
  z: number
  /** taille affichée (suit w en douceur) */
  ds: number
  /** apparition (ms) : fondu d'entrée */
  born: number
  ph: number
  /** arc depuis « vous » : points 3D (x, y, z) ×(ARC_STEPS + 1), ou null */
  arc: Float32Array | null
}

export function createEarth(canvas: HTMLCanvasElement, options: EarthOptions = {}): Earth {
  const ctx = canvas.getContext('2d')!
  let tooltip = options.tooltip ?? null
  let home: [number, number, number] | null = null
  let homeLL: { lat: number; lon: number } | null = null
  let homeLabel = options.homeLabel ?? ''

  // vue : longitude / latitude du centre (radians), zoom
  let vLon = 10 * DEG
  let vLat = 22 * DEG
  let zoom = 1
  let zoomTarget = 1
  const startView = (): { lon: number; lat: number } =>
    homeLL ? { lon: homeLL.lon * DEG, lat: clamp(homeLL.lat * DEG * 0.5, -LAT_MAX, LAT_MAX) } : { lon: 10 * DEG, lat: 22 * DEG }

  let W = 0
  let H = 0
  let R0 = 0
  let cx = 0
  let cy = 0

  let peers: PeerState[] = []
  const known = new Map<string, PeerState>()

  // gestes
  const pointers = new Map<number, { x: number; y: number }>()
  let downAt: { x: number; y: number; t: number } | null = null
  let dragging = false
  let pinch: { d: number; zoom: number } | null = null
  let velLon = 0
  let velLat = 0
  let lastMove = 0
  let hovering = false
  let lastInteract = performance.now() - AUTO_DELAY
  let autoSpeed = 0
  let tween: { from: [number, number, number]; to: [number, number, number]; t0: number; dur: number } | null = null
  let hoverKey: string | null = null
  let selKey: string | null = null

  // dernière image : positions écran des pairs visibles (survol)
  let hitX = new Float32Array(0)
  let hitY = new Float32Array(0)
  let hitR = new Float32Array(0)
  let hitOn = new Uint8Array(0)

  let sun = sunVector(new Date())
  let sunAt = performance.now()
  let lastFrame = 0
  let fps = 30
  const bg = document.createElement('canvas')
  const bctx = bg.getContext('2d')!
  let bgKey = ''

  const reduced = (): boolean => prefersReducedMotion()

  function resize(): void {
    const box = canvas.getBoundingClientRect()
    const dpr = canvasDpr()
    W = box.width
    H = box.height
    canvas.width = Math.max(1, Math.round(W * dpr))
    canvas.height = Math.max(1, Math.round(H * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    bg.width = canvas.width
    bg.height = canvas.height
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    bgKey = ''
    R0 = Math.min(Math.min(W, H) * 0.41, W * 0.31)
    cx = W / 2
    cy = H * 0.52
  }

  function buildArc(p: PeerState): void {
    p.arc = null
    if (!home) return
    const [ax, ay, az] = home
    const dot = clamp(ax * p.x + ay * p.y + az * p.z, -1, 1)
    const om = Math.acos(dot)
    if (om < 0.03) return
    const so = Math.sin(om)
    const h = Math.min(0.32, 0.04 + om * 0.11)
    const arr = new Float32Array((ARC_STEPS + 1) * 3)
    for (let k = 0; k <= ARC_STEPS; k++) {
      const u = k / ARC_STEPS
      const a = Math.sin((1 - u) * om) / so
      const b = Math.sin(u * om) / so
      const lift = 1 + h * Math.sin(Math.PI * u)
      arr[k * 3] = (a * ax + b * p.x) * lift
      arr[k * 3 + 1] = (a * ay + b * p.y) * lift
      arr[k * 3 + 2] = (a * az + b * p.z) * lift
    }
    p.arc = arr
  }

  // ---------- Dessin ----------

  function draw(now: number, still: boolean): void {
    const dt = lastFrame && !still ? Math.min(250, now - lastFrame) : 0
    lastFrame = still ? lastFrame : now
    step(now, dt)
    if (!W || !H) return
    const animate = !still && !reduced()
    const R = R0 * zoom
    const cl = Math.cos(vLon)
    const sl = Math.sin(vLon)
    const cp = Math.cos(vLat)
    const sp = Math.sin(vLat)
    // repère terrestre → écran : x1 = X cos λ0 − Z sin λ0 ; z1 = X sin λ0 + Z cos λ0 ;
    // y2 = Y cos φ0 − z1 sin φ0 ; z2 = Y sin φ0 + z1 cos φ0 (z2 > 0 : face visible)
    let px = 0
    let py = 0
    let pz = 0
    const project = (x: number, y: number, z: number): void => {
      const z1 = x * sl + z * cl
      px = cx + (x * cl - z * sl) * R
      py = cy - (y * cp - z1 * sp) * R
      pz = y * sp + z1 * cp
    }
    if (now - sunAt > 60_000) {
      sun = sunVector(new Date())
      sunAt = now
    }
    const [sx, sy, sz] = sun

    // fond fixe (halo, disque, graticule, terminateur, terres, bord) : redessiné seulement quand
    // la vue change ; sinon (pulsations seules) une simple copie de l'image en cache
    const key = `${vLon}|${vLat}|${zoom}|${W}|${H}|${sunAt}`
    if (key !== bgKey) {
      bgKey = key
      const g = bctx
      g.clearRect(0, 0, W, H)

      // halo de l'atmosphère, puis disque sombre (cache la grille du fond), puis côté jour
      const halo = g.createRadialGradient(cx, cy, R * 0.97, cx, cy, R * 1.2)
      halo.addColorStop(0, 'rgba(255,255,255,0.11)')
      halo.addColorStop(0.3, 'rgba(255,255,255,0.04)')
      halo.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = halo
      g.beginPath()
      g.arc(cx, cy, R * 1.2, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = 'rgba(6,6,6,0.92)'
      g.beginPath()
      g.arc(cx, cy, R, 0, Math.PI * 2)
      g.fill()
      project(sx, sy, sz)
      const lx = cx + (px - cx) * 0.55
      const ly = cy + (py - cy) * 0.55
      const lit = g.createRadialGradient(lx, ly, 0, lx, ly, R * 1.5)
      lit.addColorStop(0, `rgba(255,255,255,${(0.035 + 0.035 * Math.max(0, pz)).toFixed(3)})`)
      lit.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = lit
      g.beginPath()
      g.arc(cx, cy, R, 0, Math.PI * 2)
      g.fill()

      // cadran extérieur (s'efface quand on zoome)
      const ringA = clamp(1 - (zoom - 1) * 3, 0, 1)
      if (ringA > 0) {
        g.lineWidth = 1
        g.strokeStyle = `rgba(255,255,255,${(0.07 * ringA).toFixed(3)})`
        g.setLineDash([2, 4])
        g.beginPath()
        g.arc(cx, cy, R * 1.26, 0, Math.PI * 2)
        g.stroke()
        g.setLineDash([])
        g.strokeStyle = `rgba(255,255,255,${(0.14 * ringA).toFixed(3)})`
        g.beginPath()
        // graduations tous les 5°, majeures tous les 30°, qui tournent avec la longitude
        for (let k = 0; k < 72; k++) {
          const a = (k / 72) * Math.PI * 2 - vLon
          const l = k % 6 === 0 ? 5 : 2
          g.moveTo(cx + Math.cos(a) * R * 1.4, cy + Math.sin(a) * R * 1.4)
          g.lineTo(cx + Math.cos(a) * (R * 1.4 + l), cy + Math.sin(a) * (R * 1.4 + l))
        }
        g.stroke()
      }

      // graticule : méridiens et parallèles tous les 30° (15° de près), face visible seulement
      const gStep = zoom > 2.6 ? 15 : 30
      g.lineWidth = 1
      const line = (pts: (k: number) => [number, number, number], n: number): void => {
        let open = false
        for (let k = 0; k <= n; k++) {
          const [x, y, z] = pts(k)
          project(x, y, z)
          if (pz > 0) {
            if (open) g.lineTo(px, py)
            else g.moveTo(px, py)
            open = true
          } else open = false
        }
      }
      g.strokeStyle = 'rgba(255,255,255,0.06)'
      g.beginPath()
      for (let lon = -180; lon < 180; lon += gStep) line((k) => vec((-90 + k * 3) * DEG, lon * DEG), 60)
      for (let lat = -90 + gStep; lat < 90; lat += gStep) if (lat !== 0) line((k) => vec(lat * DEG, (k * 3 - 180) * DEG), 120)
      g.stroke()
      g.strokeStyle = 'rgba(255,255,255,0.12)'
      g.beginPath()
      line((k) => vec(0, (k * 3 - 180) * DEG), 120)
      g.stroke()

      // terminateur (limite jour / nuit) : grand cercle perpendiculaire au Soleil, en tirets
      {
        let ux = -sz
        let uy = 0
        let uz = sx
        const ul = Math.hypot(ux, uy, uz) || 1
        ux /= ul
        uz /= ul
        const vx = sy * uz - sz * uy
        const vy = sz * ux - sx * uz
        const vz = sx * uy - sy * ux
        g.strokeStyle = 'rgba(255,255,255,0.13)'
        g.setLineDash([3, 5])
        g.beginPath()
        line((k) => {
          const a = (k / 90) * Math.PI * 2
          const c = Math.cos(a)
          const s = Math.sin(a)
          return [c * ux + s * vx, c * uy + s * vy, c * uz + s * vz]
        }, 90)
        g.stroke()
        g.setLineDash([])
      }

      // terres en points : 8 niveaux de gris (8 changements de couleur par image)
      let level = LEVELS[0][1]
      for (const [z0, n] of LEVELS) if (zoom >= z0) level = n
      const dots = landDots(level)
      const size = clamp(1.15 + (zoom - 1) * 0.12, 1.15, 1.8)
      const backs = zoom < 1.3
      const B = 8
      for (const b of buckets) b.length = 0
      const pad = 4
      for (let i = 0; i < dots.length; i += 3) {
        const x = dots[i]
        const y = dots[i + 1]
        const z = dots[i + 2]
        const z1 = x * sl + z * cl
        const z2 = y * sp + z1 * cp
        if (z2 <= 0 && !backs) continue
        const X = cx + (x * cl - z * sl) * R
        const Y = cy - (y * cp - z1 * sp) * R
        if (X < -pad || X > W + pad || Y < -pad || Y > H + pad) continue
        if (z2 <= 0) {
          buckets[0].push(X, Y)
          continue
        }
        // jour / nuit : produit scalaire avec le Soleil, transition douce de ±7°
        const s = x * sx + y * sy + z * sz
        const day = clamp((s + 0.12) / 0.24, 0, 1)
        const a = (0.2 + 0.8 * Math.pow(z2, 0.8)) * (0.45 + 0.55 * day)
        buckets[1 + Math.min(B - 2, Math.floor(a * (B - 1)))].push(X, Y)
      }
      for (let k = 0; k < B; k++) {
        const arr = buckets[k]
        if (!arr.length) continue
        const s = k === 0 ? 0.9 : size
        g.fillStyle = k === 0 ? 'rgba(255,255,255,0.05)' : `rgba(255,255,255,${(0.12 + (k / (B - 1)) * 0.78).toFixed(3)})`
        for (let j = 0; j < arr.length; j += 2) g.fillRect(arr[j] - s / 2, arr[j + 1] - s / 2, s, s)
      }

      // bord du disque
      g.strokeStyle = 'rgba(255,255,255,0.2)'
      g.lineWidth = 1
      g.beginPath()
      g.arc(cx, cy, R, 0, Math.PI * 2)
      g.stroke()
    }
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(bg, 0, 0, W, H)
    ctx.lineWidth = 1

    // arcs depuis « vous » vers les pairs en échange (les plus rapides), particule dans le sens du transfert
    const t = now / 1000
    const arcPeers = peers.filter((p) => p.arc && p.active).sort((a, b) => b.w - a.w).slice(0, MAX_ARCS)
    for (const p of arcPeers) {
      const arc = p.arc!
      const alpha = (0.1 + 0.32 * Math.sqrt(p.w)) * clamp((now - p.born) / 500, 0, 1)
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`
      ctx.beginPath()
      let open = false
      for (let k = 0; k <= ARC_STEPS; k++) {
        project(arc[k * 3], arc[k * 3 + 1], arc[k * 3 + 2])
        // caché derrière la sphère : face arrière ET dans le disque
        const shown = pz > 0 || Math.hypot(px - cx, py - cy) > R
        if (shown) {
          if (open) ctx.lineTo(px, py)
          else ctx.moveTo(px, py)
          open = true
        } else open = false
      }
      ctx.stroke()
      // particule : de lui vers vous (réception), de vous vers lui (émission)
      let u = animate ? (t * (0.35 + 0.4 * p.w) + p.ph) % 1 : 0.5
      if (!p.up) u = 1 - u
      const fk = u * ARC_STEPS
      const k0 = Math.floor(fk)
      const k1 = Math.min(ARC_STEPS, k0 + 1)
      const f = fk - k0
      project(
        arc[k0 * 3] + (arc[k1 * 3] - arc[k0 * 3]) * f,
        arc[k0 * 3 + 1] + (arc[k1 * 3 + 1] - arc[k0 * 3 + 1]) * f,
        arc[k0 * 3 + 2] + (arc[k1 * 3 + 2] - arc[k0 * 3 + 2]) * f
      )
      if (pz > 0 || Math.hypot(px - cx, py - cy) > R) {
        ctx.fillStyle = p.up ? 'rgba(170,170,170,0.9)' : 'rgba(255,255,255,0.95)'
        ctx.fillRect(px - 1, py - 1, 2, 2)
      }
    }

    // « vous »
    if (home) {
      project(home[0], home[1], home[2])
      if (pz > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(px, py - 5)
        ctx.lineTo(px + 5, py)
        ctx.lineTo(px, py + 5)
        ctx.lineTo(px - 5, py)
        ctx.closePath()
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.fillRect(px - 1, py - 1, 2, 2)
        if (homeLabel) {
          ctx.font = `500 9px ${MONO_FONT}`
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = 'rgba(255,255,255,0.7)'
          ctx.fillText(homeLabel.toUpperCase(), px + 9, py)
        }
      }
    }

    // pairs
    if (hitX.length < peers.length) {
      hitX = new Float32Array(peers.length)
      hitY = new Float32Array(peers.length)
      hitR = new Float32Array(peers.length)
      hitOn = new Uint8Array(peers.length)
    }
    const glow = glowSprite()
    const grow = Math.min(1.6, Math.pow(zoom, 0.3))
    let tipShown = false
    peers.forEach((p, i) => {
      project(p.x, p.y, p.z)
      hitOn[i] = 0
      const fade = clamp((now - p.born) / 400, 0, 1)
      if (pz <= 0) {
        if (zoom < 1.3) {
          ctx.fillStyle = `rgba(255,255,255,${(0.14 * fade).toFixed(3)})`
          ctx.fillRect(px - 1, py - 1, 2, 2)
        }
        return
      }
      if (px < -20 || px > W + 20 || py < -20 || py > H + 20) return
      const r = (1.5 + 2.7 * Math.sqrt(p.ds)) * grow
      const a = fade * (0.5 + 0.5 * Math.min(1, pz * 1.6))
      hitX[i] = px
      hitY[i] = py
      hitR[i] = r
      hitOn[i] = 1
      if (p.active && p.ds > 0.35) {
        const s = 8 + r * 3
        ctx.globalAlpha = 0.2 * a
        ctx.drawImage(glow, px - s / 2, py - s / 2, s, s)
        ctx.globalAlpha = 1
      }
      if (p.active) {
        // pulsation : anneau qui s'élargit et s'efface (figé en mouvement réduit)
        const u = animate ? (t / 1.7 + p.ph) % 1 : 0.35
        ctx.strokeStyle = `rgba(255,255,255,${((1 - u) * 0.5 * a).toFixed(3)})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(px, py, r + 1 + u * 11, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      if (p.seed) {
        ctx.fillStyle = `rgba(255,255,255,${(0.92 * a).toFixed(3)})`
        ctx.fill()
      } else {
        ctx.fillStyle = 'rgba(8,8,8,0.9)'
        ctx.fill()
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
        ctx.stroke()
      }
      if (p.key === hoverKey || p.key === selKey) {
        // réticule du pair survolé ou choisi
        const rr = r + 5
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(px, py, rr, 0, Math.PI * 2)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.moveTo(px + dx * (rr + 2), py + dy * (rr + 2))
          ctx.lineTo(px + dx * (rr + 6), py + dy * (rr + 6))
        }
        ctx.stroke()
      }
      if (p.key === hoverKey) {
        tipShown = true
        placeTip(px, py, r)
      }
    })
    // pair survolé passé derrière la sphère (inertie, nouvelle liste) : la bulle se ferme
    if (hoverKey && !tipShown) setHover(null)
  }
  const buckets: number[][] = Array.from({ length: 8 }, () => [])

  // ---------- Mouvement ----------

  function step(now: number, dt: number): void {
    if (reduced()) {
      zoom = zoomTarget
      autoSpeed = 0
      velLon = velLat = 0
      if (tween) {
        ;[vLon, vLat, zoom] = tween.to
        zoomTarget = zoom
        tween = null
      }
      return
    }
    if (!dt) return
    const s = dt / 1000
    if (tween) {
      const u = clamp((now - tween.t0) / tween.dur, 0, 1)
      const e = ease(u)
      vLon = tween.from[0] + wrap(tween.to[0] - tween.from[0]) * e
      vLat = tween.from[1] + (tween.to[1] - tween.from[1]) * e
      zoom = zoomTarget = tween.from[2] + (tween.to[2] - tween.from[2]) * e
      if (u >= 1) tween = null
    } else if (!dragging) {
      // inertie, puis rotation lente
      if (Math.abs(velLon) + Math.abs(velLat) > 1e-4) {
        vLon += velLon * s
        vLat = clamp(vLat + velLat * s, -LAT_MAX, LAT_MAX)
        const k = Math.exp(-dt / 420)
        velLon *= k
        velLat *= k
      } else velLon = velLat = 0
      const quiet = now - lastInteract
      const target = !hovering && peers.length > 0 && quiet > AUTO_DELAY && quiet < IDLE_STOP ? AUTO_SPEED : 0
      autoSpeed += (target - autoSpeed) * Math.min(1, dt / 900)
      if (autoSpeed < 1e-4) autoSpeed = target ? autoSpeed : 0
      vLon -= autoSpeed * s
      zoom += (zoomTarget - zoom) * Math.min(1, dt / 110)
      if (Math.abs(zoomTarget - zoom) < 1e-3) zoom = zoomTarget
    }
    vLon = wrap(vLon)
    for (const p of peers) p.ds += (p.w - p.ds) * Math.min(1, dt / 350)
  }

  /** Cadence voulue après cette image (0 : plus rien ne bouge, dessin figé). */
  function wantedFps(now: number): number {
    if (reduced()) return 0
    if (dragging || tween || pinch || Math.abs(velLon) + Math.abs(velLat) > 1e-4 || zoom !== zoomTarget) return 60
    if (autoSpeed > 0 || hovering || peers.some((p) => now - p.born < 500)) return 30
    const quiet = now - lastInteract
    if (peers.length > 0 && quiet > AUTO_DELAY && quiet < IDLE_STOP) return 30
    // vue immobile : le fond vient du cache, seules les pulsations et les tailles bougent
    if (peers.some((p) => p.active || Math.abs(p.ds - p.w) > 0.01)) return 12
    return 0
  }

  const loop = createLoop(canvas, 30, (now, _dt, still) => {
    draw(now, still)
    if (still) return
    const f = wantedFps(now)
    if (!f) loop.hold(true, 'idle')
    else if (f !== fps) {
      fps = f
      loop.setFps(f)
    }
  })

  /** Quelque chose a changé : la boucle repart (ou une image fixe en mouvement réduit). */
  function kick(interact = true): void {
    if (interact) lastInteract = performance.now()
    // boucle à l'arrêt : la prochaine image repart d'un écart nul (pas de saut)
    if (!loop.running) lastFrame = 0
    loop.hold(false, 'idle')
    if (!loop.running) loop.redraw()
  }

  /** Bulle à côté du point (à droite, ou à gauche près du bord droit), jamais coupée en haut ou en bas. */
  function placeTip(x: number, y: number, r: number): void {
    if (!tooltip) return
    const side = x > W * 0.58 ? 'l' : 'r'
    tooltip.style.setProperty('--x', `${Math.round(x + (side === 'r' ? r + 14 : -r - 14))}px`)
    tooltip.style.setProperty('--y', `${Math.round(clamp(y, 64, H - 64))}px`)
    if (tooltip.dataset.side !== side) tooltip.dataset.side = side
  }

  function setHover(key: string | null): void {
    if (key === hoverKey) return
    hoverKey = key
    if (tooltip && !key) tooltip.dataset.side = ''
    options.onHover?.(key)
  }

  function hitTest(x: number, y: number): string | null {
    const i = hitIndex(x, y)
    return i >= 0 ? peers[i].key : null
  }

  function hitIndex(x: number, y: number): number {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < peers.length; i++) {
      if (!hitOn[i]) continue
      const d = Math.hypot(hitX[i] - x, hitY[i] - y)
      if (d <= Math.max(9, hitR[i] + 5) && d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  function animateTo(lon: number, lat: number, z: number, dur = 850): void {
    if (reduced()) {
      vLon = wrap(lon)
      vLat = clamp(lat, -LAT_MAX, LAT_MAX)
      zoom = zoomTarget = clamp(z, ZOOM_MIN, ZOOM_MAX)
    } else {
      tween = { from: [vLon, vLat, zoom], to: [lon, clamp(lat, -LAT_MAX, LAT_MAX), clamp(z, ZOOM_MIN, ZOOM_MAX)], t0: performance.now(), dur }
      velLon = velLat = 0
    }
    kick()
  }

  // ---------- Gestes ----------

  const local = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
    const b = canvas.getBoundingClientRect()
    return { x: e.clientX - b.left, y: e.clientY - b.top }
  }

  function onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const p = local(e)
    pointers.set(e.pointerId, p)
    canvas.setPointerCapture(e.pointerId)
    tween = null
    velLon = velLat = 0
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: zoomTarget }
      dragging = false
    } else {
      downAt = { x: p.x, y: p.y, t: performance.now() }
      dragging = false
    }
    kick()
  }

  function onMove(e: PointerEvent): void {
    const p = local(e)
    hovering = true
    const prev = pointers.get(e.pointerId)
    if (!prev) {
      // simple survol (la bulle est placée tout de suite, avant la prochaine image)
      const i = hitIndex(p.x, p.y)
      const key = i >= 0 ? peers[i].key : null
      if (key !== hoverKey) {
        if (i >= 0) placeTip(hitX[i], hitY[i], hitR[i])
        setHover(key)
        kick()
      } else if (!loop.running) kick()
      canvas.style.cursor = key ? 'pointer' : 'grab'
      return
    }
    pointers.set(e.pointerId, p)
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()]
      zoomTarget = clamp((pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, ZOOM_MIN, ZOOM_MAX)
      kick()
      return
    }
    if (!downAt) return
    if (!dragging && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 3) {
      dragging = true
      setHover(null)
      canvas.style.cursor = 'grabbing'
    }
    if (!dragging) return
    const R = R0 * zoom || 1
    const dLon = -(p.x - prev.x) / R
    const dLat = (p.y - prev.y) / R
    vLon = wrap(vLon + dLon)
    vLat = clamp(vLat + dLat, -LAT_MAX, LAT_MAX)
    const now = performance.now()
    const dtm = Math.max(8, now - (lastMove || now - 16))
    lastMove = now
    // vitesse lissée (rad/s) pour l'inertie
    velLon = velLon * 0.6 + ((dLon * 1000) / dtm) * 0.4
    velLat = velLat * 0.6 + ((dLat * 1000) / dtm) * 0.4
    kick()
  }

  function onUp(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return
    pointers.delete(e.pointerId)
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    if (pinch) {
      if (pointers.size < 2) pinch = null
      downAt = null
      kick()
      return
    }
    const p = local(e)
    if (!dragging && downAt && e.type === 'pointerup') {
      // clic : tourner vers le pair touché, ou désélectionner
      const key = hitTest(p.x, p.y)
      if (key) {
        selKey = key
        const peer = peers.find((q) => q.key === key)
        if (peer) animateTo(peer.lon * DEG, peer.lat * DEG, Math.max(zoomTarget, 2))
      } else selKey = null
    }
    if (dragging && performance.now() - lastMove > 90) velLon = velLat = 0
    // élan borné : un lancer rapide fait au plus un demi-tour, sans basculer vers un pôle
    velLon = clamp(velLon, -3, 3)
    velLat = clamp(velLat, -1.2, 1.2)
    if (reduced()) velLon = velLat = 0
    dragging = false
    downAt = null
    lastMove = 0
    canvas.style.cursor = 'grab'
    kick()
  }

  function onLeave(): void {
    hovering = false
    if (!pointers.size) setHover(null)
    kick()
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    // pincement du pavé tactile : ctrlKey + petits deltaY
    const k = e.ctrlKey ? 0.012 : 0.0016
    const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY
    zoomTarget = clamp(zoomTarget * Math.exp(-dy * k), ZOOM_MIN, ZOOM_MAX)
    tween = null
    kick()
  }

  function onDbl(e: MouseEvent): void {
    e.preventDefault()
    selKey = null
    const v = startView()
    animateTo(v.lon, v.lat, 1, 900)
  }

  function onKey(e: KeyboardEvent): void {
    const stepA = (12 * DEG) / zoom
    let handled = true
    if (e.key === 'ArrowLeft') animateTo(vLon - stepA, vLat, zoomTarget, 300)
    else if (e.key === 'ArrowRight') animateTo(vLon + stepA, vLat, zoomTarget, 300)
    else if (e.key === 'ArrowUp') animateTo(vLon, vLat + stepA, zoomTarget, 300)
    else if (e.key === 'ArrowDown') animateTo(vLon, vLat - stepA, zoomTarget, 300)
    else if (e.key === '+' || e.key === '=') animateTo(vLon, vLat, zoomTarget * 1.4, 300)
    else if (e.key === '-' || e.key === '_') animateTo(vLon, vLat, zoomTarget / 1.4, 300)
    else if (e.key === '0' || e.key === 'Home') {
      selKey = null
      const v = startView()
      animateTo(v.lon, v.lat, 1, 700)
    } else handled = false
    if (handled) e.preventDefault()
  }

  canvas.style.cursor = 'grab'
  canvas.style.touchAction = 'none'
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('dblclick', onDbl)
  canvas.addEventListener('keydown', onKey)
  const offReduced = onReducedMotionChange(() => kick(false))

  function setHomeInner(h: { lat: number; lon: number } | null): void {
    homeLL = h
    home = h ? vec(h.lat * DEG, h.lon * DEG) : null
    for (const p of peers) buildArc(p)
  }
  setHomeInner(options.home ?? null)
  {
    const v = startView()
    vLon = v.lon
    vLat = v.lat
  }

  resize()
  const ro = new ResizeObserver(() => {
    resize()
    loop.redraw()
  })
  ro.observe(canvas)

  return {
    setPeers(list) {
      const now = performance.now()
      const next: PeerState[] = []
      let changed = list.length !== peers.length
      for (const q of list) {
        let p = known.get(q.key)
        if (!p) {
          const [x, y, z] = vec(q.lat * DEG, q.lon * DEG)
          p = { ...q, x, y, z, ds: q.w, born: now, ph: (hashStr(q.key) % 1000) / 1000, arc: null }
          buildArc(p)
          changed = true
        } else {
          if (p.lat !== q.lat || p.lon !== q.lon) {
            ;[p.x, p.y, p.z] = vec(q.lat * DEG, q.lon * DEG)
            p.lat = q.lat
            p.lon = q.lon
            buildArc(p)
          }
          if (p.w !== q.w || p.seed !== q.seed || p.active !== q.active || p.up !== q.up) changed = true
          p.w = q.w
          p.seed = q.seed
          p.active = q.active
          p.up = q.up
        }
        next.push(p)
      }
      known.clear()
      for (const p of next) known.set(p.key, p)
      peers = next
      if (hoverKey && !known.has(hoverKey)) setHover(null)
      if (selKey && !known.has(selKey)) selKey = null
      if (changed) kick(false)
      else if (!loop.running) loop.redraw()
    },
    setHome(h, label) {
      if (label !== undefined) homeLabel = label
      setHomeInner(h)
      kick(false)
    },
    focus(key) {
      const p = known.get(key)
      if (!p) return
      selKey = key
      animateTo(p.lon * DEG, p.lat * DEG, Math.max(zoomTarget, 2))
    },
    reset() {
      selKey = null
      const v = startView()
      animateTo(v.lon, v.lat, 1, 900)
    },
    relayout() {
      resize()
      loop.redraw()
    },
    hold: loop.hold,
    stop() {
      loop.stop()
      ro.disconnect()
      offReduced()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('keydown', onKey)
    }
  }
}
