// MCP server over stdio: exposes every harness tool to any MCP client
// (omp, Claude Code, Cursor, ...). One JSON-RPC message per line.

import { TOOLS, formatResult, inputSchema } from "./tools.ts";

const SERVER_INFO = { name: "safari-harness", version: "0.1.0" };

// The daemon owns the extension bridge; MCP mode is a thin client that
// talks to the daemon over its HTTP RPC port instead of holding the socket.
const DAEMON_HTTP = process.env.SAFARI_HARNESS_HTTP ?? "http://127.0.0.1:37334";

async function rpc(tool: string, args: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${DAEMON_HTTP}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
  } catch {
    throw new Error(`safari daemon not reachable at ${DAEMON_HTTP}; run: safari daemon install`);
  }
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!body.ok) throw new Error(body.error ?? "rpc failed");
  return body.value;
}

function toolDefs() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: `[Safari] ${t.desc}`,
    inputSchema: inputSchema(t),
  }));
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
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return; // no response for notifications
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: toolDefs() });
    case "tools/call": {
      const name = String((msg.params as { name?: string })?.name ?? "");
      const args = ((msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {});
      try {
        const value = await rpc(name, args);
        return reply(msg.id, {
          content: [{ type: "text", text: formatResult(value).slice(0, 100_000) }],
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
