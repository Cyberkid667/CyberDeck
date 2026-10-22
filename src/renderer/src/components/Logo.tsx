import { MarkSmall } from './MarkSmall'

// Ancien logo d'Essaim (hexagone miel) : remplacé par le logo CyberDeck.
// Gardé seulement pour compatibilité : utiliser <MarkSmall /> (16 à 40 px)
// ou <MarkAnim /> (logo animé, 48 px et plus).
export function Logo({ size = 20 }: { size?: number }): React.JSX.Element {
  return <MarkSmall size={size} className="logo-mark" />
}
