import { expect, test } from "bun:test";
import { runSteps } from "./tools.ts";

// A run's steps against a stand-in for its tools that records each call:
// open makes tabs 5, 6, ...; click fails, as one on a disabled control
// does; every other tool answers ok.
function tools() {
  const calls: [string, Record<string, unknown>][] = [];
  let next = 5;
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push([tool, args]);
    if (tool === "open") return { id: next++ };
    if (tool === "click") throw new Error("that control is disabled");
    return { ok: true };
  };
  return { calls, call };
}

// On 09-29 an eval after a goto failed for want of a tab.
test("a step without tab acts on the tab an earlier step named", async () => {
  const t = tools();
  await runSteps([{ tool: "goto", args: { tab: 9, url: "https://shop.example/" } }, { tool: "eval", args: { expression: "document.title" } }], t.call);
  expect(t.calls[1]).toEqual(["eval", { expression: "document.title", tab: 9 }]);
});

test("after the run closes its tab, it opens another and reads that one", async () => {
  const t = tools();
  const run = await runSteps([{ tool: "open", args: { url: "https://a.example/" } }, { tool: "close" }, { tool: "open", args: { url: "https://b.example/" } }, { tool: "extract" }], t.call);
  expect(run).toMatchObject({ steps: [{ value: { id: 5 } }, { value: { ok: true } }, { value: { id: 6 } }, { value: { ok: true } }], notRun: 0 });
  expect(t.calls.at(-1)).toEqual(["extract", { tab: 6 }]);
});

// On 09-29 a run closed tab 801800, opened another, and snapshot 801800.
test("a step naming a tab the run closed fails with the step that closed it, and is not sent", async () => {
  const t = tools();
  const run = await runSteps([{ tool: "close", args: { tab: 7 } }, { tool: "open", args: { url: "https://shop.example/" } }, { tool: "snapshot", args: { tab: 7 } }], t.call);
  expect(run.steps[2]).toEqual({ step: 3, tool: "snapshot", error: expect.stringMatching(/^tab 7 was closed in step 1\b/) });
  expect(t.calls.map(([tool]) => tool)).toEqual(["close", "open"]);
});

test("close and keep still run after a step fails, on the run's tab", async () => {
  const t = tools();
  const run = await runSteps([{ tool: "open", args: { url: "https://shop.example/" } }, { tool: "click", args: { ref: "4" } }, { tool: "extract" }, { tool: "keep" }], t.call);
  expect(run).toEqual({ steps: [{ step: 1, tool: "open", value: { id: 5 } }, { step: 2, tool: "click", error: "that control is disabled" }, { step: 4, tool: "keep", value: { ok: true } }], notRun: 1 });
  expect(t.calls.at(-1)).toEqual(["keep", { tab: 5 }]);
});

// On 09-29 a run opened CarMax as tab 723049 and read tab 718331, his
// Gmail, and the agent took Gmail's text for CarMax's.
test("a step naming a tab the run did not open says so beside its answer", async () => {
  const t = tools();
  const run = await runSteps([{ tool: "open", args: { url: "https://carmax.example/" } }, { tool: "eval", args: { tab: 3, expression: "document.title" } }], t.call);
  expect(run.steps[1]).toEqual({ step: 2, tool: "eval", value: { ok: true, note: expect.stringMatching(/tab 3 .*\(5\)/) } });
});

// On 09-29 an agent put repl in a run twice and was offered replay.
test("a repl step fails pointing at the repl call, and nothing is called", async () => {
  const t = tools();
  const run = await runSteps([{ tool: "repl", args: { code: "1 + 1" } }], t.call);
  expect(run.steps[0]).toEqual({ step: 1, tool: "repl", error: expect.stringMatching(/^repl is its own call/) });
  expect(t.calls).toEqual([]);
});
