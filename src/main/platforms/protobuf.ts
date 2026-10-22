// Lecteur minimal du format protobuf (sans schéma), pour product.db de Battle.net.
import { t } from '../../shared/i18n'

export interface PbField {
  /** numéro du champ */
  n: number
  /** 0 varint, 1 fixe 64 bits, 2 longueur (texte ou message), 5 fixe 32 bits */
  wt: number
  num?: number
  bytes?: Buffer
}

function varint(buf: Buffer, p: number): [number, number] {
  let result = 0
  let mult = 1
  for (let k = 0; k < 10; k++) {
    if (p >= buf.length) throw new Error(t('main.protobuf.varint'))
    const b = buf[p++]
    result += (b & 0x7f) * mult
    if (b < 0x80) return [result, p]
    mult *= 128
  }
  throw new Error(t('main.protobuf.varintTooLong'))
}

/** Champs d'un message (un seul niveau). Lève une erreur si les octets ne sont pas un message valide. */
export function pbFields(buf: Buffer): PbField[] {
  const out: PbField[] = []
  let p = 0
  while (p < buf.length) {
    const [key, p1] = varint(buf, p)
    p = p1
    const n = Math.floor(key / 8)
    const wt = key % 8
    if (n === 0) throw new Error(t('main.protobuf.field0'))
    if (wt === 0) {
      const [v, p2] = varint(buf, p)
      p = p2
      out.push({ n, wt, num: v })
    } else if (wt === 1) {
      if (p + 8 > buf.length) throw new Error(t('main.protobuf.fixed64'))
      out.push({ n, wt, bytes: buf.subarray(p, p + 8) })
      p += 8
    } else if (wt === 5) {
      if (p + 4 > buf.length) throw new Error(t('main.protobuf.fixed32'))
      out.push({ n, wt, bytes: buf.subarray(p, p + 4) })
      p += 4
    } else if (wt === 2) {
      const [len, p2] = varint(buf, p)
      p = p2
      if (p + len > buf.length) throw new Error(t('main.protobuf.length'))
      out.push({ n, wt, bytes: buf.subarray(p, p + len) })
      p += len
    } else throw new Error(t('main.protobuf.wireType', { type: wt }))
  }
  return out
}

export const pbAll = (fields: PbField[], n: number): PbField[] => fields.filter((f) => f.n === n)
export const pbFirst = (fields: PbField[], n: number): PbField | undefined => fields.find((f) => f.n === n)

export function pbString(fields: PbField[], n: number): string {
  const f = pbFirst(fields, n)
  return f?.bytes ? f.bytes.toString('utf8') : ''
}

export function pbNumber(fields: PbField[], n: number): number | null {
  const f = pbFirst(fields, n)
  return f?.num ?? null
}

export function pbMessage(fields: PbField[], n: number): PbField[] {
  const f = pbFirst(fields, n)
  if (!f?.bytes) return []
  try {
    return pbFields(f.bytes)
  } catch {
    return []
  }
}
