// Twitch côté Electron : connexion du compte par code d'appareil (twitchAuth.ts), jetons
// chiffrés par le système (safeStorage : Windows, ou trousseau de clés sous Linux) dans
// <profil>/twitch.json, catégorie Twitch de
// chaque jeu (trouvée par son nom, corrigeable à la main), streams en direct (Helix, cache 60 s),
// et verrouillage des <webview> du lecteur et du chat (session « persist:twitch », sites de
// Twitch seulement, aucune fenêtre ouverte dans l'app).
// Envoyé à Twitch : le nom du jeu (recherche de sa catégorie) et le jeton du compte.
import { app, net, safeStorage, session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getLang, t } from '../shared/i18n'
import type { TwitchCategory, TwitchCategorySearch, TwitchSignIn, TwitchState, TwitchStream, TwitchStreams, TwitchStreamsQuery, TwitchUser } from '../shared/types'
import { allowedImage, openExternalLink } from './gameDetails'
import { libraryState } from './games'
import { pollDeviceToken, refreshTokens, requestDeviceCode, revokeToken, TWITCH_ID, type PostForm, type Tokens } from './twitchAuth'

/**
 * Identifiant de l'application enregistrée sur dev.twitch.tv (type de client « Public »).
 * Le seul endroit à remplir. Vide : la rubrique Twitch affiche « Twitch n'est pas configuré ».
 * Tests : la variable d'environnement CYBERDECK_TWITCH_CLIENT_ID le remplace (« none » : comme
 * une version sans identifiant, pour l'état « non configuré »).
 */
export const TWITCH_CLIENT_ID = 'm9a9laukifj5196bn9qk7ciaeb5i0r'

/** Session des <webview> du lecteur et du chat (cookies de Twitch, séparés de l'app). */
export const TWITCH_PARTITION = 'persist:twitch'

function clientId(): string {
  const env = (process.env.CYBERDECK_TWITCH_CLIENT_ID ?? '').trim()
  if (env.toLowerCase() === 'none') return ''
  return env || TWITCH_CLIENT_ID
}
/** chaînes suivies (filtre « Chaînes suivies ») ; rien d'autre : lecture seule */
const FOLLOWS_SCOPE = 'user:read:follows'
const SCOPES = [FOLLOWS_SCOPE]
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
/** limite d'appels atteinte (429) : attente avant un nouvel essai, si Twitch annonce moins que ça */
const RATE_WAIT_MAX = 3000
/** compte pas encore lu (Twitch ne répondait pas juste après l'accord) : nouvel essai après ce délai */
const USER_RETRY = 30_000
/** catégories de jeux retirés de la bibliothèque : oubliées après ce délai (sauf choix à la main) */
const CATEGORY_FORGET = 30 * 86_400_000

/** Réponse HTTP réduite ; reset : fin de la limite d'appels (ms), d'après l'en-tête Ratelimit-Reset. */
type Res = { status: number; json: any; reset: number | null } | null

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
let refreshing: Promise<'ok' | 'invalid' | 'network'> | null = null
let fake: Fake | null = null
let userFetch: Promise<void> | null = null
let userRetry: ReturnType<typeof setTimeout> | null = null
let pruned = false
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
    // l'interface le dit (« reconnectez-vous ») au lieu de montrer un compte connecté
    lastError = 'twitch.error.expired'
    setImmediate(broadcast)
  }
  return mem
}

function saveTokens(tokens: Tokens | null): void {
  mem = tokens
  store.tokens = tokens ? safeStorage.encryptString(JSON.stringify(tokens)).toString('base64') : null
  saveStore()
}

// ---------- État ----------

/** Compte connecté dont le profil n'a pas encore pu être lu : l'interface le montre quand même connecté. */
const PENDING_USER: TwitchUser = { id: '', login: '', displayName: '', avatar: null }

// Les erreurs connues (lastError, signIn.error) sont envoyées comme clés de traduction
// (« twitch.error.… ») : l'interface les traduit, donc elles suivent un changement de langue.
export function twitchState(): TwitchState {
  if (fake) return { configured: true, canStore: true, user: fake.user, signIn, error: null }
  const configured = !!clientId()
  return {
    configured,
    canStore: safeStorage.isEncryptionAvailable(),
    // jetons lisibles seulement (trousseau verrouillé, clé changée : pas connecté)
    user: configured && loadTokens() ? (store.user ?? PENDING_USER) : null,
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

async function getJson(url: string, headers: Record<string, string>): Promise<Res> {
  try {
    const res = await net.fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      // page d'erreur
    }
    const reset = Number(res.headers?.get?.('ratelimit-reset'))
    return { status: res.status, json, reset: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null }
  } catch {
    return null
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 401 dû à un droit manquant (« Missing scope ») : un nouveau jeton n'y changerait rien. */
const missingScope = (json: any): boolean => typeof json?.message === 'string' && /missing scope/i.test(json.message)

/** Texte de l'échec d'un appel (hors ligne, limite d'appels, droit manquant, autre erreur HTTP). */
function failureText(res: Res): string {
  if (!res) return t('twitch.error.offline')
  if (res.status === 429) return t('twitch.error.rateLimit')
  if (res.status === 401 && missingScope(res.json)) return t('twitch.error.scope')
  return t('twitch.error.http', { status: res.status })
}

/**
 * Numéro de la session Twitch : augmenté à chaque déconnexion. Un rafraîchissement parti avant
 * une déconnexion n'enregistre pas ses jetons (pas de reconnexion silencieuse).
 */
let sessionNo = 0

/** Jetons refusés pour de bon (révoqués, rafraîchissement expiré) : déconnexion locale. */
function dropSession(reason: string): void {
  sessionNo++
  deps.log(`Session Twitch terminée : ${reason}`)
  saveTokens(null)
  store.user = null
  saveStore()
  cache.clear()
  lastError = 'twitch.error.expired'
  broadcast()
}

type Refresh = 'ok' | 'invalid' | 'network'

/** Nouveau jeton d'accès ; « invalid » : session perdue (déconnexion locale), « network » : Twitch ne répond pas. */
function refresh(): Promise<Refresh> {
  if (refreshing) return refreshing
  refreshing = (async (): Promise<Refresh> => {
    const tokens = loadTokens()
    if (!tokens?.refresh) {
      if (tokens) dropSession('pas de jeton de rafraîchissement')
      return 'invalid'
    }
    const mine = sessionNo
    const r = await refreshTokens(post, clientId(), tokens.refresh, Date.now())
    if (mine !== sessionNo) return 'invalid'
    if (r.status === 'ok') {
      saveTokens({ ...r.tokens, scopes: r.tokens.scopes.length ? r.tokens.scopes : tokens.scopes })
      return 'ok'
    }
    if (r.status === 'invalid') dropSession('rafraîchissement refusé')
    return r.status
  })().finally(() => (refreshing = null))
  return refreshing
}

/**
 * Jeton d'accès à utiliser. offline : jeton expiré et Twitch injoignable pour le renouveler
 * (sortie de veille sans réseau) : « hors ligne » plutôt qu'un 401 trompeur.
 */
async function accessToken(): Promise<{ token: string | null; offline: boolean }> {
  const tokens = loadTokens()
  if (!tokens) return { token: null, offline: false }
  if (tokens.expiresAt - REFRESH_MARGIN < Date.now()) {
    const r = await refresh()
    if (r === 'ok') return { token: loadTokens()?.access ?? null, offline: false }
    if (r === 'invalid') return { token: null, offline: false }
    // l'ancien jeton sert encore pendant la marge ; expiré, il serait refusé
    return tokens.expiresAt > Date.now() ? { token: tokens.access, offline: false } : { token: null, offline: true }
  }
  return { token: tokens.access, offline: false }
}

/**
 * Appel à l'API Helix avec le jeton du compte. 429 : une attente courte (Ratelimit-Reset) puis
 * un nouvel essai ; 401 : un rafraîchissement puis un nouvel essai (sauf droit manquant).
 * null : Twitch ne répond pas.
 */
async function helix(query: string): Promise<Res> {
  const access = await accessToken()
  if (access.offline) return null
  if (!access.token) return { status: 401, json: null, reset: null }
  const call = (token: string): Promise<Res> => getJson(`${HELIX}/${query}`, { 'Client-Id': clientId(), Authorization: `Bearer ${token}` })
  let res = await call(access.token)
  if (res?.status === 429) {
    const wait = res.reset ? res.reset - Date.now() : 1000
    deps.log(`Twitch : limite d'appels atteinte (${query.split('?')[0]})`)
    if (wait <= RATE_WAIT_MAX) {
      await delay(Math.max(250, wait))
      res = await call(access.token)
    }
  }
  if (res?.status !== 401 || missingScope(res.json)) return res
  const r = await refresh()
  if (r === 'network') return null
  const again = r === 'ok' ? loadTokens()?.access : null
  return again ? call(again) : res
}

/**
 * Vérification demandée par Twitch (démarrage, puis toutes les heures). Sert aussi à relire le
 * compte s'il manque, et les droits réellement accordés (filtre « Chaînes suivies »).
 */
async function validate(): Promise<void> {
  if (fake || !clientId()) return
  const tokens = loadTokens()
  if (!tokens) return
  const res = await getJson(`${TWITCH_ID}/validate`, { Authorization: `OAuth ${tokens.access}` })
  if (!res) return
  if (res.status === 401) {
    if ((await refresh()) === 'ok') await ensureUser()
    return
  }
  if (res.status !== 200 || !res.json) return
  const scopes: string[] | null = Array.isArray(res.json.scopes) ? res.json.scopes.map(String) : null
  if (scopes && scopes.join(' ') !== tokens.scopes.join(' ')) saveTokens({ ...tokens, scopes })
  if (!store.user || !store.user.avatar) await ensureUser(true)
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

/**
 * Lit le compte connecté s'il manque (Twitch ne répondait pas juste après l'accord) ; repli sur
 * /oauth2/validate, qui donne au moins l'identifiant et le nom. Sans réponse : nouvel essai plus tard.
 * full : relit aussi un compte lu seulement par le repli (sans avatar).
 */
function ensureUser(full = false): Promise<void> {
  if (fake || !loadTokens() || (store.user && (!full || store.user.avatar))) return Promise.resolve()
  if (userFetch) return userFetch
  userFetch = (async () => {
    let user = await fetchUser()
    if (!user && !store.user) {
      const tokens = loadTokens()
      const res = tokens ? await getJson(`${TWITCH_ID}/validate`, { Authorization: `OAuth ${tokens.access}` }) : null
      const j = res?.status === 200 ? res.json : null
      if (j && typeof j.user_id === 'string' && j.user_id) {
        const login = String(j.login ?? '')
        user = { id: j.user_id, login, displayName: login, avatar: null }
      }
    }
    if (!loadTokens()) return
    if (user) {
      store.user = user
      saveStore()
      broadcast()
    } else if (!store.user && !userRetry) {
      userRetry = setTimeout(() => {
        userRetry = null
        void ensureUser().catch(() => {})
      }, USER_RETRY)
    }
  })().finally(() => (userFetch = null))
  return userFetch
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
    signIn = { userCode: '', verificationUri: '', expiresAt: 0, status: 'error', error: 'twitch.error.cantEncrypt' }
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
    // texte brut de Twitch (anglais) gardé pour le journal ; l'interface reçoit une clé traduite
    signIn = { userCode: '', verificationUri: '', expiresAt: 0, status: 'error', error: r.error === 'network' ? 'twitch.error.offline' : 'twitch.error.signInRefused' }
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
      store.user = null
      lastError = null
      saveStore()
      cache.clear()
      // connecté dès maintenant, même si le profil ne peut pas encore être lu (relu plus tard)
      signIn = null
      broadcast()
      await ensureUser()
      // relu après l'attente (TypeScript le croirait encore null)
      const who = store.user as TwitchUser | null
      deps.log(`Compte Twitch connecté${who ? ` : ${who.login}` : ' (profil pas encore lu)'}`)
    } else if (res.status === 'expired' || res.status === 'denied') {
      signIn = signIn && { ...signIn, status: res.status }
    } else if (res.status === 'error') {
      signIn = signIn && { ...signIn, status: 'error', error: 'twitch.error.signInRefused' }
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
  sessionNo++
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
  if (userRetry) clearTimeout(userRetry)
  userRetry = null
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

export async function searchTwitchCategories(query: string): Promise<TwitchCategorySearch> {
  const q = String(query ?? '').trim().slice(0, 100)
  if (!q) return { ok: true, categories: [] }
  if (fake) return { ok: true, categories: fake.category ? [fake.category] : [] }
  const res = await helix(`search/categories?query=${encodeURIComponent(q)}&first=20`)
  // panne, 401 ou limite d'appels : l'erreur réelle, pas « aucune catégorie trouvée »
  if (res?.status !== 200 || !Array.isArray(res.json?.data)) return { ok: false, error: failureText(res) }
  return { ok: true, categories: res.json.data.map(toCategory).filter((c: TwitchCategory | null): c is TwitchCategory => !!c) }
}

/**
 * Catégorie d'un nom de jeu : correspondance exacte, sinon recherche et rapprochement des noms.
 * Seule une vraie réponse (200) compte : une panne, un 401 ou une limite d'appels n'est pas
 * « aucune catégorie » (sinon gardé un jour). 400 sur games?name= : nom refusé, on cherche.
 */
async function findCategory(name: string): Promise<{ ok: true; category: TwitchCategory | null } | { ok: false; res: Res }> {
  const exact = await helix(`games?name=${encodeURIComponent(name)}`)
  if (!exact || (exact.status !== 200 && exact.status !== 400)) return { ok: false, res: exact }
  const direct = exact.status === 200 ? toCategory(exact.json?.data?.[0]) : null
  if (direct) return { ok: true, category: direct }
  const res = await helix(`search/categories?query=${encodeURIComponent(name)}&first=20`)
  if (!res || res.status !== 200 || !Array.isArray(res.json?.data)) return { ok: false, res }
  const list = res.json.data.map(toCategory).filter((c: TwitchCategory | null): c is TwitchCategory => !!c)
  return { ok: true, category: bestCategory(name, list) }
}

type CategoryAnswer = { category: TwitchCategory | null; manual: boolean; error: string | null }

/** recherches de catégorie en cours, par jeu : deux demandes simultanées font un seul appel */
const categoryLookups = new Map<string, Promise<CategoryAnswer>>()

function categoryFor(gameId: string, name: string): Promise<CategoryAnswer> {
  const k = `${gameId}|${name}`
  let p = categoryLookups.get(k)
  if (!p) {
    p = lookupCategory(gameId, name).finally(() => categoryLookups.delete(k))
    categoryLookups.set(k, p)
  }
  return p
}

/** error : Twitch n'a pas pu dire quelle est la catégorie (et aucune n'est connue). */
async function lookupCategory(gameId: string, name: string): Promise<CategoryAnswer> {
  const saved = store.categories[gameId]
  if (saved?.manual) return { category: saved.category, manual: true, error: null }
  const maxAge = saved?.category ? CATEGORY_MAX_AGE : CATEGORY_MISS_MAX_AGE
  if (saved && saved.name === name && Date.now() - saved.at < maxAge) return { category: saved.category, manual: false, error: null }
  const found = await findCategory(name)
  if (!found.ok) {
    // Twitch n'a pas répondu : l'ancienne catégorie (s'il y en a une) reste utilisée ; rien n'est gardé
    if (saved?.category) return { category: saved.category, manual: false, error: null }
    return { category: null, manual: false, error: failureText(found.res) }
  }
  store.categories[gameId] = { category: found.category, manual: false, name, at: Date.now() }
  saveStore()
  return { category: found.category, manual: false, error: null }
}

/** Oublie les catégories trouvées pour des jeux retirés de la bibliothèque depuis longtemps (une fois par session). */
function pruneCategories(ids: Set<string>): void {
  if (pruned || !ids.size) return
  pruned = true
  let changed = false
  for (const [id, entry] of Object.entries(store.categories)) {
    if (ids.has(id) || entry?.manual || Date.now() - (Number(entry?.at) || 0) < CATEGORY_FORGET) continue
    delete store.categories[id]
    changed = true
  }
  if (changed) saveStore()
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
  if (!store.user) void ensureUser().catch(() => {})
  const games = libraryState().games
  pruneCategories(new Set(games.map((g) => g.id)))
  const game = games.find((g) => g.id === id)
  if (!game) return empty('error', { error: t('twitch.error.noGame') })

  const { category, manual, error } = await categoryFor(id, game.name)
  if (!loadTokens()) return empty('signed-out')
  if (!category) return error ? empty('error', { manual, error }) : empty('no-category', { manual })

  const key = `${category.id}|${language ?? ''}|${cursor ?? ''}|${followed ? 'f' : ''}`
  const hit = cache.get(key)
  if (hit && !query.refresh && Date.now() - hit.at < CACHE_MAX_AGE) return { ...hit.value, manual }
  // même demande déjà en route (« Actualiser » relance deux effets) : un seul appel à Twitch
  let pending = streamLoads.get(key)
  if (!pending) {
    pending = loadStreams(category, manual, language, cursor, followed, key).finally(() => streamLoads.delete(key))
    streamLoads.set(key, pending)
  }
  return { ...(await pending), manual }
}

/** chargements de streams en cours, par clé du cache */
const streamLoads = new Map<string, Promise<TwitchStreams>>()

/** Pages lues au plus pour « Chaînes suivies » (100 chaînes en direct par page, classées par spectateurs). */
const FOLLOWED_PAGES = 5

async function loadStreams(
  category: TwitchCategory,
  manual: boolean,
  language: string | null,
  cursor: string | null,
  followed: boolean,
  key: string
): Promise<TwitchStreams> {
  let rows: any[]
  let next: string | null = null
  if (followed) {
    // jeton sans le droit de lire les chaînes suivies (accès réduit) : le dire, sans appel inutile
    const scopes = loadTokens()?.scopes ?? []
    if (scopes.length && !scopes.includes(FOLLOWS_SCOPE)) return empty('error', { category, manual, error: t('twitch.error.scope') })
    if (!store.user?.id) await ensureUser()
    const userId = store.user?.id
    if (!userId) return empty('error', { category, manual, error: t('twitch.error.offline') })
    // plusieurs pages avant le tri par jeu : une petite chaîne suivie qui joue à ce jeu n'est pas
    // perdue derrière les 100 plus regardées
    rows = []
    let after: string | null = null
    for (let page = 0; page < FOLLOWED_PAGES; page++) {
      const res = await helix(`streams/followed?user_id=${encodeURIComponent(userId)}&first=${PAGE_SIZE}${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      if (!loadTokens()) return empty('signed-out')
      if (!res || res.status !== 200 || !Array.isArray(res.json?.data)) {
        // première page en échec : l'erreur ; une suivante : ce qui a déjà été lu
        if (page === 0) return empty('error', { category, manual, error: failureText(res) })
        break
      }
      rows.push(...res.json.data)
      const c = res.json.pagination?.cursor
      after = typeof c === 'string' && c && res.json.data.length >= PAGE_SIZE ? c : null
      if (!after) break
    }
  } else {
    const params = new URLSearchParams({ game_id: category.id, first: String(PAGE_SIZE) })
    if (language) params.set('language', language)
    if (cursor) params.set('after', cursor)
    const res = await helix(`streams?${params.toString()}`)
    if (!loadTokens()) return empty('signed-out')
    if (!res || res.status !== 200 || !Array.isArray(res.json?.data)) return empty('error', { category, manual, error: failureText(res) })
    rows = res.json.data
    const c = res.json?.pagination?.cursor
    next = typeof c === 'string' && c && rows.length ? c : null
  }
  let streams = rows
    .filter((s) => !followed || String(s?.game_id ?? '') === category.id)
    .map(toStream)
    .filter((s): s is TwitchStream => !!s)
  // une chaîne vue sur deux pages (classement changé entre deux appels) n'apparaît qu'une fois
  if (followed) streams = streams.filter((s, i, all) => all.findIndex((x) => x.userLogin === s.userLogin) === i)
  if (followed && language) streams = streams.filter((s) => s.language === language)
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
    // jamais une page de connexion (id.twitch.tv, passport, /login…), même dans la page du lecteur
    return u.protocol === 'https:' && TWITCH_HOST.test(u.hostname) && !isLoginUrl(raw)
  } catch {
    return false
  }
}

/** Page de connexion de Twitch (twitch.tv/login, passport…). */
function isLoginUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    if (host === 'passport.twitch.tv' || host === 'id.twitch.tv') return true
    return /(^|\.)twitch\.tv$/i.test(host) && LOGIN_PATH.test(u.pathname)
  } catch {
    return false
  }
}

/** Chaîne affichée par une <webview> du lecteur (?channel=) ou du chat (/embed/<login>/chat). */
function channelOf(raw: string): string | null {
  try {
    const u = new URL(raw)
    const login = u.hostname === 'player.twitch.tv' ? u.searchParams.get('channel') : /^\/embed\/([a-z0-9_]{1,40})\/chat$/i.exec(u.pathname)?.[1]
    return login && /^[a-z0-9_]{1,40}$/i.test(login) ? login.toLowerCase() : null
  } catch {
    return null
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
    // Connexion demandée dans le lecteur ou le chat (« Se connecter pour discuter », chaîne
    // réservée aux abonnés…) : elle ne servirait à rien dans l'app (chat en lecture seule, pages
    // de connexion bloquées) ; on ouvre plutôt la chaîne ou son chat sur twitch.tv dans le navigateur.
    const fromPlayer = (): boolean => guest.getURL().startsWith('https://player.twitch.tv/')
    const outside = (url: string): void => {
      const channel = channelOf(guest.getURL())
      if (channel && isLoginUrl(url)) openOutside(fromPlayer() ? `https://www.twitch.tv/${channel}` : `https://www.twitch.tv/popout/${channel}/chat`)
      else if (!fromPlayer() || isTwitchHost(url)) openOutside(url)
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
