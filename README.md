# Nova

A TV-first client for [Stremio](https://www.stremio.com) on Samsung Tizen TVs (built and tuned on
the Samsung Frame). Sign in with your Stremio account and Nova uses your addons, library and watch
progress, with a big-screen interface made for the remote.

- Home rows with on-device recommendations, autoplaying trailer previews and a full-screen trailer
  button on every title.
- Source picking tuned for the TV's decoders (codecs, HDR, audio language, debrid, release-group
  continuity across episodes), with automatic fallback if a source fails.
- Resume, next-episode countdown with preloading, subtitles from the file or OpenSubtitles.
- Progress syncs back to your Stremio account, so the other Stremio apps stay in step.
- Torrent sources through the Stremio desktop app on your network, found automatically.

> Nova is an unofficial, independent project. It is not affiliated with or endorsed by Stremio or
> Samsung. It hosts no content: everything it plays comes from the addons you install in your own
> Stremio account. You are responsible for what you watch and for following the laws where you live.

## Install on your TV

Nova isn't in the Samsung store; you install it in developer mode.

**You need:** a Samsung Tizen TV (Tizen 6 / 2021 or newer), a computer on the same network,
[Tizen Studio](https://developer.tizen.org/development/tizen-studio/download) with the TV extensions
and its CLI, and a Samsung certificate profile created in Tizen Studio's Certificate Manager.

1. **Enable developer mode on the TV:** Apps → type `12345` on the remote → turn Developer mode on
   and enter your computer's IP address → restart the TV.
2. **Build, sign, install and launch:**

   ```bash
   tools/deploy.sh <tv-ip>
   ```

   The script expects Tizen Studio in `~/tizen-studio` and a certificate profile named `stremiotv`.
   Use another profile with `NOVA_SIGN_PROFILE=<name>`. `NOVA_TV_IP` can replace the argument.
3. **Sign in:** Nova shows a QR code and a link code. Confirm it on your phone and your library and
   addons appear.

Each deploy raises the app version automatically: reinstalling the same version would wipe the
app's data, including the sign-in.

## Torrent sources (streaming server)

Debrid and direct links play straight away. Torrent sources need the streaming server that comes
with the Stremio desktop app (port 11470): open Stremio on a computer on the same network and leave
it running.

You don't need to know that computer's IP address. A few seconds after start Nova reads the TV's own
address and searches that network for Stremio. When it finds it, torrents are switched on, and if
the computer gets a new address later, Nova finds it again. **Settings → Streaming server → Find
automatically** runs the same search by hand.

## Trailers

YouTube refuses embeds from apps that run from local files (error 153). Nova therefore embeds a tiny
relay page served from a real web origin, which embeds YouTube and passes the player's messages
through. The page lives in [`trailer-relay/`](trailer-relay) (a git submodule) and is hosted on
GitHub Pages. To host your own copy, publish that folder anywhere and set `trailerRelay` in
[`nova-tv/js/config.js`](nova-tv/js/config.js). An empty value turns trailers off on the TV.

## Development

```bash
python3 tools/devserver.py 8766 nova-tv    # browser preview at http://localhost:8766
NOVA_BUILD_ONLY=1 tools/deploy.sh          # build/app + build/Nova.wgt, no TV needed
```

In the preview, the arrow keys and Enter act as the remote, Esc is Back. The dev server only
listens on localhost; `NOVA_DEV_HOST=0.0.0.0` opens it to the network.

There is no build step during development and no dependencies: `nova-tv/` is plain ES5-era
JavaScript loaded in `index.html` order. `tools/deploy.sh` concatenates and minifies it with
[esbuild](https://esbuild.github.io) (fetched with `npx`) into one `js/app.js`, plus `js/worker.js`
and `js/lite.js` for catalog parsing off the UI thread.

**Debugging on the TV:** run `python3 tools/logserver.py 8799`, then deploy with
`NOVA_LOG_URL=http://<computer-ip>:8799 tools/deploy.sh <tv-ip>`. The TV's console, uncaught errors
and every main-thread task over 50 ms are printed on your computer. Never ship a build with
`NOVA_LOG_URL` set. [`docs/tv-checklist.md`](docs/tv-checklist.md) lists what to check on a real TV.

### Layout

| Path | What |
|---|---|
| `nova-tv/js/nav.js` | Remote-control focus engine (rows, anchoring, key repeat, layers) |
| `nova-tv/js/api.js` | Stremio account API: link-code sign-in, addons, library |
| `nova-tv/js/addons.js` | Addon catalogs, metadata, streams, subtitles, search |
| `nova-tv/js/recs.js` | On-device recommendations |
| `nova-tv/js/streams.js` | Source ranking (TV codec rules, debrid, release-group continuity) |
| `nova-tv/js/player.js` | AVPlay / HTML5 player, fallback, next-episode preload, subtitles |
| `nova-tv/js/library.js` | Progress sync with Stremio (incremental via `datastoreMeta`) |
| `nova-tv/js/discover.js` | Finds the Stremio streaming server on the local network |
| `nova-tv/js/trailer.js` | Trailer previews and the full-screen trailer player |
| `nova-tv/js/worker.js`, `lite.js` | Catalog fetch, parse and slimming off the UI thread |
| `tools/` | Deploy script, dev server, TV log receiver |
| `trailer-relay/` | YouTube relay page (submodule, GitHub Pages) |

## Security

See [SECURITY.md](SECURITY.md) to report a problem privately.

## License

[MIT](LICENSE)
