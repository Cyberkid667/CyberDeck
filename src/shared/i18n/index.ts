// Traductions de l'interface (anglais par défaut, français au choix dans Réglages).
// Chaque zone de l'app a son dictionnaire (main.ts : processus principal, library.ts :
// bibliothèque et fenêtres des jeux, shell.ts : coquille, réglages, torrents, formats, twitch.ts :
// streams Twitch des pages de jeux), avec
// les mêmes clés en anglais et en français. Clé absente dans une langue : l'anglais, sinon la clé.
// Paramètres : « {name} » dans le texte est remplacé par params.name.
import library from './library'
import main from './main'
import shell from './shell'
import steam from './steam'
import twitch from './twitch'

export type Lang = 'en' | 'fr'

/** Langues proposées dans Réglages, chacune écrite dans sa propre langue. */
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' }
]

export type Params = Record<string, string | number>
export type Dict = Record<string, string>
export interface Messages {
  en: Dict
  fr: Dict
}

const AREAS: Messages[] = [main, library, shell, steam, twitch]
const TABLE: Record<Lang, Dict> = {
  en: Object.assign({}, ...AREAS.map((a) => a.en)),
  fr: Object.assign({}, ...AREAS.map((a) => a.fr))
}

let current: Lang = 'en'

export const isLang = (v: unknown): v is Lang => v === 'en' || v === 'fr'
export const setLang = (lang: Lang): void => {
  current = lang
}
export const getLang = (): Lang => current
/** Étiquette BCP 47 pour Intl (dates, nombres, tri). */
export const locale = (lang: Lang = current): string => (lang === 'fr' ? 'fr-FR' : 'en-US')

/** Texte de la clé dans la langue en cours, paramètres remplacés. */
export function t(key: string, params?: Params): string {
  const text = TABLE[current][key] ?? TABLE.en[key] ?? key
  return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text
}

/**
 * Pluriel : clés « <key>.one » et « <key>.other », {n} disponible. Anglais : 1 seul est au
 * singulier ; français : 0 et 1 (« 0 jeu », « 1 jeu », « 2 jeux »).
 */
export function tn(key: string, n: number, params?: Params): string {
  const one = current === 'fr' ? Math.abs(n) < 2 : n === 1
  return t(`${key}.${one ? 'one' : 'other'}`, { n, ...params })
}
