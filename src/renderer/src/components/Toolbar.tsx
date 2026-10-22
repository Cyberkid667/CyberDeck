import { FolderOpen, Pause, Play, Plus, Search, Trash2, X } from 'lucide-react'
import { useRef } from 'react'

// Barre d'outils de la vue Torrents : titre de vue (≥ 1360 px), Ajouter (principal),
// séparateur, Reprendre, Pause, Supprimer, Ouvrir le dossier (libellés toujours
// visibles), recherche. ViewTitle et SearchBox servent aussi à la bibliothèque.

/** Titre de vue : légende « 01 · TORRENTS » + titre mono 300 26 px + compteur en exposant (masqué sous 1360 px). */
export function ViewTitle({ cap, title, count }: { cap: string; title: string; count: number }): React.JSX.Element {
  return (
    <div className="vtitle">
      <span className="cap">{cap}</span>
      <h1>
        {title}
        <sup>{count}</sup>
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
          aria-label="Effacer la recherche"
          title="Effacer la recherche (Échap)"
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
  const off = !!p.empty
  return (
    <div className="toolbar" role="toolbar" aria-label="Actions sur les torrents">
      <ViewTitle cap="01 · Torrents" title={p.title} count={p.count} />
      <button
        type="button"
        className="btn btn-primary"
        data-testid="btn-add-torrent"
        title="Ajouter un torrent (Ctrl+N)"
        aria-label="Ajouter un torrent (Ctrl+N)"
        onClick={p.onAdd}
      >
        <Plus />
        Ajouter
      </button>
      <div className="tsep" />
      <button
        type="button"
        className="btn"
        data-testid="btn-resume"
        disabled={off || !p.canResume}
        title="Reprendre"
        aria-label="Reprendre"
        onClick={p.onResume}
      >
        <Play />
        <span className="lbl">Reprendre</span>
      </button>
      <button
        type="button"
        className="btn"
        data-testid="btn-pause"
        disabled={off || !p.canPause}
        title="Mettre en pause"
        aria-label="Pause"
        onClick={p.onPause}
      >
        <Pause />
        <span className="lbl">Pause</span>
      </button>
      <button
        type="button"
        className="btn"
        data-testid="btn-remove"
        disabled={off || !p.hasSelection}
        title="Supprimer (Suppr)"
        aria-label="Supprimer (Suppr)"
        onClick={p.onRemove}
      >
        <Trash2 />
        <span className="lbl">Supprimer</span>
      </button>
      <button
        type="button"
        className="btn"
        data-testid="btn-open-folder"
        disabled={off || !p.hasSelection}
        title="Ouvrir le dossier (double-clic sur une ligne)"
        aria-label="Ouvrir le dossier (double-clic sur une ligne)"
        onClick={p.onOpenFolder}
      >
        <FolderOpen />
        <span className="lbl">Ouvrir le dossier</span>
      </button>
      <div className="spacer" />
      <SearchBox value={p.search} onChange={p.onSearch} placeholder="Rechercher un torrent" testId="torrent-search" />
    </div>
  )
}
