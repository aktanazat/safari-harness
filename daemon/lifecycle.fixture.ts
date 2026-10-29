// An isolated extension boundary for lifecycle contracts. No server or Safari
// is launched; separate processes exercise the actual durable tab checkpoint.
import { jest, setSystemTime } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect, historyFixture } from "./fake-safari.ts";
import { files } from "./groups.ts";
import { tracksOwner } from "./mission.ts";
import { runAs, watchOwner } from "./owner.ts";
import * as front from "./front.ts";
import { loadSpaces } from "./spaces.ts";
import { ReplSession } from "./repl.ts";
import { callTool, closeTabsOf, endTurn, prepareTurnEnd, loadTabs, recentlyClosedTabs, restoreClosedTab } from "./tools.ts";
import { keepSecret } from "./redact.ts";

const [directory, mode, who] = process.argv.slice(2);
const owner = Number(who);
const state = join(directory, "tabs.json");
const browser = join(directory, "browser.json");
Object.assign(files, { queue: join(directory, "groups.json"), off: join(directory, "off.json"), keeper: join(directory, "keeper.pid"), log: join(directory, "keeper.log") });
writeFileSync(files.off, JSON.stringify({ why: "isolated lifecycle fixture" }));
type Tab = { id: number; url: string; title?: string; windowId: number; typed?: true; front?: true };
const tabs = new Map<number, Tab>();
let next = 100;
let gate: { op: string; tab?: number; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
let refused = false;
let clicks = 0;
let opened = 0;
let evaluations = 0;
let handoffDone = false;
const pageHistory = historyFixture();
let submissions = 0;
const extension = {
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
    if (!id) return;
    void (async () => {
      if (op === gate?.op && (gate.tab === undefined || Number(args[0]) === gate.tab)) { gate.entered.resolve(); await gate.release.promise; }
      let value: unknown = { ok: true };
      if (op === "tabs.list") value = [...tabs.values()];
      else if (op === "probe") value = [];
      else if (op === "windows.resolve") value = [...tabs.values()].some(t => t.windowId === args[0]) ? args[0] : null;
      else if (op === "windows.open") {
        const tab = { id: ++next, url: String(args[0]), windowId: ++next };
        tabs.set(tab.id, tab); value = { tabId: tab.id, windowId: tab.windowId };
      } else if (op === "tabs.open") {
        const tab = { id: ++next, url: String(args[0]), windowId: Number(args[2]) };
        tabs.set(tab.id, tab); opened++; value = tab;
      } else if (op === "tabs.close") {
        if (refused) value = { ok: false };
        else if (args[1] === "idle" && tabs.get(Number(args[0]))?.typed) value = { ok: false, protected: "form" };
        else if (args[1] === "idle" && tabs.get(Number(args[0]))?.front) value = { ok: false, front: true };
        else tabs.delete(Number(args[0]));
      } else if (op === "relay") {
        const tab = tabs.get(Number(args[0]));
        if (!tab) { bridge.handleMessage(JSON.stringify({ id, error: "that tab is gone: it was closed" })); return; }
        if (args[1] === "click") clicks++;
        if (args[1] === "type") tab.typed = true;
        if (args[1] === "eval" && !tab.url.includes("/space?")) evaluations++;
        if (args[1] === "fetch") submissions++;
        value = args[1] === "extract" ? { text: "fixture result", title: "Fixture", url: tab.url }
          : args[1] === "wait" ? { found: handoffDone }
          : args[1] === "eval" && tab.url.includes("/space?") ? { result: pageHistory(tab.id, String((args[2] as unknown[])[0])) }
          : { ok: true };
      }
      bridge.handleMessage(JSON.stringify({ id, value }));
    })();
  },
  close() {},
};
connect(extension);
const invoke = (tool: string, args: Record<string, unknown> = {}) => runAs(owner, () => callTool(tool, args));
const open = async (path: string, more: Record<string, unknown> = {}) => (await invoke("open", { url: `https://fixture.example/${path}`, background: true, ...more })) as Tab;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

if (mode === "helper-restart") {
  const saved = JSON.parse(readFileSync(browser, "utf8")) as { tabs: Tab[]; first: number; second: number; main: number; kept: number; personal: number; window: number };
  const aliases: Record<number, number> = {};
  for (const tab of saved.tabs) {
    aliases[tab.id] = tab.id + 1000;
    tabs.set(tab.id + 1000, { ...tab, id: tab.id + 1000 });
  }
  loadTabs(state);
  loadSpaces(join(directory, "spaces.json"), tracksOwner);
  bridge.handleMessage(JSON.stringify({ op: "tab", kind: "renumbered", tabs: aliases }));
  await runAs(owner, () => callTool("extract", { tab: aliases[saved.second] }), "fixture:second");
  await endTurn(owner + 1);
  console.log(JSON.stringify({ first: tabs.has(aliases[saved.first]), second: tabs.has(aliases[saved.second]), main: tabs.has(aliases[saved.main]), kept: tabs.has(aliases[saved.kept]), personal: tabs.has(aliases[saved.personal]), firstWindow: [...tabs.values()].some(tab => tab.windowId === saved.window) }));
} else if (mode.startsWith("helper-")) {
  loadTabs(state);
  loadSpaces(join(directory, "spaces.json"), () => true);
  const asTask = (task: string, tool: string, args: Record<string, unknown>) => runAs(owner, () => callTool(tool, args), task);
  const openTask = (task: string, path: string, more: Record<string, unknown> = {}) => asTask(task, "open", { url: `https://fixture.example/${path}`, background: true, group: "research", ...more }) as Promise<Tab>;
  const main = await openTask("fixture:main", "main");
  const shared = mode === "helper-reversed-restore";
  const first = await openTask("fixture:first", shared ? "shared" : "first");
  const second = await openTask("fixture:second", shared ? "shared" : "second");
  const kept = await openTask("fixture:first", "kept", { keep: true, group: "kept" });
  const personal = ++next;
  tabs.set(personal, { id: personal, url: "https://personal.example/", windowId: 1 });
  if (mode === "helper-seed") {
    bridge.detach(extension);
    const prepared = await prepareTurnEnd(owner, "fixture:first");
    const receipt = await endTurn(owner, prepared, "fixture:first");
    writeFileSync(browser, JSON.stringify({ tabs: [...tabs.values()], first: first.id, second: second.id, main: main.id, kept: kept.id, personal, window: first.windowId }));
    console.log(JSON.stringify({ deferred: receipt.deferred, retained: receipt.retained }));
  } else if (mode === "helper-background-handoff") {
    jest.useFakeTimers();
    jest.spyOn(front, "input").mockImplementation(async () => ({ bundleId: "com.apple.mail" }));
    jest.spyOn(front, "notify").mockImplementation(() => {});
    const result = await openTask("fixture:first", "finished", { group: "finished" });
    await asTask("fixture:first", "handoff_wait", { tab: first.id, why: "Finish the fixture check", until: "saved", ms: 0, away: true, background: true });
    for (let n = 0; n < 2; n++) { jest.advanceTimersByTime(1000); await flush(); }
    const prepared = await prepareTurnEnd(owner, "fixture:first");
    const receipt = await endTurn(owner, prepared, "fixture:first");
    const pending = { handoff: tabs.has(first.id), result: tabs.has(result.id), second: tabs.has(second.id), main: tabs.has(main.id), kept: tabs.has(kept.id), personal: tabs.has(personal) };
    handoffDone = true;
    for (let n = 0; n < 2; n++) { jest.advanceTimersByTime(1000); await flush(); }
    await endTurn(owner, undefined, "fixture:first");
    console.log(JSON.stringify({ pending, afterUser: tabs.has(first.id), receipt }));
    jest.useRealTimers();
  } else if (mode === "helper-reversed-restore") {
    const before = [...tabs.values()];
    tabs.clear();
    for (const row of before) {
      const id = 11000 - row.id;
      tabs.set(id, { ...row, id, windowId: row.windowId + 1000 });
      const state = pageHistory(row.id, "history.state");
      if (state !== null) pageHistory(id, `history.replaceState(${JSON.stringify(state)})`);
    }
    bridge.detach(extension);
    setSystemTime(new Date(Date.now() + 1000));
    connect(extension);
    await asTask("fixture:second", "tabs", { all: true });
    const prepared = await prepareTurnEnd(owner, "fixture:first");
    const receipt = await endTurn(owner, prepared, "fixture:first");
    console.log(JSON.stringify({ first: tabs.has(11000 - first.id), second: tabs.has(11000 - second.id), main: tabs.has(11000 - main.id), kept: tabs.has(11000 - kept.id), personal: tabs.has(11000 - personal), receipt }));
  } else if (["helper-busy", "helper-sibling-busy", "helper-shared-read", "helper-shared-front"].includes(mode)) {
    const target = mode === "helper-sibling-busy" ? second : first;
    const task = mode === "helper-busy" ? "fixture:first" : "fixture:second";
    gate = { op: "relay", tab: target.id, entered: Promise.withResolvers(), release: Promise.withResolvers() };
    if (mode === "helper-shared-front") tabs.get(first.id)!.front = true;
    const running = asTask(task, "extract", { tab: mode === "helper-shared-front" ? "front" : target.id });
    await gate.entered.promise;
    let reported = false;
    const ending = endTurn(owner, undefined, "fixture:first").then(receipt => { reported = true; return receipt; });
    for (let n = 0; n < 10; n++) await flush();
    const whileBusy = { reported, first: tabs.has(first.id), second: tabs.has(second.id) };
    gate.release.resolve();
    await running;
    const receipt = await ending;
    console.log(JSON.stringify({ whileBusy, first: tabs.has(first.id), second: tabs.has(second.id), main: tabs.has(main.id), receipt }));
  } else {
    const prepared = await prepareTurnEnd(owner, "fixture:first");
    if (mode === "helper-stale") await asTask("fixture:first", "extract", { tab: first.id });
    else await asTask("fixture:second", "extract", { tab: second.id });
    if (mode === "helper-foreign") prepared.task = "fixture:second";
    const receipt = await endTurn(owner, prepared, "fixture:first");
    const afterHelper = { first: tabs.has(first.id), second: tabs.has(second.id), main: tabs.has(main.id), kept: tabs.has(kept.id), personal: tabs.has(personal), firstWindow: [...tabs.values()].some(tab => tab.windowId === first.windowId) };
    await endTurn(owner);
    console.log(JSON.stringify({ separateWindows: new Set([main.windowId, first.windowId, second.windowId]).size === 3, afterHelper, afterMain: { main: tabs.has(main.id), second: tabs.has(second.id), kept: tabs.has(kept.id), personal: tabs.has(personal) }, receipt }));
  }
} else
if (["deferred-restart", "deferred-resume", "deferred-same-restart", "deferred-same-resume"].includes(mode)) {
  const saved = JSON.parse(readFileSync(browser, "utf8")) as { tabs: Tab[]; disposable: number[]; kept: number; handoff: number; personal: number; window: number };
  const aliases: Record<number, number> = {};
  for (const tab of saved.tabs) {
    const id = tab.id + (mode.startsWith("deferred-same-") ? 0 : 1000);
    aliases[tab.id] = id;
    tabs.set(id, { ...tab, id });
  }
  loadTabs(state);
  loadSpaces(join(directory, "spaces.json"), tracksOwner);
  bridge.handleMessage(JSON.stringify({ op: "tab", kind: "renumbered", tabs: aliases }));
  if (mode.endsWith("-resume")) await invoke("extract", { tab: aliases[saved.disposable[0]] });
  await endTurn(owner + 1);
  await flush();
  console.log(JSON.stringify({
    disposable: saved.disposable.map(id => tabs.has(aliases[id])),
    kept: tabs.has(aliases[saved.kept]), handoff: tabs.has(aliases[saved.handoff]), personal: tabs.has(aliases[saved.personal]),
    completedWindow: [...tabs.values()].some(tab => tab.windowId === saved.window),
  }));
} else if (mode === "live-seed") {
  loadTabs(state); loadSpaces(join(directory, "spaces.json"), () => true);
  const plain = await open("live-result");
  const form = await open("live-form");
  await invoke("type", { tab: form.id, ref: "input", text: "unsent fixture text" });
  const front = await open("live-front");
  tabs.get(front.id)!.front = true;
  const kept = await open("live-kept", { keep: true });
  const handoff = await open("live-handoff");
  const recent = await open("live-recent");
  const personal = ++next;
  tabs.set(personal, { id: personal, url: "https://personal.example/", windowId: 1 });
  // A pending handoff is durable even though its wait belonged to the old daemon.
  const checkpoint = JSON.parse(readFileSync(state, "utf8")) as { tabs: Record<string, { handoff?: true }> };
  checkpoint.tabs[handoff.id].handoff = true;
  writeFileSync(state, JSON.stringify(checkpoint));
  writeFileSync(browser, JSON.stringify({ tabs: [...tabs.values()], plain: plain.id, form: form.id, front: front.id, kept: kept.id, handoff: handoff.id, recent: recent.id, personal }));
  console.log(JSON.stringify({ seeded: true }));
} else if (mode === "live-restart" || mode === "live-restart-idle" || mode === "live-restart-completed") {
  const saved = JSON.parse(readFileSync(browser, "utf8")) as { tabs: Tab[]; plain: number; form: number; front: number; kept: number; handoff: number; recent: number; personal: number };
  for (const tab of saved.tabs) tabs.set(tab.id, tab);
  if (mode === "live-restart-idle") {
    const checkpoint = JSON.parse(readFileSync(state, "utf8")) as { tabs: Record<string, { used: number }> };
    for (const id of [saved.plain, saved.form, saved.front, saved.handoff]) checkpoint.tabs[id].used = Date.now() - 21 * 60_000;
    writeFileSync(state, JSON.stringify(checkpoint));
  }
  loadTabs(state); loadSpaces(join(directory, "spaces.json"), tracksOwner);
  // No call has rebuilt this owner's in-memory mission record.
  await endTurn(mode === "live-restart-completed" ? owner : owner + 1);
  await flush();
  console.log(JSON.stringify({
    plain: tabs.has(saved.plain), form: tabs.has(saved.form), front: tabs.has(saved.front),
    kept: tabs.has(saved.kept), handoff: tabs.has(saved.handoff), recent: tabs.has(saved.recent),
    personal: tabs.has(saved.personal), marker: [...tabs.values()].some(tab => tab.url.includes("/space?")),
  }));
} else if (mode === "restart" || mode === "action" || mode === "fresh-eval" || mode === "fresh-post" || mode === "foreign") {
  const saved = JSON.parse(readFileSync(browser, "utf8")) as { tabs: Tab[]; reading: number; form: number; site: number; unsafe: number };
  for (const tab of saved.tabs) tabs.set(tab.id, tab);
  next = 200;
  loadTabs(state); loadSpaces(join(directory, "spaces.json"), () => true);
  if (mode === "action" || mode === "fresh-eval" || mode === "fresh-post") {
    let error = "";
    const tool = mode === "action" ? "click" : mode === "fresh-eval" ? "eval" : "fetch";
    try { await invoke(tool, { tab: saved.reading, ref: "Submit", expression: "window.fixtureSubmitted = true", url: "https://fixture.example/submit", method: "POST", body: "fixture" }); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    console.log(JSON.stringify({ opened, clicks, evaluations, submissions, error }));
  } else if (mode === "foreign") {
    let error = "";
    try { await runAs(owner + 1, () => callTool("extract", { tab: saved.reading })); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    console.log(JSON.stringify({ opened, error }));
  } else {
    const results = await Promise.all([invoke("extract", { tab: saved.reading }), invoke("extract", { tab: saved.reading })]);
    await endTurn(owner);
    console.log(JSON.stringify({ opened, results, protected: [saved.form, saved.site, saved.unsafe].map(tab => tabs.has(tab)), savedText: readFileSync(state, "utf8").includes("unsent fixture text"), savedCredential: readFileSync(state, "utf8").includes("credential-fixture") }));
  }
} else {
  loadTabs(state); loadSpaces(join(directory, "spaces.json"), () => true);
  if (mode === "deferred-seed") {
    const plain = await open("deferred-result");
    const form = await open("deferred-form");
    await invoke("type", { tab: form.id, ref: "input", text: "unsent fixture text" });
    const site = await open("deferred-site", { site: true });
    const unsafe = await open("callback?token=credential-fixture");
    const kept = await open("deferred-kept", { keep: true, group: "kept" });
    const handoff = await open("deferred-handoff", { group: "handoff" });
    const checkpoint = JSON.parse(readFileSync(state, "utf8")) as { tabs: Record<string, { handoff?: true }> };
    checkpoint.tabs[handoff.id].handoff = true;
    writeFileSync(state, JSON.stringify(checkpoint));
    loadTabs(state);
    const personal = ++next;
    tabs.set(personal, { id: personal, url: "https://personal.example/", windowId: 1 });
    bridge.detach(extension);
    const receipt = await endTurn(owner);
    writeFileSync(browser, JSON.stringify({ tabs: [...tabs.values()], disposable: [plain.id, form.id, site.id, unsafe.id], kept: kept.id, handoff: handoff.id, personal, window: plain.windowId }));
    console.log(JSON.stringify({ deferred: receipt.deferred, retained: receipt.retained }));
  } else if (mode === "remap-completed") {
    const unsafe = await open("callback?token=credential-fixture");
    const kept = await open("remap-kept", { keep: true });
    loadTabs(state);
    bridge.detach(extension);
    setSystemTime(new Date(Date.now() + 1000));
    connect(extension);
    const alias = unsafe.id + 1000;
    tabs.set(alias, { ...tabs.get(unsafe.id)!, id: alias });
    tabs.delete(unsafe.id);
    bridge.handleMessage(JSON.stringify({ op: "tab", kind: "renumbered", tabs: { [unsafe.id]: alias } }));
    await endTurn(owner);
    console.log(JSON.stringify({ disposable: tabs.has(alias), kept: tabs.has(kept.id) }));
  } else if (mode === "recovery-title") {
    const tab = await open("mail");
    tabs.get(tab.id)!.title = "123456 is your password reset code — private-value-fixture";
    keepSecret(tab.id, "private-value-fixture");
    await endTurn(owner);
    const saved = readFileSync(state, "utf8");
    const listed = JSON.stringify(recentlyClosedTabs());
    console.log(JSON.stringify({
      savedCode: saved.includes("123456"),
      savedKnownSecret: saved.includes("private-value-fixture"),
      listedCode: listed.includes("123456"),
      listedKnownSecret: listed.includes("private-value-fixture"),
    }));
  } else if (mode === "recovery-user-first" || mode === "recovery-agent-first") {
    const tab = await open("race");
    await endTurn(owner);
    opened = 0;
    gate = { op: "tabs.open", entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const user = () => restoreClosedTab(tab.id).then(() => true, () => false);
    const agent = () => invoke("extract", { tab: tab.id }).then(() => true, () => false);
    const first = mode === "recovery-user-first" ? user() : agent();
    await gate.entered.promise;
    const second = mode === "recovery-user-first" ? agent() : user();
    await flush();
    gate.release.resolve();
    const [firstSucceeded, secondSucceeded] = await Promise.all([first, second]);
    console.log(JSON.stringify({ pagesOpened: opened, firstSucceeded, secondSucceeded }));
  } else if (mode === "seed") {
    const reading = await open("result");
    const form = await open("form");
    await invoke("type", { tab: form.id, ref: "input", text: "unsent fixture text" });
    const site = await open("site", { site: true });
    const unsafe = await open("callback?token=credential-fixture");
    const receipt = await endTurn(owner);
    writeFileSync(browser, JSON.stringify({ tabs: [...tabs.values()], reading: reading.id, form: form.id, site: site.id, unsafe: unsafe.id }));
    const checkpoint = readFileSync(state, "utf8");
    console.log(JSON.stringify({ receipt, protected: [form.id, site.id, unsafe.id].map(tab => tabs.has(tab)), savedText: checkpoint.includes("unsent fixture text"), savedCredential: checkpoint.includes("credential-fixture") }));
  } else if (mode === "recover" || mode === "recovery-expiry" || mode === "recovery-timer") {
    const start = Date.now();
    setSystemTime(new Date(start));
    const result = await open("recover");
    const unsafe = await open("callback?token=credential-fixture");
    await endTurn(owner);
    const before = recentlyClosedTabs();
    if (mode === "recover") {
      const recovered = await Promise.all([restoreClosedTab(result.id), restoreClosedTab(result.id)]);
      await endTurn(owner);
      let ownerAccessRefused = false;
      try { await invoke("extract", { tab: result.id }); } catch { ownerAccessRefused = true; }
      const checkpoint = JSON.parse(readFileSync(state, "utf8")) as { tabs: Record<string, unknown> };
      console.log(JSON.stringify({
        listed: before.some(tab => tab.tab === result.id),
        unsafeListed: before.some(tab => tab.tab === unsafe.id),
        samePage: recovered[0].id === recovered[1].id,
        reopened: recovered[0].url,
        userPageRemains: tabs.has(recovered[0].id),
        userPageOwned: Object.hasOwn(checkpoint.tabs, recovered[0].id),
        listedAfterReopen: recentlyClosedTabs().some(tab => tab.tab === result.id),
        ownerAccessRefused,
      }));
    } else if (mode === "recovery-timer") {
      jest.useFakeTimers();
      try {
        setSystemTime(new Date(start + 5 * 60_000 - 1));
        loadTabs(state);
        setSystemTime(new Date(start + 5 * 60_000));
        jest.advanceTimersByTime(1);
        const checkpoint = JSON.parse(readFileSync(state, "utf8")) as { closed: Record<string, unknown> };
        console.log(JSON.stringify({ expiredAutomatically: !Object.hasOwn(checkpoint.closed, result.id), residentPages: tabs.size }));
      } finally {
        jest.useRealTimers();
      }
    } else {
      setSystemTime(new Date(start + 5 * 60_000 - 1));
      const beforeExpiry = recentlyClosedTabs().some(tab => tab.tab === result.id);
      setSystemTime(new Date(start + 5 * 60_000));
      const afterExpiry = recentlyClosedTabs().some(tab => tab.tab === result.id);
      let refused = false;
      try { await restoreClosedTab(result.id); } catch { refused = true; }
      const checkpoint = JSON.parse(readFileSync(state, "utf8")) as { closed: Record<string, unknown> };
      console.log(JSON.stringify({ beforeExpiry, afterExpiry, refused, persisted: Object.hasOwn(checkpoint.closed, result.id) }));
    }
    setSystemTime();
  } else if (mode === "refusal") {
    const tab = await open("refused"); refused = true;
    const receipt = await endTurn(owner);
    refused = false;
    setSystemTime(new Date(Date.now() + 60_000));
    const retry = await endTurn(owner);
    setSystemTime();
    console.log(JSON.stringify({ receipt, retry, remaining: tabs.has(tab.id) }));
  } else if (mode === "cancel") {
    const plain = await open("result");
    const form = await open("form"); await invoke("type", { tab: form.id, ref: "input", text: "unsent fixture text" });
    closeTabsOf(owner); await endTurn(owner);
    console.log(JSON.stringify({ plain: tabs.has(plain.id), form: tabs.has(form.id) }));
  } else if (mode === "session") {
    const repl = new ReplSession("fixture", { cwd: directory, invoke });
    await repl.run("await openTab('https://fixture.example/form')");
    const tab = repl.tabs[0].id;
    await invoke("type", { tab, ref: "input", text: "unsent fixture text" });
    await repl.close();
    console.log(JSON.stringify({ retainedForm: tabs.has(tab) }));
  } else if (mode === "idle-cleanup" || mode === "exit-cleanup") {
    const plain = await open("result");
    await invoke("click", { tab: plain.id, ref: "Read more" });
    const form = await open("form");
    await invoke("type", { tab: form.id, ref: "input", text: "unsent fixture text" });
    const kept = await open("kept", { keep: true });
    const front = await open("front");
    tabs.get(front.id)!.front = true;
    const recent = await open("recent");
    const saved = JSON.parse(readFileSync(state, "utf8")) as { version: number; tabs: Record<string, { used: number }> };
    for (const [id, recorded] of Object.entries(saved.tabs)) if (Number(id) !== recent.id) recorded.used = Date.now() - 21 * 60_000;
    writeFileSync(state, JSON.stringify(saved));
    loadTabs(state);
    if (mode === "exit-cleanup") {
      const dead = Bun.spawnSync(["true"]).pid;
      for (const recorded of Object.values(saved.tabs)) Object.assign(recorded, { owner: dead });
      writeFileSync(state, JSON.stringify(saved));
      loadTabs(state);
      const exited = Promise.withResolvers<void>();
      watchOwner(dead, exited.resolve);
      await exited.promise;
    }
    await endTurn(owner + 1);
    console.log(JSON.stringify({ plain: tabs.has(plain.id), form: tabs.has(form.id), kept: tabs.has(kept.id), front: tabs.has(front.id), recent: tabs.has(recent.id) }));
  } else if (mode === "aged" || mode === "cap" || mode === "stopped") {
    const plain = await open("unfinished");
    if (mode === "cap") for (let n = 0; n < 8; n++) await open(`unfinished-${n}`);
    if (mode === "stopped") closeTabsOf(owner);
    if (mode === "aged") {
      writeFileSync(state, JSON.stringify({ version: 2, tabs: { [plain.id]: { owner, used: 0, url: plain.url } } }));
      loadTabs(state);
    }
    await endTurn(owner + 1);
    console.log(JSON.stringify({ retained: tabs.has(plain.id), residentPages: [...tabs.values()].filter(tab => tab.url.startsWith("https:")).length }));
  } else if (mode === "prepared" || mode === "stale-prepare" || mode === "foreign-prepare") {
    const tab = await open("prepared-result");
    const prepared = await prepareTurnEnd(owner);
    const retainedAfterPrepare = tabs.has(tab.id);
    if (mode === "stale-prepare") await invoke("extract", { tab: tab.id });
    if (mode === "foreign-prepare") prepared.owner = owner + 1;
    const receipt = await endTurn(owner, prepared);
    console.log(JSON.stringify({ retainedAfterPrepare, remaining: tabs.has(tab.id), receipt }));
  } else if (mode === "prepare-busy") {
    const tab = await open("busy-result");
    gate = { op: "relay", entered: Promise.withResolvers(), release: Promise.withResolvers() };
    const running = invoke("extract", { tab: tab.id });
    await gate.entered.promise;
    let preparedWhileBusy = false;
    const preparing = prepareTurnEnd(owner).then(prepared => { preparedWhileBusy = true; return prepared; });
    await flush();
    const before = { prepared: preparedWhileBusy, retained: tabs.has(tab.id) };
    gate.release.resolve();
    await running;
    const prepared = await preparing;
    const retainedAfterPrepare = tabs.has(tab.id);
    const receipt = await endTurn(owner, prepared);
    console.log(JSON.stringify({ before, retainedAfterPrepare, remaining: tabs.has(tab.id), receipt }));
  } else {
    const tab = await open("result");
    const kept = await open("kept", { keep: true });
    gate = { op: mode === "completion" ? "tabs.close" : mode === "late-open" ? "tabs.open" : "relay", entered: Promise.withResolvers(), release: Promise.withResolvers() };
    const running = mode === "completion" ? undefined : mode === "late-open" ? invoke("open", { url: "https://fixture.example/late", background: true }) : mode === "nested-run" ? invoke("run", { steps: [{ tool: "extract", args: { tab: tab.id } }, { tool: "extract", args: { tab: tab.id } }] }) : invoke("extract", { tab: tab.id });
    const ending = mode === "completion" ? endTurn(owner) : undefined;
    await gate.entered.promise;
    const done = ending ?? endTurn(owner);
    let reported = false; void Promise.resolve(done).then(() => { reported = true; });
    await flush();
    const retainedWhileBusy = tabs.has(tab.id);
    const reportedWhileBusy = reported;
    gate.release.resolve();
    await running;
    const receipt = await done;
    console.log(JSON.stringify({ retainedWhileBusy, reportedWhileBusy, remaining: tabs.has(tab.id), kept: tabs.has(kept.id), residentPages: [...tabs.values()].filter(t => t.url.startsWith("https:") && t.id !== kept.id).length, receipt }));
  }
}
bridge.detach(extension);
process.exit(0);
