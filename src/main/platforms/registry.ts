// Lecture du registre Windows (et des applications du Microsoft Store) en un seul
// passage PowerShell, en lecture seule. On ne lit que des valeurs nommées : jamais
// de clé entière (certaines contiennent des jetons ou des certificats).
import { runPs } from '../powershell'

export interface RegRead {
  id: string
  /** 'HKLM\…', 'HKCU\…' ou 'HKCR\…' (vue 64 bits ; WOW6432Node écrit en toutes lettres) */
  key: string
  /** noms des valeurs à lire ('' = valeur par défaut) */
  values: string[]
  /** lit aussi ces valeurs dans chaque sous-clé directe */
  subkeys?: boolean
}

export type RegValues = Record<string, string | number>

export interface RegKeyData {
  values: RegValues
  subkeys?: Record<string, RegValues>
}

export interface UninstallEntry {
  view: 'HKLM64' | 'HKLM32' | 'HKCU'
  /** nom de la sous-clé (ex. « Steam App 221100 », « {7B682C4F-…} ») */
  key: string
  name: string
  location: string
  icon: string
  uninstall: string
  publisher: string
}

export interface AppxPackage {
  name: string
  family: string
  fullName: string
  location: string
  signature: string
  dev: boolean
  version: string
}

export interface StartApp {
  name: string
  appId: string
}

export interface RegistrySnapshot {
  ok: boolean
  error: string | null
  keys: Record<string, RegKeyData | null>
  uninstall: UninstallEntry[]
  /** null : liste des applications illisible */
  appx: AppxPackage[] | null
  startApps: StartApp[]
  takenAt: number
}

/** Protocoles des lanceurs (HKCR\<schéma>). */
export const PROTOCOLS = [
  'steam',
  'com.epicgames.launcher',
  'battlenet',
  'origin2',
  'uplay',
  'goggalaxy',
  'amazon-games',
  'itchio',
  'riotclient',
  'rockstar',
  'msxbox',
  'ms-windows-store'
] as const

const EA_VALUES = ['ClientPath', 'DesktopAppPath', 'LauncherAppPath', 'InstallLocation', 'InstallSuccessful']

export const READS: RegRead[] = [
  { id: 'steam.user', key: 'HKCU\\Software\\Valve\\Steam', values: ['SteamPath', 'SteamExe', 'AutoLoginUser', 'RunningAppID'] },
  { id: 'steam.machine', key: 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', values: ['InstallPath'] },
  { id: 'steam.machine64', key: 'HKLM\\SOFTWARE\\Valve\\Steam', values: ['InstallPath'] },
  { id: 'steam.active', key: 'HKCU\\Software\\Valve\\Steam\\ActiveProcess', values: ['ActiveUser', 'pid'] },
  { id: 'epic.64', key: 'HKLM\\SOFTWARE\\Epic Games\\EpicGamesLauncher', values: ['AppDataPath'] },
  { id: 'epic.32', key: 'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', values: ['AppDataPath'] },
  {
    id: 'gog.games',
    key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games',
    values: ['gameID', 'gameName', 'path', 'exe', 'exeFile', 'workingDir', 'launchCommand', 'launchParam', 'dependsOn', 'productID', 'uninstallCommand'],
    subkeys: true
  },
  { id: 'gog.paths', key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths', values: ['client'] },
  { id: 'gog.client', key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient', values: ['clientExecutable'] },
  { id: 'ubisoft.launcher', key: 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', values: ['InstallDir'] },
  { id: 'ubisoft.installs', key: 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs', values: ['InstallDir'], subkeys: true },
  { id: 'ea.64', key: 'HKLM\\SOFTWARE\\Electronic Arts\\EA Desktop', values: EA_VALUES },
  { id: 'ea.32', key: 'HKLM\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop', values: EA_VALUES },
  {
    id: 'rockstar.keys',
    key: 'HKLM\\SOFTWARE\\WOW6432Node\\Rockstar Games',
    values: ['InstallFolder', 'InstallFolderSteam', 'InstallFolderEpic', 'InstallFolderXboxPc', 'Version'],
    subkeys: true
  },
  ...PROTOCOLS.flatMap((p): RegRead[] => [
    { id: `proto.${p}`, key: `HKCR\\${p}`, values: ['URL Protocol'] },
    { id: `protocmd.${p}`, key: `HKCR\\${p}\\shell\\open\\command`, values: [''] }
  ])
]

const SNAPSHOT_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
# Mode de langage restreint (stratégie d'entreprise) : les appels .NET échoueraient sans bruit et
# la photo serait vide (tous les jeux pris pour désinstallés) : on s'arrête avec une erreur.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  [Console]::Error.WriteLine('PowerShell en mode restreint (' + $ExecutionContext.SessionState.LanguageMode + ')')
  exit 3
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$spec = $env:ESSAIM_SPEC | ConvertFrom-Json
$hives = @{
  HKLM = [Microsoft.Win32.RegistryHive]::LocalMachine
  HKCU = [Microsoft.Win32.RegistryHive]::CurrentUser
  HKCR = [Microsoft.Win32.RegistryHive]::ClassesRoot
}
function Open-Key([string]$full) {
  $i = $full.IndexOf('\')
  if ($i -lt 0) { $hive = $full; $sub = '' } else { $hive = $full.Substring(0, $i); $sub = $full.Substring($i + 1) }
  try {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hives[$hive], [Microsoft.Win32.RegistryView]::Registry64)
    if ($sub) { return $base.OpenSubKey($sub) } else { return $base }
  } catch { return $null }
}
function Read-Values($k, $names) {
  $o = @{}
  foreach ($n in @($names)) {
    try { $v = $k.GetValue([string]$n, $null) } catch { $v = $null }
    if ($null -eq $v) { continue }
    if ($v -is [byte[]]) { continue }
    if ($v -is [string[]]) { $v = ($v -join [string][char]10) }
    $o[[string]$n] = $v
  }
  return $o
}
$keys = @{}
foreach ($r in @($spec.reads)) {
  $k = Open-Key ([string]$r.key)
  if (-not $k) { $keys[[string]$r.id] = $null; continue }
  $entry = @{ values = (Read-Values $k $r.values) }
  if ($r.subkeys) {
    $subs = @{}
    foreach ($s in $k.GetSubKeyNames()) {
      $sk = $null
      try { $sk = $k.OpenSubKey($s) } catch {}
      if ($sk) { $subs[$s] = (Read-Values $sk $r.values); $sk.Close() }
    }
    $entry.subkeys = $subs
  }
  $k.Close()
  $keys[[string]$r.id] = $entry
}
$uninst = New-Object System.Collections.Generic.List[object]
$roots = @(
  [pscustomobject]@{ view = 'HKLM64'; path = 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' },
  [pscustomobject]@{ view = 'HKLM32'; path = 'HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' },
  [pscustomobject]@{ view = 'HKCU'; path = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall' }
)
foreach ($root in $roots) {
  $k = Open-Key $root.path
  if (-not $k) { continue }
  foreach ($s in $k.GetSubKeyNames()) {
    $sk = $null
    try { $sk = $k.OpenSubKey($s) } catch {}
    if (-not $sk) { continue }
    $v = Read-Values $sk @('DisplayName', 'InstallLocation', 'DisplayIcon', 'UninstallString', 'Publisher')
    $sk.Close()
    if ($v.Count -eq 0) { continue }
    $uninst.Add([pscustomobject]@{
      view = $root.view; key = [string]$s; name = [string]$v['DisplayName']; location = [string]$v['InstallLocation']
      icon = [string]$v['DisplayIcon']; uninstall = [string]$v['UninstallString']; publisher = [string]$v['Publisher']
    })
  }
  $k.Close()
}
$appx = $null
$appxError = $null
$start = @()
if ($spec.appx) {
  try {
    $appx = @(Get-AppxPackage -ErrorAction Stop | Where-Object { -not $_.IsFramework -and $_.InstallLocation -and [string]$_.SignatureKind -ne 'System' } | ForEach-Object {
      [pscustomobject]@{
        name = [string]$_.Name; family = [string]$_.PackageFamilyName; fullName = [string]$_.PackageFullName
        location = [string]$_.InstallLocation; signature = [string]$_.SignatureKind; dev = [bool]$_.IsDevelopmentMode
        version = [string]$_.Version
      }
    })
  } catch { $appx = $null; $appxError = $_.Exception.Message }
  try {
    $start = @(Get-StartApps | Where-Object { $_.AppID -like '*!*' } | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; appId = [string]$_.AppID } })
  } catch { $start = @() }
}
$result = [pscustomobject]@{ keys = $keys; uninstall = $uninst.ToArray(); appx = $appx; appxError = $appxError; startApps = $start }
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 8 -Compress))
`

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v ? [v as T] : [])

export async function takeSnapshot(reads: RegRead[] = READS, withAppx = true): Promise<RegistrySnapshot> {
  const spec = JSON.stringify({ reads, appx: withAppx })
  const res = await runPs(SNAPSHOT_SCRIPT, { ESSAIM_SPEC: spec }, 90_000)
  const empty: RegistrySnapshot = { ok: false, error: null, keys: {}, uninstall: [], appx: null, startApps: [], takenAt: Date.now() }
  try {
    const raw = JSON.parse(res.stdout.replace(/^\uFEFF/, '').trim() || 'null')
    if (!raw || typeof raw !== 'object')
      throw new Error(res.stderr.trim() || (res.code === 3 ? 'PowerShell en mode restreint (stratégie du PC)' : `PowerShell ${res.code}`))
    const keys: Record<string, RegKeyData | null> = {}
    for (const r of reads) {
      const k = raw.keys?.[r.id]
      keys[r.id] = k ? { values: k.values ?? {}, subkeys: k.subkeys ?? undefined } : null
    }
    const uninstall = asArray<UninstallEntry>(raw.uninstall)
    // Aucune clé lue et aucun programme installé : lecture ratée sans message (droits, stratégie),
    // pas un PC vide. Sinon tous les jeux seraient marqués désinstallés.
    if (reads.length && !uninstall.length && !Object.values(keys).some(Boolean))
      throw new Error(res.stderr.trim() || 'registre vide (lecture refusée ?)')
    return {
      ok: true,
      error: raw.appxError ? `Applications du Microsoft Store illisibles : ${raw.appxError}` : null,
      keys,
      uninstall,
      appx: raw.appx === null || raw.appx === undefined ? (withAppx ? null : []) : asArray<AppxPackage>(raw.appx),
      startApps: asArray<StartApp>(raw.startApps),
      takenAt: Date.now()
    }
  } catch (err: any) {
    return { ...empty, error: `Lecture du registre impossible : ${err.message || res.stderr || 'erreur inconnue'}` }
  }
}

// ---------- Accès pratiques ----------

export function regString(snap: RegistrySnapshot, id: string, name: string): string | null {
  const v = snap.keys[id]?.values?.[name]
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null
}

/** DWORD lu comme entier signé par .NET : ramené entre 0 et 2^32. */
export function regNumber(snap: RegistrySnapshot, id: string, name: string): number | null {
  const v = snap.keys[id]?.values?.[name]
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  return n < 0 ? n + 2 ** 32 : n
}

export const regSubkeys = (snap: RegistrySnapshot, id: string): Record<string, RegValues> => snap.keys[id]?.subkeys ?? {}

export const keyExists = (snap: RegistrySnapshot, id: string): boolean => !!snap.keys[id]

/** Le protocole (steam:, origin2:…) est enregistré dans Windows. */
export const protocolRegistered = (snap: RegistrySnapshot, scheme: string): boolean =>
  keyExists(snap, `proto.${scheme}`) || keyExists(snap, `protocmd.${scheme}`)

/** Commande du protocole (HKCR\<schéma>\shell\open\command), ex. "C:\…\steam.exe" -- "%1". */
export const protocolCommand = (snap: RegistrySnapshot, scheme: string): string | null => regString(snap, `protocmd.${scheme}`, '')
