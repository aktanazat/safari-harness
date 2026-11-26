#!/bin/zsh
# Installs the Ladybird fork (branch harness of ~/Developer/ladybird) as
# /Applications/Ladybird Harness.app: the user's own Ladybird, which the bridge
# may attach to (bridge.ts --browser attach). Its Info.plist sets
# LADYBIRD_ALLOW_WEBDRIVER_ATTACH=1, so a start from the Dock, Finder or a link
# another app opens lets WebDriver attach; once it runs, any program running as
# the user can drive it.
#
# With --bridge, the app also starts the harness bridge whenever it starts
# (LADYBIRD_ATTACH_HELPER): a launchd job of the user's runs bridge.ts
# --browser attach against the daemon on DAEMON_PORT, which launchd starts
# again if it crashes, and not once it ends with the browser.
#
# With --test DIR it installs a copy for tests instead: DIR/Ladybird Harness
# Test.app, bundle org.ladybird.Ladybird.HarnessTest, which a test may start,
# quit and replace while the user's own Ladybird Harness runs.
#
#   ladybird/install-app.sh [--bridge DAEMON_PORT [--state DIR] [--profile-path DIR]] [--test DIR] [path to the built Ladybird.app]
set -euo pipefail
zparseopts -D -E -F -- -bridge:=bridge_opt -state:=state_opt -profile-path:=profile_opt -test:=test_opt
src=${1:-$HOME/Developer/ladybird/Build/release/bin/Ladybird.app}
if (( ${#test_opt} )); then
  dst="${test_opt[2]}/Ladybird Harness Test.app" bundle=org.ladybird.Ladybird.HarnessTest name="Ladybird Harness Test"
else
  dst="/Applications/Ladybird Harness.app" bundle=org.ladybird.Ladybird.Harness name="Ladybird Harness"
fi
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

helper=""
if (( ${#bridge_opt} )); then
  port=${bridge_opt[2]}
  state=${state_opt[2]:-$HOME/.local/share/safari-harness/ladybird}
  label="dev.aktan.safari-harness.ladybird-bridge-$port"
  job="$HOME/Library/LaunchAgents/$label.plist"
  helper="$HOME/.local/share/safari-harness/ladybird-attach-$port.sh"
  bun=$(command -v bun)
  mkdir -p "$state" "${helper:h}" "${job:h}"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$job"
  /usr/libexec/PlistBuddy \
    -c "Add :Label string $label" \
    -c "Add :ProgramArguments array" \
    -c "Add :ProgramArguments:0 string $bun" \
    -c "Add :ProgramArguments:1 string ${0:a:h}/bridge.ts" \
    -c "Add :ProgramArguments:2 string --browser" \
    -c "Add :ProgramArguments:3 string attach" \
    -c "Add :ProgramArguments:4 string --daemon-port" \
    -c "Add :ProgramArguments:5 string $port" \
    -c "Add :ProgramArguments:6 string --state" \
    -c "Add :ProgramArguments:7 string $state" \
    -c "Add :KeepAlive dict" \
    -c "Add :KeepAlive:SuccessfulExit bool false" \
    -c "Add :StandardOutPath string $state/bridge.log" \
    -c "Add :StandardErrorPath string $state/bridge.log" \
    "$job"
  # A profile other than the default one, as the browser was given it.
  (( ${#profile_opt} )) && /usr/libexec/PlistBuddy -c "Add :ProgramArguments:8 string --profile-path" -c "Add :ProgramArguments:9 string ${profile_opt[2]}" "$job"
  launchctl bootstrap "gui/$(id -u)" "$job"
  print -r -- "#!/bin/sh
# Started by Ladybird Harness as it starts (LADYBIRD_ATTACH_HELPER): runs its bridge's launchd job.
exec launchctl kickstart gui/\$(id -u)/$label" > "$helper"
  chmod +x "$helper"
fi

rsync -a --delete "$src/" "$dst/"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleIdentifier $bundle" \
  -c "Set :CFBundleName $name" \
  "$plist"
/usr/libexec/PlistBuddy -c "Delete :LSEnvironment" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSEnvironment dict" -c "Add :LSEnvironment:LADYBIRD_ALLOW_WEBDRIVER_ATTACH string 1" "$plist"
[[ -n $helper ]] && /usr/libexec/PlistBuddy -c "Add :LSEnvironment:LADYBIRD_ATTACH_HELPER string $helper" "$plist"
codesign --force --deep --preserve-metadata=entitlements --sign - "$dst"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dst"
echo "installed $dst ($(git -C "${src%/Build/*}" rev-parse --short HEAD 2>/dev/null || echo unknown))${helper:+, starting the bridge for the daemon on $port}"
