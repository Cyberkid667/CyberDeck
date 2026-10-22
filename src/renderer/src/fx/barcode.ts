// Code-barres décoratif (un seul dégradé CSS, calculé une fois depuis une graine :
// id du jeu, empreinte du torrent). Seulement sur le billet du bandeau de la
// bibliothèque (72 × 10 px) et sur le billet du dialogue d'ajout (96 × 18 px).
// Usage : <span className="bc" style={{ backgroundImage: barcodeCSS(id, 72) }} />
// (la couleur des barres = currentColor : #fff par défaut sur .bc).

import { hashStr, rng } from './random'

export function barcodeCSS(seed: string, width = 72): string {
  const r = rng(hashStr(seed))
  const stops: string[] = []
  let x = 0
  while (x < width) {
    const bw = 1 + Math.floor(r() * 2.6)
    const gap = 1 + Math.floor(r() * 2.2)
    const end = Math.min(width, x + bw)
    stops.push(`currentColor ${x}px ${end}px`, `transparent ${end}px ${Math.min(width, end + gap)}px`)
    x = end + gap
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`
}
