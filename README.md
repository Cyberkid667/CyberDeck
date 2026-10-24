# CyberDeck

All your PC games in one library: Steam, Epic Games, GOG, EA, Ubisoft Connect, Battle.net, Rockstar, Xbox / Microsoft Store, itch.io, Amazon Games, Riot, plus the games you installed yourself. No more wondering which launcher a game is on: its logo tells you, and you just click **Play**.

Free, no ads, no account, no telemetry. For Windows 10 and 11 (64-bit). Available in English and French.

![The CyberDeck library](docs/capture.png)

## Install (2 minutes)

1. Open the **[Releases](https://github.com/Cyberkid667/CyberDeck/releases/latest)** page.
2. Under **Assets**, click **`CyberDeck-x.y.z-Setup.exe`** to download it.
3. Double-click the downloaded file.
4. Windows may show **"Windows protected your PC"**: click **More info**, then **Run anyway**. Every small app without a paid code-signing certificate gets this message.
5. That's it: CyberDeck installs itself, opens, and adds a Desktop shortcut. Your games show up within seconds.

No administrator rights needed: the app installs for your Windows account only.

**Update**: when a new version is out, CyberDeck tells you (a message and an "Update" button at the top of the window). Click **Download**, then run the new installer: your library is kept.

**Uninstall**: Windows Settings › Apps › CyberDeck › Uninstall. Your data stays in `%APPDATA%\CyberDeck`: delete that folder to remove everything.

## Linux

A Linux version is available too (64-bit, x86_64), for **Steam only**: other launchers exist only on Windows.

1. On the **[Releases](https://github.com/Cyberkid667/CyberDeck/releases/latest)** page, download **`CyberDeck-x.y.z-x86_64.AppImage`** (or the `.tar.gz` archive if you prefer to unpack it yourself).
2. Make it executable, then run it:

   ```bash
   chmod +x CyberDeck-*-x86_64.AppImage
   ./CyberDeck-*-x86_64.AppImage
   ```

   Some distributions need FUSE 2 for AppImages (Ubuntu 22.04 and newer: `sudo apt install libfuse2`, or `libfuse2t64` on 24.04). Without it, run `./CyberDeck-*-x86_64.AppImage --appimage-extract-and-run`.

What works on Linux:

- **Steam**: native, Flatpak and Snap installs (`~/.steam/steam`, `~/.local/share/Steam`, `~/.var/app/com.valvesoftware.Steam`, `~/snap/steam`), every Steam library, native Linux games and Proton games, "In game" and play time, download progress, owned games with your Steam API key, collections. Games start, install and uninstall through Steam (`steam://` links).
- The **Store, Library, Community and Profile** Steam tabs, game pages and **Twitch**.
- **Your own games**: add a native program, an AppImage or a `.sh` script with **Add a game**, or import a folder (for example `~/Games`).
- **Torrents** (optional, off by default). Windows installers (`setup.exe`) found in a torrent can't be run.

Not on Linux: Epic Games, GOG, EA, Ubisoft Connect, Battle.net, Rockstar, Xbox, itch.io, Amazon Games and Riot, and installing launchers with winget. To uninstall Steam, use your package manager (or Flatpak / Snap).

Your data is in `~/.config/CyberDeck`.

## Features

- **One library**: covers, the platform's logo on every game, filters by platform, sort by recently played or by name, search.
- **Play**: each game starts through its own launcher (Steam, Epic…), or directly for local games. CyberDeck shows "In game" while you play and counts your play time.
- **Launchers page**: see which of the 11 launchers are installed, install a missing one in one click (downloaded from its official source through Windows' package manager, winget), or uninstall one with its own uninstaller.
- **Automatic detection**: games installed by your launchers appear by themselves, and the list updates when you install or uninstall one.
- **Game pages**: click a game to see its page: big artwork, description, news, DLC, and links to its store, community hub, discussions, guides, workshop and support pages. With your Steam API key, also your achievements and the friends who play it.
- **Live on Twitch** (optional): sign in with your Twitch account to see who's streaming a game on its page, sort by viewers or most recent, filter by language, and watch a stream inside CyberDeck with Twitch's own player and chat, your own volume control and full screen.
- **Download progress**: follow a Steam download or update from CyberDeck (progress, speed, time remaining).
- **Uninstall games**: right-click a game › Uninstall. CyberDeck goes through the game's launcher (Steam…) or its own uninstaller, and never deletes a folder by itself.
- **Your other games**: add a game by hand, or import a whole folder (for example `D:\Games`) with a review window before anything is added.
- **Owned Steam games** (optional): with your Steam Web API key, you also see games you own but haven't installed.
- **Torrents** (optional, off by default): a small torrent client, to enable in Settings. Its peers globe places each peer in its real country: drag to rotate, scroll to zoom, hover a peer for its country, client and speed.
- **Languages**: English by default, French in Settings › Language.

![A game page in CyberDeck](docs/game-page.png)

## Supported platforms

| Platform | What is read on your PC |
| --- | --- |
| Steam | all your Steam libraries, on every drive |
| Epic Games | the Epic launcher's manifests |
| GOG Galaxy, EA app, Ubisoft Connect, Rockstar, Amazon Games, Riot, itch.io | the games registered by each launcher |
| Battle.net | the list of games installed by the Battle.net agent |
| Xbox / Microsoft Store | games installed from the Store or Game Pass |

A game is missing? Add it by hand with **Add a game**, or open an issue on GitHub with the launcher and game name.

## Privacy

- **No telemetry**: no crash reports, no analytics.
- **Updates**: at startup and every 12 hours, CyberDeck asks GitHub (`api.github.com`) for the latest published version number. Nothing is downloaded or installed without you. Can be turned off in Settings.
- To find covers, **game names** are sent to the Steam store, then to Wikipedia if Steam finds nothing. Epic covers are read from the Epic launcher's cache.
- **Only if you enter your Steam API key**: the key and your SteamID are sent to Valve to read your game list. The key is encrypted on disk by Windows.
- **Game pages**: opening a game's page asks the Steam store and news API about that game (its Steam id), or Wikipedia when it isn't on Steam, and loads their images. With your Steam API key, your achievements and your friends list are read from Valve too. Pages are cached in `%APPDATA%\CyberDeck\details`.
- **Only if you sign in with Twitch**: you approve CyberDeck on twitch.tv in your own browser, so CyberDeck never sees your Twitch password. Twitch then receives the game's name (to find its category) and your Twitch access token with each request; the player and chat come straight from Twitch. The tokens are encrypted on disk by Windows (`%APPDATA%\CyberDeck\twitch.json`) and revoked when you sign out.
- **Installing a launcher**: CyberDeck asks winget, Windows' package manager, to download the launcher from its official source. Nothing is installed unless you click Install.
- Other platforms are read **on your PC only**.
- **Torrents**: as with any torrent client, your IP address is visible to other peers. The peers globe finds each peer's country **offline**, in a database shipped with CyberDeck: peer addresses are never sent anywhere.
- Everything else (library, settings, log) stays in `%APPDATA%\CyberDeck`.

## Build it yourself

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
npm run build      # builds into out/
npx electron .     # runs the built app
npm run dist       # creates the installer in dist/
npm run dist:linux # on Linux: creates the AppImage and tar.gz in dist/
```

To test without touching your real library: `CYBERDECK_USER_DATA=<folder>` runs the app with a separate profile. Screenshot tools are in `tests/tools`.

Electron, React and TypeScript, built with electron-vite. Torrent engine: WebTorrent, in a separate process, started only when torrents are enabled.

## License

MIT, see [LICENSE](LICENSE).

**Credits**: [IP Geolocation by DB-IP](https://db-ip.com) (IP to Country Lite, CC BY 4.0); land shapes and country positions from [Natural Earth](https://www.naturalearthdata.com) (public domain). Details in [ATTRIBUTION.md](ATTRIBUTION.md).

Platform logos come from [Simple Icons](https://simpleicons.org) (CC0). They are trademarks of their respective owners, shown only to indicate where a game is installed. CyberDeck is not affiliated with any of these companies.
