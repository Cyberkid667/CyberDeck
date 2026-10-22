// Vérification des mises à jour : une seule requête à l'API publique de GitHub (dernière Release
// du dépôt), au démarrage puis toutes les 12 h, si le réglage est activé. Rien n'est téléchargé
// ni installé : l'interface dit « Mise à jour disponible » et ouvre la page de la Release sur
// demande. GitHub ne voit que l'adresse IP, comme pour une page web.
import { net, shell } from 'electron'
import type { UpdateState } from '../shared/types'

export const REPO = 'Cyberkid667/CyberDeck'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const TIMEOUT_MS = 15_000

/** « v0.5.7 », « 0.5.7-beta » → [0, 5, 7] ; null si ce n'est pas un numéro de version. */
function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** > 0 si a est plus récente que b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** Demande la dernière Release à GitHub et la compare à la version installée. */
export async function fetchUpdate(current: string): Promise<UpdateState> {
  const base: UpdateState = { status: 'error', current, latest: null, url: null, checkedAt: Date.now(), error: null }
  try {
    const res = await net.fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CyberDeck' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    // aucune Release publiée (404) : rien à proposer
    if (res.status === 404) return { ...base, status: 'current' }
    if (!res.ok) return { ...base, error: `GitHub a répondu ${res.status}` }
    const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
    const latest = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/i, '') : null
    if (!latest || !parseVersion(latest)) return { ...base, error: 'numéro de version illisible' }
    // seule une page de ce dépôt peut être ouverte
    const url = typeof data.html_url === 'string' && data.html_url.startsWith(`https://github.com/${REPO}/`) ? data.html_url : RELEASES_PAGE
    return { ...base, status: compareVersions(latest, current) > 0 ? 'available' : 'current', latest, url }
  } catch (err) {
    // hors ligne, délai dépassé… : on réessaiera à la prochaine vérification
    return { ...base, error: (err as Error).name === 'TimeoutError' ? 'délai dépassé' : 'hors ligne ou GitHub injoignable' }
  }
}

/** Ouvre la page de téléchargement (celle de la nouvelle version si elle est connue). */
export function openReleasePage(state: UpdateState): void {
  void shell.openExternal(state.url ?? RELEASES_PAGE)
}
