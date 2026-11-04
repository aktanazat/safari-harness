#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

type Reply = { status: number; text: string; headers: Record<string, string | string[] | undefined> };
type ObjectValue = Record<string, unknown>;
type Agent = { id: string; owner: number; status: string; controls: boolean; controlSecret?: string; pictures: boolean };
type Child = Subprocess<"ignore", "pipe" | "ignore", "pipe" | "ignore">;
type Result = { name: string; passed: boolean; error?: string };
const candidate = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
const ua = "OpenAI File Downloader, XaiImageApiFetch/1.0";
const limit = 1024 * 1024;
const results: Result[] = [];
const children: Child[] = [];
const reservations: Server[] = [];
const logs: string[] = [];
let home: string | undefined;
let daemon: Child | undefined;
let httpPort = 0;
let wsPort = 0;
let requests = 0;
let activeRequests = 0;
let maxActiveRequests = 0;
let removedScratch = false;
let observedOwnerExit = false;
let actualPidReuse = false;
const origin = () => `http://127.0.0.1:${httpPort}`;
const same = () => ({ origin: origin(), "sec-fetch-site": "same-origin" });
const object = (value: unknown): ObjectValue => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  return value as ObjectValue;
};
const json = (reply: Reply): ObjectValue => object(JSON.parse(reply.text));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    const detail = message(error);
    results.push({ name, passed: false, error: detail });
    console.log(`FAIL ${name}: ${detail}`);
  }
}

function http(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  assert.ok(httpPort > 0 && httpPort !== 37333 && httpPort !== 37334, "isolated HTTP port required");
  assert.ok(path.startsWith("/") && !path.startsWith("//"), "only local absolute paths allowed");
  assert.ok(++requests <= 240, "bounded request budget exceeded");
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  assert.ok(body === undefined || Buffer.byteLength(body) <= limit, "request exceeds 1 MiB");
  activeRequests++;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  const { promise, resolve: resolveReply, reject } = Promise.withResolvers<Reply>();
  try {
    const req = request({
      hostname: "127.0.0.1", port: httpPort, path,
      method: options.method ?? "GET", agent: false,
      headers: { "user-agent": ua, ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }), ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) { res.destroy(new Error("response exceeds 1 MiB")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolveReply({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      res.on("error", reject);
    });
    req.setTimeout(4000, () => req.destroy(new Error("local HTTP request timed out")));
    req.on("error", reject);
    req.end(body);
  } catch (error) { reject(error); }
  return promise.finally(() => { activeRequests--; });
}

async function until<T>(name: string, sample: () => Promise<T | undefined>, timeout = 12000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  do {
    try { const value = await sample(); if (value !== undefined) return value; } catch (error) { last = error; }
    await Bun.sleep(150);
  } while (Date.now() < deadline);
  throw new Error(`${name} not observed before deadline${last ? `: ${message(last)}` : ""}`);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  reservations.push(server);
  const { promise, resolve: listening, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", listening);
  await promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.ok(address.port !== 37333 && address.port !== 37334, "production ports forbidden");
  return address.port;
}

async function closeReservation(server: Server): Promise<void> {
  if (!server.listening) return;
  const { promise, resolve: closed, reject } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : closed());
  await promise;
}

async function captureLog(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  let kept = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    kept = (kept + new TextDecoder().decode(item.value)).slice(-32768);
  }
  logs.push(kept);
}
const logReaders: Promise<void>[] = [];

async function stop(child: Child): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const timeout = Promise.withResolvers<false>();
  const timer = setTimeout(() => timeout.resolve(false), 3000);
  try {
    const exited = await Promise.race([child.exited.then(() => true), timeout.promise]);
    if (!exited) { child.kill("SIGKILL"); await child.exited; }
  } finally { clearTimeout(timer); }
}

async function startDaemon(): Promise<Child> {
  assert.ok(home, "scratch HOME must exist before daemon startup");
  const child = Bun.spawn([process.execPath, join(candidate, "daemon/main.ts")], {
    cwd: candidate,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: join(home, "tmp"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CONFIG_HOME: join(home, ".config"), SAFARI_HARNESS_WS: String(wsPort), SAFARI_HARNESS_HTTP_PORT: String(httpPort) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  logReaders.push(captureLog(child.stdout), captureLog(child.stderr));
  daemon = child;
  await until("isolated daemon readiness", async () => {
    assert.equal(child.exitCode, null, "daemon exited during startup");
    const reply = await http("/health");
    const body = json(reply);
    assert.equal(reply.status, 200);
    assert.equal(body.pid, child.pid, "refusing a listener not owned by this attack");
    assert.equal(body.root, candidate, "wrong candidate source");
    assert.equal(object(body.extension).connected, false, "an extension must not attach to the isolated daemon");
    return true;
  }, 20000);
  return child;
}

function owner(): Child {
  const child = Bun.spawn(["/bin/sleep", "180"], { env: { HOME: home!, PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}

async function listing(): Promise<Agent[]> {
  const reply = await http("/agents.json", { headers: same() });
  assert.equal(reply.status, 200);
  const body = json(reply);
  assert.ok(Array.isArray(body.agents));
  return body.agents.map((entry: unknown) => {
    const a = object(entry);
    assert.equal(typeof a.id, "string");
    assert.equal(typeof a.status, "string");
    assert.equal(typeof a.controls, "boolean");
    return a as unknown as Agent;
  });
}
async function live(pid: number): Promise<Agent> {
  const found = (await listing()).find((a) => a.owner === pid);
  assert.ok(found, "synthetic owner is missing from the real daemon");
  return found;
}
function capability(a: Agent): string {
  assert.equal(a.controls, true, "positive control requires an active mission");
  assert.equal(typeof a.controlSecret, "string");
  assert.ok(a.controlSecret && a.controlSecret.length >= 32, "missing real daemon capability");
  return a.controlSecret;
}
async function register(child: Child): Promise<Agent> {
  assert.equal(child.exitCode, null, "only a live synthetic owner may create a mission");
  assert.equal(child.signalCode, null);
  const reply = await http("/rpc", { method: "POST", body: { tool: "identity_attack_unknown", args: {}, own: true, caller: child.pid } });
  assert.equal(reply.status, 200);
  const body = json(reply);
  assert.equal(body.ok, false);
  assert.equal(typeof body.error, "string");
  assert.match(String(body.error), /unknown tool/i, "positive control must reach tool dispatch");
  const a = await live(child.pid);
  assert.equal(a.status, "working");
  capability(a);
  return a;
}
function control(a: Agent, patch: ObjectValue = {}, headers = same()): Promise<Reply> {
  return http("/agents/control", { method: "POST", headers, body: { owner: a.owner, mission: a.id, secret: capability(a), action: "pause", ...patch } });
}
async function restore(a: Agent): Promise<void> {
  const reply = await control(a, { action: "resume" });
  assert.equal(reply.status, 200, "positive resume control failed");
  assert.equal(json(reply).status, "working");
}
async function denied(a: Agent, status: number, patch: ObjectValue = {}, headers = same()): Promise<void> {
  const reply = await control(a, patch, headers);
  const after = await live(a.owner);
  try {
    assert.equal(reply.status, status, `denied request returned HTTP ${reply.status}`);
    assert.equal(after.status, "working", "denied request changed the mission");
    assert.equal(after.id, a.id, "denied request replaced the mission");
  } finally { if (after.status === "paused") await restore(a); }
}
async function history(id: string): Promise<ObjectValue> {
  const reply = await http(`/agents/history.json?id=${encodeURIComponent(id)}`, { headers: same() });
  assert.equal(reply.status, 200);
  const rows = json(reply).missions;
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1, "exact retained mission must remain readable");
  const record = object(rows[0]);
  assert.equal(record.id, id);
  assert.equal(record.controls, false, "retained history must be read-only");
  assert.equal(Object.hasOwn(record, "controlSecret"), false, "history must not return a control capability");
  assert.equal(Object.hasOwn(record, "secret"), false);
  return record;
}
async function pageSecret(): Promise<string> {
  const reply = await http("/agents", { headers: same() });
  assert.equal(reply.status, 200);
  const secret = /data-secret="([^"]+)"/.exec(reply.text)?.[1];
  assert.ok(secret, "real overview page did not provide its page capability");
  return secret;
}

try {
  await access(join(candidate, "daemon/main.ts"));
  home = await mkdtemp("/private/var/tmp/safari-identity-");
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  httpPort = await reservePort();
  wsPort = await reservePort();
  assert.notEqual(httpPort, wsPort);
  await Promise.all(reservations.map(closeReservation));
  await startDaemon();
  const aChild = owner();
  const a = await register(aChild);
  const oldPage = await pageSecret();

  await check("same-origin capability pauses and resumes only the synthetic owner", async () => {
    try {
      const reply = await control(a);
      assert.equal(reply.status, 200);
      assert.equal(json(reply).status, "paused");
      assert.equal((await live(a.owner)).status, "paused");
    } finally { await restore(a); }
    assert.equal((await live(a.owner)).status, "working");
  });
  await check("localhost Host and matching origin remain a positive read control", async () => {
    const address = `http://localhost:${httpPort}`;
    const reply = await http("/agents.json", { headers: { host: `localhost:${httpPort}`, origin: address, "sec-fetch-site": "same-origin" } });
    assert.equal(reply.status, 200);
    assert.ok((json(reply).agents as unknown[]).some((row) => object(row).id === a.id));
  });
  await check("forged control secret is denied without pausing the owner", () => denied(a, 403, { secret: "synthetic-wrong-secret" }));
  await check("missing control secret is denied", () => denied(a, 403, { secret: null }));
  await check("correct secret with wrong mission UUID is denied", () => denied(a, 409, { mission: crypto.randomUUID() }));

  const variants = [
    { name: "foreign origin", headers: { origin: "https://identity-attacker.invalid", "sec-fetch-site": "same-origin" } },
    { name: "cross-site without Origin", headers: { "sec-fetch-site": "cross-site" } },
    { name: "same-site but not same-origin", headers: { origin: origin(), "sec-fetch-site": "same-site" } },
    { name: "rebound Host with matching attacker origin", headers: { host: `identity-attacker.invalid:${httpPort}`, origin: `http://identity-attacker.invalid:${httpPort}`, "sec-fetch-site": "same-origin" } },
    { name: "rebound Host without Origin", headers: { host: `identity-attacker.invalid:${httpPort}`, "sec-fetch-site": "same-origin" } },
  ];
  for (const variant of variants) await check(`${variant.name} cannot use a valid mission secret`, () => denied(a, 403, {}, variant.headers));

  const unknown = crypto.randomUUID();
  const picturePath = `/agents/picture?id=${a.id}&picture=${unknown}`;
  const routes = ["/agents", "/agents.json", "/agents/history", `/agents/history.json?id=${a.id}`, `/space?id=${unknown}`, `/space/state?id=${unknown}`, picturePath];
  for (const path of routes) {
    await check(`same-origin read positive control ${path.split("?")[0]}`, async () => {
      const reply = await http(path, { headers: same() });
      assert.equal(reply.status, path === picturePath ? 404 : 200);
    });
    for (const variant of [variants[0], variants[1], variants[3]]) {
      await check(`${variant.name} cannot read ${path.split("?")[0]}`, async () => {
        const reply = await http(path, { headers: variant.headers });
        assert.equal(reply.status, 403);
      });
    }
  }
  await check("public RPC rejects a page Origin before recording another mission", async () => {
    const before = await listing();
    const reply = await http("/rpc", { method: "POST", headers: { origin: "https://identity-attacker.invalid", "sec-fetch-site": "cross-site" }, body: { tool: "identity_attack_unknown", caller: aChild.pid, own: true } });
    assert.equal(reply.status, 403);
    assert.deepEqual((await listing()).map((row) => row.id), before.map((row) => row.id));
  });
  await check("public RPC rejects a rebound page Origin", async () => {
    const reply = await http("/rpc", { method: "POST", headers: variants[3].headers, body: { tool: "identity_attack_unknown", caller: aChild.pid, own: true } });
    assert.equal(reply.status, 403);
    assert.equal((await live(a.owner)).status, "working");
  });
  await check("health metadata denies a rebound Host even without Origin", async () => {
    const reply = await http("/health", { headers: variants[4].headers });
    assert.equal(reply.status, 403, `rebound Host read returned HTTP ${reply.status}; daemon metadata readable=${reply.status === 200 && json(reply).pid === daemon?.pid}`);
  });
  await check("retained history is read-only while its owner remains alive", async () => {
    const record = await history(a.id);
    assert.equal(record.owner, a.owner);
    assert.equal((await live(a.owner)).status, "working");
  });

  await stop(aChild);
  await until("daemon-observed synthetic owner exit", async () => {
    const row = await live(a.owner);
    if (row.status !== "ended") return undefined;
    assert.equal(row.controls, false);
    assert.equal(row.controlSecret, undefined);
    observedOwnerExit = true;
    return true;
  });
  await check("old capability cannot resume the observed ended mission", async () => {
    const reply = await control(a, { action: "resume" });
    assert.equal(reply.status, 409);
    assert.match(String(json(reply).error), /ended/);
    assert.equal((await live(a.owner)).status, "ended");
    assert.equal((await history(a.id)).status, "ended");
  });

  const bChild = owner();
  actualPidReuse = bChild.pid === aChild.pid;
  const b = await register(bChild);
  assert.notEqual(b.id, a.id, "a replacement live owner must have a fresh mission UUID");
  await check("old owner secret cannot control the replacement live mission", () => denied(b, 403, { secret: capability(a) }));
  await check("replacement secret cannot authorize the old mission UUID", () => denied(b, 409, { mission: a.id }));
  await check("an overview page opened before replacement cannot control it", () => denied(b, 403, { secret: oldPage }));
  await check("replacement capability remains a valid positive control", async () => {
    try { const reply = await control(b); assert.equal(reply.status, 200); assert.equal((await live(b.owner)).status, "paused"); }
    finally { await restore(b); }
  });
  const bPage = await pageSecret();
  await history(b.id);
  await stop(daemon!);
  await startDaemon();

  await check("daemon restart retains history without restoring a live owner or capability", async () => {
    const record = await history(b.id);
    assert.equal(record.status, "ended");
    assert.equal(record.interrupted, true);
    assert.equal(record.owner, bChild.pid);
    assert.equal((await listing()).some((row) => row.owner === bChild.pid), false);
    assert.equal(bChild.exitCode, null, "the synthetic owner must remain alive across restart");
  });
  await check("reading retained history pages never revives old mission controls", async () => {
    const page = await http(`/agents/history?id=${b.id}`, { headers: same() });
    assert.equal(page.status, 200);
    await history(b.id);
    const reply = await control(b, { action: "resume" });
    assert.equal(reply.status, 404);
    assert.equal(json(reply).ok, false);
    assert.equal((await listing()).some((row) => row.owner === bChild.pid), false);
  });
  const freshB = await register(bChild);
  assert.notEqual(freshB.id, b.id, "new request after restart must create a new mission UUID");
  await check("pre-restart secret cannot control the same live owner's new mission", () => denied(freshB, 403, { secret: capability(b) }));
  await check("current secret cannot apply a retained mission UUID to a new mission", () => denied(freshB, 409, { mission: b.id }));
  await check("pre-restart overview capability cannot control a new mission", () => denied(freshB, 403, { secret: bPage }));
  await check("retained history stays read-only beside a current mission for the same owner", async () => {
    const old = await history(b.id);
    assert.equal(old.status, "ended");
    assert.equal((await live(freshB.owner)).id, freshB.id);
    try { assert.equal((await control(freshB)).status, 200); }
    finally { await restore(freshB); }
    await history(b.id);
    assert.equal((await live(freshB.owner)).status, "working");
  });
} catch (error) {
  results.push({ name: "scenario prerequisites and lifecycle", passed: false, error: message(error) });
  console.log(`FAIL scenario prerequisites and lifecycle: ${message(error)}`);
} finally {
  await check("cleanup stops every owned child and listener and removes only scratch HOME", async () => {
    const errors: string[] = [];
    for (const child of [...children].reverse()) {
      try { await stop(child); } catch (error) { errors.push(`child ${child.pid}: ${message(error)}`); }
    }
    for (const server of reservations) {
      try { await closeReservation(server); } catch (error) { errors.push(message(error)); }
    }
    await Promise.allSettled(logReaders);
    if (home) {
      try { await rm(home, { recursive: true, force: true }); removedScratch = true; } catch (error) { errors.push(message(error)); }
    }
    assert.deepEqual(errors, []);
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null), "owned child still running");
    assert.ok(reservations.every((server) => !server.listening), "owned reservation still listening");
    assert.equal(removedScratch, true);
    assert.equal(activeRequests, 0);
  });
}
const failed = results.filter((result) => !result.passed);
const summary = { passed: results.length - failed.length, failed: failed.length, total: results.length, requests, maxConcurrentRequests: maxActiveRequests, observedOwnerExit, actualPidReuse, ownedChildren: children.length, allOwnedChildrenExited: children.every((child) => child.exitCode !== null || child.signalCode !== null), removedScratch, imageCoverage: "origin denial precedes absent-picture lookup; no verified image or browser was fabricated", failures: failed };
console.log(`SUMMARY ${JSON.stringify(summary)}`);
if (failed.some((result) => result.name === "scenario prerequisites and lifecycle")) console.log(`DAEMON LOG ${JSON.stringify(logs)}`);
process.exitCode = failed.length ? 1 : 0;
