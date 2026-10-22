// Effets visuels de CyberDeck (portage typé de _src/shared.js des maquettes).
// Tous les canevas animés passent par la boucle bridée de loop.ts : arrêt hors
// écran, fenêtre cachée, dialogue ouvert (holdAll / useCanvasHold) et une seule
// image fixe en mouvement réduit.

export { canvasDpr, MONO_FONT, onReducedMotionChange, prefersReducedMotion } from './motion'
export { hashStr, peerLatLon, rng } from './random'
export { canvasesHeld, createLoop, holdAll, useCanvasHold, useThrottledLoop, type DrawFn, type Loop, type LoopOptions } from './loop'
export { glowSprite } from './glow'
export { createGlobe, type Globe, type GlobeCallout, type GlobeOptions, type GlobePeer, type GlobeSettings } from './globe'
export { createMarkAnim, type MarkAnim, type MarkAnimOptions } from './markAnim'
export { createScope, SCOPE_SAMPLES, scopeScale, type Scope } from './scope'
export { createDust, type Dust, type DustOptions } from './dust'
export { contoursURL, installContours, type ContoursOptions } from './contours'
export {
  HERO_MATRIX_FILTER,
  LANDSCAPE_MATRIX_FILTER,
  pixelMatrix,
  type PixelMatrix,
  type PixelMatrixOptions
} from './pixelMatrix'
export { barcodeCSS } from './barcode'
