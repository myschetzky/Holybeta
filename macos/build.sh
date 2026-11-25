#!/usr/bin/env bash
# Bygger "HolyMoly Filter.app" med netværksfilteret (macOS-systemudvidelse).
#
# Kun tjek af at koden bygger (ad hoc-signeret, kan IKKE køre på elevernes Macs):
#   macos/build.sh
#
# Rigtig, signeret version (kræver Apple Developer-konto – se macos/README.md):
#   TEAM_ID=ABCDE12345 \
#   SIGN_ID="Developer ID Application: Din Skole (ABCDE12345)" \
#   APP_PROFILE=~/profiles/HolyMoly_Filter.provisionprofile \
#   EXT_PROFILE=~/profiles/HolyMoly_Filter_Extension.provisionprofile \
#   macos/build.sh
set -euo pipefail
cd "$(dirname "$0")"

TEAM_ID="${TEAM_ID:-XXXXXXXXXX}"
SIGN_ID="${SIGN_ID:--}"
VERSION="${VERSION:-$(node -p "require('../agent/package.json').version" 2>/dev/null || echo 1.0.0)}"
BUILD="${BUILD:-$(date +%Y%m%d%H%M)}"
MIN_OS="12.0"
EXT_ID="dk.holymoly.filterapp.extension"

OUT="dist"
APP="$OUT/HolyMoly Filter.app"
EXT="$APP/Contents/Library/SystemExtensions/$EXT_ID.systemextension"
TMP="build"

rm -rf "$OUT" "$TMP"
mkdir -p "$TMP" "$APP/Contents/MacOS" "$EXT/Contents/MacOS"

echo "▶ Kompilerer (arm64 + x86_64)…"
for arch in arm64 x86_64; do
  swiftc -O -whole-module-optimization -module-name HolyMolyFilter \
    -target "$arch-apple-macos$MIN_OS" Extension/*.swift -o "$TMP/ext-$arch"
  swiftc -O -module-name HolyMolyFilterApp \
    -target "$arch-apple-macos$MIN_OS" FilterApp/*.swift -o "$TMP/app-$arch"
done
lipo -create "$TMP/ext-arm64" "$TMP/ext-x86_64" -output "$EXT/Contents/MacOS/$EXT_ID"
lipo -create "$TMP/app-arm64" "$TMP/app-x86_64" -output "$APP/Contents/MacOS/HolyMoly Filter"

fill() { sed -e "s/__TEAM_ID__/$TEAM_ID/g" -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD/g" "$1" > "$2"; }
fill Extension/Info.plist "$EXT/Contents/Info.plist"
fill FilterApp/Info.plist "$APP/Contents/Info.plist"
fill Extension/Extension.entitlements "$TMP/ext.entitlements"
fill FilterApp/FilterApp.entitlements "$TMP/app.entitlements"
plutil -lint "$EXT/Contents/Info.plist" "$APP/Contents/Info.plist" "$TMP/ext.entitlements" "$TMP/app.entitlements"

if [ -n "${EXT_PROFILE:-}" ]; then cp "$EXT_PROFILE" "$EXT/Contents/embedded.provisionprofile"; fi
if [ -n "${APP_PROFILE:-}" ]; then cp "$APP_PROFILE" "$APP/Contents/embedded.provisionprofile"; fi

echo "▶ Signerer (${SIGN_ID})…"
TS="--timestamp"
[ "$SIGN_ID" = "-" ] && TS="--timestamp=none"
# Indefra og ud: først udvidelsen, så appen
codesign --force --options runtime $TS --entitlements "$TMP/ext.entitlements" --sign "$SIGN_ID" "$EXT"
codesign --force --options runtime $TS --entitlements "$TMP/app.entitlements" --sign "$SIGN_ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

rm -rf "$TMP"
echo "✓ $APP"
[ "$SIGN_ID" = "-" ] && echo "  (ad hoc-signeret – kan kun bruges til at tjekke at koden bygger)"
exit 0
