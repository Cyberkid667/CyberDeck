// Génère build/icon.png (512 px) à partir de build/icon.svg.
// electron-builder en tire l'icône .ico de Windows.
import { readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const svg = readFileSync(new URL('../build/icon.svg', import.meta.url))
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng()
writeFileSync(new URL('../build/icon.png', import.meta.url), png)
console.log('build/icon.png généré')
