import { FolderOpen, Gamepad2, ImageUp, Info, LoaderCircle, Plus, Search } from 'lucide-react'
import { useRef, useState } from 'react'
import { cleanGameName } from '../../../shared/gameName'
import { PLATFORM_INFO } from '../../../shared/platforms'
import type { Game } from '../../../shared/types'
import { baseName, dirName, errorText } from '../format'
import { LANDSCAPE_MATRIX_FILTER } from '../fx/pixelMatrix'
import { useT } from '../i18n'
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
  const { t } = useT()
  const name = PLATFORM_INFO[game.platform].name
  const folder = gameFolder(game)
  const launch = game.launch ? [game.launch.target, game.launch.kind === 'exe' ? game.launch.args : null].filter(Boolean).join(' ') : ''
  return (
    <div className="field">
      <div className="lab">
        <span className="cap">{t('library.game.sheetCap')}</span>
        <span className="cap">{t('library.game.readOnly')}</span>
      </div>
      <div className="psheet" data-testid="game-platform-sheet">
        <div className="irow">
          <span className="k">
            <span className="cap">{t('library.game.platform')}</span>
          </span>
          <span className="v">
            <span className="ell">{name}</span>
          </span>
        </div>
        <div className="irow">
          <span className="k">
            <span className="cap">{t('library.game.id')}</span>
          </span>
          <span className="v">
            <span className="ell sub" title={game.platformId ?? ''}>
              {game.platformId ?? '—'}
            </span>
          </span>
        </div>
        <div className="irow">
          <span className="k">
            <span className="cap">{t('library.game.folder')}</span>
          </span>
          <span className="v">
            <span className={`ell${folder && game.installed ? '' : ' sub'}`} title={folder ?? ''}>
              {game.installed ? (folder ?? '—') : t('library.common.notInstalledHere')}
            </span>
          </span>
        </div>
        <div className="irow">
          <span className="k">
            <span className="cap">{t('library.game.launch')}</span>
          </span>
          <span className="v">
            <span className="ell sub" title={launch}>
              {launch ? `${t('library.game.launchBy', { platform: name })} · ${launch}` : t('library.game.launchBy', { platform: name })}
            </span>
          </span>
        </div>
      </div>
      <div className="hint mute">{t('library.game.sheetHint', { platform: name })}</div>
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

/** Nom proposé d'après le dossier du programme (« Mon Jeu [v1.2] (x64) » → « Mon Jeu »). */
const guessName = (exe: string | null | undefined): string => (exe ? cleanGameName(baseName(dirName(exe))) : '')

/** Billet de la jaquette : image 2:3 (paysage : image entière sur sa matrice de points), sinon plaque gravée. */
function CoverTicket({ game, searching }: { game?: Game; searching: boolean }): React.JSX.Element {
  const { t } = useT()
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
    caption = t('library.game.coverAfterAdd')
  } else if (shown && game.coverShape === 'landscape') {
    cover = (
      <div className="fcov land">
        <PixelMatrix className="pxbg" src={shown} cell={5} filter={LANDSCAPE_MATRIX_FILTER} />
        <img className="main" src={shown} alt="" decoding="async" onError={() => setBroken(shown)} />
      </div>
    )
    caption = t('library.game.coverLandscape')
  } else if (shown) {
    cover = <img src={shown} alt="" decoding="async" onError={() => setBroken(shown)} />
    caption = t('library.game.coverPortrait')
  } else {
    cover = (
      <div className="ph">
        {game.iconVersion > 0 ? <img className="ico" src={`essaim://icon/${game.id}?v=${game.iconVersion}`} alt="" /> : <Gamepad2 />}
      </div>
    )
    caption = t('library.cover.noCover')
  }
  return (
    <div className={`form-ticket${searching ? ' busy' : ''}`}>
      {cover}
      <div className="stub">
        <span className="cap">{searching ? t('library.game.searching') : caption}</span>
      </div>
    </div>
  )
}

export function GameDialog({ mode, game, preset, banner, onClose, onToast }: Props): React.JSX.Element {
  const { t } = useT()
  const EXE_MISSING = t('library.game.exeMissing')
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
    onToast('success', adding ? t('library.game.added') : t('library.game.updated'), { detail: saved.name })
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
        ok ? t('library.game.coverFound') : t('library.game.coverNotFound'),
        { title: t('library.game.cover'), detail: saved.name }
      )
  }

  async function fileCover(): Promise<void> {
    const file = await window.essaim.pickImage()
    if (!file || !game) return
    const ok = await window.essaim.setCoverFromFile(game.id, file).catch(() => false)
    onToast(ok ? 'success' : 'error', ok ? t('library.game.coverChanged') : t('library.game.imageUnreadable'), {
      title: t('library.game.cover'),
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
        cap={banner ? t('library.game.capInstalled') : t('library.game.capDetails')}
        title={adding ? t('library.game.titleAdd') : t('library.game.titleEdit')}
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
              <span className="cap">{t('library.common.gameName')}</span>
            </label>
            <input
              id="game-name"
              ref={nameRef}
              className="inp sans"
              type="text"
              value={name}
              placeholder={guessName(exePath) || t('library.game.namePlaceholder')}
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
                  <span className="cap">{t('library.game.exeLabel')}</span>
                </div>
                <div className="path-row">
                  <input
                    className={`inp ro${error === EXE_MISSING ? ' invalid' : ''}`}
                    type="text"
                    readOnly
                    tabIndex={-1}
                    value={exePath}
                    placeholder={t('library.game.exePlaceholder')}
                    title={exePath}
                    aria-label={t('library.game.exeAria')}
                    data-testid="game-exe"
                  />
                  <button type="button" className="btn btn-line" disabled={busy} onClick={pickExe}>
                    <FolderOpen />
                    {t('library.game.browse')}
                  </button>
                </div>
              </div>
              <div className="field">
                <div className="lab">
                  <label className="cap" htmlFor="game-args">
                    {t('library.game.args')}
                  </label>
                  <span className="cap">{t('library.game.optional')}</span>
                </div>
                <input
                  id="game-args"
                  className="inp"
                  type="text"
                  value={args}
                  placeholder={t('library.game.argsPlaceholder')}
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
            <div className="hint mute">{t('library.game.addHint')}</div>
          ) : (
            <div className="field">
              <div className="lab">
                <span className="cap">{t('library.game.cover')}</span>
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
                  {t('library.game.searchSteam')}
                </button>
                <button type="button" className="btn btn-line" disabled={busy || !game} onClick={fileCover}>
                  <ImageUp />
                  {t('library.game.chooseImage')}
                </button>
              </div>
              <div className="hint mute">{t('library.game.searchHint')}</div>
            </div>
          )}
        </div>
      </div>

      <ErrorLine message={error} />

      <div className="dfoot">
        <Keys keys={[[t('library.common.keyEnter'), adding ? t('library.game.actAdd') : t('library.game.actSave')]]} />
        <button type="button" className="btn btn-line" disabled={busy} data-testid="dialog-cancel" onClick={onClose}>
          {t('library.common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} data-testid="dialog-submit" onClick={submit}>
          {busy ? <LoaderCircle className="spin" /> : adding ? <Plus /> : null}
          {adding ? t('library.game.add') : t('library.common.save')}
        </button>
      </div>
    </DialogFrame>
  )
}
