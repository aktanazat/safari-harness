import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A model reads a pull request page four times through a stand-in
// extension, in a process whose HOME is a temp directory. The page shows
// the checks its own JSON request got, and each read is a load of it that
// asks for them only after the read, as GitHub did on 11-11. The run
// follows the third read's hint to request_catalog try and the save call
// try answers, then reads once more.
const home = mkdtempSync(join(tmpdir(), "scrape-offers-test-"));
const at = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
const script = `
  import { existsSync, readFileSync } from "node:fs";
  import { homedir } from "node:os";
  import { bridge } from ${at("./bridge.ts")};
  import { connect } from ${at("./fake-safari.ts")};
  import { runAs } from ${at("./owner.ts")};
  import { callTool } from ${at("./tools.ts")};
  import { requestCatalogTool } from ${at("./request-catalog.ts")};
  import { dataFile } from ${at("./phone.ts")};
  if (homedir() !== ${JSON.stringify(home)}) throw new Error("the private store is not isolated");
  const loaded = Date.now() - 5000;
  const checks = JSON.stringify({
    channel: "eyJjIjoicmVwbzoxIn0=--private-fixture-channel",
    statusChecks: [
      { displayName: "buildkite/bun", description: "Build #140103 started" },
      { displayName: "Claude Code Review", description: "Code review in progress" },
    ],
  });
  const shown = '- heading "Checks"\\n- link "buildkite/bun" [1]\\n- text "Build #140103 started"\\n- link "Claude Code Review" [2]\\n- text "Code review in progress"';
  // The page asks for its checks 500 ms after each load, on the clock: the
  // daemon's looks and deadlines run on real timers in this process, which
  // no fake clock here drives.
  let load = loaded;
  const asks = 500;
  const requests = (origin, path) => [
    { kind: "fetch", method: "GET", url: origin + "/notifications/indicator", status: 200, t: load, body: '{"mode":"global"}' },
    { kind: "fetch", method: "GET", url: origin + path + "/page_data/status_checks", status: 200, t: load + asks, body: checks.slice(0, 100) },
  ].filter((request) => request.t <= Date.now());
  const tabs = new Map();
  let windows = 0, markers = 900, opened = 200, documents = 0;
  const answer = (op, args) => {
    if (op === "windows.open") { const tab = { id: ++markers, url: String(args[0]), windowId: ++windows }; tabs.set(tab.id, tab); return { windowId: tab.windowId, tabId: tab.id }; }
    if (op === "windows.resolve") return [...tabs.values()].some((tab) => tab.windowId === args[0]) ? args[0] : null;
    if (op === "tabs.open") { const tab = { id: ++opened, url: String(args[0]), windowId: Number(args[2]) }; tabs.set(tab.id, tab); return tab; }
    if (op === "tabs.list") return [...tabs.values()];
    if (op === "probe") return [];
    if (op !== "relay") return { ok: true };
    const tab = tabs.get(Number(args[0]));
    const { origin, pathname } = new URL(tab.url);
    if (args[1] === "snapshot") { load = Date.now(); return { url: tab.url, title: "Checks", nodes: 5, truncated: false, snapshot: shown, documentId: "load-" + ++documents }; }
    if (args[1] === "netRead") return { entries: requests(origin, pathname) };
    if (args[1] === "netBody") return args[2][0].url.endsWith("/status_checks") ? { text: checks, truncated: false, arriving: false } : { text: '{"mode":"global"}', truncated: false, arriving: false };
    if (args[1] === "tabInfo") return { url: tab.url };
    if (args[1] === "eval") return { ok: true, result: { url: tab.url, ready: "complete", timeOrigin: loaded } };
    if (args[1] === "fetch") return { status: 200, url: args[2][0], type: "application/json; charset=utf-8", text: checks, truncated: false };
    return { ok: true, url: tab.url };
  };
  connect({
    send(raw) {
      const { id, op, args } = JSON.parse(raw);
      try { bridge.handleMessage(JSON.stringify({ id, value: answer(op, args) })); }
      catch (error) { bridge.handleMessage(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })); }
    },
    close() {},
  });
  const agent = Bun.spawn(["sleep", "30"]);
  const model = (tool, args) => runAs(agent.pid, () => callTool(tool, args, true));
  const harness = (tool, args) => runAs(agent.pid, () => callTool(tool, args, false));
  const out = {};
  try {
    const { id: tab } = await model("open", { url: "https://ci.example/o/r/pull/7", background: true });
    out.tab = tab;
    out.hints = [];
    const read = async () => out.hints.push((await model("snapshot", { tab })).hint ?? null);
    for (let n = 0; n < 3; n++) await read();
    const offered = out.hints.find((hint) => hint !== null) ?? "";
    out.step = JSON.parse(offered.match(/run (\\{.*\\}) reads/)?.[1] ?? "null")?.steps[0].args;
    const tried = await requestCatalogTool(out.step, harness);
    out.tried = { same: tried.same, value: tried.value };
    const catalog = dataFile("request-catalog/catalog.json");
    out.savedByTry = existsSync(catalog);
    out.save = JSON.parse(tried.next.slice(tried.next.indexOf("{"))).steps[0].args;
    out.saved = await requestCatalogTool(out.save, harness);
    out.stored = readFileSync(catalog, "utf8");
    await read();
  } catch (error) {
    out.failed = error instanceof Error ? error.message : String(error);
  } finally {
    agent.kill();
  }
  console.log(JSON.stringify(out));
  process.exit(0);
`;

let result: {
  tab: number;
  hints: (string | null)[];
  step: Record<string, unknown>;
  tried: { same: boolean; value: unknown };
  savedByTry: boolean;
  save: Record<string, unknown>;
  saved: { ok: boolean; saved: boolean };
  stored: string;
};

beforeAll(async () => {
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  result = JSON.parse(text);
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("a page read again is offered its own JSON request on the third read, though it asks for it after each read, and only then", () => {
  expect(result.hints.map((hint) => hint !== null)).toEqual([false, false, true, false]);
  expect(result.step).toMatchObject({ do: "try", tab: result.tab, request: 1, field: "statusChecks", type: "array" });
});

test("the hint's words outside its step carry no path or field name the page chose", () => {
  const wording = (result.hints.find((hint) => hint !== null) ?? "").replace(/run \{.*\}/, "");
  expect(["page_data", "status_checks", "statusChecks"].filter((word) => wording.includes(word))).toEqual([]);
});

test("the offered try saves nothing, and the one save call it answers keeps the route without the page's values", () => {
  expect(result.tried).toMatchObject({ same: true, value: [{ displayName: "buildkite/bun" }, { displayName: "Claude Code Review" }] });
  expect(result.savedByTry).toBe(false);
  expect(result.save).toMatchObject({ do: "save", tab: result.tab, request: 1, field: "statusChecks", type: "array" });
  expect(result.saved).toMatchObject({ ok: true, saved: true });
  expect(JSON.parse(result.stored).entries).toMatchObject([{ origin: "https://ci.example", path: "/o/r/pull/7/page_data/status_checks", check: { field: "statusChecks", type: "array" } }]);
  expect(["buildkite", "Build #140103", "private-fixture-channel", "Code review"].filter((value) => result.stored.includes(value))).toEqual([]);
});
