import type { TorrentStatus, TorrentSummary } from '../../shared/types'

// Formats français à décimales FIXES : rien ne saute d'une seconde à l'autre
// (les chiffres mono ont tous la même largeur). Voir SPEC 8.
// 756 Mo · 6,20 Go · 18,4 Mo/s · 412 Ko/s · 42,0 % · 0,84 · 3 h 05 · 00:14:36

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To']

/** Taille : 2 décimales sous 10, 1 sous 100, 0 au-delà (min = max) : « 6,20 Go », « 18,4 Mo », « 756 Mo ». */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 o'
  let i = 0
  let v = bytes
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${UNITS[i]}`
}

/** Vitesse : « 18,4 Mo/s » ; « — » à zéro (à afficher en --tx-4 : <span className="nil">). */
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec < 1) return '—'
  return `${formatBytes(bytesPerSec)}/s`
}

/**
 * Réception affichée d'un torrent (colonne Réception, tri, fiche Infos, globe) : un torrent
 * complet (en partage ou terminé) ne télécharge plus rien ; ce qu'il reçoit encore n'est que
 * l'échange du protocole avec ses pairs (quelques octets à quelques Ko/s). Il s'affiche donc
 * « — », comme dans les maquettes. Les données brutes ne changent pas : la barre d'état et
 * l'oscilloscope montrent toujours tout le trafic reçu.
 */
export function shownDownload(t: Pick<TorrentSummary, 'downloadSpeed' | 'progress' | 'status'>): number {
  return t.progress >= 1 || t.status === 'seeding' || t.status === 'completed' ? 0 : t.downloadSpeed
}

/** Temps restant : « 42 s », « 5 min 18 s », « 3 h 05 min », « 2 j 4 h », « > 99 j » ; « — » si inconnu. */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${Math.max(1, total)} s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m} min ${String(total % 60).padStart(2, '0')} s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`
  const d = Math.floor(h / 24)
  return d > 99 ? '> 99 j' : `${d} j ${h % 24} h`
}

/**
 * Pourcentage : « 0 % » et « 100 % » exacts ; sinon UNE décimale toujours affichée,
 * arrondie vers le bas (on ne voit jamais « 100,0 % » avant la fin réelle).
 */
export function formatPercent(p: number): string {
  const v = Math.max(0, Math.min(1, p || 0)) * 100
  if (v >= 100) return '100 %'
  if (v <= 0) return '0 %'
  // + 1e-9 : 0,29 × 100 = 28,999999999999996 doit donner 29,0 ; jamais plus de 99,9 avant la fin
  const d = Math.min(99.9, Math.floor(v * 10 + 1e-9) / 10)
  return `${d.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}

/** Largeur de barre pour --p : « 42.00% » (point décimal, pour le CSS). */
export const percentVar = (p: number): string => `${(Math.max(0, Math.min(1, p || 0)) * 100).toFixed(2)}%`

/** Ratio : toujours 2 décimales, « 0,84 ». */
export function formatRatio(r: number): string {
  return (r || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Date et heure : « 21 oct. 2026, 22:58 » ; « — » si absente. */
export function formatDate(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
}

/** Jour seul : « 21 oct. 2026 » ; « — » si absent. */
export function formatDay(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Heure : « 23:21 » (ou « 23:41:52 » avec les secondes). */
export function formatTime(ts: number, seconds = false): string {
  return new Date(ts).toLocaleTimeString('fr-FR', seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
}

/** Compteur en texte simple : « 55 (197) », ou « 2 » sans total connu. */
export function formatCount(connected: number, total: number | null): string {
  return total === null ? String(connected) : `${connected} (${total})`
}

/** Compteur en deux morceaux, pour afficher le total en --tx-3 : 55 <span className="tot"> (197)</span>. */
export function countParts(connected: number, total: number | null): { n: string; total: string | null } {
  return { n: String(connected), total: total === null ? null : ` (${total})` }
}

/** Temps de jeu long (bandeau) : « Jamais joué », « Moins d’une minute », « 15 min », « 3 h 05 ». */
export function formatPlayTime(seconds: number): string {
  if (!seconds) return 'Jamais joué'
  if (seconds < 60) return 'Moins d’une minute'
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/**
 * Temps de jeu court (cartes) : « Jamais joué », « < 1 min », « 42 min », « 3 h 05 », et sans les
 * minutes à partir de 100 h (« 235 h ») pour tenir dans le talon. full : toujours avec les minutes
 * (texte complet de la bulle).
 */
export function formatPlayTimeShort(seconds: number, full = false): string {
  if (!seconds) return 'Jamais joué'
  if (seconds < 60) return '< 1 min'
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h >= 100 && !full ? `${h} h` : `${h} h ${String(m % 60).padStart(2, '0')}`
}

/**
 * Dernière partie (cartes) : « aujourd’hui », « hier », « il y a 3 j », « le 12 oct. » ; '' si jamais.
 * full : « il y a 3 jours » (texte complet de la bulle).
 */
export function formatLastPlayed(ts: number | null, now = Date.now(), full = false): string {
  if (!ts) return ''
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.round((day(now) - day(ts)) / 86_400_000)
  if (days <= 0) return 'aujourd’hui'
  if (days === 1) return 'hier'
  if (days < 7) return full ? `il y a ${days} jours` : `il y a ${days} j`
  return `le ${new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`
}

/** « aujourd’hui à 23:21 », « hier à 23:21 », « le 12 oct. à 21:10 » (« le 12 oct. 2025 à … » une autre année). */
export function formatWhen(ts: number, now = Date.now()): string {
  const day = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.round((day(now) - day(ts)) / 86_400_000)
  const at = formatTime(ts)
  if (days <= 0) return `aujourd’hui à ${at}`
  if (days === 1) return `hier à ${at}`
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const date = d.toLocaleDateString('fr-FR', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
  return `le ${date} à ${at}`
}

/** Chrono de session en trois morceaux sur 2 chiffres : ['00', '14', '36'] (secondes en --tx-3 dans le bandeau). */
export function formatClock(seconds: number): [string, string, string] {
  const s = Math.max(0, Math.floor(seconds || 0))
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, '0')) as [string, string, string]
}

/** Chrono de session en texte : « 00:14:36 ». */
export const formatClockText = (seconds: number): string => formatClock(seconds).join(':')

/** Numéro d'ajout sur 2 chiffres : « 03 » (puis « 100 »). */
export const formatIndex = (n: number): string => String(n).padStart(2, '0')

/** Adresse d'un pair : IP en --tx-1, « :port » en --tx-3 (<span className="port">). IPv6 entre crochets. */
export function splitAddress(address: string): { host: string; port: string } {
  // adresse IPv4 vue par une connexion IPv6 (« ::ffff:121.225.208.163:56847 ») : on montre l'IPv4
  const mapped = /^\[?::ffff:(\d{1,3}(?:\.\d{1,3}){3})\]?(:\d+)?$/i.exec(address)
  if (mapped) return { host: mapped[1], port: mapped[2] ?? '' }
  const i = address.lastIndexOf(':')
  // « [2a01:e0a::12]:51413 » : le port suit le crochet fermant ; une IPv6 nue n'a pas de port
  if (i > 0 && (address.startsWith('[') ? address[i - 1] === ']' : address.indexOf(':') === i))
    return { host: address.slice(0, i), port: address.slice(i) }
  return { host: address, port: '' }
}

/** Valeur « rien » d'une cellule (« — » à afficher en --tx-4). */
export const DASH = '—'

export const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')
export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p

// Message lisible d'une erreur venue du processus principal.
export const errorText = (err: unknown): string =>
  String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const STATUS_LABEL: Record<TorrentStatus, string> = {
  metadata: 'Recherche des infos',
  checking: 'Vérification',
  downloading: 'Téléchargement',
  stalled: 'En attente de pairs',
  seeding: 'En partage',
  paused: 'En pause',
  completed: 'Terminé',
  error: 'Erreur'
}

/**
 * Cause courte d'une erreur, affichée après « ERREUR · » : ENOSPC / espace →
 * « Disque plein » ; EACCES, EPERM → « Accès refusé » ; ENOENT → « Fichiers
 * introuvables » ; réseau → « Réseau » ; sinon les 24 premiers caractères.
 */
export function errorCause(error: string | null | undefined): string {
  const e = (error ?? '').trim().replace(/^error:\s*/i, '')
  if (!e) return ''
  if (/ENOSPC|espace|no space left|disk full/i.test(e)) return 'Disque plein'
  if (/EACCES|EPERM|permission denied|operation not permitted|accès refusé/i.test(e)) return 'Accès refusé'
  if (/ENOENT|no such file|introuvable/i.test(e)) return 'Fichiers introuvables'
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|network|réseau/i.test(e)) return 'Réseau'
  return e.length > 24 ? `${e.slice(0, 24).trimEnd()}…` : e
}

/** Libellé du statut au-dessus de la barre : « Téléchargement », « Erreur · Disque plein »… (affiché en capitales par le CSS). */
export function statusText(t: Pick<TorrentSummary, 'status' | 'error'>): string {
  if (t.status === 'error') {
    const cause = errorCause(t.error)
    return cause ? `${STATUS_LABEL.error} · ${cause}` : STATUS_LABEL.error
  }
  return STATUS_LABEL[t.status]
}

/** Lien magnet sans « dn » : le moteur met l'empreinte comme nom jusqu'à l'arrivée des infos. */
export const isHashName = (t: Pick<TorrentSummary, 'id' | 'name'>): boolean =>
  !t.name || t.name.toLowerCase() === t.id.toLowerCase()

export type Filter = 'all' | 'active' | 'done' | 'seeding'

export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Tous' },
  { id: 'active', label: 'En cours' },
  { id: 'done', label: 'Terminés' },
  { id: 'seeding', label: 'En partage' }
]

export function matchesFilter(t: TorrentSummary, f: Filter): boolean {
  switch (f) {
    case 'all':
      return true
    case 'active':
      return t.progress < 1 && t.status !== 'completed'
    case 'done':
      return t.progress >= 1 || t.status === 'completed' || t.status === 'seeding'
    case 'seeding':
      return t.status === 'seeding'
  }
}

export const isRunning = (t: TorrentSummary): boolean => t.status !== 'paused' && t.status !== 'completed' && t.status !== 'error'
