// Test de fumée de l'app construite (Linux sur la CI, Windows en local) : la bibliothèque s'ouvre,
// la vue Steam et la page Lanceurs s'affichent, aucune erreur de page, journal propre. Ne lance
// aucun jeu et n'ouvre aucune adresse steam://.
// Usage :
//   node tests/tools/linux-smoke.mjs --exe <programme de l'app empaquetée> --user-data <dossier> --shots <dossier>
//   node tests/tools/linux-smoke.mjs --out <sortie d'electron-vite> --user-data <dossier> --shots <dossier>
//   --no-torrents : profil vide sans moteur torrent
// <dossier> de --user-data : un dossier VIDE (CI : mktemp -d) ou une COPIE d'un profil, jamais le vrai.
// Profil vide : un jeu Steam fictif (non installé) est ajouté pour que la vue Steam existe, et les
// torrents sont activés pour vérifier que les modules natifs (uTP, WebRTC) se chargent.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const exe = opt('--exe')
const outDir = opt('--out')
const userData = path.resolve(opt('--user-data') ?? process.env.CYBERDECK_USER_DATA ?? '')
const shots = path.resolve(opt('--shots') ?? 'smoke-shots')
if ((!exe && !outDir) || !opt('--user-data') && !process.env.CYBERDECK_USER_DATA) {
  console.error('usage : linux-smoke.mjs (--exe <app> | --out <dossier-out>) --user-data <dossier> [--shots <dossier>]')
  process.exit(2)
}
const isLinux = process.platform === 'linux'
// --no-torrents : profil vide sans moteur torrent (Windows : pas d'alerte du pare-feu)
const torrents = !argv.includes('--no-torrents')
fs.mkdirSync(shots, { recursive: true })
fs.mkdirSync(userData, { recursive: true })

// ---------- Profil vide : réglages et jeu Steam fictif ----------
const fresh = !fs.existsSync(path.join(userData, 'library.json')) && !fs.existsSync(path.join(userData, 'settings.json'))
if (fresh) {
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ language: 'en', checkUpdates: false, torrentsEnabled: torrents, gamesFolder: null, port: 41234 }, null, 2)
  )
  const game = {
    id: '00000000-0000-4000-8000-000000000620',
    name: 'Portal 2',
    platform: 'steam',
    platformId: '620',
    steamAppId: 620,
    installed: false,
    owned: true,
    exePath: '',
    installDir: null,
    launch: { kind: 'uri', target: 'steam://rungameid/620', args: null, cwd: null },
    addedAt: Date.now(),
    playTimeSeconds: 0
  }
  fs.writeFileSync(path.join(userData, 'library.json'), JSON.stringify({ version: 2, games: [game], hidden: [] }, null, 1))
}

// journal déjà présent (copie d'un profil) : seules les lignes de ce lancement comptent
const logFile = path.join(userData, 'cyberdeck.log')
let logStart = 0
try {
  logStart = fs.statSync(logFile).size
} catch {
  // pas encore de journal
}

const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
const problems = []
const warnings = []
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
// Linux (CI) : chrome-sandbox d'un dossier décompressé n'est pas setuid root, et Ubuntu 24.04 limite
// les espaces de noms : --no-sandbox, comme pour un AppImage lancé dans un conteneur.
const sandboxArgs = isLinux ? ['--no-sandbox'] : []
const app = await _electron.launch({
  executablePath: exe ? path.resolve(exe) : electronBin,
  args: exe ? sandboxArgs : [...sandboxArgs, path.resolve(outDir, 'main', 'index.js')],
  env: { ...process.env, CYBERDECK_USER_DATA: userData, CYBERDECK_TEST_QUIET: '1' },
  timeout: 60_000
})
const page = await app.firstWindow()
page.setDefaultTimeout(15_000)
page.on('crash', () => problems.push('page crash'))
page.on('pageerror', (e) => problems.push('page error: ' + e.message))
// erreurs de console (réseau de la boutique…) : signalées, sans faire échouer le test
page.on('console', (m) => m.type() === 'error' && warnings.push('console: ' + m.text()))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 880))

const $ = (id) => page.locator(`[data-testid="${id}"]`)
const shot = (name) => page.screenshot({ path: path.join(shots, name + '.png') }).catch((e) => warnings.push(`capture ${name} : ${e.message}`))
async function step(name, fn) {
  try {
    await fn()
    log('ok', name)
  } catch (e) {
    problems.push(`${name}: ${String(e.message).split('\n')[0]}`)
    log('ÉCHEC', name)
  }
}

await step('library view', async () => {
  await $('nav-library').waitFor({ state: 'visible', timeout: 30_000 })
  await $('nav-library').click()
  await $('btn-add-game').waitFor({ state: 'visible' })
  // première lecture des plateformes (1,5 s après l'ouverture)
  await page.waitForTimeout(4000)
  await shot('01-library')
})

await step('steam view', async () => {
  await $('nav-platform-steam').click()
  await $('steam-view').waitFor({ state: 'visible' })
  await page.waitForTimeout(1500)
  await shot('02-steam-library')
  for (const tab of ['store', 'community']) {
    const t = $(`steam-tab-${tab}`)
    if (await t.count()) {
      await t.click()
      await page.waitForTimeout(2500)
      await shot(`03-steam-${tab}`)
    }
  }
})

await step('launchers page', async () => {
  await $('nav-platforms').click()
  await $('launchers-view').waitFor({ state: 'visible' })
  await page.waitForTimeout(2500)
  await shot('04-launchers')
  const cards = await $('launcher-card').count()
  if (isLinux) {
    // Linux : Steam seul, avec la note « autres lanceurs Windows seulement »
    const platforms = await $('launcher-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-platform')))
    if (platforms.join(',') !== 'steam') throw new Error(`launchers shown: ${platforms.join(',') || 'none'} (expected steam only)`)
    if (!(await $('launchers-linux-note').count())) throw new Error('Linux note missing')
  } else if (cards < 2) throw new Error(`only ${cards} launcher card(s)`)
})

await step('back to library', async () => {
  await $('nav-library').click()
  await $('btn-add-game').waitFor({ state: 'visible' })
})

await page.evaluate(() => window.close()).catch(() => {})
await app.waitForEvent('close', { timeout: 20_000 }).catch(() => warnings.push('app did not close within 20 s'))

// ---------- Journal de l'app ----------
let journal = ''
try {
  journal = fs.readFileSync(logFile).subarray(logStart).toString('utf8')
} catch {
  problems.push('cyberdeck.log missing')
}
for (const bad of ['Erreur imprévue', 'Promesse rejetée sans traitement', 'Affichage planté', 'Moteur arrêté']) {
  if (journal.includes(bad)) problems.push(`log contains « ${bad} »`)
}
if (isLinux && /powershell/i.test(journal)) problems.push('log mentions PowerShell on Linux')
if (!/Plateformes lues/.test(journal)) problems.push('platforms were never read (no « Plateformes lues » in the log)')
if (fresh && torrents && !/Moteur prêt/.test(journal)) problems.push('torrent engine did not start (native modules?) — no « Moteur prêt » in the log')
if (journal) fs.writeFileSync(path.join(shots, 'cyberdeck.log'), journal)

for (const w of warnings.slice(0, 20)) log('warning:', w)
log(problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'smoke test passed')
process.exit(problems.length ? 1 : 0)
