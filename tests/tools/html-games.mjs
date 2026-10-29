// Test de bout en bout des jeux web (HTML) dans l'app Electron : choix d'un dossier ou d'un fichier,
// ajout, lancement dans une fenêtre protégée, ce que la page peut et ne peut pas faire (Node,
// fichiers hors de son dossier, réseau, permissions, liens, navigation, titre), taille de la
// fenêtre, Arrêter, sauvegardes (gardées, isolées, effacées), retrait et désinstallation, fermeture
// de l'app. Un jeu de démonstration est créé dans un dossier temporaire.
// Usage : npm run build, puis node tests/tools/html-games.mjs [dossier-out] [nouveau-dossier-temp]
//   (par défaut : out et un dossier temporaire neuf, retiré à la fin si tout va bien).
// Ne touche jamais aux vrais profils (%APPDATA%\CyberDeck, CyberTorrent, Essaim) : profil temporaire,
// shell.openExternal / openPath / showItemInFolder et les fenêtres de choix remplacés.
// Code de sortie 1 au moindre échec.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const IS_WIN = process.platform === 'win32'
const [outArg = 'out', tmpArg] = process.argv.slice(2)
const outDir = path.resolve(ROOT, outArg)
const tmp = tmpArg ? path.resolve(tmpArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'cd-html-games-'))
fs.mkdirSync(tmp, { recursive: true })
const profile = path.join(tmp, 'profile')
const fx = path.join(tmp, 'fixture')

// ---------- Garde-fous ----------
const realTmp = fs.realpathSync.native(os.tmpdir())
const inTmp = (p) => fs.realpathSync.native(p).toLowerCase().startsWith(realTmp.toLowerCase() + path.sep)
if (!inTmp(tmp) || /^(cyberdeck|cybertorrent|essaim)$/i.test(path.basename(profile))) {
  console.log(`FAIL profil de test hors du dossier temporaire : ${profile}`)
  process.exit(1)
}
const appData = process.env.APPDATA || path.join(os.homedir(), '.config')
const REAL = ['CyberDeck', 'CyberTorrent', 'Essaim'].map((n) => path.join(appData, n))
const stamp = () => REAL.map((d) => (fs.existsSync(d) ? fs.statSync(d).mtimeMs : 0))
const realBefore = stamp()

let failed = 0
let passed = 0
const check = (name, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ' : ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}

/** PNG uni de w × h pixels (pour l'icône et la jaquette posées dans le dossier du jeu). */
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from(rgb))])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ---------- Jeu de démonstration ----------
const tiny = path.join(fx, 'Tiny Game #1')
const gameB = path.join(fx, 'Game B')
const empty = path.join(fx, 'Empty')
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Tiny Fixture Game</title><link rel=icon href=icon.png></head>
<body><p>Tiny</p>
<script>
window.__ready = true
window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = 'wait'; return 'wait' }
window.addEventListener('pagehide', () => { try { localStorage.setItem('bye', '1') } catch {} })
</script></body></html>`
write(path.join(fx, 'secret.txt'), 'TOP-SECRET-OUTSIDE')
write(path.join(fx, 'page.txt'), 'not a game')
fs.mkdirSync(empty, { recursive: true })
write(path.join(gameB, 'index.html'), '<!doctype html><title>Game B</title><script>window.__ready = true</script>')
write(path.join(gameB, 'cover.png'), png(256, 256, [40, 90, 200]))
const gameC = path.join(fx, 'Game C')
write(path.join(gameC, 'index.html'), '<!doctype html><title>Game C</title>')
write(path.join(tiny, 'index.html'), PAGE)
write(path.join(tiny, 'icon.png'), png(64, 64, [220, 40, 40]))
write(path.join(tiny, 'cover.png'), png(256, 300, [20, 160, 80]))
write(path.join(tiny, 'data', 'asset.json'), '{"asset":"ok"}')
write(path.join(tiny, 'Build', 't.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
write(path.join(tiny, 'Build', 'blob.data.gz'), zlib.gzipSync('HELLO-GZ'))
write(path.join(tiny, 'Build', 'app.framework.js.br'), zlib.brotliCompressSync('window.__br = 1'))
write(path.join(tiny, 'media.bin'), Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 251)))
write(path.join(tiny, 'données été.json'), '{"accent":"été"}')
fs.symlinkSync(fx, path.join(tiny, 'escape'), IS_WIN ? 'junction' : 'dir')

// ancien jeu local d'avant les jeux web (sans champ html), jamais lancé par le test
const OLD_ID = '11111111-2222-3333-4444-555555555555'
fs.mkdirSync(profile, { recursive: true })
write(
  path.join(profile, 'library.json'),
  JSON.stringify({
    version: 2,
    games: [{ id: OLD_ID, name: 'Old Game', exePath: path.join(fx, 'nowhere', 'old.exe'), args: null, installDir: path.join(fx, 'nowhere'), torrentId: null, coverVersion: 0, coverShape: null, iconVersion: 0, steamAppId: 0, addedAt: 1, lastPlayedAt: null, playTimeSeconds: 5 }],
    hidden: []
  })
)
write(path.join(profile, 'settings.json'), JSON.stringify({ defaultSavePath: tmp, port: 34567, torrentsEnabled: false, gamesFolder: null, checkUpdates: false, language: 'en' }))

const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
const electronBin = IS_WIN ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
const logFile = path.join(profile, 'cyberdeck.log')
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')

let app
let page

/** Lance l'app sur le profil temporaire, avec les remplacements de shell et des fenêtres de choix. */
async function launch() {
  app = await _electron.launch({
    executablePath: electronBin,
    args: [path.join(outDir, 'main', 'index.js')],
    env: { ...process.env, CYBERDECK_USER_DATA: profile, CYBERDECK_TEST_QUIET: '1', CYBERDECK_TEST_NO_PLATFORMS: '1' }
  })
  await app.evaluate(({ shell, dialog }) => {
    globalThis.__opened = []
    globalThis.__paths = []
    globalThis.__boxes = []
    globalThis.__openQueue = []
    shell.openExternal = async (url) => {
      globalThis.__opened.push(String(url))
    }
    shell.openPath = async (p) => {
      globalThis.__paths.push(String(p))
      return ''
    }
    shell.showItemInFolder = (p) => {
      globalThis.__paths.push(String(p))
    }
    dialog.showOpenDialog = async () => globalThis.__openQueue.shift() ?? { canceled: true, filePaths: [] }
    dialog.showSaveDialog = async () => ({ canceled: true })
    dialog.showMessageBox = async (...a) => {
      globalThis.__boxes.push(JSON.stringify(a.at(-1)?.title ?? ''))
      return { response: 1, checkboxChecked: false }
    }
  })
  page = await app.firstWindow()
  await page.waitForFunction(() => !!window.essaim, null, { timeout: 30_000 })
  await page.evaluate(() => {
    window.__notices = []
    window.essaim.onNotice((n) => window.__notices.push(n))
  })
}

const api = (fn, arg) => page.evaluate(fn, arg)
const library = () => api(() => window.essaim.getLibrary())
const notices = () => api(() => window.__notices)
const opened = () => app.evaluate(() => globalThis.__opened)
const queueOpen = (filePaths) => app.evaluate((_e, f) => globalThis.__openQueue.push({ canceled: false, filePaths: f }), filePaths)
const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)
/** URL de la fenêtre du jeu (null : aucune). */
const gameUrl = () =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('cdgame:'))?.webContents.getURL() ?? null)
/** Code exécuté dans la page du jeu (résultat sérialisable). */
const gameEval = (code) =>
  app.evaluate(async ({ BrowserWindow }, c) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith('cdgame:'))
    if (!w) throw new Error('pas de fenêtre de jeu')
    return w.webContents.executeJavaScript(c, true)
  }, code)
const gameWin = (fn) =>
  app.evaluate(({ BrowserWindow }, f) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith('cdgame:'))
    // eslint-disable-next-line no-new-func
    return w ? new Function('w', `return (${f})(w)`)(w) : null
  }, String(fn))

async function waitFor(fn, ms = 10_000, what = '') {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${what}`)
    await sleep(100)
  }
}
/** Lance un jeu et attend sa page prête. */
async function play(id) {
  await api((i) => window.essaim.playGame(i), id)
  await waitFor(async () => (await library()).running[id] !== undefined && (await gameUrl()), 10_000, 'fenêtre du jeu')
  await waitFor(() => gameEval('window.__ready === true'), 10_000, 'page du jeu prête')
}
/** Arrête un jeu web (bouton du processus principal) et attend la fin de la session. */
async function stop(id) {
  await api((i) => window.essaim.stopGame(i), id)
  await waitFor(async () => (await library()).running[id] === undefined && !(await gameUrl()), 10_000, 'fin de la session')
}
const add = (input) =>
  api(async (i) => {
    try {
      return { game: await window.essaim.addGame(i) }
    } catch (e) {
      return { error: String(e.message) }
    }
  }, input)

let keepTmp = false
try {
  await launch()

  // ---------- 1. Migration ----------
  let lib = await library()
  const old = lib.games.find((g) => g.id === OLD_ID)
  check('1. ancien jeu : html === null', old && old.html === null, JSON.stringify(old?.html))

  // ---------- 2. Choix d'un dossier ou d'un fichier ----------
  await queueOpen([tiny])
  const pick = await api(() => window.essaim.pickGameFolder())
  check(
    '2. dossier Tiny Game : page web, nom du <title>, dossier du jeu',
    pick && pick.html === true && pick.name === 'Tiny Fixture Game' && path.basename(pick.path) === 'index.html' && pick.installDir === tiny,
    JSON.stringify(pick)
  )
  await queueOpen([empty])
  const emptyPick = await api(() =>
    window.essaim.pickGameFolder().then(
      (v) => ({ v }),
      (e) => ({ error: String(e.message) })
    )
  )
  check('2. dossier vide : refusé (folderNoGame)', !!emptyPick.error && /No game found in this folder/.test(emptyPick.error), JSON.stringify(emptyPick))
  await queueOpen([path.join(tiny, 'index.html')])
  const filePick = await api(() => window.essaim.pickGameFile())
  check('2. fichier .html choisi : nom calculé', filePick?.html === true && filePick.name === 'Tiny Fixture Game', JSON.stringify(filePick))
  if (IS_WIN) {
    const txt = await add({ name: 'X', exePath: path.join(fx, 'page.txt') })
    check('2. fichier .txt : erreur chooseExe', /\.exe program or an \.html page/.test(txt.error ?? ''), JSON.stringify(txt))
  }

  // ---------- 3. Ajout ----------
  const refusedHome = await add({ name: '', exePath: path.join(tiny, 'index.html'), installDir: os.homedir() })
  check('3. dossier personnel refusé', /can’t be given access/.test(refusedHome.error ?? '') || (!refusedHome.error && false), JSON.stringify(refusedHome))
  const refusedTmp = await add({ name: '', exePath: path.join(tiny, 'index.html'), installDir: tmp })
  check('3. dossier qui contient le profil refusé', /can’t be given access/.test(refusedTmp.error ?? ''), JSON.stringify(refusedTmp))
  const added = await add({ name: '', exePath: path.join(tiny, 'index.html'), installDir: tiny })
  let g = added.game
  check('3. ajouté : nom du <title>', g?.name === 'Tiny Fixture Game', JSON.stringify(added))
  check('3. clé sur 32 caractères, Internet coupé', /^[a-f0-9]{32}$/.test(g?.html?.key ?? '') && g.html.network === false && g.args === null, JSON.stringify(g?.html))
  const id = g.id
  const key = g.html.key
  await waitFor(async () => (await library()).games.find((x) => x.id === id)?.iconVersion > 0, 10_000, 'icône').catch(() => null)
  lib = await library()
  g = lib.games.find((x) => x.id === id)
  check('3. icône lue dans le dossier (iconVersion > 0)', g.iconVersion > 0, String(g.iconVersion))
  await waitFor(async () => (await library()).games.find((x) => x.id === id)?.coverVersion > 0, 10_000, 'jaquette').catch(() => null)
  g = (await library()).games.find((x) => x.id === id)
  check('3. jaquette lue dans le dossier', g.coverVersion > 0 && g.coverShape === 'portrait', `${g.coverVersion} ${g.coverShape}`)

  // ---------- 4. Lancement ----------
  const winsBefore = await windowCount()
  const t0 = Date.now()
  await play(id)
  check('4. adresse exacte de la page', (await gameUrl()) === 'cdgame://game/index.html', await gameUrl())
  check('4. session en cours', (await library()).running[id] !== undefined)
  const winsGame = await windowCount()
  await api((i) => window.essaim.playGame(i), id)
  await sleep(1500)
  check('4. second Jouer : aucune nouvelle fenêtre', (await windowCount()) === winsGame && winsGame === winsBefore + 1, `${winsBefore} ${winsGame}`)

  // ---------- 5. Dans la page du jeu ----------
  const r = await gameEval(`(async () => {
    const out = {}
    const safe = async (f) => { try { return await f() } catch (e) { return 'ERR:' + (e && e.name) } }
    out.node = typeof require === 'undefined' && typeof process === 'undefined' && window.essaim === undefined
    out.ua = navigator.userAgent
    out.coi = crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'
    out.json = await safe(() => fetch('data/asset.json').then((x) => x.json()).then((j) => j.asset))
    out.abs = await safe(() => fetch('/data/asset.json').then((x) => x.json()).then((j) => j.asset))
    out.wasm = await safe(() => WebAssembly.instantiateStreaming(fetch('Build/t.wasm')).then((m) => !!m.instance))
    out.gz = await safe(() => fetch('Build/blob.data.gz').then((x) => x.text()))
    out.br = await safe(() => new Promise((res) => { const s = document.createElement('script'); s.src = 'Build/app.framework.js.br'; s.onload = () => res(window.__br === 1); s.onerror = () => res(false); document.head.appendChild(s) }))
    out.range = await safe(async () => { const x = await fetch('media.bin', { headers: { Range: 'bytes=10-19' } }); const b = new Uint8Array(await x.arrayBuffer()); return x.status + ':' + Array.from(b).join(',') })
    out.accent = await safe(() => fetch(encodeURIComponent('données été.json')).then((x) => x.json()).then((j) => j.accent))
    const tries = ['../secret.txt', '%2e%2e/secret.txt', '..%2fsecret.txt', '..%5csecret.txt', 'C%3A%5CWindows%5Cwin.ini', '%00', 'escape/secret.txt', 'essaim://cover/x', ${JSON.stringify(pathToFileURL(path.join(fx, 'secret.txt')).href)}, 'cdgame://autre/index.html']
    out.escapes = []
    for (const p of tries) out.escapes.push(p + ' => ' + (await safe(async () => { const x = await fetch(p); return x.status + ':' + (await x.text()).slice(0, 40) })))
    out.https = await safe(() => fetch('https://cyberdeck-test.invalid/').then((x) => 'OK' + x.status))
    out.wss = await new Promise((res) => { try { const w = new WebSocket('wss://cyberdeck-test.invalid/'); w.onerror = () => res('error'); w.onopen = () => res('open'); setTimeout(() => res('timeout'), 5000) } catch (e) { res('throw') } })
    out.http = await safe(() => fetch('http://127.0.0.1:9/').then((x) => 'OK' + x.status))
    out.notif = await safe(() => Notification.requestPermission())
    out.geo = await safe(() => navigator.permissions.query({ name: 'geolocation' }).then((p) => p.state))
    out.media = await safe(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted'))
    out.clip = await safe(() => navigator.clipboard.readText().then(() => 'read'))
    out.persist = await safe(() => navigator.storage.persist())
    localStorage.setItem('save', '42')
    out.idb = await safe(() => new Promise((res, rej) => { const q = indexedDB.open('fx', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onerror = () => rej(q.error); q.onsuccess = () => { const t = q.result.transaction('s', 'readwrite'); t.objectStore('s').put('idb-value', 'k'); t.oncomplete = () => { q.result.close(); res('written') }; t.onerror = () => rej(t.error) } }))
    return out
  })()`)
  check('5. ni require, ni process, ni window.essaim', r.node === true)
  check('5. agent sans Electron ni CyberDeck', !/electron|cyberdeck/i.test(r.ua), r.ua)
  check('5. crossOriginIsolated et SharedArrayBuffer', r.coi === true)
  check('5. JSON relatif et absolu', r.json === 'ok' && r.abs === 'ok', `${r.json} ${r.abs}`)
  check('5. WebAssembly.instantiateStreaming', r.wasm === true, String(r.wasm))
  check('5. .data.gz décompressé', r.gz === 'HELLO-GZ', String(r.gz))
  check('5. .js.br exécuté', r.br === true, String(r.br))
  check('5. Range 206 et bons octets', r.range === '206:10,11,12,13,14,15,16,17,18,19', String(r.range))
  check('5. fichier accentué servi', r.accent === 'été', String(r.accent))
  const leaks = r.escapes.filter((e) => / => 200:|TOP-SECRET/.test(e))
  check('5. aucune sortie du dossier du jeu', leaks.length === 0, JSON.stringify(r.escapes))
  check('5. https et wss coupés', String(r.https).startsWith('ERR') && r.wss === 'error', `${r.https} ${r.wss}`)
  check('5. http refusé', String(r.http).startsWith('ERR'), String(r.http))
  check('5. notifications et position refusées', r.notif === 'denied' && r.geo === 'denied', `${r.notif} ${r.geo}`)
  check('5. micro et lecture du presse-papiers refusés', String(r.media).startsWith('ERR') && String(r.clip).startsWith('ERR'), `${r.media} ${r.clip}`)
  check('5. stockage persistant accordé', r.persist === true, String(r.persist))
  check('5. IndexedDB écrite', r.idb === 'written', String(r.idb))
  await sleep(300)
  let logText = readLog()
  check('5. blocages « offline » notés', /requête bloquée \(offline\) https:\/\/cyberdeck-test\.invalid/.test(logText) && /requête bloquée \(offline\) wss:\/\/cyberdeck-test\.invalid/.test(logText))
  check('5. blocage « scheme » noté', /requête bloquée \(scheme\) http:\/\/127\.0\.0\.1:9/.test(logText))
  const netNotices = (await notices()).filter((n) => /tried to use the internet/.test(n.message))
  check('5. message Internet coupé une seule fois', netNotices.length === 1, JSON.stringify(await notices()))

  // ---------- 6. Fenêtres et liens ----------
  const winsNow = await windowCount()
  const opener = await gameEval(`window.open('https://example.com/x') === null`)
  await sleep(300)
  check('6. window.open renvoie null', opener === true)
  check('6. rien ouvert (fenêtre du jeu inactive)', (await opened()).length === 0, JSON.stringify(await opened()))
  check('6. aucune fenêtre en plus', (await windowCount()) === winsNow)

  // ---------- 7. Navigation ----------
  await gameEval(`location.href = 'https://example.com/'; true`)
  await sleep(600)
  await gameEval(`location.href = ${JSON.stringify(IS_WIN ? 'file:///C:/' : 'file:///')}; true`).catch(() => null)
  await sleep(600)
  check('7. navigation empêchée', (await gameUrl()) === 'cdgame://game/index.html' && (await opened()).length === 0, await gameUrl())

  // ---------- 8. Titre ----------
  await gameEval(`document.title = 'Windows Security'; true`)
  await sleep(200)
  check('8. titre de la fenêtre inchangé', (await gameWin((w) => w.getTitle())) === 'Tiny Fixture Game', await gameWin((w) => w.getTitle()))

  // ---------- 9. Taille ----------
  // fenêtre de test hors écran (x = -20000) : Windows y compte le cadre dans la taille du contenu
  // (916 × 639 pour 900 × 600) ; on vérifie donc l'aller-retour de la taille relevée
  await gameWin((w) => w.setContentSize(900, 600))
  await sleep(800)
  const wanted = await gameWin((w) => w.getContentSize())

  // ---------- 10. Arrêter ----------
  const wait = 2600 - (Date.now() - t0)
  if (wait > 0) await sleep(wait)
  const stopBtn = page.locator('[data-testid="hero-stop"]')
  await stopBtn.waitFor({ state: 'visible', timeout: 5000 })
  check('10. bouton Arrêter visible (et Afficher)', (await stopBtn.isVisible()) && (await page.locator('[data-testid="hero-show"]').isVisible()))
  await stopBtn.click()
  await waitFor(async () => (await library()).running[id] === undefined && !(await gameUrl()), 10_000, 'fermeture après Arrêter')
  g = (await library()).games.find((x) => x.id === id)
  check('10. fenêtre fermée malgré beforeunload, temps compté', g.playTimeSeconds >= 2, String(g.playTimeSeconds))
  check('10. taille mémorisée', g.html.width === wanted[0] && g.html.height === wanted[1] && wanted[0] < 1000, `${JSON.stringify(g.html)} relevé ${JSON.stringify(wanted)}`)

  // ---------- 11. Relance ----------
  await play(id)
  const saved = await gameEval(`(async () => ({ save: localStorage.getItem('save'), bye: localStorage.getItem('bye'),
    idb: await new Promise((res) => { const q = indexedDB.open('fx', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => { const t = q.result.transaction('s'); const g = t.objectStore('s').get('k'); g.onsuccess = () => { q.result.close(); res(g.result ?? null) }; g.onerror = () => res('ERR') }; q.onerror = () => res('ERR') }) }))()`)
  check('11. sauvegarde gardée', saved.save === '42' && saved.idb === 'idb-value', JSON.stringify(saved))
  check('11. pagehide exécuté à la fermeture', saved.bye === '1', JSON.stringify(saved))
  const size = await gameWin((w) => w.getContentSize())
  check('11. taille rendue à la relance', size?.[0] === wanted[0] && size?.[1] === wanted[1], `${JSON.stringify(size)} attendu ${JSON.stringify(wanted)}`)
  check('11. partition dans le profil temporaire', fs.existsSync(path.join(profile, 'Partitions', `cdgame-${key}`)))
  await gameEval(`setTimeout(() => window.close(), 50); true`)
  await waitFor(async () => (await library()).running[id] === undefined && !(await gameUrl()), 10_000, 'window.close()')
  check('11. window.close() termine la session', true)

  // ---------- 12. Isolation ----------
  const b = (await add({ name: '', exePath: path.join(gameB, 'index.html'), installDir: gameB })).game
  check('12. Game B ajouté (autre clé)', b && b.html && b.html.key !== key, JSON.stringify(b?.html))
  await play(b.id)
  check('12. Game B ne voit pas la sauvegarde de Tiny', (await gameEval(`localStorage.getItem('save')`)) === null)
  const busyEdit = await api((a) => window.essaim.updateGame(a.id, { name: 'Game B', exePath: a.exe, installDir: a.dir }), {
    id: b.id,
    exe: path.join(gameC, 'index.html'),
    dir: gameC
  }).then(() => 'ok', (e) => String(e))
  check('12. autre page refusée pendant la partie', /Close Game B before changing its program or page/.test(busyEdit), busyEdit)
  await stop(b.id)
  // autre jeu (l'ancienne page existe encore) : nouvelle clé, les sauvegardes de B ne sont pas lues
  const toC = await api((a) => window.essaim.updateGame(a.id, { name: 'Game B', exePath: a.exe, installDir: a.dir }), {
    id: b.id,
    exe: path.join(gameC, 'index.html'),
    dir: gameC
  })
  check('12. autre jeu : nouvelle clé', toC?.html?.key && toC.html.key !== b.html.key && toC.html.key !== key, JSON.stringify(toC?.html))

  // ---------- 13. Internet autorisé ----------
  const upd = await api((a) => window.essaim.updateGame(a.id, { name: 'Tiny Fixture Game', exePath: a.exe, installDir: a.dir, htmlNetwork: true }), {
    id,
    exe: path.join(tiny, 'index.html'),
    dir: tiny
  })
  check('13. Internet autorisé, clé gardée', upd?.html?.network === true && upd.html.key === key, JSON.stringify(upd?.html))
  await play(id)
  const priv = await gameEval(`(async () => {
    const out = []
    for (const u of ['https://127.0.0.1:9/', 'https://localhost:9/', 'https://[::1]:9/', 'https://192.168.0.1:9/'])
      out.push(await fetch(u).then((x) => 'OK' + x.status, (e) => 'ERR'))
    return out
  })()`)
  await sleep(300)
  logText = readLog()
  const privLines = (logText.match(/requête bloquée \(private\)/g) ?? []).length
  check('13. réseau local refusé', priv.every((x) => x === 'ERR') && privLines >= 4, `${JSON.stringify(priv)} lignes=${privLines}`)
  await stop(id)
  await api((a) => window.essaim.updateGame(a.id, { name: 'Tiny Fixture Game', exePath: a.exe, installDir: a.dir, htmlNetwork: false }), {
    id,
    exe: path.join(tiny, 'index.html'),
    dir: tiny
  })
  check('13. Internet recoupé', (await library()).games.find((x) => x.id === id).html.network === false)

  // ---------- 14. Retrait en cours de jeu ----------
  await play(id)
  await api((i) => window.essaim.removeGame(i), id)
  await waitFor(async () => !(await gameUrl()), 10_000, 'fermeture au retrait')
  check('14. retrait : fenêtre fermée, partition gardée', !(await library()).games.some((x) => x.id === id) && fs.existsSync(path.join(profile, 'Partitions', `cdgame-${key}`)))
  const again = (await add({ name: '', exePath: path.join(tiny, 'index.html'), installDir: tiny })).game
  check('14. nouvel ajout : même clé', again?.html?.key === key, JSON.stringify(again?.html))
  const id2 = again.id
  await play(id2)
  check('14. sauvegarde retrouvée', (await gameEval(`localStorage.getItem('save')`)) === '42')

  // ---------- 15. Effacement ----------
  const during = await api((i) => window.essaim.clearGameSaves(i), id2)
  check('15. effacement refusé pendant la partie', during.ok === false && /Close Tiny Fixture Game before deleting its saves/.test(during.error ?? ''), JSON.stringify(during))
  await stop(id2)
  const cleared = await api((i) => window.essaim.clearGameSaves(i), id2)
  check('15. effacement après Arrêter', cleared.ok === true, JSON.stringify(cleared))
  await play(id2)
  check('15. sauvegarde effacée', (await gameEval(`localStorage.getItem('save')`)) === null)

  // ---------- 16. Désinstallation ----------
  await gameEval(`localStorage.setItem('save', '7'); true`)
  await stop(id2)
  // un .exe posé dans le dossier d'un jeu web n'est jamais lancé comme désinstalleur
  write(path.join(tiny, 'uninstall.exe'), 'MZ')
  const plan = await api((i) => window.essaim.uninstallPlan(i), id2)
  check('16. plan « dossier » (uninstall.exe du dossier ignoré)', plan.kind === 'folder', JSON.stringify(plan))
  const un = await api((i) => window.essaim.uninstallGame(i, true, true), id2)
  check('16. désinstallation avec les sauvegardes', un.ok === true && !(await library()).games.some((x) => x.id === id2), JSON.stringify(un))
  const third = (await add({ name: '', exePath: path.join(tiny, 'index.html'), installDir: tiny })).game
  await play(third.id)
  check('16. nouvel ajout : sauvegarde vide', (await gameEval(`localStorage.getItem('save')`)) === null)

  // ---------- 17. Fermeture de l'app ----------
  await gameEval(`localStorage.setItem('late', 'yes'); true`)
  await sleep(1200)
  const before = JSON.parse(fs.readFileSync(path.join(profile, 'library.json'), 'utf8')).games.find((x) => x.id === third.id)?.playTimeSeconds ?? 0
  const proc = app.process()
  const exited = new Promise((res) => proc.once('exit', () => res(true)))
  const tq = Date.now()
  await app.evaluate(({ app: a }) => a.quit()).catch(() => null)
  const ok17 = await Promise.race([exited, sleep(10_000).then(() => false)])
  check('17. app fermée en 10 s', ok17 === true, `${Date.now() - tq} ms`)
  const afterQuit = JSON.parse(fs.readFileSync(path.join(profile, 'library.json'), 'utf8')).games.find((x) => x.id === third.id)?.playTimeSeconds ?? 0
  check('17. temps de jeu enregistré', afterQuit > before || afterQuit >= 1, `${before} → ${afterQuit}`)
  await launch()
  await play(third.id)
  check('17. écriture forcée sur le disque (late)', (await gameEval(`localStorage.getItem('late')`)) === 'yes')
  await stop(third.id)

  // ---------- 1 (suite). L'ancien jeu n'a jamais été lancé ----------
  lib = await library()
  const oldAfter = lib.games.find((x) => x.id === OLD_ID)
  check('1. ancien jeu jamais lancé', oldAfter && oldAfter.lastPlayedAt === null && oldAfter.html === null, JSON.stringify(oldAfter && { l: oldAfter.lastPlayedAt, h: oldAfter.html }))
  check('aucune boîte « Quitter / Continuer » en mode test', (await app.evaluate(() => globalThis.__boxes)).length === 0)
  check('aucun lien ni protocole ouvert', (await opened()).length === 0, JSON.stringify(await opened()))
} catch (e) {
  failed++
  keepTmp = true
  console.log('FAIL exception : ' + (e?.stack ?? e))
} finally {
  await app?.close().catch(() => null)
}

// ---------- 18. Journal et vrais profils ----------
const logText = readLog()
check('18. ni « Lancement impossible » ni « Erreur imprévue »', !/Lancement impossible|Erreur imprévue/.test(logText), (logText.match(/.*(Lancement impossible|Erreur imprévue).*/g) ?? []).join('\n'))
const realAfter = stamp()
check('18. vrais profils intacts', realAfter.every((v, i) => v === realBefore[i]), JSON.stringify({ realBefore, realAfter }))
if (failed) {
  console.log(`\nJournal : ${logFile}`)
  keepTmp = true
}
if (!keepTmp && !tmpArg) fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} ok, ${failed} échec(s)`)
process.exit(failed ? 1 : 0)
