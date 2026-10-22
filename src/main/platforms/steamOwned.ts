// Jeux possédés d'un compte Steam (Web API, clé fournie par l'utilisateur) et
// type des applications d'après la boutique (sans clé). La clé n'apparaît que
// dans l'adresse envoyée à api.steampowered.com : jamais dans le journal.
import { t, tn } from '../../shared/i18n'

export type FetchJson = (url: string, timeoutMs?: number) => Promise<{ status: number; json: unknown }>

export interface OwnedGame {
  appid: number
  name: string
  playtimeMinutes: number
  /** secondes Unix */
  lastPlayed: number | null
  iconHash: string | null
}

export interface OwnedGamesResult {
  status: 'ok' | 'invalid-key' | 'private' | 'offline' | 'error'
  message: string
  games: OwnedGame[]
}

export const normalizeSteamKey = (key: string): string => key.replace(/\s+/g, '').toUpperCase()
export const isSteamKeyFormat = (key: string): boolean => /^[0-9A-F]{32}$/.test(normalizeSteamKey(key))

export async function fetchOwnedGames(fetchJson: FetchJson, key: string, steamId: string): Promise<OwnedGamesResult> {
  const k = normalizeSteamKey(key)
  if (!isSteamKeyFormat(k)) return { status: 'invalid-key', message: t('main.steam.keyFormat'), games: [] }
  if (!/^\d{17}$/.test(steamId)) return { status: 'error', message: t('main.steam.accountNotFound'), games: [] }
  const url =
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=' +
    encodeURIComponent(k) +
    `&steamid=${steamId}&include_appinfo=true&include_played_free_games=true&format=json`
  let res: { status: number; json: unknown }
  try {
    res = await fetchJson(url, 20_000)
  } catch {
    return { status: 'offline', message: t('main.steam.offline'), games: [] }
  }
  if (res.status === 401 || res.status === 403)
    return { status: 'invalid-key', message: t('main.steam.keyRefused'), games: [] }
  if (res.status === 429) return { status: 'error', message: t('main.steam.rateLimited'), games: [] }
  if (res.status !== 200) return { status: 'error', message: t('main.steam.httpStatus', { status: res.status }), games: [] }
  const r = (res.json as { response?: { game_count?: number; games?: unknown[] } } | null)?.response
  if (!r || !Array.isArray(r.games)) {
    if (r && r.game_count === 0) return { status: 'ok', message: t('main.steam.noGames'), games: [] }
    return {
      status: 'private',
      message: t('main.steam.private'),
      games: []
    }
  }
  const games: OwnedGame[] = []
  for (const raw of r.games as Record<string, unknown>[]) {
    const appid = Number(raw.appid)
    if (!Number.isInteger(appid) || appid <= 0) continue
    games.push({
      appid,
      name: typeof raw.name === 'string' ? raw.name : '',
      playtimeMinutes: Number(raw.playtime_forever) || 0,
      lastPlayed: Number(raw.rtime_last_played) || null,
      iconHash: typeof raw.img_icon_url === 'string' && /^[0-9a-f]{40}$/i.test(raw.img_icon_url) ? raw.img_icon_url : null
    })
  }
  return { status: 'ok', message: tn('main.steam.gameCount', games.length), games }
}

/**
 * Type des applications d'après la boutique Steam (0 jeu, 1 démo, 4 DLC, 6 logiciel…) ;
 * null si la boutique ne connaît pas l'app (outil caché, retiré de la vente).
 */
export async function fetchStoreTypes(fetchJson: FetchJson, appids: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>()
  for (let i = 0; i < appids.length; i += 50) {
    const chunk = appids.slice(i, i + 50)
    const input = { ids: chunk.map((appid) => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: {} }
    try {
      const res = await fetchJson(
        `https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`,
        15_000
      )
      const items = (res.json as { response?: { store_items?: Record<string, unknown>[] } } | null)?.response?.store_items ?? []
      for (const it of items) {
        const id = Number(it.id ?? it.appid)
        if (!id) continue
        out.set(id, it.success === 1 ? Number(it.type ?? 0) : null)
      }
    } catch {
      // morceau ignoré : repli sur le nom pour ces applications
    }
  }
  return out
}
