// Diagnostic : laisse l'app tourner et mesure la mémoire de la page toutes les 10 s.
// Usage : node soak.mjs <arg-electron (dossier app ou main/index.js)> <copie-profil> <secondes> [vue: torrents|library]
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// racine du projet, déduite de l'emplacement de ce script (tests/outils)
const ROOT = path.resolve(import.meta.dirname, '..', '..')

const [entry, userData, seconds = '180', view = 'torrents'] = process.argv.slice(2)
const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
const app = await _electron.launch({
  executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [path.resolve(entry)],
  env: { ...process.env, CYBERDECK_USER_DATA: path.resolve(userData) , CYBERDECK_TEST_QUIET: '1'}
})
const page = await app.firstWindow()
let crashed = false
page.on('crash', () => {
  crashed = true
  console.log('CRASH de la page à', new Date().toISOString().slice(11, 19))
})
page.on('pageerror', (e) => console.log('pageerror', e.message))
if (process.env.RESIZE) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 880))
if (process.env.WAITLOC) for (let i = 0; i < 4; i++) await page.locator('[data-testid=nope]').click({ timeout: 30000 }).catch(() => console.log('attente', i))
await page.waitForTimeout(2000)
if (view === 'library') await page.getByText('Mes jeux').first().click().catch(() => {})
const t0 = Date.now()
while (!crashed && Date.now() - t0 < Number(seconds) * 1000) {
  await page.waitForTimeout(10000)
  if (crashed) break
  const m = await page
    .evaluate(() => ({ heap: Math.round(performance.memory.usedJSHeapSize / 1e6), dom: document.getElementsByTagName('*').length }))
    .catch((e) => ({ err: e.message.split('\n')[0] }))
  const procs = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => `${p.type}:${Math.round(p.memory.workingSetSize / 1024)}Mo`).join(' '))
  console.log(Math.round((Date.now() - t0) / 1000) + 's', JSON.stringify(m), procs)
}
await page.evaluate(() => window.close()).catch(() => {})
await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
process.exit(0)
