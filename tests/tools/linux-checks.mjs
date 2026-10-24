// Vérifications de la version Linux sans machine Linux : détection du client Steam (natif,
// Flatpak, Snap), bibliothèques et manifestes, registry.vdf, et surveillance « En jeu » par /proc,
// sur de faux dossiers créés dans un dossier temporaire (retiré à la fin).
// Usage : node tests/tools/linux-checks.mjs   (Windows ou Linux ; code de sortie 1 si un test échoue)
// Les modules TypeScript sont assemblés à la volée par rolldown (déjà installé avec vite).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-linux-checks-'))
let failed = 0
let passed = 0
const check = (name, ok, detail = '') => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ' : ' + detail : ''}`)
}
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** chemin écrit dans un fichier VDF (les « \ » y sont doublés) */
const vdfPath = (p) => p.replace(/\\/g, '\\\\')

try {
  // ---------- Assemblage des modules ----------
  const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'rolldown', 'dist', 'index.mjs')).href).catch(() => import('rolldown'))
  const bundleDir = path.join(tmp, 'bundle')
  await build({
    input: {
      steamLinux: path.join(ROOT, 'src', 'main', 'platforms', 'steamLinux.ts'),
      steam: path.join(ROOT, 'src', 'main', 'platforms', 'steam.ts'),
      procWatch: path.join(ROOT, 'src', 'main', 'procWatch.ts')
    },
    platform: 'node',
    logLevel: 'silent',
    output: { dir: bundleDir, format: 'esm', entryFileNames: '[name].mjs' }
  })
  const imp = (n) => import(pathToFileURL(path.join(bundleDir, n + '.mjs')).href)
  const { findLinuxSteamClient, linuxSteamRunningAppId } = await imp('steamLinux')
  const { steamLibrariesInfo, readManifests } = await imp('steam')
  const { listProcesses, matchProcess, startProcWatcher, wineToPosix } = await imp('procWatch')

  // ---------- Client Steam ----------
  const empty = path.join(tmp, 'home-empty')
  fs.mkdirSync(empty, { recursive: true })
  check('aucun Steam : null', findLinuxSteamClient(empty, {}) === null)

  const home = path.join(tmp, 'home')
  const native = path.join(home, '.local', 'share', 'Steam')
  write(path.join(native, 'steam.sh'), '#!/bin/sh\n')
  write(path.join(native, 'config', 'loginusers.vdf'), '"users"\n{\n}\n')
  fs.mkdirSync(path.join(native, 'steamapps', 'common'), { recursive: true })
  let c = findLinuxSteamClient(home, {})
  check('installation native trouvée', c && path.resolve(c.dir) === path.resolve(fs.realpathSync(native)), JSON.stringify(c))
  check('script steam.sh retenu comme programme', c && c.exe.endsWith('steam.sh'), c?.exe)

  // ~/.steam/steam : lien vers le vrai dossier (jonction sous Windows) : pas de doublon
  try {
    fs.mkdirSync(path.join(home, '.steam'), { recursive: true })
    fs.symlinkSync(native, path.join(home, '.steam', 'steam'), process.platform === 'win32' ? 'junction' : 'dir')
    c = findLinuxSteamClient(home, {})
    check('lien ~/.steam/steam : même dossier', c && path.resolve(c.dir) === path.resolve(fs.realpathSync(native)), c?.dir)
  } catch (e) {
    console.log('(lien symbolique impossible ici, test sauté : ' + e.message + ')')
  }

  // Flatpak plus ancien : le natif reste choisi ; Flatpak plus récent : il passe devant
  const flat = path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
  write(path.join(flat, 'config', 'loginusers.vdf'), '"users"\n{\n}\n')
  fs.mkdirSync(path.join(flat, 'steamapps'), { recursive: true })
  const old = new Date(Date.now() - 3600_000)
  fs.utimesSync(path.join(flat, 'config', 'loginusers.vdf'), old, old)
  fs.utimesSync(path.join(flat, 'steamapps'), old, old)
  c = findLinuxSteamClient(home, {})
  check('natif + Flatpak ancien : natif', c && path.resolve(c.dir) === path.resolve(fs.realpathSync(native)), c?.dir)
  const future = new Date(Date.now() + 3600_000)
  fs.utimesSync(path.join(flat, 'config', 'loginusers.vdf'), future, future)
  c = findLinuxSteamClient(home, {})
  check('Flatpak utilisé plus récemment : Flatpak', c && path.resolve(c.dir) === path.resolve(fs.realpathSync(flat)), c?.dir)
  check('Flatpak sans steam.sh : le dossier sert de programme', c && path.resolve(c.exe) === path.resolve(c.dir), c?.exe)

  const snapHome = path.join(tmp, 'home-snap')
  fs.mkdirSync(path.join(snapHome, 'snap', 'steam', 'common', '.local', 'share', 'Steam', 'steamapps'), { recursive: true })
  c = findLinuxSteamClient(snapHome, {})
  check('Snap trouvé', c && c.dir.includes(path.join('snap', 'steam')), c?.dir)

  const xdgHome = path.join(tmp, 'home-xdg')
  const xdgData = path.join(tmp, 'xdg-data')
  fs.mkdirSync(path.join(xdgData, 'Steam', 'steamapps'), { recursive: true })
  fs.mkdirSync(xdgHome, { recursive: true })
  c = findLinuxSteamClient(xdgHome, { XDG_DATA_HOME: xdgData })
  check('XDG_DATA_HOME/Steam trouvé', c && path.resolve(c.dir) === path.resolve(fs.realpathSync(path.join(xdgData, 'Steam'))), c?.dir)

  // ---------- Bibliothèques, manifestes (même code que sous Windows) ----------
  const lib2 = path.join(tmp, 'mnt', 'SteamLibrary')
  write(
    path.join(native, 'steamapps', 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(native)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(lib2)}"\n\t}\n}\n`
  )
  write(
    path.join(lib2, 'steamapps', 'appmanifest_620.acf'),
    '"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Portal 2"\n}\n'
  )
  fs.mkdirSync(path.join(lib2, 'steamapps', 'common', 'Portal 2'), { recursive: true })
  const libs = steamLibrariesInfo(native)
  check('libraryfolders.vdf : 2 bibliothèques', libs.dirs.length === 2 && !libs.suspect, JSON.stringify(libs))
  const man = readManifests(libs.dirs)
  check('appmanifest lu dans la 2e bibliothèque', man.manifests.length === 1 && man.manifests[0].appid === 620 && man.manifests[0].installdir === 'Portal 2', JSON.stringify(man))

  // ---------- registry.vdf ----------
  write(
    path.join(home, '.steam', 'registry.vdf'),
    '"Registry"\n{\n\t"HKCU"\n\t{\n\t\t"Software"\n\t\t{\n\t\t\t"Valve"\n\t\t\t{\n\t\t\t\t"Steam"\n\t\t\t\t{\n\t\t\t\t\t"RunningAppID"\t\t"620"\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n'
  )
  check('registry.vdf : RunningAppID 620', linuxSteamRunningAppId(home) === 620)
  check('registry.vdf absent : 0', linuxSteamRunningAppId(empty) === 0)

  // ---------- /proc ----------
  check('chemin Wine Z:\\ → Linux', wineToPosix('Z:\\home\\u\\Jeux\\a.exe') === '/home/u/Jeux/a.exe')
  check('chemin Wine C:\\ ignoré', wineToPosix('C:\\windows\\system32\\a.exe') === null)

  const proc = path.join(tmp, 'proc')
  // faux /proc : le lien exe est un fichier texte (lu par readlink ci-dessous)
  const io = {
    readdir: (p) => fs.readdirSync(p),
    readFile: (p) => fs.readFileSync(p, 'latin1'),
    readlink: (p) => fs.readFileSync(p, 'utf8')
  }
  const BTIME = 1_700_000_000
  write(path.join(proc, 'stat'), `cpu  1 2 3\nbtime ${BTIME}\n`)
  const addProc = (pid, { exe, cmdline = [], comm = '', env = [], ticks = 5000 }) => {
    const d = path.join(proc, String(pid))
    fs.mkdirSync(d, { recursive: true })
    if (exe) write(path.join(d, 'exe'), exe)
    write(path.join(d, 'cmdline'), cmdline.join('\0') + '\0')
    write(path.join(d, 'comm'), comm + '\n')
    write(path.join(d, 'environ'), env.join('\0') + '\0')
    write(path.join(d, 'stat'), `${pid} (${comm || 'x'}) S 1 ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1000 10`)
  }
  const removeProc = (pid) => fs.rmSync(path.join(proc, String(pid)), { recursive: true, force: true })
  const GAME = '/home/u/.local/share/Steam/steamapps/common/Portal 2'
  const PROTON_GAME = '/home/u/Games/SteamLibrary/steamapps/common/The Witcher 3'
  addProc(100, { exe: GAME + '/portal2_linux', cmdline: [GAME + '/portal2_linux', '-game', 'portal2'], comm: 'portal2_linux', ticks: 12345 })
  addProc(200, {
    exe: '/home/u/.local/share/Steam/steamapps/common/Proton 8.0/files/bin/wine64-preloader',
    cmdline: ['Z:\\home\\u\\Games\\SteamLibrary\\steamapps\\common\\The Witcher 3\\bin\\x64\\witcher3.exe'],
    comm: 'witcher3.exe'
  })
  addProc(300, { exe: '/home/u/.local/share/Steam/ubuntu12_32/reaper', cmdline: ['/home/u/.local/share/Steam/ubuntu12_32/reaper', 'SteamLaunch', 'AppId=292030', '--', 'proton'], comm: 'reaper' })
  addProc(400, { exe: '/home/u/.local/share/Steam/ubuntu12_32/steam', cmdline: ['steam'], comm: 'steam', env: ['SteamAppId=777'] })
  addProc(500, { exe: '/usr/lib/pressure-vessel/from-host/bin/pv-adverb', cmdline: ['pv-adverb'], comm: 'pv-adverb', env: ['HOME=/home/u', 'SteamAppId=777'] })
  addProc(600, { exe: '/usr/bin/bash', cmdline: ['bash'], comm: 'bash' })
  addProc(700, { cmdline: [], comm: 'DayZ_x64.exe' }) // processus d'un autre compte : exe illisible
  addProc(800, { exe: GAME + '/_CommonRedist/vcredist/vc_redist.x64', cmdline: [GAME + '/_CommonRedist/vcredist/vc_redist.x64'], comm: 'vc_redist.x64' })
  addProc(900, { exe: '/usr/bin/sh', cmdline: ['/bin/sh', '/home/u/Games/Celeste/Celeste.sh'], comm: 'sh' })

  const procs = listProcesses(proc, io)
  const byPid = (pid) => procs.find((p) => p.pid === pid)
  check('/proc lu (9 processus)', procs.length === 9, String(procs.length))
  check('heure de démarrage (btime + starttime)', byPid(100)?.startMs === BTIME * 1000 + 12345 * 10, String(byPid(100)?.startMs))
  check('exe illisible : null', byPid(700)?.exe === null)

  const spec = (o) => ({ dirs: [], names: [], ignore: [], platform: true, steamAppId: 0, selfPid: -1, ...o })
  check('jeu natif : programme dans le dossier', matchProcess(byPid(100), spec({ dirs: [GAME] })))
  check('autre dossier : rien', !matchProcess(byPid(100), spec({ dirs: [PROTON_GAME] })))
  check('jeu Proton : chemin Wine dans la ligne de commande', matchProcess(byPid(200), spec({ dirs: [PROTON_GAME] })))
  check('lanceur Steam SteamLaunch AppId=292030', matchProcess(byPid(300), spec({ dirs: ['/nulle/part'], steamAppId: 292030 })))
  check('SteamLaunch d’un autre appid : rien', !matchProcess(byPid(300), spec({ dirs: ['/nulle/part'], steamAppId: 620 })))
  check('processus avec SteamAppId=777', matchProcess(byPid(500), spec({ dirs: ['/nulle/part'], steamAppId: 777 })))
  check('client Steam avec SteamAppId : jamais compté', !matchProcess(byPid(400), spec({ dirs: ['/nulle/part'], steamAppId: 777 })))
  check('processus sans rapport : rien', !matchProcess(byPid(600), spec({ dirs: [GAME], steamAppId: 620 })))
  check('exe illisible : repli sur le nom', matchProcess(byPid(700), spec({ dirs: [GAME], names: ['dayz_x64.exe'] })))
  check('exe illisible, autre nom : rien', !matchProcess(byPid(700), spec({ dirs: [GAME], names: ['portal2.exe'] })))
  check('redistribuable du dossier (plateforme) : ignoré', !matchProcess(byPid(800), spec({ dirs: [GAME] })))
  check('programme ignoré (ignore)', !matchProcess(byPid(100), spec({ dirs: [GAME], ignore: ['portal2_linux'] })))
  check('jeu local lancé par un script (sh jeu.sh)', matchProcess(byPid(900), spec({ dirs: ['/home/u/Games/Celeste'], platform: false })))
  check('processus de CyberDeck : jamais compté', !matchProcess(byPid(100), spec({ dirs: [GAME], selfPid: 100 })))
  check('dossier préfixe d’un autre (Portal 2 vs Portal 22)', !matchProcess(byPid(100), spec({ dirs: ['/home/u/.local/share/Steam/steamapps/common/Portal'] })))

  // ---------- Surveillant complet (jeu de plateforme) ----------
  const runWatcher = (opts, during) =>
    new Promise((resolve) => {
      const lines = []
      const w = startProcWatcher({ procRoot: proc, io, intervalMs: 40, ...opts })
      let buf = ''
      w.stdout.setEncoding('utf8')
      w.stdout.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, i))
          buf = buf.slice(i + 1)
        }
      })
      w.on('close', (code) => resolve({ code, lines }))
      during?.(w)
    })

  const LATER = '/home/u/.local/share/Steam/steamapps/common/Hades'
  let r = await runWatcher({ mode: 'platform', dirs: [LATER], steamAppId: 1145360, graceSeconds: 5, maxWaitSeconds: 10 }, async (w) => {
    w.markLaunched()
    await sleep(150)
    addProc(1000, { exe: LATER + '/Hades', cmdline: [LATER + '/Hades'], comm: 'Hades', ticks: 1 })
    await sleep(200)
    removeProc(1000)
  })
  check('plateforme : launched, started, ended, code 0', r.code === 0 && r.lines[0] === 'launched' && r.lines.some((l) => l.startsWith('started:')) && r.lines.at(-1).startsWith('ended:'), JSON.stringify(r))
  const startedAt = Number(r.lines.find((l) => l.startsWith('started:'))?.slice(8))
  check('started : heure de démarrage du processus', startedAt === BTIME * 1000 + 10, String(startedAt))

  r = await runWatcher({ mode: 'platform', dirs: ['/nulle/part'], steamAppId: 1, graceSeconds: 0.1, maxWaitSeconds: 0.3 })
  check('plateforme sans jeu : expired puis code 5', r.code === 5 && r.lines.some((l) => l.startsWith('expired:')), JSON.stringify(r))

  let busy = true
  r = await runWatcher({ mode: 'platform', dirs: ['/nulle/part'], steamAppId: 1, graceSeconds: 0.1, maxWaitSeconds: 0.3, steamBusy: () => busy })
  check('Steam prépare le jeu (RunningAppID) : pas de expired', r.code === 5 && !r.lines.some((l) => l.startsWith('expired:')), JSON.stringify(r))

  r = await runWatcher({ mode: 'platform', dirs: ['/nulle/part'] }, (w) => setTimeout(() => w.fail('xdg-open introuvable'), 30))
  check('adresse steam:// impossible à ouvrir : code 3', r.code === 3, JSON.stringify(r))

  r = await runWatcher({ mode: 'platform', dirs: ['/nulle/part'] }, (w) => setTimeout(() => w.kill(), 30))
  check('arrêt par CyberDeck : code null', r.code === null, JSON.stringify(r))

  // ---------- Surveillant complet (jeu local) ----------
  const child = new EventEmitter()
  r = await runWatcher({ mode: 'local', dirs: ['/home/u/Games/Celeste-absent'], child }, async () => {
    await sleep(10)
    child.emit('spawn')
    await sleep(150)
    child.emit('exit', 0)
  })
  check('local : launched puis ended après la fin du programme', r.code === 0 && r.lines[0] === 'launched' && r.lines.at(-1).startsWith('ended:'), JSON.stringify(r))

  const bad = new EventEmitter()
  r = await runWatcher({ mode: 'local', dirs: [], child: bad }, () => setTimeout(() => bad.emit('error', new Error('spawn EACCES')), 10))
  check('local : programme qui ne démarre pas : code 3', r.code === 3 && !r.lines.includes('launched'), JSON.stringify(r))

  // ---------- Vrai /proc (Linux seulement : CI) ----------
  if (process.platform === 'linux') {
    const real = listProcesses()
    const me = real.find((p) => p.pid === process.pid)
    check('vrai /proc : ce processus est vu', !!me && !!me.exe && me.startMs > 0, JSON.stringify(me && { exe: me.exe, startMs: me.startMs }))
    check('vrai /proc : jamais compté soi-même', !matchProcess(me, spec({ dirs: [path.dirname(me.exe)], selfPid: process.pid })))
  }
} catch (e) {
  failed++
  console.log('FAIL exception : ' + (e?.stack ?? e))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${passed} ok, ${failed} échec(s)`)
process.exit(failed ? 1 : 0)
