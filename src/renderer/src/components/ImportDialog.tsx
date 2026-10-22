import { ChevronDown, FolderInput, FolderOpen, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ScanCandidate } from '../../../shared/types'
import { baseName } from '../format'
import { useCanvasHold } from '../fx/loop'
import { CheckMark, DialogFrame, DialogHead } from './AddDialog'

// Importer un dossier de jeux (SPEC 5.12, 780 px) : un sous-dossier par jeu.
// Chaque ligne : case (cochée par défaut pour un jeu qui n'est pas déjà dans la
// bibliothèque), nom modifiable, menu du programme à lancer, nom du dossier,
// étiquette (déjà dans la bibliothèque, outil ou émulateur, installateur, aucun
// programme). Pied : compteur + Importer.

interface Row extends ScanCandidate {
  checked: boolean
}

interface Props {
  onClose: () => void
  onToast: (level: 'info' | 'success' | 'error', message: string, opts?: { title?: string; detail?: string }) => void
}

const OTHER = '__other'

const relative = (file: string, root: string): string =>
  file.toLowerCase().startsWith(root.toLowerCase()) ? file.slice(root.length + 1) : file

function Tag({ row }: { row: Row }): React.JSX.Element | null {
  if (row.alreadyInLibrary) return <span className="tag">Déjà dans la bibliothèque</span>
  if (row.kind === 'installer')
    return (
      <span className="tag warn">
        <TriangleAlert />
        Installateur, pas un jeu installé
      </span>
    )
  if (row.kind === 'tool') return <span className="tag">Outil ou émulateur</span>
  if (row.kind === 'empty' && !row.exePath)
    return (
      <span className="tag warn">
        <TriangleAlert />
        Aucun programme trouvé
      </span>
    )
  return null
}

export function ImportDialog({ onClose, onToast }: Props): React.JSX.Element {
  // les canevas de la bibliothèque (poussière du bandeau…) restent figés derrière le dialogue
  useCanvasHold()
  const [folder, setFolder] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const scanId = useRef(0)

  async function scan(dir: string): Promise<void> {
    const id = ++scanId.current
    setFolder(dir)
    setRows(null)
    const found = await window.essaim.scanGamesFolder(dir).catch(() => [] as ScanCandidate[])
    // un autre dossier a été choisi entre-temps, ou le dialogue est fermé
    if (id !== scanId.current) return
    setRows(found.map((c) => ({ ...c, checked: c.kind === 'game' && !c.alreadyInLibrary })))
  }

  useEffect(() => {
    window.essaim
      .defaultGamesFolder()
      .then(scan)
      .catch(() => setRows([]))
    return () => {
      scanId.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (i: number, patch: Partial<Row>): void =>
    setRows((r) => r && r.map((row, j) => (j === i ? { ...row, ...patch } : row)))

  async function chooseFolder(): Promise<void> {
    const dir = await window.essaim.pickFolder(folder)
    if (dir) void scan(dir)
  }

  async function chooseExe(i: number, row: Row): Promise<void> {
    const exe = await window.essaim.pickExe(row.folder)
    if (exe) update(i, { exePath: exe, exeOptions: [exe, ...row.exeOptions.filter((o) => o !== exe)], checked: true })
  }

  const selected = rows?.filter((r) => r.checked && r.exePath) ?? []
  const n = selected.length

  async function submit(): Promise<void> {
    if (!n || busy) return
    setBusy(true)
    let added = 0
    try {
      added = await window.essaim.importGames(
        selected.map((r) => ({ name: r.name, exePath: r.exePath!, args: r.args, installDir: r.installDir }))
      )
    } catch {
      setBusy(false)
      onToast('error', 'L’import n’a pas pu se faire. Réessaie.')
      return
    }
    setBusy(false)
    onToast('success', `${added} jeu${added > 1 ? 'x' : ''} ajouté${added > 1 ? 's' : ''}. Les jaquettes arrivent une par une.`)
    onClose()
  }

  return (
    <DialogFrame kind="import" size="wide" labelledBy="import-title" busy={busy} onClose={onClose}>
      <DialogHead
        id="import-title"
        cap={rows ? '02.4 · Import — analyse terminée' : '02.4 · Import — analyse en cours'}
        title="Importer un dossier de jeux"
        onClose={onClose}
        busy={busy}
      />
      <div className="field">
        <div className="lab">
          <span className="cap">Dossier qui contient tes jeux (un sous-dossier par jeu)</span>
          {rows && (
            <span className="cap">
              {rows.length} sous-dossier{rows.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="path-row">
          <input
            className="inp ro"
            type="text"
            readOnly
            tabIndex={-1}
            value={folder}
            title={folder}
            aria-label="Dossier qui contient tes jeux"
          />
          <button type="button" className="btn btn-line" disabled={busy} data-testid="folder-pick" onClick={chooseFolder}>
            <FolderOpen />
            Changer…
          </button>
        </div>
      </div>

      {!rows ? (
        <div className="scan-busy" aria-busy="true">
          <LoaderCircle className="spin" />
          Analyse du dossier…
        </div>
      ) : rows.length === 0 ? (
        <div className="scan-busy">Aucun sous-dossier trouvé.</div>
      ) : (
        <div className="imp" role="list" aria-label="Sous-dossiers trouvés">
          {rows.map((row, i) => {
            const can = !!row.exePath
            const on = row.checked && can
            return (
              <div key={row.folder} className={`imp-row${on ? ' on' : ''}`} role="listitem" data-testid="import-row">
                <span className={`cbox${on ? ' on' : ''}${can ? '' : ' dis'}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!can || busy}
                    aria-label={`Importer ${row.name || baseName(row.folder)}`}
                    onChange={(e) => update(i, { checked: e.target.checked })}
                  />
                  <CheckMark />
                </span>
                <div className="imp-main">
                  <input
                    type="text"
                    className="imp-name"
                    value={row.name}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                    aria-label="Nom du jeu"
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                  <div className="imp-sub">
                    {can ? (
                      <span className="sel" title={row.exePath!}>
                        <span>{relative(row.exePath!, row.folder)}</span>
                        <ChevronDown />
                        <select
                          value={row.exePath!}
                          disabled={busy}
                          aria-label={`Programme qui lance ${row.name || baseName(row.folder)}`}
                          onChange={(e) => (e.target.value === OTHER ? void chooseExe(i, row) : update(i, { exePath: e.target.value }))}
                        >
                          {row.exeOptions.map((o) => (
                            <option key={o} value={o}>
                              {relative(o, row.folder)}
                            </option>
                          ))}
                          <option value={OTHER}>Autre programme…</option>
                        </select>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-line btn-sm" disabled={busy} onClick={() => chooseExe(i, row)}>
                        <FolderOpen />
                        Choisir le programme…
                      </button>
                    )}
                    <span className="fold" title={row.folder}>
                      {baseName(row.folder)}
                    </span>
                  </div>
                </div>
                <Tag row={row} />
              </div>
            )
          })}
        </div>
      )}

      <div className="dfoot">
        <span className="cap count" aria-live="polite">
          {rows ? (n ? `${n} jeu${n > 1 ? 'x' : ''} sélectionné${n > 1 ? 's' : ''}` : 'Aucun jeu sélectionné') : ''}
        </span>
        <button type="button" className="btn btn-line" disabled={busy} data-testid="dialog-cancel" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !n} data-testid="dialog-submit" onClick={submit}>
          {busy ? <LoaderCircle className="spin" /> : <FolderInput />}
          Importer
        </button>
      </div>
    </DialogFrame>
  )
}
