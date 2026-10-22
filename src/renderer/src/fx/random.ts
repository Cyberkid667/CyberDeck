// Aléatoire déterministe : mêmes graines, mêmes dessins d'une ouverture à l'autre.

/** Empreinte FNV-1a 32 bits d'une chaîne. */
export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Générateur pseudo-aléatoire (mulberry32) : renvoie des nombres dans [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Position d'un pair sur le globe : empreinte stable de son adresse (PAS une
 * géolocalisation). Un pair garde sa place d'une seconde à l'autre ; la
 * répartition est uniforme sur la sphère. Résultat en degrés.
 */
export function peerLatLon(address: string): { lat: number; lon: number } {
  const h = hashStr(address)
  const h2 = hashStr(address + '#')
  return {
    lat: (Math.asin((h & 0xffff) / 32767.5 - 1) * 180) / Math.PI,
    lon: (h2 / 4294967296) * 360 - 180
  }
}
