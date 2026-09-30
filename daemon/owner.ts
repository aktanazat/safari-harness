// Who a call works for: the agent process behind it. The calling side
// (rpc.ts) sends its own pid with every call; the daemon finds the agent
// above it (ownerOf), or takes that pid itself from a process that owns
// its calls (a named REPL session), and runs the call inside runAs, so any
// code under it can ask currentOwner(), and work a call leaves behind (a
// background tab, an unlocked password vault) can end when that agent
// exits (watchOwner).

import { AsyncLocalStorage } from "node:async_hooks";

// ---------- whose process ----------

// A shell that ran one command ends with it; omp, claude, codex, a script,
// or a terminal's login session lasts as long as the work does.
const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, fish: true, ksh: true, tcsh: true, csh: true };

// proc_pidinfo(PROC_PIDT_SHORTBSDINFO) fills struct proc_bsdshortinfo
// (sys/proc_info.h): the parent pid at byte 4, the executable's name
// (NUL-padded, 16 bytes) at 16. It answers for any user's process, so a
// walk passes through a terminal's root-owned login, and it spawns
// nothing (ps took a millisecond per ancestor). bun:ffi loads on first
// use: the CLI imports this file on every command and seldom needs it.
const SHORT_BSD_INFO = 13;
const INFO_BYTES = 64;
let kernel: Promise<(pid: number, into: Uint8Array) => boolean> | undefined;

function loadKernel() {
  kernel ??= import("bun:ffi").then(({ dlopen, FFIType, ptr }) => {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    return (pid: number, into: Uint8Array) => symbols.proc_pidinfo(pid, SHORT_BSD_INFO, 0n, ptr(into), INFO_BYTES) === INFO_BYTES;
  });
  return kernel;
}

// The first ancestor of pid that is not a shell, while pid runs.
export async function ownerOf(pid: number): Promise<number | undefined> {
  const read = await loadKernel();
  const info = new Uint8Array(INFO_BYTES);
  const parent = new DataView(info.buffer);
  const names = new TextDecoder();
  if (!read(pid, info)) return undefined;
  for (let p = parent.getUint32(4, true); p > 1; p = parent.getUint32(4, true)) {
    if (!read(p, info)) return undefined;
    if (!SHELLS[names.decode(info.subarray(16, 32)).split("\0", 1)[0]]) return p;
  }
  return undefined;
}

// The name of pid's executable (its first 16 characters), while it runs:
// omp, claude, codex, bun.
export async function processName(pid: number): Promise<string | undefined> {
  const read = await loadKernel();
  const info = new Uint8Array(INFO_BYTES);
  return read(pid, info) ? new TextDecoder().decode(info.subarray(16, 32)).split("\0", 1)[0] : undefined;
}

// ---------- daemon side ----------

const scope = new AsyncLocalStorage<number | undefined>();

export function runAs<T>(pid: number | undefined, fn: () => T): T {
  return scope.run(pid, fn);
}

export function currentOwner(): number | undefined {
  return scope.getStore();
}

// One sweep checks every watched pid each second (a signal-0 kill each),
// and runs only while something is watched.
const SWEEP_MS = 1000;
const watchers = new Map<number, Set<() => void>>();
let sweep: Timer | undefined;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process runs, as another user
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

function sweepOnce() {
  for (const [pid, exits] of watchers) {
    if (alive(pid)) continue;
    watchers.delete(pid);
    for (const onExit of exits) {
      try {
        onExit();
      } catch (e) {
        console.error(`[safari-harness] cleanup after pid ${pid} exited failed:`, e);
      }
    }
  }
  if (watchers.size === 0) {
    clearInterval(sweep);
    sweep = undefined;
  }
}

// Calls onExit once, from the sweep, after pid exits. The returned function
// stops this watch (and no other on the same pid).
export function watchOwner(pid: number, onExit: () => void): () => void {
  const exit = () => onExit();
  const exits = watchers.get(pid) ?? new Set();
  exits.add(exit);
  watchers.set(pid, exits);
  sweep ??= setInterval(sweepOnce, SWEEP_MS);
  sweep.unref();
  return () => {
    exits.delete(exit);
    if (exits.size === 0 && watchers.get(pid) === exits) watchers.delete(pid);
  };
}
