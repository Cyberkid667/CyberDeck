import fs from 'node:fs'
import path from 'node:path'
import type { SteamCollections } from '../shared/types'
import { cachedSteamClient } from './platforms/steam'
import { steamAccountId } from './platformSync'

// Collections Steam du compte (Favoris, collections de l'utilisateur, jeux cachés), lues dans le
// stockage cloud local du client Steam, en LECTURE SEULE :
//   <Steam>/userdata/<accountid>/config/cloudstorage/cloud-storage-namespace-1.json
// Le fichier est un tableau d'entrées [clé, { key, value, is_deleted?, … }] ; les collections ont des
// clés « user-collections.<id> » et leur value est un texte JSON { id, name, added: appid[], removed,
// filterSpec? }. « favorite » = Favoris, « hidden » = jeux cachés ; les collections dynamiques
// (filterSpec : règles de filtre de Steam) ne sont pas recalculées ici, seulement comptées.
// Cache : relu seulement quand la date ou la taille du fichier change.

const STEAM_ID_BASE = 76561197960265728n
const PREFIX = 'user-collections.'

let cache: { file: string; mtime: number; size: number; data: SteamCollections } | null = null

/** Fichier des collections du compte Steam de ce PC (ou celui des tests), null si inconnu. */
function collectionsFile(): string | null {
  const test = process.env.CYBERDECK_TEST_STEAM_COLLECTIONS
  if (test) return test
  const client = cachedSteamClient()
  const steamId = steamAccountId()
  if (!client || !steamId || !/^\d{17}$/.test(steamId)) return null
  const id = BigInt(steamId)
  if (id <= STEAM_ID_BASE) return null
  return path.join(client.dir, 'userdata', String(id - STEAM_ID_BASE), 'config', 'cloudstorage', 'cloud-storage-namespace-1.json')
}

/** appids ajoutés moins ceux retirés, sans doublons, dans l'ordre d'ajout. */
function appids(added: unknown, removed: unknown): number[] {
  const out = new Set<number>()
  const gone = new Set(Array.isArray(removed) ? removed.map(Number) : [])
  if (Array.isArray(added))
    for (const v of added) {
      const n = Number(v)
      if (Number.isInteger(n) && n > 0 && !gone.has(n)) out.add(n)
    }
  return [...out]
}

export function parseSteamCollections(text: string): SteamCollections {
  const data: SteamCollections = { favorites: [], hidden: [], collections: [], dynamicCount: 0 }
  let entries: unknown
  try {
    entries = JSON.parse(text)
  } catch {
    return data
  }
  if (!Array.isArray(entries)) return data
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0].startsWith(PREFIX)) continue
    const rec = entry[1] as { value?: unknown; is_deleted?: unknown } | null
    if (!rec || typeof rec !== 'object' || rec.is_deleted === true || typeof rec.value !== 'string') continue
    let v: { id?: unknown; name?: unknown; added?: unknown; removed?: unknown; filterSpec?: unknown }
    try {
      v = JSON.parse(rec.value)
    } catch {
      continue
    }
    if (!v || typeof v !== 'object') continue
    const id = typeof v.id === 'string' && v.id ? v.id : entry[0].slice(PREFIX.length)
    if (id === 'favorite') data.favorites = appids(v.added, v.removed)
    else if (id === 'hidden') data.hidden = appids(v.added, v.removed)
    else if (v.filterSpec) data.dynamicCount++
    else {
      const name = typeof v.name === 'string' ? v.name.trim() : ''
      if (name) data.collections.push({ id, name, appids: appids(v.added, v.removed) })
    }
  }
  data.collections.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  return data
}

/** Collections du compte Steam de ce PC ; null : pas de compte Steam ou fichier absent / illisible. */
export function getSteamCollections(): SteamCollections | null {
  const file = collectionsFile()
  if (!file) return null
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  if (cache && cache.file === file && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.data
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const data = parseSteamCollections(text)
  cache = { file, mtime: st.mtimeMs, size: st.size, data }
  return data
}
