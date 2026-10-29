// The call log: a line for each call the daemon ran (/rpc in main.ts) and
// for each drop of the extension's link (bridge.ts), kept KEPT_MS, so
// safari status can say how the last day went. On 10-29 nothing kept which
// calls failed or why the link dropped: counting the 533 drops of a day
// and a half took reading the daemon's log (StormRootCause). A line holds
// no argument, text, or address, only the host of a call's page.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { failedValue, failureOf, type Failure } from "./failures.ts";
import { affectsPage } from "./lanes.ts";
import { pageHost } from "./notes.ts";

const DAY_MS = 24 * 60 * 60_000;
const KEPT_MS = 7 * DAY_MS;
// The file loses its lines older than KEPT_MS when a daemon opens it and
// after every TRIM_EVERY lines it appends.
const TRIM_EVERY = 1000;

type Line = { t: string } & Record<string, unknown>;

let file: string | undefined;
let appended = 0;

// Appends to path from now on; anywhere else (tests) nothing is written.
export function openCalls(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  file = path;
  trim();
}

function lines(): Line[] {
  if (!file) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return []; // no calls yet
  }
  const read: Line[] = [];
  for (const raw of text.split("\n")) {
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (v && typeof v === "object" && "t" in v && typeof v.t === "string") read.push(v as Line);
  }
  return read;
}

function trim() {
  if (!file) return;
  const since = new Date(Date.now() - KEPT_MS).toISOString();
  writeFileSync(file, lines().filter((l) => l.t >= since).map((l) => `${JSON.stringify(l)}\n`).join(""));
  appended = 0;
}

// The log is written as calls answer and the link drops: a file it cannot
// write (its folder deleted, the disk full) must stop neither.
function append(line: Line) {
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    if (++appended >= TRIM_EVERY) trim();
  } catch (err) {
    console.error("[safari-harness] call log not written:", err instanceof Error ? err.message : err);
  }
}

// omp's task (taskOf in omp/index.ts): [session, agent], or [session,
// agent, lead] for a lead's subagent.
function taskParts(task: string | undefined): string[] | undefined {
  if (task === undefined) return undefined;
  try {
    const parts: unknown = JSON.parse(task);
    if (Array.isArray(parts) && (parts.length === 2 || parts.length === 3) && parts.every((p) => typeof p === "string")) return parts;
  } catch {
    // another client's task
  }
  return undefined;
}

// A call /rpc answered: when it came and how long it took, whose it was
// (the agent's process; from its task, the agent and its lead's session),
// its outcome (ok, or the failure's code, of a value that says it failed
// too), the bytes of the reply, whether a read was cut, and its page's host.
export function logCall(call: { t: number; ms: number; owner: number | undefined; task: string | undefined; tool: string; args: Record<string, unknown>; reply: { ok: true; value: unknown } | { ok: false; failure: Failure }; bytes: number }): void {
  const value = call.reply.ok && call.reply.value !== null && typeof call.reply.value === "object" ? call.reply.value as Record<string, unknown> : undefined;
  const outcome = !call.reply.ok ? call.reply.failure.code : failedValue(value) ? failureOf(value, { effectful: affectsPage(call.tool, call.args) }).code : "ok";
  const host = pageHost(call.args.url) ?? pageHost(value?.url);
  const task = taskParts(call.task);
  append({
    t: new Date(call.t).toISOString(),
    tool: call.tool,
    ms: call.ms,
    outcome,
    bytes: call.bytes,
    ...(value && (value.truncated === true || !!value.cut || value.incomplete !== undefined) ? { truncated: true } : {}),
    ...(host ? { host } : {}),
    ...(call.owner === undefined ? {} : { owner: call.owner }),
    ...(task ? { agent: task[1], lead: task[2] ?? task[0] } : {}),
  });
}

// The extension's link dropped (bridge.ts): why, its close code, and how
// many requests in flight it failed.
export function logDrop(drop: { cause: string; code?: number; lost: number }): void {
  append({ t: new Date().toISOString(), drop: drop.cause, ...(drop.code === undefined ? {} : { code: drop.code }), lost: drop.lost });
}

// The last day (GET /calls, safari status): how many calls, those that
// failed by code, and the link's drops by why.
export function lastDay(): { since: string; calls: number; failures: Record<string, number>; drops: Record<string, number> } {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const failures: Record<string, number> = {};
  const drops: Record<string, number> = {};
  let calls = 0;
  for (const line of lines()) {
    if (line.t < since) continue;
    if (typeof line.drop === "string") drops[line.drop] = (drops[line.drop] ?? 0) + 1;
    else if (typeof line.outcome === "string") {
      calls++;
      if (line.outcome !== "ok") failures[line.outcome] = (failures[line.outcome] ?? 0) + 1;
    }
  }
  return { since, calls, failures, drops };
}
