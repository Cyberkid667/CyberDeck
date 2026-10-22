// Oscilloscope « TRAFIC · 60 S » (barre latérale) : 60 échantillons (1 par seconde,
// depuis snapshot.global). Aucune boucle : redessiné une seule fois par seconde à
// l'arrivée de l'instantané, et au redimensionnement. Voir SPEC 5.11.
// Grille 6 colonnes (10 s) × 4 rangées ; émission en tirets blanc 50 % ;
// réception en aire dégradée + trait large de halo + trait net, tête lumineuse.

import { canvasDpr } from './motion'

export const SCOPE_SAMPLES = 60

const KO = 1024
const MO = 1048576
const GO = 1073741824

// Valeurs « rondes » de l'échelle : 1 – 2,5 – 5 × 10ⁿ
const STEPS: { v: number; label: string }[] = [
  { v: 10 * KO, label: '10 Ko/s' },
  { v: 25 * KO, label: '25 Ko/s' },
  { v: 50 * KO, label: '50 Ko/s' },
  { v: 100 * KO, label: '100 Ko/s' },
  { v: 250 * KO, label: '250 Ko/s' },
  { v: 500 * KO, label: '500 Ko/s' },
  { v: 1 * MO, label: '1 Mo/s' },
  { v: 2.5 * MO, label: '2,5 Mo/s' },
  { v: 5 * MO, label: '5 Mo/s' },
  { v: 10 * MO, label: '10 Mo/s' },
  { v: 25 * MO, label: '25 Mo/s' },
  { v: 50 * MO, label: '50 Mo/s' },
  { v: 100 * MO, label: '100 Mo/s' },
  { v: 250 * MO, label: '250 Mo/s' },
  { v: 500 * MO, label: '500 Mo/s' },
  { v: 1 * GO, label: '1 Go/s' },
  { v: 2.5 * GO, label: '2,5 Go/s' },
  { v: 5 * GO, label: '5 Go/s' },
  { v: 10 * GO, label: '10 Go/s' }
]

/** Plus petite valeur « ronde » au-dessus du maximum des 60 s (10 Ko/s au minimum). */
export function scopeScale(samples: readonly number[]): { max: number; label: string } {
  let peak = 0
  for (const v of samples) if (v > peak) peak = v
  for (const s of STEPS) if (peak <= s.v) return { max: s.v, label: s.label }
  const last = STEPS[STEPS.length - 1]
  return { max: Math.max(peak, last.v), label: last.label }
}

export interface Scope {
  /** dn / up : 60 valeurs en octets/s, de la plus ancienne à la plus récente ; max : haut de l'échelle */
  draw(dn: readonly number[], up: readonly number[], max: number): void
  stop(): void
}

export function createScope(canvas: HTMLCanvasElement): Scope {
  const ctx = canvas.getContext('2d')!
  let W = 0
  let H = 0
  let data: { dn: readonly number[]; up: readonly number[]; max: number } = {
    dn: new Array(SCOPE_SAMPLES).fill(0),
    up: new Array(SCOPE_SAMPLES).fill(0),
    max: 10 * KO
  }
  const fit = (): void => {
    const b = canvas.getBoundingClientRect()
    const dpr = canvasDpr()
    W = b.width
    H = b.height
    canvas.width = Math.max(1, Math.round(W * dpr))
    canvas.height = Math.max(1, Math.round(H * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  const yOf = (v: number): number => H - 4 - Math.min(1, Math.max(0, v) / data.max) * (H - 14)
  const smooth = (p: [number, number][]): void => {
    ctx.moveTo(p[0][0], p[0][1])
    for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2)
    ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1])
  }
  const render = (): void => {
    if (!W || !H) return
    const { dn, up } = data
    const n = dn.length
    if (n < 2) return
    const step = W / (n - 1)
    ctx.clearRect(0, 0, W, H)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.055)'
    ctx.beginPath()
    for (let k = 1; k < 6; k++) {
      // une colonne = 10 s
      const x = Math.round((k * W) / 6) + 0.5
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
    }
    for (let k = 1; k < 4; k++) {
      const y = Math.round((k * H) / 4) + 0.5
      ctx.moveTo(0, y)
      ctx.lineTo(W, y)
    }
    ctx.stroke()
    const pu = up.map((v, i): [number, number] => [i * step, yOf(v)])
    const pd = dn.map((v, i): [number, number] => [i * step, yOf(v)])
    ctx.setLineDash([2, 3])
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.beginPath()
    smooth(pu)
    ctx.stroke()
    ctx.setLineDash([])
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, 'rgba(255,255,255,0.17)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.beginPath()
    smooth(pd)
    ctx.lineTo(W, H)
    ctx.lineTo(0, H)
    ctx.closePath()
    ctx.fillStyle = g
    ctx.fill()
    ctx.beginPath()
    smooth(pd)
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'
    ctx.lineWidth = 4
    ctx.stroke() // halo sans shadowBlur
    ctx.beginPath()
    smooth(pd)
    ctx.strokeStyle = 'rgba(255,255,255,0.96)'
    ctx.lineWidth = 1.25
    ctx.stroke()
    const hy = pd[n - 1][1]
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.beginPath()
    ctx.arc(W - 2.5, hy, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(W - 2.5, hy, 2, 0, Math.PI * 2)
    ctx.fill()
  }
  fit()
  render()
  const ro = new ResizeObserver(() => {
    fit()
    render()
  })
  ro.observe(canvas)
  return {
    draw(dn, up, max) {
      data = { dn, up, max: max > 0 ? max : 10 * KO }
      render()
    },
    stop() {
      ro.disconnect()
    }
  }
}
