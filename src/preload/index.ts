import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DownloadProgress, EssaimApi, InstallResult, LaunchersState, LibraryState, Notice, PlatformsState, Settings, Snapshot, TwitchState, UpdateState } from '../shared/types'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: unknown, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: EssaimApi = {
  // Linux : l'interface adapte quelques textes (programmes sans .exe, lanceurs Windows seulement)
  os: process.platform,
  onSnapshot: (cb) => subscribe<Snapshot>('snapshot', cb),
  onNotice: (cb) => subscribe<Notice>('notice', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettings: (cb) => subscribe<Settings>('settings', cb),
  pickTorrentFile: () => ipcRenderer.invoke('dialog:torrent-file'),
  pickFolder: (defaultPath, title) => ipcRenderer.invoke('dialog:folder', defaultPath, title),
  readClipboardMagnet: () => ipcRenderer.invoke('clipboard:magnet'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  inspectTorrentFile: (filePath) => ipcRenderer.invoke('torrent:inspect', filePath),
  add: (req) => ipcRenderer.invoke('torrent:add', req),
  pause: (ids) => ipcRenderer.send('torrent:pause', ids),
  resume: (ids) => ipcRenderer.send('torrent:resume', ids),
  remove: (ids, deleteFiles) => ipcRenderer.send('torrent:remove', ids, deleteFiles),
  select: (id) => ipcRenderer.send('torrent:select', id),
  openFolder: (id) => ipcRenderer.send('torrent:open-folder', id),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),

  getLibrary: () => ipcRenderer.invoke('library:get'),
  onLibrary: (cb) => subscribe<LibraryState>('library', cb),
  onInstallDone: (cb) => subscribe<InstallResult>('install-done', cb),
  installTorrent: (torrentId) => ipcRenderer.send('library:install', torrentId),
  addGame: (input) => ipcRenderer.invoke('library:add', input),
  updateGame: (id, input) => ipcRenderer.invoke('library:update', id, input),
  removeGame: (id) => ipcRenderer.send('library:remove', id),
  playGame: (id) => ipcRenderer.send('library:play', id),
  openGameFolder: (id) => ipcRenderer.send('library:open-folder', id),
  searchCover: (id) => ipcRenderer.invoke('library:search-cover', id),
  setCoverFromFile: (id, file) => ipcRenderer.invoke('library:cover-file', id, file),
  pickExe: (defaultPath) => ipcRenderer.invoke('dialog:exe', defaultPath),
  pickImage: () => ipcRenderer.invoke('dialog:image'),
  scanGamesFolder: (dir) => ipcRenderer.invoke('library:scan-folder', dir),
  importGames: (inputs) => ipcRenderer.invoke('library:import', inputs),
  defaultGamesFolder: () => ipcRenderer.invoke('library:default-folder'),

  getPlatforms: () => ipcRenderer.invoke('platforms:get'),
  onPlatforms: (cb) => subscribe<PlatformsState>('platforms', cb),
  syncPlatforms: () => ipcRenderer.invoke('platforms:sync'),
  installGame: (id) => ipcRenderer.invoke('library:install-game', id),
  restoreHiddenGames: () => ipcRenderer.invoke('library:restore-hidden'),
  setSteamApiKey: (key) => ipcRenderer.invoke('steam:set-key', key),
  testSteamApiKey: (key) => ipcRenderer.invoke('steam:test-key', key),
  clearSteamApiKey: () => ipcRenderer.invoke('steam:clear-key'),
  refreshSteamOwned: () => ipcRenderer.invoke('steam:refresh-owned'),
  openSteamApiKeyPage: () => ipcRenderer.send('steam:open-key-page'),

  getUpdate: () => ipcRenderer.invoke('update:get'),
  onUpdate: (cb) => subscribe<UpdateState>('update', cb),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openUpdate: () => ipcRenderer.send('update:open'),

  uninstallPlan: (id) => ipcRenderer.invoke('library:uninstall-plan', id),
  uninstallGame: (id, removeFromList) => ipcRenderer.invoke('library:uninstall', id, removeFromList),

  getGameDetails: (id, refresh) => ipcRenderer.invoke('details:get', id, refresh === true),
  getDownloads: () => ipcRenderer.invoke('downloads:get'),
  onDownloads: (cb) => subscribe<Record<string, DownloadProgress>>('downloads', cb),
  openExternalLink: (url) => ipcRenderer.send('link:open', url),
  getSteamCollections: () => ipcRenderer.invoke('steam:collections'),
  getStoreHome: (refresh) => ipcRenderer.invoke('store:home', refresh === true),
  getStoreList: (kind, refresh) => ipcRenderer.invoke('store:list', kind, refresh === true),
  searchStore: (term) => ipcRenderer.invoke('store:search', term),
  getStoreApp: (appid, refresh) => ipcRenderer.invoke('store:app', appid, refresh === true),
  getSteamProfile: (refresh) => ipcRenderer.invoke('steam:profile', refresh === true),
  getSteamFriends: (refresh) => ipcRenderer.invoke('steam:friends', refresh === true),
  getCommunityNews: (refresh) => ipcRenderer.invoke('community:news', refresh === true),
  getCommunityArticle: (appid, id) => ipcRenderer.invoke('community:article', appid, id),
  getWorkshopGames: (refresh) => ipcRenderer.invoke('community:workshop-games', refresh === true),
  getWorkshopPage: (appid, sort, cursor, refresh) => ipcRenderer.invoke('community:workshop-page', appid, sort, cursor ?? null, refresh === true),
  getWorkshopItem: (id) => ipcRenderer.invoke('community:workshop-item', id),

  getLaunchers: () => ipcRenderer.invoke('launchers:get'),
  onLaunchers: (cb) => subscribe<LaunchersState>('launchers', cb),
  installLauncher: (id) => ipcRenderer.invoke('launchers:install', id),
  uninstallLauncher: (id) => ipcRenderer.invoke('launchers:uninstall', id),
  cancelLauncherOp: (id) => ipcRenderer.send('launchers:cancel', id),

  getTwitchState: () => ipcRenderer.invoke('twitch:state'),
  onTwitch: (cb) => subscribe<TwitchState>('twitch', cb),
  twitchSignIn: () => ipcRenderer.invoke('twitch:sign-in'),
  twitchCancelSignIn: () => ipcRenderer.send('twitch:cancel-sign-in'),
  twitchSignOut: () => ipcRenderer.invoke('twitch:sign-out'),
  twitchOpenActivate: () => ipcRenderer.send('twitch:open-activate'),
  getTwitchStreams: (gameId, query) => ipcRenderer.invoke('twitch:streams', gameId, query ?? {}),
  searchTwitchCategories: (query) => ipcRenderer.invoke('twitch:search-categories', query),
  setTwitchCategory: (gameId, category) => ipcRenderer.invoke('twitch:set-category', gameId, category),
  onTwitchEscape: (cb) => subscribe<void>('twitch:escape', () => cb())
}

contextBridge.exposeInMainWorld('essaim', api)
