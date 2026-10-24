// Communauté Steam dans CyberDeck (passe 4 de la refonte « Steam dans CyberDeck ») : fil des
// actualités des jeux de l'utilisateur, article lisible dans l'app, et Workshop des jeux installés.
//   - actualités : api.steampowered.com/ISteamNews/GetNewsForApp (public, sans clé) pour les jeux
//     Steam les plus joués et les plus récents de la bibliothèque ; annonces officielles d'abord ;
//   - jeux qui ont un Workshop : IStoreBrowseService/GetItems (public), catégorie 30 ;
//   - Workshop : IPublishedFileService/QueryFiles et GetDetails, ISteamUser/GetPlayerSummaries
//     (noms des auteurs), avec la clé Web API de l'utilisateur (rien d'autre n'est envoyé ; la clé
//     n'apparaît jamais dans le journal). S'abonner se fait dans Steam.
// Le BBCode / HTML des articles et des descriptions est converti ici en blocs simples (paragraphes,
// titres, listes, images d'hôtes autorisés, liens https) : l'interface n'affiche jamais de HTML.
// Cache en mémoire et sur le disque (userData/community), 30 min ; hors ligne, la dernière copie
// est rendue avec l'erreur.
import { app, net } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { gameLastPlayedAt, gamePlayTimeSeconds } from '../shared/platforms'
import type {
  CommunityArticle,
  CommunityError,
  CommunityGame,
  CommunityNews,
  CommunityNewsItem,
  Game,
  RichBlock,
  RichSpan,
  WorkshopDetail,
  WorkshopGames,
  WorkshopItem,
  WorkshopPage,
  WorkshopSort
} from '../shared/types'
import { allowedImage, decodeEntities, excerpt, firstImage, plainText } from './gameDetails'
import { libraryState } from './games'
import { steamApiCredentials } from './platformSync'

const API = 'https://api.steampowered.com'
const STORE = 'https://store.steampowered.com'
const FETCH_TIMEOUT = 12_000

const NEWS_TTL = 30 * 60_000
const WORKSHOP_TTL = 30 * 60_000
const WS_GAMES_TTL = 12 * 3600_000

/** Jeux du fil : les plus récents et les plus joués (sans doublon). */
const NEWS_RECENT = 8
const NEWS_PLAYED = 8
const NEWS_GAMES_MAX = 12
/** Actualités lues par jeu, et gardées au total. */
const NEWS_PER_GAME = 8
const NEWS_MAX = 90
/** Objets du Workshop par page. */
const WS_PER_PAGE = 24
/** Contenus pour adultes exclus (sexuel adulte, nudité fréquente), comme le magasin. */
const ADULT_DESCRIPTORS = [3, 4]

let log: (message: string) => void = () => {}
export function initSteamCommunity(d: { log: (message: string) => void }): void {
  log = d.log
}

// ---------- Réseau ----------

/** Réponse JSON ; null : le réseau n'a pas répondu. json : null si illisible. */
async function getJson(url: string): Promise<{ status: number; json: any } | null> {
  let res: Response
  try {
    res = await net.fetch(url, { headers: { 'User-Agent': 'CyberDeck' }, credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  } catch {
    return null
  }
  let json: any = null
  try {
    json = await res.json()
  } catch {
    // page d'erreur HTML, réponse vide
  }
  return { status: res.status, json }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

function apiError(res: { status: number } | null): CommunityError {
  if (!res) return 'offline'
  if (res.status === 401 || res.status === 403) return 'invalid-key'
  return 'unavailable'
}

// ---------- Cache sur le disque ----------

const dir = (): string => path.join(app.getPath('userData'), 'community')

interface Disk<T> {
  key: string
  at: number
  value: T
}

async function readDisk<T>(name: string): Promise<Disk<T> | null> {
  try {
    const d = JSON.parse(await fsp.readFile(path.join(dir(), name), 'utf8')) as Disk<T>
    return d && typeof d.at === 'number' && typeof d.key === 'string' && d.value ? d : null
  } catch {
    return null
  }
}

async function writeDisk(name: string, d: Disk<unknown>): Promise<void> {
  try {
    await fsp.mkdir(dir(), { recursive: true })
    const file = path.join(dir(), name)
    await fsp.writeFile(file + '.tmp', JSON.stringify(d))
    await fsp.rename(file + '.tmp', file)
  } catch (err) {
    log(`Communauté Steam : cache impossible à enregistrer (${(err as Error).message})`)
  }
}

// ---------- Texte riche (BBCode et HTML de Steam → blocs) ----------

const BB_TAGS = new Set([
  'b', 'i', 'u', 's', 'strike', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'url', 'img', 'list', 'olist', '*', 'quote', 'code', 'noparse', 'hr',
  'spoiler', 'table', 'tr', 'td', 'th', 'previewyoutube', 'video', 'dynamiclink', 'carousel', 'expand', 'center', 'color', 'size', 'emoticon'
])
const HTML_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'a', 'img', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'blockquote', 'div', 'span', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'iframe', 'figure', 'figcaption', 'sup', 'sub', 'code', 'pre',
  'center', 'font', 'small', 'section', 'article', 'header', 'footer', 'picture', 'source', 'video'
])
const MAX_BLOCKS = 500

/** Lien gardé : https seulement (http passe en https). */
function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(decodeEntities(raw.trim().replace(/^["']|["']$/g, '')))
    if (u.protocol === 'http:') u.protocol = 'https:'
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

const imageUrl = (raw: string | null | undefined): string | null =>
  raw ? allowedImage(decodeEntities(raw.trim().replace(/^["']|["']$/g, '')).replace(/\{STEAM_CLAN(?:_LOC)?_IMAGE\}/, 'https://clan.akamai.steamstatic.com/images')) : null

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([a-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>\]]+))/gi)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

/** BBCode ou HTML d'une actualité / description Steam → blocs lisibles. */
export function richText(src: string): RichBlock[] {
  const blocks: RichBlock[] = []
  let spans: RichSpan[] = []
  const st = { b: 0, i: 0, u: 0, s: 0 }
  const links: (string | null | 'self')[] = []
  let heading: { level: 1 | 2 | 3; text: string } | null = null
  let quote = 0
  const lists: { ordered: boolean; items: RichSpan[][]; cur: RichSpan[] }[] = []
  /** contenu brut collecté ([img]adresse[/img]) */
  let raw: { tag: string; text: string; href: string | null } | null = null
  let cells = 0

  const push = (b: RichBlock): void => {
    if (blocks.length < MAX_BLOCKS) blocks.push(b)
  }
  const target = (): RichSpan[] => (lists.length ? lists[lists.length - 1].cur : spans)
  const trimSpans = (list: RichSpan[]): RichSpan[] => {
    const out = list.map((x) => ({ ...x, text: x.text.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n') }))
    while (out.length && !out[0].text.trim()) out.shift()
    while (out.length && !out[out.length - 1].text.trim()) out.pop()
    if (!out.length) return out
    out[0].text = out[0].text.replace(/^\s+/, '')
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '')
    return out
  }
  const flush = (): void => {
    if (lists.length) return
    const list = trimSpans(spans)
    spans = []
    if (!list.length) return
    push(quote > 0 ? { t: 'quote', spans: list } : { t: 'p', spans: list })
  }
  const endItem = (): void => {
    const l = lists[lists.length - 1]
    if (!l) return
    const item = trimSpans(l.cur)
    if (item.length) l.items.push(item)
    l.cur = []
  }
  const addText = (text: string): void => {
    if (!text) return
    if (raw) {
      raw.text += text
      return
    }
    if (heading) {
      heading.text += text
      return
    }
    const parts = text.split(/\n[ \t]*\n+/)
    parts.forEach((part, n) => {
      if (n > 0) {
        if (lists.length) target().push({ text: '\n' })
        else flush()
      }
      const clean = part.replace(/[ \t\r\f\v ]+/g, ' ')
      if (!clean) return
      let href: string | undefined
      for (let k = links.length - 1; k >= 0; k--) {
        const l = links[k]
        if (l === 'self') {
          href = safeHref(clean.trim()) ?? undefined
          break
        }
        if (l) {
          href = l
          break
        }
      }
      const span: RichSpan = { text: clean }
      if (st.b) span.b = true
      if (st.i) span.i = true
      if (st.u) span.u = true
      if (st.s) span.s = true
      if (href) span.href = href
      const into = target()
      const last = into[into.length - 1]
      if (last && !!last.b === !!span.b && !!last.i === !!span.i && !!last.u === !!span.u && !!last.s === !!span.s && last.href === span.href) last.text += clean
      else into.push(span)
    })
  }
  const image = (url: string | null, href: string | null): void => {
    if (!url || lists.length || heading) return
    flush()
    push(href ? { t: 'img', src: url, href } : { t: 'img', src: url })
  }
  const currentLink = (): string | null => {
    for (let k = links.length - 1; k >= 0; k--) {
      const l = links[k]
      if (l && l !== 'self') return l
    }
    return null
  }

  const tag = (close: boolean, name: string, arg: string, html: boolean): void => {
    if (raw) {
      if (close && name === raw.tag) {
        const r = raw
        raw = null
        image(imageUrl(r.text), r.href)
      }
      return
    }
    const a = attrs(arg)
    const value = arg.startsWith('=') ? arg.slice(1).split(/\s/)[0].replace(/^["']|["']$/g, '') : ''
    switch (name) {
      case 'b':
      case 'strong':
        st.b += close ? (st.b ? -1 : 0) : 1
        return
      case 'i':
      case 'em':
        st.i += close ? (st.i ? -1 : 0) : 1
        return
      case 'u':
        st.u += close ? (st.u ? -1 : 0) : 1
        return
      case 's':
      case 'strike':
      case 'del':
        st.s += close ? (st.s ? -1 : 0) : 1
        return
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        if (lists.length) return
        if (!close) {
          flush()
          heading = { level: Math.min(3, Number(name[1])) as 1 | 2 | 3, text: '' }
        } else if (heading) {
          const text = heading.text.replace(/\s+/g, ' ').trim()
          heading = null
          if (text) push({ t: 'h', level: (Number(name[1]) <= 1 ? 1 : Number(name[1]) === 2 ? 2 : 3) as 1 | 2 | 3, text })
        }
        return
      }
      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'header':
      case 'footer':
      case 'center':
      case 'figure':
      case 'pre':
      case 'expand':
        if (lists.length) target().push({ text: '\n' })
        else flush()
        return
      case 'br':
        addText('\n')
        return
      case 'hr':
        if (lists.length || close) return
        flush()
        push({ t: 'hr' })
        return
      case 'url':
      case 'a':
        if (close) links.pop()
        else if (html) links.push(safeHref(a.href))
        else links.push(value ? safeHref(value) : a.href ? safeHref(a.href) : 'self')
        return
      case 'img': {
        if (close) return
        const src = a.src ?? (value || null)
        if (html || src) image(imageUrl(src), currentLink())
        // [img src=…][/img] : rien à collecter ; [img]adresse[/img] : l'adresse est le contenu
        if (!html && !src) raw = { tag: 'img', text: '', href: currentLink() }
        return
      }
      case 'noparse':
        return
      case 'list':
      case 'olist':
      case 'ul':
      case 'ol':
        if (!close) {
          if (lists.length) endItem()
          else flush()
          lists.push({ ordered: name === 'olist' || name === 'ol', items: [], cur: [] })
        } else if (lists.length) {
          endItem()
          const l = lists.pop()!
          if (lists.length) lists[lists.length - 1].items.push(...l.items)
          else if (l.items.length) push({ t: 'list', ordered: l.ordered, items: l.items })
        }
        return
      case '*':
      case 'li':
        if (!lists.length) {
          // puce hors liste : nouvelle ligne
          if (!close) addText('\n• ')
          return
        }
        if (!close) endItem()
        return
      case 'quote':
      case 'blockquote':
      case 'code':
        if (lists.length) return
        flush()
        quote += close ? (quote ? -1 : 0) : 1
        return
      case 'table':
      case 'tbody':
      case 'thead':
      case 'tr':
        if (lists.length) return
        flush()
        cells = 0
        return
      case 'td':
      case 'th':
        if (!close && cells++ > 0) addText(' · ')
        return
      case 'previewyoutube': {
        if (close || lists.length) return
        const id = (value || '').split(';')[0]
        if (/^[\w-]{6,20}$/.test(id)) {
          flush()
          push({ t: 'video', href: `https://www.youtube.com/watch?v=${id}` })
        }
        return
      }
      case 'iframe': {
        if (close || lists.length) return
        const m = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,20})/.exec(a.src ?? '')
        if (m) {
          flush()
          push({ t: 'video', href: `https://www.youtube.com/watch?v=${m[1]}` })
        }
        return
      }
      case 'video':
        if (close || lists.length) return
        // vidéo d'un événement Steam : son image d'attente, si elle vient d'un hôte autorisé
        image(imageUrl(a.poster), null)
        return
      case 'dynamiclink': {
        if (close || lists.length) return
        const href = safeHref(a.href)
        if (href) {
          flush()
          push({ t: 'p', spans: [{ text: href.replace(/^https:\/\//, '').replace(/\/$/, ''), href }] })
        }
        return
      }
      default:
        // spoiler, color, size, span, font, sup… : le texte seul
        return
    }
  }

  // [tag], [/tag], [tag=…], [tag a="…"] (pas les crochets échappés \[ … ]), et <tag …>
  const re = /(\\?)\[(\/?)([a-z0-9*]+)((?:=[^\]\n]*)?(?:\s[^\]\n]*)?)\]|<(\/?)([a-z][a-z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?>|<!--[\s\S]*?-->/gi
  let at = 0
  for (const m of src.matchAll(re)) {
    const start = m.index ?? 0
    if (m[0].startsWith('<!--')) {
      addText(decodeEntities(src.slice(at, start)))
      at = start + m[0].length
      continue
    }
    if (m[3] !== undefined) {
      const name = m[3].toLowerCase()
      if (m[1] || !BB_TAGS.has(name)) continue
      addText(decodeEntities(src.slice(at, start).replace(/\\([[\]])/g, '$1')))
      tag(m[2] === '/', name, m[4] ?? '', false)
    } else {
      const name = (m[6] ?? '').toLowerCase()
      if (!HTML_TAGS.has(name)) continue
      addText(decodeEntities(src.slice(at, start).replace(/\\([[\]])/g, '$1')))
      tag(m[5] === '/', name, m[7] ?? '', true)
    }
    at = start + m[0].length
    if (blocks.length >= MAX_BLOCKS) break
  }
  if (blocks.length < MAX_BLOCKS) addText(decodeEntities(src.slice(at).replace(/\\([[\]])/g, '$1')))
  while (lists.length) tag(true, 'list', '', false)
  quote = 0
  flush()
  return blocks
}

// ---------- Magasin : en-têtes des jeux et Workshop (IStoreBrowseService/GetItems, public) ----------

const ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets'
const storeInfo = new Map<number, { at: number; header: string | null; workshop: boolean }>()
const STORE_INFO_TTL = 24 * 3600_000

/** En-tête (adresse à jour, les nouveaux jeux n'ont plus de header.jpg fixe) et Workshop des jeux ;
 *  false : le magasin n'a pas répondu. */
async function readStoreInfo(appids: number[]): Promise<boolean> {
  const missing = appids.filter((id) => {
    const s = storeInfo.get(id)
    return !s || Date.now() - s.at > STORE_INFO_TTL
  })
  let answered = missing.length === 0
  for (let i = 0; i < missing.length; i += 40) {
    const input = {
      ids: missing.slice(i, i + 40).map((appid) => ({ appid })),
      context: { language: 'english', country_code: 'US' },
      data_request: { include_basic_info: true, include_assets: true }
    }
    const res = await getJson(`${API}/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`)
    if (res?.status !== 200) continue
    answered = true
    for (const it of Array.isArray(res.json?.response?.store_items) ? res.json.response.store_items : []) {
      const appid = Number(it?.appid ?? it?.id)
      if (!appid) continue
      const a = it.assets
      const header = a?.asset_url_format && typeof a.header === 'string' ? allowedImage(`${ASSETS}/${String(a.asset_url_format).replace('${FILENAME}', a.header)}`) : null
      const cats: unknown = it?.categories?.feature_categoryids
      storeInfo.set(appid, { at: Date.now(), header, workshop: Array.isArray(cats) && cats.map(Number).includes(30) })
    }
  }
  return answered
}

const withHeader = (g: { appid: number; name: string }): CommunityGame => ({ ...g, header: storeInfo.get(g.appid)?.header ?? null })

// ---------- Actualités ----------

const appidOf = (g: Game): number => {
  const n = Number(g.platformId)
  return g.platform === 'steam' && Number.isInteger(n) && n > 0 ? n : 0
}

/** Jeux du fil : les plus récents, puis les plus joués ; à défaut, les jeux installés. */
function newsGames(): CommunityGame[] {
  const steam = libraryState().games.filter((g) => appidOf(g) > 0 && (g.installed || g.owned === true))
  const recent = steam.filter((g) => gameLastPlayedAt(g)).sort((a, b) => (gameLastPlayedAt(b) ?? 0) - (gameLastPlayedAt(a) ?? 0))
  const played = steam.filter((g) => gamePlayTimeSeconds(g) > 0).sort((a, b) => gamePlayTimeSeconds(b) - gamePlayTimeSeconds(a))
  const picked = new Map<number, Game>()
  for (const g of recent.slice(0, NEWS_RECENT)) picked.set(appidOf(g), g)
  for (const g of played.slice(0, NEWS_PLAYED)) if (picked.size < NEWS_GAMES_MAX) picked.set(appidOf(g), g)
  if (!picked.size) for (const g of steam.filter((x) => x.installed).sort((a, b) => a.name.localeCompare(b.name)).slice(0, NEWS_GAMES_MAX)) picked.set(appidOf(g), g)
  // ordre des puces : partie la plus récente d'abord
  return [...picked.values()]
    .sort((a, b) => (gameLastPlayedAt(b) ?? 0) - (gameLastPlayedAt(a) ?? 0) || gamePlayTimeSeconds(b) - gamePlayTimeSeconds(a))
    .map((g) => ({ appid: appidOf(g), name: g.name, header: null }))
}

interface NewsStore {
  news: CommunityNews
  /** contenu brut des articles, par `${appid}:${gid}` */
  bodies: Record<string, string>
}

function newsUrl(appid: number, it: any): string {
  const gid = String(it?.gid ?? '')
  if (Number(it?.feed_type) === 1) return `${STORE}/news/app/${appid}/view/${gid}`
  return safeHref(String(it?.url ?? '')) ?? `${STORE}/news/app/${appid}`
}

async function readGameNews(g: CommunityGame): Promise<{ items: CommunityNewsItem[]; bodies: Record<string, string> } | null> {
  const res = await getJson(`${API}/ISteamNews/GetNewsForApp/v2/?appid=${g.appid}&count=${NEWS_PER_GAME * 2}&format=json`)
  if (!res || res.status !== 200 || !res.json?.appnews) return null
  const all: any[] = Array.isArray(res.json.appnews.newsitems) ? res.json.appnews.newsitems : []
  // annonces officielles d'abord ; les articles de presse relayés (toutes langues) seulement à défaut
  const official = all.filter((it) => Number(it?.feed_type) === 1)
  const chosen = (official.length ? official : all.slice(0, 3)).slice(0, NEWS_PER_GAME)
  const bodies: Record<string, string> = {}
  const items = chosen.flatMap((it): CommunityNewsItem[] => {
    const gid = String(it?.gid ?? '')
    const title = typeof it?.title === 'string' ? decodeEntities(it.title).trim() : ''
    if (!/^\d+$/.test(gid) || !title) return []
    const contents = typeof it.contents === 'string' ? it.contents : ''
    const tags: string[] = Array.isArray(it.tags) ? it.tags.map(String) : []
    const isOfficial = Number(it.feed_type) === 1
    const kind: CommunityNewsItem['kind'] = !isOfficial ? 'press' : tags.includes('patchnotes') || /patch|hotfix|update notes/i.test(title) ? 'patch' : 'announcement'
    bodies[`${g.appid}:${gid}`] = contents
    return [
      {
        id: gid,
        appid: g.appid,
        game: g.name,
        title,
        url: newsUrl(g.appid, it),
        date: (Number(it.date) || 0) * 1000,
        kind,
        feed: typeof it.feedlabel === 'string' ? decodeEntities(it.feedlabel).trim() : '',
        author: typeof it.author === 'string' && it.author.trim() ? decodeEntities(it.author).trim() : null,
        excerpt: excerpt(plainText(contents), 260),
        image: firstImage(contents)
      }
    ]
  })
  return { items, bodies }
}

let newsMem: Disk<NewsStore> | null = null
let newsDiskRead = false
let newsRunning: Promise<CommunityNews> | null = null

async function ensureNewsDisk(): Promise<void> {
  if (newsDiskRead) return
  newsDiskRead = true
  const d = await readDisk<NewsStore>('news.json')
  if (d && !newsMem) newsMem = d
}

async function loadNews(games: CommunityGame[], key: string): Promise<CommunityNews> {
  const t0 = Date.now()
  const items: CommunityNewsItem[] = []
  const bodies: Record<string, string> = {}
  let ok = 0
  let failed = 0
  const art = readStoreInfo(games.map((g) => g.appid))
  await pool(games, 4, async (g) => {
    const r = await readGameNews(g)
    if (!r) {
      failed++
      return
    }
    ok++
    items.push(...r.items)
    Object.assign(bodies, r.bodies)
  })
  if (games.length && !ok) {
    log(`Communauté Steam : actualités non lues (${failed} jeu(x) sans réponse)`)
    const old = newsMem?.value.news
    const error: CommunityError = 'offline'
    return old ? { ...old, error } : { games, items: [], error, fetchedAt: Date.now() }
  }
  await art
  items.sort((a, b) => b.date - a.date)
  const kept = items.slice(0, NEWS_MAX)
  const keptBodies: Record<string, string> = {}
  for (const it of kept) keptBodies[`${it.appid}:${it.id}`] = bodies[`${it.appid}:${it.id}`] ?? ''
  // seuls les jeux qui ont des actualités ont une puce
  const withNews = new Set(kept.map((it) => it.appid))
  const news: CommunityNews = { games: games.filter((g) => withNews.has(g.appid)).map(withHeader), items: kept, error: null, fetchedAt: Date.now() }
  newsMem = { key, at: Date.now(), value: { news, bodies: keptBodies } }
  void writeDisk('news.json', newsMem)
  log(`Communauté Steam : ${kept.length} actualité(s) de ${games.length} jeu(x) lues en ${((Date.now() - t0) / 1000).toFixed(1)} s${failed ? ` (${failed} sans réponse)` : ''}`)
  return news
}

/** Fil des actualités des jeux de l'utilisateur (cache 30 min ; refresh : relu maintenant). */
export async function getCommunityNews(refresh = false): Promise<CommunityNews> {
  await ensureNewsDisk()
  const games = newsGames()
  const key = games.map((g) => g.appid).sort((a, b) => a - b).join(',')
  if (!refresh && newsMem && newsMem.key === key && Date.now() - newsMem.at < NEWS_TTL) return newsMem.value.news
  if (newsRunning) return newsRunning
  newsRunning = (async () => {
    try {
      return await loadNews(games, key)
    } catch (err) {
      log(`Communauté Steam : actualités impossibles à lire (${(err as Error).message})`)
      return { games, items: [], error: 'unavailable' as const, fetchedAt: Date.now() }
    } finally {
      newsRunning = null
    }
  })()
  return newsRunning
}

/** Article complet d'une actualité du fil (lu dans le cache du fil, sinon relu sur Steam). */
export async function getCommunityArticle(appid: number, id: string): Promise<CommunityArticle | null> {
  if (!Number.isInteger(appid) || appid <= 0 || !/^\d{1,24}$/.test(String(id))) return null
  await ensureNewsDisk()
  const find = (): CommunityArticle | null => {
    const store = newsMem?.value
    const item = store?.news.items.find((x) => x.appid === appid && x.id === id)
    const raw = store?.bodies[`${appid}:${id}`]
    return item && raw !== undefined ? { item, body: richText(raw) } : null
  }
  const found = find()
  if (found) return found
  // pas dans le fil enregistré (fil relu entre-temps) : relecture des actualités de ce jeu
  const name = libraryState().games.find((g) => appidOf(g) === appid)?.name ?? String(appid)
  const r = await readGameNews({ appid, name, header: null })
  const item = r?.items.find((x) => x.id === id)
  return item ? { item, body: richText(r!.bodies[`${appid}:${id}`] ?? '') } : null
}

// ---------- Workshop : jeux ----------

let wsGamesMem: { key: string; at: number; games: CommunityGame[] } | null = null

/** Jeux Steam installés qui ont un Workshop (catégorie 30 du magasin). */
export async function getWorkshopGames(refresh = false): Promise<WorkshopGames> {
  const installed = libraryState()
    .games.filter((g) => appidOf(g) > 0 && g.installed)
    .sort((a, b) => (gameLastPlayedAt(b) ?? 0) - (gameLastPlayedAt(a) ?? 0) || a.name.localeCompare(b.name))
  const names = new Map(installed.map((g) => [appidOf(g), g.name]))
  const appids = [...names.keys()]
  const error: CommunityError | null = steamApiCredentials() ? null : 'no-key'
  const key = [...appids].sort((a, b) => a - b).join(',')
  if (!wsGamesMem) {
    const d = await readDisk<CommunityGame[]>('workshop-games.json')
    if (d && Array.isArray(d.value)) wsGamesMem = { key: d.key, at: d.at, games: d.value }
  }
  if (!refresh && wsGamesMem && wsGamesMem.key === key && Date.now() - wsGamesMem.at < WS_GAMES_TTL) return { games: wsGamesMem.games, error }
  if (!appids.length) return { games: [], error }
  if (refresh) for (const id of appids) storeInfo.delete(id)
  if (!(await readStoreInfo(appids))) {
    // hors ligne : la dernière liste connue
    return { games: wsGamesMem?.games ?? [], error: error ?? 'offline' }
  }
  const games = appids.filter((id) => storeInfo.get(id)?.workshop).map((appid) => withHeader({ appid, name: names.get(appid)! }))
  wsGamesMem = { key, at: Date.now(), games }
  void writeDisk('workshop-games.json', { key, at: wsGamesMem.at, value: games })
  return { games, error }
}

// ---------- Workshop : objets ----------

const QUERY_TYPE: Record<WorkshopSort, number> = { trend: 3, popular: 9, recent: 1 }

/** Image réduite par le serveur d'images de Steam (grille). */
function thumbOf(url: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (!/(^|\.)steamusercontent\.com$|^steamuserimages-a\.akamaihd\.net$/i.test(u.hostname) || u.search) return url
    return `${url}?imw=480&imh=270&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=true`
  } catch {
    return url
  }
}

const authorNames = new Map<string, string>()

async function readAuthors(key: string, ids: string[]): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => /^\d{17}$/.test(id) && !authorNames.has(id)).slice(0, 100)
  if (!missing.length) return
  const res = await getJson(`${API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${missing.join(',')}`)
  for (const p of res?.json?.response?.players ?? []) if (p?.steamid && typeof p.personaname === 'string') authorNames.set(String(p.steamid), p.personaname)
}

const num = (v: unknown): number | null => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

function adult(d: any): boolean {
  const ids: number[] = Array.isArray(d?.content_descriptorids) ? d.content_descriptorids.map(Number) : []
  return d?.maybe_inappropriate_sex === true || ids.some((x) => ADULT_DESCRIPTORS.includes(x))
}

function toItem(d: any, appid: number): WorkshopItem | null {
  const id = String(d?.publishedfileid ?? '')
  if (!/^\d+$/.test(id) || Number(d?.result ?? 1) !== 1 || d?.banned === true || adult(d)) return null
  const title = typeof d.title === 'string' ? decodeEntities(d.title).trim() : ''
  if (!title) return null
  const preview = allowedImage(d.preview_url)
  const vote = d.vote_data
  const votes = (Number(vote?.votes_up) || 0) + (Number(vote?.votes_down) || 0)
  const desc = typeof d.short_description === 'string' ? d.short_description : typeof d.file_description === 'string' ? d.file_description : ''
  const tags: string[] = Array.isArray(d.tags) ? d.tags.map((x: any) => String(x?.display_name || x?.tag || '').trim()).filter(Boolean) : []
  return {
    id,
    appid: Number(d.consumer_appid) || appid,
    title,
    preview,
    thumb: thumbOf(preview),
    author: authorNames.get(String(d.creator ?? '')) ?? null,
    subscriptions: num(d.subscriptions),
    favorites: num(d.favorited),
    score: votes >= 3 && num(vote?.score) !== null ? Math.max(0, Math.min(1, Number(vote.score))) : null,
    votes,
    short: excerpt(plainText(desc), 220),
    tags: [...new Set(tags)].slice(0, 12),
    createdAt: num(d.time_created) ? Number(d.time_created) * 1000 : null,
    updatedAt: num(d.time_updated) ? Number(d.time_updated) * 1000 : null,
    size: num(d.file_size)
  }
}

const pageMem = new Map<string, { at: number; page: WorkshopPage }>()
const pageRunning = new Map<string, Promise<WorkshopPage>>()

async function loadPage(appid: number, sort: WorkshopSort, cursor: string, key: string): Promise<WorkshopPage> {
  const params = new URLSearchParams({
    key,
    query_type: String(QUERY_TYPE[sort]),
    appid: String(appid),
    numperpage: String(WS_PER_PAGE),
    cursor,
    return_previews: 'true',
    return_short_description: 'true',
    strip_description_bbcode: 'true',
    return_tags: 'true',
    return_vote_data: 'true',
    return_metadata: 'false'
  })
  if (sort === 'trend') params.set('days', '7')
  ADULT_DESCRIPTORS.forEach((d, n) => params.set(`excluded_content_descriptors[${n}]`, String(d)))
  const res = await getJson(`${API}/IPublishedFileService/QueryFiles/v1/?${params.toString()}`)
  const r = res?.status === 200 ? res.json?.response : null
  if (!r) {
    log(`Communauté Steam : Workshop de ${appid} non lu (${res ? `HTTP ${res.status}` : 'pas de réponse'})`)
    return { appid, sort, items: [], next: null, error: apiError(res), fetchedAt: Date.now() }
  }
  const list: any[] = Array.isArray(r.publishedfiledetails) ? r.publishedfiledetails : []
  await readAuthors(key, list.map((d) => String(d?.creator ?? '')))
  const items = list.map((d) => toItem(d, appid)).filter((x): x is WorkshopItem => !!x)
  const next = typeof r.next_cursor === 'string' && r.next_cursor && r.next_cursor !== cursor && list.length >= WS_PER_PAGE ? r.next_cursor : null
  return { appid, sort, items, next, error: null, fetchedAt: Date.now() }
}

/** Une page d'objets du Workshop d'un jeu (cache 30 min ; première page aussi sur le disque). */
export async function getWorkshopPage(appid: number, sort: WorkshopSort, cursor: string | null = null, refresh = false): Promise<WorkshopPage> {
  const s: WorkshopSort = sort in QUERY_TYPE ? sort : 'trend'
  const cur = typeof cursor === 'string' && cursor && cursor.length < 400 ? cursor : '*'
  const empty = (error: CommunityError): WorkshopPage => ({ appid, sort: s, items: [], next: null, error, fetchedAt: Date.now() })
  if (!Number.isInteger(appid) || appid <= 0) return empty('notFound')
  const creds = steamApiCredentials()
  if (!creds) return empty('no-key')
  const memKey = `${appid}:${s}:${cur}`
  const file = `workshop-${appid}-${s}.json`
  const hit = pageMem.get(memKey)
  if (!refresh && hit && Date.now() - hit.at < WORKSHOP_TTL) return hit.page
  if (!refresh && !hit && cur === '*') {
    const d = await readDisk<WorkshopPage>(file)
    if (d && d.key === creds.steamId && Date.now() - d.at < WORKSHOP_TTL) {
      pageMem.set(memKey, { at: d.at, page: d.value })
      return d.value
    }
  }
  const running = pageRunning.get(memKey)
  if (running) return running
  const p = (async () => {
    try {
      const page = await loadPage(appid, s, cur, creds.key)
      if (!page.error) {
        pageMem.set(memKey, { at: Date.now(), page })
        if (cur === '*') void writeDisk(file, { key: creds.steamId, at: Date.now(), value: page })
        return page
      }
      // hors ligne : la dernière copie (mémoire, sinon disque) avec l'erreur
      const old = hit?.page ?? (cur === '*' ? (await readDisk<WorkshopPage>(file))?.value : undefined)
      return old && page.error === 'offline' ? { ...old, error: page.error } : page
    } catch (err) {
      log(`Communauté Steam : Workshop impossible à lire (${(err as Error).message})`)
      return empty('unavailable')
    } finally {
      pageRunning.delete(memKey)
    }
  })()
  pageRunning.set(memKey, p)
  return p
}

const detailMem = new Map<string, { at: number; detail: WorkshopDetail }>()

/** Fiche d'un objet du Workshop : images, description complète, étiquettes. */
export async function getWorkshopItem(id: string): Promise<WorkshopDetail> {
  const empty = (error: CommunityError): WorkshopDetail => ({ item: null, previews: [], body: [], error })
  if (!/^\d{1,24}$/.test(String(id))) return empty('notFound')
  const creds = steamApiCredentials()
  if (!creds) return empty('no-key')
  const hit = detailMem.get(id)
  if (hit && Date.now() - hit.at < WORKSHOP_TTL) return hit.detail
  const params = new URLSearchParams({
    key: creds.key,
    'publishedfileids[0]': id,
    includetags: 'true',
    includeadditionalpreviews: 'true',
    includevotes: 'true',
    short_description: 'false'
  })
  const res = await getJson(`${API}/IPublishedFileService/GetDetails/v1/?${params.toString()}`)
  const d = res?.status === 200 ? res.json?.response?.publishedfiledetails?.[0] : null
  if (!d) return hit?.detail ? { ...hit.detail, error: apiError(res) } : empty(res?.status === 200 ? 'notFound' : apiError(res))
  await readAuthors(creds.key, [String(d.creator ?? '')])
  const item = toItem(d, Number(d.consumer_appid) || 0)
  if (!item) return empty('notFound')
  const previews: string[] = []
  for (const p of Array.isArray(d.previews) ? d.previews : []) {
    // preview_type 0 : image (1 : vidéo YouTube, montrée seulement sur Steam)
    const url = Number(p?.preview_type ?? 0) === 0 ? allowedImage(p?.url) : null
    if (url && url !== item.preview && !previews.includes(url)) previews.push(url)
  }
  const detail: WorkshopDetail = { item, previews: previews.slice(0, 12), body: richText(typeof d.file_description === 'string' ? d.file_description : ''), error: null }
  detailMem.set(id, { at: Date.now(), detail })
  return detail
}
