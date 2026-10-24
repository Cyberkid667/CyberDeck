import { FolderOpen, Pause, Play, Plus, Search, Trash2, X } from 'lucide-react'
import { useRef } from 'react'
import { useT } from '../i18n'

// Barre d'outils de la vue Torrents : titre de vue (≥ 1360 px), Ajouter (principal),
// séparateur, Reprendre, Pause, Supprimer, Ouvrir le dossier (libellés toujours
// visibles), recherche. ViewTitle et SearchBox servent aussi à la bibliothèque.

/** Titre de vue : légende « TORRENTS » + titre mono 300 26 px + compteur en exposant (masqué sous 1360 px). */
/** Titre de vue sans compteur (l'utilisateur ne veut aucune numérotation) ; count reste accepté pour les appels existants. */
export function ViewTitle({ cap, title }: { cap: string; title: string; count?: number }): React.JSX.Element {
  return (
    <div className="vtitle">
      <span className="cap">{cap}</span>
      <h1>
        {title}
      </h1>
    </div>
  )
}

interface SearchProps {
  value: string
  onChange: (value: string) => void
  /** « Rechercher un torrent » / « Rechercher un jeu » (sert aussi d'aria-label) */
  placeholder: string
  /** data-testid posé sur le champ (torrent-search, library-search) */
  testId?: string
  disabled?: boolean
}

/** Recherche : loupe, champ mono, bouton ✕ dès qu'il y a du texte ; Échap vide le champ. */
export function SearchBox({ value, onChange, placeholder, testId, disabled }: SearchProps): React.JSX.Element {
  const { t } = useT()
  const input = useRef<HTMLInputElement>(null)
  return (
    <label className={`search${disabled ? ' dis' : ''}`}>
      <Search />
      <input
        ref={input}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            e.stopPropagation()
            onChange('')
          }
        }}
      />
      {value && !disabled && (
        <button
          type="button"
          className="clear"
          aria-label={t('shell.search.clear')}
          title={t('shell.search.clearTitle')}
          onClick={() => {
            onChange('')
            input.current?.focus()
          }}
        >
          <X />
        </button>
      )}
    </label>
  )
}

interface Props {
  /** titre de la vue : « Tous », « En cours », « Terminés », « En partage » */
  title: string
  /** compteur en exposant */
  count: number
  canResume: boolean
  canPause: boolean
  hasSelection: boolean
  /** liste vide : tout sauf Ajouter est désactivé */
  empty?: boolean
  search: string
  onSearch: (s: string) => void
  onAdd: () => void
  onResume: () => void
  onPause: () => void
  onRemove: () => void
  onOpenFolder: () => void
}

export function Toolbar(p: Props): React.JSX.Element {
  const { t } = useT()
  const off = !!p.empty
  return (
    <div className="toolbar" role="toolbar" aria-label={t('shell.toolbar.label')}>
      <ViewTitle cap="Torrents" title={p.title} count={p.count} />
      <button
        type="button"
        className="btn btn-primary"
        data-testid="btn-add-torrent"
        title={t('shell.toolbar.addTitle')}
        aria-label={t('shell.toolbar.addTitle')}
        onClick={p.onAdd}
      >
        <Plus />
        {t('shell.toolbar.add')}
      </button>
      <div className="tsep" />
      <button
        type="button"
        className="btn"
        data-testid="btn-resume"
        disabled={off || !p.canResume}
        title={t('shell.toolbar.resume')}
        aria-label={t('shell.toolbar.resume')}
        onClick={p.onResume}
      >
        <Play />
        <span className="lbl">{t('shell.toolbar.resume')}</span>
      </button>
      <button
        type="button"
        className="btn"
        data-testid="btn-pause"
        disabled={off || !p.canPause}
        title={t('shell.toolbar.pauseTitle')}
        aria-label={t('shell.toolbar.pause')}
        onClick={p.onPause}
      >
        <Pause />
        <span className="lbl">{t('shell.toolbar.pause')}</span>
      </button>
      <button
        type="button"
        className="btn"
        data-testid="btn-remove"
        disabled={off || !p.hasSelection}
        title={t('shell.toolbar.removeTitle')}
        aria-label={t('shell.toolbar.removeTitle')}
        onClick={p.onRemove}
      >
        <Trash2 />
        <span className="lbl">{t('shell.toolbar.remove')}</span>
      </button>
      <button
        type="button"
        className="btn"
        data-testid="btn-open-folder"
        disabled={off || !p.hasSelection}
        title={t('shell.toolbar.openFolderTitle')}
        aria-label={t('shell.toolbar.openFolderTitle')}
        onClick={p.onOpenFolder}
      >
        <FolderOpen />
        <span className="lbl">{t('shell.toolbar.openFolder')}</span>
      </button>
      <div className="spacer" />
      <SearchBox value={p.search} onChange={p.onSearch} placeholder={t('shell.toolbar.search')} testId="torrent-search" />
    </div>
  )
}
