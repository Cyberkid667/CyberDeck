// Boucle d'animation bridée commune à tous les canevas animés (globe, logo animé,
// poussière). Une image, puis setTimeout jusqu'à la suivante, puis
// requestAnimationFrame : exactement « fps » réveils par seconde, même sur un
// écran 144 Hz. La boucle s'arrête (dernière image figée) quand :
//   - l'élément sort de l'écran (IntersectionObserver) ;
//   - la fenêtre est cachée (visibilitychange) ;
//   - un dialogue est ouvert (holdAll / useCanvasHold), sauf pour les canevas
//     créés avec { holdable: false } (ceux DU dialogue) ;
//   - son propriétaire la met en pause (hold(true, raison)) ;
//   - Windows demande moins d'animations : une seule image fixe, redessinée
//     seulement quand les données changent (poke / redraw).

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { onReducedMotionChange, prefersReducedMotion } from './motion'

/** now : horloge de performance (ms) ; dt : écart avec l'image précédente (ms, 0 pour une image fixe) ; still : image fixe. */
export type DrawFn = (now: number, dt: number, still: boolean) => void

export interface LoopOptions {
  /** false : ignore holdAll() — pour un canevas affiché DANS un dialogue. Par défaut true. */
  holdable?: boolean
}

export interface Loop {
  /** Dessine tout de suite une image fixe (sans faire avancer l'animation). */
  redraw(): void
  /** Comme redraw(), mais seulement si la boucle est à l'arrêt et pas figée par un dialogue (données changées). */
  poke(): void
  /** Pause (image figée) ou reprise pour une raison donnée ; la boucle tourne quand plus aucune raison ne la retient. */
  hold(on: boolean, reason?: string): void
  /** Arrête et libère tout (observateurs, écouteurs). */
  stop(): void
  /** Change la cadence (images par seconde) ; prend effet à l'image suivante. */
  setFps(fps: number): void
  /** true tant que la boucle tourne. */
  readonly running: boolean
}

const REFRESH = new Set<() => void>()
let holdDepth = 0

/**
 * Fige (true) ou libère (false) tous les canevas « holdable » : à appeler à
 * l'ouverture / la fermeture d'un dialogue. Compteur : deux dialogues ouverts
 * demandent deux libérations.
 */
export function holdAll(on: boolean): void {
  holdDepth = Math.max(0, holdDepth + (on ? 1 : -1))
  for (const refresh of REFRESH) refresh()
}

/** true quand au moins un dialogue fige les canevas. */
export const canvasesHeld = (): boolean => holdDepth > 0

/** Fige les canevas de l'arrière-plan tant que le composant est monté (et que active est vrai). */
export function useCanvasHold(active = true): void {
  useEffect(() => {
    if (!active) return
    holdAll(true)
    return () => holdAll(false)
  }, [active])
}

export function createLoop(el: Element, fps: number, draw: DrawFn, opts: LoopOptions = {}): Loop {
  const holdable = opts.holdable !== false
  let step = 1000 / fps
  const holds = new Set<string>()
  let raf = 0
  let timer = 0
  let last = 0
  let visible = true
  let running = false
  let stopped = false

  const frozen = (): boolean => holdable && holdDepth > 0
  const canRun = (): boolean =>
    !stopped && visible && holds.size === 0 && !frozen() && !document.hidden && !prefersReducedMotion()

  const tick = (t: number): void => {
    raf = 0
    if (!running) return
    const dt = last ? Math.min(100, t - last) : step
    last = t
    draw(t, dt, false)
    if (running)
      timer = window.setTimeout(
        () => {
          timer = 0
          if (running) raf = requestAnimationFrame(tick)
        },
        Math.max(0, step - (performance.now() - t) - 4)
      )
  }
  const start = (): void => {
    if (running || !canRun()) return
    running = true
    last = 0
    raf = requestAnimationFrame(tick)
  }
  const halt = (): void => {
    running = false
    if (raf) cancelAnimationFrame(raf)
    if (timer) clearTimeout(timer)
    raf = 0
    timer = 0
  }
  const refresh = (): void => (canRun() ? start() : halt())
  const still = (): void => {
    if (!stopped) draw(performance.now(), 0, true)
  }

  const onVisibility = (): void => refresh()
  document.addEventListener('visibilitychange', onVisibility)
  const io = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1]
    if (e) visible = e.isIntersecting
    refresh()
  })
  io.observe(el)
  const offReduced = onReducedMotionChange((reduced) => {
    if (reduced) {
      halt()
      still()
    } else refresh()
  })
  REFRESH.add(refresh)

  still()
  start()

  return {
    redraw: still,
    poke() {
      if (!running && !frozen()) still()
    },
    hold(on, reason = 'self') {
      if (on) holds.add(reason)
      else holds.delete(reason)
      refresh()
    },
    stop() {
      if (stopped) return
      stopped = true
      halt()
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      offReduced()
      REFRESH.delete(refresh)
    },
    setFps(n) {
      step = 1000 / Math.max(1, n)
    },
    get running() {
      return running
    }
  }
}

/**
 * Crée une boucle bridée sur l'élément de ref (au montage) et la détruit au
 * démontage. draw peut changer d'un rendu à l'autre (la dernière version est
 * toujours appelée). Renvoie une ref vers la boucle (hold, redraw, poke).
 */
export function useThrottledLoop<T extends Element>(
  ref: RefObject<T | null>,
  fps: number,
  draw: DrawFn,
  opts: LoopOptions = {}
): RefObject<Loop | null> {
  const drawRef = useRef(draw)
  const loopRef = useRef<Loop | null>(null)
  const holdable = opts.holdable !== false
  useLayoutEffect(() => {
    drawRef.current = draw
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const loop = createLoop(el, fps, (now, dt, still) => drawRef.current(now, dt, still), { holdable })
    loopRef.current = loop
    return () => {
      loop.stop()
      loopRef.current = null
    }
  }, [ref, fps, holdable])
  return loopRef
}
