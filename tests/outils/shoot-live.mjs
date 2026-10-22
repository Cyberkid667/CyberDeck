// Captures de l'état « En jeu » avec un FAUX jeu (programme qui attend 40 s), sur une
// copie de profil. Ne lance aucun vrai jeu ni lanceur.
// Usage : node shoot-live.mjs <dossier-out> <copie-profil> <dossier-captures> <faux-jeu.exe>
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
// racine du projet, déduite de l'emplacement de ce script (tests/outils)
const ROOT = path.resolve(import.meta.dirname, '..', '..')

const [outDir, userData, shots, fakeExe] = process.argv.slice(2)
const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
fs.mkdirSync(shots, { recursive: true })

// Le faux jeu est ajouté en tête de la bibliothèque copiée, avec la jaquette de GTA V si elle existe.
const libFile = path.join(userData, 'library.json')
const lib = JSON.parse(fs.readFileSync(libFile, 'utf8'))
const id = randomUUID()
const gta = lib.games.find((g) => /grand theft auto v/i.test(g.name) && g.coverVersion)
if (gta) fs.copyFileSync(path.join(userData, 'covers', `${gta.id}.jpg`), path.join(userData, 'covers', `${id}.jpg`))
lib.games.push({
  id, name: 'Jeu de test (faux)', exePath: fakeExe, args: null, installDir: path.dirname(fakeExe), torrentId: null,
  coverVersion: gta ? 1 : 0, coverShape: gta ? 'portrait' : null, iconVersion: 0, steamAppId: 0, coverHint: null, coverTriedAt: Date.now(),
  addedAt: Date.now(), lastPlayedAt: Date.now() + 1000, playTimeSeconds: 0, platform: 'local', installed: true
})
fs.writeFileSync(libFile, JSON.stringify(lib))

const app = await _electron.launch({
  executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [path.resolve(outDir, 'main', 'index.js')],
  env: { ...process.env, CYBERDECK_USER_DATA: path.resolve(userData) , CYBERDECK_TEST_QUIET: '1'}
})
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 880))
await page.waitForTimeout(6000)
await page.locator('[data-testid="nav-library"]').click()
await page.waitForTimeout(1500)
const card = page.locator('[data-testid="game-card"]').filter({ hasText: 'Jeu de test' }).first()
await card.hover()
await card.locator('[data-testid="game-play"]').click()
await page.waitForTimeout(9000)
await page.mouse.move(700, 300)
await page.screenshot({ path: path.join(shots, '01-en-jeu-bibliotheque.png') })
// vue Torrents seulement si les torrents sont activés sur ce profil
if (await page.locator('[data-testid="nav-filter-all"]').count()) {
  await page.locator('[data-testid="nav-filter-all"]').click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(shots, '02-en-jeu-torrents.png') })
}
await page.locator('[data-testid="titlebar-live"]').click()
await page.waitForTimeout(1500)
console.log('vue après clic sur l’étiquette :', await page.locator('[data-testid="nav-library"]').getAttribute('aria-current'))
await page.evaluate(() => window.close()).catch(() => {})
await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
process.exit(0)
