// Magasin Steam dans CyberDeck (passe 2 de la refonte « Steam dans CyberDeck ») : vitrine, offres,
// meilleures ventes, nouveautés, prochainement, recherche et page d'un jeu du magasin.
// Lu sur les adresses PUBLIQUES de la boutique Steam, sans compte, sans clé, sans cookie :
//   - store.steampowered.com/api/featured et /api/featuredcategories (vitrine de l'accueil) ;
//   - store.steampowered.com/search/results/?json=1 (listes de 50 jeux et recherche) ;
//   - store.steampowered.com/api/appdetails (page d'un jeu : images, vidéos, genres, DLC…) ;
//   - api.steampowered.com/IStoreBrowseService/GetItems (prix, réduction, évaluations, étiquettes,
//     images, date de sortie, contenu pour adultes) et IStoreService/GetTagList (noms des étiquettes).
// Le pays (prix et devise) est celui que Steam choisit d'après l'adresse IP : lu une fois par jour
// sur une petite page de la boutique (/about/), jamais l'identité de l'utilisateur.
// Cache en mémoire et sur le disque (userData/store), 15 à 60 min selon les pages ; hors ligne, la
// dernière copie est rendue avec l'erreur.
import { app, net } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getLang, type Lang } from '../shared/i18n'
import type { StoreApp, StoreError, StoreHome, StoreItem, StoreList, StoreListKind, StoreSearch } from '../shared/types'
import { allowedImage } from './gameDetails'

const STORE = 'https://store.steampowered.com'
const API = 'https://api.steampowered.com'
const ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/'
const FETCH_TIMEOUT = 12_000

const HOME_TTL = 30 * 60_000
const LIST_TTL = 30 * 60_000
const APP_TTL = 60 * 60_000
const SEARCH_TTL = 15 * 60_000
const ITEM_TTL = 30 * 60_000
const DAY = 24 * 3600_000

/** Jeux d'une liste (offres, meilleures ventes…) et résultats d'une recherche. */
const LIST_COUNT = 50
const SEARCH_COUNT = 25
/** Jeux de la vitrine (grand carrousel). */
const HERO_MAX = 10
/** DLC montrés sur la page d'un jeu. */
const DLC_MAX = 12
/** GetItems : appids par appel. */
const ITEMS_BATCH = 40

/** Contenus pour adultes cachés, comme la boutique Steam sans compte (sexuel adulte, nudité fréquente). */
const ADULT_DESCRIPTORS = new Set([3, 4])

let log: (message: string) => void = () => {}
export function initSteamStore(d: { log: (message: string) => void }): void {
  log = d.log
}

const steamLang = (lang: Lang): string => (lang === 'fr' ? 'french' : 'english')

// ---------- Réseau ----------

/** null : le réseau n'a pas répondu (hors ligne, délai dépassé). */
async function fetchText(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': 'CyberDeck' },
      // jamais de cookie : la boutique ne doit pas savoir qui regarde
      credentials: 'omit',
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    })
    return { status: res.status, text: await res.text() }
  } catch {
    return null
  }
}

/** JSON d'une adresse ; undefined : pas de réponse ; null : réponse qui n'est pas du JSON valable. */
async function fetchJson(url: string): Promise<any | null | undefined> {
  const res = await fetchText(url)
  if (!res) return undefined
  if (res.status !== 200) return null
  try {
    return JSON.parse(res.text)
  } catch {
    return null
  }
}

// ---------- Texte ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', reg: '®', trade: '™', copy: '©' }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const plain = (s: unknown): string =>
  typeof s === 'string'
    ? decode(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
    : ''

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => plain(typeof x === 'string' ? x : x?.name ?? x?.description)).filter(Boolean) : [])

// ---------- Cache ----------

const storeDir = (): string => path.join(app.getPath('userData'), 'store')
const fileOf = (key: string): string => path.join(storeDir(), key.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120) + '.json')

interface Entry<T> {
  at: number
  value: T
}

const memory = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

async function readDisk<T>(key: string): Promise<Entry<T> | null> {
  try {
    const e = JSON.parse(await fsp.readFile(fileOf(key), 'utf8')) as Entry<T>
    return e && typeof e.at === 'number' && e.value ? e : null
  } catch {
    return null
  }
}

async function writeDisk(key: string, e: Entry<unknown>): Promise<void> {
  try {
    await fsp.mkdir(storeDir(), { recursive: true })
    const file = fileOf(key)
    await fsp.writeFile(file + '.tmp', JSON.stringify(e))
    await fsp.rename(file + '.tmp', file)
  } catch (err) {
    log(`Magasin Steam : cache impossible à enregistrer (${(err as Error).message})`)
  }
}

/**
 * Valeur en cache si elle a moins de `ttl`, sinon relue par `load`. Si la lecture échoue (error
 * rempli) et qu'une ancienne copie existe, l'ancienne copie est rendue avec l'erreur.
 */
async function cached<T extends { error: StoreError | null; fetchedAt: number }>(
  key: string,
  ttl: number,
  refresh: boolean,
  load: () => Promise<T>,
  disk = true
): Promise<T> {
  const now = Date.now()
  let stale = memory.get(key) as Entry<T> | undefined
  if (!stale && disk) {
    const d = await readDisk<T>(key)
    if (d) {
      memory.set(key, d)
      stale = d
    }
  }
  if (!refresh && stale && now - stale.at < ttl) return stale.value
  const running = inflight.get(key) as Promise<T> | undefined
  if (running) return running
  const p = (async (): Promise<T> => {
    let value: T
    try {
      value = await load()
    } catch (err) {
      log(`Magasin Steam : ${key} illisible (${(err as Error).message})`)
      value = null as unknown as T
    }
    if (value && !value.error) {
      const e = { at: Date.now(), value }
      memory.set(key, e)
      if (disk) void writeDisk(key, e)
      return value
    }
    const error: StoreError = value?.error ?? 'unavailable'
    if (stale) return { ...stale.value, error }
    return value ?? (null as unknown as T)
  })()
  inflight.set(key, p)
  try {
    return await p
  } finally {
    inflight.delete(key)
  }
}

// ---------- Pays (prix, devise) ----------

/** Devise → pays de la même zone de prix Steam (secours si la page /about/ n'a pas répondu). */
const CURRENCY_COUNTRY: Record<string, string> = {
  USD: 'US', GBP: 'GB', CHF: 'CH', CAD: 'CA', AUD: 'AU', NZD: 'NZ', JPY: 'JP', KRW: 'KR', BRL: 'BR', RUB: 'RU', PLN: 'PL', NOK: 'NO',
  CNY: 'CN', INR: 'IN', MXN: 'MX', UAH: 'UA', KZT: 'KZ', IDR: 'ID', MYR: 'MY', PHP: 'PH', SGD: 'SG', THB: 'TH', VND: 'VN', ZAR: 'ZA',
  CLP: 'CL', COP: 'CO', PEN: 'PE', CRC: 'CR', UYU: 'UY', ILS: 'IL', SAR: 'SA', AED: 'AE', QAR: 'QA', KWD: 'KW', HKD: 'HK', TWD: 'TW'
}

let countryMem: { cc: string; at: number } | null = null
let countryRun: Promise<string | null> | null = null
/** Devise vue dans la vitrine (choisie par Steam d'après l'adresse IP). */
let seenCurrency: string | null = null

/** Pays choisi par Steam pour cette adresse IP ; null s'il est inconnu (hors ligne). */
async function country(): Promise<string | null> {
  if (countryMem && Date.now() - countryMem.at < DAY) return countryMem.cc
  if (countryRun) return countryRun
  countryRun = (async () => {
    const disk = await readDisk<{ cc: string }>('country')
    if (disk && Date.now() - disk.at < DAY && /^[A-Z]{2}$/.test(disk.value.cc)) {
      countryMem = { cc: disk.value.cc, at: disk.at }
      return disk.value.cc
    }
    const res = await fetchText(`${STORE}/about/`)
    const cc = res?.text.match(/COUNTRY&quot;:&quot;([A-Z]{2})&quot;/)?.[1] ?? res?.text.match(/"COUNTRY":"([A-Z]{2})"/)?.[1] ?? null
    if (cc) {
      countryMem = { cc, at: Date.now() }
      void writeDisk('country', { at: countryMem.at, value: { cc } })
      return cc
    }
    // secours : la devise de la vitrine, sinon la dernière copie
    const byCurrency = seenCurrency ? CURRENCY_COUNTRY[seenCurrency] ?? (seenCurrency === 'EUR' ? (getLang() === 'fr' ? 'FR' : 'DE') : null) : null
    return byCurrency ?? disk?.value.cc ?? null
  })()
  try {
    return await countryRun
  } finally {
    countryRun = null
  }
}

// ---------- Étiquettes (noms) ----------

const tagNames = new Map<Lang, { at: number; names: Map<number, string> }>()

async function tags(lang: Lang): Promise<Map<number, string>> {
  const mem = tagNames.get(lang)
  if (mem && Date.now() - mem.at < DAY) return mem.names
  const key = `tags-${lang}`
  const disk = await readDisk<[number, string][]>(key)
  if (disk && Date.now() - disk.at < DAY) {
    const names = new Map(disk.value)
    tagNames.set(lang, { at: disk.at, names })
    return names
  }
  const json = await fetchJson(`${API}/IStoreService/GetTagList/v1/?language=${steamLang(lang)}`)
  const list: any[] = Array.isArray(json?.response?.tags) ? json.response.tags : []
  if (list.length) {
    const names = new Map<number, string>(list.map((x) => [Number(x.tagid), String(x.name ?? '')] as [number, string]).filter(([id, n]) => id > 0 && !!n))
    tagNames.set(lang, { at: Date.now(), names })
    void writeDisk(key, { at: Date.now(), value: [...names] })
    return names
  }
  return disk ? new Map(disk.value) : mem?.names ?? new Map()
}

// ---------- Articles de la boutique (GetItems) ----------

const TYPE: Record<number, StoreItem['type']> = { 0: 'game', 1: 'demo', 4: 'dlc', 6: 'software', 13: 'software' }

function toItem(raw: any, names: Map<number, string>): StoreItem | null {
  const appid = Number(raw?.appid ?? raw?.id)
  if (!appid || raw?.success !== 1 || typeof raw?.name !== 'string' || !raw.name.trim()) return null
  const a = raw.assets ?? {}
  const fmt = typeof a.asset_url_format === 'string' ? a.asset_url_format : `steam/apps/${appid}/\${FILENAME}`
  const asset = (file: unknown): string | null => (typeof file === 'string' && file ? allowedImage(ASSETS + fmt.replace('${FILENAME}', file)) : null)
  const bpo = raw.best_purchase_option
  const discount = bpo && !bpo.hide_discount_pct_for_compliance ? Number(bpo.discount_pct) || 0 : 0
  const price: StoreItem['price'] = raw.is_free
    ? { free: true, final: null, original: null, discount: 0 }
    : bpo?.formatted_final_price
      ? { free: false, final: String(bpo.formatted_final_price), original: discount > 0 && bpo.formatted_original_price ? String(bpo.formatted_original_price) : null, discount }
      : null
  const rel = raw.release ?? {}
  const sum = raw.reviews?.summary_filtered
  const score = Number(sum?.review_score) || 0
  const screens: any[] = Array.isArray(raw.screenshots?.all_ages_screenshots) ? raw.screenshots.all_ages_screenshots : []
  return {
    appid,
    name: plain(raw.name),
    type: TYPE[Number(raw.type)] ?? 'other',
    header: asset(a.header),
    capsule: asset(a.main_capsule) ?? asset(a.header),
    small: asset(a.small_capsule) ?? asset(a.header),
    hero: asset(a.library_hero),
    price,
    comingSoon: rel.is_coming_soon === true || raw.is_coming_soon === true,
    releaseDate: Number(rel.steam_release_date) > 0 ? Number(rel.steam_release_date) * 1000 : null,
    releaseText: typeof rel.custom_release_date_message === 'string' && rel.custom_release_date_message.trim() ? plain(rel.custom_release_date_message) : null,
    review: score > 0 && typeof sum?.review_score_label === 'string' ? { score, label: sum.review_score_label, percent: Number(sum.percent_positive) || 0 } : null,
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((x: any) => names.get(Number(x?.tagid)))
      .filter((x: string | undefined): x is string => !!x)
      .slice(0, 5),
    description: plain(raw.basic_info?.short_description) || null,
    screenshots: screens
      .slice(0, 4)
      .map((s) => (typeof s?.filename === 'string' ? allowedImage(ASSETS + s.filename.replace(/\.jpg(\?|$)/, '.600x338.jpg$1')) : null))
      .filter((x): x is string => !!x),
    platforms: { windows: raw.platforms?.windows === true, mac: raw.platforms?.mac === true, linux: raw.platforms?.steamos_linux === true },
    adult: (Array.isArray(raw.content_descriptorids) ? raw.content_descriptorids : []).some((d: unknown) => ADULT_DESCRIPTORS.has(Number(d)))
  }
}

const itemMem = new Map<string, { at: number; item: StoreItem | null }>()

/**
 * Articles de la boutique, dans l'ordre demandé (les introuvables sont omis) ; undefined : pas de
 * réponse du réseau. screens : 4 captures par jeu (vitrine).
 */
async function items(ids: number[], lang: Lang, screens = false): Promise<StoreItem[] | undefined> {
  const cc = (await country()) ?? 'US'
  const names = await tags(lang)
  const k = (id: number): string => `${lang}:${cc}:${screens ? 's' : ''}:${id}`
  const wanted = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))]
  const now = Date.now()
  const missing = wanted.filter((id) => {
    const m = itemMem.get(k(id))
    return !m || now - m.at > ITEM_TTL
  })
  let failed = false
  for (let i = 0; i < missing.length; i += ITEMS_BATCH) {
    const chunk = missing.slice(i, i + ITEMS_BATCH)
    const input = {
      ids: chunk.map((appid) => ({ appid })),
      context: { language: steamLang(lang), country_code: cc },
      data_request: {
        include_assets: true,
        include_release: true,
        include_platforms: true,
        include_reviews: true,
        include_basic_info: true,
        include_tag_count: 6,
        include_screenshots: screens
      }
    }
    const json = await fetchJson(`${API}/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`)
    if (json === undefined || json === null) {
      failed = true
      continue
    }
    const got: any[] = Array.isArray(json?.response?.store_items) ? json.response.store_items : []
    const at = Date.now()
    for (const raw of got) {
      const id = Number(raw?.appid ?? raw?.id)
      if (id) itemMem.set(k(id), { at, item: toItem(raw, names) })
    }
    for (const id of chunk) if (!itemMem.has(k(id))) itemMem.set(k(id), { at, item: null })
  }
  if (failed && missing.length === wanted.length) return undefined
  return wanted.flatMap((id) => {
    const it = itemMem.get(k(id))?.item
    return it ? [it] : []
  })
}

/** Articles visibles (sans contenu pour adultes). */
const visible = (list: StoreItem[]): StoreItem[] => list.filter((x) => !x.adult)

/** appids des articles d'une liste de la vitrine (applications seulement, sans doublon). */
function appIds(list: unknown): number[] {
  if (!Array.isArray(list)) return []
  const out: number[] = []
  for (const it of list) {
    const id = Number(it?.id)
    // type 0 : application ; 1 : paquet, 2 : lot (pas de page d'application)
    if (Number(it?.type ?? 0) === 0 && id > 0 && !out.includes(id)) out.push(id)
  }
  return out
}

// ---------- Accueil (vitrine) ----------

export function getStoreHome(refresh = false): Promise<StoreHome> {
  const lang = getLang()
  return cached<StoreHome>(`home-${lang}`, HOME_TTL, refresh, async () => {
    const l = steamLang(lang)
    const [featured, cats] = await Promise.all([fetchJson(`${STORE}/api/featured/?l=${l}`), fetchJson(`${STORE}/api/featuredcategories/?l=${l}`)])
    const empty: StoreHome = { hero: [], shelves: { specials: [], topsellers: [], newreleases: [], comingsoon: [] }, fetchedAt: Date.now(), error: null }
    if (featured === undefined && cats === undefined) return { ...empty, error: 'offline' }
    if (!featured && !cats) return { ...empty, error: 'unavailable' }
    const cur = cats?.specials?.items?.[0]?.currency ?? featured?.featured_win?.[0]?.currency
    if (typeof cur === 'string') seenCurrency = cur
    const ids = {
      hero: [...appIds(featured?.large_capsules), ...appIds(featured?.featured_win), ...appIds(cats?.['6']?.items)],
      specials: appIds(cats?.specials?.items),
      topsellers: appIds(cats?.top_sellers?.items),
      newreleases: appIds(cats?.new_releases?.items),
      comingsoon: appIds(cats?.coming_soon?.items)
    }
    const [heroItems, rest] = await Promise.all([
      items(ids.hero, lang, true),
      items([...ids.specials, ...ids.topsellers, ...ids.newreleases, ...ids.comingsoon], lang)
    ])
    if (!heroItems && !rest) return { ...empty, error: 'offline' }
    const byId = new Map((rest ?? []).map((x) => [x.appid, x]))
    const pick = (list: number[]): StoreItem[] => visible(list.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])))
    // vitrine : jeux avec une grande image ; complétée par les offres si elle est courte
    let hero = visible(heroItems ?? []).filter((x) => x.capsule)
    if (hero.length < 4) hero = [...hero, ...pick(ids.specials).filter((x) => x.capsule && !hero.some((h) => h.appid === x.appid))]
    return {
      hero: hero.slice(0, HERO_MAX),
      shelves: { specials: pick(ids.specials), topsellers: pick(ids.topsellers), newreleases: pick(ids.newreleases), comingsoon: pick(ids.comingsoon) },
      fetchedAt: Date.now(),
      error: null
    }
  })
}

// ---------- Listes (Offres, Meilleures ventes, Nouveautés, Prochainement) et recherche ----------

const LIST_QUERY: Record<StoreListKind, string> = {
  specials: 'specials=1',
  topsellers: 'filter=topsellers',
  newreleases: 'filter=popularnew',
  comingsoon: 'filter=popularcomingsoon'
}

/** Résultats de la recherche de la boutique (JSON) : appid lu dans l'adresse de l'image. */
async function searchResults(query: string, count: number, lang: Lang): Promise<number[] | undefined | null> {
  const json = await fetchJson(`${STORE}/search/results/?json=1&${query}&count=${count}&start=0&l=${steamLang(lang)}`)
  if (json === undefined) return undefined
  if (!json || !Array.isArray(json.items)) return null
  const out: number[] = []
  for (const it of json.items) {
    const m = String(it?.logo ?? '').match(/\/apps\/(\d+)\//)
    const id = m ? Number(m[1]) : 0
    if (id > 0 && !out.includes(id)) out.push(id)
  }
  return out
}

export function getStoreList(kind: StoreListKind, refresh = false): Promise<StoreList> {
  const lang = getLang()
  if (!(kind in LIST_QUERY)) return Promise.resolve({ kind, items: [], fetchedAt: Date.now(), error: 'unavailable' })
  return cached<StoreList>(`list-${kind}-${lang}`, LIST_TTL, refresh, async () => {
    const ids = await searchResults(LIST_QUERY[kind], LIST_COUNT, lang)
    if (ids === undefined) return { kind, items: [], fetchedAt: Date.now(), error: 'offline' }
    if (ids === null) return { kind, items: [], fetchedAt: Date.now(), error: 'unavailable' }
    const list = await items(ids, lang)
    if (!list) return { kind, items: [], fetchedAt: Date.now(), error: 'offline' }
    return { kind, items: visible(list), fetchedAt: Date.now(), error: null }
  })
}

export function searchStore(raw: string): Promise<StoreSearch> {
  const term = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
  const lang = getLang()
  if (!term) return Promise.resolve({ term, items: [], fetchedAt: Date.now(), error: null })
  return cached<StoreSearch>(
    `search-${lang}-${term.toLowerCase()}`,
    SEARCH_TTL,
    false,
    async () => {
      const ids = await searchResults(`term=${encodeURIComponent(term)}`, SEARCH_COUNT, lang)
      if (ids === undefined) return { term, items: [], fetchedAt: Date.now(), error: 'offline' }
      if (ids === null) return { term, items: [], fetchedAt: Date.now(), error: 'unavailable' }
      const list = await items(ids, lang)
      if (!list) return { term, items: [], fetchedAt: Date.now(), error: 'offline' }
      return { term, items: visible(list), fetchedAt: Date.now(), error: null }
    },
    false
  )
}

// ---------- Page d'un jeu ----------

export function getStoreApp(appid: number, refresh = false): Promise<StoreApp> {
  const id = Math.floor(Number(appid))
  const lang = getLang()
  const empty = (error: StoreError): StoreApp => ({
    appid: id,
    name: '',
    item: null,
    description: null,
    screenshots: [],
    movies: [],
    background: null,
    genres: [],
    categories: [],
    developers: [],
    publishers: [],
    releaseDate: null,
    comingSoon: false,
    metacritic: null,
    platforms: { windows: false, mac: false, linux: false },
    price: null,
    requiredAge: 0,
    dlc: [],
    fetchedAt: Date.now(),
    error
  })
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(empty('notFound'))
  return cached<StoreApp>(`app-${id}-${lang}`, APP_TTL, refresh, async () => {
    const cc = await country()
    const details = await fetchJson(`${STORE}/api/appdetails?appids=${id}&l=${steamLang(lang)}${cc ? `&cc=${cc}` : ''}`)
    if (details === undefined) return empty('offline')
    if (details === null) return empty('unavailable')
    const entry = details[String(id)]
    if (!entry?.success || !entry.data) return empty('notFound')
    const d = entry.data
    const dlcIds: number[] = (Array.isArray(d.dlc) ? d.dlc.map(Number) : []).filter((n: number) => Number.isInteger(n) && n > 0)
    const [self, dlcItems] = await Promise.all([items([id], lang), items(dlcIds.slice().sort((a, b) => b - a).slice(0, DLC_MAX), lang)])
    const item = self?.[0] ?? null
    const po = d.price_overview
    const discount = Number(po?.discount_percent) || 0
    const price: StoreApp['price'] = d.is_free
      ? { free: true, final: null, original: null, discount: 0 }
      : po?.final_formatted
        ? { free: false, final: String(po.final_formatted), original: discount > 0 && po.initial_formatted ? String(po.initial_formatted) : null, discount }
        : item?.price ?? null
    const shots: any[] = Array.isArray(d.screenshots) ? d.screenshots : []
    const movies: any[] = Array.isArray(d.movies) ? d.movies : []
    const meta = Number(d.metacritic?.score) || 0
    let metaUrl: string | null = typeof d.metacritic?.url === 'string' ? d.metacritic.url : null
    if (metaUrl && !/^https:\/\/(www\.)?metacritic\.com\//i.test(metaUrl)) metaUrl = null
    return {
      appid: id,
      name: plain(d.name) || item?.name || '',
      item,
      description: plain(d.short_description) || item?.description || null,
      screenshots: shots
        .map((s) => ({ thumb: allowedImage(s?.path_thumbnail), full: allowedImage(s?.path_full) }))
        .filter((s): s is { thumb: string; full: string } => !!s.thumb && !!s.full),
      movies: movies
        .map((m) => ({ thumb: allowedImage(m?.thumbnail), name: plain(m?.name) }))
        .filter((m): m is { thumb: string; name: string } => !!m.thumb),
      background: allowedImage(d.background_raw) ?? allowedImage(d.background) ?? item?.hero ?? null,
      genres: strings(d.genres),
      categories: strings(d.categories).slice(0, 10),
      developers: strings(d.developers),
      publishers: strings(d.publishers),
      releaseDate: plain(d.release_date?.date) || null,
      comingSoon: d.release_date?.coming_soon === true,
      metacritic: meta > 0 ? { score: meta, url: metaUrl } : null,
      platforms: { windows: d.platforms?.windows === true, mac: d.platforms?.mac === true, linux: d.platforms?.linux === true },
      price,
      requiredAge: Number(d.required_age) || 0,
      dlc: visible(dlcItems ?? []),
      fetchedAt: Date.now(),
      error: null
    }
  })
}
