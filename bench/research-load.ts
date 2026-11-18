// Load test of web search under many agents at once, against a fake Safari
// (no real pages load). Run with a scratch HOME, since searches write the
// page store:
//   HOME=$(mktemp -d) bun bench/research-load.ts [overload|slow|stall|longstall|all]
// It prints one JSON line per scenario with counts, not only times:
// - overload: TASKS agent tasks each ask BURST searches at once, as the
//   32 helpers of 11-18 did (4 to 6 web searches per message); slow: 8
//   tasks do the same while each results page takes SLOW_LOAD_MS.
// - stall, longstall: Safari answers nothing for 15 s or 60 s while
//   searches keep coming, then answers again, as on 11-18 02:14..02:17;
//   counts results pages loaded less than an engine's gap after the one
//   before.
import { bridge, type ExtSocket } from "../daemon/bridge.ts";
import { connect } from "../daemon/fake-safari.ts";
import { watched } from "../daemon/mission.ts";
import { runAs } from "../daemon/owner.ts";
import { COLLECT as BING } from "../daemon/sites/bing-search.ts";
import { COLLECT as GOOGLE } from "../daemon/sites/google-search.ts";
import { SiteKit } from "../daemon/sites/kit.ts";
import { webSearch } from "../daemon/sites/web-search.ts";
import { callTool } from "../daemon/tools.ts";

const READS: Record<string, string> = { "www.google.com": GOOGLE, "www.bing.com": BING };
// How long a results page takes to load: a Safari at ease, and one slowed
// by load (on 11-18 tabs.navigate answered in 20 s at worst).
const LOAD_MS = 400;
const SLOW_LOAD_MS = 4000;
const GAP_MS = 3000;

type Tab = { id: number; url: string; windowId: number };
type Loads = Record<"www.google.com" | "www.bing.com", number[]>;

// A Safari whose results pages load in loadMs, and which answers nothing
// while stalled; loads lists when Safari sent each results page's request:
// as asked, or as a stall ends for one asked during it.
function safari(loadMs = LOAD_MS) {
  const tabs = new Map<number, Tab>([[1, { id: 1, url: "https://his.example/", windowId: 1_000_001 }]]);
  const loads: Loads = { "www.google.com": [], "www.bing.com": [] };
  let stalled: Promise<void> | undefined;
  let next = 50_000;
  const sent = (url: unknown) => {
    const u = URL.parse(String(url));
    if (u && u.pathname === "/search" && u.hostname in loads) loads[u.hostname as keyof Loads].push(Date.now());
  };
  const ops: Record<string, (args: unknown[]) => unknown> = {
    "tabs.list": () => [...tabs.values()],
    "tabs.open": ([url, , windowId]) => {
      const t = { id: next++, url: String(url), windowId: Number(windowId) };
      tabs.set(t.id, t);
      return t;
    },
    "windows.open": ([url]) => {
      const t = { id: next++, url: String(url), windowId: next++ };
      tabs.set(t.id, t);
      return { windowId: t.windowId, tabId: t.id };
    },
    "windows.resolve": ([id]) => ([...tabs.values()].some((t) => t.windowId === id) ? id : null),
    "tabs.navigate": ([id, url]) => {
      const t = tabs.get(Number(id));
      if (!t) throw new Error(`that tab is gone: Safari has had no tab ${String(id)}`);
      t.url = String(url);
      return t;
    },
    "tabs.close": ([id]) => {
      tabs.delete(Number(id));
      return { ok: true };
    },
    dialogs: () => ({ ok: true }),
    probe: () => [],
    relay: ([id, op, args]) => {
      const t = tabs.get(Number(id));
      if (!t) throw new Error(`that tab is gone: Safari has had no tab ${String(id)}`);
      if (op !== "eval") return { url: t.url, title: "" };
      const page = new URL(t.url);
      const read = READS[page.hostname];
      const q = read !== undefined && Array.isArray(args) && String(args[0]).includes(read) ? page.searchParams.get("q") : null;
      const results = q === null ? [] : Array.from({ length: 10 }, (_, i) => ({ title: `${q} ${i}`, url: `https://example.com/${i}`, snippet: "a result long enough to keep as a snippet" }));
      return { ok: true, result: { url: t.url, captcha: false, results, next: null } };
    },
  };
  const socket: ExtSocket = {
    send(data) {
      const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
      if (id === undefined) return;
      const answer = async () => {
        if (stalled) await stalled;
        if (op === "tabs.navigate") sent(args[1]);
        if (op === "tabs.open" || op === "windows.open") sent(args[0]);
        if (op === "tabs.navigate" || op === "tabs.open" || op === "windows.open") await Bun.sleep(loadMs);
        const run = ops[op];
        try {
          return run ? { value: run(args) } : { error: `this fake has no ${op}` };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      };
      void answer().then((a) => bridge.handleMessage(JSON.stringify({ id, ...a })));
    },
    close() {},
  };
  connect(socket);
  return {
    loads,
    stall(ms: number) {
      stalled = Bun.sleep(ms).then(() => {
        stalled = undefined;
      });
    },
  };
}

const agent = Bun.spawn(["sleep", "3600"]);
const kitOf = (task: string) => new SiteKit((tool, args) => watched(agent.pid, tool, args, () => runAs(agent.pid, () => callTool(tool, args, false, true), task)));

type Outcome = { task: string; ms: number; engine?: string; error?: string };
async function search(task: string, query: string, kits: Map<string, SiteKit>): Promise<Outcome> {
  const kit = kits.get(task) ?? new SiteKit(() => Promise.reject(new Error("no kit")));
  const began = Date.now();
  try {
    const found = await webSearch(kit).search(query);
    return { task, ms: Date.now() - began, engine: found.results.length ? found.engine : "empty" };
  } catch (e) {
    return { task, ms: Date.now() - began, error: e instanceof Error ? e.message : String(e) };
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

// Pairs of results-page loads of one engine that started less than its gap
// apart, minus a little for timers, each as its gap in ms.
const close = (times: number[]) => times.slice(1).map((t, i) => t - times[i]).filter((gap) => gap < GAP_MS - 250);

function summary(name: string, outcomes: Outcome[], loads: Loads, began: number) {
  const ok = outcomes.filter((o) => o.engine !== undefined && o.engine !== "empty");
  const busy = outcomes.filter((o) => o.error !== undefined && /busy/i.test(o.error));
  const failed = outcomes.filter((o) => o.error !== undefined && !/busy/i.test(o.error));
  const byTask = new Map<string, number>();
  for (const o of outcomes) byTask.set(o.task, (byTask.get(o.task) ?? 0) + (ok.includes(o) ? 1 : 0));
  const ms = outcomes.map((o) => o.ms);
  return {
    scenario: name,
    searches: outcomes.length,
    answered: ok.length,
    busy: busy.length,
    failed: failed.length,
    failures: [...new Set(failed.map((o) => o.error!.slice(0, 120)))],
    over60s: ms.filter((m) => m > 60_000).length,
    p50s: +(pct(ms, 0.5) / 1000).toFixed(1),
    p90s: +(pct(ms, 0.9) / 1000).toFixed(1),
    maxs: +(Math.max(...ms) / 1000).toFixed(1),
    fewestAnsweredOfATask: Math.min(...byTask.values()),
    googleLoads: loads["www.google.com"].length,
    bingLoads: loads["www.bing.com"].length,
    loadsUnderGap: [...close(loads["www.google.com"]), ...close(loads["www.bing.com"])],
    wallS: Math.round((Date.now() - began) / 1000),
  };
}

const TASKS = 16;
const BURST = 5;
async function overload(name: string, loadMs: number, tasks: number) {
  const s = safari(loadMs);
  const kits = new Map<string, SiteKit>();
  const began = Date.now();
  const all: Promise<Outcome>[] = [];
  for (let t = 0; t < tasks; t++) {
    const task = JSON.stringify(["load-session", `Helper${t}`]);
    kits.set(task, kitOf(task));
    for (let b = 0; b < BURST; b++) all.push(search(task, `${name} ${began} task ${t} query ${b}`, kits));
  }
  return summary(name, await Promise.all(all), s.loads, began);
}

// A stall within the extension's timeouts, and one past them, as on 11-18
// (3.6 minutes, each load giving up after 52 s).
async function stall(name: string, ms: number) {
  const s = safari();
  const kits = new Map<string, SiteKit>();
  const began = Date.now();
  const all: Promise<Outcome>[] = [];
  const task = (i: number) => JSON.stringify(["load-session", `Staller${i % 4}`]);
  for (let i = 0; i < 4; i++) kits.set(task(i), kitOf(task(i)));
  all.push(search(task(0), `${name} ${began} warm`, kits));
  await Bun.sleep(1000);
  s.stall(ms);
  for (let i = 0; i < 14; i++) {
    all.push(search(task(i), `${name} ${began} query ${i}`, kits));
    await Bun.sleep(1000);
  }
  return summary(name, await Promise.all(all), s.loads, began);
}

const which = process.argv[2] ?? "all";
if (which === "overload" || which === "all") console.log(JSON.stringify(await overload("overload", LOAD_MS, TASKS)));
if (which === "slow" || which === "all") console.log(JSON.stringify(await overload("slow", SLOW_LOAD_MS, 8)));
if (which === "stall" || which === "all") console.log(JSON.stringify(await stall("stall", 15_000)));
if (which === "longstall" || which === "all") console.log(JSON.stringify(await stall("longstall", 60_000)));
agent.kill();
process.exit(0);
