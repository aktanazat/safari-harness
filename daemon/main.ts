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
//     /rpc           {tool,args} -> {ok,value|error}   (CLI + MCP client)
//     /health        bridge status

import { bridge, DEFAULT_PORT } from "./bridge.ts";
import { TOOLS, callTool } from "./tools.ts";
import { handleCdp, stopConnPumps, stopAllPumps, type CdpMsg } from "./cdp.ts";
import { passwords, BRIDGE_ORIGIN } from "./passwords.ts";

const wsPort = Number(process.env.SAFARI_HARNESS_WS ?? DEFAULT_PORT);
const httpPort = Number(process.env.SAFARI_HARNESS_HTTP_PORT ?? 37334);

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
        bridge.handleMessage(text);
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
      if (ws.data.kind === "extension") bridge.detach();
      else if (ws.data.kind === "passwords") passwords.detach(ws);
      else stopConnPumps(ws.data.connId);
    },
  },
});

const rpcServer = Bun.serve({
  hostname: "127.0.0.1",
  port: httpPort,
  async fetch(req) {
    const url = new URL(req.url);
    if (!allowed(req, "local")) return refuse(req, url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, extension: bridge.connected ? (bridge.extensionInfo ?? { connected: true }) : null, tools: Object.keys(TOOLS) });
    }
    if (url.pathname === "/rpc" && req.method === "POST") {
      let body: unknown;
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "bad json" }, { status: 400 }); }
      const { tool, args } = (body ?? {}) as { tool?: string; args?: Record<string, unknown> };
      if (!tool) return Response.json({ ok: false, error: "missing tool" }, { status: 400 });
      try {
        const value = await callTool(tool, args ?? {});
        return Response.json({ ok: true, value });
      } catch (e) {
        return Response.json({ ok: false, error: String(e instanceof Error ? e.message : e) });
      }
    }
    if (url.pathname === "/shutdown" && req.method === "POST") {
      setTimeout(stop, 50);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[safari-harness] extension+cdp ws :${wsPort}  rpc http :${httpPort}`);

function stop() {
  stopAllPumps();
  bridge.detach();
  passwords.shutdown();
  server.stop();
  rpcServer.stop();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
