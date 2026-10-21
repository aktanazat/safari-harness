import { afterEach, expect, jest, mock, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { CALLER_TOOLS } from "./caller.ts";
import { connect } from "./fake-safari.ts";
import { checkCall } from "./guard.ts";
import { runAs } from "./owner.ts";
import { callTool, TOOLS } from "./tools.ts";

// Calls a model wrote are checked and watched (guard.ts); /rpc marks them
// so with callTool's third argument. Safari is a fake that answers each
// request to a page at once, with what the test says the page holds, and
// records it as "tab op args". Each test's agent is its own, so no test
// sees another's calls.
function safari(page: (op: string, args: unknown[]) => { value: unknown } | { error: string }) {
  const sent: string[] = [];
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      if (op !== "relay") return queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, error: `no ${op} here` })));
      const [tab, dom, domArgs]: [number, string, unknown[]] = args;
      sent.push([tab, dom, ...domArgs.filter((a) => typeof a === "string")].join(" "));
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...page(dom, domArgs) })));
    },
    close() {},
  });
  return sent;
}

const model = (owner: number, tool: string, args: Record<string, unknown>) => runAs(owner, () => callTool(tool, args, true));

afterEach(() => {
  mock.restore();
  jest.useRealTimers();
});

test("the sixth call in a row with the same answer fails, telling the agent what to do instead", async () => {
  safari(() => ({ value: { url: "https://shop.example/cart", title: "Cart" } }));
  for (let i = 0; i < 5; i++) expect(await model(101, "info", { tab: 7 })).toMatchObject({ title: "Cart" });
  await expect(model(101, "info", { tab: 7 })).rejects.toThrow("you called info on tab 7 5 times and got the same page; the page is not changing: act, wait on text, or tell the user");
  // Another agent reading the same tab is counted on its own.
  expect(await model(102, "info", { tab: 7 })).toMatchObject({ title: "Cart" });
});

test("the same error six times in a row fails, saying that trying again will not help", async () => {
  safari(() => ({ error: "no element 5 on the page" }));
  for (let i = 0; i < 5; i++) await expect(model(103, "click", { tab: 7, ref: "5" })).rejects.toThrow("no element 5 on the page");
  await expect(model(103, "click", { tab: 7, ref: "5" })).rejects.toThrow("you called click on tab 7 5 times and got the same error (no element 5 on the page); trying again will not change it: try another way, or tell the user");
});

test("a read whose answer changes is never stopped, and neither is an action that keeps working", async () => {
  let n = 0;
  safari((op) => ({ value: op === "tabInfo" ? { title: `Results, page ${++n}` } : { ok: true } }));
  for (let i = 1; i <= 8; i++) {
    expect(await model(104, "click", { tab: 7, ref: "Next" })).toMatchObject({ ok: true });
    expect(await model(104, "info", { tab: 7 })).toMatchObject({ title: `Results, page ${i}` });
  }
});

// In the logs from 09-28 to 10-19 agents read a tab with snapshot in the
// turn after 373 actions on it, a page the action's own snapshot gives.
test("an owner's first snapshot of the tab its last action ran on says the action could have answered with it", async () => {
  safari((op) => ({ value: op === "snapshot" ? { url: "https://shop.example/cart", title: "Cart", nodes: 1, truncated: false, snapshot: "Total $42.10" } : { ok: true } }));
  await model(108, "click", { tab: 7, ref: "Next" });
  expect(await model(108, "snapshot", { tab: 8 })).not.toHaveProperty("note");
  await model(108, "click", { tab: 7, ref: "Next" });
  expect(await model(108, "snapshot", { tab: 7, query: "Total" })).toMatchObject({ note: 'next time pass snapshot: "Total" to click (CLI --snapshot=Total): its answer then has this page, one call instead of two' });
  await model(108, "click", { tab: 7, ref: "Next" });
  expect(await model(108, "snapshot", { tab: 7 })).not.toHaveProperty("note");
});

test("the same check after each new step is not a loop; after the same step again and again it is", async () => {
  safari((op) => ({ value: op === "tabInfo" ? { url: "https://shop.example/form", title: "Form" } : { ok: true } }));
  for (let i = 1; i <= 8; i++) {
    expect(await model(107, "type", { tab: 7, ref: `Field ${i}`, text: "x" })).toMatchObject({ ok: true });
    expect(await model(107, "info", { tab: 7 })).toMatchObject({ title: "Form" });
  }
  for (let i = 0; i < 5; i++) {
    await model(107, "click", { tab: 7, ref: "Save" });
    expect(await model(107, "info", { tab: 7 })).toMatchObject({ title: "Form" });
  }
  await model(107, "click", { tab: 7, ref: "Save" });
  await expect(model(107, "info", { tab: 7 })).rejects.toThrow("you called info on tab 7 5 times and got the same page; the page is not changing: act, wait on text, or tell the user");
});

test("a name written another way runs, with a note saying what was used", async () => {
  const sent = safari(() => ({ value: { ok: true } }));
  expect(await model(105, "Select", { tab: 7, ref: "3", value: "Blue" })).toEqual({ ok: true, note: "used select for Select; used option for value" });
  expect(sent).toEqual(["7 select 3 Blue"]);
});

test("a parameter the tool does not take fails before the page is asked, naming the nearest one", async () => {
  const sent = safari(() => ({ value: { ok: true } }));
  await expect(model(105, "select", { tab: 7, ref: "3", optoin: "Blue" })).rejects.toThrow("unknown parameter optoin for select; did you mean option? (params: tab, ref, option, snapshot)");
  expect(sent).toEqual([]);
});

// Names agents wrote in the 09-27 to 09-30 logs, and map's script on
// 10-05, each a failed call.
test.each([
  ["eval", "code", "expression"],
  ["history", "action", "do"],
  ["passwords", "action", "do"],
  ["learn", "note", "fact"],
  ["map", "mode", "what"],
  ["click", "text", "ref"],
  ["hover", "text", "ref"],
  ["snapshot", "selector", "root"],
  ["scroll", "y", "dy"],
  ["scroll", "x", "dx"],
  ["upload", "files", "paths"],
  ["shot", "path", "out"],
  ["download", "path", "out"],
  ["passwords", "account", "username"],
  ["map", "script", "expression"],
])("%s takes %s for %s, with a note saying so", (tool, alias, real) => {
  expect(checkCall(TOOLS, tool, { [alias]: "x" }, true)).toEqual({ tool, args: { [real]: "x" }, notes: [`used ${real} for ${alias}`] });
});

// press's text is the key it presses, if anything, never the element.
test("text names the ref only on the tools that take it so", () => {
  expect(() => checkCall(TOOLS, "press", { tab: 7, text: "Enter" }, true)).toThrow("unknown parameter text for press");
});

test("a real_input call written as the type tool's, or with press for key, runs as real_input's own", () => {
  expect(checkCall(CALLER_TOOLS, "real_input", { tab: 7, ref: "2", type: "a@example.com" }, true)).toEqual({ tool: "real_input", args: { tab: 7, ref: "2", do: "type", text: "a@example.com" }, notes: ['used do "type" and text for type'] });
  expect(checkCall(CALLER_TOOLS, "real_input", { tab: 7, do: "press", key: "Enter" }, true)).toEqual({ tool: "real_input", args: { tab: 7, do: "key", key: "Enter" }, notes: ['used do "key" for do "press"'] });
});

test("snapshot given an address says to open it first", () => {
  expect(() => checkCall(TOOLS, "snapshot", { url: "https://www.geico.com" }, true)).toThrow("snapshot reads the page a tab shows; open the url first (open) and pass its tab");
});

// On 10-05 and 10-08 map {max: 6000} and {max: 2500} meant to cut each
// page's text.
test("map given max says what keeps each page short instead", () => {
  expect(() => checkCall(TOOLS, "map", { urls: ["https://shop.example"], max: 2500 }, true)).toThrow("map takes no max: to keep each page's text short pass query (only lines with it) or selector");
});

test("waiting on the clock past a minute in 10 minutes gets a hint to wait on the page; a wait on text never does", async () => {
  jest.useFakeTimers();
  // A page that never goes quiet holds a wait with only ms all of its ms.
  safari((op, args) => {
    if (op === "wait" && args[1] && typeof args[1] === "object" && !("text" in args[1] && args[1].text)) jest.advanceTimersByTime(30_000);
    return { value: { found: true } };
  });
  const sleep = () => model(106, "wait", { tab: 7, ms: 30_000 });
  expect(await sleep()).not.toHaveProperty("hint");
  expect(await sleep()).not.toHaveProperty("hint");
  expect(await sleep()).toMatchObject({ ok: true, hint: "you slept 90 s in the last 10 minutes; wait on the page instead: with text or a selector it returns once the page shows them, with changed: true (a script's page.waitForChange()) once new lines appear" });
  expect(await model(106, "wait", { tab: 7, text: "Saved" })).not.toHaveProperty("hint");
  // Sleeps older than 10 minutes no longer count.
  jest.advanceTimersByTime(10 * 60_000);
  expect(await sleep()).not.toHaveProperty("hint");
});

// In the two weeks of logs before 10-19 every wait past the budget carried
// the hint: 125 answers did, and agents cut it from their output with grep
// 50 times, 44 in one session.
test("an agent that keeps sleeping is told once, again when its total doubles, and again 10 minutes on", async () => {
  jest.useFakeTimers();
  safari((op) => {
    if (op === "wait") jest.advanceTimersByTime(30_000);
    return { value: { found: true } };
  });
  // 32 sleeps of 30 s in a row; the last 10 minutes hold 20 of them at most.
  const told: number[] = [];
  for (let i = 1; i <= 32; i++) {
    const r = await model(111, "wait", { tab: 7, ms: 30_000 });
    if (r && typeof r === "object" && "hint" in r) told.push(i);
  }
  // at 90 s, 180 s and 360 s, then at 600 s, 10 minutes after the 360 s
  expect(told).toEqual([3, 6, 12, 32]);
});

// 10-05 to 10-19: in 17 stuck spells agents' calls failed at once 44
// times, each telling the agent to reload the extension, and agents ran
// safari extension reload 27 times.
test("a model's call that meets a stuck extension has it reloaded inside the call, and its answer says so", async () => {
  jest.useFakeTimers();
  const asked: string[] = [];
  connect({ send: (data: string) => void asked.push(JSON.parse(data).op), close() {} });
  jest.advanceTimersByTime(20_000);
  for (let i = 0; i < 2; i++) {
    const listed = bridge.request("tabs.list", [], 5000);
    await new Promise<void>((r) => setImmediate(r));
    jest.advanceTimersByTime(5000);
    await expect(listed).rejects.toThrow("timed out");
  }
  const call = model(109, "tabs", {});
  await new Promise<void>((r) => setImmediate(r));
  expect(asked).toEqual(["tabs.list", "tabs.list", "reload"]);
  jest.advanceTimersByTime(3000);
  connect({
    send(data: string) {
      const { id } = JSON.parse(data);
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value: [] })));
    },
    close() {},
  });
  expect(await call).toMatchObject({ note: "the extension was stuck; reloaded in 3 s" });
});
