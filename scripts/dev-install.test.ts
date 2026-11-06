// Deploys must preserve the installed history before touching a release or native app.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
let checkout: string;
let home: string;
let data: string;
let releases: string;
let current: string;
let base: string;
let installed: string;
let descendant: string;
let sibling: string;
let env: NodeJS.ProcessEnv;
const checkpointAccepted = 73;

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-C", checkout, ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
function short(commit: string): string { return git("rev-parse", "--short=7", commit); }
function release(id: string, format = 2): string {
  const path = join(releases, id);
  mkdirSync(join(path, "daemon"), { recursive: true });
  writeFileSync(join(path, "daemon/codehash.ts"), "");
  writeFileSync(join(path, "package.json"), JSON.stringify({ safariHarnessCheckpointFormat: format }));
  return path;
}
function select(id: string, absolute = false): void {
  rmSync(current, { force: true });
  release(id);
  symlinkSync(absolute ? join(releases, id) : `releases/${id}`, current);
}
function running(path = ""): void {
  writeFileSync(join(home, "health.json"), JSON.stringify({ root: path, extension: { connectedAt: 1 } }));
}
function invoke(...targets: string[]) {
  return Bun.spawnSync(["/bin/bash", join(checkout, "scripts/dev-install.sh"), ...targets], { env, stdout: "pipe", stderr: "pipe" });
}
function expectRefused(target: string, message: string): void {
  const before = readlinkSync(current);
  const result = invoke(target);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(message);
  expect(readlinkSync(current)).toBe(before);
  expect(existsSync(join(data, ".current.new"))).toBe(false);
  expect(existsSync(join(home, "checkpoint-accepted"))).toBe(false);
}
function expectAccepted(...targets: string[]): void {
  const result = invoke(...targets);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(checkpointAccepted);
  expect(readFileSync(join(home, "checkpoint-accepted"), "utf8")).toBe("check\n");
  expect(existsSync(join(data, ".current.new"))).toBe(false);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safari-deploy-ancestry-"));
  checkout = join(root, "checkout");
  home = join(root, "home");
  data = join(home, ".local/share/safari-harness");
  releases = join(data, "releases");
  current = join(data, "current");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  mkdirSync(join(checkout, "daemon"));
  mkdirSync(releases, { recursive: true });
  copyFileSync(join(import.meta.dir, "dev-install.sh"), join(checkout, "scripts/dev-install.sh"));
  copyFileSync(join(import.meta.dir, "deploy-checkpoints.ts"), join(checkout, "scripts/deploy-checkpoints.ts"));
  writeFileSync(join(checkout, "daemon/codehash.ts"), "");
  const boundaries = join(root, "boundaries.sh");
  // Run the real installer and checkpoint reader, but never acquire the real
  // install lock, contact its daemon, or continue into native app installation.
  writeFileSync(boundaries, `
mkdir() {
  if [ "$#" = 1 ] && [ "$1" = /private/var/tmp/safari-harness-install.lock ]; then
    command mkdir "$HOME/install.lock"
  else
    command mkdir "$@"
  fi
}
rmdir() {
  if [ "$#" = 1 ] && [ "$1" = /private/var/tmp/safari-harness-install.lock ]; then
    command rmdir "$HOME/install.lock"
  else
    command rmdir "$@"
  fi
}
curl() {
  case "$*" in */shutdown*) if [ -n "\${DEPLOY_THROUGH:-}" ]; then
    command cp "$HOME/.local/share/safari-harness/deploying" "$HOME/deploying-seen" 2>/dev/null
    jq '.pid = 2 | .code = "new"' "$HOME/health.json" >"$HOME/health.next" && command mv "$HOME/health.next" "$HOME/health.json"
  fi ;; esac
  command cat "$HOME/health.json"
}
bun() {
  if [ "$1" = -e ]; then "$REAL_BUN" "$@"; return; fi
  if [ "$1" = "$CHECKPOINTS" ] && [ "$2" = check ]; then
    "$REAL_BUN" "$@" || return $?
    printf '%s\\n' check > "$HOME/checkpoint-accepted"
    [ -z "\${DEPLOY_THROUGH:-}" ] || return 0
    return ${checkpointAccepted}
  fi
  [ -n "\${DEPLOY_THROUGH:-}" ] || return 99
  case "$1" in
    "$CHECKPOINTS") [ "$2" != snapshot ] || echo "$HOME/checkpoint" ;;
    */daemon/codehash.ts) echo new ;;
    *) return 99 ;;
  esac
}
xcodebuild() { return 99; }
lsregister() { [ -n "\${DEPLOY_THROUGH:-}" ] || return 99; }
pluginkit() { return 99; }
launchctl() { return 99; }
rsync() { return 99; }
codesign() { return 99; }
ditto() { return 99; }
`);
  env = {
    ...process.env,
    HOME: home,
    BASH_ENV: boundaries,
    REAL_BUN: process.execPath,
    SAFARI_HARNESS_HTTP: "http://127.0.0.1:47334",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Installer test",
    GIT_AUTHOR_EMAIL: "installer@example.test",
    GIT_COMMITTER_NAME: "Installer test",
    GIT_COMMITTER_EMAIL: "installer@example.test",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  git("init", "--quiet", "--initial-branch=work");
  git("add", "daemon/codehash.ts");
  git("commit", "--quiet", "-m", "base");
  base = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "installed");
  installed = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "descendant");
  descendant = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "--detach", base);
  git("commit", "--quiet", "--allow-empty", "-m", "sibling");
  sibling = git("rev-parse", "HEAD");
  select(short(installed));
  running(join(releases, installed));
  for (const commit of [installed, descendant, sibling]) release(short(commit));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a descendant containing the selected and running releases reaches checkpoint admission", () => {
  expectAccepted(descendant);
  expect(readlinkSync(current)).toBe(`releases/${short(installed)}`);
});

test.each([7, 12, 40])("redeploying the same commit resolves a %i-character release id", length => {
  select(installed.slice(0, length), true);
  expectAccepted(installed);
});

// Each of two extension versions of the descendant deploys past checkpoint
// admission, builds the app, and stops at the step after (lsregister). The
// fake xcodebuild notes, per build, whether an earlier build's products
// were still in its folder, and the folder.
function buildTwice(): string[][] {
  const layer = join(root, "app-build.sh");
  writeFileSync(layer, `
. "${env.BASH_ENV}"
bun() {
  if [ "$1" = "$CHECKPOINTS" ] && [ "$2" = check ]; then "$REAL_BUN" "$@"; return; fi
  return 99
}
xcodebuild() {
  case "$1" in -checkFirstLaunchStatus) return 0 ;; esac
  local folder=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -derivedDataPath ]; then folder="$2"; fi
    shift
  done
  if [ -e "$folder/Build/Products" ]; then printf 'stale\\t%s\\n' "$folder"; else printf 'clean\\t%s\\n' "$folder"; fi >>"$HOME/app-builds"
  command mkdir -p "$folder/Build/Products/Debug/Safari Harness.app"
}
ditto() { [ "$1" = -c ] || return 99; : >"\${@: -1}"; }
lsregister() { return 99; }
`);
  env.BASH_ENV = layer;
  mkdirSync(join(home, ".Trash"));
  const target = short(descendant);
  mkdirSync(join(releases, target, "Safari Harness"));
  for (const key of ["0123456789abcdef", "fedcba9876543210"]) {
    writeFileSync(join(releases, target, ".extension"), `${key}\n`);
    invoke(target);
  }
  return readFileSync(join(home, "app-builds"), "utf8").trim().split("\n").map((line) => line.split("\t"));
}

// Each app build made an Xcode build folder of its own and moved it to the
// Trash: six of 217 MB in 3.5 hours on 10-21.
test("two app builds use one build folder and leave nothing in the Trash", () => {
  const folders = buildTwice().map(([, folder]) => folder);
  expect(new Set(folders).size).toBe(1);
  expect(readdirSync(join(home, ".Trash"))).toEqual([]);
});

test("an app build in the reused folder starts without the products an earlier build left", () => {
  expect(buildTwice().map(([products]) => products)).toEqual(["clean", "clean"]);
});

test("a sibling deployment is refused before it can create or switch a release", () => {
  rmSync(join(releases, short(sibling)), { recursive: true });
  expectRefused(sibling, "does not contain");
  expect(existsSync(join(releases, short(sibling)))).toBe(false);
});

// SH-5 (11-06): the live release came from a history the checkout did not
// contain; a refusal now says which files differ, so a merge can be judged.
test("a sibling with other files is refused with the files that differ", () => {
  git("checkout", "--quiet", "--detach", base);
  writeFileSync(join(checkout, "daemon/slack-guard.ts"), "export {};\n");
  git("add", "daemon/slack-guard.ts");
  git("commit", "--quiet", "-m", "changed sibling");
  const changed = git("rev-parse", "HEAD");
  release(short(changed));
  expectRefused(changed, "does not contain");
  expect(invoke(changed).stderr.toString()).toContain(`files that differ from ${short(installed)} to ${short(changed)}:\n daemon/slack-guard.ts | 1 +`);
  expectRefused("--same-tree", "does not contain");
});

// On 11-06 the live release 25d2832 and the release to deploy had the same
// files but unrelated histories, and only an "ours" merge let it deploy.
test("a sibling with the same files is refused with --same-tree as the way, which deploys it", () => {
  expect(git("rev-parse", `${sibling}^{tree}`)).toBe(git("rev-parse", `${installed}^{tree}`));
  expectRefused(sibling, "their files are the same: deploy with --same-tree");
  expectAccepted("--same-tree", sibling);
});

test.each([7, 40])("a missing %i-character current commit is refused rather than treated as a first install", length => {
  const unknown = "f".repeat(length);
  select(unknown);
  running();
  expectRefused(descendant, "cannot resolve release");
});

test("the running release blocks a sibling even when the selected release is an older ancestor", () => {
  select(short(base));
  expectRefused(sibling, "does not contain");
});

test("the selected release blocks a sibling even when the running daemon is older", () => {
  running(join(releases, short(base)));
  expectRefused(sibling, "does not contain");
});

test("an unrecognized running path is refused rather than trusting the selected release alone", () => {
  running(checkout);
  expectRefused(descendant, "cannot identify the release in use");
});

test("a first install with no selected or running release reaches checkpoint admission", () => {
  rmSync(current);
  running();
  expectAccepted(descendant);
  expect(existsSync(current)).toBe(false);
});

test("a missing selected link still permits a descendant of the running release", () => {
  rmSync(current);
  expectAccepted(descendant);
  expect(existsSync(current)).toBe(false);
});

test("a missing selected link does not bypass the running release's ancestry", () => {
  rmSync(current);
  const result = invoke(sibling);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("does not contain");
  expect(existsSync(current)).toBe(false);
  expect(existsSync(join(home, "checkpoint-accepted"))).toBe(false);
});

test("an existing current directory with no release identity is refused", () => {
  rmSync(current);
  mkdirSync(current);
  running();
  const result = invoke(descendant);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("cannot identify the release in use");
  expect(existsSync(current)).toBe(true);
  expect(existsSync(join(data, ".current.new"))).toBe(false);
  expect(existsSync(join(home, "checkpoint-accepted"))).toBe(false);
});

test("existing deployment history without selected or running metadata is not a first install", () => {
  rmSync(current);
  running();
  writeFileSync(join(data, "deploys.log"), `2000-01-01T00:00:00Z ${short(installed)} ${short(base)} deploy\n`);
  const result = invoke(descendant);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("cannot identify the release in use");
  expect(existsSync(current)).toBe(false);
  expect(existsSync(join(home, "checkpoint-accepted"))).toBe(false);
});

test("an explicit rollback still reaches checkpoint admission for a non-descendant release", () => {
  writeFileSync(join(data, "deploys.log"), `2000-01-01T00:00:00Z ${short(installed)} ${short(sibling)} deploy\n`);
  expectAccepted("--rollback");
  expect(readlinkSync(current)).toBe(`releases/${short(installed)}`);
});

test("an explicit rollback cannot bypass checkpoint compatibility", () => {
  release(short(sibling), 1);
  writeFileSync(join(data, "deploys.log"), `2000-01-01T00:00:00Z ${short(installed)} ${short(sibling)} deploy\n`);
  expectRefused("--rollback", "manual rollback across checkpoint formats is blocked");
});

// The whole deploy, past checkpoint admission: the daemon's code changed,
// so it restarts; the app and extension stay as they are.
function deployThrough(target: string) {
  writeFileSync(join(home, "health.json"), JSON.stringify({ ok: true, pid: 1, code: "old", root: join(releases, short(installed)), extension: { connectedAt: 1 } }));
  writeFileSync(join(releases, short(target), ".extension"), "app-key\n");
  writeFileSync(join(data, "installed-extension"), "app-key\n");
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library/LaunchAgents/at.aktan.safari-harness.daemon.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>ProgramArguments</key><array><string>bun</string><string>${current}/daemon/main.ts</string></array></dict></plist>
`);
  const result = Bun.spawnSync(["/bin/bash", join(checkout, "scripts/dev-install.sh"), target], { env: { ...env, DEPLOY_THROUGH: "1" }, stdout: "pipe", stderr: "pipe" });
  const log = existsSync(join(data, "deploys.log")) ? readFileSync(join(data, "deploys.log"), "utf8").trim().split("\n").at(-1) : undefined;
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), log };
}

// On 10-23 the live release was a branch's tip, 6 commits off master, and
// nothing said so (HD-1).
test("a deploy of a commit that is not on origin/master warns, and logs and records how far ahead it is", () => {
  git("update-ref", "refs/remotes/origin/master", installed);
  const deployed = deployThrough(descendant);
  expect(deployed).toMatchObject({ code: 0, err: `warning: release ${short(descendant)} is 1 commit(s) ahead of origin/master, from branch work; merge it, or work started from master lacks it\n` });
  expect(deployed.log).toEndWith(`${short(descendant)} ${short(installed)} deploy unmerged work`);
  expect(JSON.parse(readFileSync(join(releases, short(descendant), ".upstream"), "utf8"))).toMatchObject({ branch: "work", ahead: 1, master: short(installed) });
});

test("a deploy of a commit on origin/master logs no warning and records that it is not ahead", () => {
  git("update-ref", "refs/remotes/origin/master", descendant);
  const deployed = deployThrough(descendant);
  expect(deployed).toMatchObject({ code: 0, err: "" });
  expect(deployed.log).toEndWith(`${short(descendant)} ${short(installed)} deploy`);
  expect(JSON.parse(readFileSync(join(releases, short(descendant), ".upstream"), "utf8"))).toMatchObject({ ahead: 0 });
});

// I-3 (11-06): omp's entry for safari had no timeout, so omp gave up on
// calls at 30 s while they ran up to 120 s.
test.each([
  ["without a timeout", {}, 130000],
  ["with a shorter timeout", { timeout: 30000 }, 130000],
  ["with a longer timeout", { timeout: 200000 }, 200000],
])("a deploy leaves omp's safari MCP entry %s waiting at least 130000 ms", (_, extra, want) => {
  git("update-ref", "refs/remotes/origin/master", descendant);
  const mcp = join(home, ".omp/agent/mcp.json");
  mkdirSync(join(home, ".omp/agent"), { recursive: true });
  const other = { command: "other", args: [] };
  writeFileSync(mcp, JSON.stringify({ mcpServers: { safari: { command: "bun", args: [`${current}/daemon/mcp.ts`], ...extra }, other } }));
  const deployed = deployThrough(descendant);
  expect(deployed).toMatchObject({ code: 0, err: "" });
  expect(JSON.parse(readFileSync(mcp, "utf8"))).toEqual({ mcpServers: { safari: { command: "bun", args: [`${current}/daemon/mcp.ts`], timeout: want }, other } });
});

// On 10-23 a call made while a deploy restarted the daemon said to install
// it (HD-13): the marker that says a deploy restarts it lasts exactly as
// long as the restart.
test("a deploy marks the daemon's restart for callers until it is done", () => {
  git("update-ref", "refs/remotes/origin/master", descendant);
  const started = Math.floor(Date.now() / 1000);
  const deployed = deployThrough(descendant);
  expect(deployed).toMatchObject({ code: 0, out: expect.stringContaining("daemon: restarted (its code changed)") });
  expect(Number(readFileSync(join(home, "deploying-seen"), "utf8"))).toBeGreaterThan(started + 60);
  expect(existsSync(join(data, "deploying"))).toBe(false);
});
