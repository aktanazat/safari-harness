#!/bin/zsh
# Installs the Ladybird fork (branch harness of ~/Developer/ladybird) as
# /Applications/Ladybird Harness.app: the user's own Ladybird, which the bridge
# may attach to (bridge.ts --browser attach). Its Info.plist sets
# LADYBIRD_ALLOW_WEBDRIVER_ATTACH=1, so a start from the Dock, Finder or a link
# another app opens lets WebDriver attach; once it runs, any program running as
# the user can drive it.
#
#   ladybird/install-app.sh [path to the built Ladybird.app]
set -euo pipefail
src=${1:-$HOME/Developer/ladybird/Build/release/bin/Ladybird.app}
dst="/Applications/Ladybird Harness.app"
plist="$dst/Contents/Info.plist"

[[ -d $src ]] || { echo "no Ladybird build at $src" >&2; exit 1; }
# A build with Ladybird's updater would replace the fork with a stock release.
if /usr/libexec/PlistBuddy -c "Print :SUFeedURL" "$src/Contents/Info.plist" >/dev/null 2>&1; then
  echo "$src updates itself from Ladybird's feed: configure with -DLADYBIRD_ENABLE_UPDATE_CHECK=OFF and rebuild" >&2
  exit 1
fi
if pgrep -f "^$dst/Contents/MacOS/" >/dev/null; then
  echo "Ladybird Harness is running: quit it first" >&2
  exit 1
fi

rsync -a --delete "$src/" "$dst/"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleIdentifier org.ladybird.Ladybird.Harness" \
  -c "Set :CFBundleName Ladybird Harness" \
  "$plist"
/usr/libexec/PlistBuddy -c "Delete :LSEnvironment" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSEnvironment dict" -c "Add :LSEnvironment:LADYBIRD_ALLOW_WEBDRIVER_ATTACH string 1" "$plist"
codesign --force --deep --preserve-metadata=entitlements --sign - "$dst"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dst"
echo "installed $dst ($(git -C "${src%/Build/*}" rev-parse --short HEAD 2>/dev/null || echo unknown))"
