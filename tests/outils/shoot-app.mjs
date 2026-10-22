// Captures standard de l'app construite (sans rien installer ni lancer de jeu).
// Usage : node shoot-app.mjs <dossier-out> <copie-du-profil> <dossier-captures> [largeur=1440] [hauteur=880]
//   <dossier-out> : sortie d'electron-vite (contient main/, preload/, renderer/)
//   <copie-du-profil> : une COPIE d’un profil (jamais le vrai dossier %APPDATA%\CyberDeck)
// S'appuie sur les attributs data-testid (voir la liste dans la spécification).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// racine du projet, déduite de l'emplacement de ce script (tests/outils)
const ROOT = path.resolve(import.meta.dirname, '..', '..')

const [outDir, userData, shots, w = '1440', h = '880'] = process.argv.slice(2)
const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
fs.mkdirSync(shots, { recursive: true })
const problems = []
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const app = await _electron.launch({
  executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [path.resolve(outDir, 'main', 'index.js')],
  env: { ...process.env, CYBERDECK_USER_DATA: path.resolve(userData) , CYBERDECK_TEST_QUIET: '1'}
})
const page = await app.firstWindow()
page.setDefaultTimeout(8000)
page.on('crash', () => log('CRASH de la page'))
page.on('pageerror', (e) => problems.push('erreur de page : ' + e.message))
page.on('console', (m) => m.type() === 'error' && problems.push('console : ' + m.text()))
const size = (W, H) => app.evaluate(({ BrowserWindow }, [W, H]) => BrowserWindow.getAllWindows()[0].setContentSize(W, H), [W, H])
await size(Number(w), Number(h))
await page.waitForTimeout(2500)

const $ = (id) => page.locator(`[data-testid="${id}"]`)
async function step(name, fn) {
  try {
    await fn()
  } catch (e) {
    problems.push(`${name} : ${String(e.message).split('\n')[0]}`)
  }
}
const shot = (name) => page.screenshot({ path: path.join(shots, name + '.png') })
const esc = async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(350)
}

await step('vue torrents', async () => {
  await $('nav-filter-all').click()
  await page.waitForTimeout(1200)
  await shot('01-torrents')
})
await step('torrent en pause (ubuntu)', async () => {
  await $('torrent-row').filter({ hasText: 'ubuntu' }).first().click()
  await page.waitForTimeout(1200)
  await shot('02-torrent-pause')
})
for (const [i, tab] of ['files', 'infos', 'peers', 'trackers'].entries()) {
  await step(`onglet ${tab}`, async () => {
    await $('torrent-row').filter({ hasText: 'debian' }).first().click()
    await $(`details-tab-${tab}`).click()
    await page.waitForTimeout(tab === 'peers' ? 2500 : 1200)
    await shot(`0${3 + i}-details-${tab}`)
  })
}
await step('menu clic droit torrent', async () => {
  await $('torrent-row').first().click({ button: 'right' })
  await page.waitForTimeout(500)
  await shot('07-menu-torrent')
  await esc()
})
await step('fenêtre ajout torrent', async () => {
  await $('btn-add-torrent').click()
  await page.waitForTimeout(700)
  await shot('08-dialog-ajout')
  await esc()
})
await step('fenêtre suppression', async () => {
  await $('torrent-row').filter({ hasText: 'debian' }).first().click()
  await $('btn-remove').click()
  await page.waitForTimeout(700)
  await shot('09-dialog-suppression')
  await esc()
})
await step('fenêtre réglages', async () => {
  await $('nav-settings').click()
  await page.waitForTimeout(700)
  await shot('09b-dialog-reglages')
  await esc()
})
await step('bibliothèque', async () => {
  await $('nav-library').click()
  await page.waitForTimeout(2500)
  await page.mouse.move(5, 300)
  await shot('10-bibliotheque')
})
await step('survol carte', async () => {
  await $('game-card').nth(2).hover()
  await page.waitForTimeout(700)
  await shot('11-bibliotheque-survol')
})
await step('défilement bibliothèque', async () => {
  await page.mouse.move(700, 600)
  await page.mouse.wheel(0, 900)
  await page.waitForTimeout(900)
  await shot('12-bibliotheque-bas')
})
await step('modifier un jeu', async () => {
  await $('game-card').first().click({ button: 'right' })
  await page.waitForTimeout(400)
  await $('context-menu').getByText('Modifier').click()
  await page.waitForTimeout(900)
  await shot('13-dialog-jeu')
  await esc()
})
await step('importer un dossier', async () => {
  await $('btn-import-folder').click()
  await page.waitForTimeout(6000)
  await shot('14-dialog-import')
  await esc()
})
await step('petite fenêtre', async () => {
  await size(1024, 640)
  await page.waitForTimeout(1200)
  await shot('15-bibliotheque-1024')
  await $('nav-filter-all').click()
  await page.waitForTimeout(1200)
  await shot('16-torrents-1024')
})

await page.evaluate(() => window.close()).catch(() => {})
await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
log(problems.length ? 'PROBLÈMES :\n- ' + problems.join('\n- ') : 'aucun problème')
process.exit(0)
