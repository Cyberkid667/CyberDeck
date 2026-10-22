// Captures de la bibliothèque unifiée (badges, filtres par plateforme, fenêtre Plateformes)
// sur une COPIE de profil. Ne lance aucun jeu ni lanceur.
// Usage : node shoot-platforms.mjs <dossier-out> <copie-profil> <dossier-captures>
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// racine du projet, déduite de l'emplacement de ce script (tests/outils)
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const [outDir, userData, shots] = process.argv.slice(2)
const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
fs.mkdirSync(shots, { recursive: true })
const app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [path.resolve(outDir, 'main', 'index.js')], env: { ...process.env, CYBERDECK_USER_DATA: path.resolve(userData) , CYBERDECK_TEST_QUIET: '1'} })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const problems = []
page.on('pageerror', (e) => problems.push(e.message))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 880))
await page.waitForTimeout(7000)
const $ = (id) => page.locator(`[data-testid="${id}"]`)
const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') })
await $('nav-library').click()
await page.waitForTimeout(3000)
await page.mouse.move(5, 300)
await shot('01-bibliotheque')
const filters = await page.locator('[data-testid^="nav-platform-"]').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')))
console.log('filtres :', filters.join(' | '))
const badges = await $('platform-badge').evaluateAll((els) => { const c = {}; for (const e of els) c[e.innerText] = (c[e.innerText] || 0) + 1; return c })
console.log('badges :', JSON.stringify(badges))
for (const id of ['steam', 'battlenet']) {
  const f = $(`nav-platform-${id}`)
  if (await f.count()) { await f.click(); await page.waitForTimeout(1500); await shot(`02-filtre-${id}`) }
}
await $('nav-platforms').click()
await page.waitForTimeout(2500)
await shot('03-plateformes')
await page.keyboard.press('Escape')
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640))
await page.waitForTimeout(1500)
await $('nav-library').click().catch(() => {})
await page.waitForTimeout(1500)
await shot('04-bibliotheque-1024')
// barre latérale repliée (bouton en haut à gauche), puis rouverte
await $('titlebar-side').click()
await page.waitForTimeout(800)
await shot('05-barre-repliee-1024')
await $('titlebar-side').click()
await page.evaluate(() => window.close()).catch(() => {})
await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
console.log(problems.length ? 'ERREURS : ' + problems.join(' | ') : 'aucune erreur de page')
process.exit(0)
