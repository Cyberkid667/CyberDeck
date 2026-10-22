import { PLATFORM_INFO } from '../../../shared/platforms'
import type { GamePlatform } from '../../../shared/types'
import { useT } from '../i18n'
import { PlatformLogo } from './PlatformLogo'

// Étiquette de plateforme : logo de la plateforme puis son nom (mono 500 10/13, capitales) :
// STEAM, EPIC, GOG, EA, UBISOFT, BATTLE.NET, ROCKSTAR, XBOX, ITCH.IO, AMAZON, RIOT, LOCAL. Dans le
// bandeau, au bout de la légende, et dans la fenêtre « Retirer ce jeu » (les cartes ont un grand logo seul).

export function PlatformTag({ platform, className = '' }: { platform: GamePlatform; className?: string }): React.JSX.Element {
  const { t } = useT()
  const info = PLATFORM_INFO[platform]
  return (
    <span
      className={`ptag${platform === 'local' ? ' local' : ''}${className ? ` ${className}` : ''}`}
      data-testid="platform-badge"
      data-platform={platform}
      title={platform === 'local' ? t('library.platform.localTitle') : t('library.platform.gameTitle', { platform: info.name })}
    >
      <PlatformLogo platform={platform} />
      {info.short}
    </span>
  )
}
