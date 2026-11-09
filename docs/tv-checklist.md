# On-TV verification checklist

Things that can only be confirmed on a real Samsung TV, not in the browser preview.

1. Run `python3 tools/logserver.py 8799` in the background, then
   `NOVA_LOG_URL=http://<computer-ip>:8799 NOVA_DEV_AUTOPLAY=https://media.w3.org/2010/05/sintel/trailer.mp4 tools/deploy.sh <tv-ip>`.
   The log should show `engine-avplay` and `playback started avplay`. Check `perf scripts evaluated by` and `first rows`
   (last measured: 375 ms / 534 ms).
2. Home: watch for stutter while tiles expand (FLIP slide + clip reveal) and while moving between rows.
3. Hold OK on a tile → rating popover. This depends on the remote auto-repeating OK while held. A short OK must still
   open details.
4. Trailer previews start inside the tile/billboard and stay inside its rounded frame, with sound after a key press, or
   muted as a fallback.
5. Detail page → **Trailer** plays full screen: OK pauses, ◀ ▶ skip 10 s, Back returns to the button.
6. CH ▲/▼ adjusts the subtitle delay; check it on built-in subtitles (AVPlay `setSubtitlePosition`).
7. Trailer log lines: `trailer: loading / handshake ok / playing / youtube error <code> / gave up`. Error 153 or
   "no answer from player" means the relay page isn't being used.
8. Preload: rest on a Continue Watching card (log `preload: … at Ns`), then press OK. The log should show
   `playback: using preloaded stream`. The AVPlay preload must never collide with a trailer.
9. Streaming server: with Stremio open on a computer on the same network, the log shows `discover: own ip …` and
   the server is found within a few seconds of start.
10. Search: results appear while typing, even with a slow or broken search addon installed.
11. Finish with a plain `tools/deploy.sh <tv-ip>` (no log mirror) for a clean build.

## Troubleshooting

- `sdb` says "failed to connect" while port 26101 is open: `sdb kill-server`, then reconnect.
- Every deploy raises the app version automatically: reinstalling the same version wipes the app's data (and the
  sign-in).
