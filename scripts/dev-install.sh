#!/bin/bash
# Deploy a commit of this checkout as the Safari Harness in use.
#
#   scripts/dev-install.sh [COMMIT]    deploy COMMIT (default: HEAD)
#   scripts/dev-install.sh --rollback  go back to the release deployed before
#
# A deploy takes a commit, never the working tree: it copies the commit into
# ~/.local/share/safari-harness/releases/<sha>, builds its helpers there,
# and points ~/.local/share/safari-harness/current at it in one step. The
# CLI (~/.bun/bin/safari), omp's safari MCP server and extension, and the
# launchd jobs (the daemon and routines) all run from current, so edits in
# a checkout reach no one until they are committed and deployed. Then only
# what changed restarts:
#   - The daemon, when what it runs (daemon/codehash.ts) differs from what
#     the running daemon reports, or its launchd job runs something else.
#     It finishes its calls in flight first, and calls that arrive meanwhile
#     wait for the new daemon (rpc.ts). If the new daemon does not answer,
#     the previous release is put back.
#   - The app and extension, when extension/ or "Safari Harness/" differ
#     from the installed ones, or the extension is not connected. Safari
#     reloads the extension, which reconnects to the daemon. Safari gives
#     every tab a new id then; the extension tells the daemon each old id's
#     new one, so agents keep their tabs and the ids they hold still work.
# Agent sessions already running keep their MCP server process; before
# each call it loads the daemon's release's daemon/mcp-tools.ts if that
# differs from the code its calls run on, runs the call with it, and asks
# its client to list the tools again (daemon/fresh.ts). deploys.log records
# each deploy; the last releases stay for --rollback. One deploy runs at a
# time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$HOME/.local/share/safari-harness"
RELEASES="$DATA/releases"
CURRENT="$DATA/current"
APP="/Applications/Safari Harness.app"
APPEX="$APP/Contents/PlugIns/Safari Harness Extension.appex"
LOCK=/private/var/tmp/safari-harness-install.lock
BASE="${SAFARI_HARNESS_HTTP:-http://127.0.0.1:37334}"
JOBS="$HOME/Library/LaunchAgents"
DAEMON=at.aktan.safari-harness.daemon
MCP="$HOME/.omp/agent/mcp.json"
EXTENSIONS="$HOME/.omp/agent/extensions"
# releases kept besides the current one, however old
KEEP=5
PATH="$PATH:/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support"

case "${1:-}" in
  --rollback) what=rollback ;;
  -*) echo "usage: $0 [COMMIT | --rollback]" >&2; exit 2 ;;
  *) what=deploy ;;
esac

# health FIELD: that field of the daemon's /health, or "" when it does not answer
health() { curl -s --max-time 2 "$BASE/health" | jq -r "$1 // empty" 2>/dev/null || true; }
# trash PATH: moves it to the Trash under a name of its own
trash() { mv "$1" "$HOME/.Trash/safari-harness-$(basename "$1")-$(date +%s)"; }
# job LABEL: the program its launchd job runs
job() { plutil -extract ProgramArguments.1 raw "$JOBS/$1.plist" 2>/dev/null || true; }

# point RELEASE: current becomes it in one step (a rename over the link);
# when each release was last current orders them for pruning
point() {
  ln -sfn "releases/$1" "$DATA/.current.new"
  bun -e 'require("node:fs").renameSync(process.argv.at(-2), process.argv.at(-1))' "$DATA/.current.new" "$CURRENT"
  [ -z "$before" ] || touch "$DATA/$before"
  touch "$RELEASES/$1"
}

# helpers DIR: the release's helpers (each scripts/X.swift built to
# scripts/X), copied from the current release when all their sources are
# the same, else built by the release's own `bun run helpers`
helpers() {
  local src same=true
  for src in "$1"/scripts/*.swift; do
    cmp -s "$src" "$CURRENT/scripts/${src##*/}" && [ -x "$CURRENT/scripts/$(basename "$src" .swift)" ] || same=false
  done
  if $same; then
    for src in "$1"/scripts/*.swift; do cp -p "$CURRENT/scripts/$(basename "$src" .swift)" "${src%.swift}"; done
  elif ! (cd "$1" && bun run helpers) >"$1/.helpers.log" 2>&1; then
    tail -n 20 "$1/.helpers.log"
    echo "the helpers did not build" >&2
    exit 1
  fi
  for src in "$1"/scripts/*.swift; do
    [ -x "${src%.swift}" ] || echo "warning: scripts/$(basename "$src" .swift) was not built; add it to package.json's helpers" >&2
  done
}

# restart WHY: stops the daemon once its calls in flight finish and starts
# the current release's; a new daemon that does not answer puts the
# previous release back
restart() {
  local old pid busy i
  old="$(health .pid)"
  if [ -n "$old" ] && [ "$(job "$DAEMON")" = "$CURRENT/daemon/main.ts" ]; then
    busy="$(curl -s --max-time 5 -X POST -H 'content-type: application/json' -d "$(jq -cn --arg r "$what $sha: $1" '{reason: $r}')" "$BASE/shutdown" | jq -r '.inFlight // 0' 2>/dev/null || true)"
    [ "${busy:-0}" = 0 ] || echo "daemon: finishing $busy call(s) in flight first"
  else
    # a new launchd job: launchd stops the old daemon with SIGTERM, which
    # also lets its calls in flight finish (main.ts)
    bun "$CURRENT/cli/safari.ts" daemon install >/dev/null
  fi
  # up to a minute of calls in flight, then the start
  for i in $(seq 1 180); do
    pid="$(health .pid)"
    if [ -n "$pid" ] && [ "$pid" != "$old" ] && [ "$(health .code)" = "$want" ]; then
      echo "daemon: restarted ($1)"
      for i in $(seq 1 60); do [ -n "$(health .extension.connectedAt)" ] && return; sleep 0.5; done
      echo "daemon: its extension has not connected after 30 s (is Safari running?)"
      return
    fi
    sleep 0.5
  done
  echo "daemon: no daemon of release $sha answered within 90 s; see ~/Library/Logs/safari-harness/daemon.log" >&2
  if [ -n "$before" ] && [ "$before" != "releases/$sha" ]; then
    local back="${before#releases/}"
    before="releases/$sha"
    point "$back"
    launchctl kickstart -k "gui/$(id -u)/$DAEMON" >/dev/null 2>&1 || true
    echo "put back release $back" >&2
  fi
  exit 1
}

until mkdir "$LOCK" 2>/dev/null; do sleep 1; done
tmp=""
trap '[ -z "$tmp" ] || trash "$tmp"; rmdir "$LOCK"' EXIT
mkdir -p "$RELEASES"
before="$(readlink "$CURRENT" 2>/dev/null || true)"

# A commit from before deploys by release has no daemon/codehash.ts: its
# daemon cannot say what it runs, so none is deployed or rolled back to.
if [ "$what" = rollback ]; then
  sha="$(tail -n 1 "$DATA/deploys.log" 2>/dev/null | cut -d' ' -f3)"
  [ -n "$sha" ] && [ -f "$RELEASES/$sha/daemon/codehash.ts" ] || { echo "no earlier release deployed by this script is recorded in $DATA/deploys.log" >&2; exit 1; }
else
  full="$(git -C "$ROOT" rev-parse --verify --quiet "${1:-HEAD}^{commit}")" || { echo "not a commit: ${1:-HEAD}" >&2; exit 2; }
  sha="$(git -C "$ROOT" rev-parse --short=7 "$full")"
  git -C "$ROOT" cat-file -e "$full:daemon/codehash.ts" 2>/dev/null || { echo "$sha predates deploys by release; deploy a later commit" >&2; exit 1; }
  left="$(git -C "$ROOT" status --porcelain -- daemon cli extension "Safari Harness" scripts passwords-bridge docs omp package.json | wc -l | tr -d ' ')"
  [ "$left" = 0 ] || echo "note: $left uncommitted change(s) in the checkout are not deployed"
  if [ ! -d "$RELEASES/$sha" ]; then
    tmp="$(mktemp -d "$RELEASES/.new.XXXXXX")"
    git -C "$ROOT" archive "$full" | tar -x -C "$tmp"
    for f in "$tmp"/extension/*.js; do node --check "$f"; done
    # what the app and extension are built from, as git names it
    git -C "$ROOT" rev-parse "$full:extension" "$full:Safari Harness" | shasum -a 256 | cut -c1-16 >"$tmp/.extension"
    helpers "$tmp"
    mv "$tmp" "$RELEASES/$sha"
    tmp=""
  fi
fi
REL="$RELEASES/$sha"

# The app is built before anything changes, so a failed build changes nothing.
key="$(cat "$REL/.extension")"
app=""
if [ "$key" != "$(cat "$DATA/installed-extension" 2>/dev/null || true)" ] || [ -z "$(health .extension.connectedAt)" ]; then
  app="$DATA/apps/$key.zip"
  if [ ! -f "$app" ]; then
    tmp="$(mktemp -d /private/var/tmp/sh-build.XXXXXX)"
    if ! (cd "$REL/Safari Harness" && xcodebuild -scheme "Safari Harness" -configuration Debug -derivedDataPath "$tmp" -allowProvisioningUpdates build) >"$tmp/build.log" 2>&1; then
      grep -E "error:" "$tmp/build.log" | head -20
      echo "the app did not build" >&2
      exit 1
    fi
    built="$tmp/Build/Products/Debug/Safari Harness.app"
    # Xcode registers what it builds, and Safari must find one copy only
    pluginkit -r "$built/Contents/PlugIns/Safari Harness Extension.appex" 2>/dev/null || true
    lsregister -u "$built" 2>/dev/null || true
    # kept as a zip (which Safari never finds) for a rollback to install
    mkdir -p "$DATA/apps"
    ditto -c -k --keepParent "$built" "$app.part"
    mv "$app.part" "$app"
    trash "$tmp"
    tmp=""
  fi
fi

point "$sha"
echo "current: release $sha"
[ "$(readlink "$HOME/.bun/bin/safari" || true)" = "$CURRENT/cli/safari.ts" ] || ln -sfn "$CURRENT/cli/safari.ts" "$HOME/.bun/bin/safari"
[ "$(jq -r '.mcpServers.safari.args[0] // empty' "$MCP" 2>/dev/null || true)" = "$CURRENT/daemon/mcp.ts" ] ||
  echo "note: omp's safari MCP server does not run the deployed release; in $MCP set mcpServers.safari.args to [\"$CURRENT/daemon/mcp.ts\"]"
# omp tells the daemon as each turn ends, which closes the tabs of the turn
# (omp/index.ts); a session loads it as it starts
[ ! -d "$EXTENSIONS" ] || [ "$(readlink "$EXTENSIONS/safari-harness" || true)" = "$CURRENT/omp" ] || ln -sfn "$CURRENT/omp" "$EXTENSIONS/safari-harness"
for plist in "$JOBS"/at.aktan.safari-harness.routine.*.plist; do
  [ -f "$plist" ] || continue
  label="$(basename "$plist" .plist)"
  [ "$(job "$label")" = "$CURRENT/cli/safari.ts" ] && continue
  plutil -replace ProgramArguments.1 -string "$CURRENT/cli/safari.ts" "$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "routine ${label##*.}: now runs the deployed release"
done

want="$(bun "$REL/daemon/codehash.ts")"
ran="$(job "$DAEMON")"
if [ "$ran" != "$CURRENT/daemon/main.ts" ]; then
  restart "its launchd job ran ${ran:-nothing}"
elif [ "$(health .ok)" != true ]; then
  restart "it was not running"
elif [ "$(health .code)" != "$want" ]; then
  restart "its code changed"
else
  echo "daemon: unchanged"
fi

if [ -n "$app" ]; then
  was="$(health .extension.connectedAt)"
  tmp="$(mktemp -d /private/var/tmp/sh-app.XXXXXX)"
  ditto -x -k "$app" "$tmp"
  rsync -a --delete "$tmp/Safari Harness.app/" "$APP/"
  trash "$tmp"
  tmp=""
  codesign --verify --deep "$APP"
  lsregister -f "$APP"
  pluginkit -a "$APPEX"
  echo "$key" >"$DATA/installed-extension"
  # Safari reloads the extension, which connects again
  now=""
  for i in $(seq 1 60); do
    now="$(health .extension.connectedAt)"
    if [ -n "$now" ] && [ "$now" != "$was" ]; then echo "extension: installed; it reconnected after $((i / 2)) s"; break; fi
    [ "$i" = 30 ] && pluginkit -a "$APPEX"
    sleep 0.5
  done
  [ -n "$now" ] && [ "$now" != "$was" ] || { echo "extension: installed, but it has not reconnected after 30 s (is Safari running?)" >&2; exit 1; }
else
  echo "extension: unchanged"
fi

[ "$before" = "releases/$sha" ] || echo "$(date -u +%FT%TZ) $sha ${before#releases/} $what" >>"$DATA/deploys.log"

# Kept: the current release, the newest KEEP others, any current in the
# last week (an agent session's MCP server may still run it), and the one
# the daemon runs. App zips no kept release is built from go too.
running="$(health .root)"
n=0
for r in $(ls -t "$RELEASES"); do
  n=$((n + 1))
  if [ "$n" -gt $((KEEP + 1)) ] && [ "$RELEASES/$r" != "$running" ] && [ -z "$(find "$RELEASES/$r" -maxdepth 0 -mtime -7)" ]; then trash "$RELEASES/$r"; fi
done
for zip in "$DATA"/apps/*.zip; do
  [ -f "$zip" ] || continue
  grep -qxs "$(basename "$zip" .zip)" "$RELEASES"/*/.extension || trash "$zip"
done
