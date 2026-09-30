// MCP server over stdio: exposes every harness tool to any MCP client
// (omp, Claude Code, Cursor, ...). One JSON-RPC message per line. The tools
// themselves come from mcp-tools.ts of the newest release (fresh.ts).

import { appendFileSync } from "node:fs";
import { closeAll, fresh, tools } from "./fresh.ts";
import { connectHost } from "./host.ts";
import { redactUrl } from "./redact.ts";

const SERVER_INFO = { name: "safari-harness", version: "0.1.0" };

// The Mac whose Safari this drives: SAFARI_HARNESS_HOST (safari mcp
// --host), else the saved default (safari host use). Tool calls wait for
// the tunnel; listing tools does not.
const hostReady = connectHost(process.env.SAFARI_HARNESS_HOST);
hostReady.catch(() => {});

// The daemon owns the extension bridge; MCP mode is a thin client that
// talks to the daemon over its HTTP RPC port instead of holding the socket.

type RpcMsg = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };

function reply(id: number | string | undefined, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyErr(id: number | string | undefined, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

// A routine's run (cli/launchd.ts) names its log in SAFARI_ROUTINE_LOG, and
// each call goes there on a line of its own, before the model's summary: a
// run's log held only that summary, with no trace of which call failed or
// how long each took (USCIS, 09-30). A string is shown only for these
// names, with any secret in an address cut; any other is given as its
// length, since a type's text or a repl's code can hold a password. The
// log stops at 400 lines or 64 KB, so a looping run cannot fill the disk.
const ROUTINE_LOG = process.env.SAFARI_ROUTINE_LOG;
const SHOWN: Record<string, true> = { tab: true, ref: true, do: true, url: true, key: true, selector: true, option: true, root: true, query: true, pick: true, site: true };
const LOG_MAX_LINES = 400;
const LOG_MAX_BYTES = 64 * 1024;
let logRoom = { lines: LOG_MAX_LINES, bytes: LOG_MAX_BYTES };

function shown(key: string, value: unknown): string {
  if (typeof value === "string") return SHOWN[key] === true ? JSON.stringify(redactUrl(value).slice(0, 80)) : `(${value.length} chars)`;
  if (Array.isArray(value)) return `[${value.length}]`;
  return value !== null && typeof value === "object" ? "{…}" : String(value);
}

function logCall(name: string, args: Record<string, unknown>, status: "ok" | "error", ms: number) {
  if (!ROUTINE_LOG || logRoom.lines < 0) return;
  const said = Object.entries(args).map(([k, v]) => `${k.slice(0, 20)}=${shown(k, v)}`).join(" ");
  const line = `${new Date().toISOString().slice(11, 23)} ${name.slice(0, 40)} ${said.slice(0, 300)} ${status} ${Math.round(ms)} ms\n`;
  logRoom = { lines: logRoom.lines - 1, bytes: logRoom.bytes - Buffer.byteLength(line) };
  const fits = logRoom.lines >= 0 && logRoom.bytes >= 0;
  if (!fits) logRoom.lines = -1;
  appendFileSync(ROUTINE_LOG, fits ? line : `later calls not logged: the log keeps ${LOG_MAX_LINES} lines or ${LOG_MAX_BYTES / 1024} KB of them\n`);
}

async function handle(msg: RpcMsg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: "2024-11-05",
        // A deploy since this server started is announced (fresh.ts).
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return; // no response for notifications
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: tools().listTools() });
    case "tools/call": {
      const name = String((msg.params as { name?: string })?.name ?? "");
      const args = ((msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {});
      const began = performance.now();
      try {
        await hostReady;
        const release = await fresh(() => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`));
        const text = await release.callTool(name, args);
        logCall(name, args, "ok", performance.now() - began);
        return reply(msg.id, { content: [{ type: "text", text }] });
      } catch (e) {
        logCall(name, args, "error", performance.now() - began);
        return reply(msg.id, {
          content: [{ type: "text", text: `error: ${String(e instanceof Error ? e.message : e)}` }],
          isError: true,
        });
      }
    }
    default:
      if (msg.id !== undefined) replyErr(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

// The client ends the session by closing stdin, or by a signal.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => { void closeAll().finally(() => process.exit(0)); });
}

let buf = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let parsed: RpcMsg | null = null;
    try { parsed = JSON.parse(line) as RpcMsg; } catch { continue; }
    handle(parsed).catch((e) => replyErr(parsed?.id, -32603, String(e)));
  }
}
await closeAll();
