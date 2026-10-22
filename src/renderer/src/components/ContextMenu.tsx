import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Menu contextuel en verre sombre (264 px) : éléments de 30 px, icône 14 px,
// raccourci à droite (« SUPPR »), séparateurs. Élément dangereux : texte neutre,
// seule l'icône est rouge. Placé au pointeur et ramené dans la fenêtre (8 px de
// marge). Échap, clic ailleurs, perte de focus, redimensionnement, molette hors du
// menu ou défilement d'une liste : fermé (le menu ne reste jamais collé à une autre
// ligne ou carte que celle qu'il vise). Flèches haut / bas (+ Début / Fin) pour se
// déplacer, Entrée pour valider.

export interface MenuItem {
  label: string
  /** icône Lucide (reçoit la classe « i » du LucideProvider) */
  icon?: React.ReactNode
  /** texte neutre, icône rouge (« Supprimer… », « Retirer de la bibliothèque ») */
  danger?: boolean
  disabled?: boolean
  /** raccourci affiché à droite, ex. « Suppr » */
  shortcut?: string
  onClick: () => void
}

interface Props {
  x: number
  y: number
  items: (MenuItem | 'sep')[]
  onClose: () => void
}

const MARGIN = 8
/**
 * Défilements ignorés juste après l'ouverture : celui que le navigateur peut faire pour
 * montrer en entier la ligne ou la carte qui vient de prendre le focus (clic droit).
 */
const OPEN_GRACE_MS = 150

export function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  // dernier onClose : les écouteurs de la fenêtre sont posés une seule fois
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })

  // Garde le menu entièrement visible près des bords de la fenêtre (avant l'affichage : aucun saut visible).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(MARGIN, Math.min(x, window.innerWidth - r.width - MARGIN)),
      y: Math.max(MARGIN, Math.min(y, window.innerHeight - r.height - MARGIN))
    })
  }, [x, y, items.length])

  // Le menu prend le focus (pour les flèches) et le rend en se fermant.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const el = ref.current
    el?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      const lost = !active || active === document.body || !!el?.contains(active)
      if (previous && previous.isConnected && lost) previous.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const openedAt = performance.now()
    const close = (): void => closeRef.current()
    const inside = (e: Event): boolean => !!ref.current?.contains(e.target as Node)
    // ligne ou carte visée : l'élément sous le point d'ouverture du menu
    const target = document.elementsFromPoint(x, y).find((el) => !ref.current?.contains(el)) ?? null
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // molette hors du menu : la liste ou la grille dessous va défiler
    const onWheel = (e: WheelEvent): void => {
      if (!inside(e)) close()
    }
    // Tout autre défilement (clavier, barre, programme) de la page ou de la liste qui contient
    // la ligne ou la carte visée. Un autre tableau qui bouge seul (pairs, fichiers) ne ferme rien.
    const onScroll = (e: Event): void => {
      if (performance.now() - openedAt < OPEN_GRACE_MS || inside(e)) return
      const el = e.target
      if (!target || !(el instanceof Node) || el.contains(target)) close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
    // posé une fois à l'ouverture (le menu est recréé pour chaque nouvelle position)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const move = (dir: 1 | -1 | 'first' | 'last'): void => {
    const el = ref.current
    if (!el) return
    const list = [...el.querySelectorAll<HTMLButtonElement>('.mi:not([disabled])')]
    if (!list.length) return
    const cur = list.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      dir === 'first' ? 0 : dir === 'last' ? list.length - 1 : cur === -1 ? (dir === 1 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length
    list[next].focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'Home':
        move('first')
        break
      case 'End':
        move('last')
        break
      case 'Escape':
      case 'Tab':
        onClose()
        break
      case 'Enter':
      case ' ':
        // Entrée / Espace sur un élément : le bouton déclenche son clic lui-même
        if ((e.target as HTMLElement).classList.contains('mi')) return
        e.preventDefault()
        e.stopPropagation()
        return
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={ref}
      className="ctxmenu"
      role="menu"
      tabIndex={-1}
      data-testid="context-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) =>
        item === 'sep' ? (
          <div key={`sep-${i}`} className="msep" role="separator" />
        ) : (
          <button
            key={`${i}-${item.label}`}
            type="button"
            role="menuitem"
            className={`mi${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            data-testid="context-menu-item"
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            {item.icon}
            <span className="ml">{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        )
      )}
    </div>
  )
}
