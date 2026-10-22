import { ArrowDown, ArrowUp } from 'lucide-react'
import type { GlobalStats } from '../../../shared/types'
import { formatBytes, formatSpeed } from '../format'
import { useT } from '../i18n'

// Barre d'état (28 px) : point vivant + « MOTEUR » (instantané reçu il y a moins
// de 3 s) ou point gris + « EN ATTENTE » ; réception et émission globales ;
// à droite PAIRS · DHT · PORT · LIBRE (cellule masquée si l'espace libre est inconnu).
// Le débit dans le temps est dans l'oscilloscope de la barre latérale.

function Speed({ value }: { value: number | undefined }): React.JSX.Element {
  const text = formatSpeed(value ?? 0)
  return text === '—' ? <span className="nil">—</span> : <span className="v">{text}</span>
}

export function StatusBar({ stats, connected }: { stats: GlobalStats | null; connected: boolean }): React.JSX.Element {
  const { t, tn } = useT()
  const dht = stats?.dhtNodes ?? 0
  return (
    <footer className="statusbar" data-testid="statusbar">
      <div className="sb engine" title={connected ? t('shell.statusbar.engineOn') : t('shell.statusbar.engineWaiting')}>
        <span className={`live-dot${connected ? '' : ' off'}`} />
        <span className="k">{connected ? t('shell.statusbar.engine') : t('shell.statusbar.waiting')}</span>
      </div>
      <div className="sb" title={t('shell.traffic.downTotal')}>
        <ArrowDown />
        <Speed value={stats?.downloadSpeed} />
      </div>
      <div className="sb" title={t('shell.traffic.upTotal')}>
        <ArrowUp />
        <Speed value={stats?.uploadSpeed} />
      </div>
      <div className="sb sb-spacer" />
      <div className="sb" title={t('shell.statusbar.peersTitle')}>
        <span className="k">{t('shell.statusbar.peers')}</span>
        <span className="v">{stats?.peers ?? 0}</span>
      </div>
      <div className="sb" title={t('shell.statusbar.dhtTitle')}>
        <span className="k">DHT</span>
        <span className="v">{tn('shell.statusbar.nodes', dht)}</span>
      </div>
      <div className="sb" title={t('shell.statusbar.portTitle')}>
        <span className="k">{t('shell.statusbar.port')}</span>
        {stats?.port ? <span className="v">{stats.port}</span> : <span className="nil">—</span>}
      </div>
      {stats?.freeSpace != null && (
        <div className="sb" title={t('shell.statusbar.freeTitle')}>
          <span className="k">{t('shell.statusbar.free')}</span>
          <span className="v">{formatBytes(stats.freeSpace)}</span>
        </div>
      )}
    </footer>
  )
}
