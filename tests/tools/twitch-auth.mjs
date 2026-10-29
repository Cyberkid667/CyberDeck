// Contrôle de la connexion Twitch par code d'appareil (src/main/twitchAuth.ts) avec de fausses
// réponses de Twitch : rien n'est envoyé sur le réseau. Usage : node tests/tools/twitch-auth.mjs
// (Node 22.6+ : le fichier TypeScript est lu directement, types retirés.)
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const auth = await import(pathToFileURL(path.join(ROOT, 'src', 'main', 'twitchAuth.ts')).href)

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log('ok   ', name)
  } catch (e) {
    failures++
    console.log('ÉCHEC', name, '\n     ', e.message)
  }
}

/** Faux réseau : renvoie les réponses dans l'ordre et note les demandes. */
function fakePost(responses) {
  const calls = []
  const post = async (url, form) => {
    calls.push({ url, form })
    const r = responses.shift()
    return typeof r === 'function' ? r() : r
  }
  return { post, calls }
}

/** Fausse horloge : sleep avance le temps au lieu d'attendre. */
function clock(start = 1_000_000) {
  let now = start
  const slept = []
  return { now: () => now, sleep: async (ms) => (slept.push(ms), (now += ms)), slept }
}

const DEVICE_OK = { status: 200, json: { device_code: 'dev-123', expires_in: 1800, interval: 5, user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCD-EFGH' } }
const PENDING = { status: 400, json: { status: 400, message: 'authorization_pending' } }
const TOKENS = { status: 200, json: { access_token: 'acc-1', expires_in: 14400, refresh_token: 'ref-1', scope: ['user:read:follows'], token_type: 'bearer' } }
const code = (over = {}) => ({ deviceCode: 'dev-123', userCode: 'ABCD-EFGH', verificationUri: 'https://www.twitch.tv/activate', expiresAt: 1_000_000 + 1800_000, interval: 5000, ...over })

await check('code d’appareil : réponse lue, demande correcte', async () => {
  const { post, calls } = fakePost([DEVICE_OK])
  const r = await auth.requestDeviceCode(post, 'cid', ['user:read:follows'], 1_000_000)
  assert.equal(r.ok, true)
  assert.equal(r.code.userCode, 'ABCD-EFGH')
  assert.equal(r.code.interval, 5000)
  assert.equal(r.code.expiresAt, 1_000_000 + 1800_000)
  assert.match(r.code.verificationUri, /^https:\/\/www\.twitch\.tv\/activate/)
  assert.equal(calls[0].url, 'https://id.twitch.tv/oauth2/device')
  assert.deepEqual(calls[0].form, { client_id: 'cid', scopes: 'user:read:follows' })
})

await check('code d’appareil : client refusé, hors ligne', async () => {
  const bad = await auth.requestDeviceCode(fakePost([{ status: 400, json: { status: 400, message: 'invalid client' } }]).post, 'x', [], 0)
  assert.deepEqual(bad, { ok: false, error: 'invalid client' })
  const off = await auth.requestDeviceCode(fakePost([null]).post, 'x', [], 0)
  assert.deepEqual(off, { ok: false, error: 'network' })
})

await check('attente : pending, coupure réseau, slow_down, puis jetons', async () => {
  const c = clock()
  const { post, calls } = fakePost([PENDING, null, { status: 400, json: { message: 'slow_down' } }, PENDING, TOKENS])
  const r = await auth.pollDeviceToken(post, 'cid', ['user:read:follows'], code(), { now: c.now, sleep: c.sleep, cancelled: () => false })
  assert.equal(r.status, 'ok')
  assert.equal(r.tokens.access, 'acc-1')
  assert.equal(r.tokens.refresh, 'ref-1')
  assert.deepEqual(r.tokens.scopes, ['user:read:follows'])
  assert.equal(r.tokens.expiresAt, c.now() + 14400_000)
  // intervalle de Twitch, puis +5 s après slow_down
  assert.deepEqual(c.slept, [5000, 5000, 5000, 10000, 10000])
  assert.equal(calls.length, 5)
  assert.deepEqual(calls[0].form, { client_id: 'cid', scopes: 'user:read:follows', device_code: 'dev-123', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
})

await check('attente : code expiré (horloge, puis réponse de Twitch)', async () => {
  const c = clock()
  const r1 = await auth.pollDeviceToken(fakePost(Array(1000).fill(PENDING)).post, 'cid', [], code({ expiresAt: 1_000_000 + 12_000 }), { now: c.now, sleep: c.sleep, cancelled: () => false })
  assert.equal(r1.status, 'expired')
  assert.ok(c.slept.length === 3, `3 attentes attendues, ${c.slept.length}`)
  const c2 = clock()
  const r2 = await auth.pollDeviceToken(fakePost([{ status: 400, json: { message: 'invalid device code' } }]).post, 'cid', [], code(), { now: c2.now, sleep: c2.sleep, cancelled: () => false })
  assert.equal(r2.status, 'expired')
})

await check('attente : accès refusé, erreur inconnue, annulation', async () => {
  const c = clock()
  const opts = { now: c.now, sleep: c.sleep, cancelled: () => false }
  assert.equal((await auth.pollDeviceToken(fakePost([{ status: 400, json: { message: 'access_denied' } }]).post, 'cid', [], code(), opts)).status, 'denied')
  const err = await auth.pollDeviceToken(fakePost([{ status: 400, json: { message: 'invalid client' } }]).post, 'cid', [], code(), opts)
  assert.deepEqual(err, { status: 'error', error: 'invalid client' })
  let stop = false
  const { post, calls } = fakePost([() => ((stop = true), PENDING), TOKENS])
  const r = await auth.pollDeviceToken(post, 'cid', [], code(), { ...opts, cancelled: () => stop })
  assert.equal(r.status, 'cancelled')
  assert.equal(calls.length, 1)
})

await check('attente : refus, quel que soit le texte exact de Twitch', async () => {
  // texte réel du refus inconnu tant qu'un vrai compte n'a pas refusé : les variantes connues de l'OAuth
  for (const message of ['access_denied', 'authorization_declined', 'The user denied the request']) {
    const c = clock()
    const r = await auth.pollDeviceToken(fakePost([{ status: 400, json: { status: 400, message } }]).post, 'cid', [], code(), { now: c.now, sleep: c.sleep, cancelled: () => false })
    assert.equal(r.status, 'denied', message)
  }
  // champ « error » au lieu de « message »
  const c = clock()
  const r = await auth.pollDeviceToken(fakePost([{ status: 400, json: { error: 'expired_token' } }]).post, 'cid', [], code(), { now: c.now, sleep: c.sleep, cancelled: () => false })
  assert.equal(r.status, 'expired')
})

await check('attente : 500 et 429 = on réessaie', async () => {
  const c = clock()
  const r = await auth.pollDeviceToken(fakePost([{ status: 503, json: null }, { status: 429, json: null }, TOKENS]).post, 'cid', [], code(), { now: c.now, sleep: c.sleep, cancelled: () => false })
  assert.equal(r.status, 'ok')
})

await check('rafraîchissement : nouveau jeton, refresh gardé s’il manque', async () => {
  const { post, calls } = fakePost([{ status: 200, json: { access_token: 'acc-2', expires_in: 100 } }])
  const r = await auth.refreshTokens(post, 'cid', 'ref-1', 5000)
  assert.equal(r.status, 'ok')
  assert.equal(r.tokens.access, 'acc-2')
  assert.equal(r.tokens.refresh, 'ref-1')
  assert.equal(r.tokens.expiresAt, 5000 + 100_000)
  assert.deepEqual(calls[0].form, { client_id: 'cid', grant_type: 'refresh_token', refresh_token: 'ref-1' })
  assert.equal(calls[0].url, 'https://id.twitch.tv/oauth2/token')
})

await check('rafraîchissement : refusé (session finie) ou réseau', async () => {
  assert.equal((await auth.refreshTokens(fakePost([{ status: 400, json: { message: 'Invalid refresh token' } }]).post, 'cid', 'r', 0)).status, 'invalid')
  assert.equal((await auth.refreshTokens(fakePost([null]).post, 'cid', 'r', 0)).status, 'network')
  assert.equal((await auth.refreshTokens(fakePost([{ status: 502, json: null }]).post, 'cid', 'r', 0)).status, 'network')
})

await check('révocation', async () => {
  const { post, calls } = fakePost([{ status: 200, json: null }, { status: 400, json: { message: 'Invalid token' } }])
  assert.equal(await auth.revokeToken(post, 'cid', 'acc-1'), true)
  assert.equal(await auth.revokeToken(post, 'cid', 'acc-1'), false)
  assert.deepEqual(calls[0], { url: 'https://id.twitch.tv/oauth2/revoke', form: { client_id: 'cid', token: 'acc-1' } })
})

await check('jetons : réponse sans jeton ignorée, scope en texte accepté', async () => {
  assert.equal(auth.tokensFromResponse({}, 0), null)
  assert.deepEqual(auth.tokensFromResponse({ access_token: 'a', scope: 'a b' }, 0).scopes, ['a', 'b'])
})

console.log(failures ? `\n${failures} échec(s)` : '\ntout est bon')
process.exit(failures ? 1 : 0)
