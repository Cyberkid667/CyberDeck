import { useEffect, useRef } from 'react'
import { createDust } from '../fx/dust'

// Poussière lente (bandeau de la bibliothèque : 56 points, bias 0,45 ;
// états vides : 40 points, bias 0). Le canevas remplit son conteneur via le CSS
// du contexte (.empty .dust, .hero-dust). 24 images/s, arrêt hors écran,
// fenêtre cachée ou dialogue ouvert ; image fixe en mouvement réduit.

interface Props {
  className?: string
  count?: number
  bias?: number
  seed?: number
}

export function Dust({ className = 'dust', count = 40, bias = 0, seed = 5 }: Props): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const dust = createDust(ref.current, { count, bias, seed })
    return () => dust.stop()
  }, [count, bias, seed])
  return <canvas ref={ref} className={className} aria-hidden="true" />
}
