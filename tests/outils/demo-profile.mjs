// Crée un profil de DÉMONSTRATION (bibliothèque fictive de jeux connus, une par plateforme)
// pour les captures du README, puis prend la capture de la bibliothèque. Les plateformes du
// PC ne sont pas lues (CYBERDECK_TEST_NO_PLATFORMS) : aucun jeu ni compte réel n'apparaît.
// Ne lance aucun jeu ni lanceur.
// Usage : node demo-profile.mjs <dossier-out> <nouveau-dossier-profil> <capture.png>
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
// racine du projet, déduite de l'emplacement de ce script (tests/outils)
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const [outDir, userData, shotFile] = process.argv.slice(2)
if (fs.existsSync(path.join(userData, 'library.json'))) throw new Error('Le dossier de profil doit être neuf')
fs.mkdirSync(userData, { recursive: true })

const H = 3600
const DAY = 86400000
const now = Date.now()
// nom, plateforme, identifiant, appid Steam (jaquette), heures de jeu, dernière partie (jours)
const DEMO = [
  ['Counter-Strike 2', 'steam', '730', 730, 212, 0.1],
  ['Cyberpunk 2077', 'gog', '1423049311', 1091500, 64, 1],
  ['Fall Guys', 'epic', '0a2d9f6403244d12969e11da6713137b', 1097150, 41, 1.5],
  ['Overwatch 2', 'battlenet', 'pro', 2357570, 37, 2],
  ['Grand Theft Auto V', 'rockstar', 'gta5', 271590, 120, 3],
  ['Forza Horizon 5', 'xbox', 'Microsoft.624F8B84B80_8wekyb3d8bbwe!Forzahorizon5', 1551360, 18, 4],
  ['Rocket League', 'epic', 'Sugar', 252950, 95, 5],
  ['Apex Legends', 'ea', '1172470', 1172470, 22, 6],
  ['Valorant', 'riot', 'valorant', 0, 54, 35],
  ["Assassin's Creed Valhalla", 'ubisoft', '13504', 2208920, 30, 9],
  ['Celeste', 'itch', 'celeste', 504230, 12, 11],
  ['Elden Ring', 'steam', '1245620', 1245620, 88, 13],
  ['Hollow Knight', 'steam', '367520', 367520, 26, 16],
  ["Baldur's Gate 3", 'gog', '1456460669', 1086940, 140, 20],
  ['Hades', 'epic', 'Min', 1145360, 33, 25],
  ['SuperTuxKart', 'local', null, 0, 6, 30]
]

const games = DEMO.map(([name, platform, platformId, steamAppId, hours, days]) => {
  const dir = `D:\\Jeux\\${name.replace(/[':]/g, '')}`
  return {
    id: randomUUID(), name, exePath: '', args: null, installDir: dir, torrentId: null,
    coverVersion: 0, coverShape: null, iconVersion: 0, steamAppId, coverHint: null, coverTriedAt: null,
    addedAt: now - 40 * DAY, lastPlayedAt: now - days * DAY, playTimeSeconds: hours * H,
    platform, platformId, installed: true, owned: null,
    launch: platform === 'local' ? null : { kind: 'uri', target: 'about:blank', args: null, cwd: null },
    watch: null, platformPlayTimeSeconds: null, platformLastPlayedAt: null, platformState: null, iconHint: null
  }
})
fs.writeFileSync(path.join(userData, 'library.json'), JSON.stringify({ version: 2, games, hidden: [] }))
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ defaultSavePath: 'D:\\Jeux', port: 28340, torrentsEnabled: false, gamesFolder: null }))

const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
const app = await _electron.launch({
  executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [path.resolve(outDir, 'main', 'index.js')],
  env: { ...process.env, CYBERDECK_USER_DATA: path.resolve(userData), CYBERDECK_TEST_QUIET: '1', CYBERDECK_TEST_NO_PLATFORMS: '1' }
})
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 880))
// le temps de télécharger les jaquettes (Steam, puis Wikipédia)
await page.waitForTimeout(25000)
await page.locator('[data-testid="nav-library"]').click()
await page.waitForTimeout(2000)
await page.mouse.move(5, 300)
await page.screenshot({ path: shotFile })
await page.evaluate(() => window.close()).catch(() => {})
await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
process.exit(0)
