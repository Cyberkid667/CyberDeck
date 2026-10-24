// Profil Steam et amis dans CyberDeck (passe 3 de la refonte « Steam dans CyberDeck »).
// Lu sur la Web API de Steam (api.steampowered.com) avec la clé et le SteamID de l'utilisateur,
// rien d'autre n'est envoyé :
//   - ISteamUser/GetPlayerSummaries (en-tête du profil, présence des amis, par paquets de 100) ;
//   - IPlayerService/GetBadges (niveau, XP, badges), GetRecentlyPlayedGames (activité récente),
//     GetOwnedGames (jeux possédés, heures totales, dernière partie) ;
//   - ISteamUserStats/GetPlayerAchievements + GetSchemaForGame + GetGlobalAchievementPercentagesForApp
//     (succès des jeux récents : les plus rares et les plus récents) ;
//   - ISteamUser/GetFriendList (401 / 403 : liste d'amis privée).
// Cache en mémoire (profil 10 min, amis 45 s) et sur le disque (userData/profile) pour l'affichage
// hors ligne. La clé n'apparaît jamais dans le journal.
import { app, net } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getLang, type Lang } from '../shared/i18n'
import type {
  SteamFriend,
  SteamFriendsState,
  SteamPresence,
  SteamProfile,
  SteamProfileAchievement,
  SteamProfileBadge,
  SteamProfileError,
  SteamProfileGame,
  SteamProfileState
} from '../shared/types'
import { allowedImage } from './gameDetails'
import { steamAccountId, steamApiCredentials } from './platformSync'

const API = 'https://api.steampowered.com'
const COMMUNITY = 'https://steamcommunity.com'
const FETCH_TIMEOUT = 10_000

const PROFILE_TTL = 10 * 60_000
const FRIENDS_TTL = 45_000
/** Jeux récents dont on lit les succès. */
const ACH_GAMES = 4
const RAREST_MAX = 8
const LATEST_MAX = 8
const BADGES_MAX = 12
const RECENT_MAX = 6

let log: (message: string) => void = () => {}
export function initSteamProfile(d: { log: (message: string) => void }): void {
  log = d.log
}

const steamLang = (lang: Lang): string => (lang === 'fr' ? 'french' : 'english')

// ---------- Réseau ----------

/** Réponse JSON ; null : le réseau n'a pas répondu (hors ligne, délai dépassé). json : null si illisible. */
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

// ---------- Cache ----------

const dir = (): string => path.join(app.getPath('userData'), 'profile')

interface Disk<T> {
  steamId: string
  lang: Lang
  at: number
  value: T
}

async function readDisk<T>(name: string): Promise<Disk<T> | null> {
  try {
    const d = JSON.parse(await fsp.readFile(path.join(dir(), name), 'utf8')) as Disk<T>
    return d && typeof d.at === 'number' && d.value ? d : null
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
    log(`Profil Steam : cache impossible à enregistrer (${(err as Error).message})`)
  }
}

/** Lecture avec cache (mémoire puis disque) ; hors ligne, la dernière copie est rendue avec l'erreur. */
function makeCached<S extends { error: SteamProfileError | null; fetchedAt: number }>(file: string, ttl: number, keepOnError: (e: SteamProfileError) => boolean) {
  let mem: Disk<S> | null = null
  let diskRead = false
  let running: Promise<S> | null = null
  return async (refresh: boolean, load: (key: string, steamId: string, lang: Lang) => Promise<S>, empty: (e: SteamProfileError) => S): Promise<S> => {
    const steamId = steamAccountId()
    if (!steamId) return empty('no-account')
    const creds = steamApiCredentials()
    if (!creds) return empty('no-key')
    const lang = getLang()
    if (!diskRead) {
      diskRead = true
      mem = await readDisk<S>(file)
    }
    const same = mem && mem.steamId === creds.steamId && mem.lang === lang ? mem : null
    if (!refresh && same && Date.now() - same.at < ttl) return same.value
    if (running) return running
    running = (async (): Promise<S> => {
      let value: S
      try {
        value = await load(creds.key, creds.steamId, lang)
      } catch (err) {
        log(`Profil Steam : lecture impossible (${(err as Error).message})`)
        value = empty('unavailable')
      }
      if (!value.error || !keepOnError(value.error)) {
        mem = { steamId: creds.steamId, lang, at: Date.now(), value }
        void writeDisk(file, mem)
        return value
      }
      // hors ligne ou réponse inattendue : dernière copie (même compte), avec l'erreur
      const old = mem && mem.steamId === creds.steamId ? mem.value : null
      return old ? { ...old, error: value.error } : value
    })()
    try {
      return await running
    } finally {
      running = null
    }
  }
}

// ---------- Petits outils ----------

function presence(p: any): SteamPresence {
  if (p?.gameextrainfo || p?.gameid) return 'ingame'
  switch (Number(p?.personastate)) {
    case 1:
    case 5:
    case 6:
      return 'online'
    case 2:
      return 'busy'
    case 3:
      return 'away'
    case 4:
      return 'snooze'
    default:
      return 'offline'
  }
}

const ms = (s: unknown): number | null => (Number(s) > 0 ? Number(s) * 1000 : null)
const str = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.trim() : null)
const gameIcon = (appid: number, hash: unknown): string | null =>
  typeof hash === 'string' && /^[0-9a-f]{40}$/i.test(hash) ? allowedImage(`https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`) : null

/** Erreur d'une réponse de la Web API (null : réseau muet). */
function apiError(res: { status: number } | null): SteamProfileError {
  if (!res) return 'offline'
  if (res.status === 401 || res.status === 403) return 'invalid-key'
  return 'unavailable'
}

// ---------- Profil ----------

async function readAchievements(key: string, steamId: string, lang: Lang, games: { appid: number; name: string }[]): Promise<SteamProfileAchievement[]> {
  const k = encodeURIComponent(key)
  const l = steamLang(lang)
  const out: SteamProfileAchievement[] = []
  await pool(games, 3, async (g) => {
    const [player, schema, global] = await Promise.all([
      getJson(`${API}/ISteamUserStats/GetPlayerAchievements/v1/?appid=${g.appid}&key=${k}&steamid=${steamId}&l=${l}`),
      getJson(`${API}/ISteamUserStats/GetSchemaForGame/v2/?appid=${g.appid}&key=${k}&l=${l}`),
      getJson(`${API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${g.appid}`)
    ])
    const list: any[] = player?.status === 200 ? player.json?.playerstats?.achievements ?? [] : []
    if (!Array.isArray(list) || !list.length) return
    const defs = new Map<string, any>()
    for (const a of schema?.json?.game?.availableGameStats?.achievements ?? []) if (a?.name) defs.set(String(a.name), a)
    const pct = new Map<string, number>()
    for (const a of global?.json?.achievementpercentages?.achievements ?? []) {
      const n = Number(a?.percent)
      if (a?.name && Number.isFinite(n)) pct.set(String(a.name), n)
    }
    for (const a of list) {
      if (Number(a?.achieved) !== 1) continue
      const id = String(a.apiname)
      const def = defs.get(id) ?? {}
      out.push({
        appid: g.appid,
        game: g.name,
        id,
        name: String(a.name || def.displayName || id),
        description: String(a.description || def.description || ''),
        icon: allowedImage(def.icon),
        unlockedAt: ms(a.unlocktime),
        percent: pct.has(id) ? pct.get(id)! : null
      })
    }
  })
  return out
}

async function loadProfile(key: string, steamId: string, lang: Lang): Promise<SteamProfileState> {
  const k = encodeURIComponent(key)
  const [summary, badges, recent, owned] = await Promise.all([
    getJson(`${API}/ISteamUser/GetPlayerSummaries/v2/?key=${k}&steamids=${steamId}`),
    getJson(`${API}/IPlayerService/GetBadges/v1/?key=${k}&steamid=${steamId}`),
    getJson(`${API}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${k}&steamid=${steamId}&count=0`),
    getJson(`${API}/IPlayerService/GetOwnedGames/v1/?key=${k}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1&format=json`)
  ])
  const p = summary?.status === 200 ? summary.json?.response?.players?.[0] : null
  if (!p) {
    const error = apiError(summary)
    log(`Profil Steam : résumé du profil non lu (${summary ? `HTTP ${summary.status}` : 'pas de réponse'})`)
    return { profile: null, error, fetchedAt: Date.now() }
  }

  // jeux possédés : noms, icônes, heures, dernière partie
  const ownedList: any[] = owned?.status === 200 && Array.isArray(owned.json?.response?.games) ? owned.json.response.games : []
  const ownedKnown = owned?.status === 200 && owned.json?.response && typeof owned.json.response.game_count === 'number'
  const byApp = new Map<number, any>()
  for (const g of ownedList) if (Number(g?.appid) > 0) byApp.set(Number(g.appid), g)

  const recentList: SteamProfileGame[] = (recent?.status === 200 ? recent.json?.response?.games ?? [] : [])
    .filter((g: any) => Number(g?.appid) > 0)
    .map((g: any): SteamProfileGame => {
      const appid = Number(g.appid)
      const o = byApp.get(appid)
      return {
        appid,
        name: String(g.name || o?.name || appid),
        icon: gameIcon(appid, g.img_icon_url ?? o?.img_icon_url),
        minutes2Weeks: Number(g.playtime_2weeks) || 0,
        minutesTotal: Number(g.playtime_forever ?? o?.playtime_forever) || 0,
        lastPlayedAt: ms(o?.rtime_last_played)
      }
    })
    .sort((a: SteamProfileGame, b: SteamProfileGame) => b.minutes2Weeks - a.minutes2Weeks)

  // badges : les plus récents d'abord
  const b = badges?.status === 200 ? badges.json?.response : null
  const badgeList: SteamProfileBadge[] = (Array.isArray(b?.badges) ? b.badges : [])
    .map((x: any): SteamProfileBadge => {
      const appid = Number(x?.appid) > 0 ? Number(x.appid) : null
      return {
        badgeId: Number(x?.badgeid) || 0,
        appid,
        gameName: appid ? (str(byApp.get(appid)?.name) ?? recentList.find((r) => r.appid === appid)?.name ?? null) : null,
        icon: appid ? gameIcon(appid, byApp.get(appid)?.img_icon_url) ?? recentList.find((r) => r.appid === appid)?.icon ?? null : null,
        level: Number(x?.level) || 0,
        xp: Number(x?.xp) || 0,
        earnedAt: ms(x?.completion_time),
        foil: Number(x?.border_color) === 1
      }
    })
    .sort((a: SteamProfileBadge, c: SteamProfileBadge) => (c.earnedAt ?? 0) - (a.earnedAt ?? 0))

  // succès des jeux récents
  const achGames = recentList.slice(0, ACH_GAMES).map((g) => ({ appid: g.appid, name: g.name }))
  const ach = achGames.length ? await readAchievements(key, steamId, lang, achGames) : []
  const rarest = [...ach]
    .filter((a) => a.percent !== null)
    .sort((a, c) => a.percent! - c.percent! || (c.unlockedAt ?? 0) - (a.unlockedAt ?? 0))
    .slice(0, RAREST_MAX)
  const latest = [...ach].sort((a, c) => (c.unlockedAt ?? 0) - (a.unlockedAt ?? 0)).slice(0, LATEST_MAX)

  const level = typeof b?.player_level === 'number' ? b.player_level : null
  const profile: SteamProfile = {
    steamId,
    personaName: String(p.personaname ?? ''),
    avatar: allowedImage(p.avatarfull ?? p.avatarmedium ?? p.avatar),
    realName: str(p.realname),
    country: typeof p.loccountrycode === 'string' && /^[A-Z]{2}$/.test(p.loccountrycode) ? p.loccountrycode : null,
    profileUrl: typeof p.profileurl === 'string' && p.profileurl.startsWith(`${COMMUNITY}/`) ? p.profileurl : `${COMMUNITY}/profiles/${steamId}/`,
    memberSince: ms(p.timecreated),
    status: presence(p),
    gameName: str(p.gameextrainfo),
    lastOnline: ms(p.lastlogoff),
    level,
    xp: typeof b?.player_xp === 'number' ? b.player_xp : null,
    xpToNext: typeof b?.player_xp_needed_to_level_up === 'number' ? b.player_xp_needed_to_level_up : null,
    badgeCount: Array.isArray(b?.badges) ? b.badges.length : null,
    badges: badgeList.slice(0, BADGES_MAX),
    gamesOwned: ownedKnown ? Number(owned!.json.response.game_count) : null,
    totalMinutes: ownedKnown ? ownedList.reduce((s, g) => s + (Number(g?.playtime_forever) || 0), 0) : null,
    recent: recentList.slice(0, RECENT_MAX),
    rarest,
    latest
  }
  return { profile, error: null, fetchedAt: Date.now() }
}

const profileCache = makeCached<SteamProfileState>('profile.json', PROFILE_TTL, (e) => e === 'offline' || e === 'unavailable')

export function getSteamProfile(refresh = false): Promise<SteamProfileState> {
  return profileCache(refresh, loadProfile, (error) => ({ profile: null, error, fetchedAt: Date.now() }))
}

// ---------- Amis ----------

async function loadFriends(key: string, steamId: string): Promise<SteamFriendsState> {
  const k = encodeURIComponent(key)
  const list = await getJson(`${API}/ISteamUser/GetFriendList/v1/?key=${k}&steamid=${steamId}&relationship=friend`)
  if (!list) return { friends: [], error: 'offline', fetchedAt: Date.now() }
  // 401 / 403 : liste d'amis privée (paramètres de confidentialité du profil)
  if (list.status === 401 || list.status === 403) return { friends: [], error: 'private', fetchedAt: Date.now() }
  if (list.status !== 200) {
    log(`Profil Steam : liste d’amis non lue (HTTP ${list.status})`)
    return { friends: [], error: 'unavailable', fetchedAt: Date.now() }
  }
  const raw: any[] = Array.isArray(list.json?.friendslist?.friends) ? list.json.friendslist.friends : []
  const since = new Map<string, number | null>()
  for (const f of raw) {
    const id = String(f?.steamid ?? '')
    if (/^\d{17}$/.test(id)) since.set(id, ms(f.friend_since))
  }
  const ids = [...since.keys()]
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100))
  const people = new Map<string, any>()
  let failed = 0
  await Promise.all(
    batches.map(async (batch) => {
      const res = await getJson(`${API}/ISteamUser/GetPlayerSummaries/v2/?key=${k}&steamids=${batch.join(',')}`)
      if (res?.status !== 200) failed++
      for (const p of res?.json?.response?.players ?? []) people.set(String(p.steamid), p)
    })
  )
  if (batches.length && failed === batches.length) return { friends: [], error: 'offline', fetchedAt: Date.now() }
  const friends: SteamFriend[] = ids.map((id) => {
    const p = people.get(id)
    return {
      steamid: id,
      name: String(p?.personaname || id),
      avatar: allowedImage(p?.avatarmedium ?? p?.avatar),
      status: p ? presence(p) : 'offline',
      game: str(p?.gameextrainfo),
      lastOnline: ms(p?.lastlogoff),
      friendSince: since.get(id) ?? null
    }
  })
  return { friends, error: null, fetchedAt: Date.now() }
}

const friendsCache = makeCached<SteamFriendsState>('friends.json', FRIENDS_TTL, (e) => e === 'offline' || e === 'unavailable')

export function getSteamFriends(refresh = false): Promise<SteamFriendsState> {
  return friendsCache(refresh, (key, steamId) => loadFriends(key, steamId), (error) => ({ friends: [], error, fetchedAt: Date.now() }))
}
