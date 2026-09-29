import { afterEach, expect, jest, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
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
    expect(await model(104, "info", { tab: 7 })).toEqual({ title: `Results, page ${i}` });
  }
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

// Names agents wrote in the 09-27 to 09-29 logs, each a failed call.
test.each([
  ["eval", "code", "expression"],
  ["history", "action", "do"],
  ["passwords", "action", "do"],
  ["learn", "note", "fact"],
  ["map", "mode", "what"],
])("%s takes %s for %s, with a note saying so", (tool, alias, real) => {
  expect(checkCall(TOOLS, tool, { [alias]: "x" }, true)).toEqual({ tool, args: { [real]: "x" }, notes: [`used ${real} for ${alias}`] });
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
  expect(await sleep()).toMatchObject({ ok: true, hint: "you slept 90 s in the last 10 minutes; wait with text or selector instead: it returns as soon as the page shows it" });
  expect(await model(106, "wait", { tab: 7, text: "Saved" })).not.toHaveProperty("hint");
  // Sleeps older than 10 minutes no longer count.
  jest.advanceTimersByTime(10 * 60_000);
  expect(await sleep()).not.toHaveProperty("hint");
});
