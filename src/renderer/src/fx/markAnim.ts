// Logo animé (état vide, glisser-déposer, démarrage) — même géométrie que mark.svg
// (espace 100 × 100) : sphère de rayon 33 centrée en (50, 47), cercles de latitude
// tous les 15°, couloir libre autour de l'axe, flux vertical, nœud « toi » en bas.
// 1. un tour en 48 s ; 2. une impulsion descend le flux toutes les 2,4 s ;
// 3. les points proches de l'axe s'éclairent à son passage ; 4. le nœud s'allume
// à l'arrivée. 30 images/s au plus, 12 niveaux d'opacité (un fill() par niveau).
// Mouvement réduit : une image fixe (rotation de départ 7°). Voir SPEC 5.20.

import { createLoop, type Loop } from './loop'
import { canvasDpr, prefersReducedMotion } from './motion'

export interface MarkAnimOptions {
  /** période de l'impulsion (ms) */
  period?: number
  /** durée d'un tour (ms) */
  turn?: number
  fps?: number
  /** couleur des points (le logo est toujours #f4f5f7) */
  color?: string
  holdable?: boolean
}

export interface MarkAnim extends Pick<Loop, 'hold' | 'redraw'> {
  stop(): void
}

export function createMarkAnim(canvas: HTMLCanvasElement, opts: MarkAnimOptions = {}): MarkAnim {
  const { period = 2400, turn = 48000, fps = 30, color = '#f4f5f7' } = opts
  const ctx = canvas.getContext('2d')!
  const TILT = (22 * Math.PI) / 180
  const STEP = 15
  const N0 = 30
  const STAG = 6
  const R = 33
  const CX = 50
  const CY = 47
  const TOP = 2
  const BOT = 89
  const base: { la: number; lo: number }[] = []
  for (let lat = -90 + STEP; lat <= 90 - STEP + 0.01; lat += STEP) {
    const la = (lat * Math.PI) / 180
    const cnt = Math.max(3, Math.round(Math.cos(la) * N0))
    for (let k = 0; k < cnt; k++) base.push({ la, lo: (k / cnt) * Math.PI * 2 + (((lat / STEP) * STAG + 7) * Math.PI) / 180 })
  }
  let S = 1
  let ox = 0
  let oy = 0
  let dpr = 1
  const resize = (): void => {
    const b = canvas.getBoundingClientRect()
    dpr = canvasDpr()
    canvas.width = Math.max(1, Math.round(b.width * dpr))
    canvas.height = Math.max(1, Math.round(b.height * dpr))
    S = Math.min(b.width, b.height) / 100
    ox = (b.width - 100 * S) / 2
    oy = (b.height - 100 * S) / 2
  }
  const LV = 12
  const bk: number[][] = Array.from({ length: LV }, () => [])
  const draw = (t: number, still: boolean): void => {
    if (S <= 0) return
    const spin = still ? 0 : (t / turn) * Math.PI * 2
    ctx.setTransform(dpr * S, 0, 0, dpr * S, dpr * ox, dpr * oy)
    ctx.clearRect(-ox / S, -oy / S, 100 + (2 * ox) / S, 100 + (2 * oy) / S)
    const pulseY = still ? -99 : TOP + ((t % period) / period) * (BOT - TOP + 12)
    for (const b of bk) b.length = 0
    for (const { la, lo } of base) {
      const a = lo + spin
      const x = Math.cos(la) * Math.sin(a)
      const z0 = Math.cos(la) * Math.cos(a)
      const y0 = Math.sin(la)
      const y = -(y0 * Math.cos(TILT) - z0 * Math.sin(TILT))
      const z = y0 * Math.sin(TILT) + z0 * Math.cos(TILT)
      const X = CX + x * R
      const Y = CY + y * R
      if (Math.abs(X - CX) < 1.9 && z > -0.2) continue
      let rr: number
      let o: number
      if (z < 0) {
        rr = 0.42
        o = 0.22 * (0.5 + (z + 1) / 2)
      } else {
        rr = 0.5 + 0.95 * Math.pow(z, 0.8)
        o = 0.32 + 0.68 * Math.pow(z, 0.9)
        if (Math.hypot(x, y) > 0.9) o = Math.max(o, 0.55)
        const near = Math.exp(-Math.pow((X - CX) / (R * 0.32), 2))
        o = Math.min(1, o * (0.62 + 0.5 * near))
        rr *= 0.9 + 0.22 * near
        o = Math.min(1, o + 0.35 * near * Math.exp(-Math.pow((Y - pulseY) / 5, 2)))
      }
      bk[Math.max(0, Math.min(LV - 1, Math.floor(o * LV)))].push(X, Y, rr)
    }
    ctx.fillStyle = color
    for (let k = 0; k < LV; k++) {
      const arr = bk[k]
      if (!arr.length) continue
      ctx.globalAlpha = (k + 0.5) / LV
      ctx.beginPath()
      for (let j = 0; j < arr.length; j += 3) {
        ctx.moveTo(arr[j] + arr[j + 2], arr[j + 1])
        ctx.arc(arr[j], arr[j + 1], arr[j + 2], 0, Math.PI * 2)
      }
      ctx.fill()
    }
    ctx.globalAlpha = 1
    const g = ctx.createLinearGradient(0, TOP, 0, BOT)
    g.addColorStop(0, 'rgba(244,245,247,0)')
    g.addColorStop(0.18, 'rgba(244,245,247,.35)')
    g.addColorStop(0.55, 'rgba(244,245,247,.85)')
    g.addColorStop(1, color)
    ctx.fillStyle = g
    ctx.fillRect(CX - 0.6, TOP, 1.2, BOT - TOP)
    if (pulseY > TOP && pulseY < BOT) {
      const pg = ctx.createLinearGradient(0, pulseY - 9, 0, pulseY)
      pg.addColorStop(0, 'rgba(255,255,255,0)')
      pg.addColorStop(1, '#fff')
      ctx.fillStyle = pg
      ctx.fillRect(CX - 0.9, pulseY - 9, 1.8, 9)
      ctx.globalAlpha = 0.25
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(CX, pulseY, 2.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
    const arrive = Math.max(0, 1 - Math.abs(pulseY - BOT) / 8)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(CX, BOT, 2.1 + arrive * 0.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = 0.6
    ctx.globalAlpha = 0.35 + arrive * 0.4
    ctx.beginPath()
    ctx.arc(CX, BOT, 4.5 + arrive * 2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  resize()
  // image fixe à l'angle de départ seulement en mouvement réduit ; sinon l'image fixe suit l'horloge
  const loop = createLoop(canvas, fps, (t, _dt, still) => draw(t, still && prefersReducedMotion()), { holdable: opts.holdable })
  const ro = new ResizeObserver(() => {
    resize()
    loop.redraw()
  })
  ro.observe(canvas)
  return {
    hold: loop.hold,
    redraw: loop.redraw,
    stop() {
      loop.stop()
      ro.disconnect()
    }
  }
}
