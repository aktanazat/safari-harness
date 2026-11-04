// A deploy puts a new release under running MCP servers, and each server
// lives as long as its agent's session. Running on the code it started with,
// it listed tools the harness had dropped (on 01a0d71e, 30.5 h old), and on
// 2026-09-29 two sessions started before a deploy could not send a text or
// read a login: they refused with a restart message no agent can act on,
// since an agent cannot restart its own MCP server. So before a call, the
// server compares the code its calls run with the daemon's (/health reports
// the hash and folder of the release the daemon started with). Once they
// differ, it loads that release's mcp-tools.ts into this process and runs
// every call with it, and tells the client once to list the tools again
// (mcp.ts). The process stays: its terminal's permissions are what the
// Messages, history, and input tools need.
//
// A release's tools load at the first call that runs on them. Every agent
// session runs a server, subagents of a few seconds included (8 of 14 on
// 10-21), and loaded at start the tools took 6 of each server's 16 MB for
// its whole session. Until that call a process of its own lists this
// release's tools. Modules never unload: a session that calls before and
// after a deploy holds both releases' tools (2.6 MB more, 10-21).

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { codeHash } from "./codehash.ts";
import type * as Own from "./mcp-tools.ts";
import { daemonHttp } from "./rpc.ts";

export type McpTools = Pick<typeof Own, "listTools" | "callTool" | "closeSession">;

// This server's own release, fixed as it starts: a deploy moves the
// current link, never a release under it.
const ROOT = realpathSync(join(import.meta.dir, ".."));

// The code calls run on: this release's (tools undefined) until the daemon
// runs another. Its hash is taken at the first check, which a session may
// never make.
let current: { code: string | undefined; tools: McpTools | undefined } = { code: undefined, tools: undefined };
// Every release this process loaded: each one's REPL session closes at exit.
const loaded: McpTools[] = [];
let own: Promise<McpTools> | undefined;
let ownList: unknown[] | undefined;

// A check holds for a few seconds, and the calls made while it runs share
// it: an agent's calls come faster than deploys.
const CHECK_MS = 5000;
let last: { at: number; check: Promise<McpTools> } | undefined;

// The tools calls run on now; this release's load at the first.
function calls(): Promise<McpTools> {
  if (current.tools) return Promise.resolve(current.tools);
  own ??= import("./mcp-tools.ts").then((tools: McpTools) => {
    loaded.push(tools);
    return tools;
  });
  return own;
}

// The tools of the release calls run on now, as the client lists them.
export async function listTools(): Promise<unknown[]> {
  const tools = current.tools ?? (await own);
  if (tools) return tools.listTools();
  ownList ??= await listApart();
  return ownList;
}

// This release's tools as `bun daemon/mcp-tools.ts` lists them.
async function listApart(): Promise<unknown[]> {
  const lister = Bun.spawn([process.execPath, join(ROOT, "daemon", "mcp-tools.ts")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(lister.stdout).text(), new Response(lister.stderr).text(), lister.exited]);
  if (exit !== 0) throw new Error(`the tools could not be listed: ${err.trim() || `exit ${exit}`}`);
  const tools: unknown = JSON.parse(out);
  if (!Array.isArray(tools)) throw new Error(`the tools could not be listed: ${out.slice(0, 200)}`);
  return tools;
}

// The tools of the release the daemon runs, loaded here once it differs
// from the one calls ran on. switched runs once per release loaded.
export function fresh(switched: () => void): Promise<McpTools> {
  // Another Mac's daemon runs whatever release that Mac has.
  if (process.env.SAFARI_HARNESS_REMOTE) return calls();
  const now = Date.now();
  if (last && now - last.at < CHECK_MS) return last.check;
  const check = daemonHealth().then(async (health) => {
    current.code ??= codeHash(ROOT);
    if (!health || health.code === current.code) return calls();
    const next = await load(health.root);
    current = { code: health.code, tools: next ?? current.tools };
    if (next) {
      loaded.push(next);
      switched();
    }
    return calls();
  });
  last = { at: now, check };
  return check;
}

export async function closeAll(): Promise<void> {
  await Promise.all(loaded.map((t) => t.closeSession()));
}

// The daemon's release is known only at run time, so its module is loaded
// by path. One from before mcp-tools.ts (a rollback past it) has none: calls
// keep the code they run on.
async function load(root: string): Promise<McpTools | undefined> {
  try {
    const mod: McpTools = await import(join(root, "daemon", "mcp-tools.ts"));
    return mod;
  } catch {
    return undefined;
  }
}

async function daemonHealth(): Promise<{ code: string; root: string } | undefined> {
  try {
    const body: unknown = await (await fetch(`${daemonHttp()}/health`, { signal: AbortSignal.timeout(2000) })).json();
    if (!body || typeof body !== "object" || !("code" in body) || typeof body.code !== "string" || !("root" in body) || typeof body.root !== "string") return undefined;
    return { code: body.code, root: body.root };
  } catch {
    // A daemon that does not answer fails the call itself, with its own message.
    return undefined;
  }
}
