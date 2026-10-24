import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CENTROIDS } from '../../../shared/geoCentroids'
import type { PeerInfo, TorrentSummary } from '../../../shared/types'
import { formatPercent, formatSpeed, shownDownload, splitAddress } from '../format'
import { createEarth, type Earth, type EarthPeer } from '../fx/earth'
import { useT } from '../i18n'

// Plaque du globe des pairs (onglet Pairs) : Terre en points qu'on fait tourner (glisser,
// inertie), zoom à la molette ou au pincement, double-clic pour recentrer, rotation lente
// quand on n'y touche pas. Chaque pair est placé à son PAYS réel : le moteur le trouve hors
// ligne dans la table DB-IP livrée avec l'app (main/geoip.ts), aucune adresse ne sort du PC.
// Survol d'un pair : bulle (pays, client, débits, connexion, adresse masquée) ; clic : le
// globe se tourne vers lui. Dessin et gestes : fx/earth.ts.
//
// Le globe est créé UNE fois (à la première ouverture de l'onglet, pour mesurer la plaque),
// puis seulement mis à jour (setPeers). Sa boucle s'arrête quand l'onglet est caché, la
// plaque hors de l'écran, la fenêtre cachée ou un dialogue ouvert, et quand rien ne bouge.

/** échange en cours au-delà de 512 o/s (réception ou émission) : le point pulse */
const ACTIVE = 512

/** Clé stable d'un pair (adresse, numérotée si deux pairs partagent la même). */
function keyed(peers: PeerInfo[]): { p: PeerInfo; key: string }[] {
  const seen = new Map<string, number>()
  return peers.map((p) => {
    const n = seen.get(p.address) ?? 0
    seen.set(p.address, n + 1)
    return { p, key: n ? `${p.address}#${n}` : p.address }
  })
}

/** Poids d'un pair au pas de 0,1 ; l'ancienne valeur reste tant que l'écart est faible (pas de clignotement). */
function weightFor(raw: number, prev: number | undefined): number {
  if (prev !== undefined && Math.abs(raw - prev) < 0.08) return prev
  return Math.round(Math.max(0, Math.min(1, raw)) * 10) / 10
}

/** Adresse masquée pour la bulle : « 81.23.x.x », « 2a01:e0a:x:x:… ». */
export function maskedAddress(address: string): string {
  const { host } = splitAddress(address)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (v4) return `${v4[1]}.${v4[2]}.x.x`
  const bare = host.replace(/^\[|\]$/g, '')
  if (bare.includes(':')) {
    const groups = bare.split(':').filter(Boolean)
    return `${groups.slice(0, 2).join(':')}:x:x:…`
  }
  return '—'
}

// ---------- Pays de l'utilisateur (repère « vous ») : langue puis fuseau du système, sans réseau ----------

/** Quelques fuseaux courants → pays, quand la langue du système ne donne pas de région. */
const TZ_COUNTRY: Record<string, string> = {
  'Europe/Paris': 'FR', 'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH', 'Europe/Luxembourg': 'LU', 'Europe/Monaco': 'MC',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Berlin': 'DE', 'Europe/Vienna': 'AT', 'Europe/Madrid': 'ES',
  'Europe/Lisbon': 'PT', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU',
  'Europe/Athens': 'GR', 'Europe/Bucharest': 'RO', 'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA', 'Europe/Moscow': 'RU',
  'Europe/Istanbul': 'TR', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Phoenix': 'US',
  'America/Los_Angeles': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Toronto': 'CA',
  'America/Montreal': 'CA', 'America/Vancouver': 'CA', 'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR', 'America/Bogota': 'CO', 'America/Lima': 'PE', 'America/Santiago': 'CL',
  'Africa/Casablanca': 'MA', 'Africa/Algiers': 'DZ', 'Africa/Tunis': 'TN', 'Africa/Dakar': 'SN', 'Africa/Abidjan': 'CI',
  'Africa/Lagos': 'NG', 'Africa/Cairo': 'EG', 'Africa/Johannesburg': 'ZA', 'Africa/Nairobi': 'KE', 'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW', 'Asia/Singapore': 'SG',
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dubai': 'AE', 'Asia/Jakarta': 'ID', 'Asia/Bangkok': 'TH',
  'Asia/Manila': 'PH', 'Asia/Ho_Chi_Minh': 'VN', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU',
  'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ', 'Indian/Reunion': 'RE', 'America/Martinique': 'MQ',
  'America/Guadeloupe': 'GP', 'America/Cayenne': 'GF', 'Pacific/Noumea': 'NC', 'Pacific/Tahiti': 'PF'
}

function homeCountry(): string | null {
  try {
    for (const l of navigator.languages ?? [navigator.language]) {
      const region = new Intl.Locale(l).region
      if (region && CENTROIDS[region]) return region
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const cc = TZ_COUNTRY[tz]
    if (cc && CENTROIDS[cc]) return cc
  } catch {
    /* langue ou fuseau illisible : pas de repère « vous » */
  }
  return null
}

/** Nom du pays dans la langue de l'interface (« France », « Allemagne »), sinon le code. */
const namesCache = new Map<string, Intl.DisplayNames | null>()
export function countryName(cc: string, loc: string): string {
  let dn = namesCache.get(loc)
  if (dn === undefined) {
    try {
      dn = new Intl.DisplayNames([loc], { type: 'region' })
    } catch {
      dn = null
    }
    namesCache.set(loc, dn)
  }
  try {
    return dn?.of(cc) ?? cc
  } catch {
    return cc
  }
}

/** « uTP entrant » → « uTP · entrant ». */
const connection = (c: string): string => c.replace(/^(uTP|TCP) /, '$1 · ')

interface Props {
  torrent: TorrentSummary | null
  /** pairs triés par débit total décroissant (même ordre que le tableau) */
  peers: PeerInfo[]
  /** onglet Pairs affiché avec des données : sinon la boucle est figée */
  active: boolean
}

export function PeerGlobe({ torrent, peers, active }: Props): React.JSX.Element {
  const { t, tn, locale } = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const earth = useRef<Earth | null>(null)
  const weights = useRef(new Map<string, number>())
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const home = useMemo(homeCountry, [])
  const youLabel = t('shell.globe.you')

  // Création, à la première ouverture de l'onglet (plaque mesurable).
  useLayoutEffect(() => {
    if (!active || earth.current || !canvasRef.current) return
    const c = home ? CENTROIDS[home] : null
    earth.current = createEarth(canvasRef.current, {
      onHover: setHoverKey,
      tooltip: tipRef.current,
      home: c ? { lat: c[0], lon: c[1] } : null,
      homeLabel: youLabel
    })
  }, [active, home, youLabel])

  // libellé « vous » dans la langue de l'interface
  useEffect(() => {
    const c = home ? CENTROIDS[home] : null
    earth.current?.setHome(c ? { lat: c[0], lon: c[1] } : null, youLabel)
  }, [home, youLabel])

  const list = useMemo(() => keyed(peers.slice(0, 300)), [peers])

  // Pairs du globe à chaque instantané : seuls ceux qui ont un lieu (pays connu).
  useLayoutEffect(() => {
    const g = earth.current
    if (!g) return
    let max = 0
    for (const { p } of list) max = Math.max(max, p.downloadSpeed + p.uploadSpeed)
    const next = new Map<string, number>()
    const out: EarthPeer[] = []
    for (const { p, key } of list) {
      if (p.lat === undefined || p.lon === undefined) continue
      const rate = p.downloadSpeed + p.uploadSpeed
      const w = weightFor(max > 0 ? Math.sqrt(rate / max) : 0, weights.current.get(key))
      next.set(key, w)
      out.push({ key, lat: p.lat, lon: p.lon, w, seed: p.isSeeder, active: rate >= ACTIVE, up: p.uploadSpeed > p.downloadSpeed })
    }
    weights.current = next
    g.setPeers(out)
  }, [list, active])

  // Onglet caché ou détails en route : image figée, aucune boucle.
  useLayoutEffect(() => {
    const g = earth.current
    if (!g) return
    g.hold(!active, 'tab')
    if (active) g.relayout()
  }, [active])

  useEffect(
    () => () => {
      earth.current?.stop()
      earth.current = null
    },
    []
  )

  const n = peers.length
  const idle = n === 0
  let utp = 0
  let tcp = 0
  let other = 0
  const countries = new Set<string>()
  for (const p of peers) {
    if (p.connection.startsWith('uTP')) utp++
    else if (p.connection.startsWith('TCP')) tcp++
    else other++
    if (p.country) countries.add(p.country)
  }
  // torrent complet : réception résiduelle du protocole affichée « — »
  const down = torrent ? shownDownload(torrent) : 0
  const hovered = hoverKey ? list.find((x) => x.key === hoverKey)?.p : undefined

  return (
    <div className={`plate${idle ? ' idle' : ''}`} data-testid="peer-globe">
      <canvas
        ref={canvasRef}
        data-testid="globe-canvas"
        tabIndex={0}
        role="img"
        aria-label={`${tn('shell.globe.label', n)}. ${t('shell.globe.keys')}`}
      />
      <div className="frame brackets" />
      <div className="corner c-tl">
        <span className="cap">{t('shell.globe.swarm')}</span>
        <span className="v">{tn('shell.globe.connected', n)}</span>
        {countries.size > 0 && <span className="v sub">{tn('shell.globe.countries', countries.size)}</span>}
      </div>
      <div className="corner c-tr">
        <span className="cap">↓ {t('shell.globe.download')}</span>
        <span className="v">{down >= 1 ? formatSpeed(down) : <span className="nil">—</span>}</span>
      </div>
      <div className="corner c-bl">
        <span className="cap">{t('shell.globe.seedsPeers')}</span>
        <span className="v">
          {tn('shell.globe.seeds', torrent?.seeds ?? 0)} · {tn('shell.globe.peers', torrent?.peers ?? 0)}
        </span>
      </div>
      <div className="corner c-br">
        <span className="cap">{t('shell.globe.connections')}</span>
        <span className="v">
          uTP {utp} · TCP {tcp}
          {other > 0 && ` · Web ${other}`}
        </span>
      </div>
      {!idle && (
        <div className="globe-foot">
          <span className="hint">{t('shell.globe.hint')}</span>
          <span className="attr" title={t('shell.globe.attributionTitle')}>
            {t('shell.globe.attribution')}
          </span>
        </div>
      )}
      {/* bulle du pair survolé : position (--x, --y, data-side) écrite par le globe à chaque image */}
      <div className="globe-tip" ref={tipRef} data-testid="globe-tooltip" hidden={!hovered} aria-live="polite">
        {hovered && (
          <div className="tip-in">
            <div className="tip-h">
              {hovered.country && <span className="cc">{hovered.country}</span>}
              <span className="nm">{hovered.country ? countryName(hovered.country, locale) : t('shell.globe.unknownCountry')}</span>
            </div>
            <div className="tip-r cl">{hovered.client}</div>
            <div className="tip-r">
              <span className={hovered.downloadSpeed >= 1 ? 'hi' : ''}>↓ {hovered.downloadSpeed >= 1 ? formatSpeed(hovered.downloadSpeed) : '—'}</span>
              <span className="sep">·</span>
              <span className={hovered.uploadSpeed >= 1 ? 'hi' : ''}>↑ {hovered.uploadSpeed >= 1 ? formatSpeed(hovered.uploadSpeed) : '—'}</span>
            </div>
            <div className="tip-r">
              {connection(hovered.connection)}
              <span className="sep">·</span>
              {hovered.isSeeder ? t('shell.globe.tip.seed') : t('shell.globe.tip.peer', { p: formatPercent(hovered.progress) })}
            </div>
            <div className="tip-r ip">{maskedAddress(hovered.address)}</div>
          </div>
        )}
      </div>
      {idle && (
        <div className="plate-empty">
          <span className="cap">{t('shell.globe.empty')}</span>
          <span>{t('shell.globe.emptyHint')}</span>
        </div>
      )}
    </div>
  )
}
