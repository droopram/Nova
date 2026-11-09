/* Build-time defaults. Everything here can be changed in Settings. */
window.NOVA_CONFIG = {
  // Stremio streaming server (needed for torrent sources), e.g. 'http://192.168.1.20:11470'.
  // Leave empty: the app finds Stremio on the local network by itself (js/discover.js).
  defaultServer: '',
  // Dev only: when set, console warnings/errors are mirrored to this URL (tools/logserver.py).
  logUrl: '',
  // Trailer previews on the TV: URL of trailer-relay/index.html hosted on a web origin
  // (e.g. GitHub Pages). Empty = previews off on the TV (they work in a desktop browser).
  trailerRelay: 'https://droopram.github.io/trailer-relay/',
  devAutoplay: ''
};
