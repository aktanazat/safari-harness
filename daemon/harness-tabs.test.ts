import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs, watchOwner } from "./owner.ts";
import { ReplSession } from "./repl.ts";
import { windowOwners } from "./spaces.ts";
import { callTool, endTurn, loadTabs } from "./tools.ts";

// A stand-in extension: open hands out tabs 1, 2, 3...; a click in tab 1
// opens tab 100; every close succeeds and is noted, except that the tab the
// user has in front stays when the close is for a tab left idle. The tab
// list is showing, and a call to a closed tab fails as the extension's does.
const closes: unknown[][] = [];
const opens: unknown[][] = [];
const relays: unknown[][] = [];
const gone = new Set<number>();
let showing: { id: number; url: string; windowId?: number }[] = [];
let nextTab = 0;
let nextWindow = 0;
let hisFront: number | undefined;
let onClose = () => {};
afterEach(() => { closes.length = 0; hisFront = undefined; });
const SIGN_IN_PAGE = { name: "", type: "text/html", size: 13, disposition: null, url: "https://slack.com/signin", data: Buffer.from("<html>sign in").toString("base64") };
function answer(op: string, args: unknown[]): unknown {
  if (op === "windows.open") return { windowId: ++nextWindow, tabId: 900 + nextWindow };
  if (op === "tabs.open") return { id: ++nextTab, windowId: args[2] };
  if (op === "tabs.navigate") {
    const shown = showing.find((t) => t.id === args[0]);
    if (shown) shown.url = String(args[1]);
    return { id: args[0], url: args[1] };
  }
  if (op === "tabs.list") return showing;
  if (op === "probe") return [];
  if (op === "relay" && args[0] === 1 && args[1] === "click") return { ok: true, newTab: { id: 100 } };
  // a page's fetch carries its site's cookies; the extension's own fetch,
  // without them, gets the site's sign-in page, and so does a page's on a
  // site the user is signed out of
  if (op === "relay" && args[1] === "fetchFile") {
    const url = (args[2] as string[])[0];
    return url.includes("/signed-out/") ? SIGN_IN_PAGE : { name: "", type: "image/png", size: 4, disposition: null, url, data: Buffer.from("png!").toString("base64") };
  }
  if (op === "fetchFile") return SIGN_IN_PAGE;
  if (op === "tabs.close" && args[1] === "idle" && args[0] === hisFront) return { ok: false, front: true };
  return { ok: true };
}
const ext = {
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const value = answer(op, args);
    if (op === "tabs.open") opens.push(args);
    if (op === "relay") relays.push(args);
    if (op === "tabs.close" && !(typeof value === "object" && value !== null && "front" in value)) gone.add(Number(args[0]));
    bridge.handleMessage(JSON.stringify(op === "relay" && gone.has(Number(args[0])) ? { id, error: "that tab is gone: it was closed at the end of your turn, after 20 minutes unused, or by the user" } : { id, value }));
    if (op === "tabs.close") {
      closes.push(args);
      onClose();
    }
  },
  close() {},
};
connect(ext);

function closedAs(only: string | undefined, tabs: number[]): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  onClose = () => { if (tabs.every((t) => closes.some(([tab, how]) => tab === t && how === only))) resolve(); };
  onClose();
  return promise;
}
const closesAs = (only: string | undefined) => closes.filter(([, how]) => how === only).map(([tab]) => Number(tab)).sort((a, b) => a - b);
// the answers settle in microtasks, which all run before the next turn
const settled = () => new Promise((resolve) => setImmediate(resolve));

// An agent that keeps a tab. A tab it kept stays its own until the daemon
// sees it exit (keepTab in tools.ts), on its once-a-second look at the
// kernel, and the files after this one reuse these tab ids: this one ends
// once the daemon has seen each such agent exit. One owner sweep calls the
// watches in turn, and the keeper's came first.
const keeping: { pid: number; kill(): void; exited: Promise<number> }[] = [];
function keeper() {
  const p = Bun.spawn(["sleep", "60"]);
  keeping.push(p);
  return p;
}
afterAll(async () => {
  await Promise.all(keeping.map(async (p) => {
    p.kill();
    await p.exited;
    await new Promise<void>((resolve) => watchOwner(p.pid, resolve));
  }));
});

// Before, the daemon kept its tab owners in memory: after a restart, the
// tabs of an agent that had exited stayed open for good. From 10-14 to
// 10-19 they stayed again, as only a turn end omp never sent could close them.
test("a restarted daemon closes an exited agent's tabs by itself, never another owner's", async () => {
  const exited = Bun.spawnSync(["true"]).pid;
  const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
  showing = [{ id: 11, url: "https://example.com/" }, { id: 12, url: "https://example.com/" }];
  writeFileSync(file, JSON.stringify({ 11: exited, 12: process.pid }));
  loadTabs(file);
  await closedAs(undefined, [11]);
  await settled();
  expect(closesAs(undefined)).toEqual([11]);
  expect(JSON.parse(readFileSync(file, "utf8")).tabs).toEqual({ 12: { owner: process.pid, used: expect.any(Number), seen: expect.any(Number), url: "https://example.com/" } });
  showing = [];
});

// An agent that is done need not spend a turn on close. One it asked to
// keep is the user's. From 10-14 to 10-21 a page an agent had clicked in
// outlived its exit, and five exited agents' windows stayed up for hours.
test("an agent's exit closes its tabs and popups, pages it changed too, but not one it kept", async () => {
  const agent = keeper();
  const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
  await as("open", { url: "https://example.com/", background: true }); // tab 1
  await as("click", { tab: 1, ref: "Elsewhere" }); // opens tab 100
  await as("open", { url: "https://example.com/" }); // tab 2, in front
  await as("open", { url: "https://example.com/", background: true, keep: true }); // tab 3
  await as("run", { steps: [{ tool: "open", args: { url: "https://example.com/", background: true } }] }); // tab 4
  await as("open", { url: "https://example.com/", background: true }); // tab 5
  await as("close", { tab: 5 });
  showing = [1, 2, 3, 4, 100].map((id) => ({ id, url: "https://example.com/" }));
  agent.kill();
  await closedAs(undefined, [1, 2, 4, 100]);
  await settled();
  expect(closesAs(undefined).filter((tab) => tab !== 5)).toEqual([1, 2, 4, 100]);
  expect(gone.has(3)).toBe(false);
  showing = [];
});

// Tabs an agent left open as it handed the turn back to the user piled up
// in his Safari until it exited. One it kept waits on his answer; one he is
// looking at stays until he leaves it, then closes with no turn end again.
test("when an agent's turn ends its tabs close, except one it kept, one the user has in front until he leaves it, and another agent's", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
  loadTabs(file);
  const [agent, other] = [keeper(), Bun.spawn(["sleep", "60"])];
  // the tab the stand-in handed out last is the one just opened
  const open = async (who: number, args: Record<string, unknown> = {}) => {
    await runAs(who, () => callTool("open", { url: "https://example.com/", ...args }));
    return nextTab;
  };
  const done = [await open(agent.pid, { background: true }), await open(agent.pid)];
  const kept = await open(agent.pid, { background: true });
  await runAs(agent.pid, () => callTool("keep", { tab: kept }));
  hisFront = await open(agent.pid, { background: true });
  const others = await open(other.pid, { background: true });
  endTurn(agent.pid);
  await closedAs("idle", [...done, hisFront]);
  await settled();
  expect(closesAs("idle")).toEqual([...done, hisFront].sort((a, b) => a - b));
  const saved = JSON.parse(readFileSync(file, "utf8")).tabs as Record<string, { owner: number | null }>;
  const owners = Object.fromEntries(Object.entries(saved).map(([tab, t]) => [tab, t.owner]));
  expect(owners).toMatchObject({ [hisFront]: agent.pid, [others]: other.pid });
  expect(owners).not.toContainAnyKeys([...done, kept].map(String));
  const front = hisFront;
  hisFront = undefined;
  // a sweep, which another agent's turn end runs at once
  await endTurn(Bun.spawnSync(["true"]).pid);
  const after = JSON.parse(readFileSync(file, "utf8")).tabs as Record<string, unknown>;
  expect(Object.keys(after)).not.toContain(String(front));
  agent.kill();
  other.kill();
  await endTurn(other.pid);
  await closedAs("idle", [others]);
});

// 10-02: a repl session that ended after 30 minutes unused closed the
// TikTok sign-up its agent had kept for the user from the CLI.
test("a repl session's end closes the tabs it opened, but not one kept for the user", async () => {
  const agent = keeper();
  const invoke = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
  const repl = new ReplSession("kept", { cwd: mkdtempSync(join(tmpdir(), "repl-kept-")), invoke });
  await repl.run("await openTab('https://example.com/')\nawait openTab('https://example.com/')");
  const [done, kept] = repl.tabs.map((p) => p.id);
  await invoke("keep", { tab: kept });
  const before = closes.length;
  await repl.close();
  expect(closes.slice(before).filter(([tab]) => tab === done || tab === kept)).toEqual([[done, "idle"]]);
  agent.kill();
});

// Late in September a chat tab closed while its agent waited 50 minutes on
// a subagent, and "that tab is gone" alone cost it 10 turns to recover.
// Another agent's call to such a tab is not that agent's to open again.
test("another agent's call to a tab the harness closed says why and when, and what the tab showed", async () => {
  const [agent, other] = [Bun.spawn(["sleep", "60"]), Bun.spawn(["sleep", "60"])];
  await runAs(agent.pid, () => callTool("open", { url: "https://chat.example/c/1", background: true }));
  const tab = nextTab;
  showing = [{ id: tab, url: "https://chat.example/c/1" }];
  endTurn(agent.pid);
  await closedAs("idle", [tab]);
  await settled();
  showing = [];
  const later = runAs(other.pid, () => callTool("extract", { tab }));
  await expect(later).rejects.toThrow(new RegExp(`^that tab is gone: tab ${tab} was closed as its agent's turn ended at .+ \\(it showed https://chat\\.example/c/1\\); open it again$`));
  expect(nextTab).toBe(tab);
  agent.kill();
  other.kill();
});

// 10-07: Akyl's tabs closed as its turn ended three times while the user
// typed his next ask; each cost a failed read, an open, and a wait.
test("an agent's read of its tab closed as its turn ended opens the page again in its window, and the old id names the new tab", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
  await as("open", { url: "https://app.example/board", background: true });
  const tab = nextTab;
  showing = [{ id: tab, url: "https://app.example/board/42" }];
  endTurn(agent.pid);
  await closedAs("idle", [tab]);
  await settled();
  showing = [];
  const read = (await as("extract", { tab })) as { note?: string; replaced?: { to: number } };
  const again = nextTab;
  const [url, background, windowId] = opens.at(-1) ?? [];
  expect([url, background, windowOwners().get(Number(windowId))]).toEqual(["https://app.example/board/42", true, agent.pid]);
  expect(read.replaced?.to).toBe(again);
  expect(read.note).toMatch(new RegExp(`^tab ${tab} had closed as its agent's turn ended at .+; it is open again on https://app\\.example/board/42, loaded fresh$`));
  await as("extract", { tab });
  expect(nextTab).toBe(again);
  agent.kill();
  await endTurn(agent.pid);
  await closedAs("idle", [again]);
});

// A fresh page has lost what earlier actions entered (a form in progress):
// an action on it would act on what the agent never saw.
test("an agent's action on its tab closed after its turn opens the page again but does not act", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
  await as("open", { url: "https://shop.example/checkout", background: true });
  const tab = nextTab;
  showing = [{ id: tab, url: "https://shop.example/checkout" }];
  endTurn(agent.pid);
  await closedAs("idle", [tab]);
  await settled();
  showing = [];
  await expect(as("click", { tab, ref: "Place order" })).rejects.toThrow(/; it is open again on https:\/\/shop\.example\/checkout, loaded fresh as tab \d+, so its refs and anything typed there are gone: snapshot it, then act$/);
  const again = nextTab;
  expect(opens.at(-1)?.[0]).toBe("https://shop.example/checkout");
  expect(relays.filter(([to, op]) => to === again && op === "click")).toEqual([]);
  // the next call, a look, goes to the page opened again
  expect(await as("extract", { tab })).not.toHaveProperty("note");
  expect(relays.at(-1)?.slice(0, 2)).toEqual([again, "extract"]);
  agent.kill();
  await endTurn(agent.pid);
  await closedAs("idle", [nextTab]);
});

// 10-07: a Slack image fetched with no tab came back as Slack's sign-in
// page while its agent had a tab signed in to Slack open. An agent with no
// such tab got sign-in pages too, six in a burst that drew Slack's 429.
test("a download of a url with no tab comes through the agent's own tab on that site, never another agent's, else through one it opens where the sign-in page came from", async () => {
  const [agent, other] = [Bun.spawn(["sleep", "60"]), Bun.spawn(["sleep", "60"])];
  await runAs(agent.pid, () => callTool("open", { url: "https://99-point.slack.com/archives/C1", background: true }));
  const tab = nextTab;
  showing = [{ id: tab, url: "https://99-point.slack.com/archives/C1" }];
  const dir = mkdtempSync(join(tmpdir(), "harness-download-"));
  const url = "https://files.slack.com/files-pri/T1-F1/shot.png";
  const fetchedIn = () => relays.filter(([, op, a]) => op === "fetchFile" && (a as string[])[0] === url).map(([t]) => Number(t));
  await runAs(agent.pid, () => callTool("download", { url, out: join(dir, "shot.png") }));
  await runAs(other.pid, () => callTool("download", { url, out: join(dir, "theirs.png") }));
  const theirs = nextTab;
  // the tab opened on the sign-in page's site lands in the signed-in app
  expect(opens.at(-1)?.[0]).toBe("https://slack.com/");
  showing.push({ id: theirs, url: "https://app.slack.com/client/T1" });
  await runAs(other.pid, () => callTool("download", { url, out: join(dir, "again.png") }));
  expect(fetchedIn()).toEqual([tab, theirs, theirs]);
  expect(["shot.png", "theirs.png", "again.png"].map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(["png!", "png!", "png!"]);
  agent.kill();
  other.kill();
  await Promise.all([endTurn(agent.pid), endTurn(other.pid)]);
  await closedAs("idle", [tab, theirs]);
  showing = [];
});

// The same night, before that, a sign-in page came back for such an image
// and was saved as the .png, with exit 0. Where the user is signed out of
// the site, the tab opened on it gets the sign-in page too.
test("a download of a url with no tab from a site the user is signed out of fails naming where it went, and saves nothing", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  const dir = mkdtempSync(join(tmpdir(), "harness-download-"));
  const url = "https://files.slack.com/files-pri/T1-F2/signed-out/shot.png";
  await expect(runAs(agent.pid, () => callTool("download", { url, out: join(dir, "files", "shot.png") }))).rejects.toThrow(`${url} answered a web page (it went to https://slack.com/signin), not a .png file; nothing was saved`);
  expect(existsSync(join(dir, "files"))).toBe(false);
  agent.kill();
  await endTurn(agent.pid);
  await closedAs("idle", [nextTab]);
});

// From 09-26 to 10-05, 194 of 729 opens went to a site the same agent had
// opened earlier in its turn; on 10-05 one held tirerack.com in two tabs.
test("an open on a site where the agent already has a tab names that tab, and never another agent's", async () => {
  const [agent, other] = [Bun.spawn(["sleep", "60"]), Bun.spawn(["sleep", "60"])];
  const opened: number[] = [];
  const open = async (who: number, url: string) => {
    const { hint } = (await runAs(who, () => callTool("open", { url, background: true }))) as { hint?: string };
    opened.push(nextTab);
    showing.push({ id: nextTab, url });
    return hint;
  };
  await open(agent.pid, "https://shop.example/a");
  const mine = nextTab;
  await open(other.pid, "https://news.example/");
  expect(await open(agent.pid, "https://shop.example/b")).toContain(`tab ${mine} on shop.example`);
  expect(await open(agent.pid, "https://news.example/today")).toBeUndefined();
  agent.kill();
  other.kill();
  await Promise.all([endTurn(agent.pid), endTurn(other.pid)]);
  await closedAs("idle", opened);
  showing = [];
});

// 10-05: the hint did not stop one agent's tire research from holding
// tirerack.com in two of its 17 tabs.
test("a model's open loads in its agent's tab on that site, never in a form in progress, a kept tab, or another agent's, nor with new: true", async () => {
  const [agent, other] = [keeper(), Bun.spawn(["sleep", "60"])];
  type Opened = { id: number; windowId?: number; note?: string };
  const model = async (who: number, tool: string, args: Record<string, unknown>) => (await runAs(who, () => callTool(tool, args, true))) as Opened;
  const open = async (who: number, url: string, more: Record<string, unknown> = {}) => {
    const t = await model(who, "open", { url, background: true, ...more });
    if (!showing.some((s) => s.id === t.id)) showing.push({ id: t.id, url, windowId: t.windowId });
    return t.id;
  };
  const urlOf = (tab: number) => showing.find((s) => s.id === tab)?.url;
  const a = await open(agent.pid, "https://shop.example/a");
  const b = await model(agent.pid, "open", { url: "https://shop.example/b" });
  expect(b.id).toBe(a);
  expect(b.note).toContain("in place of https://shop.example/a");
  expect(urlOf(a)).toBe("https://shop.example/b");
  await model(agent.pid, "click", { tab: a, ref: "Next" });
  const c = await open(agent.pid, "https://shop.example/c");
  const his = await open(other.pid, "https://shop.example/d");
  await model(agent.pid, "keep", { tab: c });
  const e = await open(agent.pid, "https://shop.example/e");
  const f = await open(agent.pid, "https://shop.example/f", { new: true });
  expect(new Set([a, c, his, e, f]).size).toBe(5);
  expect([a, c, his].map(urlOf)).toEqual(["https://shop.example/b", "https://shop.example/c", "https://shop.example/d"]);
  // two opens at once take a tab each
  const both = await Promise.all(["g", "h"].map((p) => model(agent.pid, "open", { url: `https://shop.example/${p}` })));
  expect(both.map((t) => t.id).toSorted((x, y) => x - y)).toEqual([e, f].toSorted((x, y) => x - y));
  // map reads in tabs of its own, and closes only those
  const made = nextTab;
  await model(agent.pid, "map", { urls: ["https://shop.example/m"] });
  expect(nextTab).toBe(made + 1);
  expect([e, f].map(urlOf).toSorted()).toEqual(["https://shop.example/g", "https://shop.example/h"]);
  await Promise.all([endTurn(agent.pid), endTurn(other.pid)]);
  await closedAs("idle", [a, his, e, f]);
  agent.kill();
  other.kill();
  showing = [];
});

// 10-05: a sign-up retry loop ran its script in one session every 10
// minutes, and each run opened partiful.com in another tab.
test("a session's openTab of an address it opened in an earlier call loads that tab again, but opens another within one call or with new: true", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  // Safari lists each tab it opened, in the window it opened it in
  const invoke = async (tool: string, args: Record<string, unknown>, model?: boolean) => {
    const r = await runAs(agent.pid, () => callTool(tool, args, model));
    const t = r as { id: number; windowId?: number };
    if (tool === "open" && !showing.some((s) => s.id === t.id)) showing.push({ id: t.id, url: String(args.url), windowId: t.windowId });
    return r;
  };
  const repl = new ReplSession("retry", { cwd: mkdtempSync(join(tmpdir(), "repl-retry-")), invoke });
  // the value prints last, after any hint
  const ids = async (code: string) => JSON.parse((await repl.run(`JSON.stringify(${code})`)).output.split("\n").at(-1) ?? "") as number[];
  const open = "(await openTab('https://events.example/rsvp')).id";
  const [first] = await ids(`[${open}]`);
  const [again, second] = await ids(`[${open}, ${open}]`);
  const [fresh] = await ids("[(await openTab('https://events.example/rsvp', { new: true })).id]");
  expect([again, second === first, fresh === first || fresh === second]).toEqual([first, false, false]);
  agent.kill();
  await endTurn(agent.pid);
  await closedAs("idle", [first, second, fresh]);
  showing = [];
});

// He quit Safari: a sweep that asked it anything would start it again. An
// exited agent's tab then waits, unasked, for the extension to come back.
test("a sweep asks nothing of Safari while its extension is gone", async () => {
  bridge.detach(ext);
  const request = bridge.request;
  const asked: unknown[] = [];
  bridge.request = (...args: Parameters<typeof request>) => {
    asked.push(args[0]);
    return request.apply(bridge, args);
  };
  try {
    const exited = Bun.spawnSync(["true"]).pid;
    const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
    writeFileSync(file, JSON.stringify({ 31: exited }));
    loadTabs(file);
    await endTurn(exited);
    expect(asked).toEqual([]);
  } finally {
    bridge.request = request;
    connect(ext);
  }
});

// On 10-07 four deploys in three hours each gave a research agent's 13
// tabs a fresh 20 minutes, and they stayed open in his Safari. An agent
// that neither ends its turn nor exits kept its windows for good from 10-14.
// A page its next call cannot open again (10-21 review) is given 2 hours,
// as an agent waiting on a long job comes back to it.
test("after a restart a page left unused 20 minutes closes, one used since stays, and one that cannot open again waits 2 hours", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
  const ago = (minutes: number) => Date.now() - minutes * 60_000;
  const tabs = {
    9021: { owner: process.pid, used: ago(21), url: "https://plain.example/a" },
    9022: { owner: process.pid, used: ago(19), url: "https://plain.example/b" },
    9023: { owner: process.pid, used: ago(21), url: "https://clicked.example/", acted: true },
    9024: { owner: process.pid, used: ago(21), url: "https://app.example/#/orders/42" },
    9025: { owner: process.pid, used: ago(121), url: "https://clicked.example/", acted: true },
  };
  writeFileSync(file, JSON.stringify({ version: 2, tabs }));
  loadTabs(file);
  await endTurn(Bun.spawnSync(["true"]).pid);
  const ours = (ids: Iterable<string | number>) => [...ids].map(Number).filter((tab) => tab in tabs).sort((a, b) => a - b);
  expect(ours(closesAs("idle"))).toEqual([9021, 9025]);
  expect(ours(Object.keys(JSON.parse(readFileSync(file, "utf8")).tabs))).toEqual([9022, 9023, 9024]);
});

// A handoff page waits for the user to sign in after his agent's turn
// ended; the turn's end mark now outlives a restart, which closed it.
test("after a restart a handoff page its agent's turn ended on stays, and its other page closes", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "harness-tabs-")), "tabs.json");
  const used = Date.now() - 60_000;
  writeFileSync(file, JSON.stringify({ version: 2, tabs: { 9041: { owner: process.pid, used, url: "https://login.example/", done: true, handoff: true }, 9042: { owner: process.pid, used, url: "https://done.example/", done: true } } }));
  loadTabs(file);
  await endTurn(Bun.spawnSync(["true"]).pid);
  expect(closesAs("idle").filter((tab) => tab === 9041 || tab === 9042)).toEqual([9042]);
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).tabs).filter((tab) => tab === "9041" || tab === "9042")).toEqual(["9041"]);
});

// On 10-07 a tire-price agent held 42 tabs in his Safari within one turn.
test("opening a ninth tab preserves unfinished work until admitted cleanup", async () => {
  const agent = Bun.spawn(["sleep", "60"]);
  const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
  const tabs: number[] = [];
  for (let n = 0; n < 8; n++) {
    await as("open", { url: `https://shop${n}.example/`, background: true });
    tabs.push(nextTab);
  }
  showing = tabs.map((id, n) => ({ id, url: `https://shop${n}.example/` }));
  // the first is used again, so the second is the least recently used
  await as("info", { tab: tabs[0] });
  await as("open", { url: "https://shop8.example/", background: true });
  await endTurn(agent.pid + 1);
  expect(closesAs("idle").filter(tab => tabs.includes(tab))).toEqual([]);
  expect(await as("info", { tab: tabs[1] })).not.toHaveProperty("note");
  agent.kill();
  await endTurn(agent.pid);
  await closedAs("idle", [tabs[0]]);
  showing = [];
});
