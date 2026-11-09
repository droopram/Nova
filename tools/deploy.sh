#!/bin/bash
# Build, sign and install Nova on the Samsung TV, then launch it.
# Usage: tools/deploy.sh <tv-ip>        (or set NOVA_TV_IP; not needed with NOVA_BUILD_ONLY=1)
set -euo pipefail

TV_IP="${1:-${NOVA_TV_IP:-}}"
if [ -z "$TV_IP" ] && [ -z "${NOVA_BUILD_ONLY:-}" ]; then
  echo "Usage: tools/deploy.sh <tv-ip>   (or NOVA_TV_IP=<tv-ip>, or NOVA_BUILD_ONLY=1)"; exit 1
fi
TARGET="$TV_IP:26101"
APP_ID="NovaStrmTV.nova"
PROFILE="${NOVA_SIGN_PROFILE:-stremiotv}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/nova-tv"
BUILD="$ROOT/build"

export JAVA_HOME="$HOME/tizen-studio/jdk/Contents/Home"
export PATH="$HOME/tizen-studio/tools/ide/bin:$HOME/tizen-studio/tools:$PATH"

rm -rf "$BUILD" && mkdir -p "$BUILD/app/js" "$BUILD/app/css" "$BUILD/src"
cp "$SRC/js/config.js" "$BUILD/src/config.js"
# NOVA_LOG_URL=http://<mac-ip>:8799 mirrors the TV's console to tools/logserver.py.
if [ -n "${NOVA_LOG_URL:-}" ]; then
  sed -i '' "s#logUrl: ''#logUrl: '$NOVA_LOG_URL'#" "$BUILD/src/config.js"
fi
if [ -n "${NOVA_DEV_AUTOPLAY:-}" ]; then
  sed -i '' "s#devAutoplay: ''#devAutoplay: '$NOVA_DEV_AUTOPLAY'#" "$BUILD/src/config.js"
fi

echo "==> Bundling + minifying"
# One script in index.html order (config.js swapped for the build copy), one stylesheet.
SCRIPTS=$(grep -o 'src="js/[^"]*"' "$SRC/index.html" | sed 's/src="//;s/"$//')
: > "$BUILD/src/app.js"
for f in $SCRIPTS; do
  if [ "$f" = "js/config.js" ]; then cat "$BUILD/src/config.js"; else cat "$SRC/$f"; fi >> "$BUILD/src/app.js"
  printf '\n;\n' >> "$BUILD/src/app.js"
done
ESB="npx --yes esbuild@0.24.0"
# NOVA_NO_MINIFY=1 keeps the bundle readable so TV error reports point at real lines.
MINIFY="--minify"; [ -n "${NOVA_NO_MINIFY:-}" ] && MINIFY=""
$ESB "$BUILD/src/app.js" $MINIFY --target=chrome85 --outfile="$BUILD/app/js/app.js" --log-level=warning
$ESB "$SRC/js/worker.js" --minify --target=chrome85 --outfile="$BUILD/app/js/worker.js" --log-level=warning
$ESB "$SRC/js/lite.js" --minify --target=chrome85 --outfile="$BUILD/app/js/lite.js" --log-level=warning
$ESB "$SRC/css/app.css" --minify --target=chrome85 --outfile="$BUILD/app/css/app.css" --log-level=warning
# index.html: drop the individual script tags, load the bundle.
python3 - "$SRC/index.html" "$BUILD/app/index.html" <<'PY'
import re, sys
html = open(sys.argv[1]).read()
html = re.sub(r'\s*<script src="js/[^"]+"></script>', '', html)
html = html.replace('</body>', '  <script src="js/app.js"></script>\n</body>')
open(sys.argv[2], 'w').write(html)
PY
cp "$SRC/icon.png" "$BUILD/app/"
# Every install must carry a higher version: reinstalling the same version wipes app data
# (and with it the sign-in). Tizen allows major/minor <= 255 and micro <= 65535, so use
# (year-2024).month.minute-of-month — strictly increasing, never wraps.
VERSION="$(( $(date +%Y) - 2024 )).$(( 10#$(date +%m) )).$(( (10#$(date +%d) - 1) * 1440 + 10#$(date +%H) * 60 + 10#$(date +%M) ))"
sed -E "s/(<widget[^>]* version=\")[0-9.]+\"/\1$VERSION\"/" "$SRC/config.xml" > "$BUILD/app/config.xml"
echo "    version $VERSION"
echo "    js $(wc -c < "$BUILD/app/js/app.js" | tr -d ' ') B (from $(wc -c < "$BUILD/src/app.js" | tr -d ' ') B), css $(wc -c < "$BUILD/app/css/app.css" | tr -d ' ') B"

echo "==> Packaging"
tizen package -t wgt -s "$PROFILE" -o "$BUILD" -- "$BUILD/app" | tail -2
WGT="$(ls "$BUILD"/*.wgt | head -1)"
echo "    package $(wc -c < "$WGT" | tr -d ' ') B"
[ -n "${NOVA_BUILD_ONLY:-}" ] && exit 0

echo "==> Connecting to $TARGET"
sdb connect "$TARGET" >/dev/null
sdb devices | grep -q "$TV_IP" || { echo "TV not reachable — is Developer Mode on with this Mac's IP?"; exit 1; }

echo "==> Installing $(basename "$WGT")"
tizen install -n "$WGT" -s "$TARGET" | grep -E "install completed|successfully|error|fail" || true

echo "==> Launching"
sdb -s "$TARGET" shell 0 was_execute "$APP_ID" | tail -1
