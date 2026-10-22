// Mouvement réduit (prefers-reduced-motion) : lu une fois puis suivi en direct.
// En mouvement réduit, chaque canevas dessine une seule image fixe et ne la
// redessine que lorsque ses données changent (voir loop.ts).

const query: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null

let reduced = !!query?.matches
const listeners = new Set<(reduced: boolean) => void>()

query?.addEventListener('change', (e) => {
  reduced = e.matches
  for (const cb of listeners) cb(reduced)
})

/** true quand Windows demande moins d'animations. */
export const prefersReducedMotion = (): boolean => reduced

/** Prévient quand le réglage change ; renvoie la fonction de désabonnement. */
export function onReducedMotionChange(cb: (reduced: boolean) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Police mono pour le texte dessiné dans les canevas (même famille que l'interface). */
export const MONO_FONT = '"IBM Plex Mono", Consolas, monospace'

/** Densité de pixels plafonnée à 2 (coût des canevas). */
export const canvasDpr = (): number => Math.min(2, window.devicePixelRatio || 1)
