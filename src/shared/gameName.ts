// Transforme un nom de torrent ou de dossier en nom de jeu lisible
// (« Mon Jeu [v1.2] (x64) » → « Mon Jeu »).
export function cleanGameName(raw: string): string {
  let s = raw.replace(/\.(iso|exe|zip|rar|7z)$/i, '')
  // suffixe « -<site>.<tld> » ajouté par certains hébergeurs de fichiers
  s = s.replace(/[-_. ]+[a-z0-9]+\.(?:com|net|org|to|io|cc|ru)(?=$|[\s[(])/gi, ' ')
  // « Mon-Jeu-Sans-Espaces » : des tirets à la place des espaces
  if (!/\s/.test(s.trim())) s = s.replace(/-/g, ' ')
  s = s.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
  s = s.replace(/\b(v|build|version)\s?\d[\w.-]*/gi, ' ')
  s = s.replace(/[._]+/g, ' ')
  s = s.replace(/\s\+\s.*$/, ' ')
  s = s.replace(/\b(multi\d*|x64|x86|win(?:32|64)|portable)\b/gi, ' ')
  s = s.replace(/\s{2,}/g, ' ').trim().replace(/[\s:–-]+$/, '').trim()
  return s || raw.trim()
}
