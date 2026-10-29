import { Folder, FolderOpen, Gamepad2, ImageUp, Info, LoaderCircle, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cleanGameName } from '../../../shared/gameName'
import { PLATFORM_INFO } from '../../../shared/platforms'
import type { Game } from '../../../shared/types'
import { baseName, dirName, errorText } from '../format'
import { LANDSCAPE_MATRIX_FILTER } from '../fx/pixelMatrix'
import { useT } from '../i18n'
import { gameFolder } from '../platformUi'
import { CheckMark, DialogFrame, DialogHead, ErrorLine, Keys } from './AddDialog'
import { PixelMatrix } from './PixelMatrix'

// Ajouter / Modifier un jeu (SPEC 5.12, 780 px) : bandeau d'information après une
// installation, billet de la jaquette à gauche (2:3, talon perforé), champs à droite :
// nom (Inter), programme à lancer (.exe) + Parcourir…, options de lancement
// (facultatif) et, en modification, la jaquette (Chercher sur Steam / Choisir une image…).
// Jeu de plateforme (Steam, Epic…) : il se lance par sa plateforme, donc seuls le nom et
// la jaquette se modifient ; le programme et les options laissent place à une fiche à
// pointillés en lecture seule (plateforme, identifiant, dossier, lancement).
// Jeu web (page .html) : pas d'options de lancement ; dossier lisible par le jeu, case
// « Autoriser l'accès à Internet » et, en modification, « Supprimer les sauvegardes… »
// (en deux temps). Jeu web d'itch.io : la case et le bouton sous la fiche.

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

/** Page web : le jeu se joue dans une fenêtre CyberDeck. */
const isPage = (p: string | null | undefined): boolean => !!p && /\.html?$/i.test(p)

/** Le fichier est dans ce dossier (comparaison sans casse, barres unifiées). */
const inFolder = (file: string, dir: string): boolean => {
  const f = file.replace(/\//g, '\\').toLowerCase()
  const d = dir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return f.startsWith(d + '\\')
}

/**
 * Réglages d'un jeu web : case « Autoriser l'accès à Internet » (décochée par défaut) et, pour un
 * jeu déjà enregistré, bouton « Supprimer les sauvegardes… » en deux temps (retour au bout de 4 s).
 */
function HtmlOptions({
  network,
  onNetwork,
  game,
  busy,
  onToast
}: {
  network: boolean
  onNetwork: (v: boolean) => void
  game?: Game
  busy: boolean
  onToast: Props['onToast']
}): React.JSX.Element {
  const { t } = useT()
  const [armed, setArmed] = useState(false)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])

  async function clearSaves(): Promise<void> {
    if (!game || clearing) return
    if (!armed) return setArmed(true)
    setArmed(false)
    setClearing(true)
    const res = await window.essaim.clearGameSaves(game.id).catch((err) => ({ ok: false, error: errorText(err) }))
    setClearing(false)
    if (res.ok) onToast('success', t('library.game.savesCleared'), { detail: game.name })
    else onToast('error', res.error ?? '', { detail: game.name })
  }

  return (
    <div className="field html-opts">
      <label className={`check${network ? ' on' : ''}`}>
        <span className="cbox">
          <input type="checkbox" checked={network} disabled={busy} data-testid="game-allow-internet" onChange={(e) => onNetwork(e.target.checked)} />
          <CheckMark />
        </span>
        <span className="txt">{t('library.game.allowInternet')}</span>
      </label>
      <div className="hint mute">{t('library.game.allowInternetHint')}</div>
      {game?.html && (
        <div className="row-btns">
          <button
            type="button"
            className={`btn ${armed ? 'btn-danger' : 'btn-line'}`}
            disabled={busy || clearing}
            aria-busy={clearing || undefined}
            data-testid="game-clear-saves"
            onClick={() => void clearSaves()}
          >
            {clearing ? <LoaderCircle className="spin" /> : <Trash2 />}
            {armed ? t('library.game.clearSavesConfirm') : t('library.game.clearSaves')}
          </button>
        </div>
      )}
    </div>
  )
}

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
  // Linux : binaire, AppImage ou script (pas de .exe)
  const linux = window.essaim?.os === 'linux'
  const EXE_MISSING = t(linux ? 'library.game.exeMissingLinux' : 'library.game.exeMissing')
  const adding = mode === 'add'
  // jeu de plateforme : nom et jaquette seulement (le programme vient de la plateforme)
  const platformGame = !adding && !!game && game.platform !== 'local'
  const [name, setName] = useState(game?.name ?? (preset?.name || guessName(preset?.exePath)))
  const [exePath, setExePath] = useState(game?.exePath ?? preset?.exePath ?? '')
  const [installDir, setInstallDir] = useState(game?.installDir ?? preset?.installDir ?? null)
  const [args, setArgs] = useState(game?.args ?? '')
  // jeu web : accès à Internet (décoché par défaut)
  const [network, setNetwork] = useState(game?.html?.network ?? false)
  const web = isPage(exePath)
  const platformWeb = platformGame && !!game?.html
  const [busy, setBusy] = useState(false)
  const [coverBusy, setCoverBusy] = useState(false)
  const [error, setError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  async function pickExe(): Promise<void> {
    const start = exePath ? dirName(exePath) : (installDir ?? undefined)
    const pick = await window.essaim.pickGameFile(start)
    if (!pick) return
    setExePath(pick.path)
    setError('')
    // dossier du jeu gardé s'il contient le fichier choisi
    if (!installDir || !inFolder(pick.path, installDir)) setInstallDir(pick.installDir)
    if (!name.trim()) setName(pick.name)
  }

  async function pickFolder(): Promise<void> {
    const start = installDir ?? (exePath ? dirName(exePath) : undefined)
    try {
      const pick = await window.essaim.pickGameFolder(start)
      if (!pick) return
      setExePath(pick.path)
      setInstallDir(pick.installDir)
      setError('')
      if (adding || !name.trim()) setName(pick.name)
    } catch (err) {
      setError(errorText(err))
    }
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
          torrentId: game.torrentId,
          ...(platformWeb ? { htmlNetwork: network } : {})
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
      // jeu web sans nom : le processus principal le lit dans la page
      name: name.trim() || (web ? '' : guessName(exePath)),
      exePath,
      args: web ? null : args,
      installDir,
      torrentId: preset?.torrentId ?? game?.torrentId ?? null,
      ...(web ? { htmlNetwork: network } : {})
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
            <>
              <PlatformSheet game={game} />
              {platformWeb && <HtmlOptions network={network} onNetwork={setNetwork} game={game} busy={busy} onToast={onToast} />}
            </>
          ) : (
            <>
              <div className="field">
                <div className="lab">
                  <span className="cap">{t(linux ? 'library.game.exeLabelLinux' : 'library.game.exeLabel')}</span>
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
                  <button type="button" className="btn btn-line" disabled={busy} data-testid="game-browse" onClick={pickExe}>
                    <FolderOpen />
                    {t('library.game.browse')}
                  </button>
                  <button type="button" className="btn btn-line" disabled={busy} data-testid="game-browse-folder" onClick={() => void pickFolder()}>
                    <Folder />
                    {t('library.game.browseFolder')}
                  </button>
                </div>
              </div>
              {web ? (
                <>
                  <div className="field html-note">
                    <div className="hint mute">{t('library.game.htmlNote')}</div>
                    <p className="dnote mono ell" title={installDir ?? dirName(exePath)} data-testid="game-html-folder">
                      {installDir ?? dirName(exePath)}
                    </p>
                  </div>
                  <HtmlOptions
                    network={network}
                    onNetwork={setNetwork}
                    game={!adding && game?.html ? game : undefined}
                    busy={busy}
                    onToast={onToast}
                  />
                </>
              ) : (
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
              )}
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
