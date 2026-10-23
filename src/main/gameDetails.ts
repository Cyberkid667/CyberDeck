// Page détaillée d'un jeu : présentation, images, actualités, DLC, succès et amis
// (boutique et Web API de Steam, sinon Wikipédia), liens utiles, cache sur le disque
// (%APPDATA%\CyberDeck\details\<id>.json). Ouverture des liens de la page.
import { app, net, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getLang, t, type Lang } from '../shared/i18n'
import {
  IMAGE_HOSTS,
  type Game,
  type GameAchievement,
  type GameDetails,
  type GameFriend,
  type GameLink,
  type GameNewsItem
} from '../shared/types'
import { libraryState } from './games'
import { protocolAvailable, steamAccountId, steamApiCredentials } from './platformSync'
import { cachedSteamClient, steamAppInfo, steamCapsuleUrl } from './platforms/steam'

interface Deps {
  log: (message: string) => void
}

let deps: Deps = { log: () => {} }

export function initGameDetails(d: Deps): void {
  deps = d
}

/** Infos lentes à changer (boutique, images, DLC, Wikipédia) : relues après 6 h. */
const STATIC_MAX_AGE = 6 * 3600_000
/** Actualités, succès et amis : relus après 1 h. */
const LIVE_MAX_AGE = 3600_000
/** Rien ne doit faire attendre la page plus longtemps. */
const TOTAL_TIMEOUT = 12_000
const FETCH_TIMEOUT = 10_000
const FRIENDS_TIMEOUT = 8_000
const MAX_FRIENDS_CHECKED = 100
const MAX_DLC = 8
const STEAM_ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets'
const STORE = 'https://store.steampowered.com'
const COMMUNITY = 'https://steamcommunity.com'
const API = 'https://api.steampowered.com'

// ---------- Réseau ----------

/** Un passage de lecture : délai total commun et bilan (tout a échoué = hors ligne). */
interface Ctx {
  signal: AbortSignal
  ok: number
  failed: number
}

const newCtx = (): Ctx => ({ signal: AbortSignal.timeout(TOTAL_TIMEOUT), ok: 0, failed: 0 })

/** Réponse HTTP, ou null si le réseau n'a pas répondu (hors ligne, délai dépassé). */
async function request(ctx: Ctx, url: string, opts: { method?: string; timeout?: number; signal?: AbortSignal } = {}): Promise<Response | null> {
  try {
    const signals = [ctx.signal, AbortSignal.timeout(opts.timeout ?? FETCH_TIMEOUT)]
    if (opts.signal) signals.push(opts.signal)
    const res = await net.fetch(url, { method: opts.method ?? 'GET', headers: { 'User-Agent': 'CyberDeck' }, signal: AbortSignal.any(signals) })
    ctx.ok++
    return res
  } catch {
    ctx.failed++
    return null
  }
}

/** JSON d'une adresse ; null si pas de réponse. json vaut null si la réponse n'est pas du JSON. */
async function getJson(ctx: Ctx, url: string, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<{ status: number; json: any } | null> {
  const res = await request(ctx, url, opts)
  if (!res) return null
  let json: any = null
  try {
    json = await res.json()
  } catch {
    // réponse vide, page d'erreur HTML ou lecture coupée par le délai
  }
  return { status: res.status, json }
}

/** L'image existe (HEAD) ; undefined si le réseau n'a pas répondu. */
async function imageExists(ctx: Ctx, url: string): Promise<boolean | undefined> {
  const res = await request(ctx, url, { method: 'HEAD' })
  if (!res) return undefined
  return res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')
}

/** Adresse d'image gardée seulement si son hôte est autorisé par la fenêtre (IMAGE_HOSTS). */
export function allowedImage(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return null
    const host = u.hostname.toLowerCase()
    for (const h of IMAGE_HOSTS) {
      const pattern = h.slice('https://'.length)
      if (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern) return u.toString()
    }
  } catch {
    // adresse invalide
  }
  return null
}

/** Exécute fn sur chaque élément, `limit` à la fois. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

// ---------- Texte ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Texte brut d'un contenu HTML ou BBCode (actualités Steam, présentation de la boutique). */
function plainText(s: string): string {
  return decodeEntities(
    s
      .replace(/\[(img|video|previewyoutube|url=[^\]]*\]\s*\[img)[^\]]*\][\s\S]*?\[\/(img|video|previewyoutube)\]/gi, ' ')
      .replace(/\[\/?[a-z*][^\]]*\]/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{STEAM_CLAN_IMAGE\}\S*/g, ' ')
      // crochets échappés du BBCode (« \[ UI ] » dans les notes de mise à jour)
      .replace(/\\([[\]])/g, '$1')
  )
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Quelques phrases au plus (coupé sur un mot). */
function excerpt(s: string, max = 320): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const sentence = cut.lastIndexOf('. ')
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1)
  return cut.replace(/\s+\S*$/, '') + '…'
}

/** Première image d'une actualité ([img]…[/img], [img src="…"], <img src="…">), hôte autorisé. */
function firstImage(contents: string): string | null {
  const found: string[] = []
  for (const m of contents.matchAll(/\[img(?:\s+src=["']?([^"'\]\s]+)["']?)?[^\]]*\]([^[]*)/gi)) found.push((m[1] || m[2] || '').trim())
  for (const m of contents.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) found.push(m[1].trim())
  for (const raw of found) {
    const url = allowedImage(decodeEntities(raw).replace('{STEAM_CLAN_IMAGE}', 'https://clan.akamai.steamstatic.com/images'))
    if (url) return url
  }
  return null
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')

/** Nom d'un jeu pour une recherche (sans ™ ® ©). */
const searchName = (name: string): string => name.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim()

// ---------- Morceaux lus ----------

/** Infos de la boutique Steam (appdetails). */
interface StoreInfo {
  description: string | null
  developers: string[]
  publishers: string[]
  releaseDate: string | null
  genres: string[]
  dlcIds: number[]
  workshop: boolean
  hasAchievements: boolean
  website: string | null
}

interface StaticData {
  /** null : pas sur la boutique Steam */
  store: StoreInfo | null
  hero: string | null
  logo: string | null
  dlc: { appid: number; name: string }[]
  /** présentation de Wikipédia (pas de correspondance Steam) */
  wiki: { description: string; hero: string | null } | null
  /** page du jeu sur la boutique de sa plateforme (GOG) */
  storeUrl: string | null
}

interface LiveData {
  news: GameNewsItem[]
  achievements: GameDetails['achievements']
  friends: GameDetails['friends']
}

interface CacheFile {
  version: 1
  lang: Lang
  /** une clé d'API Steam était enregistrée (succès et amis lus) */
  keyed: boolean
  staticAt: number
  liveAt: number
  staticData: StaticData
  liveData: LiveData
  details: GameDetails
}

const steamLang = (lang: Lang): string => (lang === 'fr' ? 'french' : 'english')

async function readStore(ctx: Ctx, appid: number, lang: Lang): Promise<StoreInfo | null | undefined> {
  const res = await getJson(ctx, `${STORE}/api/appdetails?appids=${appid}&l=${steamLang(lang)}`)
  if (!res) return undefined
  if (res.status !== 200 || !res.json) return res.status === 429 || res.status >= 500 ? undefined : null
  const entry = res.json[String(appid)]
  if (!entry?.success || !entry.data) return null
  const d = entry.data
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [])
  const categories: number[] = Array.isArray(d.categories) ? d.categories.map((c: any) => Number(c?.id)) : []
  let website: string | null = typeof d.website === 'string' ? d.website.trim() : null
  if (website && /^http:\/\//i.test(website)) website = 'https://' + website.slice(7)
  if (website && !/^https:\/\/[^\s]+$/i.test(website)) website = null
  const description = typeof d.short_description === 'string' ? plainText(d.short_description) : ''
  return {
    description: description || null,
    developers: strings(d.developers),
    publishers: strings(d.publishers),
    releaseDate: typeof d.release_date?.date === 'string' && d.release_date.date.trim() ? d.release_date.date.trim() : null,
    genres: Array.isArray(d.genres) ? d.genres.map((g: any) => String(g?.description ?? '').trim()).filter(Boolean) : [],
    dlcIds: Array.isArray(d.dlc) ? d.dlc.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [],
    workshop: categories.includes(30),
    hasAchievements: categories.includes(22) || Number(d.achievements?.total) > 0,
    website
  }
}

/** Articles de la boutique (IStoreBrowseService/GetItems) : nom et images à adresse codée. */
async function storeItems(ctx: Ctx, appids: number[], lang: Lang, assets: boolean): Promise<any[] | undefined> {
  const input = {
    ids: appids.map((appid) => ({ appid })),
    context: { language: steamLang(lang), country_code: 'US' },
    data_request: assets ? { include_assets: true } : {}
  }
  const res = await getJson(ctx, `${API}/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`)
  if (!res) return undefined
  return Array.isArray(res.json?.response?.store_items) ? res.json.response.store_items : []
}

/** Bandeau et logo : appinfo.vdf de Steam (jeux du compte), sinon la boutique, sinon les anciennes adresses. */
async function readImages(ctx: Ctx, appid: number, lang: Lang): Promise<{ hero: string | null | undefined; logo: string | null | undefined }> {
  let hero: string | null | undefined = null
  let logo: string | null | undefined = null
  const client = cachedSteamClient()
  if (client) {
    try {
      const info = steamAppInfo(client.dir, [appid]).apps.get(appid)
      if (info?.hero) hero = allowedImage(steamCapsuleUrl(appid, info.hero))
      if (info?.logo) logo = allowedImage(steamCapsuleUrl(appid, info.logo))
    } catch {
      // appinfo.vdf illisible : adresses de la boutique
    }
  }
  if (!hero) {
    const items = await storeItems(ctx, [appid], lang, true)
    const assets = items?.[0]?.assets
    const file = assets?.library_hero
    if (assets?.asset_url_format && typeof file === 'string') hero = allowedImage(`${STEAM_ASSETS}/${String(assets.asset_url_format).replace('${FILENAME}', file)}`)
  }
  const classic = async (file: string): Promise<string | null | undefined> => {
    const url = `${STEAM_ASSETS}/steam/apps/${appid}/${file}`
    const ok = await imageExists(ctx, url)
    return ok === undefined ? undefined : ok ? url : null
  }
  const [h, l] = await Promise.all([hero ? hero : classic('library_hero.jpg'), logo ? logo : classic('logo.png')])
  return { hero: h, logo: l }
}

/** Noms des DLC les plus récents (appid le plus grand d'abord), un seul appel à la boutique. */
const dlcNames = new Map<string, string>()
async function readDlc(ctx: Ctx, ids: number[], lang: Lang): Promise<{ appid: number; name: string }[] | undefined> {
  const wanted = [...new Set(ids)].sort((a, b) => b - a).slice(0, MAX_DLC)
  if (!wanted.length) return []
  const missing = wanted.filter((id) => !dlcNames.has(`${lang}:${id}`))
  if (missing.length) {
    const items = await storeItems(ctx, missing, lang, false)
    if (!items) return undefined
    for (const it of items) {
      const id = Number(it?.appid ?? it?.id)
      if (id && it?.success === 1 && typeof it.name === 'string' && it.name.trim()) dlcNames.set(`${lang}:${id}`, it.name.trim())
    }
  }
  return wanted.flatMap((appid) => {
    const name = dlcNames.get(`${lang}:${appid}`)
    return name ? [{ appid, name }] : []
  })
}

async function readNews(ctx: Ctx, appid: number): Promise<GameNewsItem[] | undefined> {
  const res = await getJson(ctx, `${API}/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=15&format=json`)
  if (!res) return undefined
  const items: any[] = Array.isArray(res.json?.appnews?.newsitems) ? res.json.appnews.newsitems : []
  // annonces officielles (feed_type 1) d'abord : les sites de presse relayés sont dans toutes les langues
  const official = items.filter((it) => Number(it?.feed_type) === 1)
  const chosen = (official.length ? official : items).slice(0, 5)
  return chosen.flatMap((it): GameNewsItem[] => {
    const gid = String(it?.gid ?? '')
    const title = typeof it?.title === 'string' ? decodeEntities(it.title).trim() : ''
    if (!gid || !title) return []
    let url: string | null = Number(it.feed_type) === 1 ? `${STORE}/news/app/${appid}/view/${gid}` : null
    if (!url) {
      try {
        const u = new URL(String(it.url ?? ''))
        url = u.protocol === 'https:' ? u.toString() : null
      } catch {
        url = null
      }
    }
    const contents = typeof it.contents === 'string' ? it.contents : ''
    return [
      {
        id: gid,
        title,
        url: url ?? `${STORE}/news/app/${appid}`,
        date: (Number(it.date) || 0) * 1000,
        feed: typeof it.feedlabel === 'string' ? it.feedlabel : '',
        excerpt: excerpt(plainText(contents)),
        image: firstImage(contents)
      }
    ]
  })
}

async function readAchievements(ctx: Ctx, appid: number, key: string, steamId: string, lang: Lang): Promise<GameDetails['achievements'] | undefined> {
  const k = encodeURIComponent(key)
  const l = steamLang(lang)
  const [player, schema] = await Promise.all([
    getJson(ctx, `${API}/ISteamUserStats/GetPlayerAchievements/v1/?appid=${appid}&key=${k}&steamid=${steamId}&l=${l}`),
    getJson(ctx, `${API}/ISteamUserStats/GetSchemaForGame/v2/?appid=${appid}&key=${k}&l=${l}`)
  ])
  if (!player) return undefined
  // 403 : profil ou « détails des jeux » privés ; 400 : jeu sans succès ; autres : pas de succès lisibles
  const list: any[] = player.status === 200 && player.json?.playerstats?.success !== false ? player.json?.playerstats?.achievements ?? [] : []
  if (!Array.isArray(list) || !list.length) return null
  const defs = new Map<string, any>()
  for (const a of schema?.json?.game?.availableGameStats?.achievements ?? []) if (a?.name) defs.set(String(a.name), a)
  const items: GameAchievement[] = list.map((a) => {
    const def = defs.get(String(a.apiname)) ?? {}
    const achieved = Number(a.achieved) === 1
    return {
      id: String(a.apiname),
      name: String(a.name || def.displayName || a.apiname),
      description: String(a.description || def.description || ''),
      icon: allowedImage(achieved ? def.icon : def.icongray ?? def.icon),
      achieved,
      unlockedAt: achieved && Number(a.unlocktime) > 0 ? Number(a.unlocktime) * 1000 : null
    }
  })
  // débloqués (les plus récents d'abord), puis les autres dans l'ordre du jeu
  const unlocked = items.filter((a) => a.achieved).sort((a, b) => (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0))
  const locked = items.filter((a) => !a.achieved)
  return { unlocked: unlocked.length, total: items.length, items: [...unlocked, ...locked] }
}

async function readFriends(ctx: Ctx, appid: number, key: string, steamId: string): Promise<GameDetails['friends'] | undefined> {
  const k = encodeURIComponent(key)
  const limit = AbortSignal.timeout(FRIENDS_TIMEOUT)
  const list = await getJson(ctx, `${API}/ISteamUser/GetFriendList/v1/?key=${k}&steamid=${steamId}&relationship=friend`, { signal: limit })
  if (!list) return undefined
  // 401 / 403 : liste d'amis privée
  if (list.status !== 200) {
    deps.log(`Page du jeu : liste d’amis Steam non lue (HTTP ${list.status})`)
    return null
  }
  const ids: string[] = (list.json?.friendslist?.friends ?? []).map((f: any) => String(f?.steamid ?? '')).filter((id: string) => /^\d{17}$/.test(id))
  if (!ids.length) return { playingNow: [], played: [], total: 0 }
  const people = new Map<string, GameFriend & { gameid: string }>()
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100))
  await Promise.all(
    batches.map(async (batch) => {
      const res = await getJson(ctx, `${API}/ISteamUser/GetPlayerSummaries/v2/?key=${k}&steamids=${batch.join(',')}`, { signal: limit })
      for (const p of res?.json?.response?.players ?? [])
        people.set(String(p.steamid), {
          steamid: String(p.steamid),
          name: String(p.personaname ?? ''),
          avatar: allowedImage(p.avatarmedium ?? p.avatar),
          gameid: String(p.gameid ?? '')
        })
    })
  )
  const friend = (id: string): GameFriend => {
    const p = people.get(id)
    return { steamid: id, name: p?.name || id, avatar: p?.avatar ?? null }
  }
  const playingNow = ids.filter((id) => people.get(id)?.gameid === String(appid)).map(friend)
  const now = new Set(playingNow.map((f) => f.steamid))
  // a déjà joué : liste des jeux du profil filtrée sur ce jeu (profil privé ou délai dépassé : ignoré)
  const played: { id: string; minutes: number }[] = []
  await pool(ids.filter((id) => !now.has(id)).slice(0, MAX_FRIENDS_CHECKED), 6, async (id) => {
    if (limit.aborted) return
    const res = await getJson(
      ctx,
      `${API}/IPlayerService/GetOwnedGames/v1/?key=${k}&steamid=${id}&include_played_free_games=1&appids_filter%5B0%5D=${appid}&format=json`,
      { signal: limit }
    )
    const g = (res?.json?.response?.games ?? []).find((x: any) => Number(x?.appid) === appid)
    if (g && Number(g.playtime_forever) > 0) played.push({ id, minutes: Number(g.playtime_forever) })
  })
  played.sort((a, b) => b.minutes - a.minutes)
  return { playingNow, played: played.map((p) => friend(p.id)), total: ids.length }
}

/** Article Wikipédia du jeu (langue de l'app, puis anglais) : présentation et grande image paysage. */
async function readWikipedia(ctx: Ctx, name: string, lang: Lang): Promise<StaticData['wiki'] | undefined> {
  const wanted = norm(searchName(name))
  if (!wanted) return null
  let answered = false
  for (const wiki of lang === 'fr' ? ['fr', 'en'] : ['en']) {
    const host = `https://${wiki}.wikipedia.org`
    const search = await getJson(ctx, `${host}/w/api.php?action=opensearch&format=json&namespace=0&limit=10&search=${encodeURIComponent(searchName(name))}`)
    if (!search) continue
    answered = true
    const titles: string[] = Array.isArray(search.json?.[1]) ? search.json[1].filter((x: unknown) => typeof x === 'string') : []
    const gameSuffix = /\((video game|jeu vidéo)(, \d{4})?\)$/i
    const base = (title: string): string => norm(title.replace(/\s*\([^)]*\)\s*$/, ''))
    const ranked = [
      ...titles.filter((ti) => gameSuffix.test(ti) && base(ti) === wanted),
      ...titles.filter((ti) => norm(ti) === wanted),
      ...titles.filter((ti) => base(ti) === wanted)
    ]
    for (const title of [...new Set(ranked)].slice(0, 2)) {
      const res = await getJson(ctx, `${host}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`)
      const s = res?.json
      if (!s || res.status !== 200 || s.type !== 'standard' || typeof s.extract !== 'string') continue
      // l'article doit parler d'un jeu (pas d'un film ou d'un roman du même nom)
      if (!/video ?game|jeu(x)? vidéo|game/i.test(s.extract) && !gameSuffix.test(title)) continue
      const img = s.originalimage
      const landscape = img && Number(img.width) > Number(img.height) * 1.3
      return { description: excerpt(s.extract.replace(/\s+/g, ' ').trim(), 700), hero: landscape ? allowedImage(img.source) : null }
    }
  }
  return answered ? null : undefined
}

/** Page du jeu sur gog.com d'après son identifiant (API publique des produits). */
async function readGogCard(ctx: Ctx, id: string): Promise<string | null | undefined> {
  if (!/^\d+$/.test(id)) return null
  const res = await getJson(ctx, `https://api.gog.com/products/${id}`)
  if (!res) return undefined
  const card = res.json?.links?.product_card
  return typeof card === 'string' && /^https:\/\/www\.gog\.com\//.test(card) ? card : null
}

// ---------- Liens ----------

const enc = encodeURIComponent

const RIOT_SITES: Record<string, string> = {
  league_of_legends: 'https://www.leagueoflegends.com/',
  valorant: 'https://playvalorant.com/',
  bacon: 'https://playruneterra.com/'
}

/** Liens de la plateforme du jeu (hors Steam) : boutique, et ouverture dans le lanceur quand c'est sûr. */
function platformLinks(g: Game, storeUrl: string | null, lang: Lang): GameLink[] {
  const name = enc(searchName(g.name))
  const id = g.platformId ?? ''
  const links: GameLink[] = []
  switch (g.platform) {
    case 'epic':
      links.push({ id: 'store', url: `https://store.epicgames.com/${lang === 'fr' ? 'fr' : 'en-US'}/browse?q=${name}&sortBy=relevancy&sortDir=DESC&count=40` })
      break
    case 'gog':
      links.push({ id: 'store', url: storeUrl ?? `https://www.gog.com/${lang === 'fr' ? 'fr' : 'en'}/games?query=${name}` })
      // ouvre la fiche du jeu dans GOG Galaxy (ne lance pas le jeu)
      if (/^\d+$/.test(id) && protocolAvailable('goggalaxy')) links.push({ id: 'launcher', url: `goggalaxy://openGameView/${id}` })
      break
    case 'ea':
      links.push({ id: 'store', url: 'https://www.ea.com/games' })
      break
    case 'ubisoft':
      links.push({ id: 'store', url: `https://store.ubisoft.com/search?q=${name}` })
      break
    case 'battlenet':
      links.push({ id: 'store', url: 'https://shop.battle.net/' })
      break
    case 'rockstar':
      links.push({ id: 'store', url: 'https://store.rockstargames.com/' })
      break
    case 'xbox': {
      links.push({ id: 'store', url: `https://apps.microsoft.com/search?query=${name}` })
      // AUMID « <nom de famille du paquet>!<appli> » : fiche du Microsoft Store
      const pfn = id.split('!')[0]
      if (/^[\w.-]+_[a-z0-9]{13}$/i.test(pfn) && protocolAvailable('ms-windows-store'))
        links.push({ id: 'launcher', url: `ms-windows-store://pdp/?PFN=${enc(pfn)}` })
      break
    }
    case 'itch':
      links.push({ id: 'store', url: `https://itch.io/search?q=${name}` })
      break
    case 'amazon':
      links.push({ id: 'store', url: 'https://gaming.amazon.com/home' })
      break
    case 'riot': {
      const site = RIOT_SITES[id.split('.')[0]]
      links.push({ id: 'website', url: site ?? 'https://www.riotgames.com/' })
      break
    }
  }
  return links
}

function buildLinks(g: Game, appid: number, st: StaticData, achievements: GameDetails['achievements'], lang: Lang): GameLink[] {
  const store = st.store
  const website = store?.website ?? null
  if (g.platform === 'steam' && appid > 0) {
    const links: GameLink[] = [{ id: 'store', url: `${STORE}/app/${appid}` }]
    if (store?.dlcIds.length || st.dlc.length) links.push({ id: 'dlc', url: `${STORE}/dlc/${appid}` })
    links.push(
      { id: 'hub', url: `${COMMUNITY}/app/${appid}` },
      { id: 'points', url: `${STORE}/points/shop/app/${appid}` },
      { id: 'discussions', url: `${COMMUNITY}/app/${appid}/discussions/` },
      { id: 'guides', url: `${COMMUNITY}/app/${appid}/guides/` }
    )
    if (store?.workshop) links.push({ id: 'workshop', url: `${COMMUNITY}/app/${appid}/workshop/` })
    links.push({ id: 'news', url: `${STORE}/news/app/${appid}` })
    if (store?.hasAchievements || achievements) {
      const steamId = steamAccountId()
      links.push({ id: 'achievements', url: steamId ? `${COMMUNITY}/profiles/${steamId}/stats/${appid}/achievements` : `${COMMUNITY}/stats/${appid}/achievements` })
    }
    links.push({ id: 'support', url: `https://help.steampowered.com/wizard/HelpWithGame/?appid=${appid}` })
    if (website) links.push({ id: 'website', url: website })
    // fiche du jeu dans la bibliothèque de Steam (ne lance pas le jeu)
    if (protocolAvailable('steam')) links.push({ id: 'launcher', url: `steam://nav/games/details/${appid}` })
    return links
  }
  const links: GameLink[] =
    g.platform === 'local' ? (appid > 0 ? [{ id: 'store', url: `${STORE}/app/${appid}` }] : []) : platformLinks(g, st.storeUrl, lang)
  if (appid > 0) links.push({ id: 'news', url: `${STORE}/news/app/${appid}` })
  if (website && !links.some((l) => l.id === 'website')) links.push({ id: 'website', url: website })
  return links
}

// ---------- Assemblage et cache ----------

const detailsDir = (): string => path.join(app.getPath('userData'), 'details')
const cacheFile = (id: string): string => path.join(detailsDir(), `${id}.json`)

const EMPTY_STATIC: StaticData = { store: null, hero: null, logo: null, dlc: [], wiki: null, storeUrl: null }
const EMPTY_LIVE: LiveData = { news: [], achievements: null, friends: null }

async function readCache(id: string): Promise<CacheFile | null> {
  try {
    const c = JSON.parse(await fsp.readFile(cacheFile(id), 'utf8')) as CacheFile
    return c?.version === 1 && c.details && c.staticData && c.liveData ? c : null
  } catch {
    return null
  }
}

async function writeCache(id: string, c: CacheFile): Promise<void> {
  try {
    await fsp.mkdir(detailsDir(), { recursive: true })
    const tmp = cacheFile(id) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(c))
    await fsp.rename(tmp, cacheFile(id))
  } catch (err) {
    deps.log(`Page du jeu : cache impossible à enregistrer (${(err as Error).message})`)
  }
}

/** appid Steam d'où viennent les infos : celui du jeu Steam, sinon celui trouvé par nom (jaquette). */
function steamAppFor(g: Game): number {
  if (g.platform === 'steam') {
    const n = Number(g.platformId)
    return Number.isInteger(n) && n > 0 ? n : 0
  }
  return g.steamAppId && g.steamAppId > 0 ? g.steamAppId : 0
}

function compose(g: Game, appid: number, st: StaticData, live: LiveData, lang: Lang, at: number, error: string | null): GameDetails {
  const store = st.store
  const fromSteam = appid > 0 && !!store
  const wiki = !fromSteam ? st.wiki : null
  return {
    gameId: g.id,
    steamAppId: appid,
    heroUrl: (appid > 0 ? st.hero : null) ?? wiki?.hero ?? null,
    logoUrl: appid > 0 ? st.logo : null,
    description: store?.description ?? wiki?.description ?? null,
    developers: store?.developers ?? [],
    publishers: store?.publishers ?? [],
    releaseDate: store?.releaseDate ?? null,
    genres: store?.genres ?? [],
    links: buildLinks(g, appid, st, live.achievements, lang),
    news: live.news,
    achievements: live.achievements,
    friends: live.friends,
    dlc: st.dlc,
    source: fromSteam ? 'steam' : wiki ? 'wikipedia' : appid > 0 && (st.hero || st.logo) ? 'steam' : 'none',
    fetchedAt: at,
    error
  }
}

/** Valeur lue, ou l'ancienne si la lecture a échoué (undefined). */
const keep = <T>(value: T | undefined, old: T): T => (value === undefined ? old : value)

async function load(g: Game, refresh: boolean): Promise<GameDetails> {
  const lang = getLang()
  const appid = steamAppFor(g)
  const creds = g.platform === 'steam' && appid > 0 ? steamApiCredentials() : null
  const cached = await readCache(g.id)
  const now = Date.now()
  const sameContext = !!cached && cached.lang === lang && cached.details.steamAppId === appid
  const staticFresh = sameContext && now - cached!.staticAt < STATIC_MAX_AGE
  const liveFresh = sameContext && now - cached!.liveAt < LIVE_MAX_AGE && cached!.keyed === !!creds
  if (!refresh && staticFresh && liveFresh) {
    // liens recalculés : lanceur installé ou compte Steam lu depuis
    return { ...cached!.details, links: buildLinks(g, appid, cached!.staticData, cached!.liveData.achievements, lang), error: null }
  }
  const fetchStatic = refresh || !staticFresh
  const prevStatic = sameContext ? cached!.staticData : EMPTY_STATIC
  const prevLive = sameContext ? cached!.liveData : EMPTY_LIVE
  const ctx = newCtx()
  const t0 = Date.now()

  const staticPart = async (): Promise<StaticData> => {
    if (!fetchStatic) return prevStatic
    const [store, images, storeUrl] = await Promise.all([
      appid > 0 ? readStore(ctx, appid, lang) : Promise.resolve(null),
      appid > 0 ? readImages(ctx, appid, lang) : Promise.resolve({ hero: null, logo: null }),
      g.platform === 'gog' && g.platformId ? readGogCard(ctx, g.platformId) : Promise.resolve(null)
    ])
    const storeInfo = keep(store, prevStatic.store)
    const [dlc, wiki] = await Promise.all([
      storeInfo?.dlcIds.length ? readDlc(ctx, storeInfo.dlcIds, lang) : Promise.resolve([]),
      // pas de correspondance Steam (ou jeu retiré de la boutique) : Wikipédia
      !storeInfo && store !== undefined ? readWikipedia(ctx, g.name, lang) : Promise.resolve(storeInfo ? null : prevStatic.wiki)
    ])
    return {
      store: storeInfo,
      hero: keep(images.hero, prevStatic.hero),
      logo: keep(images.logo, prevStatic.logo),
      dlc: keep(dlc, prevStatic.dlc),
      wiki: keep(wiki, prevStatic.wiki),
      storeUrl: keep(storeUrl, prevStatic.storeUrl)
    }
  }
  const livePart = async (): Promise<LiveData> => {
    const [news, achievements, friends] = await Promise.all([
      appid > 0 ? readNews(ctx, appid) : Promise.resolve([]),
      creds ? readAchievements(ctx, appid, creds.key, creds.steamId, lang) : Promise.resolve(null),
      creds ? readFriends(ctx, appid, creds.key, creds.steamId) : Promise.resolve(null)
    ])
    return { news: keep(news, prevLive.news), achievements: keep(achievements, prevLive.achievements), friends: keep(friends, prevLive.friends) }
  }
  const [st, live] = await Promise.all([staticPart(), livePart()])

  // rien n'a répondu : hors ligne, on rend le cache (même ancien) avec le message
  if (ctx.ok === 0 && ctx.failed > 0) {
    deps.log(`Page du jeu « ${g.name} » : hors ligne, ${cached ? 'infos enregistrées montrées' : 'aucune info enregistrée'}`)
    if (cached) return { ...cached.details, links: buildLinks(g, appid, cached.staticData, cached.liveData.achievements, lang), error: t('main.details.offline') }
    return compose(g, appid, EMPTY_STATIC, EMPTY_LIVE, lang, 0, t('main.details.offlineNoCache'))
  }
  const staticAt = fetchStatic ? now : cached!.staticAt
  const details = compose(g, appid, st, live, lang, staticAt, null)
  if (ctx.failed) deps.log(`Page du jeu « ${g.name} » : ${ctx.failed} lecture(s) sans réponse (anciennes valeurs gardées)`)
  deps.log(`Page du jeu « ${g.name} » lue en ${((Date.now() - t0) / 1000).toFixed(1)} s (source ${details.source})`)
  await writeCache(g.id, { version: 1, lang, keyed: !!creds, staticAt, liveAt: now, staticData: st, liveData: live, details })
  return details
}

const inflight = new Map<string, Promise<GameDetails>>()

/** Infos de la page d'un jeu (cache de 6 h, actualités / succès / amis 1 h ; refresh : tout est relu). */
export function getGameDetails(id: string, refresh = false): Promise<GameDetails> {
  const g = libraryState().games.find((x) => x.id === id)
  if (!g) {
    const empty: GameDetails = {
      gameId: id, steamAppId: 0, heroUrl: null, logoUrl: null, description: null, developers: [], publishers: [], releaseDate: null,
      genres: [], links: [], news: [], achievements: null, friends: null, dlc: [], source: 'none', fetchedAt: 0, error: t('main.common.gameNotFound')
    }
    return Promise.resolve(empty)
  }
  const key = `${id}:${refresh ? 1 : 0}`
  const running = inflight.get(key)
  if (running) return running
  const p = load(g, refresh)
    .catch((err) => {
      deps.log(`Page du jeu « ${g.name} » : ${(err as Error)?.stack ?? err}`)
      return compose(g, steamAppFor(g), EMPTY_STATIC, EMPTY_LIVE, getLang(), 0, t('main.details.failed'))
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Jeu retiré de la bibliothèque : son cache est supprimé (simple ménage). */
export function forgetGameDetails(id: string): void {
  if (!/^[a-f0-9-]{36}$/.test(id)) return
  fs.rm(cacheFile(id), { force: true }, () => {})
}

// ---------- Ouverture des liens ----------

/** Protocoles des lanceurs émis par buildLinks (ouvrent une fiche, jamais un lancement). */
const LAUNCHER_PREFIXES = ['steam://nav/games/details/', 'goggalaxy://openGameView/', 'ms-windows-store://pdp/']
const STEAM_WEB = /(^|\.)(steampowered\.com|steamcommunity\.com)$/i

/**
 * Ouvre un lien d'une page de jeu : https seulement (pages Steam dans le client Steam s'il est
 * installé), et les fiches des lanceurs ci-dessus. Le reste est ignoré.
 */
export function openExternalLink(raw: string): void {
  let u: URL
  try {
    u = new URL(String(raw))
  } catch {
    return
  }
  const open = (url: string): void => {
    shell.openExternal(url).catch((err) => deps.log(`Lien impossible à ouvrir : ${(err as Error).message}`))
  }
  if (u.protocol === 'https:') {
    if (STEAM_WEB.test(u.hostname) && protocolAvailable('steam')) open(`steam://openurl/${u.toString()}`)
    else open(u.toString())
    return
  }
  const text = String(raw)
  const prefix = LAUNCHER_PREFIXES.find((p) => text.toLowerCase().startsWith(p.toLowerCase()))
  if (!prefix || /[\s"'<>]/.test(text)) return
  if (protocolAvailable(prefix.slice(0, prefix.indexOf(':')))) open(text)
}
