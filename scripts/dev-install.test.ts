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
curl() { command cat "$HOME/health.json"; }
bun() {
  if [ "$1" != "$CHECKPOINTS" ] || [ "$2" != check ]; then return 99; fi
  "$REAL_BUN" "$@" || return $?
  printf '%s\\n' check > "$HOME/checkpoint-accepted"
  return ${checkpointAccepted}
}
xcodebuild() { return 99; }
lsregister() { return 99; }
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
  git("init", "--quiet");
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
