import path from 'node:path'
import { pathToFileURL } from 'node:url'
// racine du projet, déduite de l'emplacement de ce script (tests/outils)
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const [outDir, userData] = process.argv.slice(2)
const { _electron } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
const app = await _electron.launch({ executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [path.resolve(outDir, 'main', 'index.js')], env: { ...process.env, CYBERDECK_USER_DATA: path.resolve(userData) , CYBERDECK_TEST_QUIET: '1'} })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 880))
await page.waitForTimeout(4000)
const $ = (id) => page.locator(`[data-testid="${id}"]`)
async function measure(label) {
  await app.evaluate(({ app }) => app.getAppMetrics())
  await page.waitForTimeout(1000)
  const samples = []
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    samples.push(await app.evaluate(({ app }) => app.getAppMetrics().map((p) => [p.type, p.cpu.percentCPUUsage])))
  }
  const avg = {}
  for (const s of samples) for (const [t, c] of s) avg[t] = (avg[t] ?? 0) + c / samples.length
  console.log(label.padEnd(22), Object.entries(avg).map(([t, c]) => `${t} ${c.toFixed(1)}%`).join(' · '))
}
await $('nav-filter-all').click()
await $('torrent-row').filter({ hasText: 'debian' }).first().click()
await $('details-tab-peers').click()
await measure('Torrents + globe')
await $('details-tab-files').click()
await measure('Torrents + fichiers')
await $('nav-library').click()
await page.mouse.move(700, 500)
await measure('Bibliothèque')
await page.evaluate(() => window.close()).catch(() => {})
await app.waitForEvent('close', { timeout: 15000 }).catch(() => {})
process.exit(0)
