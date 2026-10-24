// Polices (SPEC 2.1) : familles « IBM Plex Mono » (300 titres, 400, 500, 600) et « Inter Variable ».
import '@fontsource/ibm-plex-mono/latin-300.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@fontsource/ibm-plex-mono/latin-600.css'
import '@fontsource-variable/inter/wght.css'
// Feuilles de style, dans cet ordre (launchers.css après dialogs.css : il adapte le billet Steam à la page).
import './styles/base.css'
import './styles/shell.css'
import './styles/torrents.css'
import './styles/library.css'
import './styles/details.css'
import './styles/dialogs.css'
import './styles/launchers.css'
import './styles/progress.css'
import './styles/steam.css'
import './styles/store.css'
import './styles/profile.css'
import './styles/community.css'
import './styles/twitch.css'

import { LucideProvider } from 'lucide-react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installContours } from './fx/contours'

// Lignes de niveau (--contours) : dessinées une seule fois au démarrage (~15 ms).
installContours()

// Toutes les icônes Lucide reçoivent la classe « i » : leur taille et leur trait
// viennent des feuilles de style (comme dans les maquettes), jamais des props.
createRoot(document.getElementById('root')!).render(
  <LucideProvider className="i" size={16} strokeWidth={1.5}>
    <App />
  </LucideProvider>
)
