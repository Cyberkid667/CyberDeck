// Globe des pairs (onglet Pairs) et sphère du billet « Lecture du lien » (mode scan).
// Canvas 2D, 30 images/s au plus, ≈ 0,4 ms par image : points regroupés en
// 10 niveaux de gris (10 changements de couleur par image), halos en image
// pré-calculée, jamais de shadowBlur. Voir SPEC 5.8.
//
// Utilisation (React) : créer UNE fois au montage, puis à chaque instantané
// setPeers(...) et set('streamRate', ...) — ne jamais recréer le globe.
//   const g = createGlobe(canvas, { dots: 'auto', idleWhenEmpty: true })
//   g.setPeers(peers.map(p => ({ ...peerLatLon(p.address), w, seed: p.isSeeder, up })))
//   g.setCallouts([{ peer: 0, el: coA, label: 'A' }, …])
//   g.hold(tab !== 'peers', 'tab') ; g.stop() au démontage.
//
// Étiquettes A, B, C : la lettre reste attachée au pair (A = le plus rapide), mais la
// PLACE de l'étiquette (à gauche à 30 %, à droite à 24 % ou à 56 % de la hauteur) suit
// la position projetée du pair : le globe choisit les places qui donnent les traits de
// rappel les plus courts (des traits qui ne se croisent pas), et l'écrit dans
// l'attribut data-slot de l'étiquette (« l », « rt », « rb » ; voir torrents.css).
// Vérifié à chaque setCallouts puis une fois par seconde (la rotation est lente),
// avec une marge pour éviter les allers-retours.

import { glowSprite } from './glow'
import { createLoop } from './loop'
import { canvasDpr, MONO_FONT } from './motion'
import { rng } from './random'

export interface GlobePeer {
  /** latitude / longitude en degrés : peerLatLon(adresse), pas une géolocalisation */
  lat: number
  lon: number
  /** poids 0..1 : réception du pair / réception maximale des pairs */
  w: number
  /** source complète (isSeeder) : disque plein ; sinon anneau */
  seed: boolean
  /** pair qui ne fait que recevoir de nous (émission seule) : particules grises vers le pair */
  up: boolean
}

export interface GlobeCallout {
  /** index du pair dans la liste passée à setPeers */
  peer: number
  /**
   * étiquette HTML (.callout) ; sa ligne .k sert de point d'ancrage du trait de rappel.
   * Le globe y écrit data-slot (« l », « rt », « rb ») : la place de l'étiquette.
   */
  el: HTMLElement
  /** lettre « A », « B », « C » (dessinée dans le canevas si l'étiquette est masquée) */
  label: string
}

/** Places des étiquettes : à gauche (30 % de la hauteur), à droite en haut (24 %) et en bas (56 %). */
export type CalloutSlot = 'l' | 'rt' | 'rb'
const SLOT_TOP: Record<CalloutSlot, number> = { l: 0.3, rt: 0.24, rb: 0.56 }
/** Marge des étiquettes au bord de la plaque (left / right: 22px dans torrents.css). */
const CALLOUT_EDGE = 22
/** Écart entre le cercle lettré et le point d'ancrage, et longueur du coude du trait. */
const ANCHOR_GAP = 10
const ELBOW = 16
const SLOTS: CalloutSlot[] = ['l', 'rt', 'rb']
/** Les segments [x1, y1]–[x2, y2] et [x3, y3]–[x4, y4] se coupent (hors simple contact). */
function segmentsCross(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const side = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number => (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  return side(x3, y3, x4, y4, x1, y1) * side(x3, y3, x4, y4, x2, y2) < 0 && side(x1, y1, x2, y2, x3, y3) * side(x1, y1, x2, y2, x4, y4) < 0
}

/** Deux traits de rappel [x0, y0, x1, y1, x2, y2] (pair → coude → ancrage) se croisent. */
function linesCross(a: number[], b: number[]): boolean {
  for (let i = 0; i < 4; i += 2)
    for (let j = 0; j < 4; j += 2) if (segmentsCross(a[i], a[i + 1], a[i + 2], a[i + 3], b[j], b[j + 1], b[j + 2], b[j + 3])) return true
  return false
}

/** Toutes les façons de placer n étiquettes (n = 1 à 3) sur les 3 places. */
const SLOT_CHOICES: CalloutSlot[][][] = [[[]], [], [], []]
for (const a of SLOTS) {
  SLOT_CHOICES[1].push([a])
  for (const b of SLOTS) {
    if (b === a) continue
    SLOT_CHOICES[2].push([a, b])
    for (const c of SLOTS) if (c !== a && c !== b) SLOT_CHOICES[3].push([a, b, c])
  }
}

export interface GlobeSettings {
  tilt: number
  /** vitesse de rotation (rad/s) : un tour en 4 min par défaut */
  spin: number
  rot0: number
  /** rayon = min(min(W, H) × radius, W × rmaxW) */
  radius: number
  rmaxW: number
  /** centre en fraction de la largeur / hauteur */
  cx: number
  cy: number
  /** flux vertical (le motif du logo) */
  stream: boolean
  /** clamp(réception / 8 Mio/s, 0,15, 2,5) ; 0 = pas de tirets */
  streamRate: number
  /** liaisons + particules entre les pairs et le flux */
  flows: boolean
  /** cercles, cadran gradué, équateur et parallèles */
  rings: boolean
  /** ligne de lecture qui balaie la sphère (billet du dialogue d'ajout) */
  scan: boolean
}

export interface GlobeOptions extends Partial<GlobeSettings> {
  /** nombre de points de la sphère, ou 'auto' = clamp(round(W × H / 130), 700, 1300) */
  dots?: number | 'auto'
  peers?: GlobePeer[]
  callouts?: GlobeCallout[]
  /** points de poussière en fond */
  dust?: number
  fps?: number
  seed?: number
  /** temps de départ (s) : fixe l'angle de la première image */
  t0?: number
  /** false pour un globe affiché DANS un dialogue (ne se fige pas avec holdAll) */
  holdable?: boolean
  /** true : boucle arrêtée (une seule image) tant qu'il n'y a aucun pair ; repart dès qu'un pair arrive */
  idleWhenEmpty?: boolean
}

export interface Globe {
  set<K extends keyof GlobeSettings>(key: K, value: GlobeSettings[K]): void
  setPeers(list: GlobePeer[]): void
  setCallouts(list: GlobeCallout[]): void
  /** à appeler après un changement de taille ou de position des étiquettes */
  relayout(): void
  /** dessine l'image courante tout de suite */
  frame(): void
  hold(on: boolean, reason?: string): void
  stop(): void
}

interface PlacedPeer extends GlobePeer {
  x: number
  y: number
  z: number
  ph: number
}

const DEFAULTS: GlobeSettings = {
  tilt: 0.36,
  spin: (Math.PI * 2) / 240,
  rot0: 0,
  radius: 0.36,
  rmaxW: 0.3,
  cx: 0.5,
  cy: 0.53,
  stream: true,
  streamRate: 1,
  flows: true,
  rings: true,
  scan: false
}

export function createGlobe(canvas: HTMLCanvasElement, options: GlobeOptions = {}): Globe {
  const cfg: GlobeSettings = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS) as (keyof GlobeSettings)[])
    if (options[k] !== undefined) (cfg as unknown as Record<string, unknown>)[k] = options[k]
  const ctx = canvas.getContext('2d')!
  const r = rng(options.seed ?? 3)
  const fps = options.fps ?? 30

  // sphère de Fibonacci + densité « continents » (7 calottes gaussiennes)
  let N: number
  if (options.dots === 'auto') {
    const b = canvas.getBoundingClientRect()
    N = Math.round(Math.min(1300, Math.max(700, (b.width * b.height) / 130)))
  } else N = Math.max(50, Math.round(options.dots ?? 1300))
  const golden = Math.PI * (3 - Math.sqrt(5))
  const P = new Float32Array(N * 4)
  const blobs = Array.from({ length: 7 }, () => {
    const z = r() * 2 - 1
    const t = r() * Math.PI * 2
    const s = Math.sqrt(1 - z * z)
    return [Math.cos(t) * s, z, Math.sin(t) * s, 0.35 + r() * 0.45]
  })
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2
    const rad = Math.sqrt(1 - y * y)
    const th = golden * i
    let x = Math.cos(th) * rad + (r() - 0.5) * 0.035
    const yy = y + (r() - 0.5) * 0.035
    let z = Math.sin(th) * rad + (r() - 0.5) * 0.035
    const n = Math.hypot(x, yy, z)
    x /= n
    z /= n
    const y1 = yy / n
    let d = 0
    for (const b of blobs) {
      const dot = x * b[0] + y1 * b[1] + z * b[2]
      d += Math.exp((dot - 1) / (b[3] * b[3] * 0.25))
    }
    P[i * 4] = x
    P[i * 4 + 1] = y1
    P[i * 4 + 2] = z
    P[i * 4 + 3] = Math.min(1, 0.46 + d * 0.7)
  }

  let peers: PlacedPeer[] = []
  let callouts: GlobeCallout[] = options.callouts ?? []
  const place = (list: GlobePeer[]): PlacedPeer[] =>
    list.slice(0, 200).map((p) => {
      const la = (p.lat * Math.PI) / 180
      const lo = (p.lon * Math.PI) / 180
      return { ...p, x: Math.cos(la) * Math.sin(lo), y: Math.sin(la), z: Math.cos(la) * Math.cos(lo), ph: r() }
    })
  peers = place(options.peers ?? [])

  const dust = Array.from({ length: options.dust ?? 34 }, () => ({
    x: r(),
    y: r(),
    vx: (r() - 0.5) * 0.012,
    vy: (r() - 0.5) * 0.008,
    a: 0.06 + r() * 0.22,
    s: r() < 0.2 ? 1.5 : 1
  }))

  let W = 0
  let H = 0
  let R = 0
  let cx = 0
  let cy = 0
  let t = options.t0 ?? 0
  const anchors: ([number, number] | null)[] = []
  /** taille de la ligne .k de chaque étiquette (même ordre que callouts), relevée par measure() */
  const kSize: [number, number][] = []
  /** place de chaque étiquette (même ordre que callouts) */
  let slots: CalloutSlot[] = []
  /** heure (t) du dernier contrôle des places */
  let slotsCheckedAt = -1e9

  /** Côté du trait de rappel de l'étiquette i : vers la droite pour la place de gauche. */
  const leftSide = (i: number): boolean => (slots[i] ?? 'l') === 'l'

  function measure(): void {
    anchors.length = 0
    kSize.length = 0
    if (!callouts.length) return
    const box = canvas.getBoundingClientRect()
    callouts.forEach((c, i) => {
      if (!c.el.isConnected || getComputedStyle(c.el).display === 'none') {
        anchors.push(null)
        kSize.push([0, 0])
        return
      }
      const k = (c.el.querySelector('.k') as HTMLElement | null) ?? c.el
      const eb = k.getBoundingClientRect()
      kSize.push([eb.width, eb.height])
      if (!eb.width && !eb.height) {
        anchors.push(null)
        return
      }
      anchors.push([leftSide(i) ? eb.right - box.left + ANCHOR_GAP : eb.left - box.left - ANCHOR_GAP, eb.top - box.top + eb.height / 2])
    })
  }

  /**
   * Trait de rappel (pair → coude → point d'ancrage) qu'aurait l'étiquette i à la place
   * `slot`, d'après la taille de sa ligne .k : [x0, y0, x1, y1, x2, y2].
   */
  function lineFor(i: number, slot: CalloutSlot, px: number, py: number): number[] {
    const [w, h] = kSize[i] ?? [0, 0]
    const left = slot === 'l'
    const ax = left ? CALLOUT_EDGE + w + ANCHOR_GAP : W - CALLOUT_EDGE - w - ANCHOR_GAP
    const ay = SLOT_TOP[slot] * H + h / 2
    return [px, py, left ? ax + ELBOW : ax - ELBOW, ay, ax, ay]
  }

  /**
   * Places des étiquettes d'après la position projetée de leurs pairs : celles qui donnent
   * les traits de rappel les plus courts, sans croisement (un croisement coûte la largeur
   * de la plaque). Les places actuelles restent tant que le gain ne dépasse pas 0,2 R (un
   * pair qui passe le centre de plus de 0,1 R environ) : pas d'allers-retours. Renvoie
   * true si une place a changé (data-slot mis à jour : les points d'ancrage sont à remesurer).
   */
  function placeCallouts(pp: [number, number, number][]): boolean {
    const n = Math.min(3, callouts.length)
    if (!n || !W) return false
    const pts = callouts.slice(0, n).map((c) => pp[c.peer] ?? ([cx, cy, 0] as [number, number, number]))
    const cost = (choice: CalloutSlot[]): number => {
      const lines = choice.map((s, i) => lineFor(i, s, pts[i][0], pts[i][1]))
      let sum = 0
      for (const l of lines) sum += Math.hypot(l[2] - l[0], l[3] - l[1]) + Math.hypot(l[4] - l[2], l[5] - l[3])
      for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) if (linesCross(lines[a], lines[b])) sum += W
      return sum
    }
    let best = SLOT_CHOICES[n][0]
    let bestCost = Infinity
    for (const choice of SLOT_CHOICES[n]) {
      const c = cost(choice)
      if (c < bestCost) {
        bestCost = c
        best = choice
      }
    }
    const current = slots.length === n ? slots : null
    if (!current || (!current.every((s, i) => s === best[i]) && cost(current) - bestCost >= 0.2 * R)) slots = best.slice()
    // l'attribut suit toujours la place retenue (une étiquette recréée n'en a pas encore)
    let changed = false
    callouts.forEach((c, i) => {
      const s = slots[i]
      if (s && c.el.dataset.slot !== s) {
        c.el.dataset.slot = s
        changed = true
      }
    })
    return changed
  }

  /** Positions projetées des pairs (rotation de l'image courante). */
  const projectPeers = (): [number, number, number][] => {
    const rot = cfg.rot0 + t * cfg.spin
    return peers.map((p) => proj(p.x, p.y, p.z, rot))
  }
  function resize(): void {
    const box = canvas.getBoundingClientRect()
    const dpr = canvasDpr()
    W = box.width
    H = box.height
    canvas.width = Math.max(1, Math.round(W * dpr))
    canvas.height = Math.max(1, Math.round(H * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    R = Math.min(Math.min(W, H) * cfg.radius, W * cfg.rmaxW)
    cx = W * cfg.cx
    cy = H * cfg.cy
    measure()
    if (placeCallouts(projectPeers())) measure()
  }
  function proj(x: number, y: number, z: number, rot: number): [number, number, number] {
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const ct = Math.cos(cfg.tilt)
    const st = Math.sin(cfg.tilt)
    const x1 = x * cr + z * sr
    const z1 = -x * sr + z * cr
    return [cx + x1 * R, cy - (y * ct - z1 * st) * R, y * st + z1 * ct]
  }

  const BUCKETS = 10
  const bx: number[][] = Array.from({ length: BUCKETS }, () => [])
  function draw(): void {
    if (!W || !H) return
    ctx.clearRect(0, 0, W, H)
    const rot = cfg.rot0 + t * cfg.spin
    for (const d of dust) {
      ctx.fillStyle = `rgba(255,255,255,${d.a})`
      ctx.fillRect(d.x * W, d.y * H, d.s, d.s)
    }
    if (cfg.rings) {
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'
      ctx.setLineDash([2, 4])
      ctx.beginPath()
      ctx.arc(cx, cy, R * 1.24, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.strokeStyle = 'rgba(255,255,255,0.045)'
      ctx.beginPath()
      ctx.arc(cx, cy, R * 1.46, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'
      ctx.beginPath()
      for (let k = 0; k < 72; k++) {
        // cadran gradué tous les 5°, majeures tous les 30°
        const a = (k / 72) * Math.PI * 2
        const l = k % 6 === 0 ? 5 : 2
        ctx.moveTo(cx + Math.cos(a) * R * 1.46, cy + Math.sin(a) * R * 1.46)
        ctx.lineTo(cx + Math.cos(a) * (R * 1.46 + l), cy + Math.sin(a) * (R * 1.46 + l))
      }
      ctx.stroke()
      const ry = Math.abs(Math.sin(cfg.tilt))
      for (const la of [0, 0.62, -0.62]) {
        // équateur + 2 parallèles (moitié avant plus nette)
        const rr = R * Math.cos(la)
        const oy = -Math.sin(la) * R * Math.cos(cfg.tilt)
        ctx.strokeStyle = la === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)'
        ctx.beginPath()
        ctx.ellipse(cx, cy + oy, rr, rr * ry, 0, 0, Math.PI)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(255,255,255,0.03)'
        ctx.beginPath()
        ctx.ellipse(cx, cy + oy, rr, rr * ry, 0, Math.PI, Math.PI * 2)
        ctx.stroke()
      }
    }
    // points de la sphère, regroupés en 10 niveaux de gris
    for (const b of bx) b.length = 0
    const scanY = cfg.scan ? cy - R + ((t * 0.45) % 1.3) * 2 * R : -1e9
    for (let i = 0; i < N; i++) {
      const p = proj(P[i * 4], P[i * 4 + 1], P[i * 4 + 2], rot)
      const z = p[2]
      const w = P[i * 4 + 3]
      let a = z > 0 ? (0.16 + 0.8 * Math.pow(z, 1.15)) * w : 0.04 + 0.05 * (1 + z) * w
      if (cfg.scan && z > 0) {
        const dy = Math.abs(p[1] - scanY)
        if (dy < 10) a = Math.min(1, a + (1 - dy / 10) * 0.6)
      }
      bx[Math.max(0, Math.min(BUCKETS - 1, Math.floor(a * BUCKETS)))].push(p[0], p[1], z > 0 ? 1.25 : 0.85)
    }
    for (let k = 0; k < BUCKETS; k++) {
      const arr = bx[k]
      if (!arr.length) continue
      ctx.fillStyle = `rgba(255,255,255,${((k + 0.5) / BUCKETS).toFixed(3)})`
      for (let j = 0; j < arr.length; j += 3) ctx.fillRect(arr[j] - arr[j + 2] / 2, arr[j + 1] - arr[j + 2] / 2, arr[j + 2], arr[j + 2])
    }
    if (cfg.scan && scanY > cy - R && scanY < cy + R) {
      const half = Math.sqrt(Math.max(0, R * R - (scanY - cy) ** 2))
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.beginPath()
      ctx.moveTo(cx - half - 14, scanY)
      ctx.lineTo(cx + half + 14, scanY)
      ctx.stroke()
    }
    // flux vertical (le motif du logo) : tirets qui descendent à la vitesse de réception ; immobile sans pair
    if (cfg.stream) {
      const top = cy - R * 1.62
      const bot = cy + R * 1.62
      const L = bot - top
      const live = peers.length > 0 && cfg.streamRate > 0
      const g = ctx.createLinearGradient(0, top, 0, bot)
      g.addColorStop(0, 'rgba(255,255,255,0)')
      g.addColorStop(0.5, live ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 7
      ctx.beginPath()
      ctx.moveTo(cx, top + L * 0.18)
      ctx.lineTo(cx, bot - L * 0.18)
      ctx.stroke()
      ctx.strokeStyle = g
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx, top)
      ctx.lineTo(cx, bot)
      ctx.stroke()
      if (live)
        for (let k = 0; k < 9; k++) {
          const pos = (t * 42 * cfg.streamRate + (k * L) / 9) % L
          const y = top + pos
          const fade = 1 - Math.abs(pos / L - 0.5) * 2
          ctx.fillStyle = `rgba(255,255,255,${(0.85 * fade).toFixed(3)})`
          ctx.fillRect(cx - 0.75, y, 1.5, 7)
        }
    }
    // pairs : liaisons + particules vers le flux (réception) ou vers le pair (émission seule, en gris)
    const pp = peers.map((p) => proj(p.x, p.y, p.z, rot))
    // places des étiquettes A, B, C : revues une fois par seconde (la sphère tourne lentement)
    if (callouts.length && Math.abs(t - slotsCheckedAt) >= 1) {
      slotsCheckedAt = t
      if (placeCallouts(pp)) measure()
    }
    if (cfg.flows)
      peers.forEach((p, i) => {
        const [x, y, z] = pp[i]
        if (z < 0.1 || p.w < 0.2) return
        const ex = cx
        const ey = y + (cy - y) * 0.35
        const mx = (x + ex) / 2
        const my = (y + ey) / 2
        const dx = mx - cx
        const dy = my - cy
        const dl = Math.hypot(dx, dy) || 1
        const qx = mx + (dx / dl) * R * 0.28
        const qy = my + (dy / dl) * R * 0.28
        ctx.strokeStyle = `rgba(255,255,255,${(0.04 + 0.16 * p.w * z).toFixed(3)})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.quadraticCurveTo(qx, qy, ex, ey)
        ctx.stroke()
        for (let s = 0; s < 2; s++) {
          let u = (t * (0.22 + p.w * 0.35) + p.ph + s * 0.5) % 1
          if (p.up) u = 1 - u
          const bx1 = (1 - u) * (1 - u) * x + 2 * (1 - u) * u * qx + u * u * ex
          const by1 = (1 - u) * (1 - u) * y + 2 * (1 - u) * u * qy + u * u * ey
          ctx.fillStyle = p.up ? `rgba(160,160,160,${(0.8 * z).toFixed(3)})` : `rgba(255,255,255,${(0.9 * z).toFixed(3)})`
          ctx.fillRect(bx1 - 0.9, by1 - 0.9, 1.8, 1.8)
        }
      })
    const lit = new Set(callouts.map((c) => c.peer))
    const glow = glowSprite()
    peers.forEach((p, i) => {
      const [x, y, z] = pp[i]
      if (z <= 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.16)'
        ctx.fillRect(x - 1, y - 1, 2, 2)
        return
      }
      const rr = 1.3 + p.w * 1.5
      if (lit.has(i) || (p.seed && p.w > 0.25)) {
        // halo pré-rendu
        const s = lit.has(i) ? 24 : 12 + p.w * 8
        ctx.globalAlpha = (lit.has(i) ? 0.55 : 0.3) * z
        ctx.drawImage(glow, x - s / 2, y - s / 2, s, s)
        ctx.globalAlpha = 1
      }
      if (p.seed) {
        ctx.fillStyle = `rgba(255,255,255,${(0.55 + 0.45 * z).toFixed(3)})`
        ctx.beginPath()
        ctx.arc(x, y, rr, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.strokeStyle = `rgba(255,255,255,${(0.55 + 0.45 * z).toFixed(3)})`
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(x, y, rr + 0.4, 0, Math.PI * 2)
        ctx.stroke()
      }
    })
    // repères A, B, C reliés par des traits de rappel (pointillés et atténués quand le pair passe derrière)
    callouts.forEach((c, i) => {
      const a = anchors[i]
      const [x, y, z] = pp[c.peer] ?? [0, 0, -1]
      const front = z > 0
      if (!pp[c.peer]) return
      if (!a) {
        // Plaque étroite : pastille lettrée près du point, même pour un pair passé derrière la
        // sphère (atténuée, trait en tirets, sans cercle autour du point) : le lien avec les
        // lignes A, B, C du tableau reste visible. La pastille reste dans la plaque.
        const lx = Math.max(10, Math.min(W - 10, x + (x < cx ? -18 : 18)))
        const ly = Math.max(10, Math.min(H - 10, y - 16))
        ctx.lineWidth = 1
        ctx.strokeStyle = front ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.18)'
        ctx.setLineDash(front ? [] : [2, 3])
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(lx, ly)
        ctx.stroke()
        ctx.setLineDash([])
        if (front) {
          ctx.beginPath()
          ctx.arc(x, y, 5, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.globalAlpha = front ? 1 : 0.4
        ctx.fillStyle = '#0a0a0a'
        ctx.beginPath()
        ctx.arc(lx, ly, 8, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.font = `500 10px ${MONO_FONT}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(c.label || '', lx, ly + 0.5)
        ctx.globalAlpha = 1
        return
      }
      ctx.strokeStyle = front ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.18)'
      ctx.setLineDash(front ? [] : [2, 3])
      ctx.lineWidth = 1
      const ex = leftSide(i) ? a[0] + ELBOW : a[0] - ELBOW
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(ex, a[1])
      ctx.lineTo(a[0], a[1])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = front ? '#fff' : 'rgba(255,255,255,0.3)'
      ctx.beginPath()
      ctx.arc(a[0], a[1], 1.8, 0, Math.PI * 2)
      ctx.fill()
      if (front) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.beginPath()
        ctx.arc(x, y, 5.5, 0, Math.PI * 2)
        ctx.stroke()
      }
      const op = front ? '1' : '0.4'
      if (c.el.style.opacity !== op) c.el.style.opacity = op
    })
  }

  resize()
  const loop = createLoop(
    canvas,
    fps,
    (_now, dt, still) => {
      if (!still) {
        const s = dt / 1000
        t += s
        for (const d of dust) {
          d.x = (d.x + d.vx * s + 1) % 1
          d.y = (d.y + d.vy * s + 1) % 1
        }
      }
      draw()
    },
    { holdable: options.holdable }
  )
  const idle = options.idleWhenEmpty === true
  if (idle) loop.hold(peers.length === 0, 'idle')
  const ro = new ResizeObserver(() => {
    resize()
    draw()
  })
  ro.observe(canvas)

  return {
    set(key, value) {
      cfg[key] = value
      if (key === 'radius' || key === 'rmaxW' || key === 'cx' || key === 'cy') resize()
      loop.poke()
    },
    setPeers(list) {
      peers = place(list)
      measure()
      if (idle) loop.hold(peers.length === 0, 'idle')
      loop.poke()
    },
    setCallouts(list) {
      callouts = list
      measure()
      if (placeCallouts(projectPeers())) measure()
      slotsCheckedAt = t
      loop.poke()
    },
    relayout() {
      resize()
      draw()
    },
    frame: draw,
    hold: loop.hold,
    stop() {
      loop.stop()
      ro.disconnect()
    }
  }
}
