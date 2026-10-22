import { useLayoutEffect } from 'react'

/**
 * Liste qui défile sans barre visible : classes « scrolls » (elle dépasse) et « at-end » (tout en
 * bas) pour le fondu du bas, mises à jour au défilement et aux changements de taille. key : à
 * changer quand le contenu change (nouvelles lignes).
 */
export function useScrollFade(ref: React.RefObject<HTMLElement | null>, key: string): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const scrolls = el.scrollHeight > el.clientHeight + 1
      el.classList.toggle('scrolls', scrolls)
      el.classList.toggle('at-end', !scrolls || el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // le contenu peut changer de hauteur sans que la liste change de taille
    for (const child of el.children) ro.observe(child)
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [ref, key])
}
