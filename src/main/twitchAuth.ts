// Connexion Twitch par « code d'appareil » (OAuth Device Code Grant Flow, client public sans
// secret) : l'app demande un code, l'utilisateur le saisit sur twitch.tv/activate dans son
// navigateur (l'app ne voit jamais son mot de passe), puis l'app interroge Twitch jusqu'à
// recevoir les jetons. Aussi : rafraîchissement et révocation des jetons.
// Fichier sans Electron (le réseau est passé en paramètre) : testable seul avec de fausses réponses.

export const TWITCH_ID = 'https://id.twitch.tv/oauth2'

/** Réponse HTTP réduite à ce qui sert ici ; null : pas de réponse (hors ligne, délai dépassé). */
export type PostForm = (url: string, form: Record<string, string>) => Promise<{ status: number; json: any } | null>

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** date d'expiration du code (ms) */
  expiresAt: number
  /** attente entre deux interrogations (ms) */
  interval: number
}

export interface Tokens {
  access: string
  refresh: string | null
  /** date d'expiration du jeton d'accès (ms) */
  expiresAt: number
  scopes: string[]
}

export type DeviceCodeResult = { ok: true; code: DeviceCode } | { ok: false; error: string }

export type PollResult =
  | { status: 'ok'; tokens: Tokens }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }

export type RefreshResult = { status: 'ok'; tokens: Tokens } | { status: 'invalid' } | { status: 'network' }

/** Message lisible d'une réponse d'erreur de Twitch ({ status, message }). */
const twitchMessage = (json: any, status: number): string =>
  (json && typeof json.message === 'string' && json.message) || (json && typeof json.error === 'string' && json.error) || `HTTP ${status}`

/** Jetons d'une réponse de /oauth2/token ; null si la réponse n'en contient pas. */
export function tokensFromResponse(json: any, now: number): Tokens | null {
  if (!json || typeof json.access_token !== 'string' || !json.access_token) return null
  const expiresIn = Number(json.expires_in)
  return {
    access: json.access_token,
    refresh: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    // durée absente : Twitch donne environ 4 h ; on prévoit une relecture au bout d'une heure
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    scopes: Array.isArray(json.scope) ? json.scope.map(String) : typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : []
  }
}

/** Étape 1 : demande d'un code d'appareil (POST /oauth2/device). */
export async function requestDeviceCode(post: PostForm, clientId: string, scopes: string[], now: number): Promise<DeviceCodeResult> {
  const res = await post(`${TWITCH_ID}/device`, { client_id: clientId, scopes: scopes.join(' ') })
  if (!res) return { ok: false, error: 'network' }
  const j = res.json
  if (res.status !== 200 || !j || typeof j.device_code !== 'string' || typeof j.user_code !== 'string') {
    return { ok: false, error: twitchMessage(j, res.status) }
  }
  const expiresIn = Number(j.expires_in)
  const interval = Number(j.interval)
  return {
    ok: true,
    code: {
      deviceCode: j.device_code,
      userCode: j.user_code,
      verificationUri: typeof j.verification_uri === 'string' && j.verification_uri ? j.verification_uri : 'https://www.twitch.tv/activate',
      expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1800) * 1000,
      interval: Math.max(1, Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000
    }
  }
}

export interface PollOptions {
  now: () => number
  /** attend ms millisecondes ; rejette ou se termine tôt si l'interrogation est annulée */
  sleep: (ms: number) => Promise<void>
  /** vrai : l'utilisateur a annulé (fenêtre fermée, déconnexion) */
  cancelled: () => boolean
}

/**
 * Étape 2 : interroge /oauth2/token jusqu'à ce que l'utilisateur ait accepté sur twitch.tv,
 * refusé, ou que le code expire. « authorization_pending » : on attend ; « slow_down » : on
 * espace les demandes de 5 s ; coupure réseau : on réessaie (jusqu'à l'expiration du code).
 */
export async function pollDeviceToken(post: PostForm, clientId: string, scopes: string[], code: DeviceCode, opts: PollOptions): Promise<PollResult> {
  let interval = code.interval
  for (;;) {
    await opts.sleep(interval)
    if (opts.cancelled()) return { status: 'cancelled' }
    if (opts.now() >= code.expiresAt) return { status: 'expired' }
    const res = await post(`${TWITCH_ID}/token`, {
      client_id: clientId,
      scopes: scopes.join(' '),
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
    if (opts.cancelled()) return { status: 'cancelled' }
    if (!res) continue
    if (res.status === 200) {
      const tokens = tokensFromResponse(res.json, opts.now())
      return tokens ? { status: 'ok', tokens } : { status: 'error', error: 'no token in response' }
    }
    const msg = twitchMessage(res.json, res.status).toLowerCase()
    if (msg.includes('authorization_pending')) continue
    if (msg.includes('slow_down')) {
      interval += 5000
      continue
    }
    if (msg.includes('denied') || msg.includes('declined')) return { status: 'denied' }
    if (msg.includes('invalid device code') || msg.includes('expired')) return { status: 'expired' }
    if (res.status >= 500 || res.status === 429) continue
    return { status: 'error', error: twitchMessage(res.json, res.status) }
  }
}

/** Nouveau jeton d'accès à partir du jeton de rafraîchissement (client public : sans secret). */
export async function refreshTokens(post: PostForm, clientId: string, refresh: string, now: number): Promise<RefreshResult> {
  const res = await post(`${TWITCH_ID}/token`, { client_id: clientId, grant_type: 'refresh_token', refresh_token: refresh })
  if (!res || res.status >= 500 || res.status === 429) return { status: 'network' }
  if (res.status !== 200) return { status: 'invalid' }
  const tokens = tokensFromResponse(res.json, now)
  return tokens ? { status: 'ok', tokens: { ...tokens, refresh: tokens.refresh ?? refresh } } : { status: 'invalid' }
}

/** Révocation d'un jeton (déconnexion) ; vrai si Twitch l'a acceptée. */
export async function revokeToken(post: PostForm, clientId: string, token: string): Promise<boolean> {
  const res = await post(`${TWITCH_ID}/revoke`, { client_id: clientId, token })
  return !!res && res.status === 200
}
