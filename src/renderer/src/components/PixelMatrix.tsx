import { useEffect, useRef } from 'react'
import { pixelMatrix } from '../fx/pixelMatrix'

// Matrice de points d'une image (jaquette) : un canevas minuscule agrandi sans
// lissage et découpé en cases par le masque CSS du conteneur.
//   Bandeau : <PixelMatrix className="hero-px" src={cover} cell={6} filter={HERO_MATRIX_FILTER} focus={0.35} />
//   Jaquette paysage : <PixelMatrix className="pxbg" src={cover} cell={5} filter={LANDSCAPE_MATRIX_FILTER} />
// Redessinée seulement au changement d'image et au redimensionnement du conteneur.

interface Props {
  /** adresse de l'image (essaim://cover/<id>?v=<version>) */
  src: string
  /** classe du conteneur masqué (.hero-px ou .pxbg) */
  className: string
  cell?: number
  filter?: string
  focus?: number
}

export function PixelMatrix({ src, className, cell = 6, filter, focus = 0.5 }: Props): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = box.current
    const cv = canvas.current
    if (!el || !cv || !src) return
    const img = new Image()
    img.decoding = 'async'
    img.src = src
    const pm = pixelMatrix(img, cv, { cell, filter, focus })
    const ro = new ResizeObserver(() => pm.redraw())
    ro.observe(el)
    return () => {
      ro.disconnect()
      pm.dispose()
    }
  }, [src, cell, filter, focus])
  return (
    <div ref={box} className={className} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  )
}
