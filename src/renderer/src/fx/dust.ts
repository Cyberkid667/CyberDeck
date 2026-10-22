// Poussière lente : seulement dans le bandeau de la bibliothèque (56 points) et
// les états vides (40 points). 24 images/s, points de 0,6 à 1,8 px, opacité 0,12 à
// 0,62 avec un léger scintillement, montée lente et balancement horizontal.
// bias > 0 : plus dense côté image (opacité × min(1, x / bias)). Voir SPEC 5.11.

import { createLoop, type Loop } from './loop'
import { canvasDpr } from './motion'
import { rng } from './random'

export interface DustOptions {
  count?: number
  fps?: number
  seed?: number
  /** 0 = uniforme ; 0,45 dans le bandeau (plus dense à droite, côté image) */
  bias?: number
  holdable?: boolean
}

export interface Dust extends Pick<Loop, 'hold' | 'redraw'> {
  stop(): void
}

export function createDust(canvas: HTMLCanvasElement, opts: DustOptions = {}): Dust {
  const { count = 56, fps = 24, seed = 5, bias = 0.45 } = opts
  const ctx = canvas.getContext('2d')!
  const r = rng(seed)
  let W = 0
  let H = 0
  const fit = (): void => {
    const b = canvas.getBoundingClientRect()
    const dpr = canvasDpr()
    W = b.width
    H = b.height
    canvas.width = Math.max(1, Math.round(W * dpr))
    canvas.height = Math.max(1, Math.round(H * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  const dots = Array.from({ length: count }, () => ({
    x: r(),
    y: r(),
    s: 0.6 + r() * 1.2,
    a: 0.12 + r() * 0.5,
    v: 0.004 + r() * 0.012,
    ph: r() * 6.28
  }))
  const draw = (t: number, dt: number, still: boolean): void => {
    if (!W || !H) return
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#fff'
    const s = dt / 1000
    for (const d of dots) {
      if (!still) {
        d.y -= d.v * s
        d.x += Math.sin(t / 4000 + d.ph) * 0.009 * s
        if (d.y < -0.02) {
          d.y = 1.02
          d.x = r()
        }
      }
      const fade = bias ? Math.min(1, d.x / bias) : 1 // plus dense côté image
      ctx.globalAlpha = Math.max(0, d.a * fade * (0.7 + 0.3 * Math.sin(t / 900 + d.ph)))
      ctx.fillRect(d.x * W, d.y * H, d.s, d.s)
    }
    ctx.globalAlpha = 1
  }
  fit()
  const loop = createLoop(canvas, fps, draw, { holdable: opts.holdable })
  const ro = new ResizeObserver(() => {
    fit()
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
