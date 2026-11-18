// Owner leases. A call works for the agent above its process (owner.ts),
// and its tabs close once that agent exits. A command run over ssh, or by
// a script one process at a time, has no agent above it that lasts: the
// daemon found the ssh session, which ended with the command, and closed
// the tab it had opened. From 11-10 to 11-16 that happened 27 times in 16
// sessions ("closed once its agent exited"), and agents built three runner
// queues to keep one process alive (LocalMining, 11-17). SAFARI_OWNER=<key>
// (CLI --owner) names a lease instead: a small process of its own, started
// by the first call that names the key and found again by the next through
// a unix socket only this user can open. Calls with the key work for it, as
// a named REPL session's do (ownCalls in rpc.ts), so the daemon's tab limit,
// idle close, handoffs and kept tabs work as for any agent. The lease ends
// after IDLE_MS without a call, or on request (safari owner --end), never
// as a calling process exits; its tabs close then as an exited agent's do.
//
// A key is a name, not a secret: any process of this user that names it
// works for its lease, as any of them could already send the daemon a pid
// (own in main.ts). It reaches only the lease's own tabs, never an agent's,
// for the lease is a process apart that no agent's call names.
//
//   bun daemon/lease.ts <key>   serve the lease (callers start this)

import { spawn } from "node:child_process";
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HarnessError } from "./failures.ts";
import { remoteLease } from "./host.ts";
import { alive } from "./owner.ts";

const LEASE_DIR = join(homedir(), ".local/share/safari-harness/owners");
// As long as a named REPL session lasts unused (repl-host.ts).
const IDLE_MS = 30 * 60_000;
// A caller asks again after this long, which keeps a lease a long-lived
// caller (an MCP server) still uses from ending.
const ASK_AGAIN_MS = 60_000;

// The key this process's calls name, if any. A unix socket path must fit
// in 104 bytes, so keys stay short and plain, as REPL session names do.
export function ownerKey(): string | undefined {
  const key = process.env.SAFARI_OWNER;
  if (!key) return undefined;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) throw new HarnessError("invalid_argument", `SAFARI_OWNER (--owner) uses letters, digits, - and _ (at most 40): ${JSON.stringify(key)}`);
  return key;
}

const socketOf = (key: string) => join(LEASE_DIR, `${key}.sock`);

// The running lease's pid, which this call renews, or undefined.
async function ask(key: string, route: "/hold" | "/end"): Promise<number | undefined> {
  try {
    const said: unknown = await (await fetch(`http://lease${route}`, { method: "POST", unix: socketOf(key) })).json();
    return said && typeof said === "object" && "pid" in said && typeof said.pid === "number" ? said.pid : undefined;
  } catch {
    return undefined;
  }
}

async function start(key: string): Promise<number> {
  await mkdir(LEASE_DIR, { recursive: true });
  await chmod(LEASE_DIR, 0o700);
  const child = spawn(process.execPath, [import.meta.path, key], { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pid = await ask(key, "/hold");
    if (pid !== undefined) return pid;
    if (child.exitCode !== null && child.exitCode !== 0) break;
    await Bun.sleep(50);
  }
  throw new HarnessError("unavailable", `the lease for SAFARI_OWNER=${key} did not start`, { effect: "none", retryable: true });
}

const held = new Map<string, { pid: number; at: number }>();

// The lease key names, started if none runs, and renewed. Through --host,
// the lease runs on that Mac, beside the daemon that watches it. A local
// lease that ended (owner --end, or unused) is asked for again at once,
// not sent as a dead pid until the next ask.
export async function holdLease(key: string): Promise<number> {
  const known = held.get(key);
  const remote = process.env.SAFARI_HARNESS_REMOTE;
  if (known && Date.now() - known.at < ASK_AGAIN_MS && (remote || alive(known.pid))) return known.pid;
  const pid = remote ? await remoteLease(remote, key) : ((await ask(key, "/hold")) ?? (await start(key)));
  if (pid === undefined) throw new HarnessError("unavailable", `the lease for SAFARI_OWNER=${key} did not start on ${remote}`, { effect: "none", retryable: true });
  held.set(key, { pid, at: Date.now() });
  return pid;
}

// Ends the lease key names; its tabs close as an exited agent's do. The
// pid it had, or undefined when none ran.
export async function endLease(key: string): Promise<number | undefined> {
  held.delete(key);
  const remote = process.env.SAFARI_HARNESS_REMOTE;
  return remote ? remoteLease(remote, key, true) : ask(key, "/end");
}

// Whether the file at path is still the socket this process made (ino):
// another lease may have made a new one there since.
function ours(path: string, ino: number): boolean {
  try {
    return statSync(path).ino === ino;
  } catch {
    return false;
  }
}

// One start at a time per key holds key.lock: it was a look, then a
// listen, and in 8 of 15 tries four first calls at once left two or three
// leases running, one serving the socket and the others deleting it once
// they ended unused (review, 11-17). A lock left by a start that died
// goes after LOCK_STALE_MS.
const LOCK_STALE_MS = 10_000;

async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(LEASE_DIR, `${key}.lock`);
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age <= LOCK_STALE_MS && Date.now() <= deadline) await Bun.sleep(20);
      else try { unlinkSync(lock); } catch { /* another start took it */ }
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch { /* a stale-lock sweep took it */ }
  }
}

async function serve(key: string): Promise<void> {
  const sock = socketOf(key);
  let idle: Timer | undefined;
  let ino = -1;
  const end = async () => {
    if (ours(sock, ino)) await unlink(sock).catch(() => {});
    process.exit(0);
  };
  const renew = () => {
    clearTimeout(idle);
    idle = setTimeout(() => void end(), IDLE_MS);
  };
  const started = await locked(key, async () => {
    // a socket that answers is another lease's; one that does not is left
    // by a lease that died
    if ((await ask(key, "/hold")) !== undefined) return false;
    await unlink(sock).catch(() => {});
    Bun.serve({
      unix: sock,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/end") {
          setTimeout(() => void end(), 0);
          return Response.json({ pid: process.pid });
        }
        if (path === "/hold") {
          renew();
          return Response.json({ pid: process.pid });
        }
        return new Response("not found", { status: 404 });
      },
    });
    ino = statSync(sock).ino;
    return true;
  });
  if (!started) process.exit(0);
  renew();
}

if (import.meta.main) {
  const key = process.argv[2];
  if (!key || !/^[A-Za-z0-9_-]{1,40}$/.test(key)) process.exit(2);
  await serve(key);
}
