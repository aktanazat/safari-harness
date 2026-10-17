import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI against a daemon that records each call and answers it from
// answers[tool], else with ok, and answers /health with health().
type Call = { tool: string; args: Record<string, unknown> };
const calls: Call[] = [];
let answers: Record<string, unknown> = {};
let health = (): Response => Response.json({});
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (new URL(req.url).pathname === "/health") return health();
    const { tool, args }: Call = await req.json();
    calls.push({ tool, args });
    return Response.json(Object.hasOwn(answers, tool) ? answers[tool] : { ok: true, value: { ok: true } });
  },
});
afterAll(() => server.stop(true));
const home = realpathSync(mkdtempSync(join(tmpdir(), "output-cli-")));
const daemon = `http://127.0.0.1:${server.port}`;

async function safari(argv: string[], at = daemon) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "safari.ts"), ...argv], {
    cwd: home,
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: at },
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

test("a command that does not exist names the one meant, prints no usage, and exits 2", async () => {
  expect(await safari(["windows", "--tab", "7"])).toEqual({ out: "", err: "error: unknown command: windows; did you mean window? (safari --help lists every command)", code: 2 });
});

// On 10-16 a reload said the daemon was not reachable while it ran, and
// status said connected while every call timed out (S99PartC, DaemonLogs).
test("status tells a daemon that is not running from one that answered an error, and a stuck extension from a connected one", async () => {
  const stopped = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const gone = `http://127.0.0.1:${stopped.port}`;
  await stopped.stop(true);
  expect(await safari(["status"], gone)).toEqual({ out: "", err: `error: daemon not reachable at ${gone}: nothing listens there; start it with: safari daemon install`, code: 1 });
  health = () => new Response("bridge failed", { status: 500 });
  expect(await safari(["status"])).toEqual({ out: "", err: `error: the daemon at ${daemon} answered /health with HTTP 500, not JSON: bridge failed`, code: 1 });
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
  const [daemonLine, extensionLine, ...events] = stuck.out.split("\n");
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
  expect(await safari(["window", "--size", "wide", "--tab", "7"])).toEqual({ out: "", err: "error: --size takes WIDTHxHEIGHT in points, as 390x844, not wide", code: 2 });
  expect(await safari(["open", "https://shop.example/", "--id"])).toEqual({ out: "13608", err: "", code: 0 });
  calls.length = 0;
  expect(await safari(["open", "https://shop.example/", "--tab", "12153"])).toEqual({ out: "", err: "error: open takes no --tab: it opens a tab of its own. To load the page in tab 12153, run: safari goto https://shop.example/ --tab 12153", code: 2 });
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

// shot's help said absolute PNG path and upload's absolute file paths, while
// the CLI takes a relative one from its folder; pdf read --path was sent as
// written (smoke run after the 10-16 deploy).
test("a path flag's help says a relative path is taken from the current folder, and each such path is sent whole, pdf --path too", async () => {
  const helps = await Promise.all(["shot", "shots", "upload"].map((cmd) => safari(["help", cmd])));
  expect(helps.filter((h) => h.code !== 0 || h.out.includes("absolute"))).toEqual([]);
  expect(helps[0].out).toContain("  --out <string>\n      PNG path (a relative path is taken from the current folder)");
  calls.length = 0;
  answers = {};
  expect((await safari(["pdf", "read", "--path", "report.pdf"])).code).toBe(0);
  expect((await safari(["shots", "https://shop.example/", "--widths", "390", "--out", "shots"])).code).toBe(0);
  expect((await safari(["shot", "page.png", "--tab", "7"])).code).toBe(0);
  expect((await safari(["download", "12", "--out", "file.bin", "--tab", "7"])).code).toBe(0);
  expect(calls.map((c) => [c.tool, c.args.path ?? c.args.out])).toEqual([["pdf", join(home, "report.pdf")], ["shots", join(home, "shots")], ["shot", join(home, "page.png")], ["download", join(home, "file.bin")]]);
}, 30_000);

// --save's help said "an absolute path", and --save rows.json saves into
// the saved folder, reading rows.json as the command's word: the help says
// the two ways a relative path is taken.
test("--save's help says how to name a relative file, and each way it names sends the path whole", async () => {
  expect((await safari(["help", "eval"])).out).toContain("  --save <string>\n      true, or a path for the whole output; returns its path, size, and first 500 characters (--save alone saves into the saved folder; give a path as --save=<path> or --save ./<path>, a relative one taken from the current folder)");
  calls.length = 0;
  answers = {};
  expect((await safari(["eval", "document.title", "--tab", "7", "--save=rows.json"])).code).toBe(0);
  expect((await safari(["extract", "--tab", "7", "--save", "./out/page.txt"])).code).toBe(0);
  expect(calls.map((c) => c.args.save)).toEqual([join(home, "rows.json"), join(home, "out", "page.txt")]);
}, 30_000);

// safari guide reference two lanes searched for "reference" alone (S99PartC).
test("guide takes every word after it", async () => {
  const lanes = await safari(["guide", "reference", "two", "lanes"]);
  expect(lanes.code).toBe(0);
  expect(lanes.out.split("\n")[0]).toBe("## Two lanes: this harness or Apple's safaridriver");
});
