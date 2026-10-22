// Plateformes de jeux côté Electron : quand relire (démarrage, bouton, dossiers
// surveillés, toutes les 10 min, retour sur la fenêtre), état affiché par
// l'interface, compte Steam et clé Web API (chiffrée par Windows via safeStorage).
import { app, net, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PLATFORM_INFO, PLATFORM_ORDER } from '../shared/platforms'
import { t, tn } from '../shared/i18n'
import type {
  LauncherPlatform,
  PlatformsState,
  PlatformStatus,
  SteamAccountState,
  SteamAccountStatus,
  SteamKeyResult
} from '../shared/types'
import type { ApplyReport } from './games'
import { scanPlatforms, takeSnapshot, type PlatformScan, type RegistrySnapshot } from './platforms'
import { battlenetWatchDirs } from './platforms/battlenet'
import { epicWatchDirs } from './platforms/epic'
import { protocolRegistered } from './platforms/registry'
import { findSteamClient, steamAccount, steamWatchDirs, type SteamAccount } from './platforms/steam'
import {
  fetchOwnedGames,
  fetchStoreTypes,
  isSteamKeyFormat,
  normalizeSteamKey,
  type FetchJson,
  type OwnedGamesResult
} from './platforms/steamOwned'

interface Deps {
  log: (message: string) => void
  broadcast: (s: PlatformsState) => void
  apply: (scans: PlatformScan[]) => Map<LauncherPlatform, ApplyReport>
  forgetOwned: () => void
  hiddenCount: () => number
  ownedCounts: () => { owned: number; notInstalled: number }
}

interface Store {
  version: 1
  /** clé Web API chiffrée par safeStorage (base64) */
  steamKey: string | null
  steamStatus: SteamAccountStatus | null
  steamMessage: string | null
  steamRefreshAt: number | null
  lastSyncAt: number | null
  platforms: Partial<Record<LauncherPlatform, PlatformStatus>>
}

interface SyncRequest {
  full?: boolean
  only?: LauncherPlatform[]
  refreshOwned?: boolean
}

const PERIOD = 10 * 60_000
const OWNED_MAX_AGE = 6 * 3600_000
const OWNED_RETRY = 10 * 60_000
const FOCUS_MIN_GAP = 2 * 60_000

let deps: Deps
let store: Store = { version: 1, steamKey: null, steamStatus: null, steamMessage: null, steamRefreshAt: null, lastSyncAt: null, platforms: {} }
let reg: RegistrySnapshot | null = null
let account: SteamAccount | null = null
let steamInstalled = false
let ownedCache: { steamId: string; result: OwnedGamesResult; at: number } | null = null
let ownedAttemptAt = 0
let checking = false
let syncing = false
/** dernière lecture complète de cette session (0 = pas encore) */
let sessionSyncAt = 0
let runner: Promise<void> | null = null
let pending: { full: boolean; only: Set<LauncherPlatform>; refreshOwned: boolean } | null = null
let periodic: NodeJS.Timeout | null = null
const watchers = new Map<string, fs.FSWatcher>()
const debounce = new Map<LauncherPlatform, NodeJS.Timeout>()
/** relectures d'affilée demandées par une plateforme dont un fichier était en cours d'écriture */
const retries = new Map<LauncherPlatform, number>()

const storePath = (): string => path.join(app.getPath('userData'), 'platforms.json')

function saveStore(): void {
  try {
    const tmp = storePath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1))
    fs.renameSync(tmp, storePath())
  } catch (err: any) {
    deps.log(`Sauvegarde de platforms.json impossible : ${err.message}`)
  }
}

const fetchJson: FetchJson = async (url, timeoutMs = 15_000) => {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    // réponse vide ou pas en JSON
  }
  return { status: res.status, json }
}

function broadcast(): void {
  deps.broadcast(platformsState())
}

// ---------- Démarrage ----------

export function initPlatforms(d: Deps): void {
  deps = d
  try {
    const saved = JSON.parse(fs.readFileSync(storePath(), 'utf8'))
    store = { ...store, ...saved, platforms: saved.platforms ?? {} }
  } catch (err: any) {
    if (err.code !== 'ENOENT') deps.log(`platforms.json illisible : ${err.message}`)
  }
  periodic = setInterval(() => void syncPlatforms({ full: true }), PERIOD)
}

export function stopPlatforms(): void {
  if (periodic) clearInterval(periodic)
  periodic = null
  for (const t of debounce.values()) clearTimeout(t)
  debounce.clear()
  for (const w of watchers.values()) w.close()
  watchers.clear()
}

/** La fenêtre revient au premier plan : relecture si la dernière date un peu (jamais avant la première). */
export function onWindowFocus(): void {
  if (!runner && sessionSyncAt > 0 && Date.now() - sessionSyncAt > FOCUS_MIN_GAP) void syncPlatforms({ full: true })
}

/** Protocole enregistré (inconnu avant la première lecture : on laisse Windows répondre). */
export const protocolAvailable = (scheme: string): boolean => (reg?.ok ? protocolRegistered(reg, scheme) : true)

export const steamAvatarFile = (): string | null => account?.avatarFile ?? null

// ---------- État ----------

function steamState(): SteamAccountState {
  const canStoreKey = safeStorage.isEncryptionAvailable()
  const hasKey = !!store.steamKey
  const counts = deps.ownedCounts()
  let status: SteamAccountStatus
  let message: string | null = null
  if (!account) {
    status = 'no-account'
    message = steamInstalled ? t('main.steam.noAccount') : t('main.steam.notInstalled')
  } else if (!hasKey) {
    status = canStoreKey ? 'no-key' : 'unavailable'
    message = canStoreKey
      ? t('main.steam.addKey')
      : t('main.steam.cantEncrypt')
  } else if (!readKey()) {
    status = 'error'
    message = t('main.steam.keyUnreadable')
  } else if (checking) {
    status = 'checking'
    message = t('main.steam.checking')
  } else {
    status = store.steamStatus ?? 'checking'
    // message enregistré dans la langue de sa lecture : redit dans la langue en cours quand il ne dépend que de l'état
    message =
      status === 'ok'
        ? tn('main.steam.ownedSummary', counts.owned, { notInstalled: counts.notInstalled })
        : status === 'private'
          ? t('main.steam.private')
          : status === 'offline'
            ? t('main.steam.offline')
            : status === 'invalid-key'
              ? t('main.steam.keyRefused')
              : store.steamMessage
  }
  let avatarUrl: string | null = null
  if (account?.avatarFile) {
    try {
      avatarUrl = `essaim://avatar/steam?v=${Math.round(fs.statSync(account.avatarFile).mtimeMs)}`
    } catch {
      avatarUrl = null
    }
  }
  const known = hasKey && status === 'ok'
  return {
    detected: !!account,
    steamId: account?.steamId ?? null,
    personaName: account?.personaName ?? null,
    avatarUrl,
    hasKey,
    canStoreKey,
    status,
    message,
    ownedCount: known ? counts.owned : null,
    ownedNotInstalledCount: known ? counts.notInstalled : null,
    lastRefreshAt: store.steamRefreshAt
  }
}

export function platformsState(): PlatformsState {
  return {
    platforms: PLATFORM_ORDER.map((id) => ({
      id,
      name: PLATFORM_INFO[id].name,
      state: 'absent' as const,
      clientPath: null,
      installedCount: 0,
      excludedCount: 0,
      duplicateCount: 0,
      error: null,
      scannedAt: null,
      // état enregistré par une version d'avant le détail des éléments écartés : liste vide
      ...store.platforms[id],
      skipped: store.platforms[id]?.skipped ?? []
    })),
    syncing,
    lastSyncAt: store.lastSyncAt,
    steam: steamState(),
    hiddenCount: deps.hiddenCount()
  }
}

// ---------- Lecture des plateformes ----------

function mergeRequest(a: typeof pending, r: SyncRequest): NonNullable<typeof pending> {
  const out = a ?? { full: false, only: new Set<LauncherPlatform>(), refreshOwned: false }
  if (r.full || !r.only?.length) out.full = true
  for (const p of r.only ?? []) out.only.add(p)
  out.refreshOwned = out.refreshOwned || !!r.refreshOwned
  return out
}

/** Relit les plateformes (toutes par défaut) et met la bibliothèque à jour. Les demandes qui arrivent pendant un passage sont regroupées. */
export async function syncPlatforms(req: SyncRequest = { full: true }): Promise<PlatformsState> {
  // captures de démonstration (tests/tools/demo-profile.mjs) : les lanceurs du PC ne sont pas lus
  if (process.env.CYBERDECK_TEST_NO_PLATFORMS) return platformsState()
  pending = mergeRequest(pending, req)
  if (!runner)
    runner = (async () => {
      try {
        while (pending) {
          const r = pending
          pending = null
          await runSync(r)
        }
      } finally {
        runner = null
      }
    })()
  await runner
  return platformsState()
}

let keyCache: { enc: string; plain: string | null } | null = null

/** Clé déchiffrée (null : pas de clé, ou clé illisible, ex. platforms.json copié d'un autre compte Windows). */
function readKey(): string | null {
  if (!store.steamKey) return null
  if (keyCache?.enc !== store.steamKey) {
    let plain: string | null = null
    try {
      plain = safeStorage.decryptString(Buffer.from(store.steamKey, 'base64'))
    } catch {
      plain = null
    }
    keyCache = { enc: store.steamKey, plain }
  }
  return keyCache.plain
}

function refreshAccount(): void {
  if (!reg) return
  const client = findSteamClient(reg)
  steamInstalled = !!client
  account = steamAccount(reg, client?.dir ?? null)
}

/** Liste possédée à utiliser pour ce passage (téléchargée si besoin). */
async function ownedForScan(force: boolean, full: boolean): Promise<OwnedGamesResult | null> {
  const key = readKey()
  if (!account || !key) return null
  const cached = ownedCache && ownedCache.steamId === account.steamId ? ownedCache : null
  const stale = !cached || Date.now() - cached.at > OWNED_MAX_AGE
  if (force || (full && stale && Date.now() - ownedAttemptAt > (cached ? 0 : OWNED_RETRY))) {
    ownedAttemptAt = Date.now()
    checking = true
    broadcast()
    const res = await fetchOwnedGames(fetchJson, key, account.steamId)
    checking = false
    store.steamStatus = res.status
    store.steamMessage = res.message
    if (res.status === 'ok') {
      ownedCache = { steamId: account.steamId, result: res, at: Date.now() }
      store.steamRefreshAt = Date.now()
    } else deps.log(`Steam : liste des jeux possédés non lue (${res.status})`)
    saveStore()
  }
  return ownedCache && ownedCache.steamId === account.steamId ? ownedCache.result : null
}

async function runSync(r: NonNullable<typeof pending>): Promise<void> {
  syncing = true
  broadcast()
  const t0 = Date.now()
  try {
    const full = r.full || !reg
    if (full) {
      reg = await takeSnapshot()
      refreshAccount()
    }
    const only = full ? undefined : [...r.only]
    const withSteam = !only || only.includes('steam')
    const owned = withSteam ? await ownedForScan(r.refreshOwned, full) : null
    const { reg: usedReg, scans } = await scanPlatforms({
      reg,
      only,
      steam: { owned, storeTypes: (ids) => fetchStoreTypes(fetchJson, ids) },
      log: deps.log,
      tempDir: app.getPath('temp')
    })
    reg = usedReg
    const report = deps.apply(scans)
    const now = Date.now()
    for (const scan of scans) {
      const rep = report.get(scan.platform) ?? { installed: 0, duplicates: 0, skipped: [] }
      const skipped = [...(scan.skipped ?? []), ...rep.skipped]
      // doublons vus par la plateforme elle-même (paquet Xbox déjà en jeu local, jeu Rockstar acheté sur Steam…)
      const scanDuplicates = (scan.skipped ?? []).filter((s) => s.reason === 'local' || s.reason === 'platform').length
      store.platforms[scan.platform] = {
        id: scan.platform,
        name: PLATFORM_INFO[scan.platform].name,
        state: !scan.ok ? 'error' : scan.detected || rep.installed > 0 ? 'detected' : 'absent',
        clientPath: scan.clientPath,
        installedCount: rep.installed,
        excludedCount: scan.excluded,
        duplicateCount: rep.duplicates + scanDuplicates,
        // doublons d'abord (peu nombreux), puis les éléments écartés ; 40 noms au plus
        skipped: [...skipped.filter((s) => s.reason === 'local' || s.reason === 'platform'), ...skipped.filter((s) => s.reason !== 'local' && s.reason !== 'platform')].slice(0, 40),
        error: scan.error,
        scannedAt: now
      }
      // Fichier en cours d'écriture : nouvelle lecture de cette plateforme dans quelques secondes (3 fois au plus d'affilée).
      const tries = retries.get(scan.platform) ?? 0
      if (scan.retry && tries < 3) {
        retries.set(scan.platform, tries + 1)
        schedule(scan.platform)
      } else if (!scan.retry) retries.delete(scan.platform)
    }
    if (full) {
      store.lastSyncAt = now
      sessionSyncAt = now
      const summary = scans
        .filter((s) => s.detected || !s.ok)
        .map((s) => `${s.platform} ${s.ok ? (report.get(s.platform)?.installed ?? 0) : 'erreur'}`)
        .join(', ')
      deps.log(`Plateformes lues en ${((now - t0) / 1000).toFixed(1)} s : ${summary || 'aucune'}`)
    }
    saveStore()
    updateWatchers()
  } catch (err: any) {
    deps.log(`Lecture des plateformes impossible : ${err?.message ?? err}`)
  } finally {
    syncing = false
    checking = false
    broadcast()
  }
}

// ---------- Dossiers surveillés ----------

const WATCH_FILTER: Partial<Record<LauncherPlatform, RegExp>> = {
  steam: /^appmanifest_\d+\.acf$/i,
  epic: /\.item$/i,
  battlenet: /^product\.db$/i
}

function schedule(platform: LauncherPlatform): void {
  const t = debounce.get(platform)
  if (t) clearTimeout(t)
  debounce.set(
    platform,
    setTimeout(() => {
      debounce.delete(platform)
      void syncPlatforms({ only: [platform] })
    }, 4000)
  )
}

function updateWatchers(): void {
  const wanted = new Map<string, LauncherPlatform>()
  for (const d of steamWatchDirs()) wanted.set(d, 'steam')
  for (const d of epicWatchDirs(reg)) wanted.set(d, 'epic')
  for (const d of battlenetWatchDirs()) wanted.set(d, 'battlenet')
  const before = [...watchers.keys()].sort().join('|')
  for (const [dir, w] of watchers) {
    if (!wanted.has(dir)) {
      w.close()
      watchers.delete(dir)
    }
  }
  for (const [dir, platform] of wanted) {
    if (watchers.has(dir)) continue
    try {
      const filter = WATCH_FILTER[platform]
      const w = fs.watch(dir, { persistent: false }, (_event, file) => {
        if (!file || !filter || filter.test(String(file))) schedule(platform)
      })
      w.on('error', () => {
        w.close()
        watchers.delete(dir)
      })
      watchers.set(dir, w)
    } catch {
      // dossier illisible : la relecture toutes les 10 min suffira
    }
  }
  const after = [...watchers.keys()].sort()
  if (after.join('|') !== before) deps.log(`Dossiers de plateformes surveillés : ${after.length ? after.join(' ; ') : 'aucun'}`)
}

// ---------- Compte Steam ----------

async function ensureAccount(): Promise<void> {
  if (!reg) {
    reg = await takeSnapshot()
    refreshAccount()
  }
}

function result(ok: boolean, status: SteamAccountStatus, message: string, gameCount?: number): SteamKeyResult {
  return { ok, status, message, gameCount, account: steamState() }
}

export async function testSteamKey(key?: string): Promise<SteamKeyResult> {
  await ensureAccount()
  const k = key !== undefined ? normalizeSteamKey(key) : readKey()
  if (!account) return result(false, 'no-account', steamState().message ?? t('main.steam.noAccountShort'))
  if (!k) return result(false, 'no-key', t('main.steam.noKey'))
  if (!isSteamKeyFormat(k)) return result(false, 'invalid-key', t('main.steam.keyFormat'))
  const res = await fetchOwnedGames(fetchJson, k, account.steamId)
  return result(res.status === 'ok', res.status, res.message, res.status === 'ok' ? res.games.length : undefined)
}

export async function setSteamKey(key: string): Promise<SteamKeyResult> {
  await ensureAccount()
  const k = normalizeSteamKey(key)
  if (!safeStorage.isEncryptionAvailable()) return result(false, 'unavailable', t('main.steam.cantEncryptNotSaved'))
  if (!account) return result(false, 'no-account', steamState().message ?? t('main.steam.noAccountShort'))
  if (!isSteamKeyFormat(k)) return result(false, 'invalid-key', t('main.steam.keyFormat'))
  checking = true
  broadcast()
  const res = await fetchOwnedGames(fetchJson, k, account.steamId)
  checking = false
  // Clé refusée : rien n'est enregistré. Hors ligne / profil privé : la clé est gardée, on réessaiera.
  if (res.status === 'invalid-key') {
    broadcast()
    return result(false, res.status, res.message)
  }
  store.steamKey = safeStorage.encryptString(k).toString('base64')
  store.steamStatus = res.status
  store.steamMessage = res.message
  ownedAttemptAt = Date.now()
  if (res.status === 'ok') {
    ownedCache = { steamId: account.steamId, result: res, at: Date.now() }
    store.steamRefreshAt = Date.now()
  }
  saveStore()
  deps.log(`Clé Web API Steam enregistrée (chiffrée), état : ${res.status}`)
  await syncPlatforms({ only: ['steam'] })
  return result(res.status === 'ok', res.status, res.status === 'ok' ? steamState().message ?? res.message : res.message, res.status === 'ok' ? res.games.length : undefined)
}

export function clearSteamKey(): SteamAccountState {
  store.steamKey = null
  store.steamStatus = null
  store.steamMessage = null
  store.steamRefreshAt = null
  ownedCache = null
  saveStore()
  deps.forgetOwned()
  deps.log('Clé Web API Steam oubliée')
  broadcast()
  return steamState()
}

export async function refreshSteamOwned(): Promise<SteamAccountState> {
  await syncPlatforms({ only: ['steam'], refreshOwned: true })
  return steamState()
}
