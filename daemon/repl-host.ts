// Named REPL sessions. Each runs in a process of its own, started by the
// first call that names it, so its bindings and tabs last from one call to
// the next, whichever terminal or agent makes it. The process answers on a
// unix socket only its user can open, and ends after half an hour unused,
// closing the tabs it opened. It is started from the caller, so it has the
// caller's permissions (Full Disk Access for imessage), which the daemon
// under launchd lacks.
//
//   bun daemon/repl-host.ts <id>     serve session <id> (callers start this)

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPL_TIMEOUT_MS, ReplSession, type ReplResult } from "./repl.ts";
import { connectHost } from "./host.ts";

export const REPL_DIR = join(homedir(), ".local/share/safari-harness/repl");
const IDLE_MS = 30 * 60_000;

export type SessionInfo = { id: string; pid: number; host: string; started: string; lastUsed: string; pwd: string; tabs: { id: number; url: string }[] };

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
async function start(id: string, host: string | undefined): Promise<void> {
  const dir = join(REPL_DIR, id);
  await mkdir(dir, { recursive: true });
  await chmod(REPL_DIR, 0o700);
  await unlink(socketOf(id)).catch(() => {});
  const env = { ...process.env };
  const remote = env.SAFARI_HARNESS_REMOTE;
  if (remote) {
    delete env.SAFARI_HARNESS_HTTP;
    delete env.SAFARI_HARNESS_REMOTE;
  }
  const target = host ?? remote;
  if (target) env.SAFARI_HARNESS_HOST = target;
  const log = openSync(join(REPL_DIR, `${id}.log`), "a");
  const child = spawn(process.execPath, [import.meta.path, id], {
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

// Runs code in session id, starting the session if it is not running.
export async function runInSession(id: string, code: string, opts: { host?: string; timeoutMs?: number } = {}): Promise<ReplResult & { started: boolean }> {
  checkSessionId(id);
  let started = false;
  const running = await info(id);
  if (!running) {
    await start(id, opts.host);
    started = true;
  } else if (opts.host && opts.host !== running.host) {
    throw new Error(`session ${id} runs on ${running.host}; end it first (safari repl --close ${id}) or use another name`);
  }
  const res = await ask(id, "/run", { code, timeoutMs: opts.timeoutMs ?? REPL_TIMEOUT_MS });
  return { ...((await res.json()) as ReplResult), started };
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

// Ends session id: its tabs close. Its files stay in its folder.
export async function closeSession(id: string): Promise<string> {
  checkSessionId(id);
  if (!(await info(id))) return `no session ${id} is running`;
  await ask(id, "/close", {});
  return `session ${id} ended; its files stay in ${join(REPL_DIR, id)}`;
}

async function serve(id: string): Promise<void> {
  const host = await connectHost(process.env.SAFARI_HARNESS_HOST);
  const session = new ReplSession(id, { cwd: process.cwd() });
  const started = new Date().toISOString();
  let lastUsed = started;
  let busy = 0;
  let idle: Timer | undefined;
  const sock = socketOf(id);

  const end = async () => {
    clearTimeout(idle);
    await session.close().catch(() => {});
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
        const sessionInfo: SessionInfo = { id, pid: process.pid, host, started, lastUsed, pwd: session.cwd, tabs: session.tabs.map((p) => ({ id: p.id, url: p.url() })) };
        return Response.json(sessionInfo);
      }
      if (route === "/close") {
        setTimeout(() => void end(), 10);
        return Response.json({ ok: true });
      }
      if (route === "/run") {
        const { code, timeoutMs } = (await req.json()) as { code: string; timeoutMs?: number };
        busy += 1;
        clearTimeout(idle);
        try {
          return Response.json(await session.run(String(code), timeoutMs));
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
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void end());
}

if (import.meta.main) {
  const id = checkSessionId(process.argv[2] ?? "");
  await serve(id);
}
