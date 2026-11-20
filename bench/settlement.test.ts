// What type and select answer when the page takes the input back after the
// action: type must say kept: false, and a select's receipt must show the
// control's state as the page left it. Each row is a way a page can do that
// within the 300 ms type and select wait before answering. An early answer
// was drafted on 2026-11-18 and dropped: bench/waits-safari.ts measures it,
// and its heading says why.
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
    if (url.pathname === "/late.js") {
      await Bun.sleep(150);
      return new Response("export {};", { headers: { "Content-Type": "text/javascript" } });
    }
    return new Response(Bun.file(join(import.meta.dir, "fixtures/settlement.html")));
  },
});
afterAll(() => server.stop(true));
const page = (mode: string) => `http://127.0.0.1:${server.port}/?mode=${mode}`;
// A frame callback and a script's animation are left to
// bench/waits-safari.ts: the bench's web view is not shown, and on some runs
// it never draws the page's frame.
const modes = ["sync", "microtask", "0", "50", "150", "200", "string", "idle", "fetch", "body", "xhr", "img", "preexisting", "prefetch", "transition", "interval", "channel", "import", "crypto", "idb"];
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
