import { useId } from 'react'

// Petit logo CyberDeck (logo/mark-small.svg, grille de 20) : 8 points sur
// l'anneau, méridien de 3 points à gauche (85 / 70 / 55 %), flux vertical qui
// finit sur le nœud « toi ». De 16 à 40 px ; au-delà de 48 px, le logo animé.
// Couleur = currentColor (#f4f5f7 via .logo-mark dans la bande de titre).

const RING: [number, number][] = [
  [14, 3],
  [17, 7],
  [17, 11],
  [14, 15],
  [6, 15],
  [3, 11],
  [3, 7],
  [6, 3]
]
const MERIDIAN: [number, number, number][] = [
  [7, 6, 0.85],
  [6, 9, 0.7],
  [7, 12, 0.55]
]

interface Props {
  /** taille en px (20 dans la bande de titre) ; sinon la taille vient du CSS */
  size?: number
  className?: string
  /** texte pour les lecteurs d'écran ; sans titre, le logo est décoratif */
  title?: string
}

export function MarkSmall({ size, className = 'logo-mark', title }: Props): React.JSX.Element {
  const id = `msg${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="currentColor"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="15.6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="currentColor" stopOpacity="0" />
          <stop offset="0.3" stopColor="currentColor" stopOpacity="0.9" />
          <stop offset="1" stopColor="currentColor" stopOpacity="1" />
        </linearGradient>
      </defs>
      <g>
        {RING.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />
        ))}
        {MERIDIAN.map(([x, y, o]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="1" fillOpacity={o} />
        ))}
      </g>
      <rect x="9" y="0" width="2" height="15.6" fill={`url(#${id})`} />
      <circle cx="10" cy="16.1" r="1.9" />
    </svg>
  )
}
