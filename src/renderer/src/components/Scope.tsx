import { useEffect, useRef, useState } from 'react'
import { createScope, SCOPE_SAMPLES, scopeScale, type Scope as ScopeApi } from '../fx/scope'
import { formatSpeed } from '../format'
import { useT } from '../i18n'
import { locale, t as tr } from '../../../shared/i18n'

// Oscilloscope « TRAFIC · 60 S » en bas de la barre latérale : 60 échantillons
// (un par instantané du moteur, depuis snapshot.global). Redessiné une seule fois
// par seconde, sans boucle. Masqué en mode rail (CSS).

interface Props {
  /** réception globale (octets/s) */
  down: number
  /** émission globale (octets/s) */
  up: number
  /** change à chaque nouvel instantané (heure de réception) : ajoute un échantillon ; 0 = aucun instantané */
  stamp: number
}

/** Échelle « ronde » de l'oscilloscope dans la langue en cours : « 2,5 Mo/s », « 2.5 MB/s ». */
function scaleLabel(max: number): string {
  const units = tr('shell.format.units').split('|')
  let i = 0
  let v = max
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toLocaleString(locale(), { maximumFractionDigits: 1 })} ${units[i]}/s`
}

export function Scope({ down, up, stamp }: Props): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const scope = useRef<ScopeApi | null>(null)
  const history = useRef({ dn: new Array<number>(SCOPE_SAMPLES).fill(0), up: new Array<number>(SCOPE_SAMPLES).fill(0) })
  const lastStamp = useRef(0)
  const { t } = useT()
  const [scale, setScale] = useState(() => scopeScale([]).max)

  useEffect(() => {
    if (!canvas.current) return
    const s = createScope(canvas.current)
    scope.current = s
    const h = history.current
    s.draw(h.dn, h.up, scopeScale([...h.dn, ...h.up]).max)
    return () => {
      s.stop()
      scope.current = null
    }
  }, [])

  useEffect(() => {
    if (!stamp || stamp === lastStamp.current) return
    lastStamp.current = stamp
    const h = history.current
    h.dn = [...h.dn.slice(1), Math.max(0, down || 0)]
    h.up = [...h.up.slice(1), Math.max(0, up || 0)]
    const next = scopeScale([...h.dn, ...h.up])
    scope.current?.draw(h.dn, h.up, next.max)
    setScale(next.max)
  }, [stamp, down, up])

  return (
    <section className="scope" aria-label={t('shell.scope.label')}>
      <div className="side-sec">
        <span className="cap">{t('shell.scope.title')}</span>
        <span className="rule" />
      </div>
      <div className="vals">
        <span title={t('shell.traffic.downTotal')}>
          ↓ <b>{formatSpeed(down)}</b>
        </span>
        <span title={t('shell.traffic.upTotal')}>
          ↑ <b>{formatSpeed(up)}</b>
        </span>
      </div>
      <div className="scope-frame">
        <canvas ref={canvas} aria-hidden="true" />
        <span className="scale">{scaleLabel(scale)}</span>
      </div>
      <div className="axis">
        <span className="cap">{t('shell.scope.ago')}</span>
        <span className="cap">{t('shell.scope.now')}</span>
      </div>
    </section>
  )
}
