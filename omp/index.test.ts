import { expect, test } from "bun:test";
import safariTurnEnd from "./index.ts";

type Handler = Parameters<Parameters<typeof safariTurnEnd>[0]["on"]>[1];
const prepared = { owner: process.pid, epoch: "owned-generation", tabs: [101] };

async function withHook(run: (handler: Handler, requests: { path: string; body: unknown }[], released: Promise<void>) => Promise<void>) {
  const released = Promise.withResolvers<void>();
  const requests: { path: string; body: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, body: await request.json() });
    if (path === "/turn-end/prepare") return Response.json(prepared);
    released.resolve();
    return Response.json({ ok: true, closed: 1, retained: 0, failed: 0, deferred: false });
  } });
  const before = process.env.SAFARI_HARNESS_HTTP;
  process.env.SAFARI_HARNESS_HTTP = `http://127.0.0.1:${server.port}`;
  let handler: Handler | undefined;
  safariTurnEnd({ on: (_event, callback) => { handler = callback; } });
  try {
    if (!handler) throw new Error("turn-end hook was not registered");
    await run(handler, requests, released.promise);
  } finally {
    server.stop(true);
    if (before === undefined) delete process.env.SAFARI_HARNESS_HTTP;
    else process.env.SAFARI_HARNESS_HTTP = before;
  }
}

test("the main session's final turn end releases exactly the pages the daemon prepared", async () => {
  await withHook(async (handler, requests, released) => {
    handler({}, { mode: "interactive", agent: { kind: "main" } });
    await released;
    expect(requests).toEqual([
      { path: "/turn-end/prepare", body: { owner: process.pid } },
      { path: "/turn-end", body: { owner: process.pid, prepared } },
    ]);
  });
});

test.each([
  ["a continuing turn", { willContinue: true }, { mode: "interactive", agent: { kind: "main" as const } }],
  ["print mode", {}, { mode: "print", agent: { kind: "main" as const } }],
  ["a subagent sharing the process", {}, { mode: "interactive", agent: { kind: "sub" as const } }],
])("%s releases nothing", async (_name, event, ctx) => {
  await withHook(async (handler, requests, released) => {
    handler(event, ctx);
    handler({}, { mode: "interactive", agent: { kind: "main" } });
    await released;
    expect(requests.map(r => r.path)).toEqual(["/turn-end/prepare", "/turn-end"]);
  });
});
