import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { alive } from "./owner.ts";
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

// On 10-22 three calls sent together each took 64 s, one of them a wait
// whose answer said 48 ms, and nothing told where the time went.
test("a call held a second or more while the daemon restarted says so in its answer", async () => {
  const up = Date.now() + 1_100;
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") return Response.json(Date.now() < up ? { stopping: "deploy" } : { ok: true });
      calls++;
      return calls === 1 ? Response.json({ ok: false, restarting: true }, { status: 503 }) : Response.json({ ok: true, value: { ok: true } });
    },
  });
  servers.push(server);
  process.env.SAFARI_HARNESS_HTTP = `http://127.0.0.1:${server.port}`;
  expect(await rpc("info", { tab: 1 })).toEqual({ ok: true, note: expect.stringMatching(/^this call waited 1 s for its turn \(the daemon restarting, as a deploy does\), from \d\d:\d\d:\d\d UTC$/) });
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

test.each([
  ["cookies", { tab: 1, do: "clear" }],
  ["replay", { tab: 1, id: "saved-flow" }],
  ["download", { tab: 1, ref: "Export" }],
] as const)("a failed %s from a release without effect details is not safe to repeat", async (tool, args) => {
  const d = daemon([
    Response.json({ ok: false, error: "the reply was lost after dispatch" }),
    Response.json({ ok: true, value: "sent twice" }),
  ]);
  servers.push(d.server);
  await expect(rpc(tool, args)).rejects.toMatchObject({ effect: "possibly_effected", retryable: false });
  expect(d.calls).toHaveLength(1);
});

// From 11-10 to 11-16 a tab opened by `ssh personal 'safari …'` closed as
// that one command ended, 27 times in 16 sessions: each command's agent
// was its ssh session. Commands that name one SAFARI_OWNER work for one
// lease that outlives them, until it is ended.
test("separate processes that name one owner key work for one lease that outlives them, until it ends", async () => {
  const calls: { caller?: number }[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    calls.push((await req.json()) as { caller?: number });
    return Response.json({ ok: true, value: { tabs: [] } });
  } });
  servers.push(server);
  const home = mkdtempSync("/private/var/tmp/sho-");
  const env = { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${server.port}` };
  delete env.SAFARI_HARNESS_REMOTE;
  delete env.SAFARI_OWNER;
  const call = async (owner?: string) => {
    const p = Bun.spawn([process.execPath, "-e", `await (await import(${JSON.stringify(join(import.meta.dir, "rpc.ts"))})).rpc("tabs")`], { env: owner === undefined ? env : { ...env, SAFARI_OWNER: owner }, stderr: "pipe" });
    expect(await p.exited).toBe(0);
    return p.pid;
  };
  try {
    const first = await call("job");
    const second = await call("job");
    const plain = await call();
    const lease = calls[0].caller!;
    expect(calls).toEqual([{ tool: "tabs", args: {}, caller: lease, own: true }, { tool: "tabs", args: {}, caller: lease, own: true }, { tool: "tabs", args: {}, caller: plain }]);
    expect([first, second, plain]).not.toContain(lease);
    expect(alive(lease)).toBe(true);
    const end = Bun.spawn([process.execPath, join(import.meta.dir, "../cli/safari.ts"), "owner", "--owner", "job", "--end", "--json"], { env, stdout: "pipe" });
    expect(JSON.parse(await new Response(end.stdout).text())).toEqual({ owner: "job", pid: lease });
    for (let i = 0; i < 100 && alive(lease); i++) await Bun.sleep(20);
    expect(alive(lease)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
