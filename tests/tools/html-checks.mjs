// Vérifications des jeux web (HTML) sans Electron : service des fichiers (cdgame://), analyse du
// dossier d'un jeu, garde-fous, règles réseau et verdict de butler (itch.io), sur de faux dossiers
// créés dans un dossier temporaire (retiré à la fin).
// Usage : node tests/tools/html-checks.mjs   (Windows ou Linux ; code de sortie 1 si un test échoue)
// Les modules TypeScript sont assemblés à la volée par rolldown (déjà installé avec vite).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const IS_WIN = process.platform === 'win32'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-html-checks-'))
let failed = 0
let passed = 0
const check = (name, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ' : ' + detail : ''}`)
}
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}

try {
  // ---------- Assemblage des modules ----------
  const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'rolldown', 'dist', 'index.mjs')).href).catch(() => import('rolldown'))
  const bundleDir = path.join(tmp, 'bundle')
  await build({
    input: {
      htmlFolder: path.join(ROOT, 'src', 'main', 'htmlFolder.ts'),
      htmlServe: path.join(ROOT, 'src', 'main', 'htmlServe.ts'),
      util: path.join(ROOT, 'src', 'main', 'platforms', 'util.ts')
    },
    platform: 'node',
    logLevel: 'silent',
    output: { dir: bundleDir, format: 'esm', entryFileNames: '[name].mjs' }
  })
  const imp = (n) => import(pathToFileURL(path.join(bundleDir, n + '.mjs')).href)
  const { findHtmlEntry, htmlGameName, rootRefusal, htmlKey, isInside, localArt } = await imp('htmlFolder')
  const { resolveGameFile, mimeFor, parseRange, serveGameRequest, isPrivateHost, requestVerdict, externalOpenAllowed, dangerousDownload, entryUrl } =
    await imp('htmlServe')
  const { verdictFiles } = await imp('util')

  // ---------- Dossier d'un jeu ----------
  const fx = path.join(tmp, 'fixture')
  write(path.join(fx, 'secret.txt'), 'TOP-SECRET-OUTSIDE')
  const game = path.join(fx, 'Game')
  write(path.join(game, 'index.html'), '<!doctype html><title>Tiny</title><p>ok</p>')
  write(path.join(game, 'sub', 'index.html'), '<p>sub</p>')
  write(path.join(game, 'données été.json'), '{"ok":true}')
  write(path.join(game, 'a b#c%d.txt'), 'odd')
  write(path.join(game, 'Data', 'Asset.json'), '{"case":1}')
  write(path.join(game, 'media.bin'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)))
  write(path.join(game, 'empty.bin'), Buffer.alloc(0))
  write(path.join(game, 'meta.html'), '<meta charset="windows-1252"><title>x</title>')
  write(path.join(game, 'Build', 'blob.data.gz'), zlib.gzipSync('HELLO-GZ'))
  write(path.join(game, 'Build', 'app.framework.js.br'), zlib.brotliCompressSync('window.__br = 1'))
  write(path.join(game, 'x.json.gz'), zlib.gzipSync('{"raw":1}'))
  const realGame = fs.realpathSync.native(game)
  let linked = true
  try {
    fs.symlinkSync(fx, path.join(game, 'escape'), IS_WIN ? 'junction' : 'dir')
  } catch (e) {
    linked = false
    console.log(`(lien escape impossible : ${e.message})`)
  }
  const ctx = (o = {}) => ({ isWin: IS_WIN, caseFallback: false, dirCache: new Map(), ...o })
  const res = (p, o) => resolveGameFile(realGame, p, ctx(o))

  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/..%5csecret.txt', '/C%3A%5CWindows%5Cwin.ini', '/%00', '/a%00b', '/sub//index.html', '/%E0%A4%A']) {
    const r = await res(p)
    check(`refusé : ${p}`, 'status' in r, JSON.stringify(r))
  }
  if (IS_WIN) {
    for (const p of ['/CON', '/nul.txt', '/index.html.', '/index.html%20', '/index.html::$DATA', '/COM1.log', '/a%3Ab']) {
      const r = await res(p, { isWin: true })
      check(`refusé (Windows) : ${p}`, 'status' in r && r.status === 400, JSON.stringify(r))
    }
  }
  if (linked) {
    const r = await res('/escape/secret.txt')
    check('lien escape vers le parent : 404', 'status' in r && r.status === 404, JSON.stringify(r))
  }
  let r = await res('/sub/')
  check('dossier/ : son index.html', r.file && r.file.endsWith(path.join('sub', 'index.html')), JSON.stringify(r))
  r = await res('/sub')
  check('dossier sans / final : 404', r.status === 404, JSON.stringify(r))
  r = await res('/')
  check('racine : index.html', r.file && path.basename(r.file) === 'index.html', JSON.stringify(r))
  r = await res('/' + encodeURIComponent('données été.json'))
  check('nom accentué servi', r.file && r.size > 0, JSON.stringify(r))
  r = await res('/' + encodeURIComponent('a b#c%d.txt'))
  check('nom avec espace, # et % servi', r.file && r.size === 3, JSON.stringify(r))
  if (!IS_WIN) {
    r = await res('/data/asset.json')
    check('Linux sans repli de casse : 404', r.status === 404, JSON.stringify(r))
    r = await res('/data/asset.json', { caseFallback: true })
    check('Linux avec repli de casse : trouvé', !!r.file, JSON.stringify(r))
  } else {
    r = await res('/data/asset.json')
    check('Windows : casse ignorée par le disque', !!r.file, JSON.stringify(r))
  }
  check('entryUrl encode les segments', entryUrl(path.join('www', 'my page#1.html')) === 'cdgame://game/www/my%20page%231.html', entryUrl(path.join('www', 'my page#1.html')))

  // ---------- Types ----------
  const mt = (f) => JSON.stringify(mimeFor(f))
  check('wasm', mimeFor('x.wasm').type === 'application/wasm' && mimeFor('x.wasm').decode === null, mt('x.wasm'))
  check('wasm.gz décompressé', mimeFor('x.wasm.gz').type === 'application/wasm' && mimeFor('x.wasm.gz').decode === 'gzip', mt('x.wasm.gz'))
  check('framework.js.br', mimeFor('x.framework.js.br').type.startsWith('text/javascript') && mimeFor('x.framework.js.br').decode === 'br', mt('x.framework.js.br'))
  check('data.gz', mimeFor('x.data.gz').type === 'application/octet-stream' && mimeFor('x.data.gz').decode === 'gzip', mt('x.data.gz'))
  check('unityweb brut', mimeFor('x.unityweb').type === 'application/octet-stream' && mimeFor('x.unityweb').decode === null, mt('x.unityweb'))
  check('pck brut', mimeFor('x.pck').type === 'application/octet-stream', mt('x.pck'))
  check('json.gz servi brut', mimeFor('x.json.gz').decode === null && mimeFor('x.json.gz').type === 'application/octet-stream', mt('x.json.gz'))
  check('opus', mimeFor('x.opus').type === 'audio/ogg', mt('x.opus'))

  // ---------- Plages ----------
  const pr = (h, s) => JSON.stringify(parseRange(h, s))
  check('bytes=0-9', pr('bytes=0-9', 100) === '{"start":0,"end":9}', pr('bytes=0-9', 100))
  check('bytes=5-', pr('bytes=5-', 100) === '{"start":5,"end":99}', pr('bytes=5-', 100))
  check('bytes=-4', pr('bytes=-4', 100) === '{"start":96,"end":99}', pr('bytes=-4', 100))
  check('plusieurs plages : null', parseRange('bytes=0-1,4-5', 100) === null)
  check('mal formé : null', parseRange('octets=1-2', 100) === null && parseRange('bytes=5-2', 100) === null)
  check('hors du fichier', parseRange('bytes=200-300', 100) === 'unsatisfiable')
  check('bytes=-0', parseRange('bytes=-0', 100) === 'unsatisfiable')
  check('fichier vide', parseRange('bytes=0-1', 0) === 'unsatisfiable' && parseRange('bytes=-3', 0) === 'unsatisfiable')
  check('bytes=0-999 tronqué', pr('bytes=90-999', 100) === '{"start":90,"end":99}')

  // ---------- Réponses ----------
  const sctx = { realRoot: realGame, ...ctx() }
  const get = (p, init) => serveGameRequest(new Request('cdgame://game' + p, init), sctx)
  const isolated = (resp) =>
    resp.headers.get('cross-origin-opener-policy') === 'same-origin' &&
    resp.headers.get('cross-origin-embedder-policy') === 'credentialless' &&
    resp.headers.get('cache-control') === 'no-cache'
  let resp = await get('/media.bin')
  let body = Buffer.from(await resp.arrayBuffer())
  check('200 avec Content-Length', resp.status === 200 && resp.headers.get('content-length') === '1000' && body.length === 1000 && isolated(resp))
  resp = await get('/media.bin', { headers: { Range: 'bytes=10-19' } })
  body = Buffer.from(await resp.arrayBuffer())
  check(
    '206 et les bons octets',
    resp.status === 206 && resp.headers.get('content-range') === 'bytes 10-19/1000' && body.length === 10 && body[0] === 10 && body[9] === 19,
    `${resp.status} ${resp.headers.get('content-range')} ${[...body]}`
  )
  resp = await get('/media.bin', { headers: { Range: 'bytes=5000-' } })
  check('416', resp.status === 416 && resp.headers.get('content-range') === 'bytes */1000' && isolated(resp))
  resp = await get('/media.bin', { method: 'HEAD' })
  check('HEAD sans corps', resp.status === 200 && resp.body === null && resp.headers.get('content-length') === '1000')
  resp = await get('/empty.bin')
  check('fichier vide : 200', resp.status === 200 && (await resp.arrayBuffer()).byteLength === 0)
  resp = await get('/Build/blob.data.gz', { headers: { Range: 'bytes=0-1' } })
  let text = await resp.text()
  check('.gz décompressé, Range ignoré', resp.status === 200 && text === 'HELLO-GZ' && !resp.headers.get('content-length') && !resp.headers.get('content-encoding'), `${resp.status} ${text}`)
  resp = await get('/Build/app.framework.js.br')
  text = await resp.text()
  check('.br décompressé', resp.status === 200 && text === 'window.__br = 1' && resp.headers.get('content-type').startsWith('text/javascript') && !resp.headers.get('accept-ranges'), text)
  resp = await get('/x.json.gz')
  body = Buffer.from(await resp.arrayBuffer())
  check('.json.gz servi brut', resp.status === 200 && body[0] === 0x1f && body[1] === 0x8b)
  resp = await get('/media.bin', { method: 'POST', body: 'x' })
  check('405 sur POST', resp.status === 405 && isolated(resp))
  resp = await serveGameRequest(new Request('cdgame://autre/index.html'), sctx)
  check('404 sur un autre hôte', resp.status === 404 && isolated(resp))
  resp = await get('/nope.txt')
  check('404 avec les en-têtes', resp.status === 404 && isolated(resp))
  resp = await get('/../secret.txt')
  check('chemin refusé avec les en-têtes', resp.status >= 400 && isolated(resp))
  resp = await get('/index.html')
  check('HTML sans charset : utf-8 imposé', resp.headers.get('content-type') === 'text/html; charset=utf-8', resp.headers.get('content-type'))
  check('CSP connect-src sans Internet', resp.headers.get('content-security-policy') === "connect-src 'self' cdgame: data: blob:", resp.headers.get('content-security-policy'))
  resp = await serveGameRequest(new Request('cdgame://game/index.html'), { ...sctx, network: () => true })
  check('CSP connect-src avec Internet', /https: wss:$/.test(resp.headers.get('content-security-policy') ?? ''), resp.headers.get('content-security-policy'))
  resp = await get('/media.bin')
  check('pas de CSP sur un fichier de données', resp.headers.get('content-security-policy') === null)
  resp = await get('/meta.html')
  check('HTML avec <meta charset> : la page décide', resp.headers.get('content-type') === 'text/html', resp.headers.get('content-type'))
  resp = await get('/index.html?x=1#frag')
  check('requête et ancre ignorées', resp.status === 200)

  // ---------- Page d'un dossier ----------
  const pick = (name, files) => {
    const d = path.join(tmp, 'pick', name)
    for (const [f, txt] of Object.entries(files)) write(path.join(d, f), txt)
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  let d = pick('root', { 'index.html': 'x', 'other.html': 'y' })
  check('index.html à la racine', findHtmlEntry(d) === path.join(d, 'index.html'))
  d = pick('htm', { 'index.htm': 'x' })
  check('index.htm', findHtmlEntry(d) === path.join(d, 'index.htm'))
  d = pick('rpg', { 'www/index.html': 'x', 'Game.exe': '' })
  check('www/index.html (RPG Maker)', findHtmlEntry(d) === path.join(d, 'www', 'index.html'))
  d = pick('onesub', { 'MyGame/index.html': 'x', '__MACOSX/index.html': 'x', '.git/index.html': 'x' })
  check('un seul sous-dossier', findHtmlEntry(d) === path.join(d, 'MyGame', 'index.html'), findHtmlEntry(d))
  d = pick('twosubs', { 'A/index.html': 'x', 'B/index.html': 'x' })
  check('deux sous-dossiers : null', findHtmlEntry(d) === null)
  d = pick('twine', { 'My Story.html': 'x', 'readme.html': 'x', 'LICENSE.htm': 'x' })
  check('page Twine unique, readme ignoré', findHtmlEntry(d) === path.join(d, 'My Story.html'), findHtmlEntry(d))
  d = pick('ambiguous', { 'a.html': 'x', 'b.html': 'y' })
  check('cas ambigu : null', findHtmlEntry(d) === null)
  d = pick('none', { 'notes.txt': 'x' })
  check('aucune page : null', findHtmlEntry(d) === null)

  // ---------- Nom du jeu ----------
  d = pick('Some Folder', { 'www/index.html': '<title>Ignored</title>', 'www/data/System.json': JSON.stringify({ gameTitle: 'Rpg Quest', title1Name: 'Castle' }) })
  check('gameTitle de System.json', htmlGameName(path.join(d, 'www', 'index.html'), d) === 'Rpg Quest', htmlGameName(path.join(d, 'www', 'index.html'), d))
  d = pick('Folder T', { 'index.html': '<html><head><title>  Space &amp; Time &#39;Quest&#x21;</title>' })
  check('<title> utile et entités', htmlGameName(path.join(d, 'index.html'), d) === "Space & Time 'Quest!", htmlGameName(path.join(d, 'index.html'), d))
  d = pick('Folder U', { 'index.html': '<title>Unity WebGL Player | Neon Run</title>' })
  check('préfixe Unity retiré', htmlGameName(path.join(d, 'index.html'), d) === 'Neon Run', htmlGameName(path.join(d, 'index.html'), d))
  d = pick('Cool Game', { 'index.html': '<title>Godot Engine</title>' })
  check('titre générique : nom du dossier', htmlGameName(path.join(d, 'index.html'), d) === 'Cool Game', htmlGameName(path.join(d, 'index.html'), d))
  d = pick('Parent Game', { 'www/index.html': '<title>index</title>' })
  check('dossier www remplacé par le parent', htmlGameName(path.join(d, 'www', 'index.html'), d) === 'Parent Game', htmlGameName(path.join(d, 'www', 'index.html'), d))
  write(path.join(d, 'www', 'img', 'titles1', 'Castle.png'), 'png')
  write(path.join(tmp, 'pick', 'Some Folder', 'www', 'img', 'titles1', 'Castle.png'), 'png')
  const art = localArt(path.join(tmp, 'pick', 'Some Folder'), path.join(tmp, 'pick', 'Some Folder', 'www', 'index.html'), IS_WIN)
  check('jaquette RPG Maker (title1Name)', art.covers.length === 1 && art.covers[0].endsWith('Castle.png'), JSON.stringify(art))
  d = pick('Icons', { 'index.html': '<link rel="icon" href="img/fav.png?v=2"><link rel="shortcut icon" href="https://x/y.png">', 'img/fav.png': 'p', 'TemplateData/favicon.png': 'p', 'cover.jpg': 'j', 'index.png': 's' })
  const art2 = localArt(d, path.join(d, 'index.html'), IS_WIN)
  check('icône de <link rel=icon>, TemplateData exclu, splash ignoré', art2.icons.length === 1 && art2.icons[0].endsWith('fav.png') && art2.covers.length === 1, JSON.stringify(art2))

  // ---------- Garde-fous du dossier ----------
  const home = os.homedir()
  const fakeUserData = path.join(tmp, 'profile')
  fs.mkdirSync(fakeUserData, { recursive: true })
  const desktop = path.join(home, 'Desktop')
  const guard = { ancestors: [home, fakeUserData, os.tmpdir()], exact: [desktop], inside: [fakeUserData, ...(IS_WIN ? ['C:\\Windows'] : [])] }
  const drive = path.parse(home).root
  check('racine du disque refusée', rootRefusal(drive, guard, IS_WIN))
  check('parent du dossier personnel refusé', rootRefusal(path.dirname(home), guard, IS_WIN))
  check('dossier personnel refusé', rootRefusal(home, guard, IS_WIN))
  check('Bureau refusé', rootRefusal(desktop, guard, IS_WIN))
  check('sous-dossier du Bureau accepté', !rootRefusal(path.join(desktop, 'My Game'), guard, IS_WIN))
  // dossier connu déplacé (Documents dans OneDrive, D:\Data\Documents) : son parent est refusé aussi
  const moved = path.join(tmp, 'OneDrive')
  const movedGuard = { ...guard, ancestors: [home, fakeUserData], exact: [desktop, path.join(moved, 'Documents')] }
  check('parent d’un dossier connu déplacé refusé', rootRefusal(moved, movedGuard, IS_WIN))
  check('sous-dossier d’un dossier connu déplacé accepté', !rootRefusal(path.join(moved, 'Documents', 'Game'), movedGuard, IS_WIN))
  check('dossier voisin d’un dossier connu déplacé accepté', !rootRefusal(path.join(moved, 'Games'), movedGuard, IS_WIN))
  check('intérieur des données refusé', rootRefusal(path.join(fakeUserData, 'x'), guard, IS_WIN))
  check('dossier temporaire refusé', rootRefusal(os.tmpdir(), guard, IS_WIN))
  check('sous-dossier du dossier temporaire accepté', !rootRefusal(path.join(tmp, 'pick', 'root'), { ...guard, ancestors: [home, os.tmpdir()] }, IS_WIN))
  if (IS_WIN) {
    check('UNC racine refusée', rootRefusal('\\\\server\\share\\', guard, true))
    check('Windows refusé (intérieur)', rootRefusal('C:\\Windows\\System32', guard, true))
    check('casse ignorée sous Windows', rootRefusal(home.toUpperCase(), guard, true))
    check('isInside sans casse sous Windows', isInside('C:\\A\\b', 'c:\\a', true) && !isInside('C:\\AB', 'C:\\A', true))
  }
  check('isInside avec casse sous Linux', !isInside('/home/A/x', '/home/a', false) && isInside('/home/a/x', '/home/a', false))

  // ---------- Clé des sauvegardes ----------
  const k1 = htmlKey(realGame, 'index.html', IS_WIN)
  check('clé sur 32 caractères', /^[a-f0-9]{32}$/.test(k1), k1)
  check('même dossier, même clé', k1 === htmlKey(realGame + path.sep, 'index.html', IS_WIN))
  check('autre page, autre clé', k1 !== htmlKey(realGame, path.join('sub', 'index.html'), IS_WIN))
  check('clé sans casse sous Windows', htmlKey('C:\\Games\\X', 'Index.HTML', true) === htmlKey('c:\\games\\x', 'index.html', true))
  check('séparateurs Windows unifiés', htmlKey('C:\\G', 'www\\index.html', true) === htmlKey('C:\\G', 'www/index.html', true))

  // ---------- Réseau ----------
  const priv = [
    'localhost', 'LOCALHOST.', 'foo.localhost', 'nas.local', 'x.internal', 'box.lan', 'r.home.arpa', 'intranet',
    '127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.0.0.8', '192.0.2.1',
    '198.18.0.1', '198.51.100.2', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255', '0.0.0.0',
    '[::1]', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1',
    '[::ffff:7f00:1]', '::ffff:192.168.1.1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1'
  ]
  for (const h of priv) check(`privé : ${h}`, isPrivateHost(h) === true)
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '[::ffff:808:808]', '64:ff9b::808:808', 'fonts.googleapis.com'])
    check(`public : ${h}`, isPrivateHost(h) === false)
  // la forme hexadécimale renvoyée par URL est bien contrôlée
  check('URL https://[::ffff:127.0.0.1] privée', isPrivateHost(new URL('https://[::ffff:127.0.0.1]/').hostname))
  check('URL https://0x7f.1/ privée', isPrivateHost(new URL('https://0x7f.1/').hostname))
  const v = (u, n) => requestVerdict(u, n)
  check('cdgame autorisé', v('cdgame://game/index.html', false) === 'allow')
  check('data/blob/about autorisés', v('data:text/plain,x', false) === 'allow' && v('blob:cdgame://game/abc', false) === 'allow' && v('about:blank', false) === 'allow')
  check('https coupé par défaut', v('https://example.com/', false) === 'offline')
  check('wss coupé par défaut', v('wss://example.com/', false) === 'offline')
  check('https autorisé', v('https://example.com/', true) === 'allow')
  check('https local refusé', v('https://127.0.0.1:9/', true) === 'private' && v('https://[::1]:9/', true) === 'private' && v('https://192.168.0.1/', true) === 'private')
  check('http refusé', v('http://example.com/', true) === 'scheme' && v('http://127.0.0.1:9/', false) === 'scheme')
  check('ws, file, essaim, ftp refusés', ['ws://x.com/', 'file:///C:/x', 'essaim://cover/x', 'ftp://x.com/'].every((u) => v(u, true) === 'scheme'))
  check('adresse illisible refusée', v('::nope', true) === 'scheme')

  // ---------- Liens et téléchargements ----------
  const o = (x) => ({ focused: true, network: true, lastInputAt: 9_500, lastOpenAt: 0, now: 10_000, ...x })
  check('lien https ouvert', externalOpenAllowed('https://example.com/x', o()))
  check('lien http refusé', !externalOpenAllowed('http://example.com/x', o()))
  check('lien avec identifiants refusé', !externalOpenAllowed('https://a:b@example.com/', o()))
  check('fenêtre inactive : refusé', !externalOpenAllowed('https://example.com/', o({ focused: false })))
  check('Internet coupé : refusé', !externalOpenAllowed('https://example.com/', o({ network: false })))
  check('sans clic ni touche récents : refusé', !externalOpenAllowed('https://example.com/', o({ lastInputAt: 8_000 })))
  check('moins de 3 s : refusé', !externalOpenAllowed('https://example.com/', o({ lastOpenAt: 8000 })))
  check('adresse trop longue refusée', !externalOpenAllowed('https://example.com/' + 'a'.repeat(2100), o()))
  check('protocole refusé', !externalOpenAllowed('steam://run/1', o()) && !externalOpenAllowed('file:///C:/x', o()))
  for (const n of ['setup.exe', 'a.MSI', 'x.bat', 'x.ps1', 'x.lnk', 'x.hta', 'a.b.js', 'x.appimage', 'x.desktop', 'x.exe.', 'x.exe ', 'x.rdp', 'x.MSC', 'x.appref-ms', 'x.diagcab', 'x.mhtml', 'x.py'])
    check(`téléchargement bloqué : ${JSON.stringify(n)}`, dangerousDownload(n))
  for (const n of ['save.json', 'shot.png', 'level.txt', 'noext', 'x.zip']) check(`téléchargement permis : ${n}`, !dangerousDownload(n))

  // ---------- Verdict de butler (itch.io) ----------
  const itch = path.join(tmp, 'itch', 'game')
  write(path.join(itch, 'index.html'), 'x')
  write(path.join(itch, 'bin', 'game.exe'), 'x')
  write(path.join(itch, 'bin32', 'game.exe'), 'x')
  write(path.join(tmp, 'itch', 'x.html'), 'x')
  const verdict = JSON.stringify({
    candidates: [
      { path: 'index.html', flavor: 'html', depth: 1 },
      { path: '../x.html', flavor: 'html', depth: 1 },
      { path: 'bin32/game.exe', flavor: 'windows', arch: '386', depth: 2 },
      { path: 'bin/game.exe', flavor: 'windows', arch: 'amd64', depth: 2 },
      { path: 'missing.exe', flavor: 'windows', arch: 'amd64', depth: 1 }
    ]
  })
  const html = verdictFiles(itch, verdict, /^html$/i)
  check('verdict html : index.html, ../x.html refusé', html.length === 1 && html[0] === path.join(itch, 'index.html'), JSON.stringify(html))
  const exes = verdictFiles(itch, verdict, /^windows/i)
  check('verdict windows : amd64 d’abord, fichiers absents ignorés', exes.length === 2 && exes[0] === path.join(itch, 'bin', 'game.exe'), JSON.stringify(exes))
  check('verdict illisible : aucun fichier', verdictFiles(itch, '{nope', /^html$/i).length === 0 && verdictFiles(itch, null, /^html$/i).length === 0)
} catch (e) {
  failed++
  console.log('FAIL exception : ' + (e?.stack ?? e))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${passed} ok, ${failed} échec(s)`)
process.exit(failed ? 1 : 0)
