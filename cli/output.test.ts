import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI against a daemon that records each call and answers it from
// answers[tool], else with ok, and answers /health with health(). It keeps
// no call log: /calls is not found there.
type Call = { tool: string; args: Record<string, unknown> };
const calls: Call[] = [];
let answers: Record<string, unknown> = {};
let health = (): Response => Response.json({});
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return health();
    if (path === "/calls") return new Response("", { status: 404 });
    const { tool, args }: Call = await req.json();
    calls.push({ tool, args });
    return Response.json(Object.hasOwn(answers, tool) ? answers[tool] : { ok: true, value: { ok: true } });
  },
});
afterAll(() => server.stop(true));
const home = realpathSync(mkdtempSync(join(tmpdir(), "output-cli-")));
const daemon = `http://127.0.0.1:${server.port}`;

async function safari(argv: string[], at = daemon, more: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "safari.ts"), ...argv], {
    cwd: home,
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: at, ...more },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

const MISS = { ok: true, value: { ok: false, found: false, waitedMs: 10000, url: "https://shop.example/cart" } };

// From 10-01 to 10-04, 450 of 933 safari commands went to /dev/null, and
// a wait that missed (found: false) exited 0 with nothing said (S99PartA).
test("under -q a call that worked prints nothing and exits 0; a miss prints one miss line and exits 1, as it exits 1 without -q", async () => {
  answers = { info: { ok: true, value: { url: "https://shop.example/", title: "Shop" } }, wait: MISS };
  expect(await safari(["info", "--tab", "7", "-q"])).toEqual({ out: "", err: "", code: 0 });
  expect(await safari(["wait", "--text", "Order placed", "--tab", "7", "-q"])).toEqual({ out: "", err: 'miss: {"ok":false,"found":false,"waitedMs":10000,"url":"https://shop.example/cart"}', code: 1 });
  const loud = await safari(["wait", "--text", "Order placed", "--tab", "7"]);
  expect(loud.code).toBe(1);
  expect(loud.out).toMatch(/"found": ?false/);
  answers = { info: { ok: false, error: "that tab is gone:\n  open it again" } };
  expect(await safari(["info", "--tab", "7", "-q"])).toEqual({ out: "", err: "error: that tab is gone: open it again", code: 1 });
});

// wait --quiet was used 43 times as the wait for quiet, and wait --timeout
// came in seconds (S99PartA, S99PartC).
test("wait --quiet waits for a quiet page and wait --timeout takes seconds", async () => {
  answers = {};
  calls.length = 0;
  expect((await safari(["wait", "--quiet", "--timeout", "30", "--tab", "7"])).code).toBe(0);
  expect(calls).toEqual([{ tool: "wait", args: { tab: 7, quiet: true, ms: 30000 } }]);
});

// --help was read 6 times for window and shot, and shot's said --fullPage
// under [--full]; safari windows printed all of USAGE (S99PartA, S99PartC).
test("help window prints the window command alone, as window --help does, and shot's flags are the ones it takes", async () => {
  const help = await safari(["help", "window"]);
  expect(help.code).toBe(0);
  expect(await safari(["window", "--help"])).toEqual(help);
  const usage = help.out.split("\n").filter((l) => l.startsWith("  safari "));
  expect(usage.length).toBeGreaterThan(0);
  expect(usage.filter((l) => !l.startsWith("  safari window "))).toEqual([]);
  expect(usage.some((l) => l.includes("--size"))).toBe(true);
  const shot = await safari(["help", "shot"]);
  expect(shot.out).toContain("--full");
  expect(shot.out).not.toContain("--fullPage");
});

test("an unknown command exits 2 without contacting the daemon", async () => {
  calls.length = 0;
  const result = await safari(["windows", "--tab", "7"]);
  expect(result.code).toBe(2);
  expect(result.out).toBe("");
  expect(result.err).not.toBe("");
  expect(calls).toEqual([]);
});

// On 10-16 a reload said the daemon was not reachable while it ran, and
// status said connected while every call timed out (S99PartC, DaemonLogs).
test("status tells a daemon that is not running from one that answered an error, and a stuck extension from a connected one", async () => {
  const stopped = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const gone = `http://127.0.0.1:${stopped.port}`;
  await stopped.stop(true);
  const unreachable = await safari(["status"], gone);
  expect(unreachable).toMatchObject({ out: "", code: 1 });
  expect(unreachable.err).toContain(gone);
  health = () => new Response("bridge failed", { status: 500 });
  const failed = await safari(["status"]);
  expect(failed).toMatchObject({ out: "", code: 1 });
  expect(failed.err).toContain(daemon);
  expect(failed.err).toContain("500");
  expect(failed.err).toContain("bridge failed");
  const now = Date.now();
  health = () => Response.json({
    pid: 4242,
    inFlight: 1,
    extension: { connected: true, stuck: true, sinceAnswerMs: 95000, timeouts: { snapshot: 3 } },
    journal: [
      { t: new Date(now - 20 * 60_000).toISOString(), kind: "connect" },
      { t: new Date(now - 60_000).toISOString(), kind: "replaced", tab: 7 },
      { t: new Date(now - 30_000).toISOString(), kind: "stuck", op: "snapshot" },
    ],
  });
  const stuck = await safari(["status"]);
  expect(stuck.code).toBe(0);
  const [daemonLine, extensionLine, , ...events] = stuck.out.split("\n");
  expect(daemonLine).toBe("daemon 4242, 1 call(s) in flight");
  expect(extensionLine).toBe("extension stuck: connected, but its calls time out (snapshot 3 in a row), last answered 95 s ago; run: safari extension reload");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatch(/ {2}stuck {2}\{"op":"snapshot"\}$/);
});

// On 10-16 doctor -q exited 1 and printed nothing: which check failed, and
// its fix, were quieted with the rest (smoke run after the deploy).
test("doctor -q prints each failed check alone, a line each on stderr with its fix, and exits 1", async () => {
  const stopped = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const gone = `http://127.0.0.1:${stopped.port}`;
  await stopped.stop(true);
  const { out, err, code } = await safari(["doctor", "-q"], gone);
  expect(code).toBe(1);
  expect(out).toBe("");
  const lines = err.split("\n");
  expect(lines.filter((l) => !/^fail: [^:]+: /.test(l))).toEqual([]);
  expect(lines.filter((l) => l.startsWith(`fail: daemon: not answering at ${gone}; fix: `))).toHaveLength(1);
}, 30_000);

// Agents cut the answer's value out with grep 47 times, and an open's id
// 48 times (S99PartA).
test("eval --raw prints the value alone, a text bare, with other words on stderr, and --expression is the code", async () => {
  calls.length = 0;
  answers = { eval: { ok: true, value: { result: "Order 42", note: "the page navigated" } } };
  expect(await safari(["eval", "--expression", "document.title", "--tab", "7", "--raw"])).toEqual({ out: "Order 42", err: "note: the page navigated", code: 0 });
  answers = { eval: { ok: true, value: { result: { rows: 2 } } } };
  expect(await safari(["eval", "rows()", "--tab", "7", "--raw"])).toEqual({ out: '{"rows":2}', err: "", code: 0 });
  expect(calls.map((c) => c.args)).toEqual([{ tab: 7, expression: "document.title", page: false }, { tab: 7, expression: "rows()", page: false }]);
});

// window --size 1440x1000, --account, and open <url> --tab 12153 (which
// opened tab 13608) were each tried as written (S99PartC).
test("window --size sets both sides, open --id prints the id alone, and open --tab refuses before any call", async () => {
  calls.length = 0;
  answers = { open: { ok: true, value: { id: 13608, url: "https://shop.example/" } } };
  expect((await safari(["window", "--size", "1440x1000", "--tab", "7"])).code).toBe(0);
  expect(calls).toEqual([{ tool: "window", args: { tab: 7, width: 1440, height: 1000 } }]);
  const invalidSize = await safari(["window", "--size", "wide", "--tab", "7"]);
  expect(invalidSize).toMatchObject({ out: "", code: 2 });
  expect(invalidSize.err).not.toBe("");
  expect(calls).toHaveLength(1);
  expect(await safari(["open", "https://shop.example/", "--id"])).toEqual({ out: "13608", err: "", code: 0 });
  calls.length = 0;
  const invalidTab = await safari(["open", "https://shop.example/", "--tab", "12153"]);
  expect(invalidTab).toMatchObject({ out: "", code: 2 });
  expect(invalidTab.err).not.toBe("");
  expect(calls).toEqual([]);
});

test("upload sends files named relative to where it runs as whole paths, given bare or with --paths", async () => {
  calls.length = 0;
  answers = {};
  expect((await safari(["upload", "resume.pdf", "--ref", "12", "--tab", "7"])).code).toBe(0);
  expect((await safari(["upload", "--paths", "resume.pdf", "--ref", "12", "--tab", "7"])).code).toBe(0);
  const sent = calls.filter((c) => c.tool === "upload").map((c) => String(c.args.paths));
  expect(sent).toEqual([join(home, "resume.pdf"), join(home, "resume.pdf")]);
});

test("path flags resolve relative inputs from the current folder, including pdf --path", async () => {
  calls.length = 0;
  answers = {};
  expect((await safari(["pdf", "read", "--path", "report.pdf"])).code).toBe(0);
  expect((await safari(["shots", "https://shop.example/", "--widths", "390", "--out", "shots"])).code).toBe(0);
  expect((await safari(["shot", "page.png", "--tab", "7"])).code).toBe(0);
  expect((await safari(["download", "12", "--out", "file.bin", "--tab", "7"])).code).toBe(0);
  expect(calls.map((c) => [c.tool, c.args.path ?? c.args.out])).toEqual([["pdf", join(home, "report.pdf")], ["shots", join(home, "shots")], ["shot", join(home, "page.png")], ["download", join(home, "file.bin")]]);
}, 30_000);

test("--save accepts both supported relative path forms", async () => {
  calls.length = 0;
  answers = {};
  expect((await safari(["eval", "document.title", "--tab", "7", "--save=rows.json"])).code).toBe(0);
  expect((await safari(["extract", "--tab", "7", "--save", "./out/page.txt"])).code).toBe(0);
  expect(calls.map((c) => c.args.save)).toEqual([join(home, "rows.json"), join(home, "out", "page.txt")]);
}, 30_000);

// safari guide reference two lanes searched for "reference" alone (S99PartC).
test("guide takes every word after it", async () => {
  const [lanes, phrase, broad] = await Promise.all([
    safari(["guide", "reference", "two", "lanes"]),
    safari(["guide", "reference", "two lanes"]),
    safari(["guide", "reference"]),
  ]);
  expect(lanes.code).toBe(0);
  expect(lanes.out).not.toBe("");
  expect(lanes).toEqual(phrase);
  expect(lanes.out).not.toBe(broad.out);
});

// On 10-23 ~/.local/bin/tell-aktan was gone after the Mac moved: ask
// failed with a spawn error, and handoff and passwords still promised his
// phone an alert (HD-5, SONA-03).
test("status, doctor, and ask say the phone alerts are off while tell-aktan is missing, and how the last one went once it runs", async () => {
  health = () => Response.json({ pid: 4242, extension: null });
  const tell = join(home, ".local/bin/tell-aktan");
  const away = { SAFARI_HARNESS_AWAY: "1" };
  const alertLine = async () => (await safari(["status"])).out.split("\n")[2];
  const alertCheck = async () => JSON.parse((await safari(["doctor", "--json"])).out).checks.find((c: { name: string }) => c.name === "phone alerts")?.status;
  const asked = async () => JSON.parse((await safari(["ask", "which color?", "--json"], daemon, away)).out);
  try {
    expect(await alertLine()).toBe("the phone alert is off: ~/.local/bin/tell-aktan is missing: handoff, ask, and watch routines cannot reach the user's phone; tell him in your chat");
    expect(JSON.parse((await safari(["status", "--json"])).out).alerts).toEqual({ on: false, why: "the phone alert is off: ~/.local/bin/tell-aktan is missing" });
    expect(await alertCheck()).toBe("fail");
    expect(await asked()).toMatchObject({ sent: false, why: "the phone alert is off: ~/.local/bin/tell-aktan is missing", hint: expect.stringContaining("ask it in your own chat") });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(tell, `#!/bin/sh\ncat >> "$HOME/told"\n`);
    chmodSync(tell, 0o755);
    expect(await asked()).toMatchObject({ sent: true });
    expect(readFileSync(join(home, "told"), "utf8")).toContain("which color?");
    expect(await alertLine()).toBe("phone alerts on");
    expect(await alertCheck()).toBe("ok");
    writeFileSync(tell, "#!/bin/sh\necho 'no route to host' >&2\nexit 1\n");
    expect(await asked()).toMatchObject({ sent: false, why: "the phone alert failed: no route to host" });
    expect(await alertLine()).toMatch(/^phone alerts on, but the last one, at .+, failed: the phone alert failed: no route to host$/);
    expect(await alertCheck()).toBe("warn");
  } finally {
    rmSync(join(home, ".local"), { recursive: true, force: true });
  }
}, 30_000);

// On 10-23 a call made during a deploy said the daemon was not reachable
// and to install it (HD-13).
test("while a deploy restarts the daemon, status says so and when to try again, rather than to install it", async () => {
  const stopped = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const gone = `http://127.0.0.1:${stopped.port}`;
  await stopped.stop(true);
  const marker = join(home, ".local/share/safari-harness/deploying");
  mkdirSync(join(marker, ".."), { recursive: true });
  try {
    writeFileSync(marker, `${Math.floor(Date.now() / 1000) + 40}\n`);
    expect(await safari(["status"], gone)).toMatchObject({ out: "", err: expect.stringMatching(/^error: safari is restarting for a deploy; try again in (39|40|41) s$/), code: 1 });
    writeFileSync(marker, `${Math.floor(Date.now() / 1000) - 5}\n`);
    expect((await safari(["status"], gone)).err).toContain("start it with: safari daemon install");
  } finally {
    rmSync(join(home, ".local"), { recursive: true, force: true });
  }
});

// On 10-23 the live release sat 6 commits off master for a day (HD-1).
test("status says how far the live release is ahead of origin/master, as its deploy recorded it, and nothing once it is merged", async () => {
  const root = join(home, "release");
  mkdirSync(root, { recursive: true });
  health = () => Response.json({ pid: 4242, root, code: "c", extension: null });
  try {
    writeFileSync(join(root, ".upstream"), JSON.stringify({ branch: "up-omp", ahead: 6, master: "48a9362", at: "2026-10-23T05:00:00Z" }));
    expect((await safari(["status"])).out.split("\n")[3]).toMatch(/^live release is 6 commit\(s\) ahead of origin\/master, from branch up-omp, as its deploy at .+ found it: merge it$/);
    expect(JSON.parse((await safari(["status", "--json"])).out).upstream).toMatchObject({ branch: "up-omp", ahead: 6 });
    writeFileSync(join(root, ".upstream"), JSON.stringify({ branch: "master", ahead: 0, master: "48a9362", at: "2026-10-23T05:00:00Z" }));
    expect((await safari(["status"])).out).not.toContain("ahead of origin/master");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
