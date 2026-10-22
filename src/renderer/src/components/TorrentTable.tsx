import { ArrowDown, ArrowUp } from 'lucide-react'
import { isValidElement, memo, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { TorrentSummary } from '../../../shared/types'
import {
  countParts,
  formatBytes,
  formatEta,
  formatIndex,
  formatRatio,
  formatSpeed,
  isHashName,
  shownDownload,
  type Filter
} from '../format'
import { useT } from '../i18n'
import { StatusProgress } from './ProgressBar'

// Tableau des torrents (SPEC 5.4) : une seule grille (--cols) partagée par la rangée
// des groupes A TORRENT · B ÉTAT · C DÉBIT · D ESSAIM, l'en-tête collant, les lignes de
// 44 px et la couche des repères verticaux ; pied de liste collant
// « // 08 TORRENTS · 1 SÉLECTIONNÉ · TRI : RÉCEPTION ↓ ». Les lignes sont mémoïsées :
// une ligne n'est recalculée que si une valeur affichée change.

export type SortKey =
  | 'addedAt'
  | 'name'
  | 'size'
  | 'progress'
  | 'downloadSpeed'
  | 'uploadSpeed'
  | 'eta'
  | 'seeds'
  | 'peers'
  | 'ratio'

export interface Sort {
  key: SortKey
  dir: 1 | -1
}

// Libellés : « shell.table.col.<clé> » (en-tête) et « shell.table.sort.<clé> » (pied de liste :
// « TRI : RÉCEPTION ↓ ») ; title : clé de la bulle (sinon « Trier par … »).
const COLUMNS: { key: SortKey; r?: boolean; title?: string }[] = [
  { key: 'addedAt', r: true, title: 'shell.table.addedOrder' },
  { key: 'name' },
  { key: 'size', r: true },
  { key: 'progress' },
  { key: 'downloadSpeed', r: true },
  { key: 'uploadSpeed', r: true },
  { key: 'eta', r: true },
  { key: 'seeds', r: true },
  { key: 'peers', r: true },
  { key: 'ratio', r: true }
]

export function sortValue(t: TorrentSummary, key: SortKey): number | string {
  if (key === 'name') return t.name.toLocaleLowerCase('fr')
  if (key === 'eta') return t.eta ?? Number.POSITIVE_INFINITY
  // tri sur la valeur affichée : les « — » des torrents complets restent dans l'ordre d'ajout
  if (key === 'downloadSpeed') return shownDownload(t)
  return t[key]
}

/** Touches de modification lues par la sélection (clic ou flèches du clavier). */
export type SelectMods = Pick<React.MouseEvent, 'shiftKey' | 'ctrlKey'>

interface Props {
  /** torrents affichés, déjà filtrés et triés */
  torrents: TorrentSummary[]
  /** numéro d'ajout de chaque torrent (colonne #) */
  numbers: Map<string, number>
  selected: Set<string>
  /** ligne dont on voit les détails */
  focusId?: string | null
  /** nombre total de torrents (pied « 03 TORRENTS SUR 8 » ; 0 = liste vide : ni repères ni pied) */
  total?: number
  /** recherche en cours (texte nettoyé) */
  query?: string
  filter?: Filter
  sort: Sort
  onSort: (key: SortKey) => void
  // Méthodes (et non propriétés fléchées) : le gestionnaire d'App reçoit un MouseEvent,
  // les flèches du clavier lui passent seulement Maj et Ctrl.
  onRowClick(id: string, e: SelectMods): void
  onRowDoubleClick: (id: string) => void
  onRowContextMenu: (id: string, e: React.MouseEvent) => void
  /** pastille à droite du nom (Installer, Jouer, En jeu, Installation…) */
  renderAction: (t: TorrentSummary) => ReactNode
  /** état à la place des lignes : aucun torrent, moteur qui démarre, aucun résultat */
  empty: ReactNode
}

/** Gestionnaires transmis aux lignes par une référence stable (les lignes mémoïsées restent à jour). */
interface RowHandlers {
  onRowClick(id: string, e: SelectMods): void
  onRowDoubleClick: (id: string) => void
  onRowContextMenu: (id: string, e: React.MouseEvent) => void
}

/**
 * Empreinte de la pastille (type d'élément, genre, titre) : une ligne n'est redessinée que
 * si sa pastille change d'aspect. Les gestionnaires de la pastille ne lisent que des
 * données qui changent avec elle (jeu lancé, nom du jeu).
 */
function actionSig(node: ReactNode): string {
  if (!isValidElement(node)) return node ? 'x' : ''
  const props = node.props as Record<string, unknown>
  return `${String(node.type)}|${String(props['data-kind'] ?? '')}|${String(props.title ?? '')}|${String(props.className ?? '')}`
}

export function TorrentTable(p: Props): React.JSX.Element {
  const { t, tn, locale } = useT()
  const handlers = useRef<RowHandlers>(p)
  useLayoutEffect(() => {
    handlers.current = p
  })
  const rowsRef = useRef<HTMLDivElement>(null)

  const total = p.total ?? p.torrents.length
  const count = p.torrents.length
  const filtered = !!p.query || (p.filter !== undefined && p.filter !== 'all')
  const nSel = p.selected.size

  // Flèches haut / bas (+ Maj pour étendre), Début / Fin : même effet qu'un clic sur la ligne ;
  // Entrée ouvre le dossier (comme un double-clic).
  function onRowsKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    // seulement quand la ligne elle-même a le focus (Entrée sur une pastille reste un clic sur la pastille)
    const row = e.target as HTMLElement
    if (!row.classList.contains('tr') || !count || e.altKey || e.metaKey) return
    const ids = p.torrents.map((x) => x.id)
    const at = ids.indexOf(row.dataset.id ?? '')
    let next = -1
    if (e.key === 'ArrowDown') next = Math.min(ids.length - 1, at + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = ids.length - 1
    else if (e.key === 'Enter' && at !== -1) {
      e.preventDefault()
      p.onRowDoubleClick(ids[at])
      return
    } else return
    e.preventDefault()
    if (next < 0 || next === at) return
    p.onRowClick(ids[next], { shiftKey: e.shiftKey, ctrlKey: false })
    const el = rowsRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(ids[next])}"]`)
    el?.focus()
  }

  return (
    <section className="tablewrap">
      <div className="tinner gridded" role="grid" aria-label="Torrents" aria-multiselectable="true" aria-rowcount={count + 1}>
        <div className="tcap">
          <div className="tgroups" aria-hidden="true">
            <div style={{ gridColumn: 'span 3' }}>
              <b>A</b>
              {t('shell.table.group.torrent')}
            </div>
            <div style={{ gridColumn: 'span 1' }}>
              <b>B</b>
              {t('shell.table.group.state')}
            </div>
            <div style={{ gridColumn: 'span 3' }}>
              <b>C</b>
              {t('shell.table.group.rate')}
            </div>
            <div style={{ gridColumn: 'span 3' }}>
              <b>D</b>
              {t('shell.table.group.swarm')}
            </div>
          </div>
          <div className="thead" role="row">
            {COLUMNS.map((c) => {
              const on = p.sort.key === c.key
              const label = t(`shell.table.col.${c.key}`)
              return (
                <button
                  key={c.key}
                  type="button"
                  role="columnheader"
                  aria-sort={on ? (p.sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                  className={`th${c.r ? ' r' : ''}${on ? ' sorted' : ''}`}
                  title={c.title ? t(c.title) : t('shell.table.sortBy', { col: label.toLocaleLowerCase(locale) })}
                  onClick={() => p.onSort(c.key)}
                >
                  {label}
                  {on && (p.sort.dir === 1 ? <ArrowUp className="arr" /> : <ArrowDown className="arr" />)}
                </button>
              )
            })}
          </div>
        </div>

        {count > 0 ? (
          <div className="rows" role="rowgroup" ref={rowsRef} onKeyDown={onRowsKey}>
            {p.torrents.map((tor) => {
              const action = p.renderAction(tor)
              return (
                <Row
                  key={tor.id}
                  t={tor}
                  num={p.numbers.get(tor.id) ?? 0}
                  sel={p.selected.has(tor.id)}
                  focus={p.focusId === tor.id}
                  action={action}
                  sig={actionSig(action)}
                  handlers={handlers}
                />
              )
            })}
          </div>
        ) : (
          p.empty
        )}

        {/* remplissage sous les lignes : la grille fine apparaît dans le vide (et un état vide se centre plus haut) */}
        <div className="tfill" />
        {total > 0 && (
          <>
            <div className="tfoot">
              <span className="sl">//</span>
              <b>{formatIndex(count)}</b>
              {`${tn('shell.table.foot.torrents', count)}${filtered ? t('shell.table.foot.of', { total }) : ''}`}
              <span className="dot">·</span>
              <b>{nSel}</b>
              {tn('shell.table.foot.selected', nSel)}
              <span className="dot">·</span>
              {t('shell.table.foot.sort')}
              <b>
                {t(`shell.table.sort.${p.sort.key}`)} {p.sort.dir === 1 ? '↑' : '↓'}
              </b>
            </div>
            <div className="guides" aria-hidden="true">
              <div style={{ gridColumn: 'span 3' }} />
              <div className="g" style={{ gridColumn: 'span 1' }} />
              <div className="g" style={{ gridColumn: 'span 3' }} />
              <div className="g" style={{ gridColumn: 'span 3' }} />
            </div>
          </>
        )}
      </div>
    </section>
  )
}

// ---------- Ligne ----------

interface RowProps {
  t: TorrentSummary
  num: number
  sel: boolean
  focus: boolean
  action: ReactNode
  sig: string
  handlers: React.RefObject<RowHandlers>
}

/** « — » d'une valeur absente (décor, --tx-4). */
const Nil = (): React.JSX.Element => <span className="nil">—</span>

function Count({ n, total }: { n: number; total: number | null }): React.JSX.Element {
  const c = countParts(n, total)
  return (
    <>
      {c.n}
      {c.total && <span className="tot">{c.total}</span>}
    </>
  )
}

const Row = memo(
  function Row({ t, num, sel, focus, action, handlers }: RowProps): React.JSX.Element {
    // redessinée au changement de langue (formats), malgré la comparaison ci-dessous
    const { t: tr } = useT()
    const hash = isHashName(t)
    const dim = t.status === 'paused' || t.status === 'metadata'
    const cls = `tr${focus ? ' focus' : ''}${sel ? ' sel' : ''}`
    // torrent complet : la réception résiduelle (protocole) s'affiche « — »
    const down = shownDownload(t)
    return (
      <div
        className={cls}
        role="row"
        aria-selected={sel}
        tabIndex={-1}
        data-id={t.id}
        data-testid="torrent-row"
        data-status={t.status}
        onMouseDown={(e) => {
          if (e.button === 0) handlers.current.onRowClick(t.id, e)
        }}
        onDoubleClick={() => handlers.current.onRowDoubleClick(t.id)}
        onContextMenu={(e) => handlers.current.onRowContextMenu(t.id, e)}
      >
        <div className="td idx r" role="gridcell">
          {formatIndex(num)}
        </div>
        <div className="td name" role="gridcell">
          {hash ? (
            <span className="nm hash" title={tr('shell.table.unnamedMagnet', { hash: t.id })}>
              {t.id}
            </span>
          ) : (
            <span className={`nm${dim ? ' dim' : ''}`} title={t.name}>
              {t.name}
            </span>
          )}
          {action}
        </div>
        <div className="td r" role="gridcell">
          {t.size > 0 ? formatBytes(t.size) : <Nil />}
        </div>
        <StatusProgress status={t.status} progress={t.progress} error={t.error} />
        <div className={`td r${down >= 1 ? ' hi' : ''}`} role="gridcell">
          {down >= 1 ? formatSpeed(down) : <Nil />}
        </div>
        <div className="td r" role="gridcell">
          {t.uploadSpeed >= 1 ? formatSpeed(t.uploadSpeed) : <Nil />}
        </div>
        <div className="td r" role="gridcell">
          {t.eta !== null && isFinite(t.eta) && t.eta >= 0 ? formatEta(t.eta) : <Nil />}
        </div>
        <div className="td r" role="gridcell">
          <Count n={t.seeds} total={t.seedsTotal} />
        </div>
        <div className="td r" role="gridcell">
          <Count n={t.peers} total={t.peersTotal} />
        </div>
        <div className="td r" role="gridcell">
          {formatRatio(t.ratio)}
        </div>
      </div>
    )
  },
  // Une ligne ne change que si une valeur du torrent, sa sélection, son numéro ou sa pastille change.
  (a, b) => {
    if (a.num !== b.num || a.sel !== b.sel || a.focus !== b.focus || a.sig !== b.sig || a.handlers !== b.handlers) return false
    if (a.t === b.t) return true
    for (const k in b.t) if (a.t[k as keyof TorrentSummary] !== b.t[k as keyof TorrentSummary]) return false
    return true
  }
)
