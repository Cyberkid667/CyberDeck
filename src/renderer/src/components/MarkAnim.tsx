import { useEffect, useRef } from 'react'
import { createMarkAnim } from '../fx/markAnim'

// Logo animé (sphère de points qui tourne, impulsion qui descend le flux) :
// état vide « Aucun torrent » 132 px, glisser-déposer 200 px, démarrage 112 px.
// La taille vient du CSS du contexte (.empty .mark-anim, .drop .box canvas,
// .splash canvas) ou de la prop size. Boucle bridée à 30 images/s, figée hors
// écran, fenêtre cachée ou dialogue ouvert ; image fixe en mouvement réduit.

interface Props {
  size?: number
  className?: string
  /** false pour un logo affiché par-dessus un dialogue ou dans le dialogue lui-même */
  holdable?: boolean
}

export function MarkAnim({ size, className, holdable = true }: Props): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const anim = createMarkAnim(ref.current, { holdable })
    return () => anim.stop()
  }, [holdable])
  return <canvas ref={ref} className={className} style={size ? { width: size, height: size } : undefined} aria-hidden="true" />
}
