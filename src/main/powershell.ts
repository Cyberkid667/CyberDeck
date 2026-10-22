// Lancement de scripts PowerShell (Windows PowerShell 5.1, présent sur tous les Windows).
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

export const POWERSHELL = path.join(
  process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

/**
 * Code de sortie des scripts quand PowerShell est en mode restreint (Constrained Language :
 * Smart App Control, stratégie de sécurité d'entreprise…) : les appels .NET y sont refusés.
 * À tester en première ligne d'un script : `if (...) { exit 6 }` (voir PS_RESTRICTED_CHECK).
 */
export const PS_RESTRICTED = 6
export const PS_RESTRICTED_CHECK = `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit ${PS_RESTRICTED} }`

// Les chemins passent par des variables d'environnement : aucun souci de
// guillemets, de crochets ou d'esperluettes dans les noms de dossiers.
// Peut lever une exception (lancement refusé par Windows) : runPs la transforme en code -1.
export function startPs(script: string, env: Record<string, string> = {}): ChildProcess {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...process.env, ...env },
    windowsHide: true
  })
}

export function runPs(
  script: string,
  env: Record<string, string> = {},
  timeoutMs = 0
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = startPs(script, env)
    } catch (err) {
      // PowerShell absent ou bloqué : même réponse qu'un échec du script, jamais d'exception
      return resolve({ code: -1, stdout: '', stderr: `PowerShell ne démarre pas : ${(err as Error).message}` })
    }
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | null = null
    if (timeoutMs > 0)
      timer = setTimeout(() => {
        stderr += `\nDélai dépassé (${Math.round(timeoutMs / 1000)} s)`
        child.kill()
      }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `PowerShell ne démarre pas : ${err.message}` })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr: cleanPsError(stderr) })
    })
  })
}

/** Texte d'un élément CLIXML : retours à la ligne (_x000D__x000A_) et caractères échappés. */
const clixmlText = (s: string): string =>
  s
    .replace(/_x([0-9a-f]{4})_/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

// Retire l'enrobage XML que PowerShell ajoute à ses messages d'erreur (stderr redirigé avec
// -EncodedCommand) : on garde le texte des erreurs, sans leur position dans le script.
export function cleanPsError(text: string): string {
  const errors: string[] = []
  for (const block of text.match(/<Objs[\s\S]*?<\/Objs>/g) ?? [])
    for (const m of block.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)) errors.push(clixmlText(m[1]))
  const plain = text
    .replace(/#< CLIXML/g, '')
    .replace(/<Objs[\s\S]*?<\/Objs>/g, '')
    .trim()
  if (plain) return plain
  const lines = errors
    .join('')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('+') && !/^(Au caract|At line|At char)/i.test(l))
  return [...new Set(lines)].join(' ').slice(0, 600)
}
