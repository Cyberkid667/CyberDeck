// Capture d'écran d'une page HTML locale avec Edge (sans fenêtre).
// Usage : node shot.mjs <page.html> <sortie.png> [largeur=1440] [hauteur=880] [attente-ms=1200]
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// racine du projet, déduite de l'emplacement de ce script (tests/outils)
const ROOT = path.resolve(import.meta.dirname, '..', '..')

const [html, out, w = '1440', h = '880', wait = '1200'] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href)
const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.goto(pathToFileURL(path.resolve(html)).href)
await page.waitForTimeout(Number(wait))
await page.screenshot({ path: out })
await browser.close()
console.log(errors.length ? `capture faite, erreurs : ${errors.join(' | ')}` : 'capture faite')
