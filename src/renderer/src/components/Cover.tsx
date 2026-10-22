import { Gamepad2 } from 'lucide-react'
import { useState } from 'react'
import type { Game } from '../../../shared/types'
import { LANDSCAPE_MATRIX_FILTER } from '../fx/pixelMatrix'
import { PixelMatrix } from './PixelMatrix'

// Jaquette d'un jeu, toujours au format 2:3 (SPEC 5.10) :
//   - portrait : l'image remplit la case (object-fit: cover) ;
//   - paysage : l'image entière, centrée verticalement, sur un fond en matrice
//     de points de la même image (cases de 5 px) ;
//   - sans jaquette (ou image illisible) : plaque gravée (lignes de niveau +
//     grille de 18 px, vignettage), icône du .exe dans un cadre noir, petite
//     croix, légende « SANS JAQUETTE » et le nom en mono 300 17 px.
// compact : plaque sans textes (billet du bandeau, petites vignettes).
// children : calques posés par-dessus la jaquette (puce EN JEU, bouton « … », voile JOUER).

export const coverSrc = (game: Game): string | null =>
  game.coverVersion ? `essaim://cover/${game.id}?v=${game.coverVersion}` : null

export const iconSrc = (game: Game): string | null =>
  game.iconVersion > 0 ? `essaim://icon/${game.id}?v=${game.iconVersion}` : null

/** Icône du .exe dans son cadre noir ; manette si l'icône manque ou ne se lit pas. */
export function ExeIcon({ game, className = 'ico' }: { game: Game; className?: string }): React.JSX.Element {
  const src = iconSrc(game)
  const [failed, setFailed] = useState<string | null>(null)
  if (src && failed !== src) return <img className={className} src={src} alt="" decoding="async" onError={() => setFailed(src)} />
  return (
    <span className={`${className} none`}>
      <Gamepad2 />
    </span>
  )
}

interface Props {
  game: Game
  className?: string
  /** plaque sans légende ni nom (billet du bandeau) */
  compact?: boolean
  children?: React.ReactNode
}

export function Cover({ game, className = '', compact = false, children }: Props): React.JSX.Element {
  const src = coverSrc(game)
  // une jaquette qui ne se charge pas (fichier supprimé…) laisse place à la plaque gravée
  const [failed, setFailed] = useState<string | null>(null)
  const extra = className ? ` ${className}` : ''

  if (src && failed !== src && game.coverShape === 'landscape')
    return (
      <div className={`cov land${extra}`}>
        <PixelMatrix className="pxbg" src={src} cell={5} filter={LANDSCAPE_MATRIX_FILTER} />
        <img className="main" src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />
        {children}
      </div>
    )
  if (src && failed !== src)
    return (
      <div className={`cov${extra}`}>
        <img className="full" src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />
        {children}
      </div>
    )
  return (
    <div className={`cov ph${compact ? ' compact' : ''}${extra}`}>
      <div className="ph-plate" aria-hidden="true">
        <ExeIcon game={game} />
        <span className="plus" />
        {!compact && (
          <div className="ph-text">
            <div className="cap">Sans jaquette</div>
            <div className="pht">{game.name}</div>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
