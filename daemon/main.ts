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
//     /shutdown      {reason} stop once the calls in flight finish
//     /space         the live page an agent window opens on, with its state
//                    and controls; /agents, every agent at work (mission.ts)

import { homedir } from "node:os";
import { join } from "node:path";
import { bridge, DEFAULT_PORT } from "./bridge.ts";
import { TOOLS, callTool, loadTabs } from "./tools.ts";
import { handleCdp, stopConnPumps, stopAllPumps, type CdpMsg } from "./cdp.ts";
import { passwords, BRIDGE_ORIGIN } from "./passwords.ts";
import { note, openJournal, recent } from "./journal.ts";
import { codeHash } from "./codehash.ts";
import { ownerOf, runAs } from "./owner.ts";
import { missionRoute, watched } from "./mission.ts";
import { saveRecording } from "./recordings.ts";
import { notify } from "./front.ts";
import { loadSpaces } from "./spaces.ts";

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
const earlier = openJournal(join(homedir(), "Library", "Logs", "safari-harness", `journal-${httpPort}.jsonl`));
const last = earlier.at(-1);
note("start", {
  pid: process.pid,
  code: CODE,
  reason: !last ? "first start" : last.kind === "stop" ? `after a stop: ${String(last.reason)}` : "the previous daemon ended without stopping (it crashed or was killed)",
});
// Background tabs agents opened, and the windows they opened them in, so a
// restart still closes them (tools.ts, spaces.ts).
loadTabs(join(homedir(), ".local/share/safari-harness", `tabs-${httpPort}.json`));
loadSpaces(join(homedir(), ".local/share/safari-harness", `spaces-${httpPort}.json`));
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

type SocketScope =
  | { kind: "extension" }
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
function allowed(req: Request, caller: Caller): boolean {
  const origin = req.headers.get("origin");
  if (caller === "extension") return origin?.startsWith("safari-web-extension://") ?? false;
  if (caller === "passwords") return origin === BRIDGE_ORIGIN;
  return origin === null;
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
  fetch(req, srv) {
    const url = new URL(req.url);
    if (!allowed(req, callerOf(url.pathname))) return refuse(req, url);
    if (url.pathname.startsWith("/devtools/")) {
      const pageMatch = url.pathname.match(/^\/devtools\/page\/(\d+)/);
      const connId = ++connSeq;
      const scope: SocketScope = pageMatch
        ? { kind: "page", tabId: Number(pageMatch[1]), connId }
        : { kind: "browser", connId };
      return srv.upgrade(req, { data: scope }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/" || url.pathname === "/passwords") {
      const kind = url.pathname === "/" ? "extension" : "passwords";
      return srv.upgrade(req, { data: { kind } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "extension") bridge.attach(ws);
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
    close(ws) {
      if (ws.data.kind === "extension") bridge.detach(ws);
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

const rpcServer = Bun.serve({
  hostname: "127.0.0.1",
  port: httpPort,
  async fetch(req) {
    const url = new URL(req.url);
    // The agent windows' pages call back from their own origin, which the
    // check below refuses: mission.ts checks its routes itself.
    const page = await missionRoute(req, url);
    if (page) return page;
    if (!allowed(req, "local")) return refuse(req, url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        pid: process.pid,
        code: CODE,
        root: ROOT,
        inFlight,
        ...(stopping ? { stopping } : {}),
        extension: bridge.connected ? (bridge.extensionInfo ?? { connected: true }) : null,
        tools: Object.keys(TOOLS),
        journal: recent(),
      });
    }
    if (url.pathname === "/rpc" && req.method === "POST") {
      if (stopping) return Response.json({ ok: false, restarting: true, error: `the safari daemon is restarting (${stopping}); try again in a moment` }, { status: 503 });
      let body: unknown;
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "bad json" }, { status: 400 }); }
      const { tool, args, caller, model } = (body ?? {}) as { tool?: string; args?: Record<string, unknown>; caller?: unknown; model?: unknown };
      if (!tool) return Response.json({ ok: false, error: "missing tool" }, { status: 400 });
      inFlight++;
      try {
        const owner = Number.isInteger(caller) && Number(caller) > 1 ? await ownerOf(Number(caller)) : undefined;
        const value = await watched(owner, tool, args ?? {}, () => runAs(owner, () => callTool(tool, args ?? {}, model === true)));
        return Response.json({ ok: true, value });
      } catch (e) {
        return Response.json({ ok: false, error: String(e instanceof Error ? e.message : e) });
      } finally {
        if (--inFlight === 0) for (const wake of idle) wake();
      }
    }
    if (url.pathname === "/shutdown" && req.method === "POST") {
      const reason = safeParse(await req.text())?.reason;
      void stop(typeof reason === "string" && reason ? reason : "shutdown requested", SHUTDOWN_DRAIN_MS);
      return Response.json({ ok: true, inFlight });
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
  server.stop();
  // A drained call is done before its answer is written: exit once the rpc
  // connections have closed (a call the drain's timeout cut is cut here).
  await rpcServer.stop(inFlight > 0);
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT", SIGNAL_DRAIN_MS));
process.on("SIGTERM", () => void stop("SIGTERM", SIGNAL_DRAIN_MS));
