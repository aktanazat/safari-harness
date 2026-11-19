import { afterAll, expect } from "bun:test";
import { join } from "node:path";
import { benchRows, type Row } from "./bench.ts";

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/answer") {
      if (url.searchParams.get("mode") === "body") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("start"));
            setTimeout(() => { controller.enqueue(new TextEncoder().encode("end")); controller.close(); }, 200);
          },
        }));
      }
      await Bun.sleep(150);
      return new Response("done");
    }
    return new Response(Bun.file(join(import.meta.dir, "fixtures/settlement.html")));
  },
});
afterAll(() => server.stop(true));
const page = (mode: string) => `http://127.0.0.1:${server.port}/?mode=${mode}`;
const modes = ["sync", "microtask", "0", "50", "200", "string", "raf", "idle", "fetch", "body", "150", "preexisting", "transition", "interval", "channel"];
const rows: Row[] = modes.map(mode => (
  {
    name: `type and both selects preserve rejection by ${mode}`, page: page(mode),
    steps: [
      { op: "type", args: ["#field", "sample"], answer: { value: { ok: true, kept: false } } },
      { op: "element", args: ["#field", "value"], answer: { value: { value: "rewritten" } } },
      { pageEval: "prepare()" },
      { op: "select", args: ["#choice", "B"], answer: { value: { ok: true, value: "B", receipt: { states: [] } } } },
      { op: "eval", args: ["document.querySelector('#choice').value"], answer: { value: { result: "A" } } },
      { op: "eval", args: ["document.querySelector('#choice').value='B'"] },
      { pageEval: "prepare()" },
      { op: "select", args: ["#choice", "B"], answer: { value: { ok: true, value: "B", receipt: { states: [{ who: 'combobox "Choice"', before: ['value="B"', "2 options"], after: ['value="A"', "2 options"] }] } } } },
      { op: "eval", args: ["document.querySelector('#choice').value"], answer: { value: { result: "A" } } },
    ],
  },
));
rows.push({ name: "idle-looking click includes the string timer's drawing", page: page("quiet"), steps: [
  { op: "click", args: ["#idle"], answer: { value: { ok: true, receipt: { changed: 1, said: ["After"] } } } },
] });
rows.push({ name: "quiet type retains the value", page: page("quiet"), steps: [
  { op: "type", args: ["#field", "sample"], answer: { value: { ok: true, kept: true } } },
] });
rows.push({ name: "empty type retains an empty value", page: page("quiet"), steps: [
  { op: "type", args: ["#field", ""], answer: { value: { ok: true, kept: true } } },
] });
rows.push({ name: "missing type target remains an error", page: page("quiet"), steps: [
  { op: "type", args: ["#absent", "sample"], answer: { error: expect.any(String) } },
] });
benchRows("settlement answer preservation", rows);

if (process.env.FAST_SETTLEMENT === "1") benchRows("settlement fast path", [
  { name: "a quiet page answers type before its old deadline", page: page("quiet"), steps: [
    { op: "type", args: ["#field", "sample"], timeout: 250, answer: { value: { kept: true } } },
  ] },
  ...["A", "B"].map(option => ({ name: `a quiet page answers select ${option} early`, page: page("quiet"), steps: [
    { op: "select", args: ["#choice", option], timeout: 250, answer: { value: { ok: true, value: option } } },
  ] })),
]);
