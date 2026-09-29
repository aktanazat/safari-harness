// MCP server over stdio: exposes every harness tool to any MCP client
// (omp, Claude Code, Cursor, ...). One JSON-RPC message per line.

import { join } from "node:path";
import { TOOLS, formatResult, inputSchema, type Tool } from "./tools.ts";
import { CALLER_GROUPS } from "./caller.ts";
import { invoke, runsHere } from "./call.ts";
import { RESTART, newListing, newer } from "./fresh.ts";
import { beside, nameIn } from "./guard.ts";
import { connectHost } from "./host.ts";
import type { ReplSession } from "./repl.ts";

const SERVER_INFO = { name: "safari-harness", version: "0.1.0" };

// The Mac whose Safari this drives: SAFARI_HARNESS_HOST (safari mcp
// --host), else the saved default (safari host use). Tool calls wait for
// the tunnel; listing tools does not.
const hostReady = connectHost(process.env.SAFARI_HARNESS_HOST);
hostReady.catch(() => {});

// The daemon owns the extension bridge; MCP mode is a thin client that
// talks to the daemon over its HTTP RPC port instead of holding the socket.

// This connection's own REPL session: its bindings last as long as the
// connection, and its tabs close with it.
let repl: ReplSession | undefined;

const REPL_TOOL: Tool = {
  desc: "Run Playwright-style JavaScript against Safari: openTab(url), snapshot(page), page.locator(ref).click(), page.pdf(), cookie-bearing fetch, and site globals (slack, gmail, notion, youtube, x, linkedin, imessage...). Bindings persist; console.log returns values; 120 s limit. API: safari guide repl.",
  params: { code: { type: "string", description: "JavaScript; top-level await works" }, session: { type: "string", description: "a named session, shared with safari repl --session; omit for this connection's own" } },
  required: ["code"],
  run: async (a) => {
    // The repl's modules (node:vm, the site kits) load on its first call:
    // most sessions never make one, and this server lives as long as its session.
    const [{ ReplSession }, { REPL_DIR, runInSession }] = await Promise.all([import("./repl.ts"), import("./repl-host.ts")]);
    const code = String(a.code ?? "");
    const r = a.session === undefined
      ? await (repl ??= new ReplSession(`mcp-${process.pid}`, { cwd: join(REPL_DIR, `mcp-${process.pid}`) })).run(code)
      : await runInSession(String(a.session), code, { host: process.env.SAFARI_HARNESS_HOST });
    if (r.error) throw new Error(`${r.output ? `${r.output}\n` : ""}${r.error}`);
    return r.output || "(no output; console.log what you want back)";
  },
};

const SESSION_NOTES: Record<string, string> = {
  close: " Not needed once you have the answer: your tabs close themselves when your turn ends. Reply instead.",
};

// Caller tools run here, not in the daemon: this process inherits the
// terminal's permissions (see caller.ts).
function toolDefs() {
  return [
    ...Object.entries(TOOLS).filter(([, t]) => !t.hidden).map(([name, t]) => ({ name, description: `[Safari] ${t.desc}${SESSION_NOTES[name] ?? ""}`, inputSchema: inputSchema(t) })),
    { name: "repl", description: `[Safari] ${REPL_TOOL.desc}`, inputSchema: inputSchema(REPL_TOOL) },
    ...CALLER_GROUPS.flatMap((g) => Object.entries(g.tools).filter(([, t]) => !t.hidden).map(([name, t]) => ({ name, description: `[${g.label}] ${t.desc}`, inputSchema: inputSchema(t) }))),
  ];
}

type RpcMsg = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };

function reply(id: number | string | undefined, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyErr(id: number | string | undefined, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
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
      return reply(msg.id, { tools: newListing() ?? toolDefs() });
    case "tools/call": {
      const name = String((msg.params as { name?: string })?.name ?? "");
      const args = ((msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {});
      try {
        await hostReady;
        // After a deploy, the code that runs here is out of date, and so is
        // a call to a tool the daemon no longer has; the rest still work.
        const update = await newer(() => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`));
        if (update && (name === "repl" || runsHere(name, args) || nameIn(update.tools, name) === undefined)) throw new Error(RESTART);
        const value = name === "repl" ? await REPL_TOOL.run(args) : await invoke(name, args, true);
        return reply(msg.id, {
          content: [{ type: "text", text: formatResult(update ? beside(value, "note", RESTART) : value).slice(0, 100_000) }],
        });
      } catch (e) {
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
  process.on(sig, () => { void Promise.resolve(repl?.close()).finally(() => process.exit(0)); });
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
await repl?.close();
