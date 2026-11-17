// Smoke test for a change in this checkout. See SKILL.md next to it.
//
//   bun .claude/skills/verify/verify.ts [--base REF] [PATH...]
//
// PATHs count as changed besides what git shows against REF
// (default origin/master). Exits 1 when any check fails.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { codeHash } from "../../../daemon/codehash.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const LIVE = "http://127.0.0.1:37334";
const CURRENT = join(process.env.HOME ?? "", ".local/share/safari-harness/current");

const argv = process.argv.slice(2);
const baseAt = argv.indexOf("--base");
const BASE = baseAt >= 0 ? argv[baseAt + 1] : "origin/master";
const extra = argv.filter((_, i) => baseAt < 0 || (i !== baseAt && i !== baseAt + 1));

let failed = 0;
function check(name: string, pass: boolean, detail?: unknown) {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass || detail === undefined ? "" : `\n     got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

type Ran = { code: number; out: string; err: string };
// Never spawnSync: the page server below answers Safari from this process.
async function sh(cmd: string[], env: Record<string, string> = {}): Promise<Ran> {
  const p = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

const cli = (args: string[], env: Record<string, string> = {}) => sh(["bun", join(ROOT, "cli/safari.ts"), ...args], env);

type Health = { pid: number; code: string; root: string; extension: { connected: boolean } };
async function healthOf(base: string): Promise<Health> {
  const body: Health = await (await fetch(`${base}/health`)).json();
  return body;
}

type Row = { id: number; url?: string };
// Cleanup goes straight to the live daemon, not through this checkout's
// CLI, which the change may have broken.
async function live<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${LIVE}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args }) });
  const reply: { ok: boolean; value?: T; error?: string } = await res.json();
  if (!reply.ok || reply.value === undefined) throw new Error(`${tool}: ${reply.error}`);
  return reply.value;
}
async function leftTabs(origin: string): Promise<Row[]> {
  const { tabs } = await live<{ tabs: Row[] }>("tabs", { all: true });
  return tabs.filter((t) => t.url?.startsWith(origin));
}

// ---------- what changed ----------

const lines = (s: string) => s.split("\n").filter(Boolean);
const changed = [...new Set([
  ...lines((await sh(["git", "diff", "--name-only", `${BASE}...HEAD`])).out),
  ...lines((await sh(["git", "diff", "--name-only", "HEAD"])).out),
  ...lines((await sh(["git", "ls-files", "--others", "--exclude-standard"])).out),
  ...extra,
])].sort();
console.log(`changed against ${BASE}: ${changed.length ? changed.join(" ") : "nothing"}`);

const isTest = (f: string) => f.endsWith(".test.ts");
// What daemon/codehash.ts hashes: the daemon runs it, so only a deploy makes it live.
const daemonCode = (f: string) => f === "package.json" || f === "bun.lock" || (f.startsWith("daemon/") && !isTest(f)) ||
  f.startsWith("docs/") || f.startsWith("passwords-bridge/") || /^scripts\/[^/]+\.swift$/.test(f);

// ---------- targeted unit tests ----------

if (!existsSync(join(ROOT, "node_modules")) && existsSync(join(ROOT, "bun.lock"))) {
  const r = await sh(["bun", "install", "--frozen-lockfile"]);
  check("bun install --frozen-lockfile", r.code === 0, r.err.slice(-800));
}

const present = (f: string) => existsSync(join(ROOT, f));
const testFiles = lines((await sh(["git", "ls-files", "*.test.ts"])).out).filter(present);
const picked = new Set(changed.filter((f) => isTest(f) && present(f)));
// A test covers a file when it names it in quotes: an import or a path it reads.
for (const f of changed.filter((f) => !isTest(f) && /\.(ts|js|md|swift|json)$/.test(f) && !f.startsWith(".claude/"))) {
  const quoted = new RegExp(`["'/]${basename(f).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
  for (const t of testFiles) if (quoted.test(readFileSync(join(ROOT, t), "utf8"))) picked.add(t);
}
// The bench runs extension/*.js in WebKit without naming them; guides.ts reads docs/.
if (changed.some((f) => /^extension\/[^/]+\.js$/.test(f))) for (const t of testFiles) if (t.startsWith("bench/")) picked.add(t);
if (changed.some((f) => f.startsWith("docs/"))) picked.add("daemon/guides.test.ts");
const tests = [...picked].sort();
console.log(`tests picked: ${tests.length ? tests.join(" ") : "none (no code or test file changed)"}`);
// One Bun process per file (README, Tests), four at a time.
for (let i = 0; i < tests.length; i += 4) {
  await Promise.all(tests.slice(i, i + 4).map(async (t) => {
    const { code, out, err } = await sh(["bun", "test", `./${t}`]);
    const summary = `${out}\n${err}`.match(/^ *\d+ pass[\s\S]*?Ran \d+ tests?.*$/m)?.[0].replace(/\s+/g, " ") ?? "";
    check(`bun test ./${t}: ${summary}`, code === 0, `${out}\n${err}`.slice(-1500));
  }));
}

// ---------- which code the live harness runs ----------

const ours = codeHash(ROOT);
const health = await healthOf(LIVE);
check("the live daemon answers and its extension is connected", health.extension.connected === true, health.extension);
console.log(`live daemon: pid ${health.pid}, code ${health.code}, ${health.root}`);
console.log(`this checkout's daemon code: ${ours}`);
const differs = async (dir: string) => (await sh(["diff", "-rq", join(ROOT, dir), join(CURRENT, dir)])).code !== 0;
const notLive: string[] = [];
if (health.code !== ours && changed.some(daemonCode)) notLive.push("daemon (daemon/, docs/, passwords-bridge/, scripts/*.swift, package.json)");
if (changed.some((f) => f.startsWith("extension/") || f.startsWith("Safari Harness/")) && ((await differs("extension")) || (await differs("Safari Harness")))) {
  notLive.push("extension or app (extension/, Safari Harness/)");
}
if (changed.some((f) => f.startsWith("omp/")) && (await differs("omp"))) notLive.push("omp extension (omp/)");
console.log(health.code === ours ? "LIVE: the running daemon runs this checkout's daemon code" : "LIVE: the running daemon runs DIFFERENT daemon code than this checkout");
console.log(notLive.length
  ? `NOT LIVE: this change's ${notLive.join("; ")} is not what runs. The live run below does not exercise it; only a deploy does, and a deploy needs Aktan's yes.`
  : "the live run below exercises every changed part that runs (the CLI runs from this checkout)");

// ---------- this checkout's daemon on its own ports, with the fake extension ----------

// Port 0 picks a free port; the daemon takes ports by number.
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  return port;
}
const scratch = mkdtempSync("/private/var/tmp/safari-verify-");
const httpPort = freePort();
const ownBase = `http://127.0.0.1:${httpPort}`;
// HOME keeps its logs, tabs and state in the scratch folder, away from the live daemon's.
const ownEnv = { HOME: scratch, SAFARI_HARNESS_WS: String(freePort()), SAFARI_HARNESS_HTTP_PORT: String(httpPort), SAFARI_HARNESS_HTTP: ownBase };
const daemon = Bun.spawn(["bun", join(ROOT, "daemon/main.ts")], { cwd: ROOT, env: { ...process.env, ...ownEnv }, stdout: "ignore", stderr: "ignore" });
let fake: Bun.Subprocess | undefined;
try {
  let up: Health | undefined;
  for (let i = 0; i < 100 && !up; i++) {
    await Bun.sleep(100);
    up = await healthOf(ownBase).catch(() => undefined);
  }
  check("this checkout's daemon starts on its own ports and runs this code", up?.code === ours, up ?? "no answer in 10 s");
  fake = Bun.spawn(["bun", join(ROOT, "scripts/fake-extension.ts")], { cwd: ROOT, env: { ...process.env, ...ownEnv }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50 && !(await healthOf(ownBase).catch(() => undefined))?.extension.connected; i++) await Bun.sleep(100);
  const opened = await cli(["open", "https://example.com/", "--bg", "--id"], ownEnv);
  const snap = await cli(["snapshot", "--tab", opened.out], ownEnv);
  check("the CLI opens and reads a tab through it", /^\d+$/.test(opened.out) && snap.code === 0 && snap.out.includes("Example Domain"), { opened, snap });
  const closed = await cli(["close", opened.out], ownEnv);
  check("the CLI closes that tab", closed.code === 0, closed);
} finally {
  fake?.kill();
  daemon.kill();
  await Promise.all([fake?.exited, daemon.exited]);
  rmSync(scratch, { recursive: true, force: true });
}

// ---------- this checkout's CLI against the live daemon, in a background tab ----------

const stamp = `verify-${Date.now()}`;
const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
  `<!doctype html><title>${stamp}</title><link rel="icon" href="data:,"><h1>Verify page</h1><button onclick="this.textContent='pressed'">Press</button>`,
  { headers: { "content-type": "text/html" } }) });
const origin = `http://127.0.0.1:${page.port}/`;
const frontApp = async () => (await sh(["osascript", "-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js'])).out;
const appBefore = await frontApp();
// Listing every tab is Safari's slowest call (seconds with 100+ tabs open),
// so the run lists them only at the end.
try {
  const opened = await cli(["open", origin, "--bg", "--id"]);
  const tab = opened.out;
  check("open --bg gives a tab id", /^\d+$/.test(tab), opened);
  const snap = await cli(["snapshot", "--tab", tab]);
  const ref = snap.out.match(/\[(\d+)\] button "Press"/)?.[1];
  check("snapshot shows the page and its button", snap.out.includes("Verify page") && ref !== undefined, snap);
  const clicked = await cli(["click", ref ?? "0", "--tab", tab]);
  const text = await cli(["eval", "document.querySelector('button').textContent", "--tab", tab, "--raw"]);
  check("click runs the page's handler", clicked.code === 0 && text.out === "pressed", { clicked, text });
  const title = await cli(["eval", "document.title", "--tab", tab, "--raw"]);
  check("eval reads the page", title.out === stamp, title);
  const shut = await cli(["close", tab]);
  check("close closes the tab", shut.code === 0, shut);
  if (changed.some((f) => f.startsWith("docs/"))) {
    const guide = await cli(["guide"]);
    check("safari guide prints this checkout's card", guide.code === 0 && guide.out.length > 200, guide);
  }
} finally {
  const left = await leftTabs(origin);
  for (const t of left) await live("close", { tab: t.id });
  if (left.length) console.log(`closed ${left.length} tab(s) the CLI left: ${left.map((t) => t.id).join(" ")}`);
  const remain = await leftTabs(origin);
  check("none of this run's tabs remain", remain.length === 0, remain);
  page.stop(true);
}
const appAfter = await frontApp();
// Other agents may move the front meanwhile; this run may only never raise Safari.
check("the run did not bring Safari forward", appBefore === "com.apple.Safari" || appAfter !== "com.apple.Safari", { appBefore, appAfter });
console.log(`front app ${appBefore} -> ${appAfter}`);
const after = await healthOf(LIVE);
check("the live daemon was not restarted or redeployed", after.pid === health.pid && after.code === health.code, { before: health.pid, after: after.pid });

console.log(failed ? `FAILED: ${failed} check(s)` : "ALL PASSED");
if (notLive.length) console.log(`reminder: NOT LIVE: ${notLive.join("; ")}`);
process.exit(failed ? 1 : 0);
