// Client for the daemon's HTTP RPC port, for code that runs outside the
// daemon: the MCP server, the REPL, and the tools that run in the calling
// process. The address is read on each call, so a process that opens a
// tunnel to another Mac (safari host) can point here after it starts.
//
// Every call carries this process's pid, from which the daemon finds the
// agent it works for (owner.ts), except one bound for another Mac, whose
// daemon cannot see this Mac's processes. A process that works for itself
// says so (ownCalls), as does one that works for an agent another process
// found (the pairing's, pair.ts). A call the daemon never took, refused
// while it restarts or answered 503 while it finishes its calls in flight
// first, is made again, once, as soon as a daemon answers again.

import { AsyncLocalStorage } from "node:async_hooks";
import { ownerOf } from "./owner.ts";
import { HarnessError, readFailure } from "./failures.ts";
import { affectsPage } from "./lanes.ts";

export function daemonHttp(): string {
  return process.env.SAFARI_HARNESS_HTTP ?? "http://127.0.0.1:37334";
}

// A named REPL session's process (repl-host.ts) outlives the command that
// started it, which is the agent the daemon would find above it: its tabs
// would close once that command exited, after the session's first call.
// Each run names the process that asked for it instead (callFor), and the
// run's calls work for the agent above that process, as the asker's own
// calls would: their tabs join that agent's window and close as its turn
// ends. Before (10-02), the session owned them: every session opened a
// window of its own, and its tabs outlived the turn by 20 minutes. A call
// outside any run, as the session closes its tabs on ending, works for the
// session itself (ownCalls).
let ownsCalls: number | undefined;
const asker = new AsyncLocalStorage<number>();

export function ownCalls(pid = process.pid): void {
  ownsCalls = pid;
}

// The agent a call made now works for, as the daemon finds it (main.ts).
export async function agentOf(): Promise<number | undefined> {
  const asked = asker.getStore();
  return asked === undefined && ownsCalls !== undefined ? ownsCalls : ownerOf(asked ?? process.pid);
}

export function callFor<T>(pid: number, fn: () => T): T {
  return asker.run(pid, fn);
}

// A task is scoped to one invocation, not to a shared MCP process or REPL.
// The object also represents an explicit unnamed invocation: it must not
// fall back to the environment inherited when a named session started.
const tasks = new AsyncLocalStorage<{ task: string | undefined }>();

export function withTask<T>(task: string | undefined, fn: () => T): T {
  return tasks.run({ task }, fn);
}

export function currentTask(): string | undefined {
  const context = tasks.getStore();
  if (context !== undefined) return context.task;
  const task = process.env.SAFARI_HARNESS_TASK;
  return task && task.trim() ? task : undefined;
}

type Missed = "refused" | "restarting";

// How long a call waits for the daemon to answer again: launchd starts a
// stopped daemon again within a second or two, and one that answered 503
// first finishes its calls in flight, for up to a minute.
const BACK_MS: Record<Missed, number> = { refused: 15000, restarting: 75000 };

async function attempt(base: string, body: string, effectful: boolean): Promise<Response | Missed> {
  try {
    const res = await fetch(`${base}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body });
    return res.status === 503 ? "restarting" : res;
  } catch (e) {
    const code = e instanceof Error && "code" in e ? e.code : undefined;
    if (code === "ConnectionRefused") return "refused";
    // The daemon took the call and ended before it answered: the call may
    // have acted (a click, a submit), so it is not made again.
    const effect = effectful ? "possibly_effected" : "none";
    if (code === "ECONNRESET") throw new HarnessError(effectful ? "effect_unknown" : "unavailable", "the safari daemon stopped before it answered (it crashed or was killed), so the call may have run; check the page before trying it again", { effect, next: "read the page before repeating the call" });
    throw new HarnessError("unavailable", `safari daemon not reachable at ${base} (${e instanceof Error ? e.message : String(e)}); check it with: safari status`, { effect, next: effectful ? "check safari status, then read the page before repeating the action" : "check safari status" });
  }
}

// Whether a daemon that is not stopping answers /health within ms.
async function back(base: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const health = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).json()) as { stopping?: string };
      if (!health.stopping) return true;
    } catch {
      // not listening yet
    }
    await Bun.sleep(250);
  }
  return false;
}

// A call that runs in this process (call.ts) makes daemon calls of its own
// along the way. Their answers leave the agent's news of its tabs
// (continuity.ts) to the one the agent gets, which takes it once at the end.
const quiet = new AsyncLocalStorage<true>();

export function quietly<T>(fn: () => Promise<T>): Promise<T> {
  return quiet.run(true, fn);
}

// Whether a call made now takes the agent's news.
export function takesNews(): boolean {
  return quiet.getStore() === undefined;
}

// model: the call is one a model wrote, which the daemon checks and
// watches (guard.ts).
export async function rpc(tool: string, args: Record<string, unknown> = {}, model = false): Promise<unknown> {
  const base = daemonHttp();
  const asked = asker.getStore();
  const task = currentTask();
  const body = JSON.stringify({ tool, args, caller: process.env.SAFARI_HARNESS_REMOTE ? undefined : (asked ?? ownsCalls ?? process.pid), ...(task === undefined ? {} : { task }), ...(ownsCalls !== undefined && asked === undefined ? { own: true } : {}), ...(model ? { model } : {}), ...(takesNews() ? {} : { news: false }) });
  const effectful = affectsPage(tool, args);
  let res = await attempt(base, body, effectful);
  if (typeof res === "string" && (await back(base, BACK_MS[res]))) res = await attempt(base, body, effectful);
  if (res === "refused") throw new HarnessError("unavailable", `safari daemon not reachable at ${base}; check it with: safari status (install it with: safari daemon install)`, { effect: "none", retryable: true, next: "check safari status and start the daemon if needed" });
  if (res === "restarting") throw new HarnessError("unavailable", `the safari daemon at ${base} is restarting and did not answer again within ${BACK_MS.restarting / 1000} s; check it with: safari status`, { effect: "none", retryable: true, next: "wait for the daemon to finish restarting" });
  const out = (await res.json()) as { ok: boolean; value?: unknown; error?: string; failure?: unknown };
  if (!out.ok) {
    const failure = readFailure(out.failure);
    if (failure) throw new HarnessError(failure.code, failure.message, { retryable: failure.retryable, effect: failure.effect, next: failure.next });
    throw new HarnessError("command_failed", out.error ?? "rpc failed", { effect: effectful ? "possibly_effected" : "none", next: effectful ? "read the page before repeating the action" : "check the error before trying again" });
  }
  return out.value;
}
