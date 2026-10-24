import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { percentVar } from '../format'

// Barre de progression « vivante », partagée par les installations de lanceurs (LauncherCard)
// et les téléchargements Steam (DownloadPanel, carte de jeu) : remplissage bleu avec rayures
// qui défilent et reflet pendant le travail, balayage bleu quand la part faite est inconnue
// (jamais une barre figée), grisée en pause, rouge en erreur. Styles : progress.css.
// Mouvement réduit : barre bleue fixe (les animations sont coupées par base.css).
//
// Petits outils qui vont avec : compteur de temps écoulé (« 0:42 ») qui survit au
// redessin de la carte, et débit lissé calculé à partir des octets reçus.

export type LiveMode = 'active' | 'ind' | 'paused' | 'error' | 'done'

interface BarProps {
  /** part faite 0..1 (ignorée en mode 'ind') */
  value: number
  mode: LiveMode
  className?: string
  label?: string
}

export function LiveBar({ value, mode, className, label }: BarProps): React.JSX.Element {
  const known = mode !== 'ind'
  const p = mode === 'done' ? 1 : value
  return (
    <div
      className={`lbar m-${mode}${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? Math.round(Math.max(0, Math.min(1, p)) * 100) : undefined}
    >
      <i className="fill" style={known ? ({ '--p': percentVar(p) } as CSSProperties) : undefined} />
    </div>
  )
}

/** « 0:42 », « 12:05 », « 1:02:05 ». */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

// Début de chaque phase vue (clé → horodatage) : la carte peut changer de groupe ou la page être
// rouverte sans que le compteur reparte de zéro. Une clé pas revue depuis 10 s repart de zéro.
const seen = new Map<string, { since: number; last: number }>()

/**
 * Secondes écoulées depuis la première fois que `key` a été vue (ou depuis `since` s'il est
 * donné) ; se redessine chaque seconde tant que key n'est pas null.
 */
export function useElapsed(key: string | null, since?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!key) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [key])
  if (!key) return 0
  let rec = seen.get(key)
  if (!rec || now - rec.last > 10_000) {
    rec = { since: since ?? now, last: now }
    seen.set(key, rec)
    if (seen.size > 64) seen.delete(seen.keys().next().value as string)
  }
  rec.last = Math.max(rec.last, now)
  return Math.max(0, (now - (since ?? rec.since)) / 1000)
}

/**
 * Débit (octets/s) calculé à partir des octets reçus : moyenne glissante sur les relevés,
 * 0 quand plus rien n'arrive depuis 5 s. key change : on repart de zéro.
 */
export function useRate(bytes: number | null, key: string | null): number {
  const st = useRef<{
    key: string | null
    at: number
    bytes: number
    rate: number
    changed: number
  }>({ key: null, at: 0, bytes: 0, rate: 0, changed: 0 })
  const [, tick] = useState(0)
  const s = st.current
  const now = Date.now()
  if (s.key !== key || bytes === null) {
    st.current = { key, at: now, bytes: bytes ?? 0, rate: 0, changed: now }
  } else if (bytes !== s.bytes) {
    const dt = (now - s.at) / 1000
    if (bytes < s.bytes) st.current = { key, at: now, bytes, rate: 0, changed: now }
    else if (dt >= 0.25) {
      const inst = (bytes - s.bytes) / dt
      st.current = {
        key,
        at: now,
        bytes,
        rate: s.rate ? s.rate * 0.65 + inst * 0.35 : inst,
        changed: now
      }
    }
  }
  // un relevé par seconde au moins : le débit retombe quand le téléchargement cale
  useEffect(() => {
    if (!key) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [key])
  const cur = st.current
  return key && Date.now() - cur.changed < 5000 ? cur.rate : 0
}
