// MCP server over stdio: exposes every harness tool to any MCP client
// (omp, Claude Code, Cursor, ...). One JSON-RPC message per line.

import { TOOLS, formatResult, inputSchema } from "./tools.ts";
import { CALLER_GROUPS, CALLER_TOOLS } from "./caller.ts";
import { rpc } from "./rpc.ts";

const SERVER_INFO = { name: "safari-harness", version: "0.1.0" };

// The daemon owns the extension bridge; MCP mode is a thin client that
// talks to the daemon over its HTTP RPC port instead of holding the socket.

// Background tabs this session opened, and tabs they opened in turn. The
// user never saw them, so they close when the session ends, and an agent
// that is done need not spend a turn on close.
const owned = new Set<number>();

function idOf(v: unknown): number | undefined {
  return v && typeof v === "object" && "id" in v && typeof v.id === "number" ? v.id : undefined;
}

function track(tool: string, args: Record<string, unknown>, value: unknown) {
  if (!value || typeof value !== "object") return;
  const tab = args.tab === undefined ? undefined : Number(args.tab);
  if (tool === "open" && args.background) {
    const id = idOf(value);
    if (id !== undefined) owned.add(id);
  }
  if (tool === "close" && tab !== undefined) owned.delete(tab);
  const opened = "newTab" in value ? idOf(value.newTab) : undefined;
  if (opened !== undefined && tab !== undefined && owned.has(tab)) owned.add(opened);
  // run: each step as if called alone; a step without tab uses the latest open
  if (tool === "run" && "steps" in value && Array.isArray(value.steps) && Array.isArray(args.steps)) {
    let last: number | undefined;
    for (const s of value.steps as { step: number; tool: string; value?: unknown }[]) {
      const input: unknown = args.steps[s.step - 1];
      const stepArgs = input && typeof input === "object" && "args" in input && input.args && typeof input.args === "object" ? input.args as Record<string, unknown> : {};
      track(s.tool, stepArgs.tab === undefined && last !== undefined ? { ...stepArgs, tab: last } : stepArgs, s.value);
      if (s.tool === "open") last = idOf(s.value) ?? last;
    }
  }
}

async function closeOwned() {
  await Promise.all([...owned].map((tab) => rpc("close", { tab }).catch(() => {})));
  owned.clear();
}

const SESSION_NOTES: Record<string, string> = {
  close: " Not needed once you have the answer: background tabs close themselves when this session ends. Reply instead.",
};

// Caller tools run here, not in the daemon: this process inherits the
// terminal's permissions (see caller.ts).
function toolDefs() {
  return [
    ...Object.entries(TOOLS).filter(([, t]) => !t.hidden).map(([name, t]) => ({ name, description: `[Safari] ${t.desc}${SESSION_NOTES[name] ?? ""}`, inputSchema: inputSchema(t) })),
    ...CALLER_GROUPS.flatMap((g) => Object.entries(g.tools).map(([name, t]) => ({ name, description: `[${g.label}] ${t.desc}`, inputSchema: inputSchema(t) }))),
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
        const local = CALLER_TOOLS[name];
        const value = local ? await local.run(args) : await rpc(name, args);
        track(name, args, value);
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

// The client ends the session by closing stdin, or by a signal.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => { closeOwned().finally(() => process.exit(0)); });
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
await closeOwned();
