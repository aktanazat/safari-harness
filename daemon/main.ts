// Safari Harness daemon.
//
//   bun daemon/main.ts
//
// Endpoints:
//   ws   :SAFARI_HARNESS_WS (default 37333)
//     /              extension background worker connects here
//     /passwords     the hidden Helium's Apple Passwords bridge (passwords.ts)
//     /devtools/…    CDP-compatible shim for Chrome-protocol clients
//   http :SAFARI_HARNESS_HTTP_PORT (default 37334)
//     /rpc           {tool,args,caller} -> {ok,value|error}   (CLI + MCP client)
//     /health        bridge status, calls in flight, the code and directory
//                    it runs, recent events
//     /calls         the last 24 h of calls and the extension's drops (calls.ts)
//     /turn-end/prepare {owner} drain and identify exact owned resources
//     /turn-end      {owner,prepared} release after runtime authorization
//     /shutdown      {reason} stop once the calls in flight finish
//     /space         the live page an agent window opens on, with its state
//                    and controls; /agents, every agent at work (mission.ts)

import { homedir } from "node:os";
import { join } from "node:path";
import { bridge, DEFAULT_PORT, MESSAGE_MAX } from "./bridge.ts";
import { TOOLS, callTool, endTurn, prepareTurnEnd, loadTabs, type TurnPreparation } from "./tools.ts";
import { handleCdp, stopConnPumps, stopAllPumps, type CdpMsg } from "./cdp.ts";
import { passwords, BRIDGE_ORIGIN } from "./passwords.ts";
import { note, openJournal, recent, trimLog } from "./journal.ts";
import { lastDay, logCall, logDrop, openCalls } from "./calls.ts";
import { codeHash } from "./codehash.ts";
import { ownerOf, runAs } from "./owner.ts";
import { missionRoute, tracksOwner, watched } from "./mission.ts";
import { saveRecording } from "./recordings.ts";
import { notify } from "./front.ts";
import { loadSpaces } from "./spaces.ts";
import { loadsFile, openLoads } from "./loads.ts";
import { fromAutomation } from "./automation.ts";
import { failureOf, HarnessError, type Failure } from "./failures.ts";
import { affectsPage } from "./lanes.ts";
import { openMissionHistory } from "./mission.ts";
import { localRequest } from "./requests.ts";
import { browserMemoryRoute, startBrowserMemory, stopBrowserMemory } from "./browser-memory-runtime.ts";
import { pruneSaved } from "./save.ts";
import { sweepPlaybookLearning } from "./playbooks.ts";

const wsPort = Number(process.env.SAFARI_HARNESS_WS ?? DEFAULT_PORT);
const httpPort = Number(process.env.SAFARI_HARNESS_HTTP_PORT ?? 37334);

// Every line of the log (launchd's StandardOutPath) says when.
for (const level of ["log", "warn", "error"] as const) {
  const write = console[level].bind(console);
  console[level] = (...a: unknown[]) => write(new Date().toISOString(), ...a);
}

// The release it runs (scripts/dev-install.sh keeps that one while it runs)
const ROOT = join(import.meta.dir, "..");
const CODE = codeHash(ROOT);
const LOGS = join(homedir(), "Library", "Logs", "safari-harness");
// launchd's log of the daemon (cli/launchd.ts), about 600 lines a day on
// 10-21: a week or so of it stays.
trimLog(join(LOGS, "daemon.log"), 5000);
const earlier = openJournal(join(LOGS, `journal-${httpPort}.jsonl`));
openCalls(join(LOGS, `calls-${httpPort}.jsonl`));
bridge.onDrop = logDrop;
const last = earlier.at(-1);
note("start", {
  pid: process.pid,
  code: CODE,
  reason: !last ? "first start" : last.kind === "stop" ? `after a stop: ${String(last.reason)}` : "the previous daemon ended without stopping (it crashed or was killed)",
});
loadTabs(join(homedir(), ".local/share/safari-harness", `tabs-${httpPort}.json`));
loadSpaces(join(homedir(), ".local/share/safari-harness", `spaces-${httpPort}.json`), tracksOwner);
openMissionHistory(join(homedir(), ".local/share/safari-harness", `history-${httpPort}.json`));
// The extension reports every load in its owned tabs (bridge.ts), including
// loads no tool caused, so browsing_history can leave those visits out.
openLoads(loadsFile(httpPort));
// Files of agents that have exited, and reads saved over a week ago
void pruneSaved();
sweepPlaybookLearning();
// What the user taught in a tab (teach mode) is saved as he stops it; a
// notification tells him its name, or why it was not saved.
bridge.onRecording = (recording) => {
  try {
    notify(`Saved the recording as ${saveRecording(recording)}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error("[safari-harness] recording not saved:", why);
    notify(`The recording was not saved: ${why}`);
  }
};
startBrowserMemory();

type SocketScope =
  | { kind: "extension"; automation: boolean }
  | { kind: "passwords" }
  | { kind: "browser"; connId: number }
  | { kind: "page"; tabId: number; connId: number };

let connSeq = 0;

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Web pages can reach localhost too: a plain http page's own script POSTed to
// /rpc and opened a tab. Browsers put the page's Origin on every POST and every
// WebSocket handshake. The CLI, the MCP server and CDP tools send none. The
// extension sends its safari-web-extension:// origin, and only it may take the
// extension socket, because attaching drops the current one. The password
// bridge sends the one extension origin Apple's helper answers.
type Caller = "extension" | "passwords" | "local";
function allowed(req: Request, url: URL, caller: Caller): boolean {
  const origin = req.headers.get("origin");
  if (caller === "extension") return origin?.startsWith("safari-web-extension://") ?? false;
  if (caller === "passwords") return origin === BRIDGE_ORIGIN;
  return origin === null && localRequest(req, url);
}

function callerOf(path: string): Caller {
  if (path === "/") return "extension";
  return path === "/passwords" ? "passwords" : "local";
}

function refuse(req: Request, url: URL): Response {
  console.log(`[safari-harness] refused ${req.method} ${url.pathname} from origin ${req.headers.get("origin") ?? "(none)"}`);
  return new Response("forbidden", { status: 403 });
}

// Both servers bind 127.0.0.1: Bun's default is every interface, which let
// anyone on the same network drive Safari. Remote use goes over ssh (host.ts).
const server = Bun.serve<SocketScope>({
  hostname: "127.0.0.1",
  port: wsPort,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (!allowed(req, url, callerOf(url.pathname))) return refuse(req, url);
    if (url.pathname.startsWith("/devtools/")) {
      const pageMatch = url.pathname.match(/^\/devtools\/page\/(\d+)/);
      const connId = ++connSeq;
      const scope: SocketScope = pageMatch
        ? { kind: "page", tabId: Number(pageMatch[1]), connId }
        : { kind: "browser", connId };
      return srv.upgrade(req, { data: scope }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/") {
      const automation = await fromAutomation(srv.requestIP(req)?.port ?? 0);
      return srv.upgrade(req, { data: { kind: "extension", automation } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/passwords") {
      return srv.upgrade(req, { data: { kind: "passwords" } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  // Bun's 16 MB defaults failed what the extension's link carries
  // (MESSAGE_MAX in bridge.ts): past maxPayloadLength it closed the socket,
  // and with more than backpressureLimit waiting to go out it dropped a send
  // (10-29, Bun 1.4.2: two of three 20 MB sends in a row).
  websocket: {
    maxPayloadLength: MESSAGE_MAX,
    backpressureLimit: MESSAGE_MAX,
    open(ws) {
      if (ws.data.kind === "extension") bridge.attach(ws, ws.data.automation);
      else if (ws.data.kind === "passwords") passwords.attach(ws);
    },
    message(ws, raw) {
      const text = String(raw);
      if (ws.data.kind === "extension") {
        bridge.handleMessage(text, ws);
        return;
      }
      if (ws.data.kind === "passwords") {
        passwords.handleMessage(text);
        return;
      }
      const msg = safeParse(text);
      if (msg) handleCdp((obj) => ws.send(JSON.stringify(obj)), msg as CdpMsg, ws.data);
    },
    close(ws, code, reason) {
      if (ws.data.kind === "extension") bridge.detach(ws, code, reason);
      else if (ws.data.kind === "passwords") passwords.detach(ws);
      else stopConnPumps(ws.data.connId);
    },
  },
});

// Calls in flight, and why the daemon is stopping once it is: it then
// refuses new calls with 503 (rpc.ts waits for the next daemon and calls
// again) and exits when the calls in flight have finished.
let inFlight = 0;
let stopping: string | null = null;
const idle = new Set<() => void>();
// How long a stop waits for the calls in flight. launchd kills the daemon
// 20 s after its SIGTERM (its default ExitTimeOut); a deploy asks by
// /shutdown and can wait longer, for a call that waits on the user's
// Touch ID.
const SIGNAL_DRAIN_MS = 15000;
const SHUTDOWN_DRAIN_MS = 60000;

// idleTimeout 0: Bun's default cut a request its handler had not answered
// within 10 s, so safari extension reload, which waits up to 30 s for the
// extension to connect again, failed as "daemon not reachable" (10-16,
// 10-17). Every route bounds its own wait.
const rpcServer = Bun.serve({
  hostname: "127.0.0.1",
  port: httpPort,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    // The agent windows' pages call back from their own origin, which the
    // check below refuses: mission.ts checks its routes itself.
    const page = await missionRoute(req, url);
    if (page) return page;
    const memory = await browserMemoryRoute(req, url);
    if (memory) return memory;
    if (!allowed(req, url, "local")) return refuse(req, url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        pid: process.pid,
        code: CODE,
        root: ROOT,
        inFlight,
        ...(stopping ? { stopping } : {}),
        // connected, stuck, how long since it answered, each kind's timeouts
        // in a row, its drops by why (bridge.ts); an older daemon sends null
        // while not connected
        extension: bridge.health(),
        latency: bridge.latency(),
        tools: Object.keys(TOOLS),
        journal: recent(),
      });
    }
    if (url.pathname === "/calls") return Response.json(lastDay());
    if (url.pathname === "/rpc" && req.method === "POST") {
      if (stopping) {
        const error = `the safari daemon is restarting (${stopping}); try again in a moment`;
        return Response.json({ ok: false, restarting: true, error, failure: failureOf(new HarnessError("unavailable", error, { retryable: true, effect: "none", next: "wait for the daemon to finish restarting" })) }, { status: 503 });
      }
      let body: unknown;
      try { body = await req.json(); } catch {
        const failure = failureOf(new HarnessError("invalid_argument", "bad json"));
        return Response.json({ ok: false, error: failure.message, failure }, { status: 400 });
      }
      const { tool, args, caller, own, model, news, task } = (body ?? {}) as { tool?: string; args?: Record<string, unknown>; caller?: unknown; own?: unknown; model?: unknown; news?: unknown; task?: unknown };
      if (!tool) {
        const failure = failureOf(new HarnessError("invalid_argument", "missing tool"));
        return Response.json({ ok: false, error: failure.message, failure }, { status: 400 });
      }
      if (task !== undefined && (typeof task !== "string" || task.length === 0)) {
        const failure = failureOf(new HarnessError("invalid_argument", "task must be a nonempty string"));
        return Response.json({ ok: false, error: failure.message, failure }, { status: 400 });
      }
      inFlight++;
      const t = Date.now();
      let owner: number | undefined;
      let reply: { ok: true; value: unknown } | { ok: false; error: string; failure: Failure };
      try {
        // A call works for the agent above its caller, or for the caller
        // itself when it owns its calls: a named REPL session (rpc.ts).
        // news: false leaves the agent's news to a later call (rpc.ts).
        const pid = Number.isInteger(caller) && Number(caller) > 1 ? Number(caller) : undefined;
        owner = pid === undefined ? undefined : own === true ? pid : await ownerOf(pid);
        const value = await watched(owner, tool, args ?? {}, () => runAs(owner, () => callTool(tool, args ?? {}, model === true, news !== false), task));
        reply = { ok: true, value };
      } catch (e) {
        const failure = failureOf(e, { effectful: affectsPage(tool, args ?? {}) });
        reply = { ok: false, error: failure.message, failure };
      } finally {
        if (--inFlight === 0) for (const wake of idle) wake();
      }
      const text = JSON.stringify(reply);
      logCall({ t, ms: Date.now() - t, owner, task, tool, args: args ?? {}, reply, bytes: Buffer.byteLength(text) });
      return new Response(text, { headers: { "content-type": "application/json;charset=utf-8" } });
    }
    // The caller drains first, then releases the exact resources it was
    // given; a newer call in between invalidates the preparation.
    if ((url.pathname === "/turn-end/prepare" || url.pathname === "/turn-end") && req.method === "POST") {
      const body = safeParse(await req.text());
      const owner = body?.owner;
      if (!Number.isInteger(owner) || Number(owner) <= 1) return Response.json({ ok: false, error: "owner must be a process id" }, { status: 400 });
      const task = body?.task;
      if (task !== undefined && (typeof task !== "string" || task.length === 0)) return Response.json({ ok: false, error: "task must be a nonempty string" }, { status: 400 });
      inFlight++;
      try {
        if (url.pathname === "/turn-end/prepare") return Response.json(await prepareTurnEnd(Number(owner), task));
        const prepared = body?.prepared;
        if (!prepared || typeof prepared !== "object" || !("owner" in prepared) || prepared.owner !== owner || !("epoch" in prepared) || typeof prepared.epoch !== "string" || !("tabs" in prepared) || !Array.isArray(prepared.tabs) || !prepared.tabs.every(tab => Number.isInteger(tab) && tab > 0)) {
          return Response.json({ ok: false, error: "a current owned-resource preparation is required" }, { status: 409 });
        }
        return Response.json(await endTurn(Number(owner), prepared as TurnPreparation, task));
      } catch (e) {
        // Its tabs are marked done by then, and a later sweep closes them
        // (tools.ts): from 10-30 01:05Z to 01:50Z, while Safari left
        // tabs.list unanswered, every turn end escaped here as Bun's 500.
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[safari-harness] turn end for ${owner} failed: ${error}`);
        return Response.json({ ok: false, error }, { status: 503 });
      } finally {
        if (--inFlight === 0) for (const wake of idle) wake();
      }
    }
    if (url.pathname === "/shutdown" && req.method === "POST") {
      const reason = safeParse(await req.text())?.reason;
      void stop(typeof reason === "string" && reason ? reason : "shutdown requested", SHUTDOWN_DRAIN_MS);
      return Response.json({ ok: true, inFlight });
    }
    // safari extension reload (safari.ts): the reload the bridge gives a
    // stuck extension by itself, asked for now.
    if (url.pathname === "/extension/reload" && req.method === "POST") {
      try {
        return Response.json({ ok: true, value: await bridge.reload() });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[safari-harness] extension+cdp ws :${wsPort}  rpc http :${httpPort}`);

async function stop(reason: string, drainMs: number) {
  if (stopping) return;
  stopping = reason;
  const busy = inFlight;
  if (busy > 0) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, drainMs);
    idle.add(resolve);
    await promise;
    clearTimeout(timer);
  }
  note("stop", { reason, ...(busy ? { finished: busy - inFlight, cut: inFlight } : {}) });
  stopAllPumps();
  passwords.shutdown();
  await stopBrowserMemory();
  server.stop();
  // A drained call is done before its answer is written: exit once the rpc
  // connections have closed (a call the drain's timeout cut is cut here).
  await rpcServer.stop(inFlight > 0);
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT", SIGNAL_DRAIN_MS));
process.on("SIGTERM", () => void stop("SIGTERM", SIGNAL_DRAIN_MS));
