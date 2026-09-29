// MCP server over stdio: exposes every harness tool to any MCP client
// (omp, Claude Code, Cursor, ...). One JSON-RPC message per line. The tools
// themselves come from mcp-tools.ts of the newest release (fresh.ts).

import { closeAll, fresh, tools } from "./fresh.ts";
import { connectHost } from "./host.ts";

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
      try {
        await hostReady;
        const release = await fresh(() => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`));
        return reply(msg.id, { content: [{ type: "text", text: await release.callTool(name, args) }] });
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
