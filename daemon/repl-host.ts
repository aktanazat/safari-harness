// Named REPL sessions. Each runs in a process of its own, started by the
// first call that names it, so its bindings last from one call to the
// next, whichever terminal or agent makes it. `safari repl` without a
// name runs in the calling agent's own session, agent-<pid> (owner.ts
// finds the agent), which also ends when that agent exits. Each call
// names the process that made it (callFor in rpc.ts), so the tabs its
// code opens are the agent's above that process: they open in that
// agent's window and close as its turn ends, or after 20 minutes unused.
// It answers on a unix socket only its user can open, and ends after half
// an hour unused, closing the tabs it still has but one kept for the
// user. It is started from the caller, so it has the caller's permissions
// (Full Disk Access for imessage), which the daemon under launchd lacks.
//
//   bun daemon/repl-host.ts <id> [pid]   serve session <id> (callers start
//                                        this); with pid, it ends when
//                                        that process does

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readdir, rmdir, stat, unlink, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPL_TIMEOUT_MS, ReplSession, type ReplResult } from "./repl.ts";
import { connectHost } from "./host.ts";
import { pageHost } from "./notes.ts";
import { alive, ownerOf, watchOwner } from "./owner.ts";
import { callFor, currentTask, ownCalls, withTask } from "./rpc.ts";

export const REPL_DIR = join(homedir(), ".local/share/safari-harness/repl");
const IDLE_MS = 30 * 60_000;
// A gone session's log that says something is kept a week.
const LOG_KEPT_MS = 7 * 24 * 60 * 60_000;
// Longer than a session takes to answer once started (start).
const STARTING_MS = 60_000;

// owner: the agent that last ran code in the session (owner.ts).
export type SessionInfo = { id: string; pid: number; host: string; started: string; lastUsed: string; pwd: string; tabs: { id: number; url: string }[]; owner?: number };

// A unix socket path must fit in 104 bytes; ids stay short and plain.
export function checkSessionId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error(`session names use letters, digits, - and _ (at most 40): ${JSON.stringify(id)}`);
  return id;
}

const socketOf = (id: string) => join(REPL_DIR, `${id}.sock`);

async function ask(id: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`http://session${route}`, {
    method: body === undefined ? "GET" : "POST",
    unix: socketOf(id),
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function info(id: string): Promise<SessionInfo | null> {
  try {
    return (await (await ask(id, "/info")).json()) as SessionInfo;
  } catch {
    return null;
  }
}

// The session connects to its Mac itself: a tunnel this process opened
// ends with this process, so the child gets the host's name, not its port.
// With endsWith, it also ends when that process does.
async function start(id: string, host: string | undefined, endsWith: number | undefined): Promise<void> {
  const dir = join(REPL_DIR, id);
  await mkdir(dir, { recursive: true });
  // just made or reused, its time says it is starting (sweep)
  const now = new Date();
  await utimes(dir, now, now);
  await chmod(REPL_DIR, 0o700);
  await unlink(socketOf(id)).catch(() => {});
  const env = { ...process.env };
  delete env.PI_SESSION_ID;
  const remote = env.SAFARI_HARNESS_REMOTE;
  if (remote) {
    delete env.SAFARI_HARNESS_HTTP;
    delete env.SAFARI_HARNESS_REMOTE;
  }
  const target = host ?? remote;
  if (target) env.SAFARI_HARNESS_HOST = target;
  const log = openSync(join(REPL_DIR, `${id}.log`), "a");
  const child = spawn(process.execPath, [import.meta.path, id, ...(endsWith === undefined ? [] : [String(endsWith)])], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
  child.unref();
  closeSync(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await info(id)) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(100);
  }
  throw new Error(`session ${id} did not start; see ${join(REPL_DIR, `${id}.log`)}`);
}

// Runs code in session id, starting the session if it is not running. A
// session it starts says which others the calling agent runs, and ends
// when the process endsWith names does, if one is named.
export async function runInSession(id: string, code: string, opts: { host?: string; timeoutMs?: number; endsWith?: number } = {}): Promise<ReplResult & { started: boolean; hint?: string }> {
  checkSessionId(id);
  const task = currentTask();
  let started = false;
  const running = await info(id);
  if (!running) {
    await start(id, opts.host, opts.endsWith);
    started = true;
  } else if (opts.host && opts.host !== running.host) {
    throw new Error(`session ${id} runs on ${running.host}; end it first (safari repl --close ${id}) or use another name`);
  }
  const res = await ask(id, "/run", { code, timeoutMs: opts.timeoutMs ?? REPL_TIMEOUT_MS, caller: process.pid, ...(task === undefined ? {} : { task }) });
  const result = { ...((await res.json()) as ReplResult), started };
  const hint = started ? await alsoRunning(id) : undefined;
  return hint === undefined ? result : { ...result, hint };
}

// The calling agent's other sessions, as a hint to go on in one. From 09-26
// to 10-05, 40 of 191 session names were one agent's numbered retries (rh,
// rh2 … rh16; tt-agent … tt-agent4), each starting over with new tabs, and
// on 10-05 one agent ran its tire research in five sessions at once.
async function alsoRunning(id: string): Promise<string | undefined> {
  const me = await ownerOf(process.pid);
  if (me === undefined) return undefined;
  const mine = (await listSessions()).filter((s) => s.id !== id && s.owner === me);
  if (mine.length === 0) return undefined;
  const named = mine.map((s) => {
    const sites = [...new Set(s.tabs.map((t) => pageHost(t.url)).filter((h) => h !== undefined))];
    return sites.length === 0 ? s.id : `${s.id} (${sites.join(", ")})`;
  });
  return `you already run ${mine.length === 1 ? "session" : "sessions"} ${named.join(", ")}: go on in one, where its tabs and bindings are, rather than start another`;
}

export async function listSessions(): Promise<SessionInfo[]> {
  let names: string[] = [];
  try { names = await readdir(REPL_DIR); } catch { return []; }
  const found = await Promise.all(names.filter((n) => n.endsWith(".sock")).map(async (n) => {
    const id = n.slice(0, -5);
    const i = await info(id);
    if (!i) await unlink(socketOf(id)).catch(() => {});
    return i;
  }));
  return found.filter((i): i is SessionInfo => i !== null);
}

// What session id leaves: its folder if nothing was saved in it, and its
// log if empty or a week old.
async function tidy(id: string): Promise<void> {
  await rmdir(join(REPL_DIR, id)).catch(() => {});
  const log = join(REPL_DIR, `${id}.log`);
  const s = await stat(log).catch(() => undefined);
  if (s && (s.size === 0 || Date.now() - s.mtimeMs > LOG_KEPT_MS)) await unlink(log).catch(() => {});
}

// What sessions that are gone left, as a session starts: one killed, or
// one ended before its folder was tidied (10-21: 11 folders and 15 logs,
// all empty). One whose folder changed in the last minute may be starting.
// An MCP server's own session (mcp-tools.ts) runs in that server, with no
// socket, and is gone only once the server is.
async function sweep(self: string): Promise<void> {
  const names = await readdir(REPL_DIR).catch(() => []);
  const ids = new Set(names.filter((n) => !n.endsWith(".sock")).map((n) => n.replace(/\.log$/, "")));
  ids.delete(self);
  for (const id of ids) {
    const server = /^mcp-(\d+)$/.exec(id)?.[1];
    if (server !== undefined && alive(Number(server))) continue;
    const s = await stat(join(REPL_DIR, id)).catch(() => stat(join(REPL_DIR, `${id}.log`)).catch(() => undefined));
    if (!s || Date.now() - s.mtimeMs < STARTING_MS || (await info(id))) continue;
    await tidy(id);
  }
}

// Ends session id: its tabs close. Its files stay in its folder.
export async function closeSession(id: string): Promise<string> {
  checkSessionId(id);
  if (!(await info(id))) return `no session ${id} is running`;
  await ask(id, "/close", {});
  return `session ${id} ended; its files stay in ${join(REPL_DIR, id)}`;
}

async function serve(id: string, endsWith: number | undefined): Promise<void> {
  ownCalls();
  const host = await connectHost(process.env.SAFARI_HARNESS_HOST);
  const session = new ReplSession(id, { cwd: process.cwd() });
  const started = new Date().toISOString();
  let lastUsed = started;
  let owner: number | undefined;
  let busy = 0;
  let idle: Timer | undefined;
  const sock = socketOf(id);

  const end = async () => {
    clearTimeout(idle);
    await session.close().catch(() => {});
    // while its socket answers, no other host starts as id
    await tidy(id);
    await unlink(sock).catch(() => {});
    process.exit(0);
  };
  const rest = () => {
    clearTimeout(idle);
    if (busy === 0) idle = setTimeout(() => void end(), IDLE_MS);
  };

  Bun.serve({
    unix: sock,
    idleTimeout: 0,
    async fetch(req) {
      const route = new URL(req.url).pathname;
      if (route === "/info") {
        const sessionInfo: SessionInfo = { id, pid: process.pid, host, started, lastUsed, pwd: session.cwd, tabs: session.tabs.map((p) => ({ id: p.id, url: p.url() })), ...(owner === undefined ? {} : { owner }) };
        return Response.json(sessionInfo);
      }
      if (route === "/close") {
        setTimeout(() => void end(), 10);
        return Response.json({ ok: true });
      }
      if (route === "/run") {
        const { code, timeoutMs, caller, task } = (await req.json()) as { code: string; timeoutMs?: number; caller?: number; task?: string };
        busy += 1;
        clearTimeout(idle);
        try {
          return await withTask(typeof task === "string" && task.trim() ? task : undefined, async () => {
            const run = () => session.run(String(code), timeoutMs);
            if (!(Number.isInteger(caller) && Number(caller) > 1)) return Response.json(await run());
            owner = (await ownerOf(Number(caller))) ?? owner;
            return Response.json(await callFor(Number(caller), run));
          });
        } finally {
          busy -= 1;
          lastUsed = new Date().toISOString();
          rest();
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  await chmod(sock, 0o600);
  rest();
  void sweep(id);
  if (endsWith !== undefined) watchOwner(endsWith, () => void end());
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void end());
}

if (import.meta.main) {
  const id = checkSessionId(process.argv[2] ?? "");
  await serve(id, process.argv[3] === undefined ? undefined : Number(process.argv[3]));
}
