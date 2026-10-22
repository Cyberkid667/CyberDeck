# CyberDeck

**Français** · [English](#english)

Tous tes jeux PC dans une seule bibliothèque : Steam, Epic Games, GOG, EA, Ubisoft Connect, Battle.net, Rockstar, Xbox / Microsoft Store, itch.io, Amazon Games, Riot et tes jeux installés à la main. Plus besoin de te demander sur quel lanceur se trouve un jeu : tu le vois à son logo, et tu cliques sur **Jouer**.

Gratuit, sans publicité, sans compte, sans télémétrie. Pour Windows 10 et 11 (64 bits).

![La bibliothèque de CyberDeck](docs/capture.png)

## Installer (2 minutes)

1. Ouvre la page **[Releases](https://github.com/Cyberkid667/CyberDeck/releases/latest)**.
2. Dans **Assets**, clique sur **`CyberDeck-x.y.z-Setup.exe`** pour le télécharger.
3. Double-clique sur le fichier téléchargé.
4. Windows affiche peut-être **« Windows a protégé votre ordinateur »** : clique sur **Informations complémentaires**, puis sur **Exécuter quand même**. Ce message apparaît pour toutes les petites applications qui n'ont pas de certificat payant.
5. C'est tout : CyberDeck s'installe tout seul, s'ouvre, et met un raccourci sur le Bureau. Tes jeux apparaissent en quelques secondes.

Pas besoin d'être administrateur : l'app s'installe seulement pour ton compte Windows.

**Mettre à jour** : télécharge la nouvelle version sur la même page et lance-la. Ta bibliothèque est gardée.

**Désinstaller** : Paramètres Windows › Applications › CyberDeck › Désinstaller. Tes données restent dans `%APPDATA%\CyberDeck` : supprime ce dossier pour tout effacer.

## Ce que fait CyberDeck

- **Une bibliothèque unique** : jaquettes, logo de la plateforme sur chaque jeu, filtres par plateforme, tri « joués récemment » ou par nom, recherche.
- **Jouer** : chaque jeu se lance par son lanceur d'origine (Steam, Epic…), ou directement pour les jeux locaux. CyberDeck affiche « En jeu » pendant la partie et compte ton temps de jeu.
- **Détection automatique** : les jeux installés par tes lanceurs arrivent tout seuls, et la liste se met à jour quand tu en installes ou désinstalles un.
- **Tes autres jeux** : ajoute un jeu à la main, ou importe tout un dossier (par exemple `D:\Jeux`) avec une fenêtre de revue avant l'ajout.
- **Jeux Steam possédés** (facultatif) : avec ta clé d'API Steam, tu vois aussi les jeux que tu possèdes sans les avoir installés.
- **Torrents** (facultatif, désactivés par défaut) : un petit client torrent, à activer dans Réglages.

## Plateformes reconnues

| Plateforme | Ce qui est lu sur ton PC |
| --- | --- |
| Steam | toutes tes bibliothèques Steam, sur tous les disques |
| Epic Games | les manifestes du lanceur Epic |
| GOG Galaxy, EA app, Ubisoft Connect, Rockstar, Amazon Games, Riot, itch.io | les jeux enregistrés par chaque lanceur |
| Battle.net | la liste des jeux installés par l'agent Battle.net |
| Xbox / Microsoft Store | les jeux installés depuis le Store ou le Game Pass |

Un jeu manque ? Ajoute-le à la main avec **Ajouter un jeu**, ou ouvre une *issue* sur GitHub avec le nom du lanceur et du jeu.

## Confidentialité

- **Aucune télémétrie** : pas de mise à jour automatique, pas de rapport de plantage, pas de mesure d'audience.
- Pour trouver les jaquettes, le **nom des jeux** est envoyé à la boutique Steam, puis à Wikipédia si Steam ne trouve rien. Les jaquettes Epic sont lues dans le cache du lanceur Epic.
- **Seulement si tu entres ta clé d'API Steam** : la clé et ton SteamID sont envoyés à Valve pour lire la liste de tes jeux. La clé est chiffrée sur le disque par Windows.
- Les autres plateformes sont lues **sur ton PC uniquement**.
- **Torrents** : comme avec tout client torrent, ton adresse IP est visible des autres participants.
- Tout le reste (bibliothèque, réglages, journal) reste dans `%APPDATA%\CyberDeck`.

## Compiler soi-même

Il faut [Node.js](https://nodejs.org) 22 ou plus récent.

```bash
npm install
npm run build      # compile dans out/
npx electron .     # lance l'app compilée
npm run dist       # crée l'installateur dans dist/
```

Pour tester sans toucher à ta vraie bibliothèque : `CYBERDECK_USER_DATA=<dossier>` lance l'app avec un profil séparé. Les outils de capture sont dans `tests/outils`.

Electron, React et TypeScript, construit avec electron-vite. Moteur torrent : WebTorrent, dans un processus séparé, démarré seulement si les torrents sont activés.

## Licence

MIT, voir [LICENSE](LICENSE).

Les logos des plateformes viennent de [Simple Icons](https://simpleicons.org) (CC0). Ce sont des marques de leurs propriétaires respectifs, affichées seulement pour indiquer où un jeu est installé. CyberDeck n'est lié à aucune de ces sociétés.

---

<a id="english"></a>

# CyberDeck (English)

[Français](#cyberdeck) · **English**

All your PC games in one library: Steam, Epic Games, GOG, EA, Ubisoft Connect, Battle.net, Rockstar, Xbox / Microsoft Store, itch.io, Amazon Games, Riot, plus games you installed yourself. No more wondering which launcher a game is on: its logo tells you, and you just click **Play** (*Jouer*).

Free, no ads, no account, no telemetry. For Windows 10 and 11 (64-bit). The interface is in French.

## Install (2 minutes)

1. Open the **[Releases](https://github.com/Cyberkid667/CyberDeck/releases/latest)** page.
2. Under **Assets**, click **`CyberDeck-x.y.z-Setup.exe`** to download it.
3. Double-click the downloaded file.
4. Windows may show **"Windows protected your PC"**: click **More info**, then **Run anyway**. Every small app without a paid code-signing certificate gets this message.
5. That's it: CyberDeck installs itself, opens, and adds a Desktop shortcut. Your games show up within seconds.

No administrator rights needed: the app installs for your Windows account only.

**Update**: download the new version from the same page and run it. Your library is kept.

**Uninstall**: Windows Settings › Apps › CyberDeck › Uninstall. Your data stays in `%APPDATA%\CyberDeck`: delete that folder to remove everything.

## Features

- **One library**: covers, the platform's logo on every game, filters by platform, sort by recently played or by name, search.
- **Play**: each game starts through its own launcher (Steam, Epic…), or directly for local games. CyberDeck shows "En jeu" (in game) while you play and counts your play time.
- **Automatic detection**: games installed by your launchers appear by themselves, and the list updates when you install or uninstall one.
- **Your other games**: add a game by hand, or import a whole folder (for example `D:\Games`) with a review window before anything is added.
- **Owned Steam games** (optional): with your Steam Web API key, you also see games you own but haven't installed.
- **Torrents** (optional, off by default): a small torrent client, to enable in Settings (*Réglages*).

## Supported platforms

| Platform | What is read on your PC |
| --- | --- |
| Steam | all your Steam libraries, on every drive |
| Epic Games | the Epic launcher's manifests |
| GOG Galaxy, EA app, Ubisoft Connect, Rockstar, Amazon Games, Riot, itch.io | the games registered by each launcher |
| Battle.net | the list of games installed by the Battle.net agent |
| Xbox / Microsoft Store | games installed from the Store or Game Pass |

A game is missing? Add it by hand with **Ajouter un jeu** (Add a game), or open an issue on GitHub with the launcher and game name.

## Privacy

- **No telemetry**: no auto-update, no crash reports, no analytics.
- To find covers, **game names** are sent to the Steam store, then to Wikipedia if Steam finds nothing. Epic covers are read from the Epic launcher's cache.
- **Only if you enter your Steam API key**: the key and your SteamID are sent to Valve to read your game list. The key is encrypted on disk by Windows.
- Other platforms are read **on your PC only**.
- **Torrents**: as with any torrent client, your IP address is visible to other peers.
- Everything else (library, settings, log) stays in `%APPDATA%\CyberDeck`.

## Build it yourself

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run build      # builds into out/
npx electron .     # runs the built app
npm run dist       # creates the installer in dist/
```

To test without touching your real library: `CYBERDECK_USER_DATA=<folder>` runs the app with a separate profile. Screenshot tools are in `tests/outils`.

Electron, React and TypeScript, built with electron-vite. Torrent engine: WebTorrent, in a separate process, started only when torrents are enabled.

## License

MIT, see [LICENSE](LICENSE).

Platform logos come from [Simple Icons](https://simpleicons.org) (CC0). They are trademarks of their respective owners, shown only to indicate where a game is installed. CyberDeck is not affiliated with any of these companies.
