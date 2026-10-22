import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PeerInfo, TorrentSummary } from '../../../shared/types'
import { countParts, formatSpeed, shownDownload, splitAddress } from '../format'
import { createGlobe, peerLatLon, type Globe, type GlobeCallout, type GlobePeer } from '../fx'
import { useT } from '../i18n'

// Plaque du globe des pairs (onglet Pairs, SPEC 5.8) : sphère de points qui tourne,
// flux vertical du logo, pairs placés par une empreinte de leur adresse (pas une
// géolocalisation), repères A, B, C reliés aux 3 premières lignes du tableau des pairs.
//
// Le globe est créé UNE fois (à la première ouverture de l'onglet, pour mesurer la
// plaque), puis seulement mis à jour : setPeers / setCallouts / set('streamRate').
// La boucle (30 images/s au plus) s'arrête quand l'onglet est caché, la plaque hors
// de l'écran, la fenêtre cachée, un dialogue ouvert, ou quand il n'y a aucun pair.
//
// Les particules et les tirets du flux avancent en « temps × vitesse » : une vitesse
// qui change d'une seconde à l'autre les ferait sauter. Les poids des pairs (pas de
// 0,2) et la vitesse du flux (quelques paliers) ne changent donc qu'au-delà d'un
// petit écart, et les pairs sont passés au globe dans un ordre stable (par adresse).

const MIB = 1024 * 1024
/** Paliers de vitesse du flux : clamp(réception / 8 Mio/s, 0,15, 2,5) arrondi au palier le plus proche. */
const RATE_LEVELS = [0.15, 0.25, 0.4, 0.6, 1, 1.6, 2.5]
/**
 * Repères des 3 pairs les plus rapides. La lettre suit le pair ; la place de l'étiquette
 * (à gauche, à droite en haut ou en bas) est choisie par le globe selon la position du
 * pair sur la sphère (attribut data-slot, voir fx/globe.ts et torrents.css).
 */
const MARKS = ['A', 'B', 'C'] as const
/** Valeur jamais égale à une signature : force l'envoi des repères au globe. */
const RESEND = '\u0000'

/** Vitesse du flux : 0 sans réception (pas de tirets) ; on garde le palier tant que l'écart reste sous 30 %. */
function streamRateFor(prev: number, down: number): number {
  if (!(down >= 1)) return 0
  const raw = Math.min(2.5, Math.max(0.15, down / (8 * MIB)))
  if (prev > 0 && raw >= prev / 1.3 && raw <= prev * 1.3) return prev
  let best = RATE_LEVELS[0]
  for (const l of RATE_LEVELS) if (Math.abs(Math.log(l / raw)) < Math.abs(Math.log(best / raw))) best = l
  return best
}

/** Poids d'un pair au pas de 0,2 ; l'ancienne valeur reste tant que l'écart est faible (pas de clignotement). */
function weightFor(raw: number, prev: number | undefined): number {
  if (prev !== undefined && Math.abs(raw - prev) < 0.14) return prev
  return Math.round(Math.max(0, Math.min(1, raw)) * 5) / 5
}

/** Clé stable d'un pair (adresse, numérotée si deux pairs partagent la même). */
function keyed(peers: PeerInfo[]): { p: PeerInfo; key: string }[] {
  const seen = new Map<string, number>()
  return peers.map((p) => {
    const n = seen.get(p.address) ?? 0
    seen.set(p.address, n + 1)
    return { p, key: n ? `${p.address}#${n}` : p.address }
  })
}

/** Ligne « ↓ 3,82 Mo/s » d'une étiquette (« ↑ » pour un pair qui ne fait que recevoir). */
function rateLine(p: PeerInfo | undefined): string {
  if (!p) return ''
  if (p.downloadSpeed >= 1) return `↓ ${formatSpeed(p.downloadSpeed)}`
  if (p.uploadSpeed >= 1) return `↑ ${formatSpeed(p.uploadSpeed)}`
  return '↓ —'
}

function Count({ n, total }: { n: number; total: number | null }): React.JSX.Element {
  const c = countParts(n, total)
  return (
    <>
      {c.n}
      {c.total && <span className="tot">{c.total}</span>}
    </>
  )
}

interface Props {
  torrent: TorrentSummary | null
  /** pairs triés par débit total décroissant : le même ordre que le tableau (A, B, C = 3 premières lignes) */
  peers: PeerInfo[]
  /** onglet Pairs affiché avec des données : sinon la boucle est figée */
  active: boolean
}

export function PeerGlobe({ torrent, peers, active }: Props): React.JSX.Element {
  const { t, tn } = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const calloutRefs = useRef<(HTMLDivElement | null)[]>([])
  const globe = useRef<Globe | null>(null)
  const sent = useRef({ peers: '', callouts: '', rate: -1 })
  const weights = useRef(new Map<string, number>())

  // Création, à la première ouverture de l'onglet (plaque mesurable : nombre de points « auto »).
  useLayoutEffect(() => {
    if (!active || globe.current || !canvasRef.current) return
    globe.current = createGlobe(canvasRef.current, { dots: 'auto', idleWhenEmpty: true })
    sent.current = { peers: '', callouts: RESEND, rate: -1 }
  }, [active])

  // Mise à jour à chaque instantané (sur le même globe), seulement quand quelque chose change.
  useLayoutEffect(() => {
    const g = globe.current
    if (!g) return
    const top = keyed(peers.slice(0, 200))
    const byKey = [...top].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    let maxDown = 0
    let maxUp = 0
    for (const { p } of top) {
      maxDown = Math.max(maxDown, p.downloadSpeed)
      maxUp = Math.max(maxUp, p.uploadSpeed)
    }
    const nextWeights = new Map<string, number>()
    const list: GlobePeer[] = byKey.map(({ p, key }) => {
      // pair qui ne fait que recevoir de nous : poids d'après l'émission (particules grises vers lui)
      const up = p.downloadSpeed < 1 && p.uploadSpeed >= 1
      const raw = up ? p.uploadSpeed / (maxUp || 1) : p.downloadSpeed / (maxDown || 1)
      const w = weightFor(raw, weights.current.get(key))
      nextWeights.set(key, w)
      return { ...peerLatLon(p.address === '—' ? key : p.address), w, seed: p.isSeeder, up }
    })
    weights.current = nextWeights
    const peersSig = byKey.map(({ key }, i) => `${key}|${list[i].w}|${list[i].seed ? 1 : 0}${list[i].up ? 1 : 0}`).join(';')
    if (peersSig !== sent.current.peers) {
      g.setPeers(list)
      sent.current.peers = peersSig
      // les index ont pu changer : les repères sont toujours renvoyés après une nouvelle liste
      sent.current.callouts = RESEND
    }
    // repères A, B, C : les 3 premiers pairs du tableau, retrouvés dans la liste du globe
    const marks = top.slice(0, 3).map(({ p }) => byKey.findIndex((x) => x.p === p))
    const calloutSig = marks.join(',')
    if (calloutSig !== sent.current.callouts) {
      const list2: GlobeCallout[] = []
      marks.forEach((peer, i) => {
        const el = calloutRefs.current[i]
        if (el && peer >= 0) list2.push({ peer, el, label: MARKS[i] })
      })
      g.setCallouts(list2)
      sent.current.callouts = calloutSig
    }
    const rate = streamRateFor(sent.current.rate, torrent ? shownDownload(torrent) : 0)
    if (rate !== sent.current.rate) {
      g.set('streamRate', rate)
      sent.current.rate = rate
    }
  })

  // Onglet caché ou détails en route : image figée, aucune boucle.
  useLayoutEffect(() => {
    const g = globe.current
    if (!g) return
    g.hold(!active, 'tab')
    if (active) g.relayout()
  }, [active])

  useEffect(
    () => () => {
      globe.current?.stop()
      globe.current = null
    },
    []
  )

  const n = peers.length
  const idle = n === 0
  let utp = 0
  let tcp = 0
  let other = 0
  for (const p of peers) {
    if (p.connection.startsWith('uTP')) utp++
    else if (p.connection.startsWith('TCP')) tcp++
    else other++
  }
  // torrent complet : réception résiduelle du protocole affichée « — » (flux sans tirets)
  const down = torrent ? shownDownload(torrent) : 0

  return (
    <div className={`plate${idle ? ' idle' : ''}`} data-testid="peer-globe">
      <canvas ref={canvasRef} role="img" aria-label={tn('shell.globe.label', n)} />
      <div className="frame brackets" />
      <div className="corner c-tl">
        <span className="cap">{t('shell.globe.swarm')}</span>
        <span className="v">{tn('shell.globe.connected', n)}</span>
      </div>
      <div className="corner c-tr">
        <span className="cap">↓ {t('shell.globe.download')}</span>
        <span className="v">{down >= 1 ? formatSpeed(down) : <span className="nil">—</span>}</span>
      </div>
      <div className="corner c-bl">
        <span className="cap">{t('shell.globe.seedsPeers')}</span>
        <span className="v">
          <Count n={torrent?.seeds ?? 0} total={torrent?.seedsTotal ?? null} /> ·{' '}
          <Count n={torrent?.peers ?? 0} total={torrent?.peersTotal ?? null} />
        </span>
      </div>
      <div className="corner c-br">
        <span className="cap">{t('shell.globe.connections')}</span>
        <span className="v">
          uTP {utp} · TCP {tcp}
          {other > 0 && ` · Web ${other}`}
        </span>
      </div>
      <div className="schem cap" title={t('shell.globe.schematicTitle')}>
        {t('shell.globe.schematic')}
      </div>
      {MARKS.map((label, i) => {
        const p = peers[i]
        const a = p ? splitAddress(p.address) : { host: '', port: '' }
        return (
          // data-slot (place de l'étiquette) est écrit par le globe, jamais par React
          <div
            key={label}
            ref={(el) => {
              calloutRefs.current[i] = el
            }}
            className="callout"
            hidden={!p}
          >
            {/* adresse puis lettre ; à droite, la ligne s'inverse (CSS) : la lettre reste du côté de la sphère */}
            <div className="k">
              <span className="ad" title={p?.address}>
                {p?.address === '—' ? <span className="nil">—</span> : a.host}
                <span className="port">{a.port}</span>
              </span>
              <span className="mk">{label}</span>
            </div>
            <div className="s">{rateLine(p)}</div>
            <div className="s">{p?.client}</div>
          </div>
        )
      })}
      {idle && (
        <div className="plate-empty">
          <span className="cap">{t('shell.globe.empty')}</span>
          <span>{t('shell.globe.emptyHint')}</span>
        </div>
      )}
    </div>
  )
}
