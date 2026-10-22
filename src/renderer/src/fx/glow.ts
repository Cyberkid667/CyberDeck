// Halo pré-calculé (une seule fois) : un drawImage par point lumineux, jamais de shadowBlur.

let sprite: HTMLCanvasElement | null = null

/** Image de 64 × 64 px : dégradé radial blanc (opaque au centre, transparent au bord). */
export function glowSprite(): HTMLCanvasElement {
  if (sprite) return sprite
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.22, 'rgba(255,255,255,0.45)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 64, 64)
  sprite = c
  return c
}
