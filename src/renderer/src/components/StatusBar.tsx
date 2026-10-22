import { ArrowDown, ArrowUp } from 'lucide-react'
import type { GlobalStats } from '../../../shared/types'
import { formatBytes, formatSpeed } from '../format'

// Barre d'état (28 px) : point vivant + « MOTEUR » (instantané reçu il y a moins
// de 3 s) ou point gris + « EN ATTENTE » ; réception et émission globales ;
// à droite PAIRS · DHT · PORT · LIBRE (cellule masquée si l'espace libre est inconnu).
// Le débit dans le temps est dans l'oscilloscope de la barre latérale.

function Speed({ value }: { value: number | undefined }): React.JSX.Element {
  const text = formatSpeed(value ?? 0)
  return text === '—' ? <span className="nil">—</span> : <span className="v">{text}</span>
}

export function StatusBar({ stats, connected }: { stats: GlobalStats | null; connected: boolean }): React.JSX.Element {
  const dht = stats?.dhtNodes ?? 0
  return (
    <footer className="statusbar" data-testid="statusbar">
      <div className="sb engine" title={connected ? 'Moteur actif' : 'Moteur en attente'}>
        <span className={`live-dot${connected ? '' : ' off'}`} />
        <span className="k">{connected ? 'Moteur' : 'En attente'}</span>
      </div>
      <div className="sb" title="Réception totale">
        <ArrowDown />
        <Speed value={stats?.downloadSpeed} />
      </div>
      <div className="sb" title="Émission totale">
        <ArrowUp />
        <Speed value={stats?.uploadSpeed} />
      </div>
      <div className="sb sb-spacer" />
      <div className="sb" title="Pairs connectés">
        <span className="k">Pairs</span>
        <span className="v">{stats?.peers ?? 0}</span>
      </div>
      <div className="sb" title="Nœuds DHT connus">
        <span className="k">DHT</span>
        <span className="v">
          {dht} nœud{dht > 1 ? 's' : ''}
        </span>
      </div>
      <div className="sb" title="Port d’écoute">
        <span className="k">Port</span>
        {stats?.port ? <span className="v">{stats.port}</span> : <span className="nil">—</span>}
      </div>
      {stats?.freeSpace != null && (
        <div className="sb" title="Espace libre dans le dossier de destination">
          <span className="k">Libre</span>
          <span className="v">{formatBytes(stats.freeSpace)}</span>
        </div>
      )}
    </footer>
  )
}
