import { expect, test } from "bun:test";
import { benchRows } from "../bench/bench.ts";
import { inputStateTool } from "./input-state.ts";

const initial = { tab: 7, frame: 0, focus: false, after: -1, ms: 0 };

test("input_state returns only validated completion count and focus", async () => {
  const tool = inputStateTool(async () => ({ result: { marks: 3, focus: true, privateText: "not returned" } }));
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
  const tool = inputStateTool(async (options) => {
    reached.push(options);
    return { result: { marks: 0, focus: false } };
  });
  await expect(tool.run({ ...initial, ...extra })).rejects.toMatchObject({ code: "invalid_argument", effect: "none" });
  expect(reached).toEqual([]);
});

test.each([
  { result: { marks: -1, focus: true } },
  { result: { marks: 1, focus: "true" } },
  { result: { marks: Number.POSITIVE_INFINITY, focus: false } },
  { result: null },
])("input_state refuses malformed page state %j", async (result) => {
  const tool = inputStateTool(async () => result);
  await expect(tool.run(initial)).rejects.toMatchObject({ code: "unavailable", effect: "none" });
});

let fixedExpression = "";
await inputStateTool(async (options) => {
  fixedExpression = options.expression;
  return { result: { marks: 0, focus: false } };
}).run(initial);

benchRows("trusted native input completion", [{
  name: "page-created F20 events cannot acknowledge real input",
  page: "blank.html",
  steps: [
    { op: "eval", args: [fixedExpression], answer: { value: { result: { marks: 0 } } } },
    { op: "eval", args: ["(() => { const event = new KeyboardEvent('keyup',{code:'F20',bubbles:true}); return { dispatched: dispatchEvent(event), trusted: event.isTrusted, code: event.code }; })()"], answer: { value: { result: { dispatched: true, trusted: false, code: "F20" } } } },
    { op: "eval", args: [fixedExpression], answer: { value: { result: { marks: 0 } } } },
  ],
}]);
