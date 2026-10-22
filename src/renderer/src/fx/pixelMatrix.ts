// Matrice de points : l'image est dessinée UNE fois dans un canevas minuscule
// (1 pixel = 1 case), affichée agrandie avec image-rendering: pixelated et découpée
// en carrés par un double masque CSS (.hero-px, .cov.land .pxbg). Aucun
// getImageData : fonctionne avec le protocole essaim://. Redessinée au changement
// d'image et au redimensionnement du conteneur seulement. Voir SPEC 5.11.

export interface PixelMatrixOptions {
  /** taille d'une case en px CSS (6 dans le bandeau, 5 derrière une jaquette paysage) */
  cell?: number
  /** filtre canvas appliqué au dessin */
  filter?: string
  /** point de cadrage 0..1 quand l'image est recadrée (0,5 = centre) */
  focus?: number
}

export const HERO_MATRIX_FILTER = 'grayscale(1) contrast(1.35) brightness(0.9)'
export const LANDSCAPE_MATRIX_FILTER = 'grayscale(1) contrast(1.2) brightness(0.8)'

export interface PixelMatrix {
  /** redessine d'après la taille actuelle du parent du canevas */
  redraw(): void
  /** retire l'écouteur de chargement de l'image */
  dispose(): void
}

/** Le canevas remplit son parent (le conteneur masqué) ; l'image peut être en cours de chargement. */
export function pixelMatrix(img: HTMLImageElement, canvas: HTMLCanvasElement, opts: PixelMatrixOptions = {}): PixelMatrix {
  const { cell = 6, filter = 'grayscale(1) contrast(1.25) brightness(0.95)', focus = 0.5 } = opts
  const draw = (): void => {
    const parent = canvas.parentElement
    if (!parent) return
    const box = parent.getBoundingClientRect()
    if (!box.width || !box.height || !img.naturalWidth) return
    const w = Math.ceil(box.width / cell)
    const h = Math.ceil(box.height / cell)
    canvas.width = w
    canvas.height = h
    canvas.style.width = `${w * cell}px`
    canvas.style.height = `${h * cell}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.filter = filter
    const ir = img.naturalWidth / img.naturalHeight
    const cr = w / h
    let sw: number
    let sh: number
    let sx: number
    let sy: number
    if (ir > cr) {
      sh = img.naturalHeight
      sw = sh * cr
      sx = (img.naturalWidth - sw) * focus
      sy = 0
    } else {
      sw = img.naturalWidth
      sh = sw / cr
      sx = 0
      sy = (img.naturalHeight - sh) * focus
    }
    ctx.imageSmoothingQuality = 'high'
    try {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
    } catch {
      // image illisible : le fond reste vide
    }
  }
  const onLoad = (): void => draw()
  if (img.complete && img.naturalWidth) draw()
  else img.addEventListener('load', onLoad, { once: true })
  return {
    redraw: draw,
    dispose: () => img.removeEventListener('load', onLoad)
  }
}
