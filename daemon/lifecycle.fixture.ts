// An isolated extension boundary for lifecycle contracts. No server or Safari
// is launched; separate processes exercise the actual durable tab checkpoint.
import { jest, setSystemTime } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { files } from "./groups.ts";
import { runAs, watchOwner } from "./owner.ts";
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
let gate: { op: string; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
let refused = false;
let clicks = 0;
let opened = 0;
let evaluations = 0;
let submissions = 0;
const extension = {
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
    if (!id) return;
    void (async () => {
      if (op === gate?.op) { gate.entered.resolve(); await gate.release.promise; }
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
        value = args[1] === "extract" ? { text: "fixture result", title: "Fixture", url: tab.url } : { ok: true };
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

if (mode === "restart" || mode === "action" || mode === "fresh-eval" || mode === "fresh-post" || mode === "foreign") {
  const saved = JSON.parse(readFileSync(browser, "utf8")) as { tabs: Tab[]; reading: number; form: number; site: number; unsafe: number };
  for (const tab of saved.tabs) tabs.set(tab.id, tab);
  next = 200;
  loadTabs(state); loadSpaces(join(directory, "spaces.json"));
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
  loadTabs(state); loadSpaces(join(directory, "spaces.json"));
  if (mode === "recovery-title") {
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
    const retry = await endTurn(owner);
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
