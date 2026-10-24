// Twitch côté Electron : connexion du compte par code d'appareil (twitchAuth.ts), jetons
// chiffrés par Windows (safeStorage) dans %APPDATA%\CyberDeck\twitch.json, catégorie Twitch de
// chaque jeu (trouvée par son nom, corrigeable à la main), streams en direct (Helix, cache 60 s),
// et verrouillage des <webview> du lecteur et du chat (session « persist:twitch », sites de
// Twitch seulement, aucune fenêtre ouverte dans l'app).
// Envoyé à Twitch : le nom du jeu (recherche de sa catégorie) et le jeton du compte.
import { app, net, safeStorage, session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getLang, t } from '../shared/i18n'
import type { TwitchCategory, TwitchSignIn, TwitchState, TwitchStream, TwitchStreams, TwitchStreamsQuery, TwitchUser } from '../shared/types'
import { allowedImage, openExternalLink } from './gameDetails'
import { libraryState } from './games'
import { pollDeviceToken, refreshTokens, requestDeviceCode, revokeToken, TWITCH_ID, type PostForm, type Tokens } from './twitchAuth'

/**
 * Identifiant de l'application enregistrée sur dev.twitch.tv (type de client « Public »).
 * Le seul endroit à remplir. Vide : la rubrique Twitch affiche « Twitch n'est pas configuré ».
 * Tests : la variable d'environnement CYBERDECK_TWITCH_CLIENT_ID le remplace.
 */
export const TWITCH_CLIENT_ID = ''

/** Session des <webview> du lecteur et du chat (cookies de Twitch, séparés de l'app). */
export const TWITCH_PARTITION = 'persist:twitch'

const clientId = (): string => (process.env.CYBERDECK_TWITCH_CLIENT_ID ?? '').trim() || TWITCH_CLIENT_ID
/** chaînes suivies (filtre « Chaînes suivies ») ; rien d'autre : lecture seule */
const SCOPES = ['user:read:follows']
const HELIX = 'https://api.twitch.tv/helix'
const FETCH_TIMEOUT = 10_000
const CACHE_MAX_AGE = 60_000
/** catégorie trouvée automatiquement : recherchée de nouveau après 7 jours (1 jour si rien trouvé) */
const CATEGORY_MAX_AGE = 7 * 86_400_000
const CATEGORY_MISS_MAX_AGE = 86_400_000
/** Twitch demande de vérifier le jeton au démarrage puis toutes les heures */
const VALIDATE_PERIOD = 3600_000
/** jeton rafraîchi un peu avant son expiration */
const REFRESH_MARGIN = 5 * 60_000
const PAGE_SIZE = 100

interface Deps {
  log: (message: string) => void
  broadcast: (s: TwitchState) => void
}

interface CategoryEntry {
  category: TwitchCategory | null
  /** choisie par l'utilisateur (jamais remplacée automatiquement) */
  manual: boolean
  /** nom du jeu au moment de la recherche (renommé : nouvelle recherche) */
  name: string
  at: number
}

interface Store {
  version: 1
  /** jetons (JSON) chiffrés par safeStorage, en base64 */
  tokens: string | null
  user: TwitchUser | null
  categories: Record<string, CategoryEntry>
}

/** Données de démonstration (tests et captures) : CYBERDECK_TWITCH_FAKE=<fichier JSON>. */
interface Fake {
  user: TwitchUser | null
  category: TwitchCategory | null
  streams: TwitchStream[]
}

let deps: Deps = { log: () => {}, broadcast: () => {} }
let store: Store = { version: 1, tokens: null, user: null, categories: {} }
let mem: Tokens | null = null
let signIn: TwitchSignIn | null = null
let lastError: string | null = null
let flow: { cancelled: boolean; wake: () => void } | null = null
let refreshing: Promise<boolean> | null = null
let fake: Fake | null = null
const cache = new Map<string, { at: number; value: TwitchStreams }>()

const storePath = (): string => path.join(app.getPath('userData'), 'twitch.json')

function loadStore(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8').replace(/^﻿/, ''))
    if (raw && typeof raw === 'object') {
      store = {
        version: 1,
        tokens: typeof raw.tokens === 'string' ? raw.tokens : null,
        user: raw.user && typeof raw.user.id === 'string' ? raw.user : null,
        categories: raw.categories && typeof raw.categories === 'object' ? raw.categories : {}
      }
    }
  } catch {
    // pas encore de fichier, ou fichier abîmé : on repart de zéro
  }
}

function saveStore(): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = storePath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1))
    fs.renameSync(tmp, storePath())
  } catch (err) {
    deps.log(`Enregistrement de twitch.json impossible : ${(err as Error).message}`)
  }
}

function loadTokens(): Tokens | null {
  if (mem) return mem
  if (!store.tokens || !safeStorage.isEncryptionAvailable()) return null
  try {
    const t = JSON.parse(safeStorage.decryptString(Buffer.from(store.tokens, 'base64')))
    if (t && typeof t.access === 'string') mem = t
  } catch {
    deps.log('Jetons Twitch illisibles (clé de chiffrement de Windows changée) : déconnexion')
    store.tokens = null
    store.user = null
    saveStore()
  }
  return mem
}

function saveTokens(tokens: Tokens | null): void {
  mem = tokens
  store.tokens = tokens ? safeStorage.encryptString(JSON.stringify(tokens)).toString('base64') : null
  saveStore()
}

// ---------- État ----------

export function twitchState(): TwitchState {
  if (fake) return { configured: true, canStore: true, user: fake.user, signIn, error: null }
  const configured = !!clientId()
  return {
    configured,
    canStore: safeStorage.isEncryptionAvailable(),
    user: configured && store.tokens ? store.user : null,
    signIn,
    error: lastError
  }
}

const broadcast = (): void => deps.broadcast(twitchState())

// ---------- Réseau ----------

const post: PostForm = async (url, form) => {
  try {
    const res = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      // réponse vide (révocation) ou pas en JSON
    }
    return { status: res.status, json }
  } catch {
    return null
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; json: any } | null> {
  try {
    const res = await net.fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      // page d'erreur
    }
    return { status: res.status, json }
  } catch {
    return null
  }
}

/** Jetons refusés pour de bon (révoqués, rafraîchissement expiré) : déconnexion locale. */
function dropSession(reason: string): void {
  deps.log(`Session Twitch terminée : ${reason}`)
  saveTokens(null)
  store.user = null
  saveStore()
  cache.clear()
  lastError = t('twitch.error.expired')
  broadcast()
}

/** Nouveau jeton d'accès ; faux si la session est perdue ou si Twitch ne répond pas. */
function refresh(): Promise<boolean> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const tokens = loadTokens()
    if (!tokens?.refresh) {
      if (tokens) dropSession('pas de jeton de rafraîchissement')
      return false
    }
    const r = await refreshTokens(post, clientId(), tokens.refresh, Date.now())
    if (r.status === 'ok') {
      saveTokens(r.tokens)
      return true
    }
    if (r.status === 'invalid') dropSession('rafraîchissement refusé')
    return false
  })().finally(() => (refreshing = null))
  return refreshing
}

async function accessToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens) return null
  if (tokens.expiresAt - REFRESH_MARGIN < Date.now()) {
    await refresh()
    return loadTokens()?.access ?? null
  }
  return tokens.access
}

/** Appel à l'API Helix avec le jeton du compte (401 : un rafraîchissement, puis un nouvel essai). */
async function helix(query: string): Promise<{ status: number; json: any } | null> {
  const access = await accessToken()
  if (!access) return { status: 401, json: null }
  const call = (token: string): Promise<{ status: number; json: any } | null> =>
    getJson(`${HELIX}/${query}`, { 'Client-Id': clientId(), Authorization: `Bearer ${token}` })
  const res = await call(access)
  if (res?.status !== 401) return res
  if (!(await refresh())) return res
  const again = loadTokens()?.access
  return again ? call(again) : res
}

/** Vérification demandée par Twitch (démarrage, puis toutes les heures). */
async function validate(): Promise<void> {
  if (fake || !clientId()) return
  const tokens = loadTokens()
  if (!tokens) return
  const res = await getJson(`${TWITCH_ID}/validate`, { Authorization: `OAuth ${tokens.access}` })
  if (res?.status === 401) await refresh()
}

async function fetchUser(): Promise<TwitchUser | null> {
  const res = await helix('users')
  const u = res?.status === 200 ? res.json?.data?.[0] : null
  if (!u || typeof u.id !== 'string') return null
  return {
    id: u.id,
    login: String(u.login ?? ''),
    displayName: String(u.display_name || u.login || ''),
    avatar: allowedImage(typeof u.profile_image_url === 'string' ? u.profile_image_url : null)
  }
}

// ---------- Connexion ----------

/** Demande un code d'appareil, puis attend (en arrière-plan) l'accord sur twitch.tv/activate. */
export async function startTwitchSignIn(): Promise<TwitchState> {
  cancelTwitchSignIn(false)
  lastError = null
  if (fake) {
    signIn = { userCode: 'WDJB-MJHT', verificationUri: 'https://www.twitch.tv/activate', expiresAt: Date.now() + 1800_000, status: 'waiting', error: null }
    broadcast()
    return twitchState()
  }
  const id = clientId()
  if (!id) return twitchState()
  if (!safeStorage.isEncryptionAvailable()) {
    signIn = { userCode: '', verificationUri: '', expiresAt: 0, status: 'error', error: t('twitch.error.cantEncrypt') }
    broadcast()
    return twitchState()
  }
  let wake = (): void => {}
  const mine = { cancelled: false, wake: () => wake() }
  flow = mine
  signIn = { userCode: '', verificationUri: '', expiresAt: 0, status: 'starting', error: null }
  broadcast()
  const r = await requestDeviceCode(post, id, SCOPES, Date.now())
  if (flow !== mine) return twitchState()
  if (!r.ok) {
    flow = null
    signIn = { userCode: '', verificationUri: '', expiresAt: 0, status: 'error', error: r.error === 'network' ? t('twitch.error.offline') : r.error }
    deps.log(`Connexion Twitch impossible : ${r.error}`)
    broadcast()
    return twitchState()
  }
  const code = r.code
  signIn = { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: code.expiresAt, status: 'waiting', error: null }
  broadcast()
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  void pollDeviceToken(post, id, SCOPES, code, { now: Date.now, sleep, cancelled: () => mine.cancelled || flow !== mine }).then(async (res) => {
    if (flow !== mine) return
    flow = null
    if (res.status === 'ok') {
      saveTokens(res.tokens)
      cache.clear()
      const user = await fetchUser()
      store.user = user
      saveStore()
      signIn = null
      deps.log(`Compte Twitch connecté${user ? ` : ${user.login}` : ''}`)
    } else if (res.status === 'expired' || res.status === 'denied') {
      signIn = signIn && { ...signIn, status: res.status }
    } else if (res.status === 'error') {
      signIn = signIn && { ...signIn, status: 'error', error: res.error }
      deps.log(`Connexion Twitch interrompue : ${res.error}`)
    }
    broadcast()
  })
  return twitchState()
}

/** Ferme la connexion en cours (fenêtre du code fermée). */
export function cancelTwitchSignIn(notify = true): void {
  if (flow) {
    flow.cancelled = true
    flow.wake()
    flow = null
  }
  if (signIn) {
    signIn = null
    if (notify) broadcast()
  }
}

/** Ouvre twitch.tv/activate (seulement l'adresse donnée par Twitch pour la connexion en cours). */
export function openTwitchActivate(): void {
  const uri = signIn?.verificationUri
  if (!uri) return
  try {
    const u = new URL(uri)
    if (u.protocol === 'https:' && /(^|\.)twitch\.tv$/i.test(u.hostname)) openExternalLink(u.toString())
  } catch {
    // adresse invalide
  }
}

export async function twitchSignOut(): Promise<TwitchState> {
  cancelTwitchSignIn(false)
  if (fake) {
    fake.user = null
    broadcast()
    return twitchState()
  }
  const tokens = loadTokens()
  if (tokens && clientId()) {
    // révoquer le jeton d'accès met aussi fin au jeton de rafraîchissement
    const ok = await revokeToken(post, clientId(), tokens.access)
    deps.log(`Compte Twitch déconnecté${ok ? '' : ' (révocation non confirmée par Twitch)'}`)
  }
  saveTokens(null)
  store.user = null
  saveStore()
  cache.clear()
  lastError = null
  broadcast()
  return twitchState()
}

// ---------- Catégories et streams ----------

const sized = (url: unknown, w: number, h: number): string | null =>
  typeof url === 'string' ? allowedImage(url.replace('{width}', String(w)).replace('{height}', String(h))) : null

const toCategory = (c: any): TwitchCategory | null =>
  c && typeof c.id === 'string' && c.id ? { id: c.id, name: String(c.name ?? ''), boxArt: sized(c.box_art_url, 52, 72) } : null

/** Nom comparable : minuscules, sans accents ni ™®, chiffres et lettres seulement. */
const norm = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Meilleure catégorie pour un nom de jeu parmi les résultats de recherche (null : aucune assez proche). */
export function bestCategory(name: string, results: TwitchCategory[]): TwitchCategory | null {
  const want = norm(name)
  if (!want || !results.length) return null
  const flat = want.replace(/ /g, '')
  const exact = results.find((c) => norm(c.name).replace(/ /g, '') === flat)
  if (exact) return exact
  const words = new Set(want.split(' '))
  let best: TwitchCategory | null = null
  let bestScore = 0
  for (const c of results) {
    const theirs = norm(c.name).split(' ').filter(Boolean)
    if (!theirs.length) continue
    const common = theirs.filter((w) => words.has(w)).length
    // part des mots en commun des deux côtés (« Rainbow Six Siege » contre « Tom Clancy's Rainbow Six Siege »)
    const score = (common / words.size + common / theirs.length) / 2
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return bestScore >= 0.6 ? best : null
}

export async function searchTwitchCategories(query: string): Promise<TwitchCategory[]> {
  const q = String(query ?? '').trim().slice(0, 100)
  if (!q) return []
  if (fake) return fake.category ? [fake.category] : []
  const res = await helix(`search/categories?query=${encodeURIComponent(q)}&first=20`)
  if (res?.status !== 200 || !Array.isArray(res.json?.data)) return []
  return res.json.data.map(toCategory).filter((c: TwitchCategory | null): c is TwitchCategory => !!c)
}

async function findCategory(name: string): Promise<{ category: TwitchCategory | null; ok: boolean }> {
  const exact = await helix(`games?name=${encodeURIComponent(name)}`)
  if (!exact) return { category: null, ok: false }
  const direct = exact.status === 200 ? toCategory(exact.json?.data?.[0]) : null
  if (direct) return { category: direct, ok: true }
  const res = await helix(`search/categories?query=${encodeURIComponent(name)}&first=20`)
  if (res?.status !== 200 || !Array.isArray(res.json?.data)) return { category: null, ok: !!res && res.status < 500 }
  const list = res.json.data.map(toCategory).filter((c: TwitchCategory | null): c is TwitchCategory => !!c)
  return { category: bestCategory(name, list), ok: true }
}

async function categoryFor(gameId: string, name: string): Promise<{ category: TwitchCategory | null; manual: boolean }> {
  const saved = store.categories[gameId]
  if (saved?.manual) return { category: saved.category, manual: true }
  const maxAge = saved?.category ? CATEGORY_MAX_AGE : CATEGORY_MISS_MAX_AGE
  if (saved && saved.name === name && Date.now() - saved.at < maxAge) return { category: saved.category, manual: false }
  const found = await findCategory(name)
  // Twitch n'a pas répondu : l'ancienne catégorie (s'il y en a une) reste utilisée
  if (!found.ok) return { category: saved?.category ?? null, manual: false }
  store.categories[gameId] = { category: found.category, manual: false, name, at: Date.now() }
  saveStore()
  return { category: found.category, manual: false }
}

export async function setTwitchCategory(gameId: string, category: TwitchCategory | null): Promise<void> {
  const id = String(gameId)
  if (category && typeof category.id === 'string' && category.id) {
    const clean: TwitchCategory = { id: category.id, name: String(category.name ?? ''), boxArt: allowedImage(category.boxArt) }
    store.categories[id] = { category: clean, manual: true, name: '', at: Date.now() }
  } else {
    delete store.categories[id]
  }
  if (fake && category) fake.category = category
  saveStore()
  cache.clear()
}

function toStream(s: any): TwitchStream | null {
  if (!s || typeof s.user_login !== 'string' || !s.user_login) return null
  const started = Date.parse(String(s.started_at ?? ''))
  return {
    id: String(s.id ?? s.user_id ?? s.user_login),
    userId: String(s.user_id ?? ''),
    userLogin: s.user_login,
    userName: String(s.user_name || s.user_login),
    title: String(s.title ?? '').trim(),
    viewers: Number(s.viewer_count) || 0,
    language: typeof s.language === 'string' && s.language ? s.language : 'other',
    startedAt: Number.isFinite(started) ? started : 0,
    thumbnail: sized(s.thumbnail_url, 440, 248) ?? '',
    tags: Array.isArray(s.tags) ? s.tags.map(String).slice(0, 6) : [],
    mature: s.is_mature === true
  }
}

const empty = (status: TwitchStreams['status'], extra: Partial<TwitchStreams> = {}): TwitchStreams => ({
  status,
  category: null,
  manual: false,
  streams: [],
  cursor: null,
  error: null,
  fetchedAt: Date.now(),
  ...extra
})

export async function getTwitchStreams(gameId: string, query: TwitchStreamsQuery = {}): Promise<TwitchStreams> {
  const id = String(gameId)
  const language = typeof query.language === 'string' && /^[a-z]{2,3}(-[a-z]{2,4})?$|^other$/i.test(query.language) ? query.language.toLowerCase() : null
  const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : null
  const followed = query.followed === true
  if (fake) {
    const user = fake.user
    if (!user) return empty('signed-out')
    let streams = fake.streams.filter((s) => !language || s.language === language)
    if (followed) streams = streams.filter((_, i) => i % 3 === 0)
    return empty('ok', { category: fake.category, manual: !!store.categories[id]?.manual, streams })
  }
  if (!clientId()) return empty('not-configured')
  if (!loadTokens()) return empty('signed-out')
  const game = libraryState().games.find((g) => g.id === id)
  if (!game) return empty('error', { error: t('twitch.error.noGame') })

  const { category, manual } = await categoryFor(id, game.name)
  if (!loadTokens()) return empty('signed-out')
  if (!category) return empty('no-category', { manual })

  const key = `${category.id}|${language ?? ''}|${cursor ?? ''}|${followed ? 'f' : ''}`
  const hit = cache.get(key)
  if (hit && !query.refresh && Date.now() - hit.at < CACHE_MAX_AGE) return { ...hit.value, manual }

  let res: { status: number; json: any } | null
  if (followed) {
    const userId = store.user?.id
    res = userId ? await helix(`streams/followed?user_id=${encodeURIComponent(userId)}&first=${PAGE_SIZE}`) : null
  } else {
    const params = new URLSearchParams({ game_id: category.id, first: String(PAGE_SIZE) })
    if (language) params.set('language', language)
    if (cursor) params.set('after', cursor)
    res = await helix(`streams?${params.toString()}`)
  }
  if (!loadTokens()) return empty('signed-out')
  if (!res || res.status !== 200 || !Array.isArray(res.json?.data)) {
    const error = !res ? t('twitch.error.offline') : t('twitch.error.http', { status: res.status })
    return empty('error', { category, manual, error })
  }
  let streams = (res.json.data as any[])
    .filter((s) => !followed || String(s?.game_id ?? '') === category.id)
    .map(toStream)
    .filter((s): s is TwitchStream => !!s)
  if (followed && language) streams = streams.filter((s) => s.language === language)
  const next = !followed && typeof res.json?.pagination?.cursor === 'string' && res.json.pagination.cursor && streams.length ? res.json.pagination.cursor : null
  const value = empty('ok', { category, manual, streams, cursor: next })
  cache.set(key, { at: Date.now(), value })
  return value
}

// ---------- Lecteur et chat intégrés (<webview>) ----------

const TWITCH_HOST = /(^|\.)(twitch\.tv|ttvnw\.net|jtvnw\.net)$/i
/** pages de connexion de Twitch : jamais dans l'app (l'app ne doit pas voir de mot de passe) */
const LOGIN_PATH = /^\/(login|signup|passport|settings)(\/|$)/i

function allowedTwitchUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && TWITCH_HOST.test(u.hostname) && !(/(^|\.)twitch\.tv$/i.test(u.hostname) && LOGIN_PATH.test(u.pathname)) && u.hostname.toLowerCase() !== 'passport.twitch.tv'
  } catch {
    return false
  }
}

function isTwitchHost(raw: string): boolean {
  try {
    return /(^|\.)twitch\.tv$/i.test(new URL(raw).hostname)
  } catch {
    return false
  }
}

/** Adresses que l'interface peut charger dans une <webview> : lecteur et chat officiels seulement. */
function allowedEmbedSrc(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    if (u.hostname === 'player.twitch.tv') return u.pathname === '/'
    return u.hostname === 'www.twitch.tv' && /^\/embed\/[a-z0-9_]{1,40}\/chat$/i.test(u.pathname)
  } catch {
    return false
  }
}

/** Lien ouvert depuis le lecteur ou le chat : navigateur de l'utilisateur (https seulement). */
function openOutside(url: string): void {
  try {
    if (new URL(url).protocol === 'https:') openExternalLink(url)
  } catch {
    // adresse invalide
  }
}

/**
 * Prépare la session des <webview> et verrouille celles de la fenêtre : pas de préchargement ni
 * de Node, session « persist:twitch » obligatoire, lecteur ou chat officiels seulement,
 * navigation limitée aux domaines de Twitch, nouvelles fenêtres ouvertes dans le navigateur.
 */
export function secureTwitchWebviews(contents: WebContents, onEscape: () => void): void {
  const ses = session.fromPartition(TWITCH_PARTITION)
  // agent utilisateur d'un Chrome ordinaire (sans « Electron » ni le nom de l'app)
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|CyberDeck|cyberdeck)\/\S+/g, ''))
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen' || permission === 'clipboard-sanitized-write'))
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen' || permission === 'clipboard-sanitized-write')

  contents.on('will-attach-webview', (e, prefs, params) => {
    // textes de Twitch (chat, lecteur) dans la langue de l'app plutôt que celle de Windows
    ses.setUserAgent(ses.getUserAgent(), getLang() === 'fr' ? 'fr-FR,fr,en' : 'en-US,en')
    if (params.partition !== TWITCH_PARTITION || !allowedEmbedSrc(params.src)) {
      deps.log(`<webview> refusée : ${params.src}`)
      e.preventDefault()
      return
    }
    delete (prefs as { preload?: string }).preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.webSecurity = true
    prefs.allowRunningInsecureContent = false
    // le lecteur démarre avec le son sans clic dans la page
    prefs.autoplayPolicy = 'no-user-gesture-required'
  })

  contents.on('did-attach-webview', (_e, guest) => {
    // Lien vers un autre site : ouvert dans le navigateur seulement depuis le chat (liens des
    // spectateurs). Le lecteur contient des publicités qui ouvrent des fenêtres sans clic :
    // depuis lui, seules les pages de Twitch sont ouvertes dehors.
    const fromPlayer = (): boolean => guest.getURL().startsWith('https://player.twitch.tv/')
    const outside = (url: string): void => {
      if (!fromPlayer() || isTwitchHost(url)) openOutside(url)
    }
    guest.setWindowOpenHandler(({ url }) => {
      outside(url)
      return { action: 'deny' }
    })
    const guard = (e: { preventDefault: () => void }, url: string): void => {
      if (allowedTwitchUrl(url)) return
      e.preventDefault()
      outside(url)
    }
    guest.on('will-navigate', (e, url) => guard(e, url))
    guest.on('will-redirect', (e, url) => guard(e, url))
    // Échap dans le lecteur ou le chat : le clavier ne remonte pas jusqu'à la fenêtre
    guest.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') onEscape()
    })
  })
}

// ---------- Démarrage ----------

export function initTwitch(d: Deps): void {
  deps = d
  loadStore()
  const fakeFile = process.env.CYBERDECK_TWITCH_FAKE
  if (fakeFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(fakeFile, 'utf8'))
      fake = { user: raw.user ?? null, category: raw.category ?? null, streams: Array.isArray(raw.streams) ? raw.streams : [] }
      deps.log(`Twitch : données de démonstration (${fake.streams.length} streams)`)
    } catch (err) {
      deps.log(`Twitch : données de démonstration illisibles (${(err as Error).message})`)
    }
  }
  // sans compte connecté, validate() ne fait rien
  if (!fake && clientId()) {
    setTimeout(() => void validate().catch(() => {}), 5000)
    setInterval(() => void validate().catch(() => {}), VALIDATE_PERIOD)
  }
}
