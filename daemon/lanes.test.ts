import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { runAs } from "./owner.ts";
import { callTool } from "./tools.ts";

// One acting call at a time on a tab (lanes.ts). Safari is a fake: it
// records each request sent to a page as "tab op ref", holds the answers
// to clicks and waits until the test gives them, and answers the rest at
// once. A request on the ref gone fails, as one on a ref the page no
// longer has does.
function safari() {
  const sent: string[] = [];
  const held = new Map<string, () => void>();
  bridge.attach({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      if (op !== "relay") return queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, error: `no ${op} here` })));
      const [tab, dom, domArgs]: [number, string, unknown[]] = args;
      const what = [tab, dom, ...(typeof domArgs[0] === "string" ? [domArgs[0]] : [])].join(" ");
      sent.push(what);
      const reply = domArgs[0] === "gone" ? { error: "no element gone on the page" } : { value: dom === "wait" ? { found: true } : { ok: true } };
      const answer = () => bridge.handleMessage(JSON.stringify({ id, ...reply }));
      if (dom === "click" || dom === "wait") held.set(what, answer);
      else queueMicrotask(answer);
    },
    close() {},
  });
  return {
    sent,
    answer(what: string) {
      held.get(what)?.();
      held.delete(what);
    },
  };
}

// The agent that holds the tab, by its process name in the busy message,
// and another caller.
const agent = Bun.spawn(["sleep", "60"]);
afterAll(() => agent.kill());
const other = process.pid;

const as = (owner: number, tool: string, args: Record<string, unknown>) => runAs(owner, () => callTool(tool, args));

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => new Promise<void>((r) => setImmediate(r));

afterEach(() => {
  jest.useRealTimers();
});

test("acting calls on a tab another call is acting on wait their turns in order; one on another tab does not wait", async () => {
  const page = safari();
  const first = as(agent.pid, "click", { tab: 7, ref: "1" });
  await settled();
  const second = as(other, "click", { tab: 7, ref: "2" });
  await settled();
  const third = as(other, "type", { tab: 7, ref: "3", text: "hi" });
  const elsewhere = as(other, "click", { tab: 8, ref: "4" });
  await settled();
  expect(page.sent).toEqual(["7 click 1", "8 click 4"]);
  page.answer("7 click 1");
  await first;
  await settled();
  expect(page.sent).toEqual(["7 click 1", "8 click 4", "7 click 2"]);
  page.answer("7 click 2");
  expect(await second).toMatchObject({ ok: true });
  expect(await third).toMatchObject({ ok: true });
  expect(page.sent).toEqual(["7 click 1", "8 click 4", "7 click 2", "7 type 3"]);
  page.answer("8 click 4");
  expect(await elsewhere).toMatchObject({ ok: true });
});

test("a call that has waited just under 10 s still gets the tab when it frees", async () => {
  jest.useFakeTimers();
  const page = safari();
  const first = as(agent.pid, "click", { tab: 7, ref: "1" });
  await settled();
  const second = as(other, "type", { tab: 7, ref: "2", text: "hi" });
  await settled();
  jest.advanceTimersByTime(9_999);
  page.answer("7 click 1");
  await first;
  expect(await second).toMatchObject({ ok: true });
  expect(page.sent).toEqual(["7 click 1", "7 type 2"]);
});

test("a call still waiting after 10 s fails, naming the call that holds the tab and for how long", async () => {
  jest.useFakeTimers();
  const page = safari();
  const first = as(agent.pid, "click", { tab: 7, ref: "1" });
  await settled();
  const second = as(other, "type", { tab: 7, ref: "2", text: "hi" });
  await settled();
  jest.advanceTimersByTime(10_000);
  await expect(second).rejects.toThrow(`tab 7 is busy with click from sleep pid ${agent.pid} for 10 s; wait or use your own tab`);
  expect(page.sent).toEqual(["7 click 1"]);
  page.answer("7 click 1");
  await first;
});

test("reads go ahead on a busy tab, and a wait holds no lane", async () => {
  const page = safari();
  const click = as(agent.pid, "click", { tab: 7, ref: "1" });
  await settled();
  expect(await as(other, "info", { tab: 7 })).toEqual({ ok: true });
  const waiting = as(other, "wait", { tab: 8, text: "Saved" });
  await settled();
  expect(await as(agent.pid, "type", { tab: 8, ref: "4", text: "hi" })).toMatchObject({ ok: true });
  expect(page.sent).toEqual(["7 click 1", "7 tabInfo", "8 wait", "8 type 4"]);
  page.answer("7 click 1");
  page.answer("8 wait");
  await click;
  expect(await waiting).toMatchObject({ found: true });
});

test("a call that fails gives the tab to the next in line", async () => {
  const page = safari();
  const failing = as(agent.pid, "click", { tab: 7, ref: "gone" });
  await settled();
  const next = as(other, "click", { tab: 7, ref: "2" });
  await settled();
  expect(page.sent).toEqual(["7 click gone"]);
  page.answer("7 click gone");
  await expect(failing).rejects.toThrow("no element gone on the page");
  await settled();
  expect(page.sent).toEqual(["7 click gone", "7 click 2"]);
  page.answer("7 click 2");
  expect(await next).toMatchObject({ ok: true });
});

test("a run's acting steps on one tab take its lane in turn", async () => {
  const page = safari();
  const run = await as(agent.pid, "run", { steps: [{ tool: "type", args: { tab: 7, ref: "1", text: "hi" } }, { tool: "select", args: { tab: 7, ref: "2", option: "Blue" } }] });
  expect(run).toMatchObject({ steps: [{ tool: "type", value: { ok: true } }, { tool: "select", value: { ok: true } }], notRun: 0 });
  expect(page.sent).toEqual(["7 type 1", "7 select 2"]);
});
