// The tools an MCP server offers, as one release has them. The server
// (mcp.ts) holds its client's connection for the whole agent session, across
// deploys, and runs each call with this module from the newest release the
// daemon runs (fresh.ts). Servers started on older releases call these three
// exports of newer ones: keep their names and signatures as they are.

import { join } from "node:path";
import { TOOLS, formatResult, inputSchema, type Tool } from "./tools.ts";
import { CALLER_GROUPS } from "./caller.ts";
import { invoke } from "./call.ts";
import { saveAnswer } from "./save.ts";
import type { ReplSession } from "./repl.ts";

// This connection's own REPL session: its bindings last as long as the
// connection runs this release, and its tabs close with it.
let repl: ReplSession | undefined;

const REPL_TOOL: Tool = {
  desc: "Run Playwright-style JavaScript in Safari: openTab(url), snapshot(page), page.locator(ref).click(), cookie-bearing fetch, site globals (slack, gmail, x...). Bindings persist; console.log returns values; 120 s limit; MCP clients may cut a call at 60 s: split long waits. API: safari guide repl.",
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
    return r.output || "(no output; return or console.log what you want back)";
  },
};

const SESSION_NOTES: Record<string, string> = {
  close: " Not needed once you have the answer: your tabs close themselves when your turn ends. Reply instead.",
};

// A tool's schema as the client gets it. do is never listed required: the
// daemon takes action and go as do (guard.ts) and refuses a call with none,
// but omp checks required before a call leaves it, and refused real_input
// {action: "click"} for want of do before the daemon could take it
// (01a0f145, 09-30).
function published(t: Tool) {
  const schema = inputSchema(t);
  return t.required?.includes("do") ? { ...schema, required: t.required.filter((k) => k !== "do") } : schema;
}

// Caller tools run in the server's process, not in the daemon: it inherits
// the terminal's permissions (see caller.ts).
export function listTools(): unknown[] {
  return [
    ...Object.entries(TOOLS).filter(([, t]) => !t.hidden).map(([name, t]) => ({ name, description: `[Safari] ${t.desc}${SESSION_NOTES[name] ?? ""}`, inputSchema: published(t) })),
    { name: "repl", description: `[Safari] ${REPL_TOOL.desc}`, inputSchema: published(REPL_TOOL) },
    ...CALLER_GROUPS.flatMap((g) => Object.entries(g.tools).filter(([, t]) => !t.hidden).map(([name, t]) => ({ name, description: `[${g.label}] ${t.desc}`, inputSchema: published(t) }))),
  ];
}

// A reply keeps an answer's first 30 000 characters, as the agent loop's
// does (agent.ts); a longer answer is saved whole, and the reply says where.
// The cut was 100 000 characters and said nothing; on 10-01 and 10-02, 82
// answers past 10 000 made up half of the 3 M characters ten sessions read.
const REPLY_CHARS = 30_000;

// A call's answer as the client reads it; a failed call throws.
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const value = name === "repl" ? await REPL_TOOL.run(args) : await invoke(name, args, true);
  const text = formatResult(value);
  if (text.length <= REPLY_CHARS) return text;
  const path = await saveAnswer(text);
  return `${text.slice(0, REPLY_CHARS)}\n…cut at ${REPLY_CHARS} of ${text.length} characters; the whole answer is in ${path}: read the part you need from it, or narrow the read (query, root, selector)`;
}

// The connection ends: the REPL session's tabs close.
export async function closeSession(): Promise<void> {
  await repl?.close();
}
