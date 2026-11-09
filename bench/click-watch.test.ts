import { afterAll } from "bun:test";
import { basename, join } from "node:path";
import { benchRows } from "./bench.ts";

// Serves click-late.html, with what it loads late: ?ms= holds a response
// back, and the socket answers 600 ms after each message. The delays are
// real because the watch under test runs on the web view's own clock.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/socket") return srv.upgrade(req) ? undefined : new Response(null, { status: 400 });
    await Bun.sleep(Number(url.searchParams.get("ms") ?? 0));
    if (url.pathname === "/chunk.js") return new Response("out.textContent = 'Chunk ran after 800 ms';", { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/image") return new Response(null, { status: 404 });
    return new Response(Bun.file(join(import.meta.dir, "fixtures", basename(url.pathname))));
  },
  websocket: {
    async message(ws, message) {
      await Bun.sleep(600);
      ws.send(String(message));
    },
  },
});
afterAll(() => server.stop(true));

const page = `http://127.0.0.1:${server.port}/click-late.html`;
const drew = (said: string) => ({ value: { receipt: { changed: 1, said: [said] } } });

benchRows("a click's watch", [
  {
    // Watched the 2 s a slow page gets, the click would not answer in time.
    name: "a click that changes nothing on a page with nothing out answers well inside 2 s",
    page,
    steps: [{ op: "click", args: ["Nothing"], timeout: 1200, answer: { value: { receipt: { added: 0, removed: 0, changed: 0, said: [] } } } }],
  },
  {
    name: "a click whose page draws from a timer 800 ms later reports the drawing, not none",
    page,
    steps: [{ op: "click", args: ["Late 800"], answer: drew("Changed after 800 ms") }],
  },
  {
    name: "a click whose page draws from an interval 700 ms later reports the drawing",
    page,
    steps: [{ op: "click", args: ["Poll"], answer: drew("Polled after 700 ms") }],
  },
  {
    name: "a click whose page draws from a script it put in, loaded 800 ms later, reports the drawing",
    page,
    steps: [{ op: "click", args: ["Chunk"], answer: drew("Chunk ran after 800 ms") }],
  },
  {
    name: "a click whose page draws once an image it asked for fails 800 ms later reports the drawing",
    page,
    steps: [{ op: "click", args: ["Image"], answer: drew("Image came after 800 ms") }],
  },
  {
    name: "a click whose page draws a WebSocket answer 600 ms later reports the drawing",
    page,
    steps: [{ op: "click", args: ["Socket"], answer: drew("Socket answered after 600 ms") }],
  },
  {
    name: "a page whose world cannot tell its timers keeps the 2 s and reports a drawing 800 ms later",
    page: `${page}#old`,
    steps: [{ op: "click", args: ["Late 800"], answer: drew("Changed after 800 ms") }],
  },
]);
