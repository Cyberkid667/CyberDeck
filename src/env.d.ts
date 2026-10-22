declare module '*?asset' {
  const path: string
  export default path
}

declare module '*.css'
declare module 'webtorrent'
declare module 'parse-torrent'

interface Window {
  essaim: import('./shared/types').EssaimApi
}
