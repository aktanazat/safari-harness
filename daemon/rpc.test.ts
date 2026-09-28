import { afterEach, expect, test } from "bun:test";
import { rpc } from "./rpc.ts";

// A stand-in daemon: answers /rpc calls in turn from answers, and /health ok.
function daemon(answers: Response[], port = 0) {
  const calls: unknown[] = [];
  const server = Bun.serve({
    port,
    async fetch(req) {
      if (new URL(req.url).pathname === "/health") return Response.json({ ok: true });
      calls.push(await req.json());
      return answers.shift() ?? Response.json({ ok: false, error: "no answer left" });
    },
  });
  process.env.SAFARI_HARNESS_HTTP = `http://127.0.0.1:${server.port}`;
  return { server, calls };
}

const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  delete process.env.SAFARI_HARNESS_HTTP;
});

test("a call a restarting daemon turned away goes through, once, when it is back", async () => {
  const d = daemon([
    Response.json({ ok: false, restarting: true, error: "the safari daemon is restarting (deploy)" }, { status: 503 }),
    Response.json({ ok: true, value: "done" }),
  ]);
  servers.push(d.server);
  expect(await rpc("wait", { tab: 1, ms: 10 })).toBe("done");
  expect(d.calls).toHaveLength(2);
});

test("a call made while no daemon listens goes through when one starts", async () => {
  const gone = daemon([]).server;
  const free = gone.port;
  gone.stop();
  process.env.SAFARI_HARNESS_HTTP = `http://127.0.0.1:${free}`;
  const answered = rpc("info", { tab: 1 });
  // Only a port nobody listens on refuses, so nothing can signal that the
  // client has tried; the real clock puts its first try before the start.
  await Bun.sleep(300);
  const d = daemon([Response.json({ ok: true, value: "info" })], free);
  servers.push(d.server);
  expect(await answered).toBe("info");
  expect(d.calls).toHaveLength(1);
});

test("a call the daemon took and failed is never made again", async () => {
  const d = daemon([Response.json({ ok: false, error: "no element with ref 4" }), Response.json({ ok: true, value: "ran twice" })]);
  servers.push(d.server);
  await expect(rpc("click", { tab: 1, ref: "4" })).rejects.toThrow("no element with ref 4");
  expect(d.calls).toHaveLength(1);
});
