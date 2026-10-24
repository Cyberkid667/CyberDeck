import { Check, CircleAlert, File as FileIcon, FileUp, FolderOpen, Link2, LoaderCircle, Plus, X } from 'lucide-react'
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import type { AddRequest, AddResult, EssaimApi, TorrentFileInfo } from '../../../shared/types'
import { baseName, dirName, errorText, formatBytes } from '../format'
import { barcodeCSS } from '../fx/barcode'
import { createGlobe } from '../fx/globe'
import { t, useT } from '../i18n'

// ==========================================================================
// Socle commun des dialogues (SPEC 5.12), utilisé aussi par RemoveDialog,
// GameDialog et ImportDialog : voile noir, carte en verre dépoli, en-tête
// (légende + titre + « ÉCHAP ✕ »), touches du pied, case à cocher, ligne d'erreur.
// Comportement : focus sur le premier champ à l'ouverture (rendu à la fermeture),
// Tab reste dans le dialogue, Échap et un clic sur le voile ferment (sauf pendant
// un envoi), Entrée lance l'action principale si le dialogue en a une. Les touches
// et le collage ne remontent pas jusqu'aux raccourcis de la fenêtre (Ctrl+N, Suppr…).
// ==========================================================================

export type DialogKind = 'add-torrent' | 'remove' | 'game' | 'import' | 'remove-game' | 'uninstall' | 'launcher-uninstall' | 'settings' | 'twitch-signin'

/** Dialogues ouverts, du plus ancien au plus récent : seul le dernier écoute le clavier de la fenêtre. */
const OPEN: HTMLElement[] = []

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]')].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0
  )
}

interface FrameProps {
  kind: DialogKind
  /** 'plate' : 820 px avec billet à droite (défaut) ; 'single' : 540 px ; 'wide' : 780 px */
  size?: 'plate' | 'single' | 'wide'
  /** id du titre (aria-labelledby) */
  labelledBy: string
  /** envoi en cours : Échap et le clic sur le voile ne ferment pas */
  busy?: boolean
  onClose: () => void
  /** Entrée (hors bouton, menu déroulant et Maj+Entrée) : action principale */
  onEnter?: () => void
  /** champ qui reçoit le focus à l'ouverture (sinon le premier champ) */
  initialFocus?: RefObject<HTMLElement | null>
  /** colonne de droite (billet) */
  aside?: ReactNode
  children: ReactNode
}

export function DialogFrame({
  kind,
  size = 'plate',
  labelledBy,
  busy = false,
  onClose,
  onEnter,
  initialFocus,
  aside,
  children
}: FrameProps): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const live = useRef({ busy, onClose, onEnter })
  useLayoutEffect(() => {
    live.current = { busy, onClose, onEnter }
  })

  // Ouverture : focus sur le champ voulu ; fermeture : le focus revient où il était.
  useEffect(() => {
    const root = box.current
    if (!root) return
    const before = document.activeElement as HTMLElement | null
    OPEN.push(root)
    const target = initialFocus?.current ?? focusables(root).find((el) => !el.classList.contains('xbtn')) ?? root
    target.focus()
    return () => {
      OPEN.splice(OPEN.indexOf(root), 1)
      if (before && before !== document.body && before.isConnected) before.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus hors du dialogue (après un clic sur un toast, par exemple) : Échap ferme quand même,
  // Tab revient dans le dialogue, et les raccourcis de la fenêtre restent bloqués.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const root = box.current
      if (!root || OPEN[OPEN.length - 1] !== root || root.contains(e.target as Node)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!live.current.busy) live.current.onClose()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        ;(focusables(root)[0] ?? root).focus()
      } else if (!(e.ctrlKey || e.metaKey || e.key === 'Delete')) return
      e.stopPropagation()
    }
    const onPaste = (e: ClipboardEvent): void => {
      const root = box.current
      if (root && OPEN[OPEN.length - 1] === root && !root.contains(e.target as Node)) e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('paste', onPaste, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('paste', onPaste, true)
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // rien ne remonte jusqu'aux raccourcis de la fenêtre
    e.stopPropagation()
    const root = box.current
    if (!root) return
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!live.current.busy) live.current.onClose()
    } else if (e.key === 'Tab') {
      const items = focusables(root)
      const active = document.activeElement
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    } else if (e.key === 'Enter' && live.current.onEnter && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.nativeEvent.isComposing) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'A') return
      e.preventDefault()
      live.current.onEnter()
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={box}
        className={`dialog${size === 'plate' ? '' : ` ${size}`}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
        data-testid="dialog"
        data-dialog={kind}
        onKeyDown={onKeyDown}
        onPaste={(e) => e.stopPropagation()}
      >
        <div className="dform">{children}</div>
        {aside}
      </div>
    </div>
  )
}

/** En-tête : légende numérotée + titre mono 300 26 px ; à droite « ÉCHAP ✕ ». */
export function DialogHead({
  id,
  cap,
  title,
  onClose,
  busy
}: {
  id: string
  cap: string
  title: string
  onClose: () => void
  busy?: boolean
}): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="dhead-row">
      <div className="dtitle">
        <span className="cap">{cap}</span>
        <h2 id={id}>{title}</h2>
      </div>
      <button type="button" className="xbtn" aria-label={t('shell.common.close')} title={t('shell.dialog.closeTitle')} disabled={busy} onClick={onClose}>
        <span className="cap">{t('shell.keys.esc')}</span>
        <X />
      </button>
    </div>
  )
}

/** Touches dessinées du pied : [touche, action] (« ENTRÉE ajouter », « ÉCHAP fermer »). */
export function Keys({ keys }: { keys: [string, string][] }): React.JSX.Element {
  return (
    <span className="keys">
      {keys.map(([key, action]) => (
        <Fragment key={key}>
          <kbd className="k">{key}</kbd>
          <span className="cap">{action}</span>
        </Fragment>
      ))}
    </span>
  )
}

/** Ligne d'erreur : 18 px réservés (rien ne saute), icône + phrase en rouge. */
export function ErrorLine({ message }: { message: string | null | undefined }): React.JSX.Element {
  return (
    <div className="derr" role="alert">
      {message ? (
        <>
          <CircleAlert />
          {message}
        </>
      ) : null}
    </div>
  )
}

/** Coche noire de la case (.cbox) : trait 3, visible quand la case est cochée. */
export function CheckMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/** Texte qui peut se couper après « - » ou « _ » (noms de fichiers sans espace) ; ailleurs, overflow-wrap coupe au besoin. */
export function Breakable({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(?<=[-_\\/])/)
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {p}
        </Fragment>
      ))}
    </>
  )
}

// ==========================================================================
// Ajouter un torrent (SPEC 5.12) : lien magnet (détecté dans le presse-papiers)
// ou fichier .torrent (bouton ou glisser-déposer), dossier de destination, et à
// droite le billet « Lecture du lien » : nom, empreinte et trackers lus sur place
// dans le texte du lien. Rien ne part sur le réseau avant « Ajouter ».
// ==========================================================================

export interface AddPreset {
  magnet?: string
  filePath?: string
}

/**
 * Lecture locale d'un .torrent par le processus principal (SPEC 5.12, window.essaim.inspectTorrentFile) :
 * nom, taille, fichiers, pièces, empreinte. Si l'appel manquait (ancien preload), le billet
 * n'afficherait que le nom du fichier.
 */
export type { TorrentFileInfo }
type InspectApi = Omit<EssaimApi, 'inspectTorrentFile'> & { inspectTorrentFile?: EssaimApi['inspectTorrentFile'] }

/** Ce qu'on lit d'un lien magnet, sans rien envoyer sur le réseau. */
export interface MagnetReading {
  text: string
  /** commence par « magnet:? » */
  magnet: boolean
  /** nom annoncé (dn) */
  name: string | null
  /** empreinte (xt=urn:btih:…) en majuscules, telle qu'écrite */
  hash: string | null
  /** longueur attendue de l'empreinte : 40 (hexadécimal) ou 32 (base 32) */
  expected: number
  /** nombre de trackers (tr) */
  trackers: number
  /** taille annoncée (xl), en octets */
  size: number | null
  /** lien complet, prêt à être ajouté */
  ok: boolean
  /** l'empreinte est lisible (le lien peut quand même être invalide ailleurs) */
  hashOk: boolean
  /** « Incomplet » ou « Invalide » (bandeau du billet), dans la langue en cours */
  verdict: string | null
  /** phrase d'erreur sous le formulaire, dans la langue en cours */
  problem: string | null
  /** l'empreinte contient des caractères qui n'ont rien à y faire */
  odd: boolean
}

const HEX = /^[0-9a-f]*$/i
const B32 = /^[a-z2-7]*$/i

/** Décodage comme magnet-uri (dn : %XX puis « + » → espace) ; null si un « % » est mal encodé (le moteur refuserait le lien). */
function decodePart(v: string, plus = false): string | null {
  try {
    const d = decodeURIComponent(v)
    return plus ? d.replace(/\+/g, ' ') : d
  } catch {
    return null
  }
}

export function readMagnet(raw: string): MagnetReading {
  const text = raw.trim()
  const r: MagnetReading = {
    text,
    magnet: false,
    name: null,
    hash: null,
    expected: 40,
    trackers: 0,
    size: null,
    ok: false,
    hashOk: false,
    verdict: null,
    problem: null,
    odd: false
  }
  if (!text) return r
  // Mêmes règles que le moteur (parse-torrent → magnet-uri) : préfixe exact, clés exactes, un seul « = »
  // par paramètre (sinon il est ignoré), « xt » lu tel quel, « dn » et « tr » décodés.
  const invalid = t('shell.add.verdict.invalid')
  const incomplete = t('shell.add.verdict.incomplete')
  if (!text.startsWith('magnet:?')) return { ...r, verdict: invalid, problem: t('shell.add.problem.prefix') }
  r.magnet = true
  // Deux liens collés bout à bout (ou le même lien collé deux fois) : le moteur ne lirait que
  // le premier, avec un dernier paramètre abîmé (« …:80magnet:?xt=… »). Refusé.
  const finish = (): MagnetReading => {
    if (text.indexOf('magnet:?', 1) !== -1) {
      r.ok = false
      r.verdict = invalid
      r.problem = t('shell.add.problem.several')
    }
    return r
  }
  let btih: string | null = null
  let garbled = false
  const trackers = new Set<string>()
  for (const part of (text.split('magnet:?')[1] ?? '').split('&')) {
    const kv = part.split('=')
    if (kv.length !== 2) continue
    const [key, raw] = kv
    if (key === 'xt') {
      const m = /^urn:btih:(.*)$/.exec(raw)
      if (m && btih === null) btih = m[1]
    } else if (key === 'dn') {
      const v = decodePart(raw, true)
      if (v === null) garbled = true
      else if (r.name === null && v.trim()) r.name = v.trim()
    } else if (key === 'tr') {
      const v = decodePart(raw)
      if (v === null) garbled = true
      else if (v.trim()) trackers.add(v.trim())
    } else if (key === 'xl') {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) r.size = n
    }
  }
  r.trackers = trackers.size
  const garbledProblem = t('shell.add.problem.garbled')
  if (btih === null) {
    r.verdict = garbled ? invalid : incomplete
    r.problem = garbled ? garbledProblem : t('shell.add.problem.noHash')
    return finish()
  }
  r.hash = btih.toUpperCase()
  const len = btih.length
  // comme magnet-uri : les 40 premiers caractères en hexadécimal, sinon les 32 premiers en base 32
  // (le reste est ignoré) ; une empreinte coupée ou qui contient d'autres caractères ne marcherait pas
  if (len >= 40 && HEX.test(btih.slice(0, 40))) {
    r.hashOk = true
    r.hash = r.hash.slice(0, 40)
  } else if (len >= 32 && len < 40 && B32.test(btih.slice(0, 32)) && !(len > 32 && HEX.test(btih))) {
    r.hashOk = true
    r.expected = 32
    r.hash = r.hash.slice(0, 32)
  }
  if (r.hashOk) {
    r.ok = !garbled
    if (garbled) {
      r.verdict = invalid
      r.problem = garbledProblem
    }
  } else if (len < 40 && HEX.test(btih)) {
    r.verdict = incomplete
    r.problem = t('shell.add.problem.hashLength', { n: 40 })
  } else if (B32.test(btih) && len < 32) {
    r.expected = 32
    r.verdict = incomplete
    r.problem = t('shell.add.problem.hashLength', { n: 32 })
  } else {
    r.odd = true
    r.verdict = invalid
    r.problem = t('shell.add.problem.oddHash')
  }
  return finish()
}

/** Empreinte en groupes de 4 caractères, 5 groupes par ligne (4 pour une empreinte en base 32). */
function hashLines(hash: string, perLine: number): string[] {
  const groups = hash.match(/.{1,4}/g) ?? []
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += perLine) lines.push(groups.slice(i, i + perLine).join(' '))
  return lines
}

/** Nom de fichier : l'extension (« .iso », « .iso.torrent ») en --tx-3. */
function NameLine({ name }: { name: string }): React.JSX.Element {
  const m = /(\.[a-z][a-z0-9]{1,7}){1,2}$/i.exec(name)
  const base = m && m.index > 0 ? name.slice(0, m.index) : name
  const ext = m && m.index > 0 ? m[0] : ''
  return (
    <div className="dn" title={name}>
      <Breakable text={base} />
      {ext && (
        <span>
          <Breakable text={ext} />
        </span>
      )}
    </div>
  )
}

function HashBlock({ hash, perLine, bad, sub }: { hash: string; perLine: number; bad?: boolean; sub?: string }): React.JSX.Element {
  const lines = hash ? hashLines(hash, perLine) : []
  return (
    <div className={`hash${bad ? ' bad' : ''}`}>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {l}
        </Fragment>
      ))}
      {sub && (
        <>
          {lines.length > 0 && <br />}
          <span className="sub">{sub}</span>
        </>
      )}
    </div>
  )
}

const Star = (): React.JSX.Element => (
  <svg className="star" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.2} aria-hidden="true">
    <path d="M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9 4.9 19.1" />
  </svg>
)

/** Sphère de points balayée par une ligne de lecture (globe en mode scan, sans pair) ; tourne même dialogue ouvert. */
function TicketSphere(): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const globe = createGlobe(c, {
      dots: 980,
      radius: 0.39,
      rmaxW: 0.4,
      cy: 0.5,
      flows: false,
      dust: 16,
      scan: true,
      spin: (Math.PI * 2) / 90,
      streamRate: 0.7,
      seed: 9,
      t0: 1.1,
      holdable: false
    })
    return () => globe.stop()
  }, [])
  return (
    <div className="sph">
      <canvas ref={canvas} aria-hidden="true" />
      <div className="frame brackets" />
    </div>
  )
}

interface TicketProps {
  mode: 'magnet' | 'file'
  reading: MagnetReading
  filePath: string
  dropped: boolean
  /** undefined : pas encore lu (ou lecture impossible ici) ; null : illisible */
  fileInfo: TorrentFileInfo | null | undefined
  canInspect: boolean
}

/** Billet « Lecture du lien » / « Lecture du fichier » (colonne droite, 292 px ; 244 sous 1100 px). */
function LinkTicket({ mode, reading, filePath, dropped, fileInfo, canInspect }: TicketProps): React.JSX.Element {
  const { t, tn, locale } = useT()
  const file = mode === 'file'
  const title = file ? t('shell.add.ticket.file') : t('shell.add.ticket.link')

  let state: ReactNode
  let info: ReactNode
  if (!file) {
    state = !reading.text ? (
      <span className="cap state wait">{t('shell.add.state.waiting')}</span>
    ) : reading.ok ? (
      <span className="cap state">
        <Check />
        {t('shell.add.state.valid')}
      </span>
    ) : (
      <span className="cap state bad">
        <X />
        {reading.verdict}
      </span>
    )
    if (!reading.text || !reading.magnet) {
      info = (
        <>
          <p className="note">
            {reading.text ? t('shell.add.note.prefix') : t('shell.add.note.pasteLink')}
          </p>
          <div className="foot">
            <div>
              <span className="cap">{t('shell.add.ticket.localLink')}</span>
            </div>
            <Star />
          </div>
        </>
      )
    } else {
      const perLine = reading.expected === 32 ? 4 : 5
      const count = reading.hash?.length ?? 0
      info = (
        <>
          <div>
            <span className="cap">{t('shell.add.ticket.name')}</span>
            {reading.name ? <NameLine name={reading.name} /> : <div className="dn mute">{t('shell.add.ticket.noName')}</div>}
          </div>
          <div>
            <span className="cap">{t('shell.add.ticket.hash')}</span>
            {reading.hashOk ? (
              <HashBlock hash={reading.hash ?? ''} perLine={perLine} />
            ) : reading.hash === null ? (
              <HashBlock hash="" perLine={perLine} bad sub={t('shell.add.ticket.hashMissing')} />
            ) : (
              <HashBlock
                hash={reading.hash}
                perLine={perLine}
                bad
                sub={reading.odd ? t('shell.add.ticket.oddChars') : tn('shell.add.ticket.hashCount', count, { expected: reading.expected })}
              />
            )}
          </div>
          <div className="kv">
            <div>
              <span className="cap">Trackers</span>
              <span className="v">{reading.trackers}</span>
            </div>
            <div>
              <span className="cap">DHT</span>
              <span className="v">{t('shell.add.ticket.yes')}</span>
            </div>
            {reading.ok && (
              <div>
                <span className="cap">{t('shell.add.ticket.size')}</span>
                {reading.size ? <span className="v">{formatBytes(reading.size)}</span> : <span className="v mute">{t('shell.add.ticket.sizeLater')}</span>}
              </div>
            )}
          </div>
          {reading.ok && (
            <div className="foot">
              <div>
                <span className="bc" style={{ backgroundImage: barcodeCSS(reading.hash ?? '', 96) }} />
                <span className="cap">{t('shell.add.ticket.localLink')}</span>
              </div>
              <Star />
            </div>
          )}
        </>
      )
    }
  } else {
    const how = dropped ? t('shell.add.file.dropped') : t('shell.add.file.chosen')
    state = !filePath ? (
      <span className="cap state wait">{t('shell.add.state.waiting')}</span>
    ) : canInspect && fileInfo === undefined ? (
      <span className="cap state wait">{t('shell.add.state.reading')}</span>
    ) : fileInfo === null ? (
      <span className="cap state bad">
        <X />
        {t('shell.add.state.unreadable')}
      </span>
    ) : (
      <span className="cap state">
        <Check />
        {fileInfo ? t('shell.add.state.valid') : how}
      </span>
    )
    if (!filePath) {
      info = <p className="note">{t('shell.add.note.pickFile')}</p>
    } else if (fileInfo) {
      info = (
        <>
          <div>
            <span className="cap">{t('shell.add.ticket.file1')}</span>
            <NameLine name={baseName(filePath)} />
          </div>
          <div className="kv">
            <div>
              <span className="cap">{t('shell.add.ticket.files')}</span>
              <span className="v">{fileInfo.files.toLocaleString(locale)}</span>
            </div>
            <div>
              <span className="cap">{t('shell.add.ticket.size')}</span>
              <span className="v">{formatBytes(fileInfo.size)}</span>
            </div>
            <div>
              <span className="cap">{t('shell.add.ticket.pieces')}</span>
              <span className="v">{fileInfo.pieces.toLocaleString(locale)}</span>
            </div>
          </div>
          <div>
            <span className="cap">{t('shell.add.ticket.hash')}</span>
            <HashBlock hash={fileInfo.infoHash.toUpperCase()} perLine={5} />
          </div>
          <div className="foot">
            <div>
              <span className="bc" style={{ backgroundImage: barcodeCSS(fileInfo.infoHash.toLowerCase(), 96) }} />
              <span className="cap">{t('shell.add.ticket.localFile')}</span>
            </div>
          </div>
        </>
      )
    } else {
      info = (
        <>
          <div>
            <span className="cap">{t('shell.add.ticket.file1')}</span>
            <NameLine name={baseName(filePath)} />
          </div>
          <div>
            <span className="cap">{t('shell.add.ticket.location')}</span>
            <div className="path" title={dirName(filePath)}>
              <Breakable text={dirName(filePath)} />
            </div>
          </div>
          {fileInfo === null ? (
            <p className="note bad">{t('shell.add.note.badFile')}</p>
          ) : canInspect ? (
            <p className="note">{t('shell.add.note.readingFile')}</p>
          ) : (
            <p className="note">{t('shell.add.note.afterAdd')}</p>
          )}
          <div className="foot">
            <div>
              <span className="bc" style={{ backgroundImage: barcodeCSS(filePath.toLowerCase(), 96) }} />
              <span className="cap">{t('shell.add.ticket.localFileOnly')}</span>
            </div>
          </div>
        </>
      )
    }
  }

  return (
    <aside className="dplate" aria-label={title}>
      <div className="ticket">
        <div className="band">
          <span className="cap">{title}</span>
          {state}
        </div>
        <TicketSphere />
        <div className="perf" />
        <div className="info">{info}</div>
      </div>
    </aside>
  )
}

interface Props {
  preset: AddPreset
  defaultSavePath: string
  /** espace libre du disque du dossier par défaut (instantané du moteur), null si inconnu */
  freeSpace?: number | null
  onClose: () => void
  onAdded: (name: string) => void
}

type ErrorField = 'source' | 'folder' | null

/** Lettre du disque d'un chemin Windows (« C »), sinon null. */
const driveOf = (p: string): string | null => /^([a-z]):/i.exec(p.trim())?.[1].toUpperCase() ?? null

/** Hauteur du lien magnet : 3 à 5 lignes entières de 18 px, puis défilement sans barre avec un fondu. */
const MIN_LINES = 3
const MAX_LINES = 5

export function AddDialog({ preset, defaultSavePath, freeSpace = null, onClose, onAdded }: Props): React.JSX.Element {
  const { t, lang } = useT()
  const [mode, setMode] = useState<'magnet' | 'file'>(preset.filePath ? 'file' : 'magnet')
  const [magnet, setMagnet] = useState(preset.magnet ?? '')
  const [filePath, setFilePath] = useState(preset.filePath ?? '')
  const [dropped, setDropped] = useState(!!preset.filePath)
  const [fileInfo, setFileInfo] = useState<TorrentFileInfo | null | undefined>(undefined)
  const [savePath, setSavePath] = useState(defaultSavePath)
  const [fromClipboard, setFromClipboard] = useState(false)
  // le lien a été collé, déposé ou quitté : ses défauts s'affichent en rouge (pas pendant la frappe d'un lien vide)
  const [checked, setChecked] = useState(!!preset.magnet)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field: ErrorField } | null>(null)
  const [fit, setFit] = useState({ lines: MIN_LINES, scroll: false })
  // lien long qui défile : le fondu du bas disparaît quand on est tout en bas
  const [atEnd, setAtEnd] = useState(false)
  const magnetRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLButtonElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const magnetTab = useRef<HTMLButtonElement>(null)
  const fileTab = useRef<HTMLButtonElement>(null)
  const magnetNow = useRef(magnet)
  const focusAfter = useRef<'field' | 'radio' | null>(null)
  const firstPreset = useRef(preset)
  useLayoutEffect(() => {
    magnetNow.current = magnet
  })

  // lang : les phrases du lien suivent la langue de l'interface
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reading = useMemo(() => readMagnet(magnet), [magnet, lang])
  const canInspect = typeof (window.essaim as InspectApi).inspectTorrentFile === 'function'

  // Lien magnet trouvé dans le presse-papiers à l'ouverture (si le champ est encore vide).
  useEffect(() => {
    if (preset.magnet || preset.filePath) return
    let off = false
    window.essaim
      .readClipboardMagnet()
      .then((m) => {
        if (off || !m || magnetNow.current) return
        setMagnet(m)
        setFromClipboard(true)
        setChecked(true)
      })
      .catch(() => {})
    return () => {
      off = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Un autre fichier déposé pendant que le dialogue est ouvert : il remplace le précédent.
  useEffect(() => {
    if (preset === firstPreset.current) return
    firstPreset.current = preset
    if (preset.filePath) {
      setMode('file')
      setFilePath(preset.filePath)
      setDropped(true)
      setError(null)
    } else if (preset.magnet) {
      setMode('magnet')
      setMagnet(preset.magnet)
      setFromClipboard(false)
      setChecked(true)
      setError(null)
    }
  }, [preset])

  // Lecture locale du .torrent (si le processus principal la propose).
  useEffect(() => {
    setFileInfo(undefined)
    const inspect = (window.essaim as InspectApi).inspectTorrentFile
    if (!filePath || typeof inspect !== 'function') return
    let off = false
    inspect(filePath).then(
      (info) => !off && setFileInfo(info ?? null),
      () => !off && setFileInfo(null)
    )
    return () => {
      off = true
    }
  }, [filePath])

  // Hauteur du lien : n lignes × 18 px + 22 px, mesurée avec la vraie police.
  const measure = useCallback(() => {
    const ta = magnetRef.current
    if (!ta) return
    ta.style.setProperty('--lines', String(MIN_LINES))
    const n = Math.round((ta.scrollHeight - 20) / 18)
    const next = { lines: Math.max(MIN_LINES, Math.min(MAX_LINES, n)), scroll: n > MAX_LINES }
    ta.style.setProperty('--lines', String(next.lines))
    setFit((cur) => (cur.lines === next.lines && cur.scroll === next.scroll ? cur : next))
    setAtEnd(ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 2)
  }, [])
  const trackEnd = (e: React.UIEvent<HTMLTextAreaElement>): void => {
    const ta = e.currentTarget
    setAtEnd(ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 2)
  }
  useLayoutEffect(measure, [magnet, mode, measure])
  useEffect(() => {
    let off = false
    document.fonts?.ready.then(() => !off && measure())
    window.addEventListener('resize', measure)
    return () => {
      off = true
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  // Après un changement de source : focus sur le champ (clic) ou sur le choix (flèches).
  useEffect(() => {
    const f = focusAfter.current
    focusAfter.current = null
    if (f === 'radio') (mode === 'magnet' ? magnetTab : fileTab).current?.focus()
    else if (f === 'field') (mode === 'magnet' ? magnetRef : filePath ? submitRef : fileRef).current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const switchMode = (next: 'magnet' | 'file', focus: 'field' | 'radio'): void => {
    if (busy) return
    if (next === mode) {
      if (focus === 'radio') (next === 'magnet' ? magnetTab : fileTab).current?.focus()
      return
    }
    focusAfter.current = focus
    setMode(next)
    setError(null)
  }

  async function pickFile(): Promise<void> {
    const p = await window.essaim.pickTorrentFile()
    if (!p) return
    setFilePath(p)
    setDropped(false)
    setError(null)
    // Entrée ajoute (le bouton du fichier rouvrirait le sélecteur)
    submitRef.current?.focus()
  }

  async function pickFolder(): Promise<void> {
    const p = await window.essaim.pickFolder(savePath)
    if (p) {
      setSavePath(p)
      if (error?.field === 'folder') setError(null)
    }
  }

  const fail = (text: string, field: ErrorField): void => {
    setError({ text, field })
    if (field === 'source') (mode === 'magnet' ? magnetRef : fileRef).current?.focus()
  }

  async function submit(): Promise<void> {
    if (busy) return
    let source: AddRequest['source']
    if (mode === 'magnet') {
      const text = magnet.trim()
      if (!text) return fail(t('shell.add.error.noLink'), 'source')
      if (!reading.ok) {
        setChecked(true)
        setError(null)
        magnetRef.current?.focus()
        return
      }
      source = { kind: 'magnet', magnet: text }
    } else {
      if (!filePath) return fail(t('shell.add.error.noFile'), 'source')
      source = { kind: 'file', filePath }
    }
    if (!savePath.trim()) return fail(t('shell.add.error.noFolder'), 'folder')
    setBusy(true)
    setError(null)
    let res: AddResult
    try {
      res = await window.essaim.add({ source, savePath })
    } catch (err) {
      res = { ok: false, error: errorText(err) }
    }
    setBusy(false)
    if (res.ok) {
      onAdded(mode === 'file' ? baseName(filePath) : (reading.name ?? t('shell.add.magnetLink')))
      onClose()
      return
    }
    setError({ text: res.error ?? t('shell.add.error.failed'), field: null })
    // les champs étaient désactivés pendant l'envoi : le focus revient sur la source
    requestAnimationFrame(() => (mode === 'magnet' ? magnetRef : submitRef).current?.focus())
  }

  const linkProblem = mode === 'magnet' && checked && reading.text ? reading.problem : null
  const message = error?.text ?? linkProblem
  const sourceInvalid = (error?.field === 'source' || (!error && !!linkProblem)) && !busy
  const folderInvalid = error?.field === 'folder'

  const drive = driveOf(savePath)
  const freeLabel =
    freeSpace !== null && freeSpace !== undefined && freeSpace >= 0 && drive && drive === driveOf(defaultSavePath)
      ? t('shell.add.free', { size: formatBytes(freeSpace), drive })
      : null

  const onSegKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      switchMode(mode === 'magnet' ? 'file' : 'magnet', 'radio')
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      switchMode(e.key === 'Home' ? 'magnet' : 'file', 'radio')
    }
  }

  return (
    <DialogFrame
      kind="add-torrent"
      labelledBy="add-title"
      busy={busy}
      onClose={onClose}
      onEnter={submit}
      initialFocus={mode === 'magnet' ? magnetRef : filePath ? submitRef : fileRef}
      aside={
        <LinkTicket mode={mode} reading={reading} filePath={filePath} dropped={dropped} fileInfo={fileInfo} canInspect={canInspect} />
      }
    >
      <DialogHead id="add-title" cap={t('shell.add.cap')} title={t('shell.add.title')} onClose={onClose} busy={busy} />

      <div className="dseg">
        <div className="seg big" role="radiogroup" aria-label={t('shell.add.source')} onKeyDown={onSegKey}>
          <button
            ref={magnetTab}
            type="button"
            role="radio"
            aria-checked={mode === 'magnet'}
            tabIndex={mode === 'magnet' ? 0 : -1}
            className={mode === 'magnet' ? 'on' : ''}
            disabled={busy}
            data-testid="add-tab-magnet"
            onClick={() => switchMode('magnet', 'field')}
          >
            <Link2 />
            {t('shell.add.tab.magnet')}
          </button>
          <button
            ref={fileTab}
            type="button"
            role="radio"
            aria-checked={mode === 'file'}
            tabIndex={mode === 'file' ? 0 : -1}
            className={mode === 'file' ? 'on' : ''}
            disabled={busy}
            data-testid="add-tab-file"
            onClick={() => switchMode('file', 'field')}
          >
            <FileUp />
            {t('shell.add.tab.file')}
          </button>
        </div>
      </div>

      {mode === 'magnet' ? (
        <div className="field">
          <label className="lab" htmlFor="add-magnet">
            <span className="cap">{t('shell.add.tab.magnet')}</span>
            <span className="cap">{t('shell.add.pasteHint')}</span>
          </label>
          {/* au-delà de 5 lignes : défilement sans barre, fondu de 22 px sur le texte (pas sur le cadre) tant qu'il en reste */}
          <div className={`ta-wrap${fit.scroll && !atEnd ? ' fade' : ''}`}>
            <textarea
              id="add-magnet"
              ref={magnetRef}
              className={`ta${fit.scroll ? ' scrolls' : ''}${sourceInvalid ? ' invalid' : ''}`}
              style={{ '--lines': fit.lines } as CSSProperties}
              spellCheck={false}
              autoComplete="off"
              placeholder="magnet:?xt=urn:btih:…"
              value={magnet}
              disabled={busy}
              aria-invalid={sourceInvalid || undefined}
              data-testid="magnet-input"
              onScroll={trackEnd}
              onChange={(e) => {
                const v = e.target.value
                const how = (e.nativeEvent as InputEvent).inputType ?? ''
                setMagnet(v)
                setError(null)
                setFromClipboard(false)
                if (!v.trim()) setChecked(false)
                else if (how.startsWith('insertFromPaste') || how.startsWith('insertFromDrop')) setChecked(true)
              }}
              onBlur={() => {
                if (magnet.trim()) setChecked(true)
              }}
            />
          </div>
          {fromClipboard && !message && (
            <div className="hint">
              <span className="sdot" />
              {t('shell.add.fromClipboard')}
            </div>
          )}
        </div>
      ) : (
        <div className="field">
          <div className="lab">
            <span className="cap">{t('shell.add.tab.file')}</span>
            <span className="cap">{t('shell.add.dropHint')}</span>
          </div>
          <button
            ref={fileRef}
            type="button"
            className={`filepick${sourceInvalid ? ' invalid' : ''}`}
            disabled={busy}
            title={filePath || t('shell.add.pickTitle')}
            data-testid="file-pick"
            onClick={pickFile}
          >
            <FileIcon />
            <span className="fp-txt">
              {filePath ? (
                <>
                  <span className="fn">{baseName(filePath)}</span>
                  <span className="cap fs">
                    {dropped ? t('shell.add.file.dropped') : t('shell.add.file.chosen')}
                    {fileInfo?.fileSize ? ` · ${formatBytes(fileInfo.fileSize)}` : ''} · {t('shell.add.file.change')}
                  </span>
                </>
              ) : (
                <>
                  <span className="fn none">{t('shell.add.file.pick')}</span>
                  <span className="cap fs">{t('shell.add.file.none')}</span>
                </>
              )}
            </span>
          </button>
        </div>
      )}

      <div className="field">
        <div className="lab">
          <span className="cap">{t('shell.add.folder')}</span>
          {freeLabel && (
            <span className="cap" title={t('shell.statusbar.freeTitle')}>
              {freeLabel}
            </span>
          )}
        </div>
        <div className="path-row">
          <input
            className={`inp ro${folderInvalid ? ' invalid' : ''}`}
            type="text"
            readOnly
            tabIndex={-1}
            value={savePath}
            title={savePath}
            aria-label={t('shell.add.folder')}
          />
          <button type="button" className="btn btn-line" disabled={busy} data-testid="folder-pick" onClick={pickFolder}>
            <FolderOpen />
            {t('shell.common.browse')}
          </button>
        </div>
      </div>

      <ErrorLine message={message} />

      <div className="dfoot">
        <Keys
          keys={[
            [t('shell.keys.enter'), t('shell.keys.add')],
            [t('shell.keys.esc'), t('shell.keys.close')]
          ]}
        />
        <button type="button" className="btn btn-line" disabled={busy} data-testid="dialog-cancel" onClick={onClose}>
          {t('shell.common.cancel')}
        </button>
        <button
          ref={submitRef}
          type="button"
          className="btn btn-primary"
          disabled={busy}
          data-testid="dialog-submit"
          onClick={submit}
        >
          {busy ? <LoaderCircle className="spin" /> : <Plus />}
          {t('shell.toolbar.add')}
        </button>
      </div>
    </DialogFrame>
  )
}
