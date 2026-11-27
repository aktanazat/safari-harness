import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { inputStateTool } from "./input-state.ts";

const initial = { tab: 7, frame: 0, focus: false, after: -1, ms: 0 };

test("input_state returns only validated completion count and focus", async () => {
  const tool = inputStateTool(async () => ({ marks: 3, focus: true, privateText: "not returned" }));
  expect(await tool.run(initial)).toEqual({ marks: 3, focus: true });
});

test.each([
  { name: "an expression", extra: { expression: "document.body.innerText" } },
  { name: "page-world execution", extra: { page: true } },
  { name: "an unbounded wait", extra: { ms: 3001 } },
  { name: "a negative wait", extra: { ms: -1 } },
  { name: "a fractional frame", extra: { frame: 0.5 } },
  { name: "a frame expression", extra: { frame: "1:document.body.innerText" } },
  { name: "a nonfinite completion count", extra: { after: Number.NaN } },
  { name: "a nonboolean focus request", extra: { focus: 1 } },
])("input_state refuses $name before reaching the browser", async ({ extra }) => {
  const reached: unknown[] = [];
  const tool = inputStateTool(async (...args) => {
    reached.push(args);
    return { marks: 0, focus: false };
  });
  await expect(tool.run({ ...initial, ...extra })).rejects.toMatchObject({ code: "invalid_argument", effect: "none" });
  expect(reached).toEqual([]);
});

test.each([
  { marks: -1, focus: true },
  { marks: 1, focus: "true" },
  { marks: Number.POSITIVE_INFINITY, focus: false },
  null,
])("input_state refuses malformed page state %j", async (result) => {
  const tool = inputStateTool(async () => result);
  await expect(tool.run(initial)).rejects.toMatchObject({ code: "unavailable", effect: "none" });
});

test("the content script reports focus and counts only trusted F20 keyups without dynamic JavaScript", async () => {
  const source = await Bun.file(new URL("../extension/content.js", import.meta.url)).text();
  const page = new EventTarget();
  let focused = false;
  const document = Object.assign(new EventTarget(), { hasFocus: () => focused, querySelectorAll: () => [] });
  type World = { top: World; __safariHarnessInjected: unknown; __safariHarnessRun: (message: { id: string; op: string; args: unknown[] }) => Promise<unknown> };
  const window = {} as World;
  window.top = window;
  const globals = {
    window, document, AbortController, Event, setTimeout,
    addEventListener: (type: string, listener: (event: unknown) => void, options?: AddEventListenerOptions) => {
      page.addEventListener(type, (event) => listener(type === "keyup" ? (event as CustomEvent).detail : event), options);
    },
    browser: { runtime: { sendMessage: async () => null, onMessage: { addListener: () => {} } } },
    Function: function () { throw new EvalError("dynamic JavaScript is forbidden"); },
  };
  runInNewContext(source, globals);

  const call = (op: string, ...args: unknown[]) => window.__safariHarnessRun({ id: "test", op, args });
  const read = () => call("inputState", { focus: false, after: -1, ms: 0 });
  const keyup = (code: string, isTrusted: boolean) => page.dispatchEvent(new CustomEvent("keyup", { detail: { code, isTrusted } }));

  expect(await call("eval", "1")).toMatchObject({ error: expect.stringContaining("security policy blocks eval") });
  expect(await read()).toMatchObject({ value: { marks: 0, focus: false } });
  keyup("F20", false);
  keyup("F19", true);
  expect(await read()).toMatchObject({ value: { marks: 0 } });
  keyup("F20", true);
  focused = true;
  expect(await read()).toMatchObject({ value: { marks: 1, focus: true } });
  window.__safariHarnessInjected = null;
  runInNewContext(source, globals);
  keyup("F20", true);
  expect(await read()).toMatchObject({ value: { marks: 2, focus: true } });
});
