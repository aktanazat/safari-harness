// safari do sessions: every run keeps its whole conversation on disk, so it
// can be read later, resumed with a new prompt, or talked to while it runs
// from another terminal (steer, queue, stop). A running loop takes those
// messages from its inbox folder between steps; each message is a file of
// its own, written whole and then renamed in, so none is lost or half read.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { firstMessages, runAgent, type AgentEvent, type AgentStatus, type ChatMsg, type Control } from "./agent.ts";

export const SESSIONS_DIR = join(homedir(), ".local/share/safari-harness/sessions");

export type SessionRecord = {
  id: string;
  task: string;
  created: string;
  updated: string;
  status: AgentStatus | "running";
  pid?: number;
  host: string;
  model: string;
  baseUrl: string;
  answer?: string;
  messages: ChatMsg[];
};

const recordPath = (id: string) => join(SESSIONS_DIR, `${id}.json`);
const inboxOf = (id: string) => join(SESSIONS_DIR, `${id}.inbox`);

function checkId(id: string): string {
  if (!/^[a-z0-9]{8}$/.test(id)) throw new Error(`no session ${JSON.stringify(id)}; see: safari session list`);
  return id;
}

export async function loadSession(id: string): Promise<SessionRecord> {
  try {
    return JSON.parse(await readFile(recordPath(checkId(id)), "utf8")) as SessionRecord;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("no session")) throw e;
    throw new Error(`no session ${id}; see: safari session list`);
  }
}

async function save(rec: SessionRecord): Promise<void> {
  rec.updated = new Date().toISOString();
  await mkdir(SESSIONS_DIR, { recursive: true });
  const tmp = `${recordPath(rec.id)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rec));
  await rename(tmp, recordPath(rec.id));
}

// Running means a process still holds it: a run cut off by a crash or a
// closed terminal reads as interrupted.
export function isRunning(rec: SessionRecord): boolean {
  if (rec.status !== "running" || !rec.pid) return false;
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function statusOf(rec: SessionRecord): string {
  return rec.status === "running" && !isRunning(rec) ? "interrupted" : rec.status;
}

export async function listSessionRecords(): Promise<SessionRecord[]> {
  let names: string[] = [];
  try { names = await readdir(SESSIONS_DIR); } catch { return []; }
  const recs = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => loadSession(n.slice(0, -5)).catch(() => null)));
  return recs.filter((r): r is SessionRecord => r !== null).sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function newSession(task: string, opts: { tab?: number; host: string; model: string; baseUrl: string }): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const rec: SessionRecord = { id: crypto.randomUUID().replaceAll("-", "").slice(0, 8), task, created: now, updated: now, status: "running", host: opts.host, model: opts.model, baseUrl: opts.baseUrl, messages: firstMessages(task, opts.tab) };
  await save(rec);
  return rec;
}

// A message for a running session. Refused when nothing runs it, since
// nothing would ever read it.
export async function sendControl(id: string, c: Control): Promise<void> {
  const rec = await loadSession(id);
  if (!isRunning(rec)) throw new Error(`session ${id} is not running (${statusOf(rec)}); go on with: safari session resume ${id} "<prompt>"`);
  const dir = inboxOf(id);
  await mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await writeFile(join(dir, `.${name}`), JSON.stringify(c));
  await rename(join(dir, `.${name}`), join(dir, `${name}.json`));
}

async function takeControl(id: string): Promise<Control[]> {
  const dir = inboxOf(id);
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const out: Control[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      out.push(JSON.parse(await readFile(path, "utf8")) as Control);
    } finally {
      await rm(path, { force: true });
    }
  }
  return out;
}

export async function deleteSession(id: string): Promise<void> {
  const rec = await loadSession(id);
  if (isRunning(rec)) throw new Error(`session ${id} is running; stop it first: safari session stop ${id}`);
  await rm(recordPath(id), { force: true });
  await rm(inboxOf(id), { recursive: true, force: true });
}

// Runs the session's conversation on in this process, saving it after
// every step. Ctrl-C leaves it stopped, ready to resume.
export async function runSession(rec: SessionRecord, opts: { apiKey?: string; maxSteps: number; onEvent: (ev: AgentEvent) => void }): Promise<SessionRecord> {
  rec.status = "running";
  rec.pid = process.pid;
  await save(rec);
  const onSignal = () => {
    rec.status = "stopped";
    delete rec.pid;
    save(rec).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await runAgent(rec.messages, {
      baseUrl: rec.baseUrl,
      model: rec.model,
      apiKey: opts.apiKey,
      maxSteps: opts.maxSteps,
      onEvent: opts.onEvent,
      inbox: () => takeControl(rec.id),
      save: () => save(rec),
    });
    rec.status = result.status;
    rec.answer = result.answer;
  } catch (e) {
    rec.status = "failed";
    rec.answer = `error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    delete rec.pid;
    await save(rec);
    await rm(inboxOf(rec.id), { recursive: true, force: true });
  }
  return rec;
}

// The conversation as a person reads it: prompts, the steps taken, and the
// answers; tool results are cut to a line.
export function transcript(rec: SessionRecord): string {
  const lines = [`session ${rec.id} · ${statusOf(rec)} · ${rec.model} · on ${rec.host} · started ${rec.created}`];
  for (const m of rec.messages) {
    if (m.role === "user") lines.push("", `you: ${m.content ?? ""}`);
    else if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content?.trim()) lines.push(`  ${m.content.trim()}`);
      for (const c of m.tool_calls) lines.push(`  ● ${c.function.name} ${c.function.arguments.slice(0, 120)}`);
    } else if (m.role === "assistant") lines.push(`agent: ${m.content ?? ""}`);
    else if (m.role === "tool") lines.push(`    → ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 140)}`);
  }
  return lines.join("\n");
}
