// Lignes de niveau : bruit de valeurs + carrés marchants, dessinés UNE fois
// (~15 ms) puis réutilisés comme image de fond via la variable CSS --contours
// (états vides à 13 %, bandeau à 10 %, plaques « sans jaquette »). Voir SPEC 5.11.

import { rng } from './random'

export interface ContoursOptions {
  seed?: number
  /** taille d'une case des carrés marchants (px) */
  cell?: number
  levels?: number
  scale?: number
  /** opacité des niveaux majeurs (les autres : × 0,45) */
  alpha?: number
  /** un niveau sur « major » est majeur */
  major?: number
}

/** Dessine les lignes de niveau dans un canevas w × h et renvoie une data-URL PNG. */
export function contoursURL(w: number, h: number, opts: ContoursOptions = {}): string {
  const { seed = 7, cell = 6, levels = 11, scale = 0.006, alpha = 0.55, major = 4 } = opts
  const r = rng(seed)
  const G = 64
  const lat = new Float32Array(G * G)
  for (let i = 0; i < lat.length; i++) lat[i] = r()
  const sm = (t: number): number => t * t * (3 - 2 * t)
  const vn = (x: number, y: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const a = lat[(yi & 63) * G + (xi & 63)]
    const b = lat[(yi & 63) * G + ((xi + 1) & 63)]
    const c = lat[((yi + 1) & 63) * G + (xi & 63)]
    const d = lat[((yi + 1) & 63) * G + ((xi + 1) & 63)]
    const u = sm(xf)
    const v = sm(yf)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
  const fbm = (x: number, y: number): number => vn(x, y) * 0.62 + vn(x * 2.03 + 11, y * 2.03 + 7) * 0.27 + vn(x * 4.1 + 3, y * 4.1 + 19) * 0.11
  const nx = Math.ceil(w / cell) + 1
  const ny = Math.ceil(h / cell) + 1
  const f = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) f[j * nx + i] = fbm(i * cell * scale * 10, j * cell * scale * 10)
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')!
  ctx.lineWidth = 1
  type Pt = [number, number]
  for (let L = 0; L < levels; L++) {
    const iso = 0.2 + (L / (levels - 1)) * 0.6
    ctx.strokeStyle = `rgba(255,255,255,${L % major === 0 ? alpha : alpha * 0.45})`
    ctx.beginPath()
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const v0 = f[j * nx + i]
        const v1 = f[j * nx + i + 1]
        const v2 = f[(j + 1) * nx + i + 1]
        const v3 = f[(j + 1) * nx + i]
        const idx = (v0 > iso ? 8 : 0) | (v1 > iso ? 4 : 0) | (v2 > iso ? 2 : 0) | (v3 > iso ? 1 : 0)
        if (idx === 0 || idx === 15) continue
        const x = i * cell
        const y = j * cell
        const lp = (a: number, b: number): number => (iso - a) / (b - a)
        const T: Pt = [x + lp(v0, v1) * cell, y]
        const R: Pt = [x + cell, y + lp(v1, v2) * cell]
        const B: Pt = [x + lp(v3, v2) * cell, y + cell]
        const Lf: Pt = [x, y + lp(v0, v3) * cell]
        const seg = (p: Pt, q: Pt): void => {
          ctx.moveTo(p[0], p[1])
          ctx.lineTo(q[0], q[1])
        }
        switch (idx) {
          case 1:
          case 14:
            seg(Lf, B)
            break
          case 2:
          case 13:
            seg(B, R)
            break
          case 3:
          case 12:
            seg(Lf, R)
            break
          case 4:
          case 11:
            seg(T, R)
            break
          case 5:
            seg(Lf, T)
            seg(B, R)
            break
          case 6:
          case 9:
            seg(T, B)
            break
          case 7:
          case 8:
            seg(Lf, T)
            break
          case 10:
            seg(T, R)
            seg(Lf, B)
            break
        }
      }
    ctx.stroke()
  }
  return cv.toDataURL('image/png')
}

let installed = false

/**
 * Pose --contours sur :root (une seule fois, au démarrage) : image de 420 × 460 px,
 * 12 niveaux, graine 11 — la même que dans les maquettes.
 */
export function installContours(): void {
  if (installed) return
  installed = true
  try {
    const url = contoursURL(420, 460, { seed: 11, cell: 5, levels: 12 })
    document.documentElement.style.setProperty('--contours', `url(${url})`)
  } catch {
    // simple décor : sans lignes de niveau, les fonds restent unis
  }
}
