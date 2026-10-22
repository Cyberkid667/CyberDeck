// Moteur torrent de CyberDeck. Tourne dans un utilityProcess séparé pour que
// l'interface reste fluide même quand WebTorrent vérifie ou écrit beaucoup.
// Les torrents sont facultatifs : ce processus n'est lancé que s'ils sont activés
// (Réglages), et il peut être arrêté en cours de route (message « shutdown »).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import type {
  AddRequest,
  AddResult,
  FileInfo,
  FromEngine,
  GlobalStats,
  PeerInfo,
  Snapshot,
  ToEngine,
  TorrentDetails,
  TorrentStatus,
  TorrentSummary,
  TrackerInfo
} from '../shared/types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Torrent = any

interface ParentPort {
  postMessage(msg: FromEngine): void
  on(event: 'message', cb: (e: { data: ToEngine }) => void): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

// Ce qu'on garde sur disque pour chaque torrent (state.json).
interface TorrentRecord {
  id: string
  name: string
  magnetURI: string
  hasTorrentFile: boolean
  savePath: string
  paused: boolean
  addedAt: number
  completedAt: number | null
  downloadedTotal: number
  uploadedTotal: number
  size: number
  progress: number
  // Pièces déjà vérifiées (base64) : permet de reprendre sans tout revérifier.
  bitfield: string | null
  announce: string[]
  files: FileInfo[]
  pieceCount: number
  pieceLength: number
  comment: string | null
  createdBy: string | null
  createdAt: number | null
  error: string | null
}

interface LiveTorrent {
  torrent: Torrent
  baseDownloaded: number
  baseUploaded: number
  trackers: Map<string, TrackerInfo>
  startedAt: number
}

const STATE_VERSION = 1
let WebTorrent: any
let parseTorrent: (input: unknown) => Promise<any>
let client: any
let dataDir = ''
let defaultSavePath = ''
let selectedId: string | null = null
let dirty = false
/** state.json a été lu : avant, une sauvegarde écraserait la liste par une liste vide */
let stateLoaded = false
let freeSpace: number | null = null
const records = new Map<string, TorrentRecord>()
const live = new Map<string, LiveTorrent>()

const send = (msg: FromEngine): void => parentPort.postMessage(msg)
const log = (message: string): void => send({ type: 'log', message })
const notify = (level: 'info' | 'success' | 'error', message: string): void =>
  send({ type: 'notice', notice: { level, message } })

const statePath = (): string => path.join(dataDir, 'state.json')
const torrentFilePath = (id: string): string => path.join(dataDir, 'torrents', `${id}.torrent`)

// ---------- Sauvegarde ----------

function loadState(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    for (const rec of raw.torrents ?? []) records.set(rec.id, rec)
  } catch (err: any) {
    if (err.code !== 'ENOENT') log(`state.json illisible : ${err.message}`)
  }
}

function saveState(): void {
  // arrêt demandé avant la fin du démarrage (ou démarrage raté) : la liste sur disque reste intacte
  if (!stateLoaded) return
  for (const [id, lt] of live) syncRecord(records.get(id)!, lt)
  const body = JSON.stringify({ version: STATE_VERSION, torrents: [...records.values()] })
  const tmp = statePath() + '.tmp'
  try {
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, statePath())
    dirty = false
  } catch (err: any) {
    log(`Sauvegarde impossible : ${err.message}`)
  }
}

// Recopie l'état vivant du torrent dans son enregistrement.
function syncRecord(rec: TorrentRecord, lt: LiveTorrent): void {
  const t = lt.torrent
  rec.downloadedTotal = lt.baseDownloaded + (t.received || 0)
  rec.uploadedTotal = lt.baseUploaded + (t.uploaded || 0)
  if (!t.metadata && !t.files?.length) return
  rec.progress = t.progress
  // On ne garde le bitfield qu'une fois la vérification finie, sinon des
  // pièces pas encore vérifiées seraient prises pour manquantes.
  if (t.ready && t.bitfield) rec.bitfield = Buffer.from(t.bitfield.buffer).toString('base64')
  rec.files = t.files.map((f: any) => ({ name: f.name, path: f.path, size: f.length, progress: f.progress }))
}

// ---------- Ajout au client WebTorrent ----------

function addToClient(rec: TorrentRecord): void {
  const opts: any = { path: rec.savePath }
  if (rec.bitfield) opts.bitfield = Buffer.from(rec.bitfield, 'base64')
  let source: unknown = rec.magnetURI
  if (rec.hasTorrentFile) {
    try {
      source = fs.readFileSync(torrentFilePath(rec.id))
    } catch {
      rec.hasTorrentFile = false
    }
  }
  rec.error = null
  const torrent = client.add(source, opts)
  const lt: LiveTorrent = {
    torrent,
    baseDownloaded: rec.downloadedTotal,
    baseUploaded: rec.uploadedTotal,
    trackers: new Map(),
    startedAt: Date.now()
  }
  live.set(rec.id, lt)

  torrent.on('metadata', () => {
    rec.name = torrent.name
    rec.size = torrent.length
    rec.pieceCount = torrent.pieces.length
    rec.pieceLength = torrent.pieceLength
    rec.announce = torrent.announce ?? []
    rec.files = torrent.files.map((f: any) => ({ name: f.name, path: f.path, size: f.length, progress: f.progress }))
    rec.comment = torrent.comment ?? rec.comment
    rec.createdBy = torrent.createdBy ?? rec.createdBy
    rec.createdAt = torrent.created ? new Date(torrent.created).getTime() : rec.createdAt
    rec.magnetURI = torrent.magnetURI || rec.magnetURI
    if (!rec.hasTorrentFile && torrent.torrentFile) {
      try {
        fs.writeFileSync(torrentFilePath(rec.id), torrent.torrentFile)
        rec.hasTorrentFile = true
      } catch (err: any) {
        log(`Copie du .torrent impossible : ${err.message}`)
      }
    }
    dirty = true
  })
  torrent.on('ready', () => {
    watchTrackers(lt)
    dirty = true
  })
  // Le client tracker apparaît juste après l'ajout : on s'y branche avant sa
  // première réponse, qui donne le nombre total de sources et de pairs.
  const hook = setInterval(() => {
    if (watchTrackers(lt) || torrent.destroyed || Date.now() - lt.startedAt > 15_000) clearInterval(hook)
  }, 100)
  torrent.on('done', () => {
    if (!rec.completedAt) {
      rec.completedAt = Date.now()
      // Pas de message pour un torrent déjà complet qu'on vient juste de revérifier.
      if (Date.now() - lt.startedAt > 5000 || rec.downloadedTotal > 0) {
        notify('success', `Téléchargement terminé : ${rec.name}`)
      }
    }
    dirty = true
    saveState()
  })
  torrent.on('error', (err: Error) => {
    log(`Erreur ${rec.name} : ${err.message}`)
    syncRecord(rec, lt)
    rec.error = err.message
    live.delete(rec.id)
    dirty = true
  })
  torrent.on('warning', (err: Error) => {
    const msg = String(err?.message ?? err)
    for (const url of rec.announce) {
      if (msg.includes(url)) {
        const info = lt.trackers.get(url) ?? { url, status: '', seeds: null, peers: null, lastUpdate: null }
        info.status = `Erreur : ${msg.replace(url, '').trim()}`
        lt.trackers.set(url, info)
      }
    }
  })
}

// Les infos des trackers (sources / pairs totaux) arrivent par le client tracker.
function watchTrackers(lt: LiveTorrent): boolean {
  const tracker = lt.torrent.discovery?.tracker
  if (!tracker) return false
  if (tracker.__essaimWatched) return true
  tracker.__essaimWatched = true
  tracker.on('update', (data: any) => {
    if (!data?.announce) return
    lt.trackers.set(data.announce, {
      url: data.announce,
      status: 'OK',
      seeds: typeof data.complete === 'number' ? data.complete : null,
      peers: typeof data.incomplete === 'number' ? data.incomplete : null,
      lastUpdate: Date.now()
    })
  })
  return true
}

function removeFromClient(lt: LiveTorrent): Promise<void> {
  return new Promise((resolve) => {
    const t = lt.torrent
    if (t.destroyed) return resolve()
    const timer = setTimeout(resolve, 5000)
    t.destroy({ destroyStore: false }, () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function addTorrent(req: AddRequest): Promise<AddResult> {
  const savePath = req.savePath.trim()
  if (!savePath) return { ok: false, error: 'Choisis un dossier de destination.' }
  await fsp.mkdir(savePath, { recursive: true })

  let parsed: any
  let buffer: Buffer | null = null
  try {
    if (req.source.kind === 'magnet') {
      const magnet = req.source.magnet.trim()
      if (!magnet.startsWith('magnet:?')) return { ok: false, error: 'Ce lien ne commence pas par « magnet:? ».' }
      parsed = await parseTorrent(magnet)
    } else {
      buffer = await fsp.readFile(req.source.filePath)
      parsed = await parseTorrent(buffer)
    }
  } catch {
    return {
      ok: false,
      error: req.source.kind === 'magnet' ? 'Ce lien magnet est invalide.' : 'Ce fichier n’est pas un .torrent valide.'
    }
  }
  if (!parsed?.infoHash) return { ok: false, error: 'Impossible de lire ce torrent.' }

  const id: string = parsed.infoHash
  if (records.has(id)) return { ok: false, error: `« ${records.get(id)!.name} » est déjà dans la liste.` }

  const rec: TorrentRecord = {
    id,
    name: parsed.name || parsed.dn || id,
    magnetURI: req.source.kind === 'magnet' ? req.source.magnet.trim() : `magnet:?xt=urn:btih:${id}`,
    hasTorrentFile: false,
    savePath,
    paused: false,
    addedAt: Date.now(),
    completedAt: null,
    downloadedTotal: 0,
    uploadedTotal: 0,
    size: parsed.length ?? 0,
    progress: 0,
    bitfield: null,
    announce: parsed.announce ?? [],
    files: (parsed.files ?? []).map((f: any) => ({ name: f.name, path: f.path, size: f.length, progress: 0 })),
    pieceCount: parsed.pieces?.length ?? 0,
    pieceLength: parsed.pieceLength ?? 0,
    comment: parsed.comment ?? null,
    createdBy: parsed.createdBy ?? null,
    createdAt: parsed.created ? new Date(parsed.created).getTime() : null,
    error: null
  }
  if (buffer) {
    await fsp.writeFile(torrentFilePath(id), buffer)
    rec.hasTorrentFile = true
  }
  records.set(id, rec)
  addToClient(rec)
  saveState()
  return { ok: true, id }
}

async function pauseTorrents(ids: string[]): Promise<void> {
  for (const id of ids) {
    const rec = records.get(id)
    if (!rec || rec.paused) continue
    rec.paused = true
    const lt = live.get(id)
    if (lt) {
      syncRecord(rec, lt)
      live.delete(id)
      await removeFromClient(lt)
    }
  }
  saveState()
}

function resumeTorrents(ids: string[]): void {
  for (const id of ids) {
    const rec = records.get(id)
    if (!rec || (!rec.paused && !rec.error)) continue
    if (live.has(id)) continue
    rec.paused = false
    addToClient(rec)
  }
  saveState()
}

// Liste uniquement les fichiers du torrent (jamais tout un dossier) et leurs
// sous-dossiers, sans jamais sortir du dossier de destination. Le processus
// principal les met à la corbeille, puis retire les dossiers devenus vides.
function trashTorrentFiles(rec: TorrentRecord): void {
  const root = path.resolve(rec.savePath)
  const files: string[] = []
  const dirs = new Set<string>()
  for (const f of rec.files) {
    const full = path.resolve(root, f.path)
    if (!full.startsWith(root + path.sep)) continue
    files.push(full)
    let dir = path.dirname(full)
    while (dir.startsWith(root + path.sep)) {
      dirs.add(dir)
      dir = path.dirname(dir)
    }
  }
  if (files.length) send({ type: 'trash', files, dirs: [...dirs].sort((a, b) => b.length - a.length) })
}

async function removeTorrents(ids: string[], deleteFiles: boolean): Promise<void> {
  for (const id of ids) {
    const rec = records.get(id)
    if (!rec) continue
    const lt = live.get(id)
    if (lt) {
      syncRecord(rec, lt)
      live.delete(id)
      await removeFromClient(lt)
    }
    records.delete(id)
    if (selectedId === id) selectedId = null
    await fsp.rm(torrentFilePath(id), { force: true }).catch(() => {})
    if (deleteFiles) trashTorrentFiles(rec)
  }
  saveState()
}

// ---------- Instantanés pour l'interface ----------

function statusOf(rec: TorrentRecord, lt: LiveTorrent | undefined): TorrentStatus {
  if (rec.error && !lt) return 'error'
  if (rec.paused || !lt) return rec.progress >= 1 ? 'completed' : 'paused'
  const t = lt.torrent
  if (!t.metadata && !t.files?.length) return 'metadata'
  if (!t.ready) return 'checking'
  if (t.done) return 'seeding'
  return t.numPeers > 0 ? 'downloading' : 'stalled'
}

function trackerTotals(lt: LiveTorrent): { seeds: number | null; peers: number | null } {
  let seeds: number | null = null
  let peers: number | null = null
  for (const info of lt.trackers.values()) {
    if (info.seeds !== null) seeds = Math.max(seeds ?? 0, info.seeds)
    if (info.peers !== null) peers = Math.max(peers ?? 0, info.peers)
  }
  return { seeds, peers }
}

// Repère l'installateur d'un jeu ou d'un logiciel (setup.exe, install.exe…)
// parmi les fichiers du torrent, en ignorant les redistribuables.
const INSTALLER_NAME = /(^|[\\/])(setup|install|installer)[^\\/]*\.(exe|msi)$/i
const NOT_INSTALLER = /(redist|directx|vcredist|dotnet|physx|unins|prereq)/i
const installerCache = new Map<string, { count: number; installer: string | null }>()

function installerOf(rec: TorrentRecord): string | null {
  const cached = installerCache.get(rec.id)
  if (cached && cached.count === rec.files.length) return cached.installer
  const depth = (p: string): number => p.split(/[\\/]/).length
  const found = rec.files
    .map((f) => f.path)
    .filter((p) => INSTALLER_NAME.test(p) && !NOT_INSTALLER.test(p))
    .sort((a, b) => depth(a) - depth(b) || a.length - b.length)[0]
  const installer = found ? path.join(rec.savePath, found) : null
  installerCache.set(rec.id, { count: rec.files.length, installer })
  return installer
}

function summarize(rec: TorrentRecord): TorrentSummary {
  const lt = live.get(rec.id)
  const t = lt?.torrent
  const status = statusOf(rec, lt)
  const downloadedTotal = lt ? lt.baseDownloaded + (t.received || 0) : rec.downloadedTotal
  const uploadedTotal = lt ? lt.baseUploaded + (t.uploaded || 0) : rec.uploadedTotal
  const progress = t && (t.metadata || t.files?.length) ? t.progress : rec.progress
  const size = t?.length || rec.size
  let seeds = 0
  let peers = 0
  if (t) for (const w of t.wires) w.isSeeder ? seeds++ : peers++
  const totals = lt ? trackerTotals(lt) : { seeds: null, peers: null }
  const downloadSpeed = t ? Math.round(t.downloadSpeed) : 0
  const uploadSpeed = t ? Math.round(t.uploadSpeed) : 0
  let eta: number | null = null
  if (status === 'downloading' && downloadSpeed > 0) eta = Math.round((size * (1 - progress)) / downloadSpeed)
  const base = Math.max(downloadedTotal, size * progress)
  return {
    id: rec.id,
    name: rec.name,
    size,
    progress,
    downloadedTotal,
    uploadedTotal,
    downloadSpeed,
    uploadSpeed,
    eta,
    status,
    seeds,
    seedsTotal: totals.seeds,
    peers,
    peersTotal: totals.peers,
    ratio: base > 0 ? uploadedTotal / base : 0,
    savePath: rec.savePath,
    magnetURI: rec.magnetURI,
    installer: installerOf(rec),
    addedAt: rec.addedAt,
    completedAt: rec.completedAt,
    error: rec.error
  }
}

const CLIENT_CODES: Record<string, string> = {
  qB: 'qBittorrent', TR: 'Transmission', UT: 'µTorrent', UM: 'µTorrent Mac', BT: 'BitTorrent', lt: 'libtorrent',
  LT: 'libtorrent', DE: 'Deluge', WW: 'WebTorrent', WD: 'WebTorrent Desktop', AZ: 'Vuze', BI: 'BiglyBT',
  TX: 'Tixati', FD: 'Free Download Manager', PI: 'PicoTorrent', BC: 'BitComet', XL: 'Xunlei', SD: 'Xunlei',
  KT: 'KTorrent', FW: 'FrostWire'
}

function clientName(wire: any): string {
  const v = wire.peerExtendedHandshake?.v
  if (v) return typeof v === 'string' ? v : Buffer.from(v).toString('utf8')
  if (wire.type === 'webSeed') return 'Source web'
  const idHex: string | undefined = wire.peerId
  if (!idHex) return 'Inconnu'
  const id = Buffer.from(idHex, 'hex').toString('latin1')
  if (id[0] === '-' && id[7] === '-') {
    const code = id.slice(1, 3)
    const ver = id.slice(3, 7).replace(/0+$/, '').split('').join('.')
    return `${CLIENT_CODES[code] ?? code} ${ver}`.trim()
  }
  return 'Inconnu'
}

const CONNECTIONS: Record<string, string> = {
  tcpIncoming: 'TCP entrant', tcpOutgoing: 'TCP sortant', utpIncoming: 'uTP entrant',
  utpOutgoing: 'uTP sortant', webrtc: 'WebRTC', webSeed: 'Source web'
}

function popcount(buf: Uint8Array | undefined, max: number): number {
  if (!buf || !max) return 0
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    let b = buf[i]
    while (b) {
      n += b & 1
      b >>= 1
    }
  }
  return Math.min(n, max)
}

function detailsOf(rec: TorrentRecord): TorrentDetails {
  const lt = live.get(rec.id)
  const t = lt?.torrent
  const hasMeta = !!(t && (t.metadata || t.files?.length))
  const files: FileInfo[] = hasMeta
    ? t.files.map((f: any) => ({ name: f.name, path: f.path, size: f.length, progress: f.progress }))
    : rec.files
  const pieceCount = hasMeta ? t.pieces.length : rec.pieceCount
  const peers: PeerInfo[] = t
    ? t.wires.map((w: any) => ({
        address: w.remoteAddress ? `${w.remoteAddress}:${w.remotePort}` : '—',
        client: clientName(w),
        connection: CONNECTIONS[w.type] ?? w.type ?? '—',
        progress: w.isSeeder ? 1 : popcount(w.peerPieces?.buffer, pieceCount) / (pieceCount || 1),
        downloadSpeed: Math.round(w.downloadSpeed()),
        uploadSpeed: Math.round(w.uploadSpeed()),
        isSeeder: !!w.isSeeder
      }))
    : []
  const urls: string[] = (hasMeta ? t.announce : rec.announce) ?? []
  const trackers: TrackerInfo[] = urls.map((url) => {
    const info = lt?.trackers.get(url)
    if (info) return info
    let status = 'En contact…'
    if (!lt) status = rec.paused ? 'En pause' : 'Arrêté'
    else if (Date.now() - lt.startedAt > 60_000) status = 'Pas de réponse'
    return { url, status, seeds: null, peers: null, lastUpdate: null }
  })
  return {
    id: rec.id,
    magnetURI: rec.magnetURI,
    comment: rec.comment,
    createdBy: rec.createdBy,
    createdAt: rec.createdAt,
    pieceCount,
    pieceLength: hasMeta ? t.pieceLength : rec.pieceLength,
    files,
    peers,
    trackers
  }
}

function dhtNodes(): number {
  try {
    return client?.dht?._rpc?.nodes?.count?.() ?? 0
  } catch {
    return 0
  }
}

function snapshot(): Snapshot {
  for (const lt of live.values()) watchTrackers(lt)
  const torrents = [...records.values()].sort((a, b) => a.addedAt - b.addedAt).map(summarize)
  let peers = 0
  for (const lt of live.values()) peers += lt.torrent.wires?.length ?? 0
  const global: GlobalStats = {
    downloadSpeed: Math.round(client?.downloadSpeed ?? 0),
    uploadSpeed: Math.round(client?.uploadSpeed ?? 0),
    dhtNodes: dhtNodes(),
    peers,
    port: client?.torrentPort ?? 0,
    freeSpace
  }
  const sel = selectedId ? records.get(selectedId) : undefined
  return { torrents, global, details: sel ? detailsOf(sel) : null }
}

async function refreshFreeSpace(): Promise<void> {
  try {
    const st = await fsp.statfs(defaultSavePath)
    freeSpace = st.bavail * st.bsize
  } catch {
    freeSpace = null
  }
}

// ---------- Démarrage ----------

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, () => srv.close(() => resolve(true)))
  })
}

async function init(msg: Extract<ToEngine, { type: 'init' }>): Promise<void> {
  dataDir = msg.dataDir
  defaultSavePath = msg.defaultSavePath
  fs.mkdirSync(path.join(dataDir, 'torrents'), { recursive: true })
  WebTorrent = (await import('webtorrent')).default
  parseTorrent = (await import('parse-torrent')).default
  const port = (await portIsFree(msg.port)) ? msg.port : 0
  client = new WebTorrent({ torrentPort: port })
  client.on('error', (err: Error) => {
    log(`Client : ${err.message}`)
    notify('error', `Erreur du moteur : ${err.message}`)
  })
  loadState()
  stateLoaded = true
  for (const rec of records.values()) if (!rec.paused) addToClient(rec)
  log(`Moteur prêt (port ${port || 'auto'}, ${records.size} torrent(s))`)

  await refreshFreeSpace()
  setInterval(() => send({ type: 'snapshot', snapshot: snapshot() }), 1000)
  setInterval(refreshFreeSpace, 10_000)
  setInterval(() => {
    if (dirty || live.size) saveState()
  }, 15_000)
}

async function shutdown(): Promise<void> {
  saveState()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000)
    try {
      client?.destroy(() => {
        clearTimeout(timer)
        resolve()
      })
    } catch {
      resolve()
    }
  })
  send({ type: 'shutdown-done' })
}

// Les messages sont traités un par un, dans l'ordre d'arrivée.
let queue: Promise<void> = Promise.resolve()
parentPort.on('message', ({ data: msg }) => {
  queue = queue.then(async () => {
    try {
      switch (msg.type) {
        case 'init':
          return await init(msg)
        case 'add': {
          const result = await addTorrent(msg.request).catch((err: Error) => ({ ok: false, error: err.message }))
          return send({ type: 'added', requestId: msg.requestId, result })
        }
        case 'pause':
          return await pauseTorrents(msg.ids)
        case 'resume':
          return resumeTorrents(msg.ids)
        case 'remove':
          return await removeTorrents(msg.ids, msg.deleteFiles)
        case 'select':
          selectedId = msg.id
          return
        case 'release': {
          const rec = records.get(msg.id)
          const wasRunning = !!rec && !rec.paused && live.has(msg.id)
          if (wasRunning) await pauseTorrents([msg.id])
          return send({ type: 'released', requestId: msg.requestId, wasRunning })
        }
        case 'set-default-path':
          defaultSavePath = msg.path
          return await refreshFreeSpace()
        case 'shutdown':
          return await shutdown()
      }
    } catch (err: any) {
      log(`Message ${msg.type} : ${err?.stack ?? err}`)
      notify('error', `Action impossible : ${err?.message ?? err}`)
    }
  })
})

process.on('uncaughtException', (err) => log(`Exception : ${err.stack ?? err}`))
process.on('unhandledRejection', (err: any) => log(`Promesse rejetée : ${err?.stack ?? err}`))
