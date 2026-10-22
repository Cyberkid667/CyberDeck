// Langue de l'interface côté fenêtre. App fixe la langue (réglage « language ») avec setLang
// avant de se dessiner et la transmet par LangContext : les composants appellent useT() pour
// être redessinés quand elle change (même les composants mémorisés).
import { createContext, useContext, useEffect } from 'react'
import { getLang, locale, t, tn, type Lang } from '../../shared/i18n'

const LangContext = createContext<Lang>('en')

export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }): React.JSX.Element {
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>
}

/** Fonctions de traduction ; le composant se redessine au changement de langue. */
export function useT(): { t: typeof t; tn: typeof tn; lang: Lang; locale: string } {
  const lang = useContext(LangContext)
  return { t, tn, lang, locale: locale(lang) }
}

export { getLang, t, tn }
