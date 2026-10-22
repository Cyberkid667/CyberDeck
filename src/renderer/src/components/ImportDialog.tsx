import { ChevronDown, FolderInput, FolderOpen, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ScanCandidate } from '../../../shared/types'
import { baseName } from '../format'
import { useCanvasHold } from '../fx/loop'
import { useT } from '../i18n'
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
  const { t } = useT()
  if (row.alreadyInLibrary) return <span className="tag">{t('library.import.tagInLibrary')}</span>
  if (row.kind === 'installer')
    return (
      <span className="tag warn">
        <TriangleAlert />
        {t('library.import.tagInstaller')}
      </span>
    )
  if (row.kind === 'tool') return <span className="tag">{t('library.import.tagTool')}</span>
  if (row.kind === 'empty' && !row.exePath)
    return (
      <span className="tag warn">
        <TriangleAlert />
        {t('library.import.tagNoExe')}
      </span>
    )
  return null
}

export function ImportDialog({ onClose, onToast }: Props): React.JSX.Element {
  const { t, tn } = useT()
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
      onToast('error', t('library.import.failed'))
      return
    }
    setBusy(false)
    onToast('success', tn('library.import.added', added))
    onClose()
  }

  return (
    <DialogFrame kind="import" size="wide" labelledBy="import-title" busy={busy} onClose={onClose}>
      <DialogHead
        id="import-title"
        cap={rows ? t('library.import.capDone') : t('library.import.capBusy')}
        title={t('library.common.importFolder')}
        onClose={onClose}
        busy={busy}
      />
      <div className="field">
        <div className="lab">
          <span className="cap">{t('library.import.folderLabel')}</span>
          {rows && (
            <span className="cap">{tn('library.import.subfolders', rows.length)}</span>
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
            aria-label={t('library.import.folderAria')}
          />
          <button type="button" className="btn btn-line" disabled={busy} data-testid="folder-pick" onClick={chooseFolder}>
            <FolderOpen />
            {t('library.import.change')}
          </button>
        </div>
      </div>

      {!rows ? (
        <div className="scan-busy" aria-busy="true">
          <LoaderCircle className="spin" />
          {t('library.import.scanning')}
        </div>
      ) : rows.length === 0 ? (
        <div className="scan-busy">{t('library.import.noSubfolders')}</div>
      ) : (
        <div className="imp" role="list" aria-label={t('library.import.listAria')}>
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
                    aria-label={t('library.import.rowAria', { name: row.name || baseName(row.folder) })}
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
                    aria-label={t('library.common.gameName')}
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
                          aria-label={t('library.import.exeAria', { name: row.name || baseName(row.folder) })}
                          onChange={(e) => (e.target.value === OTHER ? void chooseExe(i, row) : update(i, { exePath: e.target.value }))}
                        >
                          {row.exeOptions.map((o) => (
                            <option key={o} value={o}>
                              {relative(o, row.folder)}
                            </option>
                          ))}
                          <option value={OTHER}>{t('library.import.otherExe')}</option>
                        </select>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-line btn-sm" disabled={busy} onClick={() => chooseExe(i, row)}>
                        <FolderOpen />
                        {t('library.import.chooseExe')}
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
          {rows ? (n ? tn('library.import.selected', n) : t('library.import.noneSelected')) : ''}
        </span>
        <button type="button" className="btn btn-line" disabled={busy} data-testid="dialog-cancel" onClick={onClose}>
          {t('library.common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !n} data-testid="dialog-submit" onClick={submit}>
          {busy ? <LoaderCircle className="spin" /> : <FolderInput />}
          {t('library.import.submit')}
        </button>
      </div>
    </DialogFrame>
  )
}
