#!/bin/bash
# Build the Safari app and extension from this checkout, install it over
# /Applications/Safari Harness.app, restart the daemon, and wait until the
# extension reconnects. One install runs at a time (a lock directory), and
# the build copy is unregistered and removed so Safari never loads two copies.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="/Applications/Safari Harness.app"
APPEX="$APP/Contents/PlugIns/Safari Harness Extension.appex"
LS=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
LOCK=/private/var/tmp/safari-harness-install.lock
HEALTH="${SAFARI_HARNESS_HTTP:-http://127.0.0.1:37334}/health"

for f in "$ROOT"/extension/*.js; do node --check "$f"; done

until mkdir "$LOCK" 2>/dev/null; do sleep 1; done
DD="$(mktemp -d /private/var/tmp/sh-build.XXXXXX)"
trap 'rm -rf "$DD"; rmdir "$LOCK"' EXIT

cd "$ROOT/Safari Harness"
if ! xcodebuild -scheme "Safari Harness" -configuration Debug -derivedDataPath "$DD" -allowProvisioningUpdates build >"$DD/build.log" 2>&1; then
  grep -E "error:" "$DD/build.log" | head -20
  echo "build failed" >&2
  exit 1
fi
B="$DD/Build/Products/Debug/Safari Harness.app"
pluginkit -r "$B/Contents/PlugIns/Safari Harness Extension.appex" 2>/dev/null || true
"$LS" -u "$B" 2>/dev/null || true
rsync -a --delete "$B/" "$APP/"
codesign --verify --deep "$APP"
"$LS" -f "$APP"
pluginkit -a "$APPEX"
launchctl kickstart -k "gui/$(id -u)/at.aktan.safari-harness.daemon"
for i in $(seq 1 60); do
  if curl -s "$HEALTH" | grep -q '"extension":{'; then echo "installed; extension connected after $((i / 2)) s"; exit 0; fi
  [ "$i" = 30 ] && pluginkit -a "$APPEX"
  sleep 0.5
done
echo "installed, but the extension has not reconnected after 30 s" >&2
exit 1
