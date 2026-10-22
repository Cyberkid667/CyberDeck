import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EssaimApi, InstallResult, LibraryState, Notice, PlatformsState, Settings, Snapshot, UpdateState } from '../shared/types'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: unknown, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: EssaimApi = {
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
  uninstallGame: (id, removeFromList) => ipcRenderer.invoke('library:uninstall', id, removeFromList)
}

contextBridge.exposeInMainWorld('essaim', api)
