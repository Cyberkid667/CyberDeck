// Bibliothèque de jeux : installation depuis un torrent, détection du jeu
// installé, jeux des plateformes (Steam, Epic…), jaquettes Steam, lancement et
// temps de jeu.
import { app, nativeImage, net, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanGameName } from '../shared/gameName'
import { PLATFORM_INFO } from '../shared/platforms'
import { locale, t as tr } from '../shared/i18n'
import type {
  ActionResult,
  Game,
  GameInput,
  InstallResult,
  LauncherPlatform,
  LibraryState,
  Notice,
  PlatformSkip,
  ScanCandidate,
  TorrentSummary,
  UninstallPlan
} from '../shared/types'
import type { DetectedGame, PlatformScan } from './platforms'
import { takeSnapshot, type UninstallEntry as RegUninstallEntry } from './platforms/registry'
import { steamLocalCover } from './platforms/steam'
import { cleanPsError, PS_RESTRICTED, PS_RESTRICTED_CHECK, runPs, startPs } from './powershell'

interface Deps {
  log: (message: string) => void
  notice: (n: Notice) => void
  broadcast: (s: LibraryState) => void
  installDone: (r: InstallResult) => void
  torrentById: (id: string) => TorrentSummary | undefined
  // Un torrent en partage garde ses fichiers ouverts : Windows refuse alors de
  // lancer un .exe qu'il contient. On le met en pause le temps de l'utiliser.
  releaseTorrent: (id: string) => Promise<boolean>
  resumeTorrent: (id: string) => void
  /** le protocole (steam:, origin2:…) est enregistré dans Windows (dernière lecture du registre) */
  protocolAvailable: (scheme: string) => boolean
}

interface Session {
  /** null : jeu de plateforme lancé, processus pas encore vu */
  startedAt: number | null
  launchedAt: number
  watcher: ChildProcess
  resumeTorrentId: string | null
  /** jeu de plateforme pas vu à temps : plus de « Démarrage… », surveillance silencieuse (compté s'il démarre) */
  expired: boolean
  /** dernier relevé où le jeu tournait (fin de la partie, donnée par le script) */
  lastAliveAt: number | null
}

let deps: Deps
let games: Game[] = []
/** jeux de plateforme retirés à la main (« steam:221100 ») : jamais rajoutés par la détection */
let hidden = new Set<string>()
const running = new Map<string, Session>()
const installing = new Set<string>()

const libraryPath = (): string => path.join(app.getPath('userData'), 'library.json')
export const coversDir = (): string => path.join(app.getPath('userData'), 'covers')
const coverFile = (id: string): string => path.join(coversDir(), `${id}.jpg`)
const iconFile = (id: string): string => path.join(coversDir(), `${id}-icon.png`)
export const imageFileFor = (kind: string, id: string): string | null =>
  /^[a-f0-9-]{36}$/.test(id) ? (kind === 'cover' ? coverFile(id) : kind === 'icon' ? iconFile(id) : null) : null

const platformKey = (platform: string, platformId: string | null): string => `${platform}:${platformId ?? ''}`

// ---------- Sauvegarde ----------

/** Valeurs par défaut des champs ajoutés après la 0.2 (et des plateformes en 0.4). */
function normalizeGame(g: Partial<Game>): Game {
  return {
    args: null,
    coverHint: null,
    coverTriedAt: null,
    platform: 'local',
    platformId: null,
    installed: true,
    owned: null,
    launch: null,
    watch: null,
    platformPlayTimeSeconds: null,
    platformLastPlayedAt: null,
    platformState: null,
    iconHint: null,
    // fichier retouché à la main ou abîmé : jamais de champ indispensable manquant
    name: '',
    exePath: '',
    installDir: null,
    torrentId: null,
    coverVersion: 0,
    coverShape: null,
    iconVersion: 0,
    steamAppId: null,
    addedAt: 0,
    lastPlayedAt: null,
    playTimeSeconds: 0,
    ...g
  } as Game
}

export function initLibrary(d: Deps): void {
  deps = d
  try {
    fs.mkdirSync(coversDir(), { recursive: true })
  } catch (err: any) {
    deps.log(`Dossier des jaquettes impossible à créer : ${err.message}`)
  }
  let text: string | null = null
  try {
    text = fs.readFileSync(libraryPath(), 'utf8')
  } catch (err: any) {
    if (err.code !== 'ENOENT') deps.log(`library.json illisible : ${err.message}`)
  }
  if (text !== null) {
    try {
      // « UTF-8 avec BOM » (fichier retouché à la main) : lisible quand même
      const parsed = JSON.parse(text.replace(/^﻿/, ''))
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.games)) throw new Error('liste des jeux absente')
      const saved = (parsed.games as unknown[]).filter(
        (g): g is Partial<Game> => !!g && typeof g === 'object' && typeof (g as Game).id === 'string'
      )
      games = saved.map(normalizeGame)
      hidden = new Set(Array.isArray(parsed.hidden) ? parsed.hidden.filter((k: unknown) => typeof k === 'string') : [])
    } catch (err: any) {
      // Fichier abîmé : gardé à côté avant que la prochaine sauvegarde ne le remplace.
      const backup = `${libraryPath()}.illisible-${Date.now()}`
      try {
        fs.copyFileSync(libraryPath(), backup)
        deps.log(`library.json illisible (${err.message}) : copie gardée dans ${backup}, bibliothèque repartie de zéro`)
      } catch (copyErr: any) {
        deps.log(`library.json illisible (${err.message}), copie impossible : ${copyErr.message}`)
      }
    }
  }
  setTimeout(refreshMissingArt, 3000)
}

/** Pas de réseau : une seule nouvelle tentative 30 min plus tard (pas de relance en boucle). */
let artRetryTimer: NodeJS.Timeout | null = null
function retryArtLater(): void {
  if (artRetryTimer) return
  artRetryTimer = setTimeout(() => {
    artRetryTimer = null
    refreshMissingArt()
  }, 30 * 60_000)
  artRetryTimer.unref?.()
}

// Au démarrage : icônes manquantes, et jaquettes jamais trouvées (une fois par jour).
function refreshMissingArt(): void {
  const day = 24 * 3600 * 1000
  for (const g of games) {
    if (!g.iconVersion) void refreshIcon(g.id)
    if (!g.coverVersion && (!g.coverTriedAt || Date.now() - g.coverTriedAt > day)) void searchCover(g.id)
  }
}

export function libraryState(): LibraryState {
  const started = [...running].filter(([, s]) => s.startedAt !== null)
  // surveillance silencieuse (démarrage trop long) : ni « En jeu » ni « Démarrage… »
  const waiting = [...running].filter(([, s]) => s.startedAt === null && !s.expired)
  return {
    games,
    running: Object.fromEntries(started.map(([id, s]) => [id, s.startedAt as number])),
    launching: Object.fromEntries(waiting.map(([id, s]) => [id, s.launchedAt])),
    installing: [...installing]
  }
}

function save(): void {
  const tmp = libraryPath() + '.tmp'
  const data = JSON.stringify({ version: 2, games, hidden: [...hidden] }, null, 1)
  try {
    fs.writeFileSync(tmp, data)
    try {
      fs.renameSync(tmp, libraryPath())
    } catch {
      // library.json ouvert par un antivirus ou un outil de synchronisation (EPERM, EBUSY) :
      // écriture directe plutôt qu'une bibliothèque jamais enregistrée
      fs.writeFileSync(libraryPath(), data)
      fs.rm(tmp, { force: true }, () => {})
    }
  } catch (err: any) {
    deps.log(`Sauvegarde de la bibliothèque impossible : ${err.message}`)
  }
}

let soonTimer: NodeJS.Timeout | null = null

function changed(): void {
  if (soonTimer) {
    clearTimeout(soonTimer)
    soonTimer = null
  }
  save()
  deps.broadcast(libraryState())
}

// Pour les images qui arrivent en rafale (première détection des plateformes) :
// une seule sauvegarde par demi-seconde.
function changedSoon(): void {
  if (soonTimer) return
  soonTimer = setTimeout(() => {
    soonTimer = null
    changed()
  }, 500)
}

const findGame = (id: string): Game | undefined => games.find((g) => g.id === id)

// ---------- PowerShell (Windows) ----------

// Lance un programme ou une adresse (steam://…) comme un double-clic (fenêtre
// UAC si besoin) et donne son processus. Code 4 : autorisation administrateur refusée.
// Code 6 (PS_RESTRICTED) : PowerShell en mode restreint, rien n'est lancé (voir launchRestricted).
// « launched » : le programme a bien démarré (une sortie imprévue ensuite n'est pas un échec du lancement).
const LAUNCH =
  PS_RESTRICTED_CHECK +
  String.raw`
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$si = New-Object System.Diagnostics.ProcessStartInfo
$si.FileName = $env:ESSAIM_TARGET
$si.WorkingDirectory = $env:ESSAIM_CWD
if ($env:ESSAIM_ARGS) { $si.Arguments = $env:ESSAIM_ARGS }
$si.UseShellExecute = $true
try {
  $p = [System.Diagnostics.Process]::Start($si)
} catch {
  $e = $_.Exception
  if ($e.InnerException) { $e = $e.InnerException }
  if ($e.NativeErrorCode -eq 1223) { exit 4 }
  [Console]::Error.WriteLine($e.Message)
  exit 3
}
try { [Console]::Out.WriteLine('launched'); [Console]::Out.Flush() } catch {}
`

const INSTALL_SCRIPT =
  LAUNCH +
  String.raw`
if ($p) {
  $p.WaitForExit()
  try { [Console]::Out.WriteLine("exit:" + $p.ExitCode) } catch {}
}
exit 0
`

// Le jeu compte comme lancé tant que son processus, ou un autre programme de
// son dossier (lanceur → jeu), tourne encore. Le chemin des processus vient de
// QueryFullProcessImageName : lisible aussi pour un jeu lancé en administrateur.
//   Jeu local : on attend la fin du processus lancé, puis celle du dossier.
//   Jeu de plateforme (ESSAIM_MODE=platform) : le programme lancé est le lanceur
//   (Steam, Epic…), qui reste ouvert : on ne suit que le dossier du jeu.
//   « started:<ms> » est écrit quand un processus du jeu apparaît. Sans jeu au bout de
//   ESSAIM_GRACE secondes : « expired » (l'interface retire « Démarrage… »), puis la
//   surveillance continue en silence jusqu'à ESSAIM_MAX_WAIT secondes (mise à jour dans
//   le lanceur…) ; rien vu d'ici là : code 5. Pour Steam, RunningAppID = appid ne prouve
//   jamais que le jeu tourne (un outil tiers peut se déclarer avec cet appid) : il
//   prolonge seulement l'attente visible (Steam prépare le lancement).
//   « ended:<ms> » : dernier relevé où le jeu tournait (le temps compté s'arrête là).
const PLAY_SCRIPT =
  LAUNCH +
  String.raw`
$fast = $false
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CtProc {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder buf, ref int size);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  public static string PathOf(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      StringBuilder sb = new StringBuilder(1024);
      int n = sb.Capacity;
      return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString(0, n) : null;
    } finally { CloseHandle(h); }
  }
}
'@
  $fast = $true
} catch {}
function Split-List([string]$s) { if (-not $s) { return @() }; return @($s.Split('|') | Where-Object { $_ }) }
$dirs = @(Split-List $env:ESSAIM_DIR | ForEach-Object { $_.TrimEnd('\') + '\' })
$names = @(Split-List $env:ESSAIM_NAMES | ForEach-Object { $_.ToLowerInvariant() })
$ignore = @(Split-List $env:ESSAIM_IGNORE | ForEach-Object { $_.ToLowerInvariant() })
$platform = $env:ESSAIM_MODE -eq 'platform'
$steamApp = 0
if ($env:ESSAIM_STEAM_APPID) { [void][int]::TryParse($env:ESSAIM_STEAM_APPID, [ref]$steamApp) }
# installateurs de prérequis lancés par le lanceur depuis le dossier du jeu : pas le jeu
$skipDir = '\\(_?CommonRedist|_?Redist|Redistributables?|__Installer|DirectX|Prereq[^\\]*|Support)\\'
$skipExe = '^(dxsetup|vc_?redist.*|vcredist.*|ue\d?prereqsetup.*|dotnetfx.*|ndp\d.*|oalinst|physx.*)\.exe$'
function Now-Ms { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Say([string]$s) { try { [Console]::Out.WriteLine($s); [Console]::Out.Flush() } catch {} }
# Steam prépare ou lance ce jeu (RunningAppID) : raison d'attendre plus longtemps, jamais une preuve qu'il tourne
$steamKey = 'HKCU:\Software\Valve\Steam'
if ($env:ESSAIM_STEAM_KEY) { $steamKey = $env:ESSAIM_STEAM_KEY }
function Steam-Busy {
  if ($steamApp -le 0) { return $false }
  try { return ([int64](Get-ItemProperty -LiteralPath $steamKey -Name RunningAppID -ErrorAction Stop).RunningAppID -eq $steamApp) } catch { return $false }
}
# heure de démarrage du processus trouvé (ms), si Windows la donne : le temps compté part de là
$script:hitStart = 0
function Hit($proc) {
  $script:hitStart = 0
  try { $script:hitStart = ([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds() } catch {}
  return $true
}
function Test-Alive {
  foreach ($proc in [System.Diagnostics.Process]::GetProcesses()) {
    if ($proc.Id -eq $PID) { continue }
    $exe = ($proc.ProcessName + '.exe').ToLowerInvariant()
    if ($ignore -contains $exe) { continue }
    if ($platform -and $exe -match $skipExe) { continue }
    $path = $null
    if ($fast) { $path = [CtProc]::PathOf($proc.Id) } else { try { $path = $proc.Path } catch {} }
    if ($path) {
      if ($platform -and $path -match $skipDir) { continue }
      foreach ($d in $dirs) { if ($path.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return (Hit $proc) } }
    } elseif ($names.Count -gt 0 -and ($names -contains $exe)) { return (Hit $proc) }
  }
  return $false
}
if ($platform) {
  $grace = 120
  if ($env:ESSAIM_GRACE) { [void][int]::TryParse($env:ESSAIM_GRACE, [ref]$grace) }
  $maxWait = 900
  if ($env:ESSAIM_MAX_WAIT) { [void][int]::TryParse($env:ESSAIM_MAX_WAIT, [ref]$maxWait) }
  if ($maxWait -lt $grace) { $maxWait = $grace }
  $t0 = [DateTime]::UtcNow
  $started = $false
  $expired = $false
  $empty = 0
  $last = 0
  while ($true) {
    if (Test-Alive) {
      $empty = 0
      $last = Now-Ms
      if (-not $started) {
        $started = $true
        $from = $last
        if ($script:hitStart -gt 0 -and $script:hitStart -lt $last) { $from = $script:hitStart }
        Say ('started:' + $from)
      }
    } elseif ($started) {
      $empty++
      if ($empty -ge 3) { break }
    } else {
      $waited = ([DateTime]::UtcNow - $t0).TotalSeconds
      if ($waited -ge $maxWait) { exit 5 }
      if (-not $expired -and $waited -ge $grace -and -not (Steam-Busy)) { $expired = $true; Say ('expired:' + [int]$waited) }
    }
    Start-Sleep -Seconds 3
  }
  Say ('ended:' + $last)
  exit 0
}
$empty = 0
$last = Now-Ms
while ($true) {
  Start-Sleep -Seconds 3
  if ($p -and -not $p.HasExited) { $empty = 0; $last = Now-Ms; continue }
  if (Test-Alive) { $empty = 0; $last = Now-Ms } else { $empty++ }
  if ($empty -ge 2) { break }
}
Say ('ended:' + $last)
exit 0
`

const UNINSTALL_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$paths = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$list = @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ key = [string]$_.PSPath; name = [string]$_.DisplayName; location = [string]$_.InstallLocation; icon = [string]$_.DisplayIcon }
})
ConvertTo-Json -InputObject $list -Compress
`

// ---------- Détection du jeu installé ----------

interface UninstallEntry {
  key: string
  name: string
  location: string
  icon: string
}

async function uninstallEntries(): Promise<UninstallEntry[]> {
  // PowerShell bloqué (antivirus…) : l'installation ou l'import n'attend pas indéfiniment
  const res = await runPs(UNINSTALL_SCRIPT, {}, 60_000)
  try {
    const parsed = JSON.parse(res.stdout.trim() || '[]')
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    deps.log(`Lecture des programmes installés impossible : ${res.stderr.trim()}`)
    return []
  }
}

// Entrées créées par les lanceurs (Steam qui finit une mise à jour pendant
// l'installation d'un torrent…) : jamais le jeu que l'on vient d'installer.
const LAUNCHER_UNINSTALL_KEY = /\\(Steam App \d+|Uplay Install \d+|Riot Game [^\\]+)$/i

function shortcutDirs(): string[] {
  return [
    app.getPath('desktop'),
    path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ]
}

async function listShortcuts(): Promise<Map<string, number>> {
  const found = new Map<string, number>()
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.lnk')) {
        const st = await fsp.stat(p).catch(() => null)
        if (st) found.set(p, st.mtimeMs)
      }
    }
  }
  for (const dir of shortcutDirs()) await walk(dir, 0)
  return found
}

const NOT_GAME_EXE =
  /(unins\d*|uninstall|setup|install|redist|dxsetup|vc_?redist|crash|report|helper|prereq|dotnet|physx|7z|update)/i

function isGameExe(p: string | null | undefined): p is string {
  return !!p && /\.exe$/i.test(p) && !NOT_GAME_EXE.test(path.basename(p))
}

function exeFromIcon(icon: string | null | undefined): string | null {
  if (!icon) return null
  return icon.trim().replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, '')
}

// Le plus gros .exe d'un dossier est en général le jeu lui-même.
async function largestExe(root: string): Promise<string | null> {
  let best: { p: string; size: number } | null = null
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 3 && !/(redist|directx|support|_commonredist|tools)/i.test(e.name)) await walk(p, depth + 1)
      } else if (isGameExe(p)) {
        const size = (await fsp.stat(p).catch(() => null))?.size ?? 0
        if (!best || size > best.size) best = { p, size }
      }
    }
  }
  await walk(root, 0)
  return (best as { p: string } | null)?.p ?? null
}

const inside = (file: string, dir: string): boolean =>
  !!file && !!dir && path.resolve(file).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)

const sameDir = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

async function guessInstalled(
  before: { entries: UninstallEntry[]; shortcuts: Map<string, number> },
  startedAt: number,
  fallbackName: string
): Promise<InstallResult['guess']> {
  const known = new Set(before.entries.map((e) => e.key))
  const entry = (await uninstallEntries()).find((e) => !known.has(e.key) && e.name && !LAUNCHER_UNINSTALL_KEY.test(e.key)) ?? null
  const installDir = entry?.location?.trim() ? path.resolve(entry.location.trim()) : null
  const name = entry?.name ? cleanGameName(entry.name) : fallbackName

  // Raccourcis créés pendant l'installation (Bureau, menu Démarrer).
  const links: { name: string; target: string }[] = []
  for (const [p, mtime] of await listShortcuts()) {
    if (before.shortcuts.has(p) && mtime < startedAt) continue
    try {
      const target = shell.readShortcutLink(p).target
      if (isGameExe(target) && fs.existsSync(target)) links.push({ name: path.basename(p, '.lnk'), target })
    } catch {
      // raccourci illisible : ignoré
    }
  }
  const link = (installDir && links.find((l) => inside(l.target, installDir))) || links[0]
  if (link) return { name: entry ? name : cleanGameName(link.name), exePath: link.target, installDir: installDir ?? path.dirname(link.target) }

  const iconExe = exeFromIcon(entry?.icon)
  if (isGameExe(iconExe) && fs.existsSync(iconExe)) return { name, exePath: iconExe, installDir: installDir ?? path.dirname(iconExe) }

  if (installDir && fs.existsSync(installDir)) return { name, exePath: await largestExe(installDir), installDir }
  return { name, exePath: null, installDir: null }
}

// ---------- Installation ----------

export async function installFromTorrent(t: TorrentSummary): Promise<void> {
  const fallbackName = cleanGameName(t.name)
  const fail = (error: string): void =>
    deps.installDone({ torrentId: t.id, ok: false, error, guess: { name: fallbackName, exePath: null, installDir: null } })
  if (!t.installer || installing.has(t.id)) return
  if (!fs.existsSync(t.installer)) return fail(tr('main.install.installerMissing', { path: t.installer }))

  installing.add(t.id)
  deps.broadcast(libraryState())
  const wasSharing = await deps.releaseTorrent(t.id)
  try {
    const before = { entries: await uninstallEntries(), shortcuts: await listShortcuts() }
    const startedAt = Date.now()
    deps.log(`Installation de ${t.name} avec ${t.installer}`)
    const res = await runPs(INSTALL_SCRIPT, { ESSAIM_TARGET: t.installer, ESSAIM_CWD: path.dirname(t.installer) })
    const exitCode = Number((res.stdout.match(/exit:(-?\d+)/) || [])[1] ?? 0)
    deps.log(`Installateur terminé (powershell ${res.code}, installateur ${exitCode})${res.stderr ? ` : ${res.stderr}` : ''}`)
    if (res.code === 4) return fail(tr('main.install.adminDenied'))
    if (res.code === PS_RESTRICTED) {
      shell.showItemInFolder(t.installer)
      return fail(tr('main.install.psRestricted'))
    }
    if (res.code !== 0) return fail(tr('main.install.cantStart', { error: res.stderr.trim() || tr('main.common.unknownError') }))
    // Codes d'annulation des installateurs Inno Setup, les plus courants.
    if (exitCode === 2 || exitCode === 5) return fail(tr('main.install.cancelled'))
    deps.installDone({ torrentId: t.id, ok: true, guess: await guessInstalled(before, startedAt, fallbackName) })
  } catch (err: any) {
    fail(tr('main.install.failed', { error: err.message }))
  } finally {
    if (wasSharing) deps.resumeTorrent(t.id)
    installing.delete(t.id)
    deps.broadcast(libraryState())
  }
}

// ---------- Jaquettes et icônes ----------

async function fetchBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

/** Chemin de fichier local (C:\…) plutôt qu'une adresse web. */
const isLocalFile = (p: string | null | undefined): p is string => !!p && /^[a-z]:[\\/]/i.test(p)

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')

// Nom d'un jeu de plateforme sans sa mention d'édition (« Grand Theft Auto V
// Enhanced » → « Grand Theft Auto V »), pour chercher une jaquette.
const EDITION =
  /\s*[-–:]?\s*\b(enhanced( edition)?|remastered|definitive edition|complete edition|game of the year edition|goty( edition)?|era|deluxe edition|ultimate edition|anniversary edition|director'?s cut|launcher|for windows( 10| 11)?)$/i

function nameCandidates(name: string): string[] {
  const out = [name.trim()]
  let n = name.trim()
  for (let i = 0; i < 2; i++) {
    const m = n.replace(EDITION, '').trim()
    if (!m || m === n) break
    out.push(m)
    n = m
  }
  return [...new Set(out)]
}

// exactOnly : jeu d'une autre plateforme (Fortnite, World of Warcraft…) : on ne
// prend pas « le premier résultat » s'il ne porte pas le même nom (noms anglais
// des lanceurs, d'où la recherche en anglais).
async function findSteamApp(name: string, exactOnly = false): Promise<number | null> {
  if (exactOnly) {
    for (const term of nameCandidates(name)) {
      const res = await net.fetch(
        `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`,
        { signal: AbortSignal.timeout(10_000) }
      )
      if (!res.ok) continue
      const items: { id: number; name: string }[] = (await res.json())?.items ?? []
      const hit = items.find((i) => norm(i.name) === norm(term))
      if (hit) return hit.id
    }
    return null
  }
  const terms = [...new Set([name, name.split(/\s[-–:]\s|:\s/)[0]].map((s) => s.trim()).filter(Boolean))]
  for (const term of terms) {
    const res = await net.fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=french&cc=FR`,
      { signal: AbortSignal.timeout(10_000) }
    )
    if (!res.ok) continue
    const items: { id: number; name: string }[] = (await res.json())?.items ?? []
    if (!items.length) continue
    const exact = items.find((i) => norm(i.name) === norm(name)) ?? items.find((i) => norm(i.name) === norm(term))
    return (exact ?? items[0]).id
  }
  return null
}

const STEAM_CDNS = [
  'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps',
  'https://cdn.akamai.steamstatic.com/steam/apps'
]

async function steamArt(appId: number): Promise<Buffer | null> {
  for (const cdn of STEAM_CDNS) {
    const bytes = await fetchBytes(`${cdn}/${appId}/library_600x900.jpg`)
    if (bytes) return bytes
  }
  // Jeux récents : l'image a une adresse avec un code, donnée par l'API de la boutique.
  try {
    const input = { ids: [{ appid: appId }], context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } }
    const res = await net.fetch(
      `https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`,
      { signal: AbortSignal.timeout(10_000) }
    )
    const assets = res.ok ? (await res.json())?.response?.store_items?.[0]?.assets : null
    if (assets?.asset_url_format) {
      for (const key of ['library_capsule_2x', 'library_capsule', 'header']) {
        if (!assets[key]) continue
        const file = String(assets.asset_url_format).replace('${FILENAME}', assets[key])
        const bytes = await fetchBytes(`https://shared.akamai.steamstatic.com/store_item_assets/${file}`)
        if (bytes) return bytes
      }
    }
  } catch {
    // on tente l'ancienne adresse ci-dessous
  }
  for (const cdn of STEAM_CDNS) {
    const bytes = await fetchBytes(`${cdn}/${appId}/header.jpg`)
    if (bytes) return bytes
  }
  return null
}

// Image d'illustration de l'article Wikipédia (anglais) du jeu, s'il y en a un.
// strict (jeu de plateforme) : le titre de l'article doit être le nom du jeu (avec
// ou sans sa mention d'édition), pas seulement celui de la série.
async function wikipediaCover(name: string, strict = false): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=${strict ? 5 : 3}&prop=pageimages&piprop=original&pilicense=any&gsrsearch=` +
    encodeURIComponent(`${name} video game`)
  const res = await net.fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return null
  const pages: { title: string; index: number; original?: { source: string } }[] = Object.values((await res.json())?.query?.pages ?? {})
  const wanted = norm(name)
  const accepted = new Set(nameCandidates(name).map(norm))
  const page = pages
    .sort((a, b) => a.index - b.index)
    .find((p) => {
      const title = norm(p.title.replace(/\(.*\)/, ''))
      if (!p.original || /\.svg$/i.test(p.original.source)) return false
      return strict ? accepted.has(title) : title.includes(wanted) || wanted.includes(title)
    })
  return page?.original?.source ?? null
}

async function storeCover(g: Game, bytes: Buffer, appId: number | null): Promise<boolean> {
  const img = nativeImage.createFromBuffer(bytes)
  let data = bytes
  let shape: Game['coverShape'] = 'portrait'
  if (!img.isEmpty()) {
    const { width, height } = img.getSize()
    // jeu de plateforme : une image carrée (logo du Microsoft Store) est montrée en entier
    shape = height >= width * (g.platform === 'local' ? 1 : 1.15) ? 'portrait' : 'landscape'
    data = img.toJPEG(90)
  }
  await fsp.writeFile(coverFile(g.id), data)
  // l'appid d'un jeu Steam est le vrai : une recherche par nom ne le remplace pas
  if (appId && g.platform !== 'steam') g.steamAppId = appId
  g.coverShape = shape
  g.coverVersion++
  changed()
  return true
}

// Jeu local : jeu Steam connu → image indiquée → recherche Steam par nom → Wikipédia.
// Jeu de plateforme : image de la plateforme → appid Steam → cache local de Steam
// → recherche Steam par nom exact → Wikipédia.
// fresh = nouvelle recherche par nom (bouton « Chercher sur Steam »).
// steamAppId 0 veut dire « pas sur Steam » : on ne cherche pas sur Steam.
async function findCover(id: string, fresh: boolean): Promise<boolean> {
  const g0 = findGame(id)
  if (!g0) return false
  const name = g0.name
  // jeu de plateforme hors ligne : le logo local sert quand même, et la recherche
  // en ligne sera retentée au prochain démarrage (pas d'attente d'un jour)
  let offline = false
  const online = <T>(p: Promise<T | null>): Promise<T | null> =>
    p.catch(() => {
      offline = true
      return null
    })
  try {
    let bytes: Buffer | null = null
    let appId: number | null = null
    if (g0.platform === 'local') {
      if (!fresh && g0.steamAppId) {
        appId = g0.steamAppId
        bytes = await steamArt(appId)
      }
      if (!bytes && !fresh && g0.coverHint) bytes = await fetchBytes(g0.coverHint)
      if (!bytes && (fresh || g0.steamAppId !== 0)) {
        appId = await findSteamApp(name)
        if (appId) bytes = await steamArt(appId)
      }
    } else {
      const steamGame = g0.platform === 'steam' && !!g0.steamAppId
      // image de la plateforme : adresse web, ou fichier local (logo d'un jeu du Microsoft Store)
      const localHint = !!g0.coverHint && isLocalFile(g0.coverHint)
      if (g0.coverHint && !localHint && (!fresh || steamGame)) bytes = await fetchBytes(g0.coverHint)
      if (!bytes && g0.steamAppId && (!fresh || steamGame)) {
        appId = g0.steamAppId
        bytes = await steamArt(appId)
      }
      if (!bytes && steamGame) {
        const local = steamLocalCover(g0.steamAppId!)
        if (local) bytes = await fsp.readFile(local).catch(() => null)
      }
      if (!bytes && !steamGame && (fresh || g0.steamAppId !== 0)) {
        appId = await online(findSteamApp(name, true))
        if (appId) bytes = await steamArt(appId)
      }
    }
    if (!bytes) {
      appId = null
      const url = g0.platform === 'local' ? await wikipediaCover(name) : await online(wikipediaCover(name, true))
      if (url) bytes = await fetchBytes(url)
    }
    if (!bytes && g0.platform !== 'local' && g0.coverHint && isLocalFile(g0.coverHint))
      bytes = await fsp.readFile(g0.coverHint).catch(() => null)
    const g = findGame(id)
    if (!g) return false
    if (!bytes && offline) {
      retryArtLater()
      return false
    }
    g.coverTriedAt = Date.now()
    if (!bytes) {
      deps.log(`Pas de jaquette trouvée pour « ${name} »`)
      changedSoon()
      return false
    }
    return await storeCover(g, bytes, appId)
  } catch (err: any) {
    // hors ligne : nouvelle tentative plus tard, sans une ligne de journal par jeu
    if (!net.isOnline()) retryArtLater()
    else deps.log(`Recherche de jaquette impossible pour « ${name} » : ${err.message}`)
    return false
  }
}

// Une recherche à la fois, pour rester poli avec Steam et Wikipédia ; une
// demande de l'utilisateur passe devant les recherches de fond.
const coverQueue: { id: string; fresh: boolean; resolve: (ok: boolean) => void }[] = []
let coverBusy = false

async function pumpCovers(): Promise<void> {
  if (coverBusy) return
  coverBusy = true
  try {
    while (coverQueue.length) {
      const job = coverQueue.shift()!
      const g = findGame(job.id)
      // recherche de fond pour un jeu qui a déjà une image (ou qui a été retiré) : rien à faire
      if (!g || (!job.fresh && g.coverVersion > 0)) {
        job.resolve(!!g)
        continue
      }
      let ok = false
      try {
        ok = await findCover(job.id, job.fresh)
      } catch {
        ok = false
      }
      job.resolve(ok)
      await new Promise((r) => setTimeout(r, 300))
    }
  } finally {
    coverBusy = false
  }
}

export function searchCover(id: string, fresh = false): Promise<boolean> {
  return new Promise((resolve) => {
    if (fresh) coverQueue.unshift({ id, fresh, resolve })
    else if (coverQueue.some((j) => j.id === id && !j.fresh)) return resolve(false)
    else coverQueue.push({ id, fresh, resolve })
    void pumpCovers()
  })
}

export async function setCoverFromFile(id: string, file: string): Promise<boolean> {
  const img = nativeImage.createFromPath(file)
  const g = findGame(id)
  if (img.isEmpty() || !g) return false
  const { width, height } = img.getSize()
  await fsp.writeFile(coverFile(id), img.toJPEG(90))
  g.coverShape = height >= width ? 'portrait' : 'landscape'
  g.coverVersion++
  changed()
  return true
}

// Icônes : trois extractions à la fois au plus, une seule par jeu (deux demandes
// simultanées du même fichier à Windows peuvent ne jamais répondre).
let iconSlots = 0
const iconWaiters: (() => void)[] = []
const iconJobs = new Set<string>()

async function withIconSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (iconSlots >= 3) await new Promise<void>((r) => iconWaiters.push(r))
  iconSlots++
  try {
    return await fn()
  } finally {
    iconSlots--
    iconWaiters.shift()?.()
  }
}

function fileIcon(file: string): Promise<Electron.NativeImage | null> {
  return Promise.race([
    app.getFileIcon(file, { size: 'large' }),
    new Promise<null>((r) => setTimeout(() => r(null), 20_000))
  ])
}

async function refreshIcon(id: string): Promise<void> {
  if (iconJobs.has(id)) return
  iconJobs.add(id)
  try {
    await withIconSlot(() => loadIcon(id))
  } finally {
    iconJobs.delete(id)
  }
}

/** Sans bloquer l'app : un disque réseau débranché peut mettre de longues secondes à répondre. */
const exists = (p: string | null | undefined): Promise<boolean> =>
  p ? fsp.access(p).then(
      () => true,
      () => false
    ) : Promise.resolve(false)

async function loadIcon(id: string): Promise<void> {
  const g = findGame(id)
  if (!g) return
  try {
    if (g.platform === 'local') {
      // Jeu lancé par un autre programme (explorer.exe pour un jeu du Microsoft Store) :
      // l'icône vient plutôt du programme principal de son dossier.
      let source = g.exePath
      if (g.installDir && !inside(g.exePath, g.installDir) && (await exists(g.installDir)))
        source = (await largestExe(g.installDir)) ?? g.exePath
      const icon = await fileIcon(source)
      if (!icon || icon.isEmpty()) return
      await fsp.writeFile(iconFile(id), icon.toPNG())
      g.iconVersion++
      changed()
      return
    }
    if (await exists(g.exePath)) {
      const icon = await fileIcon(g.exePath)
      if (icon && !icon.isEmpty()) {
        await fsp.writeFile(iconFile(id), icon.toPNG())
        g.iconVersion++
        changedSoon()
        return
      }
    }
    if (g.iconHint) {
      const bytes = await fetchBytes(g.iconHint)
      const img = bytes ? nativeImage.createFromBuffer(bytes) : null
      if (img && !img.isEmpty() && findGame(id)) {
        await fsp.writeFile(iconFile(id), img.toPNG())
        g.iconVersion++
        changedSoon()
      }
    }
  } catch (err: any) {
    deps.log(`Icône introuvable pour ${g.exePath || g.name} : ${err.message}`)
  }
}

// ---------- Importer un dossier de jeux ----------

const TOOL_EXE =
  /^(ds4windows|nucleuscoop|content manager|rpcs3|ryujinx|yuzu|suyu|dolphin|pcsx2|cemu|retroarch|duckstation|ppsspp|xenia|xemu|citra|vita3k|steam|playnite|x360ce)\.exe$/i

// Dossiers jamais utiles pour trouver le programme d'un jeu.
const SKIP_DIRS =
  /^(_?commonredist|_?redist|__?redist|redist|directx|__installer|installer|engine|md5|support|_support|extras?|bonus|soundtrack|ost|manuals?|docs?)$/i

async function listExes(root: string): Promise<{ rel: string; size: number }[]> {
  const found: { rel: string; size: number }[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length > 400) return
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 6 && !SKIP_DIRS.test(e.name)) await walk(p, depth + 1)
      } else if (isGameExe(p) && !/(anticheat|eosbootstrapper|ffmpeg|ffprobe|quicksfv|uplayinstaller)/i.test(e.name)) {
        const size = (await fsp.stat(p).catch(() => null))?.size ?? 0
        found.push({ rel: path.relative(root, p), size })
      }
    }
  }
  await walk(root, 0)
  return found
}

// Classe les .exe d'un dossier : nom proche du dossier, gros fichier, peu
// profond. Le petit lanceur à la racine d'un jeu Unreal passe avant le
// « -Win64-Shipping.exe » caché dans Binaries.
function rankExes(root: string, exes: { rel: string; size: number }[]): string[] {
  const folderWords = cleanGameName(path.basename(root)).toLowerCase().split(/\s+/).map(norm).filter((w) => w.length >= 3)
  const hasShipping = exes.some((e) => /-win64-shipping\.exe$/i.test(e.rel))
  const score = (e: { rel: string; size: number }): number => {
    const base = norm(path.basename(e.rel, '.exe'))
    const depth = e.rel.split(path.sep).length
    let s = Math.log10(Math.max(e.size, 1000))
    if (folderWords.some((w) => base.includes(w))) s += 3
    s -= (depth - 1) * 0.4
    if (hasShipping && /-win64-shipping\.exe$/i.test(e.rel) && exes.some((o) => o.rel.split(path.sep).length <= 2 && !/shipping/i.test(o.rel))) s -= 4
    if (hasShipping && depth <= 2 && !/shipping/i.test(e.rel)) s += 3
    return s
  }
  return [...exes].sort((a, b) => score(b) - score(a)).map((e) => path.join(root, e.rel))
}

export async function scanGamesFolder(dir: string): Promise<ScanCandidate[]> {
  const entries = await uninstallEntries()
  const links: { name: string; target: string; args: string }[] = []
  for (const p of (await listShortcuts()).keys()) {
    try {
      const link = shell.readShortcutLink(p)
      if (link.target) links.push({ name: path.basename(p, '.lnk'), target: link.target, args: link.args ?? '' })
    } catch {
      // raccourci illisible
    }
  }
  const subdirs = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())
  const result: ScanCandidate[] = []
  for (const sub of subdirs) {
    const root = path.join(dir, sub.name)
    const top = await fsp.readdir(root).catch(() => [] as string[])
    const exes = await listExes(root)
    const ranked = rankExes(root, exes)
    // Un jeu lancé par un autre programme (explorer.exe pour le Microsoft Store)
    // est reconnu par son dossier d'installation.
    const alreadyInLibrary = games.some(
      (g) =>
        (!!g.exePath && inside(g.exePath, root)) ||
        (!!g.installDir && (path.resolve(g.installDir).toLowerCase() === root.toLowerCase() || inside(g.installDir, root)))
    )
    const isInstaller = top.some((f) => /^setup.*\.exe$/i.test(f)) && top.some((f) => /\.bin$/i.test(f)) && ranked.length === 0
    const entry = entries.find((e) => e.location && path.resolve(e.location).toLowerCase() === root.toLowerCase())
    const link = links.find((l) => inside(l.target, root) && isGameExe(l.target))
    let exePath = link?.target ?? null
    const iconExe = exeFromIcon(entry?.icon)
    if (!exePath && isGameExe(iconExe) && inside(iconExe, root) && fs.existsSync(iconExe)) exePath = iconExe
    if (!exePath) exePath = ranked[0] ?? null
    const options = [...new Set([...(exePath ? [exePath] : []), ...ranked])].slice(0, 8)
    // Outil ou émulateur seul (pas de jeu installé par un installateur dans ce dossier).
    const isTool = !!exePath && !entry && TOOL_EXE.test(path.basename(exePath))
    result.push({
      folder: root,
      kind: isInstaller ? 'installer' : isTool ? 'tool' : exePath ? 'game' : 'empty',
      name: entry?.name ? cleanGameName(entry.name) : cleanGameName(sub.name),
      exePath: isInstaller ? null : exePath,
      args: link?.args || null,
      exeOptions: isInstaller ? [] : options,
      installDir: root,
      alreadyInLibrary
    })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, locale()))
}

export function defaultGamesFolder(): string {
  const systemDrive = process.env.SystemDrive || 'C:'
  const gamesDir = path.join(systemDrive + path.sep, 'Games')
  if (fs.existsSync(gamesDir)) return gamesDir
  // Documents redirigé vers OneDrive (dossier pas encore synchronisé) ou introuvable : dossier personnel
  try {
    const docs = app.getPath('documents')
    if (fs.existsSync(docs)) return docs
  } catch {
    // dossier connu de Windows illisible
  }
  return os.homedir()
}

// ---------- Ajouter, modifier, retirer ----------

function checkExe(exePath: string): void {
  if (!/\.exe$/i.test(exePath)) throw new Error(tr('main.game.chooseExe'))
  if (!fs.existsSync(exePath)) throw new Error(tr('main.game.exeNotFound', { path: exePath }))
}

export function addGame(input: GameInput): Game {
  checkExe(input.exePath)
  const g: Game = normalizeGame({
    id: randomUUID(),
    name: input.name.trim() || cleanGameName(path.basename(path.dirname(input.exePath))),
    exePath: input.exePath,
    args: input.args?.trim() || null,
    installDir: input.installDir || path.dirname(input.exePath),
    torrentId: input.torrentId ?? null,
    coverVersion: 0,
    coverShape: null,
    iconVersion: 0,
    steamAppId: input.steamAppId ?? null,
    coverHint: input.coverHint || null,
    coverTriedAt: null,
    addedAt: Date.now(),
    lastPlayedAt: null,
    playTimeSeconds: 0
  })
  games.push(g)
  changed()
  void refreshIcon(g.id)
  void searchCover(g.id)
  return g
}

export function importGames(inputs: GameInput[]): number {
  let added = 0
  for (const input of inputs) {
    try {
      addGame(input)
      added++
    } catch (err: any) {
      deps.log(`Import impossible pour ${input.exePath} : ${err.message}`)
    }
  }
  return added
}

export function updateGame(id: string, input: GameInput): Game | null {
  const g = findGame(id)
  if (!g) return null
  // Jeu de plateforme : seul le nom se modifie (le lancement passe par la plateforme).
  if (g.platform !== 'local') {
    g.name = input.name.trim() || g.name
    changed()
    return g
  }
  checkExe(input.exePath)
  g.name = input.name.trim() || g.name
  if (input.args !== undefined) g.args = input.args?.trim() || null
  if (input.exePath !== g.exePath) {
    g.exePath = input.exePath
    g.installDir = input.installDir || (g.installDir && inside(input.exePath, g.installDir) ? g.installDir : path.dirname(input.exePath))
    void refreshIcon(id)
  }
  changed()
  return g
}

export function removeGame(id: string): void {
  const g = findGame(id)
  // Un jeu de plateforme retiré n'est pas rajouté par la détection suivante.
  if (g && g.platform !== 'local' && g.platformId) hidden.add(platformKey(g.platform, g.platformId))
  games = games.filter((x) => x.id !== id)
  fs.rm(coverFile(id), { force: true }, () => {})
  fs.rm(iconFile(id), { force: true }, () => {})
  changed()
}

export function openGameFolder(id: string): void {
  const g = findGame(id)
  if (!g) return
  if (g.exePath && fs.existsSync(g.exePath)) shell.showItemInFolder(g.exePath)
  else if (g.installDir && fs.existsSync(g.installDir)) shell.openPath(g.installDir)
}

// ---------- Jouer ----------

// Dossier surveillé pour savoir si le jeu tourne encore : son dossier
// d'installation (même si le lanceur est ailleurs, ex. explorer.exe pour un
// jeu du Microsoft Store), jamais un dossier trop large (voir tooBroad). Aucun dossier
// convenable : seul le processus lancé est suivi.
function watchDirFor(g: Game): string[] {
  const exeDir = path.resolve(path.dirname(g.exePath))
  const dir = g.installDir && fs.existsSync(g.installDir) ? path.resolve(g.installDir) : exeDir
  if (!tooBroad(dir)) return withRealPaths([dir])
  return tooBroad(exeDir) ? [] : withRealPaths([exeDir])
}

/** Dossier connu de Windows, s'il est lisible. */
function knownDir(name: Parameters<typeof app.getPath>[0]): string | undefined {
  try {
    return app.getPath(name)
  } catch {
    return undefined
  }
}

/**
 * Dossier trop large pour suivre un jeu : n'importe quel programme qui en sort passerait pour
 * lui et la partie ne finirait jamais (racine d'un disque, Windows, Program Files, profil,
 * Bureau, Téléchargements, Documents).
 */
function tooBroad(dir: string): boolean {
  const r = path.resolve(dir)
  if (r === path.parse(r).root) return true
  const windows = process.env.SystemRoot || process.env.windir
  if (windows && (sameDir(r, windows) || inside(r, windows))) return true
  const broad = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    os.homedir(),
    knownDir('desktop'),
    knownDir('downloads'),
    knownDir('documents')
  ]
  return broad.some((b) => sameDir(r, b))
}

/**
 * Ajoute le chemin réel de chaque dossier (lecteur SUBST, lecteur réseau, jonction) : Windows
 * donne parfois ce chemin-là pour les processus qui en sortent.
 */
function withRealPaths(dirs: string[]): string[] {
  const out = new Set<string>()
  for (const d of dirs) {
    out.add(d)
    try {
      const real = fs.realpathSync.native(d)
      if (!tooBroad(real)) out.add(real)
    } catch {
      // dossier absent ou disque débranché : le chemin connu suffit
    }
  }
  return [...out]
}

/**
 * Lignes du script de surveillance : « started:<ms> » (jeu vu), « expired » (pas vu à temps,
 * surveillance silencieuse), « ended:<ms> » (dernier relevé où il tournait).
 */
function readWatcherLines(watcher: ChildProcess, onLine: (line: string) => void): void {
  let buf = ''
  watcher.stdout?.setEncoding('utf8')
  watcher.stdout?.on('data', (d: string) => {
    buf += d
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
    }
  })
}

/** La session de ce jeu est encore celle de ce script (pas une relance). */
const sessionOf = (id: string, watcher: ChildProcess): Session | undefined => {
  const s = running.get(id)
  return s && s.watcher === watcher ? s : undefined
}

function onWatcherLine(id: string, watcher: ChildProcess, line: string): void {
  const s = sessionOf(id, watcher)
  if (!s) return
  const game = findGame(id)
  const m = /^(started|ended|expired)(?::(\d+))?$/.exec(line)
  if (m?.[1] === 'ended') {
    const at = Number(m[2])
    if (at > 0) s.lastAliveAt = Math.min(at, Date.now())
    return
  }
  if (m?.[1] === 'started') {
    if (s.startedAt !== null) return
    // heure de démarrage du processus du jeu (si Windows la donne), jamais avant le clic
    const at = Number(m[2])
    s.startedAt = at > 0 ? Math.min(Math.max(at, s.launchedAt), Date.now()) : Date.now()
    s.expired = false
    if (game) game.lastPlayedAt = s.startedAt
    deps.log(`${game?.name ?? id} a démarré (${Math.round((s.startedAt - s.launchedAt) / 1000)} s après le lancement)`)
    changed()
    return
  }
  if (m?.[1] === 'expired' && s.startedAt === null && !s.expired) {
    // attente réelle (Steam a pu la prolonger) et reste de la surveillance silencieuse
    const waited = Math.max(GRACE_SECONDS, Number(m[2]) || GRACE_SECONDS)
    s.expired = true
    deps.log(`${game?.name ?? id} : pas encore démarré après ${durationText(waited)}, surveillance silencieuse`)
    if (game)
      deps.notice({
        level: 'info',
        message: tr('main.play.notStartedYet', {
          name: game.name,
          waited: durationText(waited),
          left: durationText(Math.max(0, MAX_WAIT_SECONDS - waited))
        })
      })
    changed()
  }
}

/** De quoi lancer le jeu sans PowerShell (mode restreint). */
interface DirectLaunch {
  kind: 'exe' | 'uri'
  target: string
  args: string
  cwd: string
}

/** PowerShell en mode restreint sur ce PC (vu une fois) : les lancements suivants s'en passent. */
let psRestricted = false
let psRestrictedTold = false

/** Suit le script de lancement et de surveillance jusqu'à sa fin. */
function followWatcher(id: string, watcher: ChildProcess, direct: DirectLaunch): void {
  let stderr = ''
  let launched = false
  readWatcherLines(watcher, (line) => {
    if (line === 'launched') launched = true
    else onWatcherLine(id, watcher, line)
  })
  watcher.stderr?.setEncoding('utf8')
  watcher.stderr?.on('data', (d: string) => (stderr += d))
  watcher.on('error', (err) => finishSession(id, watcher, tr('main.play.psStartFailed', { message: err.message })))
  watcher.on('close', (code) => {
    if (code === 4) finishSession(id, watcher, tr('main.play.adminDenied'))
    else if (code === PS_RESTRICTED) launchRestricted(id, watcher, direct)
    else if (code === 3) finishSession(id, watcher, cleanPsError(stderr) || tr('main.common.unknownError'))
    else if (code === 5) finishSession(id, watcher, null, true)
    // fin normale, script arrêté par CyberDeck, ou arrêté après avoir lancé le jeu
    else if (code === 0 || code === null || launched) finishSession(id, watcher, null)
    // PowerShell arrêté avant d'avoir lancé quoi que ce soit (antivirus, stratégie du PC…)
    else {
      const why = cleanPsError(stderr)
      finishSession(id, watcher, why ? tr('main.play.psStoppedWhy', { code: String(code), why }) : tr('main.play.psStopped', { code: String(code) }))
    }
  })
}

/** Code 6 : rien n'a été lancé, le jeu part directement par Windows (sans suivi du temps de jeu). */
function launchRestricted(id: string, watcher: ChildProcess, direct: DirectLaunch): void {
  const s = sessionOf(id, watcher)
  if (!s) return
  running.delete(id)
  psRestricted = true
  deps.log('PowerShell en mode restreint (Constrained Language) : lancement direct, temps de jeu non compté')
  void launchUntracked(id, direct, s.resumeTorrentId)
}

async function launchDirect(d: DirectLaunch): Promise<string | null> {
  try {
    if (d.kind === 'uri') {
      await shell.openExternal(d.target)
      return null
    }
    // comme un double-clic (fenêtre UAC si besoin), dossier de travail = celui du programme
    if (!d.args) return (await shell.openPath(d.target)) || null
    // arguments transmis tels quels ; détaché : le jeu continue si CyberDeck se ferme
    const error = await new Promise<string | null>((resolve) => {
      const child = spawn(d.target, [d.args], {
        cwd: d.cwd,
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
        argv0: `"${d.target}"`
      })
      child.once('error', (err) => resolve(err.message))
      child.once('spawn', () => {
        child.unref()
        resolve(null)
      })
    })
    if (!error) return null
    // programme qui demande les droits administrateur : lancé sans ses arguments
    deps.log(`Lancement direct avec arguments impossible (${error}) : lancement sans arguments`)
    return (await shell.openPath(d.target)) || null
  } catch (err: any) {
    return err.message
  }
}

async function launchUntracked(id: string, direct: DirectLaunch, resumeTorrentId: string | null): Promise<void> {
  const error = await launchDirect(direct)
  if (resumeTorrentId) deps.resumeTorrent(resumeTorrentId)
  const g = findGame(id)
  if (error) deps.notice({ level: 'error', message: tr('main.play.failed', { error }) })
  else {
    if (g) g.lastPlayedAt = Date.now()
    deps.log(`Lancement direct de ${g?.name ?? id} : ${direct.target}`)
    if (!psRestrictedTold) {
      psRestrictedTold = true
      deps.notice({
        level: 'info',
        message: tr('main.play.psRestricted')
      })
    }
  }
  changed()
}

export async function playGame(id: string): Promise<void> {
  const g = findGame(id)
  if (!g) return
  const current = running.get(id)
  if (current) {
    // Démarrage trop long, surveillance silencieuse : une nouvelle demande relance le jeu.
    if (current.expired && current.startedAt === null) {
      running.delete(id)
      current.watcher.kill()
    } else {
      const waiting = current.startedAt === null
      return deps.notice({ level: 'info', message: waiting ? tr('main.play.starting', { name: g.name }) : tr('main.play.alreadyRunning', { name: g.name }) })
    }
  }
  if (g.platform !== 'local') return playPlatformGame(g)
  if (!fs.existsSync(g.exePath)) {
    return deps.notice({
      level: 'error',
      message: tr('main.play.exeMissing', { path: g.exePath })
    })
  }
  // Jeu lancé directement depuis le dossier d'un torrent (sans installation).
  const t = g.torrentId ? deps.torrentById(g.torrentId) : undefined
  const torrentRoot = t ? path.join(t.savePath, t.name) : null
  const fromTorrent =
    !!t && !!torrentRoot && (inside(g.exePath, torrentRoot) || path.resolve(g.exePath).toLowerCase() === path.resolve(torrentRoot).toLowerCase())
  const resumeTorrentId = fromTorrent && (await deps.releaseTorrent(t.id)) ? t.id : null
  const direct: DirectLaunch = { kind: 'exe', target: g.exePath, args: g.args ?? '', cwd: path.dirname(g.exePath) }
  if (psRestricted) return launchUntracked(id, direct, resumeTorrentId)
  const startedAt = Date.now()
  let watcher: ChildProcess
  try {
    watcher = startPs(PLAY_SCRIPT, {
      ESSAIM_TARGET: g.exePath,
      ESSAIM_CWD: path.dirname(g.exePath),
      ESSAIM_ARGS: g.args ?? '',
      ESSAIM_DIR: watchDirFor(g).join('|')
    })
  } catch (err: any) {
    if (resumeTorrentId) deps.resumeTorrent(resumeTorrentId)
    return deps.notice({ level: 'error', message: tr('main.play.failed', { error: tr('main.play.psStartFailed', { message: err.message }) }) })
  }
  followWatcher(id, watcher, direct)
  running.set(id, { startedAt, launchedAt: startedAt, watcher, resumeTorrentId, expired: false, lastAliveAt: null })
  g.lastPlayedAt = startedAt
  deps.log(`Lancement de ${g.name} : ${g.exePath}`)
  changed()
}

// Délai laissé au lanceur pour démarrer le jeu avec « Démarrage… » affiché (mise à jour,
// connexion…), puis surveillance silencieuse jusqu'à MAX_WAIT (grosse mise à jour).
// CYBERDECK_LAUNCH_GRACE / _MAX_WAIT : valeurs plus courtes pour les tests automatiques.
const GRACE_SECONDS = Number(process.env.CYBERDECK_LAUNCH_GRACE) || 120
const MAX_WAIT_SECONDS = Math.max(GRACE_SECONDS, Number(process.env.CYBERDECK_LAUNCH_MAX_WAIT) || 900)

/** « 2 min », « 13 min », « 20 s » */
const durationText = (s: number): string => (s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`)

// Jeu de plateforme : lancé par la plateforme (adresse ou programme du
// lanceur), puis suivi par son dossier tant qu'un de ses processus tourne.
function playPlatformGame(g: Game): void {
  const platformName = PLATFORM_INFO[g.platform].name
  if (!g.installed)
    return deps.notice({
      level: 'error',
      message: tr(g.platform === 'steam' ? 'main.play.notInstalledSteam' : 'main.play.notInstalled', { name: g.name })
    })
  const launch = g.launch
  if (!launch || !launch.target)
    return deps.notice({ level: 'error', message: tr('main.play.launcherMissing', { platform: platformName }) })
  if (launch.kind === 'uri') {
    const scheme = launch.target.slice(0, launch.target.indexOf(':')).toLowerCase()
    if (!scheme || !deps.protocolAvailable(scheme))
      return deps.notice({ level: 'error', message: tr('main.play.protocolMissing', { platform: platformName, scheme }) })
  } else if (!fs.existsSync(launch.target)) {
    return deps.notice({ level: 'error', message: tr('main.play.targetMissing', { path: launch.target }) })
  }
  const dirs = (g.watch?.dirs.length ? g.watch.dirs : g.installDir ? [g.installDir] : []).filter((d) => !!d && !tooBroad(d))
  if (!dirs.length) return deps.notice({ level: 'error', message: tr('main.play.folderUnknown', { name: g.name }) })
  const cwd = [launch.cwd, g.installDir, os.homedir()].find((d) => !!d && fs.existsSync(d)) ?? os.homedir()
  const id = g.id
  const direct: DirectLaunch = { kind: launch.kind === 'uri' ? 'uri' : 'exe', target: launch.target, args: launch.kind === 'exe' ? (launch.args ?? '') : '', cwd }
  if (psRestricted) return void launchUntracked(id, direct, null)
  const launchedAt = Date.now()
  let watcher: ChildProcess
  try {
    watcher = startPs(PLAY_SCRIPT, {
      ESSAIM_MODE: 'platform',
      ESSAIM_TARGET: launch.target,
      ESSAIM_ARGS: direct.args,
      ESSAIM_CWD: cwd,
      ESSAIM_DIR: withRealPaths(dirs).join('|'),
      ESSAIM_NAMES: (g.watch?.names ?? []).join('|'),
      ESSAIM_IGNORE: (g.watch?.ignore ?? []).join('|'),
      ESSAIM_STEAM_APPID: g.platform === 'steam' && g.platformId ? g.platformId : '',
      ESSAIM_GRACE: String(GRACE_SECONDS),
      ESSAIM_MAX_WAIT: String(MAX_WAIT_SECONDS),
      // tests automatiques seulement : clé de registre de test à la place de celle de Steam (jamais écrite par l'app)
      ESSAIM_STEAM_KEY: process.env.CYBERDECK_TEST_STEAM_KEY ?? ''
    })
  } catch (err: any) {
    return deps.notice({ level: 'error', message: tr('main.play.failed', { error: tr('main.play.psStartFailed', { message: err.message }) }) })
  }
  followWatcher(id, watcher, direct)
  running.set(id, { startedAt: null, launchedAt, watcher, resumeTorrentId: null, expired: false, lastAliveAt: null })
  deps.log(`Lancement de ${g.name} par ${platformName} : ${launch.target}${launch.kind === 'exe' && launch.args ? ' ' + launch.args : ''}`)
  changed()
}

/** Secondes jouées : du premier relevé où le jeu tournait au dernier (ou jusqu'à maintenant). */
function sessionSeconds(s: Session, now = Date.now()): number {
  if (s.startedAt === null) return 0
  const end = s.lastAliveAt !== null ? Math.min(now, Math.max(s.lastAliveAt, s.startedAt)) : now
  return Math.max(0, Math.round((end - s.startedAt) / 1000))
}

function finishSession(id: string, watcher: ChildProcess, error: string | null, notStarted = false): void {
  const session = sessionOf(id, watcher)
  if (!session) return // script d'une session déjà remplacée (relance) ou terminée
  running.delete(id)
  if (session.resumeTorrentId) deps.resumeTorrent(session.resumeTorrentId)
  const g = findGame(id)
  if (g && !error) g.playTimeSeconds += sessionSeconds(session)
  if (error) deps.notice({ level: 'error', message: tr('main.play.failed', { error }) })
  else if (notStarted && g) {
    // déjà dit à la fin du délai (« expired ») : seulement le journal cette fois
    // sinon (Steam préparait encore le lancement à la fin du délai) : dit maintenant
    if (session.expired) deps.log(`${g.name} n’a pas démarré en ${durationText(MAX_WAIT_SECONDS)} : surveillance arrêtée`)
    else
      deps.notice({
        level: 'info',
        message: tr('main.play.notStarted', { name: g.name, duration: durationText(MAX_WAIT_SECONDS) })
      })
  }
  changed()
}

// À la fermeture de CyberDeck : on compte le temps déjà joué (le jeu, lui, continue).
export function stopAllSessions(): void {
  for (const [id, session] of running) {
    const g = findGame(id)
    if (g) g.playTimeSeconds += sessionSeconds({ ...session, lastAliveAt: null })
    session.watcher.kill()
  }
  running.clear()
  save()
}

// ---------- Plateformes : installer un jeu possédé ----------

export async function installPlatformGame(id: string): Promise<ActionResult> {
  const g = findGame(id)
  if (!g) return { ok: false, error: tr('main.common.gameNotFound') }
  if (g.installed) return { ok: false, error: tr('main.install.alreadyInstalled', { name: g.name }) }
  if (g.platform !== 'steam' || !g.platformId || !/^\d+$/.test(g.platformId))
    return { ok: false, error: tr('main.install.steamOnly') }
  if (!deps.protocolAvailable('steam')) return { ok: false, error: tr('main.steam.notInstalled') }
  try {
    await shell.openExternal(`steam://install/${g.platformId}`)
    deps.log(`Installation demandée à Steam : ${g.name} (${g.platformId})`)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: tr('main.install.steamNoReply', { message: err.message }) }
  }
}

// ---------- Désinstaller ----------

/** Plateformes qui ne se laissent pas désinstaller depuis une autre app : on les ouvre.
 *  Fonction : le nom affiché suit la langue en cours. */
const openToUninstall = (): Partial<Record<Game['platform'], { name: string; uri: string; scheme: string | null }>> => ({
  epic: { name: 'Epic Games', uri: 'com.epicgames.launcher://store', scheme: 'com.epicgames.launcher' },
  itch: { name: 'itch', uri: 'itch://library', scheme: 'itch' },
  amazon: { name: 'Amazon Games', uri: 'amazon-games://', scheme: 'amazon-games' },
  // jeux du Microsoft Store / Game Pass : « Applications installées » de Windows
  xbox: { name: tr('main.uninstall.windowsApps'), uri: 'ms-settings:appsfeatures', scheme: null }
})

/** « "C:\…\unins000.exe" /SILENT » ou « MsiExec.exe /X{…} » → programme et arguments. */
function splitCommand(cmd: string): { exe: string; args: string } | null {
  const c = cmd.trim()
  if (c.startsWith('"')) {
    const end = c.indexOf('"', 1)
    return end > 1 ? { exe: c.slice(1, end), args: c.slice(end + 1).trim() } : null
  }
  const m = /^(.+?\.exe)(?:\s+(.*))?$/i.exec(c)
  return m ? { exe: m[1], args: (m[2] ?? '').trim() } : null
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Désinstalleur déclaré dans Windows pour ce jeu : d'abord la clé propre à sa plateforme
 * (GOG « <id>_is1 », Ubisoft « Uplay Install <id> », Riot, Battle.net --uid, Rockstar
 * -uninstall), sinon une clé dont le dossier (ou le désinstalleur) est celui du jeu.
 */
function matchUninstall(g: Game, entries: RegUninstallEntry[]): RegUninstallEntry | null {
  const id = (g.platformId ?? '').toLowerCase()
  const withCmd = entries.filter((e) => e.uninstall.trim())
  const byPlatform = (e: RegUninstallEntry): boolean => {
    if (!id) return false
    const key = e.key.toLowerCase()
    const cmd = e.uninstall.toLowerCase()
    switch (g.platform) {
      case 'gog':
        return key === `${id}_is1`
      case 'ubisoft':
        return key === `uplay install ${id}`
      case 'riot':
        return key === `riot game ${id}`
      case 'battlenet':
        return new RegExp(`--uid=${escapeRe(id)}(?=[\\s"]|$)`).test(cmd)
      case 'rockstar':
        return new RegExp(`-uninstall=${escapeRe(id)}(?=[\\s"]|$)`).test(cmd)
      default:
        return false
    }
  }
  const dir = g.installDir
  const inDir = (e: RegUninstallEntry): boolean => {
    if (!dir || tooBroad(dir)) return false
    const loc = e.location.trim().replace(/^"|"$/g, '')
    if (loc && sameDir(loc, dir)) return true
    const exe = splitCommand(e.uninstall)?.exe
    return !!exe && inside(exe, dir)
  }
  return withCmd.find(byPlatform) ?? withCmd.find(inDir) ?? null
}

/** Désinstalleur posé à la racine du dossier du jeu (unins000.exe d'Inno Setup, uninstall.exe…). */
function uninstallerInFolder(dir: string | null): string | null {
  if (!dir || tooBroad(dir)) return null
  try {
    const f = fs.readdirSync(dir).find((n) => /^(unins\d{3}|uninstall|uninst|uninstaller)\.exe$/i.test(n))
    return f ? path.join(dir, f) : null
  } catch {
    return null
  }
}

type UninstallCommand = { exe: string; args: string }

/** Ce que fera « Désinstaller » pour ce jeu (aucune action ici). */
async function planUninstall(g: Game): Promise<UninstallPlan & { command?: UninstallCommand }> {
  const none = (error: string): UninstallPlan => ({ kind: 'none', launcher: null, target: null, error })
  if (!g.installed) return none(tr('main.uninstall.notInstalled', { name: g.name }))
  if (g.platform === 'steam') {
    if (!g.platformId || !/^\d+$/.test(g.platformId)) return none(tr('main.uninstall.noSteamId'))
    if (!deps.protocolAvailable('steam')) return none(tr('main.steam.notInstalled'))
    return { kind: 'launcher', launcher: 'Steam', target: null, error: null }
  }
  const reg = await takeSnapshot([], false)
  const entry = reg.ok ? matchUninstall(g, reg.uninstall) : null
  const cmd = entry ? splitCommand(entry.uninstall) : null
  if (cmd) return { kind: 'uninstaller', launcher: g.platform === 'local' ? null : PLATFORM_INFO[g.platform].name, target: cmd.exe, error: null, command: cmd }
  const open = openToUninstall()[g.platform]
  if (open && (!open.scheme || deps.protocolAvailable(open.scheme))) return { kind: 'open-launcher', launcher: open.name, target: null, error: null }
  const own = uninstallerInFolder(g.installDir)
  if (own) return { kind: 'uninstaller', launcher: null, target: own, error: null, command: { exe: own, args: '' } }
  const dir = g.installDir && fs.existsSync(g.installDir) && !tooBroad(g.installDir) ? g.installDir : null
  if (dir) return { kind: 'folder', launcher: null, target: dir, error: null }
  return none(tr('main.uninstall.nothingFound'))
}

export async function uninstallPlan(id: string): Promise<UninstallPlan> {
  const g = findGame(id)
  if (!g) return { kind: 'none', launcher: null, target: null, error: tr('main.common.gameNotFound') }
  const plan = await planUninstall(g)
  return { kind: plan.kind, launcher: plan.launcher, target: plan.target, error: plan.error }
}

/**
 * Le désinstalleur d'un jeu local est lancé : quand son programme et son dossier ont disparu
 * (vérifié toutes les 5 s pendant 15 min), le jeu est retiré de la bibliothèque. Les jeux de
 * plateforme passent « Non installé » à la lecture suivante de leur plateforme.
 */
function followLocalUninstall(id: string): void {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    const g = findGame(id)
    if (!g || Date.now() - startedAt > 15 * 60_000) return clearInterval(timer)
    const gone = (!g.exePath || !fs.existsSync(g.exePath)) && (!g.installDir || !fs.existsSync(g.installDir))
    if (!gone) return
    clearInterval(timer)
    removeGame(id)
    deps.log(`Désinstallé : ${g.name}`)
    deps.notice({ level: 'success', message: tr('main.uninstall.done', { name: g.name }) })
  }, 5000)
}

export async function uninstallGame(id: string, removeFromList: boolean): Promise<ActionResult> {
  const g = findGame(id)
  if (!g) return { ok: false, error: tr('main.common.gameNotFound') }
  if (running.has(id)) return { ok: false, error: tr('main.uninstall.running', { name: g.name }) }
  const plan = await planUninstall(g)
  try {
    switch (plan.kind) {
      case 'launcher':
        await shell.openExternal(`steam://uninstall/${g.platformId}`)
        deps.log(`Désinstallation demandée à Steam : ${g.name} (${g.platformId})`)
        return { ok: true }
      case 'open-launcher': {
        const open = openToUninstall()[g.platform]!
        await shell.openExternal(open.uri)
        deps.log(`Désinstallation de ${g.name} : ${open.name} ouvert`)
        return { ok: true }
      }
      case 'folder': {
        const error = await shell.openPath(plan.target!)
        if (error) return { ok: false, error: tr('main.uninstall.folderMissing', { error }) }
        if (removeFromList) removeGame(id)
        deps.log(`Désinstallation de ${g.name} : dossier ouvert (${plan.target})${removeFromList ? ', retiré de la bibliothèque' : ''}`)
        return { ok: true }
      }
      case 'uninstaller': {
        const { exe, args } = plan.command!
        const cwd = path.isAbsolute(exe) && fs.existsSync(path.dirname(exe)) ? path.dirname(exe) : os.homedir()
        const res = await runPs(LAUNCH, { ESSAIM_TARGET: exe, ESSAIM_CWD: cwd, ESSAIM_ARGS: args }, 30_000)
        if (res.code === 4) return { ok: false, error: tr('main.uninstall.adminDenied') }
        if (res.code === PS_RESTRICTED) {
          const error = await launchDirect({ kind: 'exe', target: exe, args, cwd })
          if (error) return { ok: false, error: tr('main.uninstall.cantStart', { error }) }
        } else if (!/launched/.test(res.stdout)) {
          return { ok: false, error: tr('main.uninstall.cantStart', { error: cleanPsError(res.stderr) || `code ${res.code}` }) }
        }
        deps.log(`Désinstalleur lancé pour ${g.name} : ${exe}${args ? ' ' + args : ''}`)
        if (g.platform === 'local') followLocalUninstall(id)
        return { ok: true }
      }
      default:
        return { ok: false, error: plan.error ?? tr('main.uninstall.failed') }
    }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

// ---------- Plateformes : synchronisation de la bibliothèque ----------

const hasHistory = (g: Game): boolean => g.playTimeSeconds > 0 || g.lastPlayedAt !== null

const argsAumid = (args: string | null): string | null => {
  const m = /^\s*"?shell:appsfolder\\([^"\s]+)"?\s*$/i.exec(args ?? '')
  return m ? m[1].toLowerCase() : null
}

/** Le jeu détecté est déjà dans la bibliothèque comme jeu local (ou par une autre plateforme). */
function duplicateOf(d: DetectedGame): Game | undefined {
  const dirs = [d.installDir, ...(d.altDirs ?? [])].filter((x): x is string => !!x)
  return games.find((g) => {
    if (g.platform === d.platform) return false
    if (g.platform === 'local') {
      if (dirs.some((dir) => sameDir(g.installDir, dir) || inside(g.exePath, dir))) return true
      if (d.aumid && argsAumid(g.args) === d.aumid.toLowerCase()) return true
      // possédé sur Steam mais déjà jouable ici (copie locale du même jeu)
      if (!d.installed && d.steamAppId && g.steamAppId === d.steamAppId) return true
      return false
    }
    return g.installed && d.installed && dirs.some((dir) => sameDir(g.installDir, dir))
  })
}

function gameFromDetected(d: DetectedGame): Game {
  return normalizeGame({
    id: randomUUID(),
    name: d.name,
    exePath: d.exePath ?? '',
    args: null,
    installDir: d.installDir,
    torrentId: null,
    coverVersion: 0,
    coverShape: null,
    iconVersion: 0,
    steamAppId: d.steamAppId ?? null,
    coverHint: d.coverHint ?? null,
    coverTriedAt: null,
    addedAt: Date.now(),
    lastPlayedAt: null,
    playTimeSeconds: 0,
    platform: d.platform,
    platformId: d.platformId,
    installed: d.installed,
    owned: d.owned ?? null,
    launch: d.launch,
    watch: { dirs: d.watchDirs, names: d.processNames, ignore: d.ignoreNames ?? [] },
    platformPlayTimeSeconds: d.playTimeSeconds ?? null,
    platformLastPlayedAt: d.lastPlayedAt ?? null,
    platformState: d.state ?? null,
    iconHint: d.iconHint ?? null
  })
}

/** Met un jeu existant à jour ; renvoie [modifié, icône à refaire]. */
function updateFromDetected(g: Game, d: DetectedGame): [boolean, boolean] {
  let dirty = false
  let icon = false
  const set = <K extends keyof Game>(k: K, v: Game[K]): void => {
    if (JSON.stringify(g[k]) !== JSON.stringify(v)) {
      g[k] = v
      dirty = true
    }
  }
  if (d.installed) {
    if (d.installDir && !sameDir(g.installDir, d.installDir)) {
      deps.log(`${g.name} a changé de dossier : ${g.installDir ?? '—'} → ${d.installDir}`)
      icon = true
    }
    if (d.installDir) set('installDir', d.installDir)
    if (d.exePath && d.exePath !== g.exePath) {
      set('exePath', d.exePath)
      icon = true
    }
    set('watch', { dirs: d.watchDirs, names: d.processNames, ignore: d.ignoreNames ?? [] })
    if (!g.installed) icon = icon || !g.iconVersion
  }
  set('installed', d.installed)
  set('launch', d.launch)
  if (d.owned !== undefined) set('owned', d.owned)
  if (d.steamAppId) set('steamAppId', d.steamAppId)
  if (d.coverHint) set('coverHint', d.coverHint)
  if (d.iconHint) set('iconHint', d.iconHint)
  if (d.playTimeSeconds !== undefined && d.playTimeSeconds !== null) set('platformPlayTimeSeconds', d.playTimeSeconds)
  if (d.lastPlayedAt) set('platformLastPlayedAt', Math.max(d.lastPlayedAt, g.platformLastPlayedAt ?? 0))
  set('platformState', d.state ?? null)
  // nom provisoire (« App 123456 ») remplacé par le vrai nom
  if (/^App \d+$/.test(g.name) && d.name && !/^App \d+$/.test(d.name)) set('name', d.name)
  return [dirty, icon]
}

export interface ApplyReport {
  installed: number
  duplicates: number
  /** jeux trouvés déjà dans la bibliothèque (jeu local ou autre plateforme) */
  skipped: PlatformSkip[]
}

/** Ajoute les jeux trouvés, met à jour ceux qui ont bougé, marque les désinstallés (historique gardé). */
export function applyPlatformScans(scans: PlatformScan[]): Map<LauncherPlatform, ApplyReport> {
  const report = new Map<LauncherPlatform, ApplyReport>()
  const fresh: Game[] = []
  const icons: string[] = []
  let dirty = false
  for (const scan of scans) {
    const rep: ApplyReport = { installed: 0, duplicates: 0, skipped: [] }
    const seen = new Set<string>()
    for (const d of scan.games) {
      if (hidden.has(platformKey(d.platform, d.platformId))) continue
      let g = games.find((x) => x.platform === d.platform && x.platformId === d.platformId)
      if (!g) {
        const dup = duplicateOf(d)
        if (dup) {
          if (d.installed) {
            rep.duplicates++
            rep.skipped.push(dup.platform === 'local' ? { name: d.name, reason: 'local' } : { name: d.name, reason: 'platform', other: dup.platform })
          }
          continue
        }
        g = gameFromDetected(d)
        games.push(g)
        fresh.push(g)
        dirty = true
      } else {
        const [changedNow, icon] = updateFromDetected(g, d)
        dirty = dirty || changedNow
        if (icon) icons.push(g.id)
      }
      seen.add(d.platformId)
      if (d.installed) rep.installed++
    }
    // Lecture incomplète (fichier de la plateforme en cours d'écriture) : rien n'est marqué désinstallé.
    if (scan.ok && !scan.partial) {
      const keep = new Set(scan.keep ?? [])
      for (const g of games) {
        if (g.platform !== scan.platform || !g.platformId || seen.has(g.platformId)) continue
        // son fichier n'a pas pu être lu cette fois : le jeu reste tel quel s'il est encore sur le disque
        if (keep.has(g.platformId) && (!g.installed || (!!g.installDir && fs.existsSync(g.installDir)))) continue
        // plus vu sur la plateforme : désinstallé (l'historique reste)
        if (g.installed || g.platformState) {
          g.installed = false
          g.platformState = null
          dirty = true
          deps.log(`${g.name} n’est plus installé (${PLATFORM_INFO[g.platform].name})`)
        }
        if (scan.ownedKnown && g.owned !== false) {
          g.owned = false
          dirty = true
        }
      }
      // Jeux seulement « possédés » d'un compte qui ne les a plus (autre compte Steam) :
      // jamais installés, jamais lancés → retirés.
      if (scan.platform === 'steam' && scan.ownedKnown) {
        const before = games.length
        const gone = games.filter((g) => g.platform === 'steam' && !g.installed && g.owned === false && !g.installDir && !hasHistory(g))
        if (gone.length) {
          games = games.filter((g) => !gone.includes(g))
          for (const g of gone) {
            fs.rm(coverFile(g.id), { force: true }, () => {})
            fs.rm(iconFile(g.id), { force: true }, () => {})
          }
          dirty = dirty || games.length !== before
        }
      }
    }
    report.set(scan.platform, rep)
  }
  if (dirty) changed()
  for (const g of fresh) {
    void refreshIcon(g.id)
    void searchCover(g.id)
  }
  for (const id of icons) void refreshIcon(id)
  if (fresh.length) deps.log(`Plateformes : ${fresh.length} jeu(x) ajouté(s) à la bibliothèque`)
  return report
}

/** Clé Steam retirée : la liste possédée n'est plus connue. */
export function forgetSteamOwned(): void {
  const gone = games.filter((g) => g.platform === 'steam' && !g.installed && !g.installDir && !hasHistory(g))
  games = games.filter((g) => !gone.includes(g))
  for (const g of gone) {
    fs.rm(coverFile(g.id), { force: true }, () => {})
    fs.rm(iconFile(g.id), { force: true }, () => {})
  }
  for (const g of games) if (g.platform === 'steam') g.owned = null
  changed()
}

/** Remet les jeux de plateforme retirés à la main ; renvoie leur nombre (la détection suivante les rajoute). */
export function restoreHiddenGames(): number {
  const n = hidden.size
  if (!n) return 0
  hidden.clear()
  changed()
  return n
}

export const hiddenCount = (): number => hidden.size

export function steamOwnedCounts(): { owned: number; notInstalled: number } {
  const owned = games.filter((g) => g.platform === 'steam' && g.owned === true)
  return { owned: owned.length, notInstalled: owned.filter((g) => !g.installed).length }
}
