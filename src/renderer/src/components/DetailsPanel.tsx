import { Copy, FolderOpen } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { FileInfo, PeerInfo, TorrentDetails, TorrentSummary, TrackerInfo } from '../../../shared/types'
import {
  formatBytes,
  formatDate,
  formatIndex,
  formatRatio,
  formatSpeed,
  formatTime,
  isHashName,
  shownDownload,
  splitAddress,
  STATUS_LABEL
} from '../format'
import { PeerGlobe } from './PeerGlobe'
import { MiniProgress } from './ProgressBar'

// Panneau de détails (SPEC 5.7) : onglets Fichiers · Infos · Pairs · Trackers avec leurs
// compteurs, nom du torrent et « #03 » à droite ; arbre ASCII des fichiers, fiche à
// pointillés, globe + tableau des pairs (repères A, B, C, port en gris), trackers.
// Le globe reste monté (et figé) quand on change d'onglet : il n'est jamais recréé.

type Tab = 'files' | 'infos' | 'peers' | 'trackers'

const TABS: { id: Tab; label: string }[] = [
  { id: 'files', label: 'Fichiers' },
  { id: 'infos', label: 'Infos' },
  { id: 'peers', label: 'Pairs' },
  { id: 'trackers', label: 'Trackers' }
]
const TAB_KEY = 'essaim.detailsTab'

/** Onglet ouvert : le dernier choisi (mémorisé), sinon Fichiers comme avant la refonte. */
function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    if (TABS.some((t) => t.id === v)) return v as Tab
  } catch {
    // simple confort
  }
  return 'files'
}

function storeTab(tab: Tab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // simple confort
  }
}

/** « — » d'une valeur absente (décor, --tx-4). */
const nil = <span className="nil">—</span>
const speed = (v: number): ReactNode => (v >= 1 ? formatSpeed(v) : nil)

/** Pairs triés par débit total décroissant (A, B, C = les 3 premiers). */
const byRate = (a: PeerInfo, b: PeerInfo): number =>
  b.downloadSpeed + b.uploadSpeed - (a.downloadSpeed + a.uploadSpeed) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)

interface Props {
  torrent: TorrentSummary | null
  details: TorrentDetails | null
  /** hauteur en px (séparateur ; plafonnée par le CSS) */
  height: number
  /** numéro d'ajout du torrent affiché (« #03 ») */
  number?: number | null
  onCopy: (text: string, what: string) => void
  onOpenFolder: (id: string) => void
}

export function DetailsPanel({ torrent, details, height, number, onCopy, onOpenFolder }: Props): React.JSX.Element {
  const [tab, setTabState] = useState<Tab>(readTab)
  const tabsRef = useRef<HTMLDivElement>(null)
  const d = details && torrent && details.id === torrent.id ? details : null
  const peers = useMemo(() => (d ? [...d.peers].sort(byRate) : []), [d])

  const setTab = (t: Tab): void => {
    setTabState(t)
    storeTab(t)
  }

  // Flèches gauche / droite, Début / Fin : onglet voisin (motif « tablist »).
  function onTabsKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    const i = TABS.findIndex((t) => t.id === tab)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft') next = (i + TABS.length - 1) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    else return
    e.preventDefault()
    setTab(TABS[next].id)
    tabsRef.current?.querySelector<HTMLElement>(`#dtab-${TABS[next].id}`)?.focus()
  }

  const counts: Record<Tab, number | undefined> = {
    files: d?.files.length,
    infos: undefined,
    peers: d?.peers.length,
    trackers: d?.trackers.length
  }
  const name = torrent ? (isHashName(torrent) ? torrent.id : torrent.name) : ''

  return (
    <section className="details" style={{ height }} data-testid="details-panel" aria-label="Détails du torrent">
      <div className="tabs" role="tablist" aria-label="Détails du torrent" ref={tabsRef} onKeyDown={onTabsKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`dtab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={tab === t.id ? `dpane-${t.id}` : undefined}
            tabIndex={tab === t.id ? 0 : -1}
            className={`tab${tab === t.id ? ' on' : ''}`}
            data-testid={`details-tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {counts[t.id] !== undefined && <span className="n">{counts[t.id]}</span>}
          </button>
        ))}
        {torrent && (
          <div className="ttl">
            <span className={`nm${isHashName(torrent) ? ' hash' : ''}`} title={name}>
              {name}
            </span>
            {number ? <span className="cap">#{formatIndex(number)}</span> : null}
          </div>
        )}
      </div>

      <div className="dbody">
        {!torrent ? (
          <div className="details-empty">Sélectionne un torrent pour voir ses détails.</div>
        ) : !d ? (
          <div className="loading" aria-busy="true">
            <span className="cap">Chargement…</span>
            <span className="scanbar">
              <i />
            </span>
          </div>
        ) : null}

        {/* Pairs : toujours monté (le globe n'est jamais recréé), affiché seulement sur l'onglet Pairs. */}
        <div
          className={`pane split${d && tab === 'peers' ? ' on' : ''}`}
          id="dpane-peers"
          role="tabpanel"
          aria-labelledby="dtab-peers"
        >
          <PeerGlobe torrent={d ? torrent : null} peers={peers} active={!!d && tab === 'peers'} />
          {d && torrent && tab === 'peers' && <PeersTable peers={peers} paused={torrent.status === 'paused'} />}
        </div>

        {d && torrent && tab === 'files' && (
          <div className="pane on" id="dpane-files" role="tabpanel" aria-labelledby="dtab-files">
            <FilesTree id={d.id} files={d.files} done={torrent.progress >= 1} />
          </div>
        )}
        {d && torrent && tab === 'infos' && (
          <div className="pane on" id="dpane-infos" role="tabpanel" aria-labelledby="dtab-infos">
            <InfosTab torrent={torrent} details={d} onCopy={onCopy} onOpenFolder={onOpenFolder} />
          </div>
        )}
        {d && torrent && tab === 'trackers' && (
          <div className="pane on" id="dpane-trackers" role="tabpanel" aria-labelledby="dtab-trackers">
            <TrackersTable trackers={d.trackers} />
          </div>
        )}
      </div>
    </section>
  )
}

// ---------- Onglet Fichiers : arbre ASCII ----------

interface TreeRow {
  key: string
  /** préfixe ASCII : « |-- », « `-- », « |   » ou 4 espaces par niveau */
  prefix: string
  name: string
  /** chemin complet (title) */
  path: string
  dir: boolean
  /** index des fichiers sous cette ligne (un seul pour un fichier) */
  files: number[]
}

interface Node {
  name: string
  dirs: Map<string, Node>
  files: { name: string; i: number }[]
  all: number[]
}

const newNode = (name: string): Node => ({ name, dirs: new Map(), files: [], all: [] })
const byName = (a: string, b: string): number => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' })

/**
 * Une ligne par dossier et par fichier : chemins découpés par « / » ou « \ », dossiers
 * d'abord puis fichiers, par nom. Préfixes : « |-- » pour un enfant qui n'est pas le
 * dernier, « `-- » pour le dernier, « |   » ou 4 espaces pour les niveaux au-dessus.
 */
function buildTree(files: FileInfo[]): TreeRow[] {
  const root = newNode('')
  files.forEach((f, i) => {
    const parts = f.path.split(/[\\/]+/).filter(Boolean)
    if (!parts.length) parts.push(f.name || '?')
    let node = root
    for (let k = 0; k < parts.length - 1; k++) {
      let next = node.dirs.get(parts[k])
      if (!next) node.dirs.set(parts[k], (next = newNode(parts[k])))
      next.all.push(i)
      node = next
    }
    node.files.push({ name: parts[parts.length - 1], i })
  })
  const rows: TreeRow[] = []
  const walk = (node: Node, depth: number, lead: string, path: string): void => {
    const dirs = [...node.dirs.values()].sort((a, b) => byName(a.name, b.name))
    const leaves = [...node.files].sort((a, b) => byName(a.name, b.name))
    const count = dirs.length + leaves.length
    let k = 0
    for (const dir of dirs) {
      const last = ++k === count
      const p = path ? `${path}/${dir.name}` : dir.name
      rows.push({ key: `d:${p}`, prefix: depth ? lead + (last ? '`-- ' : '|-- ') : '', name: `${dir.name}/`, path: `${p}/`, dir: true, files: dir.all })
      walk(dir, depth + 1, depth ? lead + (last ? '    ' : '|   ') : '', p)
    }
    for (const leaf of leaves) {
      const last = ++k === count
      rows.push({
        key: `f:${leaf.i}`,
        prefix: depth ? lead + (last ? '`-- ' : '|-- ') : '',
        name: leaf.name,
        path: files[leaf.i].path,
        dir: false,
        files: [leaf.i]
      })
    }
  }
  walk(root, 0, '', '')
  return rows
}

const ROW_H = 29
const HEAD_H = 30
/** Au-delà, seules les lignes visibles (± une marge) sont rendues. */
const WINDOW_FROM = 200

/** Lignes visibles d'une liste de hauteur fixe qui défile dans `ref`. */
function useRowWindow(ref: RefObject<HTMLDivElement | null>, count: number): { start: number; end: number } {
  const on = count > WINDOW_FROM
  const [win, setWin] = useState({ start: 0, end: Math.min(count, 60) })
  useLayoutEffect(() => {
    const el = ref.current
    if (!on || !el) return
    const update = (): void => {
      const start = Math.max(0, Math.floor((el.scrollTop - HEAD_H) / ROW_H) - 20)
      const end = Math.min(count, Math.ceil((el.scrollTop + el.clientHeight) / ROW_H) + 20)
      setWin((w) => (w.start === start && w.end === end ? w : { start, end }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [ref, on, count])
  return on ? win : { start: 0, end: count }
}

/** done : torrent complet (le moteur peut annoncer 99,9 % pour un fichier dont toutes les pièces sont là). */
function FilesTree({ id, files, done }: { id: string; files: FileInfo[]; done: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // La structure ne dépend que des chemins (fixes pour un torrent : clé = id + nombre de
  // fichiers) ; tailles et progression sont recalculées à chaque instantané.
  const shape = `${id}:${files.length}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => buildTree(files), [shape])
  const { start, end } = useRowWindow(ref, rows.length)

  if (!files.length)
    return <div className="details-empty">La liste des fichiers arrive dès que les infos du torrent sont reçues.</div>

  const visible = rows.slice(start, end)
  return (
    <div className="dtable ftree" ref={ref}>
      <div className="dhead">
        <div>Nom</div>
        <div className="r">Taille</div>
        <div>Progression</div>
      </div>
      {start > 0 && <div style={{ height: start * ROW_H }} aria-hidden="true" />}
      {visible.map((r) => {
        let size = 0
        let got = 0
        for (const i of r.files) {
          const f = files[i]
          if (!f) continue
          size += f.size
          got += f.size * (done ? 1 : Math.max(0, Math.min(1, f.progress)))
        }
        const progress = done ? 1 : size > 0 ? got / size : r.files.length === 1 ? (files[r.files[0]]?.progress ?? 0) : 0
        return (
          <div className={`drow${r.dir ? ' d' : ''}`} key={r.key}>
            <div title={r.path}>
              {r.prefix && <span className="tw">{r.prefix}</span>}
              <span className={r.dir ? 'dir' : undefined}>{r.name}</span>
            </div>
            <div className="r">{formatBytes(size)}</div>
            <div>
              <MiniProgress value={progress} />
            </div>
          </div>
        )
      })}
      {end < rows.length && <div style={{ height: (rows.length - end) * ROW_H }} aria-hidden="true" />}
    </div>
  )
}

// ---------- Onglet Infos : fiche à pointillés ----------

interface InfosProps {
  torrent: TorrentSummary
  details: TorrentDetails
  onCopy: (text: string, what: string) => void
  onOpenFolder: (id: string) => void
}

function InfosTab({ torrent: t, details: d, onCopy, onOpenFolder }: InfosProps): React.JSX.Element {
  const status = t.status === 'error' ? `Erreur : ${t.error || 'inconnue'}` : STATUS_LABEL[t.status]
  const rows: [string, ReactNode][] = [
    [
      'Statut',
      <span className="ell" title={status}>
        {status}
      </span>
    ],
    [
      'Dossier',
      <>
        <span className="ell" title={t.savePath}>
          {t.savePath}
        </span>
        <button type="button" className="btn btn-line btn-sm" onClick={() => onOpenFolder(t.id)}>
          <FolderOpen />
          Ouvrir
        </button>
      </>
    ],
    ['Taille totale', t.size > 0 ? formatBytes(t.size) : nil],
    // « 2 519 × 4,00 Mo » : espace insécable de pleine chasse (l'espace fine est plus étroite en mono)
    ['Pièces', d.pieceCount > 0 ? `${d.pieceCount.toLocaleString('fr-FR').replace(/ /g, ' ')} × ${formatBytes(d.pieceLength)}` : nil],
    ['Reçu', formatBytes(t.downloadedTotal)],
    ['Envoyé', formatBytes(t.uploadedTotal)],
    ['Ratio', formatRatio(t.ratio)],
    [
      'Vitesses',
      <>
        ↓ {speed(shownDownload(t))}
        {'   '}↑ {speed(t.uploadSpeed)}
      </>
    ],
    ['Ajouté le', formatDate(t.addedAt)],
    ['Terminé le', t.completedAt ? formatDate(t.completedAt) : nil],
    [
      'Hash',
      <>
        <span className="ell sub" title={t.id}>
          {t.id}
        </span>
        <button type="button" className="btn btn-line btn-sm" onClick={() => onCopy(t.id, 'Hash copié')}>
          <Copy />
          Copier
        </button>
      </>
    ],
    [
      'Lien magnet',
      <>
        <span className="ell sub" title={d.magnetURI}>
          {d.magnetURI}
        </span>
        <button type="button" className="btn btn-line btn-sm" onClick={() => onCopy(d.magnetURI, 'Lien magnet copié')}>
          <Copy />
          Copier
        </button>
      </>
    ],
    [
      'Créé par',
      d.createdBy ? (
        <span className="ell" title={d.createdBy}>
          {d.createdBy}
        </span>
      ) : (
        nil
      )
    ],
    ['Créé le', d.createdAt ? formatDate(d.createdAt) : nil],
    [
      'Commentaire',
      d.comment ? (
        <span className="ell" title={d.comment}>
          {d.comment}
        </span>
      ) : (
        nil
      )
    ]
  ]
  return (
    <div className="infos">
      {rows.map(([label, value]) => (
        <div className="irow" key={label}>
          <span className="k">
            <span className="cap">{label}</span>
          </span>
          <span className="v">{value}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- Onglet Pairs : tableau (le globe est dans PeerGlobe) ----------

/** « uTP entrant » → « uTP · entrant ». */
const connection = (c: string): string => c.replace(/^(uTP|TCP) /, '$1 · ')

function PeersTable({ peers, paused }: { peers: PeerInfo[]; paused: boolean }): React.JSX.Element {
  if (!peers.length)
    return (
      <div className="details-empty">
        {paused ? 'Aucun pair connecté pour l’instant. Le torrent est en pause.' : 'Aucun pair connecté pour l’instant.'}
      </div>
    )
  const seen = new Map<string, number>()
  return (
    <div className="dtable peers">
      <div className="dhead">
        <div />
        <div>Adresse</div>
        <div>Client</div>
        <div className="c-conn">Connexion</div>
        <div>Progression</div>
        <div className="r">Réception</div>
        <div className="r">Émission</div>
      </div>
      {peers.map((p, i) => {
        const n = seen.get(p.address) ?? 0
        seen.set(p.address, n + 1)
        const a = splitAddress(p.address)
        const mark = i < 3 ? 'ABC'[i] : null
        return (
          <div className={`drow${mark ? ' mark' : ''}`} key={n ? `${p.address}#${n}` : p.address}>
            <div>{mark && <span className="mk">{mark}</span>}</div>
            {/* source web : pas d'adresse IP (« — ») */}
            <div className="hi" title={p.address === '—' ? p.client : p.address}>
              {p.address === '—' ? nil : a.host}
              {a.port && <span className="port">{a.port}</span>}
            </div>
            <div className="cl" title={p.client}>
              {p.client}
            </div>
            <div className="c-conn">{connection(p.connection)}</div>
            <div>
              <MiniProgress value={p.progress} />
            </div>
            <div className={`r${p.downloadSpeed >= 1 ? ' hi' : ''}`}>{speed(p.downloadSpeed)}</div>
            <div className="r">{speed(p.uploadSpeed)}</div>
          </div>
        )
      })}
    </div>
  )
}

// ---------- Onglet Trackers ----------

const trackerClass = (status: string): string => (status === 'OK' ? 'ok' : status.startsWith('Erreur') ? 'bad' : 'wait')

function TrackersTable({ trackers }: { trackers: TrackerInfo[] }): React.JSX.Element {
  if (!trackers.length) return <div className="details-empty">Aucun tracker : ce torrent trouve ses pairs par le DHT.</div>
  return (
    <div className="dtable trk">
      <div className="dhead">
        <div>Adresse</div>
        <div>État</div>
        <div className="r">Sources</div>
        <div className="r">Pairs</div>
        <div>Dernière réponse</div>
      </div>
      {trackers.map((t) => (
        <div className="drow" key={t.url}>
          <div className="hi" title={t.url}>
            {t.url}
          </div>
          <div className={trackerClass(t.status)} title={t.status}>
            {t.status || 'En contact…'}
          </div>
          <div className="r">{t.seeds ?? nil}</div>
          <div className="r">{t.peers ?? nil}</div>
          <div>{t.lastUpdate ? formatTime(t.lastUpdate, true) : nil}</div>
        </div>
      ))}
    </div>
  )
}
