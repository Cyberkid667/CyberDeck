// Formats de fichiers de Steam : VDF texte (KeyValues : libraryfolders.vdf,
// appmanifest_*.acf, loginusers.vdf, localconfig.vdf) et appinfo.vdf (binaire).

export interface VdfObject {
  [key: string]: string | VdfObject
}

/** VDF texte → objet. Les clés gardent leur casse ; utiliser vdfGet pour les lire. */
export function parseVdf(text: string): VdfObject {
  let i = 0
  const n = text.length
  if (text.charCodeAt(0) === 0xfeff) i = 1

  const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff

  function skip(): void {
    for (;;) {
      while (i < n && isSpace(text.charCodeAt(i))) i++
      if (text[i] === '/' && text[i + 1] === '/') {
        const e = text.indexOf('\n', i)
        i = e < 0 ? n : e + 1
        continue
      }
      break
    }
  }

  function str(): string {
    if (text[i] === '"') {
      i++
      let s = ''
      let start = i
      while (i < n) {
        const c = text.charCodeAt(i)
        if (c === 34) break // "
        if (c === 92 && i + 1 < n) {
          // \\ \" \n \t
          s += text.slice(start, i)
          const e = text[i + 1]
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e
          i += 2
          start = i
          continue
        }
        i++
      }
      s += text.slice(start, i)
      i++
      return s
    }
    const start = i
    while (i < n) {
      const c = text.charCodeAt(i)
      if (isSpace(c) || c === 123 || c === 125 || c === 34) break // { } "
      i++
    }
    return text.slice(start, i)
  }

  function obj(depth: number): VdfObject {
    const o: VdfObject = {}
    for (;;) {
      skip()
      if (i >= n) return o
      if (text[i] === '}') {
        i++
        return o
      }
      const k = str()
      skip()
      if (text[i] === '{') {
        i++
        o[k] = depth > 64 ? {} : obj(depth + 1)
      } else o[k] = str()
      // condition facultative après une valeur : [$WIN32]
      const save = i
      skip()
      if (text[i] === '[') {
        while (i < n && text[i] !== ']') i++
        i++
      } else i = save
    }
  }

  return obj(0)
}

/** Lit un chemin de clés sans tenir compte de la casse (apps/Apps…). */
export function vdfGet(o: unknown, ...keys: string[]): unknown {
  let cur: unknown = o
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    const obj = cur as Record<string, unknown>
    if (k in obj) {
      cur = obj[k]
      continue
    }
    const lower = k.toLowerCase()
    const found = Object.keys(obj).find((x) => x.toLowerCase() === lower)
    cur = found === undefined ? undefined : obj[found]
  }
  return cur
}

export const vdfStr = (o: unknown, ...keys: string[]): string | null => {
  const v = vdfGet(o, ...keys)
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null
}

export const vdfObj = (o: unknown, ...keys: string[]): VdfObject | null => {
  const v = vdfGet(o, ...keys)
  return v && typeof v === 'object' ? (v as VdfObject) : null
}

// ---------- appinfo.vdf (binaire) ----------

export type KvValue = string | number | KvMap
export interface KvMap {
  [key: string]: KvValue
}

const MAGIC_27 = 0x07564427
const MAGIC_28 = 0x07564428
const MAGIC_29 = 0x07564429

/**
 * Lit appinfo.vdf et renvoie les sections des appid demandés (les autres sont
 * sautées sans être décodées). Formats 27, 28 et 29 ; erreur sur un format inconnu.
 */
export function readAppInfo(buf: Buffer, wanted: Set<number>): Map<number, KvMap> {
  const out = new Map<number, KvMap>()
  if (buf.length < 16) throw new Error('fichier trop court')
  const magic = buf.readUInt32LE(0)
  if (magic !== MAGIC_27 && magic !== MAGIC_28 && magic !== MAGIC_29) throw new Error(`format inconnu (0x${magic.toString(16)})`)
  let strings: string[] | null = null
  let o = 8
  if (magic === MAGIC_29) {
    const tableOffset = Number(buf.readBigInt64LE(8))
    if (tableOffset <= 0 || tableOffset >= buf.length) throw new Error('table de chaînes absente')
    let p = tableOffset
    const count = buf.readUInt32LE(p)
    p += 4
    strings = new Array(count)
    for (let k = 0; k < count; k++) {
      const e = buf.indexOf(0, p)
      if (e < 0) throw new Error('table de chaînes coupée')
      strings[k] = buf.toString('utf8', p, e)
      p = e + 1
    }
    o = 16
  }
  const header = magic === MAGIC_27 ? 40 : 60

  const cstr = (p: number): [string, number] => {
    const e = buf.indexOf(0, p)
    if (e < 0) throw new Error('chaîne coupée')
    return [buf.toString('utf8', p, e), e + 1]
  }
  const wstr = (p: number): [string, number] => {
    let e = p
    while (e + 1 < buf.length && (buf[e] !== 0 || buf[e + 1] !== 0)) e += 2
    return [buf.toString('utf16le', p, e), e + 2]
  }
  const readKv = (start: number, end: number, depth: number): [KvMap, number] => {
    const obj: KvMap = {}
    let p = start
    for (;;) {
      if (p >= end) throw new Error('section coupée')
      const t = buf[p++]
      if (t === 0x08 || t === 0x0b) return [obj, p]
      let key: string
      if (strings) {
        key = strings[buf.readUInt32LE(p)] ?? ''
        p += 4
      } else [key, p] = cstr(p)
      switch (t) {
        case 0x00: {
          if (depth > 32) throw new Error('trop profond')
          const [v, np] = readKv(p, end, depth + 1)
          obj[key] = v
          p = np
          break
        }
        case 0x01: {
          const [v, np] = cstr(p)
          obj[key] = v
          p = np
          break
        }
        case 0x05: {
          const [v, np] = wstr(p)
          obj[key] = v
          p = np
          break
        }
        case 0x02:
        case 0x04:
        case 0x06:
          obj[key] = buf.readInt32LE(p)
          p += 4
          break
        case 0x03:
          obj[key] = buf.readFloatLE(p)
          p += 4
          break
        case 0x07:
          obj[key] = Number(buf.readBigUInt64LE(p))
          p += 8
          break
        case 0x0a:
          obj[key] = Number(buf.readBigInt64LE(p))
          p += 8
          break
        default:
          throw new Error(`type ${t} inconnu`)
      }
    }
  }

  while (o + 8 <= buf.length) {
    const appid = buf.readUInt32LE(o)
    if (appid === 0) break
    const size = buf.readUInt32LE(o + 4)
    const recordEnd = o + 8 + size
    if (recordEnd > buf.length) throw new Error('fichier coupé (Steam l’écrit peut-être en ce moment)')
    if (wanted.has(appid)) {
      try {
        const [kv] = readKv(o + 8 + header, recordEnd, 0)
        out.set(appid, kv)
      } catch {
        // section illisible : l'app est traitée comme absente
      }
    }
    o = recordEnd
  }
  return out
}

/** Accès sans casse dans une section binaire. */
export function kvGet(o: unknown, ...keys: string[]): KvValue | undefined {
  return vdfGet(o, ...keys) as KvValue | undefined
}
