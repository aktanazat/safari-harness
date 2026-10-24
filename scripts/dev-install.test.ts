// Deploys must preserve the installed history before touching a release or native app.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
function invoke(target: string) {
  return Bun.spawnSync(["/bin/bash", join(checkout, "scripts/dev-install.sh"), target], { env, stdout: "pipe", stderr: "pipe" });
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
function expectAccepted(target: string): void {
  const result = invoke(target);
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

test("a sibling deployment is refused before it can create or switch a release", () => {
  rmSync(join(releases, short(sibling)), { recursive: true });
  expectRefused(sibling, "does not contain");
  expect(existsSync(join(releases, short(sibling)))).toBe(false);
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
