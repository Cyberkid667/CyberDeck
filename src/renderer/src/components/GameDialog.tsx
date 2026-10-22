import { FolderOpen, Gamepad2, ImageUp, Info, LoaderCircle, Plus, Search } from 'lucide-react'
import { useRef, useState } from 'react'
import { cleanGameName } from '../../../shared/gameName'
import { PLATFORM_INFO } from '../../../shared/platforms'
import type { Game } from '../../../shared/types'
import { baseName, dirName, errorText } from '../format'
import { LANDSCAPE_MATRIX_FILTER } from '../fx/pixelMatrix'
import { gameFolder } from '../platformUi'
import { DialogFrame, DialogHead, ErrorLine, Keys } from './AddDialog'
import { PixelMatrix } from './PixelMatrix'

// Ajouter / Modifier un jeu (SPEC 5.12, 780 px) : bandeau d'information après une
// installation, billet de la jaquette à gauche (2:3, talon perforé), champs à droite :
// nom (Inter), programme à lancer (.exe) + Parcourir…, options de lancement
// (facultatif) et, en modification, la jaquette (Chercher sur Steam / Choisir une image…).
// Jeu de plateforme (Steam, Epic…) : il se lance par sa plateforme, donc seuls le nom et
// la jaquette se modifient ; le programme et les options laissent place à une fiche à
// pointillés en lecture seule (plateforme, identifiant, dossier, lancement).

/** Fiche en lecture seule d'un jeu de plateforme (même dessin que l'onglet Infos). */
function PlatformSheet({ game }: { game: Game }): React.JSX.Element {
  const name = PLATFORM_INFO[game.platform].name
  const folder = gameFolder(game)
  const launch = game.launch ? [game.launch.target, game.launch.kind === 'exe' ? game.launch.args : null].filter(Boolean).join(' ') : ''
  return (
    <div className="field">
      <div className="lab">
        <span className="cap">Fiche de la plateforme</span>
        <span className="cap">Lecture seule</span>
      </div>
      <div className="psheet" data-testid="game-platform-sheet">
        <div className="irow">
          <span className="k">
            <span className="cap">Plateforme</span>
          </span>
          <span className="v">
            <span className="ell">{name}</span>
          </span>
        </div>
        <div className="irow">
          <span className="k">
            <span className="cap">Identifiant</span>
          </span>
          <span className="v">
            <span className="ell sub" title={game.platformId ?? ''}>
              {game.platformId ?? '—'}
            </span>
          </span>
        </div>
        <div className="irow">
          <span className="k">
            <span className="cap">Dossier</span>
          </span>
          <span className="v">
            <span className={`ell${folder && game.installed ? '' : ' sub'}`} title={folder ?? ''}>
              {game.installed ? (folder ?? '—') : 'Pas installé sur ce PC'}
            </span>
          </span>
        </div>
        <div className="irow">
          <span className="k">
            <span className="cap">Lancement</span>
          </span>
          <span className="v">
            <span className="ell sub" title={launch}>
              {launch ? `Par ${name} · ${launch}` : `Par ${name}`}
            </span>
          </span>
        </div>
      </div>
      <div className="hint mute">Ce jeu se lance par {name} : ici, seuls son nom et sa jaquette se modifient.</div>
    </div>
  )
}

export interface GameDialogState {
  mode: 'add' | 'edit'
  game?: Game
  preset?: { name: string; exePath: string | null; installDir: string | null; torrentId: string | null }
  banner?: string
}

interface Props extends GameDialogState {
  onClose: () => void
  onToast: (level: 'info' | 'success' | 'error', message: string, opts?: { title?: string; detail?: string }) => void
}

const EXE_MISSING = 'Choisis le programme (.exe) qui lance le jeu.'

/** Nom proposé d'après le dossier du programme (« Mon Jeu [v1.2] (x64) » → « Mon Jeu »). */
const guessName = (exe: string | null | undefined): string => (exe ? cleanGameName(baseName(dirName(exe))) : '')

/** Billet de la jaquette : image 2:3 (paysage : image entière sur sa matrice de points), sinon plaque gravée. */
function CoverTicket({ game, searching }: { game?: Game; searching: boolean }): React.JSX.Element {
  const src = game?.coverVersion ? `essaim://cover/${game.id}?v=${game.coverVersion}` : null
  const [broken, setBroken] = useState<string | null>(null)
  const shown = src && broken !== src ? src : null

  let cover: React.ReactNode
  let caption: string
  if (!game) {
    cover = (
      <div className="ph">
        <Gamepad2 />
      </div>
    )
    caption = 'Jaquette après l’ajout'
  } else if (shown && game.coverShape === 'landscape') {
    cover = (
      <div className="fcov land">
        <PixelMatrix className="pxbg" src={shown} cell={5} filter={LANDSCAPE_MATRIX_FILTER} />
        <img className="main" src={shown} alt="" decoding="async" onError={() => setBroken(shown)} />
      </div>
    )
    caption = 'Jaquette paysage'
  } else if (shown) {
    cover = <img src={shown} alt="" decoding="async" onError={() => setBroken(shown)} />
    caption = 'Jaquette 2:3'
  } else {
    cover = (
      <div className="ph">
        {game.iconVersion > 0 ? <img className="ico" src={`essaim://icon/${game.id}?v=${game.iconVersion}`} alt="" /> : <Gamepad2 />}
      </div>
    )
    caption = 'Sans jaquette'
  }
  return (
    <div className={`form-ticket${searching ? ' busy' : ''}`}>
      {cover}
      <div className="stub">
        <span className="cap">{searching ? 'Recherche…' : caption}</span>
      </div>
    </div>
  )
}

export function GameDialog({ mode, game, preset, banner, onClose, onToast }: Props): React.JSX.Element {
  const adding = mode === 'add'
  // jeu de plateforme : nom et jaquette seulement (le programme vient de la plateforme)
  const platformGame = !adding && !!game && game.platform !== 'local'
  const [name, setName] = useState(game?.name ?? (preset?.name || guessName(preset?.exePath)))
  const [exePath, setExePath] = useState(game?.exePath ?? preset?.exePath ?? '')
  const [installDir, setInstallDir] = useState(game?.installDir ?? preset?.installDir ?? null)
  const [args, setArgs] = useState(game?.args ?? '')
  const [busy, setBusy] = useState(false)
  const [coverBusy, setCoverBusy] = useState(false)
  const [error, setError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  async function pickExe(): Promise<void> {
    const start = exePath ? dirName(exePath) : (installDir ?? undefined)
    const p = await window.essaim.pickExe(start)
    if (!p) return
    setExePath(p)
    setError('')
    if (installDir && !p.toLowerCase().startsWith(installDir.toLowerCase())) setInstallDir(null)
    if (!name.trim()) setName(guessName(p))
  }

  async function save(): Promise<Game | null> {
    if (platformGame && game) {
      // seul le nom compte pour le processus principal ; le reste est renvoyé tel quel
      try {
        return await window.essaim.updateGame(game.id, {
          name: name.trim() || game.name,
          exePath: game.exePath,
          args: game.args,
          installDir: game.installDir,
          torrentId: game.torrentId
        })
      } catch (err) {
        setError(errorText(err))
        return null
      }
    }
    if (!exePath) {
      setError(EXE_MISSING)
      return null
    }
    const input = {
      name: name.trim() || guessName(exePath),
      exePath,
      args,
      installDir,
      torrentId: preset?.torrentId ?? game?.torrentId ?? null
    }
    try {
      return adding ? await window.essaim.addGame(input) : await window.essaim.updateGame(game!.id, input)
    } catch (err) {
      setError(errorText(err))
      return null
    }
  }

  async function submit(): Promise<void> {
    if (busy) return
    setBusy(true)
    const saved = await save()
    setBusy(false)
    if (!saved) {
      requestAnimationFrame(() => nameRef.current?.focus())
      return
    }
    onToast('success', adding ? 'Ajouté à la bibliothèque' : 'Jeu modifié', { detail: saved.name })
    onClose()
  }

  async function steamCover(): Promise<void> {
    if (coverBusy) return
    setCoverBusy(true)
    const saved = await save()
    const ok = saved ? await window.essaim.searchCover(saved.id).catch(() => false) : false
    setCoverBusy(false)
    if (saved)
      onToast(
        ok ? 'success' : 'error',
        ok ? 'Jaquette trouvée sur Steam' : 'Aucune jaquette trouvée sur Steam pour ce nom. Essaie un autre nom.',
        { title: 'Jaquette', detail: saved.name }
      )
  }

  async function fileCover(): Promise<void> {
    const file = await window.essaim.pickImage()
    if (!file || !game) return
    const ok = await window.essaim.setCoverFromFile(game.id, file).catch(() => false)
    onToast(ok ? 'success' : 'error', ok ? 'Jaquette changée' : 'Cette image ne peut pas être lue.', {
      title: 'Jaquette',
      detail: game.name
    })
  }

  return (
    <DialogFrame
      kind="game"
      size="wide"
      labelledBy="game-title"
      busy={busy}
      onClose={onClose}
      onEnter={submit}
      initialFocus={nameRef}
    >
      <DialogHead
        id="game-title"
        cap={banner ? '02.3 · Installation terminée' : '02.3 · Fiche du jeu'}
        title={adding ? 'Ajouter à la bibliothèque' : 'Modifier le jeu'}
        onClose={onClose}
        busy={busy}
      />
      {banner && (
        <div className="banner">
          <Info />
          <span>{banner}</span>
        </div>
      )}

      <div className="game-form">
        <CoverTicket game={adding ? undefined : game} searching={coverBusy} />
        <div className="game-fields">
          <div className="field">
            <label className="lab" htmlFor="game-name">
              <span className="cap">Nom du jeu</span>
            </label>
            <input
              id="game-name"
              ref={nameRef}
              className="inp sans"
              type="text"
              value={name}
              placeholder={guessName(exePath) || 'Nom affiché dans la bibliothèque'}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              data-testid="game-name"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {platformGame && game ? (
            <PlatformSheet game={game} />
          ) : (
            <>
              <div className="field">
                <div className="lab">
                  <span className="cap">Programme à lancer (.exe)</span>
                </div>
                <div className="path-row">
                  <input
                    className={`inp ro${error === EXE_MISSING ? ' invalid' : ''}`}
                    type="text"
                    readOnly
                    tabIndex={-1}
                    value={exePath}
                    placeholder="Aucun programme choisi"
                    title={exePath}
                    aria-label="Programme à lancer"
                    data-testid="game-exe"
                  />
                  <button type="button" className="btn btn-line" disabled={busy} onClick={pickExe}>
                    <FolderOpen />
                    Parcourir…
                  </button>
                </div>
              </div>
              <div className="field">
                <div className="lab">
                  <label className="cap" htmlFor="game-args">
                    Options de lancement
                  </label>
                  <span className="cap">Facultatif</span>
                </div>
                <input
                  id="game-args"
                  className="inp"
                  type="text"
                  value={args}
                  placeholder="En général vide. Pour un émulateur : le fichier du jeu."
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                  data-testid="game-args"
                  onChange={(e) => setArgs(e.target.value)}
                />
              </div>
            </>
          )}
          {adding ? (
            <div className="hint mute">La jaquette sera cherchée sur Steam d’après le nom. Tu pourras la changer avec Modifier.</div>
          ) : (
            <div className="field">
              <div className="lab">
                <span className="cap">Jaquette</span>
              </div>
              <div className="row-btns">
                <button
                  type="button"
                  className={`btn btn-line${coverBusy ? ' busy' : ''}`}
                  disabled={coverBusy || busy}
                  aria-busy={coverBusy || undefined}
                  onClick={steamCover}
                >
                  {coverBusy ? <LoaderCircle className="spin" /> : <Search />}
                  Chercher sur Steam
                </button>
                <button type="button" className="btn btn-line" disabled={busy || !game} onClick={fileCover}>
                  <ImageUp />
                  Choisir une image…
                </button>
              </div>
              <div className="hint mute">La recherche Steam utilise le nom du jeu ci-dessus.</div>
            </div>
          )}
        </div>
      </div>

      <ErrorLine message={error} />

      <div className="dfoot">
        <Keys keys={[['Entrée', adding ? 'ajouter' : 'enregistrer']]} />
        <button type="button" className="btn btn-line" disabled={busy} data-testid="dialog-cancel" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} data-testid="dialog-submit" onClick={submit}>
          {busy ? <LoaderCircle className="spin" /> : adding ? <Plus /> : null}
          {adding ? 'Ajouter' : 'Enregistrer'}
        </button>
      </div>
    </DialogFrame>
  )
}
