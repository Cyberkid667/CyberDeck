// Captures et contrôles de la rubrique Twitch de la page d'un jeu (sans rien installer ni lancer).
// Usage : node shoot-twitch.mjs <dossier-out> <copie-du-profil> <dossier-captures> <id-du-jeu> <mode> [fichier-fake]
//   <mode> : 'fake'      données de démonstration (CYBERDECK_TWITCH_FAKE) : encart, salle avec et sans chat,
//                        lecteur et chat réels (son coupé au niveau d'Electron), volume (aussi changé depuis
//                        le lecteur, et après rechargement du lecteur), chat en lecture seule, réglages
//            'signedout' démonstration sans compte : bouton de connexion et fenêtre du code
//            'noconfig'  sans identifiant d'application (CYBERDECK_TWITCH_CLIENT_ID=none) : « Twitch n'est pas configuré »
//            'badclient' identifiant bidon : vraie demande de code à Twitch, refusée (message d'erreur)
//            'mockapi'   faux serveur Twitch dans le processus principal (net.fetch remplacé) : connexion complète
//                        par code d'appareil (profil illisible juste après l'accord), jetons chiffrés, catégorie,
//                        tri et filtre « Chaînes suivies » séparés, langues, « Plus récents » sur plusieurs pages,
//                        droit manquant, aucune catégorie, hors ligne, limite d'appels, jeton expiré sans
//                        réseau, chiffrement impossible, déconnexion avec révocation
// [fichier-fake] : facultatif ; sans lui, des données de démonstration intégrées (première chaîne :
// « monstercat », en direct 24 h/24, pour que le lecteur ait une vidéo).
// Ne touche jamais au vrai profil ; les liens externes sont interceptés (rien ne s'ouvre).
// Code de sortie 1 s'il y a des problèmes.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = path.resolve(import.meta.dirname, '..', '..')

const [outDir, userData, shots, gameId, mode = 'fake', fakeFile] = process.argv.slice(2)
const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
fs.mkdirSync(shots, { recursive: true })
const problems = []
const notes = []
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const expect = (ok, what) => {
  if (!ok) problems.push(`attendu : ${what}`)
  else notes.push(`ok : ${what}`)
}

/** Données de démonstration intégrées : catégorie et streams fictifs (sauf la première chaîne, réelle). */
function builtInDemo() {
  const langs = ['en', 'en', 'fr', 'de', 'es', 'en', 'pt', 'fr', 'ru', 'ja', 'en', 'ko', 'it', 'pl', 'tr', 'fr', 'en', 'es', 'de', 'en', 'zh', 'nl', 'sv', 'en', 'fr', 'th', 'en', 'uk', 'en', 'other']
  const now = Date.now()
  return {
    user: { id: '42', login: 'mockuser', displayName: 'MockUser', avatar: null },
    category: { id: '32399', name: 'Counter-Strike', boxArt: 'https://static-cdn.jtvnw.net/ttv-boxart/32399-52x72.jpg' },
    streams: langs.map((language, i) => ({
      id: String(9000 + i),
      userId: String(100 + i),
      userLogin: i === 0 ? 'monstercat' : `cd_demo_${i}`,
      userName: i === 0 ? 'Monstercat' : `Demo${i}`,
      title: `Demo stream ${i}`,
      viewers: 50_000 - i * 1500,
      language,
      // ordre de début mélangé (tri « Plus récents » différent du tri par spectateurs) ;
      // le plus récent (cd_demo_25) n'arrive qu'avec la troisième page de 10 du faux serveur
      startedAt: now - ((i * 7919 + 25) % 30) * 600_000 - 60_000,
      thumbnail: `https://static-cdn.jtvnw.net/previews-ttv/live_user_cd_demo_${i}-440x248.jpg`,
      tags: ['Demo'],
      mature: i === 3
    }))
  }
}
const demo = fakeFile ? JSON.parse(fs.readFileSync(fakeFile, 'utf8')) : builtInDemo()
const demoFile = path.join(path.resolve(userData), '..', `twitch-demo-${process.pid}.json`)
if (!fakeFile && (mode === 'fake' || mode === 'signedout')) fs.writeFileSync(demoFile, JSON.stringify(demo))

// plateformes du PC jamais lues : seule la bibliothèque de démonstration du profil apparaît
const env = { ...process.env, CYBERDECK_USER_DATA: path.resolve(userData), CYBERDECK_TEST_QUIET: '1', CYBERDECK_TEST_NO_PLATFORMS: '1' }
delete env.CYBERDECK_TWITCH_FAKE
delete env.CYBERDECK_TWITCH_CLIENT_ID
if (mode === 'fake' || mode === 'signedout') env.CYBERDECK_TWITCH_FAKE = fakeFile ? path.resolve(fakeFile) : demoFile
if (mode === 'signedout') {
  const signedOut = { ...demo, user: null }
  fs.writeFileSync(demoFile, JSON.stringify(signedOut))
  env.CYBERDECK_TWITCH_FAKE = demoFile
}
if (mode === 'noconfig') env.CYBERDECK_TWITCH_CLIENT_ID = 'none'
if (mode === 'badclient') env.CYBERDECK_TWITCH_CLIENT_ID = 'cyberdeck-test-invalid-client-id'
if (mode === 'mockapi') env.CYBERDECK_TWITCH_CLIENT_ID = 'mock-client'

const app = await _electron.launch({
  executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [path.resolve(outDir, 'main', 'index.js')],
  env
})
// liens externes interceptés ; son des <webview> coupé au niveau d'Electron (la page croit jouer avec le son)
await app.evaluate(({ app: a, shell }) => {
  globalThis.__opened = []
  shell.openExternal = async (url) => {
    globalThis.__opened.push(url)
  }
  a.on('web-contents-created', (_e, wc) => {
    if (wc.getType() === 'webview') wc.setAudioMuted(true)
  })
})
if (mode === 'mockapi') {
  await app.evaluate(({ net }, demo) => {
    const real = net.fetch.bind(net)
    globalThis.__twitch = []
    // réglages du faux serveur, changés pendant le test
    globalThis.__mock = { usersFail: false, offline: false, rate429: false, missingScope: false, tokenTtl: 14400, pageSize: 10, valid: 'mock-access' }
    const m = globalThis.__mock
    let polls = 0
    let refreshes = 0
    const json = (status, body, headers = {}) => new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
    const toHelix = (s) => ({ id: s.id, user_id: s.userId, user_login: s.userLogin, user_name: s.userName, game_id: demo.category.id, title: s.title, viewer_count: s.viewers, language: s.language, started_at: new Date(s.startedAt).toISOString(), thumbnail_url: s.thumbnail.replace('440x248', '{width}x{height}'), tags: s.tags, is_mature: s.mature })
    net.fetch = async (input, init = {}) => {
      const url = String(typeof input === 'string' ? input : input.url)
      if (!/^https:\/\/(id|api)\.twitch\.tv\//.test(url)) return real(input, init)
      const body = typeof init.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {}
      const auth = init.headers?.Authorization ?? ''
      globalThis.__twitch.push(`${init.method ?? 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')} ${auth ? auth.split(' ')[0] : ''} ${body.grant_type ?? ''}`.trim())
      if (m.offline) throw new TypeError('net::ERR_INTERNET_DISCONNECTED')
      if (url.endsWith('/oauth2/device')) return json(200, { device_code: 'dev-1', expires_in: 1800, interval: 1, user_code: 'MOCK-CODE', verification_uri: 'https://www.twitch.tv/activate?device-code=MOCK-CODE' })
      if (url.endsWith('/oauth2/token') && body.grant_type?.includes('device_code')) {
        if (++polls < 3) return json(400, { status: 400, message: 'authorization_pending' })
        m.valid = 'mock-access'
        return json(200, { access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: m.tokenTtl, scope: ['user:read:follows'] })
      }
      if (url.endsWith('/oauth2/token') && body.grant_type === 'refresh_token') {
        m.valid = `mock-access-${++refreshes}`
        return json(200, { access_token: m.valid, refresh_token: `mock-refresh-${refreshes}`, expires_in: m.tokenTtl, scope: ['user:read:follows'] })
      }
      if (url.endsWith('/oauth2/revoke')) return json(200, null)
      if (url.endsWith('/oauth2/validate'))
        return auth === `OAuth ${m.valid}` ? json(200, { client_id: 'mock-client', login: 'mockuser', user_id: '42', scopes: ['user:read:follows'], expires_in: 3600 }) : json(401, { status: 401, message: 'invalid access token' })
      if (auth !== `Bearer ${m.valid}`) return json(401, { status: 401, message: 'invalid token' })
      const u = new URL(url)
      if (m.rate429) return json(429, { status: 429, message: 'Too Many Requests' }, { 'Ratelimit-Reset': String(Math.ceil(Date.now() / 1000) + 60), 'Ratelimit-Remaining': '0' })
      if (u.pathname === '/helix/users') {
        if (m.usersFail) return json(503, { status: 503, message: 'Service Unavailable' })
        return json(200, { data: [{ id: '42', login: 'mockuser', display_name: 'MockUser', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-300x300.png' }] })
      }
      if (u.pathname === '/helix/games') return json(200, { data: [] })
      if (u.pathname === '/helix/search/categories')
        return json(200, { data: [{ id: '1', name: 'Counter-Strike: Global Offensive', box_art_url: '' }, { id: demo.category.id, name: demo.category.name, box_art_url: 'https://static-cdn.jtvnw.net/ttv-boxart/32399-{width}x{height}.jpg' }] })
      if (u.pathname === '/helix/streams/followed') {
        if (m.missingScope) return json(401, { error: 'Unauthorized', status: 401, message: 'Missing scope: user:read:follows' })
        return json(200, { data: demo.streams.filter((_, i) => i % 3 === 0).map(toHelix), pagination: {} })
      }
      if (u.pathname === '/helix/streams') {
        const lang = u.searchParams.get('language')
        const all = demo.streams.filter((s) => !lang || s.language === lang)
        // pages courtes (pageSize) pour exercer « Afficher plus » et « Plus récents » sur plusieurs pages
        const from = Number(u.searchParams.get('after') ?? 0) || 0
        const page = all.slice(from, from + m.pageSize)
        const next = from + m.pageSize < all.length ? String(from + m.pageSize) : undefined
        return json(200, { data: page.map(toHelix), pagination: next ? { cursor: next } : {} })
      }
      return json(404, { message: 'not found' })
    }
  }, demo)
}
const page = await app.firstWindow()
page.setDefaultTimeout(10000)
page.on('pageerror', (e) => problems.push('erreur de page : ' + e.message))
page.on('console', (m) => m.type() === 'error' && problems.push('console : ' + m.text().slice(0, 200)))
const size = (W, H) => app.evaluate(({ BrowserWindow }, [W, H]) => BrowserWindow.getAllWindows()[0].setContentSize(W, H), [W, H])
await size(1440, 880)
await page.waitForTimeout(2500)

const $ = (id) => page.locator(`[data-testid="${id}"]`)
async function step(name, fn) {
  try {
    await fn()
  } catch (e) {
    problems.push(`${name} : ${String(e.message).split('\n')[0]}`)
    // capture de l'écran au moment de l'échec
    await page.screenshot({ path: path.join(shots, `echec-${problems.length}.png`) }).catch(() => {})
  }
}
const shot = (name) => page.screenshot({ path: path.join(shots, name + '.png') })
/** Capture de la fenêtre par Electron : la seule qui montre le lecteur et le chat (<webview>) à la bonne taille. */
const nativeShot = async (name) => {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(b64, 'base64'))
}
/** Code exécuté dans une <webview> (lecteur ou chat), avec un geste de l'utilisateur. */
const inGuest = (kind, code) =>
  app.evaluate(
    ({ webContents }, [kind, code]) => {
      const g = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && (kind === 'player' ? w.getURL().startsWith('https://player.twitch.tv/') : w.getURL().includes('/chat')))
      return g ? g.executeJavaScript(code, true).catch((e) => 'erreur : ' + String(e)) : 'absent'
    },
    [kind, code]
  )
/** Échap tapé dans le lecteur (le clavier est alors dans la <webview>, pas dans la fenêtre). */
const escapeInPlayer = () =>
  app.evaluate(({ webContents }) => {
    const g = webContents.getAllWebContents().find((w) => w.getURL().startsWith('https://player.twitch.tv/'))
    if (!g) return false
    g.focus()
    g.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    g.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    return true
  })

/** État du <video> du lecteur et texte du chat, lus dans les <webview> depuis le processus principal. */
const probe = () =>
  app.evaluate(async ({ webContents }) => {
    const out = {}
    for (const wc of webContents.getAllWebContents()) {
      const url = wc.getURL()
      if (wc.getType() !== 'webview') continue
      if (url.startsWith('https://player.twitch.tv/'))
        out.player = await wc
          .executeJavaScript(
            `(() => { const v = document.querySelector('video'); return { url: location.href, t: v && v.currentTime, ready: v && v.readyState, paused: v && v.paused, muted: v && v.muted, volume: v && v.volume, vis: document.visibilityState } })()`
          )
          .catch((e) => String(e))
      if (url.includes('/chat')) out.chat = await wc.executeJavaScript(`({ url: location.href, lines: document.querySelectorAll('[data-a-target="chat-line-message"], .chat-line__message').length, text: document.body.innerText.slice(0, 160) })`).catch((e) => String(e))
      out.audioMuted = wc.isAudioMuted()
    }
    return out
  })
const opened = () => app.evaluate(() => globalThis.__opened)
const twitchCalls = () => app.evaluate(() => globalThis.__twitch)
const mock = (flags) => app.evaluate((_e, flags) => Object.assign(globalThis.__mock, flags), flags)
const saved = () => JSON.parse(fs.readFileSync(path.join(userData, 'twitch.json'), 'utf8'))
const textOf = async (id) => ((await $(id).count()) ? ((await $(id).first().textContent()) ?? '') : '')

const library = JSON.parse(fs.readFileSync(path.join(userData, 'library.json'), 'utf8'))
const games = Array.isArray(library) ? library : library.games
const idOf = (name) => games.find((g) => g.name === name)?.id

async function openGame(id = gameId) {
  await $('nav-library').click()
  await page.waitForTimeout(1500)
  let card = page.locator(`[data-testid="game-card"][data-id="${id}"]`)
  if (!(await card.count())) {
    await $('library-show-owned').click()
    await page.waitForTimeout(1200)
    card = page.locator(`[data-testid="game-card"][data-id="${id}"]`)
  }
  await card.scrollIntoViewIfNeeded()
  await card.click()
  await page.waitForTimeout(2500)
  await $('twitch-section').scrollIntoViewIfNeeded()
  await page.evaluate(() => document.querySelector('[data-testid="twitch-section"]')?.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(1500)
}

if (mode === 'fake') {
  await step('page du jeu', () => openGame())
  await step('encart 1440', async () => {
    await $('twitch-card').first().waitFor()
    await page.waitForTimeout(2500)
    notes.push(`cartes affichées : ${await $('twitch-card').count()}, langue : ${await $('twitch-language').inputValue()}, tri : ${await $('twitch-sort').inputValue()}`)
    expect((await $('twitch-sort').locator('option').count()) === 2, 'le tri a deux choix (spectateurs, plus récents)')
    expect((await $('twitch-followed').count()) === 1, 'filtre « Chaînes suivies » à part')
    await shot('01-section-1440')
  })
  await step('tri plus récents + langue', async () => {
    await $('twitch-sort').selectOption('recent')
    await page.waitForTimeout(600)
    const langs = await $('twitch-language').locator('option').allTextContents()
    notes.push(`langues proposées : ${langs.join(', ')}`)
    expect(langs.length > 30, 'toutes les langues de Twitch proposées')
    await $('twitch-language').selectOption({ index: 1 })
    await page.waitForTimeout(1200)
    notes.push(`après filtre langue : ${await $('twitch-card').count()} cartes`)
    await shot('02-section-recent-language')
    await $('twitch-language').selectOption('')
    await $('twitch-sort').selectOption('viewers')
    await page.waitForTimeout(800)
  })
  await step('choix de catégorie', async () => {
    await $('twitch-category-change').click()
    await page.waitForTimeout(1200)
    await shot('03-category-picker')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    expect((await $('twitch-category-picker').count()) === 0, 'choix de catégorie fermé par Échap')
  })
  await step('salle avec chat', async () => {
    await $('twitch-card').first().click()
    await $('twitch-theater').waitFor()
    await page.waitForTimeout(14000)
    const p = await probe()
    notes.push(`lecteur (avec chat) : ${JSON.stringify(p.player)}`)
    notes.push(`chat : ${JSON.stringify(p.chat)}`)
    notes.push(`son coupé par Electron : ${p.audioMuted}`)
    expect((await $('twitch-chat-readonly').count()) === 1, 'mention « chat en lecture seule »')
    await nativeShot('04-theater-chat-1440')
  })
  await step('volume', async () => {
    const slider = $('twitch-volume')
    await slider.fill('23')
    await page.waitForTimeout(800)
    let p = await probe()
    notes.push(`volume 23 % -> video.volume=${p.player?.volume} muted=${p.player?.muted}`)
    await $('twitch-mute').click()
    await page.waitForTimeout(800)
    p = await probe()
    notes.push(`sourdine -> muted=${p.player?.muted}`)
    await $('twitch-mute').click()
    await page.waitForTimeout(500)
  })
  await step('volume changé dans le lecteur', async () => {
    const hasVideo = await inGuest('player', `!!document.querySelector('video')`)
    if (hasVideo !== true) {
      notes.push(`pas de <video> dans le lecteur (${hasVideo}) : synchronisation non vérifiée`)
      return
    }
    // geste dans le lecteur puis nouveau volume : le curseur de l'app suit
    await inGuest('player', `document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.querySelector('video').volume = 0.31; true`)
    await page.waitForTimeout(800)
    expect((await $('twitch-volume').inputValue()) === '31', `curseur de l'app suit le lecteur (lu : ${await $('twitch-volume').inputValue()})`)
    // changement sans geste (le lecteur reprend son réglage) : annulé
    await inGuest('player', `window.__cdInput = 0; document.querySelector('video').volume = 0.9; true`)
    await page.waitForTimeout(800)
    let p = await probe()
    expect(Math.abs((p.player?.volume ?? 0) - 0.31) < 0.01, `volume sans geste remis au réglage de l'app (video.volume=${p.player?.volume})`)
    // page du lecteur rechargée : le réglage est renvoyé
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().startsWith('https://player.twitch.tv/'))?.reload())
    await page.waitForTimeout(12000)
    p = await probe()
    expect(Math.abs((p.player?.volume ?? 0) - 0.31) < 0.01, `volume gardé après rechargement du lecteur (video.volume=${p.player?.volume})`)
  })
  await step('connexion demandée dans le chat ou le lecteur', async () => {
    const login = (await $('twitch-theater').getAttribute('data-channel'))?.toLowerCase()
    await inGuest('chat', `window.open('https://www.twitch.tv/login?popup=true'); true`)
    await inGuest('player', `window.open('https://passport.twitch.tv/sessions/new'); true`)
    await page.waitForTimeout(600)
    const o = await opened()
    expect(o.includes(`https://www.twitch.tv/popout/${login}/chat`), 'connexion du chat -> chat de la chaîne sur twitch.tv')
    expect(o.includes(`https://www.twitch.tv/${login}`), 'connexion du lecteur -> chaîne sur twitch.tv')
    expect(!o.some((u) => /\/login|passport/.test(u)), 'aucune page de connexion ouverte')
    await $('twitch-chat-write').click()
    await page.waitForTimeout(300)
  })
  await step('salle sans chat', async () => {
    await $('twitch-chat-toggle').click()
    await page.waitForTimeout(1500)
    notes.push(`chat présent après bascule : ${await $('twitch-chat').count()}`)
    await nativeShot('05-theater-nochat-1440')
  })
  await step('ouvrir sur Twitch', async () => {
    await $('twitch-open').click()
    await page.waitForTimeout(300)
    notes.push(`liens ouverts : ${JSON.stringify(await opened())}`)
  })
  await step('Échap ferme', async () => {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    notes.push(`salle fermée par Échap : ${(await $('twitch-theater').count()) === 0}, page du jeu toujours là : ${(await $('game-detail').count()) === 1}`)
  })
  await step('petite fenêtre', async () => {
    await size(1000, 700)
    await page.waitForTimeout(1200)
    await page.evaluate(() => document.querySelector('[data-testid="twitch-section"]')?.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(1200)
    await shot('06-section-1000')
    // préférence du chat gardée (masqué plus haut) : on la réactive pour la capture
    await $('twitch-card').nth(1).click()
    await $('twitch-theater').waitFor()
    await page.waitForTimeout(9000)
    await nativeShot('07-theater-nochat-1000')
    await $('twitch-chat-toggle').click()
    await page.waitForTimeout(8000)
    const p = await probe()
    notes.push(`lecteur 1000 px : ${JSON.stringify(p.player)}`)
    await nativeShot('08-theater-chat-1000')
    // Échap avec le clavier dans le lecteur : renvoyé par le processus principal
    notes.push(`Échap envoyé dans le lecteur : ${await escapeInPlayer()}`)
    await page.waitForTimeout(800)
    notes.push(`Échap depuis le lecteur ferme la salle : ${(await $('twitch-theater').count()) === 0}`)
  })
  await step('réglages', async () => {
    await size(1440, 880)
    await page.waitForTimeout(600)
    await $('nav-settings').click()
    await page.waitForTimeout(900)
    await $('settings-twitch').scrollIntoViewIfNeeded()
    await shot('09-settings-signed-in')
    await page.keyboard.press('Escape')
  })
} else if (mode === 'signedout') {
  await step('page du jeu', () => openGame())
  await step('pas connecté', async () => {
    await $('twitch-signin').waitFor()
    await shot('10-signed-out-1440')
  })
  await step('fenêtre du code', async () => {
    await $('twitch-signin').click()
    await $('twitch-code').waitFor()
    await page.waitForTimeout(700)
    notes.push(`code affiché : ${await $('twitch-code').textContent()}`)
    await shot('11-signin-dialog-1440')
    await $('twitch-open-activate').click()
    await page.waitForTimeout(300)
    notes.push(`liens ouverts : ${JSON.stringify(await opened())}`)
    await size(1000, 700)
    await page.waitForTimeout(900)
    await shot('12-signin-dialog-1000')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    notes.push(`fenêtre fermée par Échap : ${(await $('twitch-signin-dialog').count()) === 0}`)
  })
  await step('réglages', async () => {
    await size(1440, 880)
    await $('nav-settings').click()
    await page.waitForTimeout(900)
    await $('settings-twitch').scrollIntoViewIfNeeded()
    await shot('13-settings-signed-out')
    await page.keyboard.press('Escape')
  })
} else if (mode === 'noconfig') {
  await step('page du jeu', () => openGame())
  await step('non configuré', async () => {
    await $('twitch-not-configured').waitFor()
    await shot('14-not-configured-1440')
    await size(1000, 700)
    await page.waitForTimeout(900)
    await page.evaluate(() => document.querySelector('[data-testid="twitch-section"]')?.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(500)
    await shot('15-not-configured-1000')
  })
} else if (mode === 'mockapi') {
  // textes attendus, en anglais ou en français (langue du profil)
  const T = {
    cantEncrypt: /trousseau|keyring/,
    offline: /ne répond pas|isn’t responding/,
    rate: /trop de demandes|too many requests/,
    scope: /chaînes que vous suivez|channels you follow/
  }
  await step('chiffrement impossible : raison sur la page du jeu', async () => {
    await app.evaluate(({ safeStorage }) => {
      globalThis.__realEnc = safeStorage.isEncryptionAvailable
      safeStorage.isEncryptionAvailable = () => false
    })
    await openGame()
    await $('twitch-signin').waitFor()
    expect(await $('twitch-signin').isDisabled(), 'bouton de connexion grisé sans chiffrement')
    expect(T.cantEncrypt.test(await textOf('twitch-signed-out-hint')), `raison donnée sur la page (« ${await textOf('twitch-signed-out-hint')} »)`)
    await shot('18-mockapi-no-keyring')
    await app.evaluate(({ safeStorage }) => (safeStorage.isEncryptionAvailable = globalThis.__realEnc))
  })
  await step('connexion complète, profil illisible juste après l’accord', async () => {
    await mock({ usersFail: true })
    await openGame()
    await $('twitch-signin').click()
    await $('twitch-code').waitFor()
    notes.push(`code : ${await $('twitch-code').textContent()}`)
    await $('twitch-me').waitFor({ timeout: 20000 })
    expect((await $('twitch-signin-dialog').count()) === 0, 'fenêtre du code fermée malgré le profil illisible')
    expect((await textOf('twitch-me')).includes('mockuser'), `compte affiché par le repli /validate (« ${await textOf('twitch-me')} »)`)
    await mock({ usersFail: false })
    await $('twitch-card').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(1500)
    notes.push(`connecté, cartes : ${await $('twitch-card').count()}`)
    notes.push(`catégorie : ${await page.locator('.tw-cat .nm').textContent()}`)
    const s = saved()
    expect(typeof s.tokens === 'string' && !s.tokens.includes('mock-access'), 'jetons chiffrés dans twitch.json')
    notes.push(`twitch.json : utilisateur=${s.user?.login}, catégorie gardée=${s.categories[gameId]?.category?.name}`)
    await shot('17-mockapi-signed-in')
  })
  await step('langues, tri et « Afficher plus »', async () => {
    const langs = await $('twitch-language').locator('option').allTextContents()
    expect(langs.length > 30, `toutes les langues de Twitch proposées (${langs.length > 30 ? 'oui' : langs.join(', ')})`)
    expect((await $('twitch-sort').locator('option').count()) === 2, 'tri : deux choix, sans « Chaînes suivies »')
    await $('twitch-language').selectOption('')
    await page.waitForTimeout(1500)
    const before = await $('twitch-card').count()
    await $('twitch-more').click()
    await page.waitForTimeout(1500)
    const after = await $('twitch-card').count()
    expect(after > before, `« Afficher plus » lit la page suivante (${before} -> ${after})`)
  })
  await step('« Plus récents » sur plusieurs pages', async () => {
    const callsBefore = (await twitchCalls()).length
    await $('twitch-sort').selectOption('recent')
    await page.waitForTimeout(3000)
    const calls = (await twitchCalls()).slice(callsBefore).filter((c) => c.includes('/helix/streams?'))
    const newest = [...demo.streams].sort((a, b) => b.startedAt - a.startedAt)[0].userLogin
    const first = await $('twitch-card').first().getAttribute('data-channel')
    expect(first === newest, `premier stream = le plus récent de toutes les pages (${first} / ${newest})`)
    // pages déjà lues (« Afficher plus ») servies par le cache : seule la dernière est demandée
    expect(calls.length >= 1, `pages suivantes lues d'un coup pour trier (${calls.length})`)
    expect((await $('twitch-recent-note').count()) === 0, 'pas de mention « parmi les plus regardés » quand tout est lu')
  })
  await step('filtre « Chaînes suivies » séparé du tri', async () => {
    await $('twitch-followed').click()
    await page.waitForTimeout(2000)
    expect((await $('twitch-followed').getAttribute('aria-pressed')) === 'true', 'filtre allumé')
    expect((await $('twitch-sort').inputValue()) === 'recent', 'tri « Plus récents » gardé avec le filtre')
    const n = await $('twitch-card').count()
    expect(n > 0 && n <= Math.ceil(demo.streams.length / 3), `seulement les chaînes suivies (${n})`)
    await shot('19-mockapi-followed-recent')
  })
  await step('droit manquant pour les chaînes suivies', async () => {
    await $('twitch-followed').click()
    await page.waitForTimeout(800)
    await mock({ missingScope: true })
    const callsBefore = (await twitchCalls()).length
    await $('twitch-followed').click()
    await page.waitForTimeout(600)
    // la liste des chaînes suivies est en cache (60 s) : relue pour de bon
    await $('twitch-refresh').click()
    await $('twitch-error').waitFor()
    expect(T.scope.test(await textOf('twitch-error')), `message « droit manquant » (« ${await textOf('twitch-error')} »)`)
    const calls = (await twitchCalls()).slice(callsBefore)
    expect(!calls.some((c) => c.includes('refresh_token')), 'pas de rafraîchissement inutile du jeton')
    await mock({ missingScope: false })
    await $('twitch-followed').click()
    await $('twitch-sort').selectOption('viewers')
    await page.waitForTimeout(1000)
  })
  await step('aucune catégorie : le choix s’ouvre et se ferme', async () => {
    await openGame(idOf('SuperTuxKart'))
    await $('twitch-category-picker').waitFor()
    expect((await $('twitch-no-category').count()) === 1, 'texte « aucune catégorie »')
    await $('twitch-category-picker').locator('button[aria-label]').last().click()
    await page.waitForTimeout(400)
    expect((await $('twitch-category-picker').count()) === 0, 'choix de catégorie fermé par X')
    await shot('20-mockapi-no-category')
  })
  await step('hors ligne à la première visite', async () => {
    const id = idOf('Celeste')
    await mock({ offline: true })
    await openGame(id)
    await $('twitch-error').waitFor()
    expect(T.offline.test(await textOf('twitch-error')), `message « hors ligne » (« ${await textOf('twitch-error')} »)`)
    expect((await $('twitch-category-picker').count()) === 0, 'pas de choix de catégorie ouvert')
    expect(!saved().categories[id], 'rien de gardé pour ce jeu')
    await mock({ offline: false })
    await shot('21-mockapi-offline')
  })
  await step('limite d’appels (429)', async () => {
    const id = idOf('Hades')
    await mock({ rate429: true })
    await openGame(id)
    await $('twitch-error').waitFor()
    expect(T.rate.test(await textOf('twitch-error')), `message « limite d'appels » (« ${await textOf('twitch-error')} »)`)
    expect(!saved().categories[id], 'pas de faux « introuvable » gardé')
    await mock({ rate429: false })
  })
  await step('jeton expiré et réseau absent (sortie de veille)', async () => {
    await openGame()
    await $('twitch-card').first().waitFor()
    // jeton révoqué côté serveur : un 401, un rafraîchissement, puis un jeton de 2 s
    await mock({ valid: 'revoked', tokenTtl: 2 })
    await $('twitch-refresh').click()
    await page.waitForTimeout(2500)
    await page.waitForTimeout(1500)
    await mock({ offline: true })
    await $('twitch-refresh').click()
    await $('twitch-error').waitFor()
    const txt = await textOf('twitch-error')
    expect(T.offline.test(txt) && !txt.includes('401'), `« hors ligne » et pas « HTTP 401 » (« ${txt} »)`)
    expect(typeof saved().tokens === 'string', 'session gardée (pas de déconnexion faute de réseau)')
    await mock({ offline: false, tokenTtl: 14400 })
    await page.locator('[data-testid="twitch-error"] button').click()
    await $('twitch-card').first().waitFor({ timeout: 15000 })
    expect(true, 'streams revenus avec le réseau')
  })
  await step('déconnexion depuis la page du jeu', async () => {
    await $('twitch-section-signout').click()
    await $('twitch-signin').waitFor()
    const s = saved()
    expect(s.tokens === null && s.user === null, 'jetons et compte effacés')
    expect((await twitchCalls()).some((c) => c.startsWith('POST /oauth2/revoke')), 'jeton révoqué chez Twitch')
  })
  notes.push(`appels à Twitch :\n    ${(await twitchCalls()).join('\n    ')}`)
} else if (mode === 'badclient') {
  await step('page du jeu', () => openGame())
  await step('vraie demande refusée', async () => {
    await $('twitch-signin').click()
    await page.waitForTimeout(5000)
    notes.push(`texte de la fenêtre : ${(await $('twitch-signin-dialog').textContent())?.slice(0, 200)}`)
    await shot('16-signin-error')
    await page.keyboard.press('Escape')
  })
}

await page.evaluate(() => window.close()).catch(() => {})
await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
try {
  fs.rmSync(demoFile, { force: true })
} catch {
  // rien
}
log('NOTES :\n- ' + notes.join('\n- '))
log(problems.length ? 'PROBLÈMES :\n- ' + problems.join('\n- ') : 'aucun problème')
process.exit(problems.length ? 1 : 0)
