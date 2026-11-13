#!/bin/sh
# Renders design/icon.svg to design/icon.png (1024 px, for the README) and design/icon-256.png
# (the plugin icon Orca shows). Needs Google Chrome; sips ships with macOS.
set -eu
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$PROFILE" \
  --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$PWD/icon.png" "file://$PWD/icon.svg" >/dev/null 2>&1

sips -z 256 256 icon.png --out icon-256.png >/dev/null
echo "icon.png and icon-256.png rendered"
