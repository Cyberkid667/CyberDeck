import { ArrowLeft, BookOpen, ExternalLink, Gamepad2, KeyRound, LoaderCircle, MessagesSquare, Newspaper, PlayCircle, RefreshCw, UsersRound, WifiOff, Wrench, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { gameLastPlayedAt, gamePlayTimeSeconds } from '../../../shared/platforms'
import type {
  CommunityArticle,
  CommunityError,
  CommunityGame,
  CommunityNews,
  CommunityNewsItem,
  Game,
  RichBlock,
  RichSpan,
  WorkshopDetail,
  WorkshopGames,
  WorkshopItem,
  WorkshopPage,
  WorkshopSort
} from '../../../shared/types'
import { formatBytes, formatDay } from '../format'
import { useT } from '../i18n'
import { coverSrc } from './Cover'
import { SearchBox } from './Toolbar'

// Onglet COMMUNAUTÉ de la vue Steam (passe 4 de la refonte « Steam dans CyberDeck ») : la structure
// du hub Communauté du client Steam, aux couleurs de l'app.
//   - barre : Accueil · Actualités · Workshop · Guides & discussions (retour quand un article est ouvert) ;
//   - Accueil : dernières actualités des jeux de l'utilisateur (une grande carte, puis une grille)
//     et, à droite, ses hubs de communauté (guides et discussions dans Steam) ;
//   - Actualités : tout le fil, filtré par jeu (puces, sans compteur) ; clic : l'article dans l'app
//     (texte nettoyé par le processus principal), bouton « Ouvrir sur Steam » ;
//   - Workshop : jeux installés qui en ont un, objets en tendance / populaires / récents, fiche d'un
//     objet à droite ; s'abonner se fait dans Steam. Sans clé : panneau « Ajouter une clé Steam » ;
//   - Guides & discussions : les vraies pages, ouvertes dans Steam.
// Toutes les données viennent du processus principal (steamCommunity.ts).

export type CommunitySection = 'home' | 'news' | 'workshop' | 'guides'
const SECTIONS: CommunitySection[] = ['home', 'news', 'workshop', 'guides']
const SORTS: WorkshopSort[] = ['trend', 'popular', 'recent']

const ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps'
const COMMUNITY = 'https://steamcommunity.com'
/** Cartes de l'accueil (après la grande). */
const HOME_CARDS = 8
/** Hubs montrés sur l'accueil. */
const HOME_HUBS = 8
/** Jeux de « Guides & discussions » sans recherche. */
const GUIDES_MAX = 60
const WS_GAME_KEY = 'cyberdeck.workshopGame'

function openLink(url: string): void {
  try {
    window.essaim.openExternalLink(url)
  } catch {
    /* pont pas encore prêt */
  }
}

const headerArt = (appid: number): string => `${ASSETS}/${appid}/header.jpg`
const fold = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('fr')
const appidOf = (g: Game): number => {
  const n = Number(g.platformId)
  return Number.isInteger(n) && n > 0 ? n : 0
}

function readWsGame(): number | null {
  try {
    const n = Number(localStorage.getItem(WS_GAME_KEY))
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}
function storeWsGame(appid: number): void {
  try {
    localStorage.setItem(WS_GAME_KEY, String(appid))
  } catch {
    // simple confort
  }
}

// ---------- Petits morceaux ----------

/** Image qui passe à la suivante (puis à une manette) si elle ne charge pas. */
function Art({ srcs, className, alt = '', hideOnFail = false }: { srcs: (string | null | undefined)[]; className?: string; alt?: string; hideOnFail?: boolean }): React.JSX.Element | null {
  const list = srcs.filter((s): s is string => !!s)
  const key = list.join('|')
  const [state, setState] = useState({ key, i: 0 })
  const i = state.key === key ? state.i : 0
  const src = list[i]
  if (!src && hideOnFail) return null
  if (!src)
    return (
      <span className={`cmn-art none${className ? ' ' + className : ''}`} aria-hidden="true">
        <Gamepad2 />
      </span>
    )
  return (
    <img
      className={`cmn-art${className ? ' ' + className : ''}`}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setState({ key, i: i + 1 })}
    />
  )
}

function Head({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <header className="stv-sh">
      <h3 className="cap">{title}</h3>
      <span className="rule" />
      {children}
    </header>
  )
}

/** Panneau calme centré (pas de clé, erreur, rien à montrer). */
function Calm({ testId, icon, cap, title, text, children }: { testId?: string; icon: React.ReactNode; cap?: string; title: string; text: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="cmn-calm" data-testid={testId}>
      <div className="box brackets">
        {icon}
        {cap && <span className="cap">{cap}</span>}
        <h2>{title}</h2>
        <p>{text}</p>
        {children}
      </div>
    </div>
  )
}

function Loading(): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="cmn-loading" aria-busy="true">
      <span className="scanbar">
        <i />
      </span>
      <span className="cap">{t('community.loading')}</span>
    </div>
  )
}

function ErrorPanel({ error, busy, onRetry }: { error: CommunityError; busy: boolean; onRetry: () => void }): React.JSX.Element {
  const { t } = useT()
  const kind = error === 'offline' ? 'offline' : error === 'invalid-key' ? 'invalidKey' : 'unavailable'
  return (
    <Calm icon={kind === 'offline' ? <WifiOff className="big" /> : <UsersRound className="big" />} title={t(`community.error.${kind}.title`)} text={t(`community.error.${kind}.text`)}>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onRetry}>
        <RefreshCw className={busy ? 'spin' : undefined} />
        {t('community.retry')}
      </button>
    </Calm>
  )
}

// ---------- Texte riche ----------

function Spans({ spans }: { spans: RichSpan[] }): React.JSX.Element {
  return (
    <>
      {spans.map((s, i) => {
        const cls = [s.b && 'b', s.i && 'i', s.u && 'u', s.s && 's'].filter(Boolean).join(' ') || undefined
        if (s.href) {
          const href = s.href
          return (
            <a
              key={i}
              className={cls}
              href={href}
              title={href}
              onClick={(e) => {
                e.preventDefault()
                openLink(href)
              }}
            >
              {s.text}
            </a>
          )
        }
        return cls ? (
          <span key={i} className={cls}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      })}
    </>
  )
}

function RichImage({ src, href }: { src: string; href?: string }): React.JSX.Element | null {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  const img = <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
  return href ? (
    <a className="rt-img" href={href} title={href} onClick={(e) => (e.preventDefault(), openLink(href))}>
      {img}
    </a>
  ) : (
    <figure className="rt-img">{img}</figure>
  )
}

export function RichText({ blocks }: { blocks: RichBlock[] }): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="rt">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'p':
            return (
              <p key={i}>
                <Spans spans={b.spans} />
              </p>
            )
          case 'quote':
            return (
              <blockquote key={i}>
                <Spans spans={b.spans} />
              </blockquote>
            )
          case 'h':
            return b.level === 1 ? <h2 key={i}>{b.text}</h2> : b.level === 2 ? <h3 key={i}>{b.text}</h3> : <h4 key={i}>{b.text}</h4>
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={j}>
                <Spans spans={it} />
              </li>
            ))
            return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>
          }
          case 'img':
            return <RichImage key={i} src={b.src} href={b.href} />
          case 'video':
            return (
              <p key={i} className="rt-video">
                <button type="button" className="btn btn-line btn-sm" title={b.href} onClick={() => openLink(b.href)}>
                  <PlayCircle />
                  {t('community.article.video')}
                </button>
              </p>
            )
          case 'hr':
            return <hr key={i} />
          default:
            return null
        }
      })}
    </div>
  )
}

// ---------- Actualités ----------

/** En-tête du magasin de chaque jeu du fil. */
function useArt(news: CommunityNews | null): Map<number, string | null> {
  return useMemo(() => new Map((news?.games ?? []).map((g) => [g.appid, g.header])), [news])
}

function kindLabel(it: CommunityNewsItem, t: (k: string) => string): string {
  if (it.kind === 'press') return it.feed || t('community.kind.press')
  return t(`community.kind.${it.kind}`)
}

const NewsCard = memo(function NewsCard({ it, header, big = false, onOpen }: { it: CommunityNewsItem; header: string | null | undefined; big?: boolean; onOpen: (it: CommunityNewsItem) => void }): React.JSX.Element {
  const { t } = useT()
  return (
    <button
      type="button"
      className={`cmn-card${big ? ' big' : ''} k-${it.kind}`}
      data-testid="news-card"
      data-appid={it.appid}
      title={t('community.news.openTitle', { title: it.title })}
      onClick={() => onOpen(it)}
    >
      <span className="pic">
        <Art srcs={[it.image, header, headerArt(it.appid)]} />
      </span>
      <span className="txt">
        <span className="meta">
          <span className={`cap kind k-${it.kind}`}>{kindLabel(it, t)}</span>
          <span className="cap deco">·</span>
          <span className="cap game">{it.game}</span>
        </span>
        <span className="ttl">{it.title}</span>
        {it.excerpt && <span className="ex">{it.excerpt}</span>}
        <span className="date">{formatDay(it.date)}</span>
      </span>
    </button>
  )
})

function ArticleView({ appid, id, seed, header }: { appid: number; id: string; seed: CommunityNewsItem | null; header: string | null | undefined }): React.JSX.Element {
  const { t } = useT()
  const [state, setState] = useState<{ article: CommunityArticle | null; done: boolean }>({ article: null, done: false })
  useEffect(() => {
    let alive = true
    setState({ article: null, done: false })
    try {
      window.essaim.getCommunityArticle(appid, id).then(
        (a) => alive && setState({ article: a, done: true }),
        () => alive && setState({ article: null, done: true })
      )
    } catch {
      setState({ article: null, done: true })
    }
    return () => {
      alive = false
    }
  }, [appid, id])
  const item = state.article?.item ?? seed
  return (
    <article className="cmn-article" data-testid="news-article" data-appid={appid}>
      {item && (
        <header className="cmn-art-head">
          <Art srcs={[header, headerArt(item.appid)]} className="band" hideOnFail />
          <span className="meta">
            <span className={`cap kind k-${item.kind}`}>{kindLabel(item, t)}</span>
            <span className="cap deco">·</span>
            <span className="cap game">{item.game}</span>
          </span>
          <h1>{item.title}</h1>
          <p className="sub">
            {formatDay(item.date)}
            {item.author ? <> · {t('community.article.by', { name: item.author })}</> : null}
          </p>
          <div className="acts">
            <button type="button" className="btn btn-line" data-testid="news-open-steam" title={item.url} onClick={() => openLink(item.url)}>
              <ExternalLink />
              {t('community.article.openSteam')}
            </button>
          </div>
        </header>
      )}
      {!state.done ? (
        <Loading />
      ) : state.article ? (
        state.article.body.length ? (
          <RichText blocks={state.article.body} />
        ) : (
          <p className="cmn-quiet">{item?.excerpt || t('community.article.empty')}</p>
        )
      ) : (
        <p className="cmn-quiet">{t('community.article.notFound')}</p>
      )}
      {item && state.done && (
        <footer className="cmn-art-foot">
          <button type="button" className="btn btn-line" onClick={() => openLink(item.url)}>
            <ExternalLink />
            {t('community.article.openSteam')}
          </button>
        </footer>
      )}
    </article>
  )
}

function useNews(active: boolean): { news: CommunityNews | null; busy: boolean; reload: (refresh: boolean) => void } {
  const [news, setNews] = useState<CommunityNews | null>(null)
  const [busy, setBusy] = useState(false)
  const started = useRef(false)
  const reload = useCallback((refresh: boolean) => {
    setBusy(true)
    try {
      window.essaim.getCommunityNews(refresh).then(
        (n) => {
          setNews(n)
          setBusy(false)
        },
        () => setBusy(false)
      )
    } catch {
      setBusy(false)
    }
  }, [])
  useEffect(() => {
    if (!active || started.current) return
    started.current = true
    reload(false)
  }, [active, reload])
  return { news, busy, reload }
}

function NewsBody({ news, busy, onRetry, children }: { news: CommunityNews | null; busy: boolean; onRetry: () => void; children: React.ReactNode }): React.JSX.Element {
  const { t } = useT()
  if (!news) return <Loading />
  if (!news.items.length) {
    if (news.error) return <ErrorPanel error={news.error} busy={busy} onRetry={onRetry} />
    return (
      <Calm icon={<Newspaper className="big" />} title={t('community.news.none')} text={t('community.news.noGames')}>
        <button type="button" className="btn btn-line" onClick={() => openLink(`${COMMUNITY}/`)}>
          <ExternalLink />
          {t('community.openCommunity')}
        </button>
      </Calm>
    )
  }
  return (
    <>
      {news.error && <p className="cmn-stale cap">{t('community.stale')}</p>}
      {children}
    </>
  )
}

function HubRow({ g }: { g: CommunityGame }): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="cmn-hub" data-appid={g.appid}>
      <button type="button" className="hub-main" title={t('community.hub.openTitle', { name: g.name })} onClick={() => openLink(`${COMMUNITY}/app/${g.appid}`)}>
        <Art srcs={[g.header, `${ASSETS}/${g.appid}/capsule_231x87.jpg`]} className="cap-img" />
        <span className="nm">{g.name}</span>
      </button>
      <span className="hub-links">
        <button type="button" title={t('community.guides.guidesTitle', { name: g.name })} onClick={() => openLink(`${COMMUNITY}/app/${g.appid}/guides/`)}>
          {t('community.hub.guides')}
        </button>
        <button type="button" title={t('community.guides.discussionsTitle', { name: g.name })} onClick={() => openLink(`${COMMUNITY}/app/${g.appid}/discussions/`)}>
          {t('community.hub.discussions')}
        </button>
      </span>
    </div>
  )
}

function HomePage({ news, busy, reload, onOpen, onAllNews }: { news: CommunityNews | null; busy: boolean; reload: (r: boolean) => void; onOpen: (it: CommunityNewsItem) => void; onAllNews: () => void }): React.JSX.Element {
  const { t } = useT()
  const art = useArt(news)
  const items = news?.items ?? []
  const lead = items.find((x) => x.image) ?? items[0] ?? null
  const rest = items.filter((x) => x !== lead).slice(0, HOME_CARDS)
  return (
    <div className="sto-page cmn-page" data-testid="community-home">
      <div className="sto-ph">
        <span className="cap">{t('community.cap')}</span>
        <h2>{t('community.home.title')}</h2>
        <p>{t('community.home.sub')}</p>
      </div>
      <NewsBody news={news} busy={busy} onRetry={() => reload(true)}>
        <div className="cmn-home">
          <div className="cmn-home-main">
            <section>
              <Head title={t('community.home.latest')}>
                <button type="button" className="btn btn-line btn-sm" onClick={onAllNews}>
                  {t('community.home.allNews')}
                </button>
              </Head>
              {lead && <NewsCard it={lead} header={art.get(lead.appid)} big onOpen={onOpen} />}
              {rest.length > 0 && (
                <div className="cmn-grid">
                  {rest.map((it) => (
                    <NewsCard key={`${it.appid}:${it.id}`} it={it} header={art.get(it.appid)} onOpen={onOpen} />
                  ))}
                </div>
              )}
            </section>
          </div>
          <aside className="cmn-home-side" aria-label={t('community.home.hubs')}>
            <Head title={t('community.home.hubs')} />
            <div className="cmn-hubs">
              {(news?.games ?? []).slice(0, HOME_HUBS).map((g) => (
                <HubRow key={g.appid} g={g} />
              ))}
            </div>
            <button type="button" className="btn btn-line btn-sm cmn-side-btn" onClick={() => openLink(`${COMMUNITY}/`)}>
              <ExternalLink />
              {t('community.openCommunity')}
            </button>
          </aside>
        </div>
      </NewsBody>
    </div>
  )
}

function NewsPage({ news, busy, reload, onOpen }: { news: CommunityNews | null; busy: boolean; reload: (r: boolean) => void; onOpen: (it: CommunityNewsItem) => void }): React.JSX.Element {
  const { t } = useT()
  const [game, setGame] = useState<number | null>(null)
  const art = useArt(news)
  const items = useMemo(() => (news?.items ?? []).filter((x) => game === null || x.appid === game), [news, game])
  return (
    <div className="sto-page cmn-page" data-testid="community-news">
      <div className="sto-ph">
        <span className="cap">{t('community.cap')}</span>
        <h2>{t('community.news.title')}</h2>
        <p>{t('community.news.sub')}</p>
      </div>
      <NewsBody news={news} busy={busy} onRetry={() => reload(true)}>
        <div className="cmn-chips" role="radiogroup" aria-label={t('community.news.filterAria')}>
          <button type="button" role="radio" aria-checked={game === null} className={`cmn-chip${game === null ? ' on' : ''}`} data-testid="news-chip" onClick={() => setGame(null)}>
            {t('community.news.all')}
          </button>
          {(news?.games ?? []).map((g) => (
            <button
              key={g.appid}
              type="button"
              role="radio"
              aria-checked={game === g.appid}
              className={`cmn-chip${game === g.appid ? ' on' : ''}`}
              data-testid="news-chip"
              data-appid={g.appid}
              onClick={() => setGame(g.appid)}
            >
              {g.name}
            </button>
          ))}
        </div>
        <div className="cmn-grid">
          {items.map((it) => (
            <NewsCard key={`${it.appid}:${it.id}`} it={it} header={art.get(it.appid)} onOpen={onOpen} />
          ))}
        </div>
      </NewsBody>
    </div>
  )
}

// ---------- Workshop ----------

function useCompact(): (n: number) => string {
  const { locale } = useT()
  return useMemo(() => {
    const f = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
    return (n: number) => f.format(n)
  }, [locale])
}

const WorkshopCard = memo(function WorkshopCard({ it, on, onOpen }: { it: WorkshopItem; on: boolean; onOpen: (it: WorkshopItem) => void }): React.JSX.Element {
  const { t } = useT()
  const compact = useCompact()
  return (
    <button type="button" className={`cmn-ws${on ? ' on' : ''}`} data-testid="workshop-item" data-id={it.id} title={t('community.workshop.openTitle', { name: it.title })} onClick={() => onOpen(it)}>
      <span className="pic">
        <Art srcs={[it.thumb, it.preview]} />
      </span>
      <span className="ttl">{it.title}</span>
      {it.author && <span className="by">{t('community.workshop.by', { name: it.author })}</span>}
      <span className="meta">
        {it.subscriptions !== null && <span>{t('community.workshop.subs', { n: compact(it.subscriptions) })}</span>}
        {it.score !== null && <span>{t('community.workshop.rating', { pct: Math.round(it.score * 100) })}</span>}
      </span>
    </button>
  )
})

function WorkshopPanel({ item, onClose }: { item: WorkshopItem; onClose: () => void }): React.JSX.Element {
  const { t } = useT()
  const compact = useCompact()
  const [detail, setDetail] = useState<WorkshopDetail | null>(null)
  const [shot, setShot] = useState<string | null>(null)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    let alive = true
    setDetail(null)
    setShot(null)
    panel.current?.scrollTo({ top: 0 })
    try {
      window.essaim.getWorkshopItem(item.id).then(
        (d) => alive && setDetail(d),
        () => alive && setDetail({ item: null, previews: [], body: [], error: 'unavailable' })
      )
    } catch {
      /* pont pas encore prêt */
    }
    return () => {
      alive = false
    }
  }, [item.id])
  const it = detail?.item ?? item
  const images = [it.preview, ...(detail?.previews ?? [])].filter((x): x is string => !!x)
  const main = shot && images.includes(shot) ? shot : images[0] ?? null
  const url = `${COMMUNITY}/sharedfiles/filedetails/?id=${it.id}`
  return (
    <aside className="cmn-wsd" data-testid="workshop-detail" data-id={it.id} role="dialog" aria-label={it.title} ref={panel}>
      <header className="cmn-wsd-top">
        <span className="cap">{t('community.workshop.cap')}</span>
        <button type="button" className="stv-arrow" title={t('community.workshop.close')} aria-label={t('community.workshop.close')} onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="cmn-wsd-pic">
        <Art key={main ?? ''} srcs={[main]} />
      </div>
      {images.length > 1 && (
        <div className="cmn-wsd-shots">
          {images.slice(0, 8).map((src) => (
            <button key={src} type="button" className={src === main ? 'on' : undefined} onClick={() => setShot(src)} aria-label={t('community.workshop.shot')}>
              <Art srcs={[src]} />
            </button>
          ))}
        </div>
      )}
      <h2>{it.title}</h2>
      {it.author && <p className="by">{t('community.workshop.by', { name: it.author })}</p>}
      <dl className="cmn-wsd-facts">
        {it.subscriptions !== null && (
          <>
            <dt className="cap">{t('community.workshop.subsK')}</dt>
            <dd>{compact(it.subscriptions)}</dd>
          </>
        )}
        <dt className="cap">{t('community.workshop.ratingK')}</dt>
        <dd>{it.score !== null ? t('community.workshop.rating', { pct: Math.round(it.score * 100) }) : t('community.workshop.noRating')}</dd>
        {it.updatedAt && (
          <>
            <dt className="cap">{t('community.workshop.updated')}</dt>
            <dd>{formatDay(it.updatedAt)}</dd>
          </>
        )}
        {it.size ? (
          <>
            <dt className="cap">{t('community.workshop.size')}</dt>
            <dd>{formatBytes(it.size)}</dd>
          </>
        ) : null}
      </dl>
      <div className="cmn-wsd-acts">
        <button type="button" className="btn btn-primary" data-testid="workshop-open-steam" title={url} onClick={() => openLink(url)}>
          <ExternalLink />
          {t('community.workshop.open')}
        </button>
        <p className="note">{t('community.workshop.openNote')}</p>
      </div>
      {it.tags.length > 0 && (
        <section>
          <Head title={t('community.workshop.tags')} />
          <div className="cmn-tags">
            {it.tags.map((tag) => (
              <span key={tag} className="sto-tag">
                {tag}
              </span>
            ))}
          </div>
        </section>
      )}
      <section>
        <Head title={t('community.workshop.description')} />
        {!detail ? <Loading /> : detail.body.length ? <RichText blocks={detail.body} /> : <p className="cmn-quiet">{it.short || t('community.workshop.noDescription')}</p>}
      </section>
    </aside>
  )
}

function WorkshopView({ active, onOpenLaunchers }: { active: boolean; onOpenLaunchers: (focus?: 'steam-key') => void }): React.JSX.Element {
  const { t } = useT()
  const [games, setGames] = useState<WorkshopGames | null>(null)
  const [appid, setAppid] = useState<number | null>(readWsGame)
  const [sort, setSort] = useState<WorkshopSort>('trend')
  const [page, setPage] = useState<{ key: string; items: WorkshopItem[]; next: string | null; error: CommunityError | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<WorkshopItem | null>(null)
  const reqKey = useRef('')

  const loadGames = useCallback((refresh: boolean) => {
    try {
      window.essaim.getWorkshopGames(refresh).then(setGames, () => setGames({ games: [], error: 'unavailable' }))
    } catch {
      /* pont pas encore prêt */
    }
  }, [])
  useEffect(() => {
    if (active && !games) loadGames(false)
  }, [active, games, loadGames])

  const current = games?.games.find((g) => g.appid === appid) ?? games?.games[0] ?? null
  const currentId = current?.appid ?? 0
  const key = currentId ? `${currentId}:${sort}` : ''

  const load = useCallback(
    (cursor: string | null, refresh: boolean) => {
      if (!currentId) return
      const k = `${currentId}:${sort}`
      reqKey.current = k
      setBusy(true)
      try {
        window.essaim.getWorkshopPage(currentId, sort, cursor, refresh).then(
          (p: WorkshopPage) => {
            if (reqKey.current !== k) return
            setBusy(false)
            setPage((old) => {
              const prev = cursor && old?.key === k ? old.items : []
              const seen = new Set(prev.map((x) => x.id))
              return { key: k, items: [...prev, ...p.items.filter((x) => !seen.has(x.id))], next: p.next, error: p.error }
            })
          },
          () => reqKey.current === k && setBusy(false)
        )
      } catch {
        setBusy(false)
      }
    },
    [currentId, sort]
  )
  useEffect(() => {
    if (!active || !key || page?.key === key || reqKey.current === key || games?.error === 'no-key') return
    setOpen(null)
    load(null, false)
  }, [active, key, page?.key, load, games?.error])

  // Échap : ferme la fiche (avant la vue Steam)
  useEffect(() => {
    if (!active || !open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setOpen(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, open])

  const head = (
    <div className="sto-ph">
      <span className="cap">{t('community.cap')}</span>
      <h2>{t('community.workshop.title')}</h2>
      <p>{t('community.workshop.sub')}</p>
    </div>
  )

  let body: React.ReactNode
  if (!games) body = <Loading />
  else if (games.error === 'no-key')
    body = (
      <Calm testId="community-no-key" icon={<KeyRound className="big" />} cap={t('community.noKey.cap')} title={t('community.noKey.title')} text={t('community.noKey.text')}>
        <button type="button" className="btn btn-line" data-testid="community-add-key" onClick={() => onOpenLaunchers('steam-key')}>
          <KeyRound />
          {t('community.noKey.btn')}
        </button>
      </Calm>
    )
  else if (!games.games.length)
    body = games.error ? (
      <ErrorPanel error={games.error} busy={false} onRetry={() => loadGames(true)} />
    ) : (
      <Calm icon={<Wrench className="big" />} title={t('community.workshop.noGames.title')} text={t('community.workshop.noGames.text')}>
        <button type="button" className="btn btn-line" onClick={() => openLink(`${COMMUNITY}/workshop/`)}>
          <ExternalLink />
          {t('community.workshop.browse')}
        </button>
      </Calm>
    )
  else {
    const items = page?.key === key ? page.items : []
    const error = page?.key === key ? page.error : null
    body = (
      <>
        <div className="cmn-ws-bar">
          <div className="cmn-chips" role="radiogroup" aria-label={t('community.workshop.gamesAria')}>
            {games.games.map((g) => (
              <button
                key={g.appid}
                type="button"
                role="radio"
                aria-checked={current?.appid === g.appid}
                className={`cmn-chip${current?.appid === g.appid ? ' on' : ''}`}
                data-testid="workshop-game"
                data-appid={g.appid}
                onClick={() => {
                  setAppid(g.appid)
                  storeWsGame(g.appid)
                }}
              >
                {g.name}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <div className="seg sm" role="radiogroup" aria-label={t('community.workshop.sortAria')}>
            {SORTS.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={sort === s} className={sort === s ? 'on' : undefined} data-testid={`workshop-sort-${s}`} onClick={() => setSort(s)}>
                {t(`community.workshop.sort.${s}`)}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-line btn-sm" title={t('community.workshop.browseGame', { name: current?.name ?? '' })} onClick={() => current && openLink(`${COMMUNITY}/app/${current.appid}/workshop/`)}>
            <ExternalLink />
            {t('community.workshop.steamPage')}
          </button>
        </div>
        {error && items.length > 0 && <p className="cmn-stale cap">{t('community.stale')}</p>}
        {!items.length ? (
          busy || page?.key !== key ? (
            <Loading />
          ) : error ? (
            <ErrorPanel error={error} busy={busy} onRetry={() => load(null, true)} />
          ) : (
            <p className="cmn-quiet">{t('community.workshop.none')}</p>
          )
        ) : (
          <>
            <div className="cmn-ws-grid" data-testid="workshop-grid" data-appid={current?.appid}>
              {items.map((it) => (
                <WorkshopCard key={it.id} it={it} on={open?.id === it.id} onOpen={setOpen} />
              ))}
            </div>
            {page?.next && (
              <div className="cmn-more">
                <button type="button" className="btn btn-line" data-testid="workshop-more" disabled={busy} onClick={() => load(page.next, false)}>
                  {busy ? <LoaderCircle className="spin" /> : null}
                  {t('community.workshop.more')}
                </button>
              </div>
            )}
          </>
        )}
      </>
    )
  }

  return (
    <div className={`cmn-ws-wrap${open ? ' with-detail' : ''}`}>
      <div className="sto-page cmn-page" data-testid="community-workshop">
        {head}
        {body}
      </div>
      {open && <WorkshopPanel item={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

// ---------- Guides & discussions ----------

function GuidesPage({ games }: { games: Game[] }): React.JSX.Element {
  const { t } = useT()
  const [search, setSearch] = useState('')
  const list = useMemo(() => {
    const steam = games.filter((g) => appidOf(g) > 0)
    const score = (g: Game): number => gameLastPlayedAt(g) ?? 0
    const sorted = [...steam].sort((a, b) => score(b) - score(a) || gamePlayTimeSeconds(b) - gamePlayTimeSeconds(a) || a.name.localeCompare(b.name))
    const q = fold(search.trim())
    if (q) return sorted.filter((g) => fold(g.name).includes(q))
    return sorted.slice(0, GUIDES_MAX)
  }, [games, search])
  return (
    <div className="sto-page cmn-page" data-testid="community-guides">
      <div className="sto-ph">
        <span className="cap">{t('community.cap')}</span>
        <h2>{t('community.guides.title')}</h2>
        <p>{t('community.guides.sub')}</p>
      </div>
      <div className="cmn-guides-bar">
        <SearchBox value={search} onChange={setSearch} placeholder={t('community.guides.search')} testId="guides-search" />
      </div>
      {!list.length ? (
        <p className="cmn-quiet">{search.trim() ? t('community.guides.none') : t('community.guides.empty')}</p>
      ) : (
        <div className="cmn-guides">
          {list.map((g) => {
            const id = appidOf(g)
            return (
              <div key={g.id} className="cmn-guide" data-testid="guides-game" data-appid={id}>
                <span className="pic">
                  <Art srcs={[headerArt(id), coverSrc(g)]} />
                </span>
                <span className="nm" title={g.name}>
                  {g.name}
                </span>
                <span className="acts">
                  <button type="button" className="btn btn-line btn-sm" data-testid="guides-open" title={t('community.guides.guidesTitle', { name: g.name })} onClick={() => openLink(`${COMMUNITY}/app/${id}/guides/`)}>
                    <BookOpen />
                    {t('community.hub.guides')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-line btn-sm"
                    data-testid="discussions-open"
                    title={t('community.guides.discussionsTitle', { name: g.name })}
                    onClick={() => openLink(`${COMMUNITY}/app/${id}/discussions/`)}
                  >
                    <MessagesSquare />
                    {t('community.hub.discussions')}
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------- Vue ----------

interface Props {
  /** l'onglet est affiché */
  active: boolean
  /** jeux Steam de la bibliothèque */
  games: Game[]
  onOpenLaunchers: (focus?: 'steam-key') => void
}

export function CommunityView({ active, games, onOpenLaunchers }: Props): React.JSX.Element {
  const { t } = useT()
  const [section, setSection] = useState<CommunitySection>('home')
  const [article, setArticle] = useState<CommunityNewsItem | null>(null)
  const { news, busy, reload } = useNews(active && section !== 'workshop' && section !== 'guides')
  const body = useRef<HTMLDivElement>(null)
  const scrollMemo = useRef(0)

  const openArticle = useCallback((it: CommunityNewsItem) => {
    scrollMemo.current = body.current?.scrollTop ?? 0
    setArticle(it)
    body.current?.scrollTo({ top: 0 })
  }, [])
  const back = useCallback(() => {
    setArticle(null)
    requestAnimationFrame(() => body.current?.scrollTo({ top: scrollMemo.current }))
  }, [])
  const go = (s: CommunitySection): void => {
    setArticle(null)
    setSection(s)
    body.current?.scrollTo({ top: 0 })
  }

  // Échap : retour depuis un article (avant la vue Steam, qui ramène à la bibliothèque)
  useEffect(() => {
    if (!active || !article) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.ctxmenu')) return
      e.preventDefault()
      back()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, article, back])

  const steamUrl = section === 'workshop' ? `${COMMUNITY}/workshop/` : article ? article.url : `${COMMUNITY}/`

  return (
    <div className="sto cmn" data-testid="steam-community" data-section={article ? 'article' : section}>
      <nav className="sto-bar" aria-label={t('community.nav.aria')}>
        {article && (
          <button type="button" className="sto-back" data-testid="community-back" title={t('community.backTitle')} onClick={back}>
            <ArrowLeft />
            <span>{t('community.back')}</span>
          </button>
        )}
        <div className="sto-tabs">
          {SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              className={`sto-tab${section === id ? ' on' : ''}`}
              aria-current={section === id && !article ? 'page' : undefined}
              data-testid={`community-nav-${id}`}
              onClick={() => go(id)}
            >
              {t(`community.nav.${id}`)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {(section === 'home' || section === 'news') && !article && (
          <button type="button" className="btn btn-line btn-sm cmn-icon" data-testid="community-refresh" title={t('community.refresh')} aria-label={t('community.refresh')} disabled={busy} onClick={() => reload(true)}>
            <RefreshCw className={busy ? 'spin' : undefined} />
          </button>
        )}
        <button type="button" className="btn btn-line btn-sm" data-testid="community-open-steam" title={steamUrl} onClick={() => openLink(steamUrl)}>
          <ExternalLink />
          {t('community.openInSteam')}
        </button>
      </nav>
      <div className={`sto-body cmn-body${section === 'workshop' && !article ? ' ws' : ''}`} ref={body}>
        {article ? (
          <div className="sto-page cmn-page narrow">
            <ArticleView key={`${article.appid}:${article.id}`} appid={article.appid} id={article.id} seed={article} header={news?.games.find((g) => g.appid === article.appid)?.header} />
          </div>
        ) : section === 'home' ? (
          <HomePage news={news} busy={busy} reload={reload} onOpen={openArticle} onAllNews={() => go('news')} />
        ) : section === 'news' ? (
          <NewsPage news={news} busy={busy} reload={reload} onOpen={openArticle} />
        ) : section === 'workshop' ? (
          <WorkshopView active={active} onOpenLaunchers={onOpenLaunchers} />
        ) : (
          <GuidesPage games={games} />
        )}
      </div>
    </div>
  )
}
