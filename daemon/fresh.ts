// A deploy puts a new release under running MCP servers, and each runs on
// the code it started with for as long as its agent session lasts: on
// 01a0d71e an agent's tool list was 30.5 h old and named a tool the harness
// had dropped. So before a call, the server compares its code with the
// daemon's (/health reports the hash the daemon started with). Once they
// differ, the server lists the new release's tools and tells the client
// once to list them again (mcp.ts). Calls whose code runs in this process
// get the restart message (mcp.ts decides which); the rest still go to the
// daemon.

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { codeHash } from "./codehash.ts";
import { daemonHttp } from "./rpc.ts";

export const RESTART = "the harness was updated since this MCP server started; restart the Safari MCP server (or the agent) to load the new tools";

// This server's own release, fixed as it starts: a deploy moves the
// current link, never a release under it.
const ROOT = realpathSync(join(import.meta.dir, ".."));
let own: string | undefined;

// A check holds for a few seconds, and the calls made while it runs share
// it: an agent's calls come faster than deploys.
const CHECK_MS = 5000;
let last: { at: number; check: Promise<Newer | undefined> } | undefined;

// The daemon's tools, and the new release's list of all of them.
export type Newer = { tools: string[]; listing: unknown[] | undefined };
let found: Promise<Newer> | undefined;
let latest: Newer | undefined;

type Health = { code?: string; root?: string; tools?: string[] };

// The newer release the daemon runs, once it differs from this server's.
// announce runs once, when it is found, after its list is ready.
export function newer(announce: () => void): Promise<Newer | undefined> {
  if (found) return found;
  // Another Mac's daemon runs whatever release that Mac has.
  if (process.env.SAFARI_HARNESS_REMOTE) return Promise.resolve(undefined);
  const now = Date.now();
  if (last && now - last.at < CHECK_MS) return last.check;
  const check = daemonHealth().then((health) => {
    if (!health?.code || health.code === (own ??= codeHash(ROOT))) return undefined;
    found ??= toolList(health.root).then((listing) => {
      latest = { tools: health.tools ?? [], listing };
      announce();
      return latest;
    });
    return found;
  });
  last = { at: now, check };
  return check;
}

// The new release's tool list, once a check has found one.
export const newListing = (): unknown[] | undefined => latest?.listing;

async function daemonHealth(): Promise<Health | undefined> {
  try {
    const body: unknown = await (await fetch(`${daemonHttp()}/health`, { signal: AbortSignal.timeout(2000) })).json();
    if (!body || typeof body !== "object") return undefined;
    return {
      code: "code" in body && typeof body.code === "string" ? body.code : undefined,
      root: "root" in body && typeof body.root === "string" ? body.root : undefined,
      tools: "tools" in body && Array.isArray(body.tools) ? body.tools.filter((t): t is string => typeof t === "string") : undefined,
    };
  } catch {
    // A daemon that does not answer fails the call itself, with its own message.
    return undefined;
  }
}

// The list the new release's MCP server gives; without one, the client
// lists this server's own tools again.
async function toolList(root: string | undefined): Promise<unknown[] | undefined> {
  if (!root) return undefined;
  const proc = Bun.spawn([process.execPath, join(root, "daemon", "mcp.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    // The address keeps the new server on this daemon: without one, it
    // would dial the saved default host.
    env: { ...process.env, SAFARI_HARNESS_HTTP: daemonHttp() },
    timeout: 10_000,
  });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  proc.stdin.end();
  const line = (await new Response(proc.stdout).text()).split("\n")[0];
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = reply && typeof reply === "object" && "result" in reply ? reply.result : undefined;
  const tools = result && typeof result === "object" && "tools" in result ? result.tools : undefined;
  return Array.isArray(tools) ? tools : undefined;
}
