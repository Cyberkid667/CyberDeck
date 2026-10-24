import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, Gamepad2, Heart, LibraryBig, Play, RotateCw, ShoppingCart, WifiOff, ArrowDownToLine } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Game, LibraryState, StoreApp, StoreError, StoreHome, StoreItem, StoreList, StoreListKind, StorePrice, StoreSearch } from '../../../shared/types'
import { useT } from '../i18n'
import { canPlayState, gameState } from '../platformUi'
import { SearchBox } from './Toolbar'

// Onglet MAGASIN de la vue Steam (passe 2 de la refonte « Steam dans CyberDeck ») : la structure du
// magasin du client Steam, aux couleurs de l'app.
//   - barre du magasin : À la une · Offres · Meilleures ventes · Nouveautés · Prochainement · recherche ;
//   - À la une : grand carrousel (défile seul, s'arrête au survol, flèches), puis les étagères ;
//   - listes (offres…) et résultats de recherche : lignes façon page de recherche de Steam ;
//   - page d'un jeu : images (grande vue + vignettes), présentation, évaluations, sortie,
//     développeur / éditeur, étiquettes, plateformes, prix et boutons « Acheter sur Steam » /
//     « Ajouter à la liste de souhaits sur Steam » (les achats se font toujours dans Steam) ;
//     jeu possédé : « Dans ta bibliothèque » + Jouer / Installer + lien vers la page de la bibliothèque ;
//   - Retour (bouton et Échap), squelettes de chargement, hors ligne avec « Réessayer ».
// Les données viennent du processus principal (steamStore.ts : adresses publiques, cache).
// Aucun compteur ni numéro (choix de l'utilisateur) : prix et réductions seulement.

const NAV: ('featured' | StoreListKind)[] = ['featured', 'specials', 'topsellers', 'newreleases', 'comingsoon']

type Route =
  | { kind: 'home'; scroll?: number }
  | { kind: 'list'; list: StoreListKind; scroll?: number }
  | { kind: 'search'; term: string; scroll?: number }
  | { kind: 'app'; appid: number; seed: StoreItem | null; scroll?: number }

const routeKey = (r: Route): string =>
  r.kind === 'home' ? 'home' : r.kind === 'list' ? `list:${r.list}` : r.kind === 'search' ? `search:${r.term.toLowerCase()}` : `app:${r.appid}`

/** Vitrine : délai entre deux jeux. */
const HERO_DELAY = 6500
/** Recherche : délai après la dernière touche. */
const SEARCH_DELAY = 450
/** Tuiles d'une étagère de l'accueil. */
const SHELF_MAX = 16

const STORE_URL = 'https://store.steampowered.com/'
const appUrl = (appid: number): string => `https://store.steampowered.com/app/${appid}/`

function openLink(url: string): void {
  try {
    window.essaim.openExternalLink(url)
  } catch {
    /* pont pas encore prêt */
  }
}

/** Première lettre en capitale (« très positives » → « Très positives »). */
const capFirst = (s: string): string => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s)

const reviewTone = (score: number): string => (score >= 6 ? 'pos' : score === 5 ? 'mixed' : 'neg')

// ---------- Chargement ----------

interface Loaded<T> {
  data: T | null
  loading: boolean
  /** erreur de la dernière lecture (les données peuvent être une ancienne copie) */
  error: StoreError | null
  retry: () => void
}

/** Lit une page du magasin par le processus principal ; key change : relecture. */
function useStoreData<T extends { error: StoreError | null }>(key: string | null, fetcher: (refresh: boolean) => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; loading: boolean; error: StoreError | null }>({ key: null, data: null, loading: !!key, error: null })
  const [nonce, setNonce] = useState(0)
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher
  useEffect(() => {
    if (!key) return
    let alive = true
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, data: null, loading: true, error: null }))
    let p: Promise<T>
    try {
      p = fetchRef.current(nonce > 0)
    } catch {
      p = Promise.reject(new Error('bridge'))
    }
    p.then(
      (data) => alive && setState({ key, data, loading: false, error: data?.error ?? null }),
      () => alive && setState((s) => ({ key, data: s.key === key ? s.data : null, loading: false, error: 'unavailable' }))
    )
    return () => {
      alive = false
    }
  }, [key, nonce])
  const retry = useCallback(() => setNonce((n) => n + 1), [])
  const same = state.key === key
  return { data: same ? state.data : null, loading: same ? state.loading : !!key, error: same ? state.error : null, retry }
}

// ---------- Petits morceaux ----------

/** Image du magasin qui disparaît si elle ne se charge pas (fond neutre à la place). */
function Img({ src, className, alt = '' }: { src: string | null; className?: string; alt?: string }): React.JSX.Element {
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src)
    return (
      <span className={`sto-img none${className ? ' ' + className : ''}`} aria-hidden="true">
        <Gamepad2 />
      </span>
    )
  return <img className={`sto-img${className ? ' ' + className : ''}`} src={src} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(src)} />
}

/** Bloc prix : réduction, ancien prix barré, prix payé (ou Gratuit). */
function Price({ price, comingSoon, big = false }: { price: StorePrice | null; comingSoon?: boolean; big?: boolean }): React.JSX.Element | null {
  const { t } = useT()
  if (!price) return comingSoon ? <span className={`sto-price soon${big ? ' big' : ''}`}>{t('store.comingSoon')}</span> : null
  if (price.free) return <span className={`sto-price free${big ? ' big' : ''}`}>{t('store.free')}</span>
  return (
    <span className={`sto-price${price.discount > 0 ? ' disc' : ''}${big ? ' big' : ''}`}>
      {price.discount > 0 && (
        <span className="pct" aria-label={t('store.discountAria', { pct: price.discount })}>
          -{price.discount}%
        </span>
      )}
      <span className="amt">
        {price.original && <s className="was">{price.original}</s>}
        <span className="now">{price.final}</span>
      </span>
    </span>
  )
}

function Platforms({ p }: { p: { windows: boolean; mac: boolean; linux: boolean } }): React.JSX.Element | null {
  const { t } = useT()
  const list = (['windows', 'mac', 'linux'] as const).filter((k) => p[k])
  if (!list.length) return null
  return (
    <span className="sto-pf" aria-label={t('store.app.platforms')}>
      {list.map((k) => (
        <span key={k} className="cap" title={t(`store.pf.${k}`)}>
          {t(`store.pfShort.${k}`)}
        </span>
      ))}
    </span>
  )
}

/** Date de sortie lisible (texte de l'éditeur, date, ou « Prochainement »). */
function useRelease(): (it: StoreItem) => string {
  const { t, locale } = useT()
  const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }), [locale])
  return useCallback(
    (it: StoreItem) => {
      if (it.releaseText) return it.releaseText
      if (it.releaseDate && !(it.comingSoon && it.releaseDate < Date.now())) return fmt.format(it.releaseDate)
      return it.comingSoon ? t('store.comingSoon') : ''
    },
    [fmt, t]
  )
}

function OwnedChip(): React.JSX.Element {
  const { t } = useT()
  return (
    <span className="sto-owned cap">
      <LibraryBig />
      {t('store.inLibrary')}
    </span>
  )
}

/** Tuile d'une étagère : en-tête du jeu, nom, prix. */
const Tile = memo(function Tile({ it, owned, onOpen }: { it: StoreItem; owned: boolean; onOpen: (it: StoreItem) => void }): React.JSX.Element {
  const { t } = useT()
  return (
    <button type="button" className={`sto-tile${owned ? ' owned' : ''}`} data-testid="store-tile" data-appid={it.appid} title={t('store.openTitle', { name: it.name })} onClick={() => onOpen(it)}>
      <span className="sto-tile-img">
        <Img src={it.header ?? it.capsule} />
        {owned && <OwnedChip />}
        {it.type !== 'game' && it.type !== 'other' && <span className="sto-kind cap">{t(`store.type.${it.type}`)}</span>}
      </span>
      <span className="nm">{it.name}</span>
      <span className="foot">
        {it.review ? <span className={`rv ${reviewTone(it.review.score)}`}>{capFirst(it.review.label)}</span> : <span className="rv" />}
        <Price price={it.price} comingSoon={it.comingSoon} />
      </span>
    </button>
  )
})

/** Ligne d'une liste ou d'une recherche (comme la page de recherche du magasin Steam). */
const Row = memo(function Row({ it, owned, release, onOpen }: { it: StoreItem; owned: boolean; release: string; onOpen: (it: StoreItem) => void }): React.JSX.Element {
  const { t } = useT()
  return (
    <button type="button" className={`sto-row${owned ? ' owned' : ''}`} data-testid="store-tile" data-appid={it.appid} title={t('store.openTitle', { name: it.name })} onClick={() => onOpen(it)}>
      <Img src={it.small ?? it.header} className="sto-row-img" />
      <span className="mid">
        <span className="nm">
          {it.name}
          {it.type !== 'game' && it.type !== 'other' && <span className="sto-kind inline cap">{t(`store.type.${it.type}`)}</span>}
        </span>
        <span className="sub">
          <Platforms p={it.platforms} />
          {it.tags.length > 0 && <span className="tg">{it.tags.slice(0, 4).join(' · ')}</span>}
        </span>
      </span>
      <span className="rel">{release}</span>
      <span className="rvw">
        {it.review ? <span className={`rv ${reviewTone(it.review.score)}`}>{capFirst(it.review.label)}</span> : null}
        {owned && <OwnedChip />}
      </span>
      <Price price={it.price} comingSoon={it.comingSoon} />
    </button>
  )
})

function Skeleton({ kind }: { kind: 'home' | 'list' | 'app' }): React.JSX.Element {
  const { t } = useT()
  return (
    <div className={`sto-skel k-${kind}`} aria-busy="true" aria-label={t('store.loading')}>
      {kind === 'home' && (
        <>
          <div className="sk hero" />
          {[0, 1].map((i) => (
            <div key={i} className="sk-shelf">
              <div className="sk line" />
              <div className="sk-strip">
                {[0, 1, 2, 3, 4].map((j) => (
                  <div key={j} className="sk tile" />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
      {kind === 'list' && [0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div key={i} className="sk row" />)}
      {kind === 'app' && (
        <div className="sk-app">
          <div className="sk viewer" />
          <div className="sk-side">
            <div className="sk head" />
            <div className="sk line" />
            <div className="sk line short" />
            <div className="sk line" />
          </div>
        </div>
      )}
    </div>
  )
}

function ErrorBox({ error, onRetry }: { error: StoreError; onRetry: () => void }): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="sto-error" data-testid="store-error" data-error={error}>
      <div className="box brackets">
        <WifiOff className="big" />
        <h2>{t(`store.error.${error}.title`)}</h2>
        <p>{t(`store.error.${error}.text`)}</p>
        <div className="acts">
          <button type="button" className="btn btn-line" data-testid="store-retry" onClick={onRetry}>
            <RotateCw />
            {t('store.retry')}
          </button>
          <button type="button" className="btn" onClick={() => openLink(STORE_URL)}>
            <ExternalLink />
            {t('store.openSteam')}
          </button>
        </div>
      </div>
    </div>
  )
}

function StaleNote({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="sto-stale" role="status">
      <WifiOff />
      <span>{t('store.stale')}</span>
      <button type="button" className="btn btn-sm btn-line" onClick={onRetry}>
        <RotateCw />
        {t('store.retry')}
      </button>
    </div>
  )
}

// ---------- À la une ----------

function Hero({ items, active, owned, onOpen }: { items: StoreItem[]; active: boolean; owned: (appid: number) => boolean; onOpen: (it: StoreItem) => void }): React.JSX.Element | null {
  const { t } = useT()
  const release = useRelease()
  const [i, setI] = useState(0)
  const [hover, setHover] = useState(false)
  const n = items.length
  const go = useCallback((d: number) => setI((x) => (x + d + n) % n), [n])
  // défile seul, sauf au survol, onglet caché ou fenêtre en arrière-plan ; repart du début après un clic
  useEffect(() => {
    if (!active || hover || n < 2) return
    const id = window.setTimeout(() => {
      if (document.visibilityState === 'visible') setI((x) => (x + 1) % n)
    }, HERO_DELAY)
    return () => window.clearTimeout(id)
  }, [i, active, hover, n])
  if (!n) return null
  const it = items[Math.min(i, n - 1)]
  const own = owned(it.appid)
  const rel = release(it)
  return (
    <section
      className="sto-hero"
      data-testid="store-hero"
      aria-roledescription="carousel"
      aria-label={t('store.hero.aria')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <header className="stv-sh">
        <h3 className="cap">{t('store.hero.cap')}</h3>
        <span className="rule" />
      </header>
      <div className="sto-hero-stage">
        <button type="button" className="sto-hero-arrow" aria-label={t('store.hero.prev')} title={t('store.hero.prev')} onClick={() => go(-1)} disabled={n < 2}>
          <ChevronLeft />
        </button>
        <button key={it.appid} type="button" className="sto-hero-card" data-testid="store-tile" data-appid={it.appid} title={t('store.openTitle', { name: it.name })} onClick={() => onOpen(it)}>
          <span className="main">
            <Img src={it.capsule} />
            {own && <OwnedChip />}
          </span>
          <span className="side">
            <span className="nm">{it.name}</span>
            <span className="shots">
              {it.screenshots.slice(0, 4).map((s) => (
                <Img key={s} src={s} />
              ))}
            </span>
            <span className="state cap">{it.comingSoon ? t('store.comingSoon') : t('store.hero.available')}</span>
            {rel && !it.comingSoon && <span className="rel">{rel}</span>}
            {it.tags.length > 0 && (
              <span className="tags">
                {it.tags.slice(0, 4).map((g) => (
                  <span key={g} className="sto-tag">
                    {g}
                  </span>
                ))}
              </span>
            )}
            <span className="buy">
              <Platforms p={it.platforms} />
              <Price price={it.price} comingSoon={it.comingSoon} />
            </span>
          </span>
        </button>
        <button type="button" className="sto-hero-arrow" aria-label={t('store.hero.next')} title={t('store.hero.next')} onClick={() => go(1)} disabled={n < 2}>
          <ChevronRight />
        </button>
      </div>
      {n > 1 && (
        <div className="sto-dots">
          {items.map((x, k) => (
            <button
              key={x.appid}
              type="button"
              className={k === i ? 'on' : undefined}
              aria-label={t('store.hero.goto', { name: x.name })}
              aria-current={k === i ? 'true' : undefined}
              title={x.name}
              onClick={() => setI(k)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function Shelf({
  kind,
  items,
  owned,
  onOpen,
  onMore
}: {
  kind: StoreListKind
  items: StoreItem[]
  owned: (appid: number) => boolean
  onOpen: (it: StoreItem) => void
  onMore: (kind: StoreListKind) => void
}): React.JSX.Element | null {
  const { t } = useT()
  const strip = useRef<HTMLDivElement>(null)
  const scroll = (dir: 1 | -1): void => {
    const el = strip.current
    if (el) el.scrollBy({ left: dir * Math.max(240, el.clientWidth - 120), behavior: 'smooth' })
  }
  if (!items.length) return null
  return (
    <section className="sto-shelf" data-testid="store-shelf" data-shelf={kind}>
      <header className="stv-sh">
        <h3 className="cap">{t(`store.nav.${kind}`)}</h3>
        <span className="rule" />
        <button type="button" className="btn btn-sm btn-line sto-more" onClick={() => onMore(kind)}>
          {t('store.shelf.more')}
        </button>
        <button type="button" className="stv-arrow" aria-label={t('steam.home.prev')} title={t('steam.home.prev')} onClick={() => scroll(-1)}>
          <ChevronLeft />
        </button>
        <button type="button" className="stv-arrow" aria-label={t('steam.home.next')} title={t('steam.home.next')} onClick={() => scroll(1)}>
          <ChevronRight />
        </button>
      </header>
      <div className="stv-strip sto-strip" ref={strip}>
        {items.slice(0, SHELF_MAX).map((it) => (
          <Tile key={it.appid} it={it} owned={owned(it.appid)} onOpen={onOpen} />
        ))}
      </div>
    </section>
  )
}

function HomePage({ active, owned, onOpen, onMore }: { active: boolean; owned: (appid: number) => boolean; onOpen: (it: StoreItem) => void; onMore: (k: StoreListKind) => void }): React.JSX.Element {
  const { lang } = useT()
  const res = useStoreData<StoreHome>(`home:${lang}`, (refresh) => window.essaim.getStoreHome(refresh))
  const d = res.data
  if (!d) return res.loading ? <Skeleton kind="home" /> : <ErrorBox error={res.error ?? 'unavailable'} onRetry={res.retry} />
  const empty = !d.hero.length && !Object.values(d.shelves).some((l) => l.length)
  if (empty && d.error) return <ErrorBox error={d.error} onRetry={res.retry} />
  return (
    <div className="sto-page sto-home" data-testid="store-home">
      {d.error && <StaleNote onRetry={res.retry} />}
      <Hero items={d.hero} active={active} owned={owned} onOpen={onOpen} />
      {(['specials', 'topsellers', 'newreleases', 'comingsoon'] as const).map((k) => (
        <Shelf key={k} kind={k} items={d.shelves[k]} owned={owned} onOpen={onOpen} onMore={onMore} />
      ))}
    </div>
  )
}

// ---------- Listes et recherche ----------

function ListBody({ items, owned, onOpen }: { items: StoreItem[]; owned: (appid: number) => boolean; onOpen: (it: StoreItem) => void }): React.JSX.Element {
  const release = useRelease()
  return (
    <div className="sto-rows">
      {items.map((it) => (
        <Row key={it.appid} it={it} owned={owned(it.appid)} release={release(it)} onOpen={onOpen} />
      ))}
    </div>
  )
}

function ListPage({ kind, owned, onOpen }: { kind: StoreListKind; owned: (appid: number) => boolean; onOpen: (it: StoreItem) => void }): React.JSX.Element {
  const { t, lang } = useT()
  const res = useStoreData<StoreList>(`list:${kind}:${lang}`, (refresh) => window.essaim.getStoreList(kind, refresh))
  const d = res.data
  return (
    <div className="sto-page sto-list" data-testid="store-list" data-list={kind}>
      <header className="sto-ph">
        <span className="cap">{t('store.cap')}</span>
        <h2>{t(`store.nav.${kind}`)}</h2>
        <p>{t(`store.list.sub.${kind}`)}</p>
      </header>
      {!d ? (
        res.loading ? (
          <Skeleton kind="list" />
        ) : (
          <ErrorBox error={res.error ?? 'unavailable'} onRetry={res.retry} />
        )
      ) : !d.items.length && d.error ? (
        <ErrorBox error={d.error} onRetry={res.retry} />
      ) : (
        <>
          {d.error && <StaleNote onRetry={res.retry} />}
          {d.items.length ? <ListBody items={d.items} owned={owned} onOpen={onOpen} /> : <p className="stv-quiet">{t('store.empty')}</p>}
        </>
      )}
    </div>
  )
}

function SearchPage({ term, owned, onOpen }: { term: string; owned: (appid: number) => boolean; onOpen: (it: StoreItem) => void }): React.JSX.Element {
  const { t, lang } = useT()
  const res = useStoreData<StoreSearch>(`search:${lang}:${term}`, () => window.essaim.searchStore(term))
  const d = res.data
  return (
    <div className="sto-page sto-results" data-testid="store-results">
      <header className="sto-ph">
        <span className="cap">{t('store.search.cap')}</span>
        <h2>{t('store.search.title', { term })}</h2>
      </header>
      {!d ? (
        res.loading ? (
          <Skeleton kind="list" />
        ) : (
          <ErrorBox error={res.error ?? 'unavailable'} onRetry={res.retry} />
        )
      ) : d.error && !d.items.length ? (
        <ErrorBox error={d.error} onRetry={res.retry} />
      ) : d.items.length ? (
        <ListBody items={d.items} owned={owned} onOpen={onOpen} />
      ) : (
        <p className="stv-quiet">{t('store.search.none', { term })}</p>
      )}
    </div>
  )
}

// ---------- Page d'un jeu ----------

interface Media {
  key: string
  thumb: string
  full: string
  movie: string | null
}

function Gallery({ media, appid, name }: { media: Media[]; appid: number; name: string }): React.JSX.Element {
  const { t } = useT()
  const [i, setI] = useState(0)
  const strip = useRef<HTMLDivElement>(null)
  const n = media.length
  const cur = media[Math.min(i, n - 1)]
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [i])
  if (!cur)
    return (
      <div className="sto-gal empty">
        <span className="sto-viewer">
          <Img src={null} />
        </span>
      </div>
    )
  return (
    <div className="sto-gal" aria-label={t('store.app.media')}>
      <div className="sto-viewer">
        <Img key={cur.full} src={cur.full} alt={cur.movie ? t('store.app.movie', { name: cur.movie }) : t('store.app.shot', { name })} />
        {cur.movie !== null && (
          <button type="button" className="sto-watch" onClick={() => openLink(appUrl(appid))} title={t('store.app.watchTitle')}>
            <Play className="fill" />
            {t('store.app.watch')}
          </button>
        )}
        {n > 1 && (
          <>
            <button type="button" className="sto-gal-arrow l" aria-label={t('store.hero.prev')} title={t('store.hero.prev')} onClick={() => setI((x) => (x - 1 + n) % n)}>
              <ChevronLeft />
            </button>
            <button type="button" className="sto-gal-arrow r" aria-label={t('store.hero.next')} title={t('store.hero.next')} onClick={() => setI((x) => (x + 1) % n)}>
              <ChevronRight />
            </button>
          </>
        )}
      </div>
      {n > 1 && (
        <div className="sto-thumbs" ref={strip}>
          {media.map((m, k) => (
            <button key={m.key} type="button" className={`${k === i ? 'on' : ''}${m.movie !== null ? ' mv' : ''}`} aria-label={m.movie ? t('store.app.movie', { name: m.movie }) : t('store.app.shot', { name })} onClick={() => setI(k)}>
              <Img src={m.thumb} />
              {m.movie !== null && <Play className="fill" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AppPage({
  appid,
  seed,
  ownedGame,
  library,
  onOpen,
  onPlay,
  onInstall,
  onOpenGame
}: {
  appid: number
  seed: StoreItem | null
  ownedGame: Game | null
  library: LibraryState
  onOpen: (it: StoreItem) => void
  onPlay: (g: Game) => void
  onInstall: (g: Game) => void
  onOpenGame: (g: Game) => void
}): React.JSX.Element {
  const { t, lang } = useT()
  const release = useRelease()
  const res = useStoreData<StoreApp>(`app:${appid}:${lang}`, (refresh) => window.essaim.getStoreApp(appid, refresh))
  const d = res.data && res.data.name ? res.data : null
  const item = d?.item ?? seed
  const name = d?.name || seed?.name || ''
  const media = useMemo<Media[]>(() => {
    if (!d) return []
    const shots = d.screenshots.map((s) => ({ key: s.full, thumb: s.thumb, full: s.full, movie: null }))
    const movies = d.movies.map((m) => ({ key: m.thumb, thumb: m.thumb, full: m.thumb, movie: m.name }))
    // comme sur Steam : la première bande-annonce, les captures, puis les autres vidéos
    return [...movies.slice(0, 1), ...shots, ...movies.slice(1)]
  }, [d])

  if (!d) {
    if (res.loading)
      return (
        <div className="sto-page sto-app" data-testid="store-app" data-appid={appid} aria-busy="true">
          <header className="sto-app-h">
            <span className="cap">{t('store.cap')}</span>
            <h1>{name || ' '}</h1>
          </header>
          <Skeleton kind="app" />
        </div>
      )
    return (
      <div className="sto-page sto-app" data-testid="store-app" data-appid={appid}>
        <ErrorBox error={res.data?.error ?? res.error ?? 'unavailable'} onRetry={res.retry} />
      </div>
    )
  }

  const state = ownedGame ? gameState(ownedGame, library) : null
  const price = d.price ?? item?.price ?? null
  const review = item?.review ?? null
  const facts: [string, string][] = []
  const rel = d.releaseDate ?? (item ? release(item) : '')
  if (rel) facts.push([t('store.app.release'), rel])
  if (d.developers.length) facts.push([t('store.app.developer'), d.developers.join(', ')])
  if (d.publishers.length) facts.push([t('store.app.publisher'), d.publishers.join(', ')])

  return (
    <article className="sto-page sto-app" data-testid="store-app" data-appid={appid} aria-label={t('store.app.aria', { name })}>
      {d.background && <div className="sto-app-bg" style={{ backgroundImage: `url("${d.background}")` }} aria-hidden="true" />}
      {d.error && <StaleNote onRetry={res.retry} />}
      <header className="sto-app-h">
        <span className="cap">
          {[t('store.cap'), ...d.genres.slice(0, 2)].join(' · ')}
        </span>
        <h1>{name}</h1>
      </header>

      <div className="sto-app-top">
        <Gallery media={media} appid={appid} name={name} />
        <aside className="sto-app-info">
          <Img src={item?.header ?? null} className="hd" />
          {d.description && <p className="desc">{d.description}</p>}
          <dl className="sto-facts">
            <div>
              <dt className="cap">{t('store.app.reviews')}</dt>
              <dd>
                {review ? (
                  <>
                    <span className={`rv ${reviewTone(review.score)}`}>{capFirst(review.label)}</span>
                    {review.percent > 0 && <span className="pct">{t('store.app.reviewPct', { pct: review.percent })}</span>}
                  </>
                ) : (
                  <span className="muted">{t('store.app.noReviews')}</span>
                )}
              </dd>
            </div>
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt className="cap">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {item && item.tags.length > 0 && (
            <div className="sto-tags" aria-label={t('store.app.tags')}>
              {item.tags.map((g) => (
                <span key={g} className="sto-tag">
                  {g}
                </span>
              ))}
            </div>
          )}
        </aside>
      </div>

      {ownedGame && state && (
        <section className="sto-ownedbar" data-testid="store-owned">
          <LibraryBig className="lead" />
          <div className="txt">
            <span className="cap">{t('store.app.owned')}</span>
            <span>{t('store.app.ownedText', { name })}</span>
          </div>
          {canPlayState(state) && state !== 'running' && state !== 'launching' ? (
            <button type="button" className="btn btn-primary" data-testid="store-play" onClick={() => onPlay(ownedGame)}>
              <Play className="fill" />
              {t('store.app.play')}
            </button>
          ) : state === 'installable' ? (
            <button type="button" className="btn btn-primary" data-testid="store-install" onClick={() => onInstall(ownedGame)}>
              <ArrowDownToLine />
              {t('store.app.install')}
            </button>
          ) : null}
          <button type="button" className="btn btn-line" data-testid="store-open-library" onClick={() => onOpenGame(ownedGame)}>
            <LibraryBig />
            {t('store.app.seeLibrary')}
          </button>
        </section>
      )}

      <div className="sto-app-main">
        <div className="col">
          <section className="sto-buy">
            <div className="txt">
              <h3>{t(price?.free ? 'store.app.playTitle' : 'store.app.buyTitle', { name })}</h3>
              <Platforms p={d.platforms} />
              <span className="note">{t('store.app.buyNote')}</span>
            </div>
            <div className="acts">
              <Price price={price} comingSoon={d.comingSoon} big />
              <button type="button" className="btn btn-primary" data-testid="store-buy" onClick={() => openLink(appUrl(appid))}>
                <ShoppingCart />
                {t(price?.free ? 'store.app.getFree' : d.comingSoon && !price ? 'store.app.seeSteam' : 'store.app.buy')}
              </button>
              <button type="button" className="btn btn-line" data-testid="store-wishlist" onClick={() => openLink(appUrl(appid))}>
                <Heart />
                {t('store.app.wishlist')}
              </button>
            </div>
          </section>

          {d.dlc.length > 0 && (
            <section className="sto-dlc">
              <header className="stv-sh">
                <h3 className="cap">{t('store.app.dlc')}</h3>
                <span className="rule" />
              </header>
              <div className="sto-dlc-list">
                {d.dlc.map((x) => (
                  <button key={x.appid} type="button" className="sto-dlc-row" data-testid="store-tile" data-appid={x.appid} title={t('store.openTitle', { name: x.name })} onClick={() => onOpen(x)}>
                    <Img src={x.small ?? x.header} />
                    <span className="nm">{x.name}</span>
                    <Price price={x.price} comingSoon={x.comingSoon} />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="side">
          {d.metacritic && (
            <div className="sto-meta">
              <span className={`score${d.metacritic.score >= 75 ? ' hi' : d.metacritic.score >= 50 ? '' : ' lo'}`}>{d.metacritic.score}</span>
              <span className="cap">{t('store.app.metacritic')}</span>
              {d.metacritic.url && (
                <button type="button" className="lnk" onClick={() => openLink(d.metacritic!.url!)} title={d.metacritic.url}>
                  <ExternalLink />
                </button>
              )}
            </div>
          )}
          {d.genres.length > 0 && (
            <div className="sto-side-b">
              <span className="cap">{t('store.app.genres')}</span>
              <span className="v">{d.genres.join(', ')}</span>
            </div>
          )}
          {d.categories.length > 0 && (
            <div className="sto-side-b">
              <span className="cap">{t('store.app.features')}</span>
              <ul className="feats">
                {d.categories.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="sto-side-b">
            <span className="cap">{t('store.app.platforms')}</span>
            <span className="v">
              {(['windows', 'mac', 'linux'] as const)
                .filter((k) => d.platforms[k])
                .map((k) => t(`store.pf.${k}`))
                .join(', ') || '—'}
            </span>
          </div>
          <button type="button" className="btn btn-line sto-open" onClick={() => openLink(appUrl(appid))}>
            <ExternalLink />
            {t('store.app.openSteam')}
          </button>
        </aside>
      </div>
    </article>
  )
}

// ---------- Vue ----------

interface Props {
  /** onglet MAGASIN visible (carrousel et Échap seulement quand il l'est) */
  active: boolean
  /** jeux Steam de la bibliothèque par appid (possédés ou installés) */
  owned: Map<number, Game>
  library: LibraryState
  onPlay: (g: Game) => void
  onInstall: (g: Game) => void
  /** page du jeu dans l'onglet Bibliothèque */
  onOpenGame: (g: Game) => void
}

export function StoreView({ active, owned, library, onPlay, onInstall, onOpenGame }: Props): React.JSX.Element {
  const { t } = useT()
  const [stack, setStack] = useState<Route[]>([{ kind: 'home' }])
  const [query, setQuery] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const restore = useRef<number | null>(null)
  /** recherche différée en attente (annulée par Entrée ou par l'ouverture d'une autre page) */
  const searchTimer = useRef<number | null>(null)
  const cancelSearch = (): void => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    searchTimer.current = null
  }
  const route = stack[stack.length - 1]
  const root = stack[0]
  // rubrique allumée : celle d'où l'on vient (pas pendant une recherche)
  const navOn = route.kind === 'search' ? null : root.kind === 'list' ? root.list : root.kind === 'home' ? 'featured' : null

  const isOwned = useCallback((appid: number) => owned.has(appid), [owned])

  /** Nouvelle page : la position de défilement de la page quittée est gardée pour Retour. */
  const push = useCallback((r: Route, replaceSearch = false) => {
    cancelSearch()
    const y = body.current?.scrollTop ?? 0
    restore.current = 0
    setStack((s) => {
      const top = s[s.length - 1]
      if (routeKey(top) === routeKey(r)) return s
      if (replaceSearch && top.kind === 'search') return [...s.slice(0, -1), r]
      return [...s.slice(0, -1), { ...top, scroll: y }, r]
    })
  }, [])
  const back = useCallback(() => {
    setStack((s) => {
      if (s.length < 2) return s
      const prev = s[s.length - 2]
      restore.current = prev.scroll ?? 0
      if (s[s.length - 1].kind === 'search') setQuery('')
      return s.slice(0, -1)
    })
  }, [])
  const goRoot = useCallback((id: 'featured' | StoreListKind) => {
    cancelSearch()
    restore.current = 0
    setQuery('')
    setStack([id === 'featured' ? { kind: 'home' } : { kind: 'list', list: id }])
  }, [])

  // défilement : en haut sur une nouvelle page, là où on était au retour
  useLayoutEffect(() => {
    if (restore.current === null || !body.current) return
    body.current.scrollTop = restore.current
    restore.current = null
  }, [stack])

  const openItem = useCallback((it: StoreItem) => push({ kind: 'app', appid: it.appid, seed: it }), [push])
  const openList = useCallback((k: StoreListKind) => push({ kind: 'list', list: k }), [push])

  // recherche : après une courte pause dans la frappe, ou tout de suite avec Entrée
  const runSearch = useCallback(
    (raw: string) => {
      const term = raw.replace(/\s+/g, ' ').trim()
      if (term.length < 2) return
      push({ kind: 'search', term }, true)
    },
    [push]
  )
  useEffect(() => {
    const term = query.replace(/\s+/g, ' ').trim()
    if (!term) {
      // champ vidé : on quitte les résultats
      setStack((s) => {
        if (s.length < 2 || s[s.length - 1].kind !== 'search') return s
        restore.current = s[s.length - 2].scroll ?? 0
        return s.slice(0, -1)
      })
      return
    }
    if (route.kind === 'search' && route.term.toLowerCase() === term.toLowerCase()) return
    cancelSearch()
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null
      runSearch(term)
    }, SEARCH_DELAY)
    return cancelSearch
  }, [query])

  // Échap : retour (avant la vue Steam, qui ramène à la bibliothèque depuis l'accueil du magasin)
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"], .ctxmenu')) return
      if (stack.length < 2) return
      // Échap dans la recherche remplie : le champ se vide d'abord
      const el = e.target as HTMLInputElement | null
      if (el?.tagName === 'INPUT' && el.value) return
      e.preventDefault()
      back()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, stack.length, back])

  const ownedGame = route.kind === 'app' ? owned.get(route.appid) ?? null : null

  return (
    <div className="sto" data-testid="steam-store" data-route={route.kind}>
      <nav className="sto-bar" aria-label={t('store.nav.aria')}>
        {stack.length > 1 && (
          <button type="button" className="sto-back" data-testid="store-back" title={t('store.backTitle')} onClick={back}>
            <ArrowLeft />
            <span>{t('store.back')}</span>
          </button>
        )}
        <div className="sto-tabs">
          {NAV.map((id) => (
            <button
              key={id}
              type="button"
              className={`sto-tab${navOn === id ? ' on' : ''}`}
              aria-current={navOn === id && stack.length === 1 ? 'page' : undefined}
              data-testid={`store-nav-${id}`}
              onClick={() => goRoot(id)}
            >
              {t(`store.nav.${id}`)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div
          className="sto-search"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              runSearch(query)
            }
          }}
        >
          <SearchBox value={query} onChange={setQuery} placeholder={t('store.search')} testId="store-search" />
        </div>
      </nav>
      <div className="sto-body" ref={body}>
        {route.kind === 'home' ? (
          <HomePage active={active} owned={isOwned} onOpen={openItem} onMore={openList} />
        ) : route.kind === 'list' ? (
          <ListPage key={route.list} kind={route.list} owned={isOwned} onOpen={openItem} />
        ) : route.kind === 'search' ? (
          <SearchPage key={route.term} term={route.term} owned={isOwned} onOpen={openItem} />
        ) : (
          <AppPage
            key={route.appid}
            appid={route.appid}
            seed={route.seed}
            ownedGame={ownedGame}
            library={library}
            onOpen={openItem}
            onPlay={onPlay}
            onInstall={onInstall}
            onOpenGame={onOpenGame}
          />
        )}
      </div>
    </div>
  )
}
