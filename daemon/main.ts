// Safari Harness daemon.
//
//   bun daemon/main.ts
//
// Endpoints:
//   ws   :SAFARI_HARNESS_WS (default 37333)
//     /              extension background worker connects here
//     /devtools/…    CDP-compatible shim for Chrome-protocol clients
//   http :SAFARI_HARNESS_HTTP_PORT (default 37334)
//     /rpc           {tool,args} -> {ok,value|error}   (CLI + MCP client)
//     /health        bridge status

import { bridge, DEFAULT_PORT } from "./bridge.ts";
import { TOOLS, callTool } from "./tools.ts";
import { handleCdp, stopConnPumps, stopAllPumps, type CdpMsg } from "./cdp.ts";

const wsPort = Number(process.env.SAFARI_HARNESS_WS ?? DEFAULT_PORT);
const httpPort = Number(process.env.SAFARI_HARNESS_HTTP_PORT ?? 37334);

type SocketScope =
  | { kind: "extension" }
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

const server = Bun.serve<SocketScope>({
  port: wsPort,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/devtools/")) {
      const pageMatch = url.pathname.match(/^\/devtools\/page\/(\d+)/);
      const connId = ++connSeq;
      const scope: SocketScope = pageMatch
        ? { kind: "page", tabId: Number(pageMatch[1]), connId }
        : { kind: "browser", connId };
      return srv.upgrade(req, { data: scope }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/") {
      return srv.upgrade(req, { data: { kind: "extension" } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "extension") bridge.attach(ws);
    },
    message(ws, raw) {
      const text = String(raw);
      if (ws.data.kind === "extension") {
        bridge.handleMessage(text);
        return;
      }
      const msg = safeParse(text);
      if (!msg) return;
      const scope = ws.data.kind === "extension" ? null : ws.data;
      if (scope) handleCdp((obj) => ws.send(JSON.stringify(obj)), msg as CdpMsg, scope);
    },
    close(ws) {
      if (ws.data.kind === "extension") bridge.detach();
      else stopConnPumps(ws.data.connId);
    },
  },
});

const rpcServer = Bun.serve({
  port: httpPort,
  async fetch(req) {
    const url = new URL(req.url);
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
    if (url.pathname === "/shutdown") {
      setTimeout(() => { stopAllPumps(); bridge.detach(); server.stop(); rpcServer.stop(); process.exit(0); }, 50);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[safari-harness] extension+cdp ws :${wsPort}  rpc http :${httpPort}`);

process.on("SIGINT", () => {
  stopAllPumps();
  bridge.detach();
  server.stop();
  rpcServer.stop();
  process.exit(0);
});
