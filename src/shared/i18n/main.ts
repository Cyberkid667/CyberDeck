// Dictionnaire « main » (processus principal : avertissements, erreurs, fenêtres Windows, textes des plateformes).
// Mêmes clés en anglais et en français ; voir index.ts.
import type { Messages } from './index'

const messages: Messages = {
  en: {
    // ---------- Commun ----------
    'main.common.unknownError': 'unknown error',
    'main.common.gameNotFound': 'Game not found.',

    // ---------- Fenêtres de Windows (choix de fichier ou de dossier) ----------
    'main.dialog.torrentTitle': 'Choose a .torrent file',
    'main.dialog.torrentFilter': 'Torrent files',
    'main.dialog.folderTitle': 'Destination folder',
    'main.dialog.exeTitle': 'Choose the game’s program',
    'main.dialog.exeFilter': 'Programs',
    'main.dialog.imageTitle': 'Choose a cover',
    'main.dialog.imageFilter': 'Images',

    // ---------- Moteur torrent ----------
    'main.engine.serviceName': '{app} - torrent engine',
    'main.engine.stopped': 'The torrent engine has stopped.',
    'main.engine.restarting': 'The torrent engine stopped, restarting…',
    'main.engine.noRestart': 'The torrent engine won’t restart. Close and reopen {app}.',
    'main.engine.notReady': 'The torrent engine isn’t ready.',
    'main.engine.disabled': 'Torrents are turned off: turn them on in Settings.',
    'main.engine.downloadDone': 'Download complete: {name}',
    'main.engine.trackerError': 'Error: {message}',
    'main.engine.chooseFolder': 'Choose a destination folder.',
    'main.engine.notMagnet': 'This link doesn’t start with “magnet:?”.',
    'main.engine.badMagnet': 'This magnet link is invalid.',
    'main.engine.badTorrentFile': 'This file isn’t a valid .torrent.',
    'main.engine.unreadable': 'Can’t read this torrent.',
    'main.engine.alreadyListed': '“{name}” is already in the list.',
    'main.engine.webSeed': 'Web seed',
    'main.engine.unknownClient': 'Unknown',
    'main.engine.tcpIncoming': 'TCP incoming',
    'main.engine.tcpOutgoing': 'TCP outgoing',
    'main.engine.utpIncoming': 'uTP incoming',
    'main.engine.utpOutgoing': 'uTP outgoing',
    'main.engine.trackerContacting': 'Contacting…',
    'main.engine.trackerPaused': 'Paused',
    'main.engine.trackerStopped': 'Stopped',
    'main.engine.trackerNoReply': 'No response',
    'main.engine.clientError': 'Engine error: {message}',
    'main.engine.actionFailed': 'Action failed: {message}',
    'main.trash.failed.one': '{n} file couldn’t be moved to the Recycle Bin.',
    'main.trash.failed.other': '{n} files couldn’t be moved to the Recycle Bin.',

    // ---------- Mises à jour (texte placé entre parenthèses par l'interface) ----------
    'main.update.httpStatus': 'GitHub replied {status}',
    'main.update.badVersion': 'unreadable version number',
    'main.update.timeout': 'timed out',
    'main.update.offline': 'offline or GitHub unreachable',

    // ---------- PowerShell ----------
    'main.ps.cantStart': 'PowerShell won’t start: {message}',
    'main.ps.timeout': 'Timed out ({s} s)',

    // ---------- Installation depuis un torrent ----------
    'main.install.installerMissing': 'The installer can’t be found: {path}',
    'main.install.adminDenied': 'Installation cancelled: administrator permission was denied.',
    'main.install.psRestricted':
      'PowerShell is restricted on this PC (Windows security policy): run the installer yourself from the opened folder, then add the game to the library.',
    'main.install.cantStart': 'The installer couldn’t start: {error}',
    'main.install.cancelled': 'Installation cancelled.',
    'main.install.failed': 'Installation failed: {error}',
    'main.install.alreadyInstalled': '{name} is already installed.',
    'main.install.steamOnly': 'Installing from CyberDeck only works for Steam games.',
    'main.install.steamNoReply': 'Steam isn’t responding: {message}',

    // ---------- Ajouter, modifier un jeu ----------
    'main.game.chooseExe': 'Choose an .exe program.',
    'main.game.exeNotFound': 'Program not found: {path}',

    // ---------- Lancer un jeu ----------
    'main.play.failed': 'Can’t launch the game: {error}',
    'main.play.psStartFailed': 'PowerShell won’t start ({message}).',
    'main.play.adminDenied': 'administrator permission was denied.',
    'main.play.psStopped': 'PowerShell stopped before launching (code {code}).',
    'main.play.psStoppedWhy': 'PowerShell stopped before launching (code {code}): {why}',
    'main.play.psRestricted':
      'PowerShell is restricted on this PC (Windows security policy): games are launched directly, but CyberDeck can’t track their playtime.',
    'main.play.notStartedYet':
      '{name} hasn’t started after {waited} (update or sign-in in the launcher?). CyberDeck keeps watching for {left} more: its playtime will be counted if it starts.',
    'main.play.notStarted': '{name} didn’t start within {duration} (update or sign-in in the launcher?): playtime isn’t counted this time.',
    'main.play.starting': '{name} is starting.',
    'main.play.alreadyRunning': '{name} is already running.',
    'main.play.exeMissing': 'Program not found: {path}. Click Edit to choose the right .exe.',
    'main.play.notInstalled': '{name} isn’t installed.',
    'main.play.notInstalledSteam': '{name} isn’t installed. Click Install.',
    'main.play.launcherMissing': 'The {platform} launcher can’t be found: install it or run platform detection again.',
    'main.play.protocolMissing': '{platform} isn’t installed on this PC (Windows doesn’t know the {scheme}: address).',
    'main.play.targetMissing': 'Program not found: {path}. Run platform detection again.',
    'main.play.folderUnknown': 'Folder of {name} unknown: run platform detection again.',

    // ---------- Désinstaller ----------
    'main.uninstall.windowsApps': 'Windows Installed apps',
    'main.uninstall.notInstalled': '{name} isn’t installed on this PC.',
    'main.uninstall.noSteamId': 'Unknown Steam ID.',
    'main.uninstall.nothingFound': 'No uninstaller or folder found for this game.',
    'main.uninstall.done': '{name} is uninstalled and removed from the library.',
    'main.uninstall.running': '{name} is running: quit the game first.',
    'main.uninstall.folderMissing': 'Folder not found: {error}',
    'main.uninstall.adminDenied': 'Administrator permission was denied.',
    'main.uninstall.cantStart': 'The uninstaller won’t start: {error}',
    'main.uninstall.failed': 'Can’t uninstall.',

    // ---------- Compte Steam ----------
    'main.steam.notInstalled': 'Steam isn’t installed on this PC.',
    'main.steam.noAccount': 'No Steam account found on this PC: sign in to Steam once.',
    'main.steam.noAccountShort': 'No Steam account found on this PC.',
    'main.steam.addKey': 'Add your Steam Web API key to also see the games you own but haven’t installed.',
    'main.steam.cantEncrypt': 'Windows can’t encrypt the key on this PC: it can’t be saved.',
    'main.steam.cantEncryptNotSaved': 'Windows can’t encrypt the key on this PC: it wasn’t saved.',
    'main.steam.keyUnreadable': 'The saved key can’t be read on this PC: save it again.',
    'main.steam.checking': 'Reading the list of owned games…',
    'main.steam.ownedSummary.one': '{n} game owned ({notInstalled} not installed on this PC).',
    'main.steam.ownedSummary.other': '{n} games owned, {notInstalled} of them not installed on this PC.',
    'main.steam.noKey': 'No key saved.',
    'main.steam.keyFormat': 'A Steam key is 32 characters long (digits and letters A to F).',
    'main.steam.accountNotFound': 'Steam account not found on this PC.',
    'main.steam.offline': 'Steam can’t be reached: check your internet connection.',
    'main.steam.keyRefused': 'Steam rejects this key. Check it at steamcommunity.com/dev/apikey.',
    'main.steam.rateLimited': 'Steam is limiting requests: try again in a few minutes.',
    'main.steam.httpStatus': 'Steam replied {status}: try again later.',
    'main.steam.noGames': 'No games on this account.',
    'main.steam.private':
      'This account’s game details are private: in Steam, go to Profile › Edit Profile › Privacy Settings and set “Game details” to Public.',
    'main.steam.gameCount.one': '{n} game or app on this account.',
    'main.steam.gameCount.other': '{n} games and apps on this account.',

    // ---------- Lecture des plateformes ----------
    'main.scan.failed': 'Read failed: {error}',
    'main.scan.unknownSchema': 'unknown database schema',
    'main.scan.amazonUnreadable': 'Amazon Games database unreadable: {error}',
    'main.scan.amazonNoSqlite': 'SQLite unavailable: Amazon games not read',
    'main.scan.itchUnreadable': 'itch.io database unreadable: {error}',
    'main.scan.itchNoSqlite': 'SQLite unavailable: itch.io games not read',
    'main.scan.battlenetUnreadable': 'product.db unreadable: {error}',
    'main.scan.epicUnreadable': 'Epic manifests unreadable: {error}',
    'main.scan.storeAppsUnreadable': 'Microsoft Store apps unreadable: {error}',
    'main.scan.storeAppsUnreadableShort': 'Microsoft Store apps unreadable',
    'main.scan.psRestricted': 'PowerShell in restricted mode (PC policy)',
    'main.scan.registryEmpty': 'empty registry (read denied?)',
    'main.scan.registryFailed': 'Can’t read the registry: {error}',
    'main.protobuf.varint': 'truncated varint',
    'main.protobuf.varintTooLong': 'varint too long',
    'main.protobuf.field0': 'field 0',
    'main.protobuf.fixed64': 'truncated fixed64',
    'main.protobuf.fixed32': 'truncated fixed32',
    'main.protobuf.length': 'truncated length',
    'main.protobuf.wireType': 'unsupported type {type}'
  },
  fr: {
    // ---------- Commun ----------
    'main.common.unknownError': 'erreur inconnue',
    'main.common.gameNotFound': 'Jeu introuvable.',

    // ---------- Fenêtres de Windows (choix de fichier ou de dossier) ----------
    'main.dialog.torrentTitle': 'Choisir un fichier .torrent',
    'main.dialog.torrentFilter': 'Fichiers torrent',
    'main.dialog.folderTitle': 'Dossier de destination',
    'main.dialog.exeTitle': 'Choisir le programme du jeu',
    'main.dialog.exeFilter': 'Programmes',
    'main.dialog.imageTitle': 'Choisir une jaquette',
    'main.dialog.imageFilter': 'Images',

    // ---------- Moteur torrent ----------
    'main.engine.serviceName': '{app} - moteur torrent',
    'main.engine.stopped': 'Le moteur torrent s’est arrêté.',
    'main.engine.restarting': 'Le moteur torrent s’est arrêté, redémarrage…',
    'main.engine.noRestart': 'Le moteur torrent ne redémarre pas. Ferme et relance {app}.',
    'main.engine.notReady': 'Le moteur torrent n’est pas prêt.',
    'main.engine.disabled': 'Les torrents sont désactivés : active-les dans Réglages.',
    'main.engine.downloadDone': 'Téléchargement terminé : {name}',
    'main.engine.trackerError': 'Erreur : {message}',
    'main.engine.chooseFolder': 'Choisis un dossier de destination.',
    'main.engine.notMagnet': 'Ce lien ne commence pas par « magnet:? ».',
    'main.engine.badMagnet': 'Ce lien magnet est invalide.',
    'main.engine.badTorrentFile': 'Ce fichier n’est pas un .torrent valide.',
    'main.engine.unreadable': 'Impossible de lire ce torrent.',
    'main.engine.alreadyListed': '« {name} » est déjà dans la liste.',
    'main.engine.webSeed': 'Source web',
    'main.engine.unknownClient': 'Inconnu',
    'main.engine.tcpIncoming': 'TCP entrant',
    'main.engine.tcpOutgoing': 'TCP sortant',
    'main.engine.utpIncoming': 'uTP entrant',
    'main.engine.utpOutgoing': 'uTP sortant',
    'main.engine.trackerContacting': 'En contact…',
    'main.engine.trackerPaused': 'En pause',
    'main.engine.trackerStopped': 'Arrêté',
    'main.engine.trackerNoReply': 'Pas de réponse',
    'main.engine.clientError': 'Erreur du moteur : {message}',
    'main.engine.actionFailed': 'Action impossible : {message}',
    'main.trash.failed.one': '{n} fichier n’a pas pu aller à la corbeille.',
    'main.trash.failed.other': '{n} fichiers n’ont pas pu aller à la corbeille.',

    // ---------- Mises à jour (texte placé entre parenthèses par l'interface) ----------
    'main.update.httpStatus': 'GitHub a répondu {status}',
    'main.update.badVersion': 'numéro de version illisible',
    'main.update.timeout': 'délai dépassé',
    'main.update.offline': 'hors ligne ou GitHub injoignable',

    // ---------- PowerShell ----------
    'main.ps.cantStart': 'PowerShell ne démarre pas : {message}',
    'main.ps.timeout': 'Délai dépassé ({s} s)',

    // ---------- Installation depuis un torrent ----------
    'main.install.installerMissing': 'L’installateur est introuvable : {path}',
    'main.install.adminDenied': 'Installation annulée : l’autorisation administrateur a été refusée.',
    'main.install.psRestricted':
      'PowerShell est restreint sur ce PC (stratégie de sécurité de Windows) : lance l’installateur toi-même depuis le dossier ouvert, puis ajoute le jeu à la bibliothèque.',
    'main.install.cantStart': 'L’installateur n’a pas pu démarrer : {error}',
    'main.install.cancelled': 'Installation annulée.',
    'main.install.failed': 'Installation impossible : {error}',
    'main.install.alreadyInstalled': '{name} est déjà installé.',
    'main.install.steamOnly': 'L’installation depuis CyberDeck n’existe que pour les jeux Steam.',
    'main.install.steamNoReply': 'Steam ne répond pas : {message}',

    // ---------- Ajouter, modifier un jeu ----------
    'main.game.chooseExe': 'Choisis un programme .exe.',
    'main.game.exeNotFound': 'Programme introuvable : {path}',

    // ---------- Lancer un jeu ----------
    'main.play.failed': 'Impossible de lancer le jeu : {error}',
    'main.play.psStartFailed': 'PowerShell ne démarre pas ({message}).',
    'main.play.adminDenied': 'l’autorisation administrateur a été refusée.',
    'main.play.psStopped': 'PowerShell s’est arrêté avant le lancement (code {code}).',
    'main.play.psStoppedWhy': 'PowerShell s’est arrêté avant le lancement (code {code}) : {why}',
    'main.play.psRestricted':
      'PowerShell est restreint sur ce PC (stratégie de sécurité de Windows) : les jeux sont lancés directement, mais CyberDeck ne peut pas compter leur temps de jeu.',
    'main.play.notStartedYet':
      '{name} n’a pas encore démarré après {waited} (mise à jour ou connexion dans le lanceur ?). CyberDeck le surveille encore {left} : son temps de jeu sera compté s’il démarre.',
    'main.play.notStarted':
      '{name} n’a pas démarré en {duration} (mise à jour ou connexion dans le lanceur ?) : le temps de jeu n’est pas compté cette fois.',
    'main.play.starting': '{name} est en train de démarrer.',
    'main.play.alreadyRunning': '{name} est déjà lancé.',
    'main.play.exeMissing': 'Programme introuvable : {path}. Clique sur Modifier pour choisir le bon .exe.',
    'main.play.notInstalled': '{name} n’est pas installé.',
    'main.play.notInstalledSteam': '{name} n’est pas installé. Clique sur Installer.',
    'main.play.launcherMissing': 'Le lanceur {platform} est introuvable : installe-le ou relance la détection des plateformes.',
    'main.play.protocolMissing': '{platform} n’est pas installé sur ce PC (adresse {scheme}: inconnue de Windows).',
    'main.play.targetMissing': 'Programme introuvable : {path}. Relance la détection des plateformes.',
    'main.play.folderUnknown': 'Dossier de {name} inconnu : relance la détection des plateformes.',

    // ---------- Désinstaller ----------
    'main.uninstall.windowsApps': 'Applications installées de Windows',
    'main.uninstall.notInstalled': '{name} n’est pas installé sur ce PC.',
    'main.uninstall.noSteamId': 'Identifiant Steam inconnu.',
    'main.uninstall.nothingFound': 'Aucun programme de désinstallation ni dossier trouvé pour ce jeu.',
    'main.uninstall.done': '{name} est désinstallé et retiré de la bibliothèque.',
    'main.uninstall.running': '{name} est en cours : quitte le jeu d’abord.',
    'main.uninstall.folderMissing': 'Dossier introuvable : {error}',
    'main.uninstall.adminDenied': 'L’autorisation administrateur a été refusée.',
    'main.uninstall.cantStart': 'Le désinstalleur ne démarre pas : {error}',
    'main.uninstall.failed': 'Désinstallation impossible.',

    // ---------- Compte Steam ----------
    'main.steam.notInstalled': 'Steam n’est pas installé sur ce PC.',
    'main.steam.noAccount': 'Aucun compte Steam trouvé sur ce PC : connecte-toi une fois dans Steam.',
    'main.steam.noAccountShort': 'Aucun compte Steam trouvé sur ce PC.',
    'main.steam.addKey': 'Ajoute ta clé Web API Steam pour voir aussi les jeux possédés mais pas installés.',
    'main.steam.cantEncrypt': 'Windows ne peut pas chiffrer la clé sur ce PC : elle ne peut pas être enregistrée.',
    'main.steam.cantEncryptNotSaved': 'Windows ne peut pas chiffrer la clé sur ce PC : elle n’est pas enregistrée.',
    'main.steam.keyUnreadable': 'La clé enregistrée ne peut pas être relue sur ce PC : enregistre-la à nouveau.',
    'main.steam.checking': 'Lecture de la liste des jeux possédés…',
    'main.steam.ownedSummary.one': '{n} jeu possédé, dont {notInstalled} pas installé sur ce PC.',
    'main.steam.ownedSummary.other': '{n} jeux possédés, dont {notInstalled} pas installés sur ce PC.',
    'main.steam.noKey': 'Aucune clé enregistrée.',
    'main.steam.keyFormat': 'Une clé Steam fait 32 caractères (chiffres et lettres A à F).',
    'main.steam.accountNotFound': 'Compte Steam introuvable sur ce PC.',
    'main.steam.offline': 'Steam est injoignable : vérifie la connexion Internet.',
    'main.steam.keyRefused': 'Steam refuse cette clé. Vérifie-la sur steamcommunity.com/dev/apikey.',
    'main.steam.rateLimited': 'Steam limite les demandes : réessaie dans quelques minutes.',
    'main.steam.httpStatus': 'Steam a répondu {status} : réessaie plus tard.',
    'main.steam.noGames': 'Aucun jeu sur ce compte.',
    'main.steam.private':
      'Le détail des jeux de ce compte est privé : dans Steam, Profil › Modifier › Confidentialité, mets « Détails des jeux » sur Public.',
    'main.steam.gameCount.one': '{n} jeu ou application sur ce compte.',
    'main.steam.gameCount.other': '{n} jeux et applications sur ce compte.',

    // ---------- Lecture des plateformes ----------
    'main.scan.failed': 'Lecture impossible : {error}',
    'main.scan.unknownSchema': 'schéma de la base inconnu',
    'main.scan.amazonUnreadable': 'Base Amazon Games illisible : {error}',
    'main.scan.amazonNoSqlite': 'SQLite indisponible : jeux Amazon non lus',
    'main.scan.itchUnreadable': 'Base itch.io illisible : {error}',
    'main.scan.itchNoSqlite': 'SQLite indisponible : jeux itch.io non lus',
    'main.scan.battlenetUnreadable': 'product.db illisible : {error}',
    'main.scan.epicUnreadable': 'Manifestes Epic illisibles : {error}',
    'main.scan.storeAppsUnreadable': 'Applications du Microsoft Store illisibles : {error}',
    'main.scan.storeAppsUnreadableShort': 'Applications du Microsoft Store illisibles',
    'main.scan.psRestricted': 'PowerShell en mode restreint (stratégie du PC)',
    'main.scan.registryEmpty': 'registre vide (lecture refusée ?)',
    'main.scan.registryFailed': 'Lecture du registre impossible : {error}',
    'main.protobuf.varint': 'varint coupé',
    'main.protobuf.varintTooLong': 'varint trop long',
    'main.protobuf.field0': 'champ 0',
    'main.protobuf.fixed64': 'fixe 64 coupé',
    'main.protobuf.fixed32': 'fixe 32 coupé',
    'main.protobuf.length': 'longueur coupée',
    'main.protobuf.wireType': 'type {type} non géré'
  }
}

export default messages
