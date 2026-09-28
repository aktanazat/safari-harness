// Agent loop: the "safari do <task>" brain. Model-agnostic over an
// OpenAI-compatible /chat/completions endpoint with tool calling
// (Ollama locally by default; any frontier API works via env). The whole
// conversation is the caller's: it can save it after every step and hand it
// back later to go on (safari session resume), and messages that arrive
// while the loop runs (steer, queue, stop) are taken in between steps.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { TOOLS, formatResult, inputSchema, type Tool } from "./tools.ts";
import { IMESSAGE_READ_TOOLS } from "./imessage.ts";
import { HISTORY_TOOLS } from "./safari-history.ts";
import { FILL_TOOLS } from "./fill.ts";
import { HANDOFF_TOOLS } from "./handoff.ts";
import { siteGuide } from "./guides.ts";
import { invoke } from "./call.ts";

export type AgentEvent =
  | { type: "plan"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; ok: boolean; result?: unknown; error?: string }
  | { type: "answer"; text: string }
  | { type: "user"; text: string; kind: "steer" | "queue" }
  | { type: "error"; text: string };

export type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

// A message for a running loop: steer goes in before its next step, queue
// once it has answered, stop ends it.
export type Control = { kind: "steer" | "queue" | "stop"; text?: string };

export type AgentStatus = "done" | "stopped" | "failed" | "out of steps";

export type AgentConfig = {
  baseUrl: string;      // e.g. http://127.0.0.1:11434/v1
  model: string;        // e.g. gemma4:12b-mlx
  apiKey?: string;
  maxSteps: number;
  onEvent: (ev: AgentEvent) => void;
  // Messages sent to the loop while it runs; each is returned once.
  inbox?: () => Promise<Control[]>;
  // The conversation after each step, to keep.
  save?: (messages: ChatMsg[]) => Promise<void>;
};

const SYSTEM_PROMPT = `You are a browser agent controlling Safari on macOS through tools.

Rules:
- Every page tool needs tab: the tab the task names, or the id open returned. With neither, open the page in the background first.
- Call snapshot first to see the page. Elements are listed as "[ref] role "name" {state}".
- Click and type by ref. Refs go stale after navigation; re-snapshot then.
- After every click or type, call snapshot (or info + extract) to observe the result before acting again.
- Prefer extract for reading article text; eval for structured data (JSON from the DOM).
- Do one thing per step. Never invent refs you have not seen in a snapshot.
- Before working on a site, call site_guide with its domain: it says what signed out looks like and the site's limits.
- For facts about the user (their address, accounts, preferences, past decisions), call memory_search, then memory_read for a whole record; browsing_history finds pages they visited. Put what you learn from these into a page only when the task needs it.
- If a page needs login the user is already logged into, use their existing session; do not ask for credentials.
- If a sign-in asks for a code sent by text, call imessage_wait_code and type the code in; never repeat it in your reply.
- A message from the user may arrive while you work; follow the newest one.
- Close the tabs you opened, then reply with a short final answer and no tool call.
- If you cannot do something (Safari has no equivalent of a Chrome capability), say exactly what blocked you.`;

const MEMORY_ROOT = join(homedir(), "memory");

function memFind(): string {
  return Bun.which("mem-find") ?? join(homedir(), ".local/bin/mem-find");
}

// The user's own notes in engram (~/memory), searched by its mem-find.
async function memorySearch(a: Record<string, unknown>): Promise<unknown> {
  const query = String(a.query ?? "").trim();
  if (!query) throw new Error("memory_search needs query");
  const limit = Math.min(Math.max(Number(a.limit ?? 5), 1), 10);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([memFind(), "--format", "json", "--sources", "memory", "--limit", String(limit), query], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("engram's mem-find is not installed on this Mac, so there is no memory to search");
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`memory search failed: ${err.trim().slice(0, 300)}`);
  const found = JSON.parse(out) as { results?: { title?: string; summary?: string; path?: string }[] };
  return (found.results ?? []).map((r) => ({ title: r.title, summary: r.summary, path: r.path }));
}

async function memoryRead(a: Record<string, unknown>): Promise<unknown> {
  const path = resolve(MEMORY_ROOT, String(a.path ?? ""));
  const inside = relative(MEMORY_ROOT, path);
  if (!inside || inside.startsWith("..")) throw new Error("memory_read reads records under ~/memory, by the path memory_search gave");
  const text = await readFile(path, "utf8");
  return text.length > 8000 ? `${text.slice(0, 8000)}\n[cut at 8000 characters]` : text;
}

const CONTEXT_TOOLS: Record<string, Tool> = {
  memory_search: {
    desc: "Search the user's own notes (engram memory) for facts about them: addresses, accounts, preferences, past decisions. Returns title, summary, and path for each match.",
    params: { query: { type: "string", description: "what to look for, in plain words" }, limit: { type: "number", description: "default 5, max 10" } },
    required: ["query"],
    run: memorySearch,
  },
  memory_read: {
    desc: "Read one memory record in full, by the path memory_search returned.",
    params: { path: { type: "string", description: "path from memory_search" } },
    required: ["path"],
    run: memoryRead,
  },
  site_guide: {
    desc: "The usage guide for a site: what signed out looks like, its limits, and the repl global that reads it. Pass a domain or name, e.g. x.com or gmail; sites lists every guide.",
    params: { site: { type: "string", description: "domain, address, or site name" } },
    required: ["site"],
    run: async (a) => (await siteGuide(String(a.site ?? ""))) ?? `no guide for ${String(a.site)}; site_guide {site: "sites"} lists them`,
  },
};

// The loop runs unattended, so it gets the Messages read tools but not send;
// handoff texts only the user's own phone, when they are away. Its small
// local model takes one step per turn (see the rules), so no run.
const ALL_TOOLS: Record<string, Tool> = {
  ...Object.fromEntries(Object.entries(TOOLS).filter(([name, t]) => name !== "run" && !t.hidden)),
  ...IMESSAGE_READ_TOOLS,
  ...HISTORY_TOOLS,
  ...FILL_TOOLS,
  ...HANDOFF_TOOLS,
  ...CONTEXT_TOOLS,
};

function toolSchemas() {
  return Object.entries(ALL_TOOLS).map(([name, t]) => ({
    type: "function" as const,
    function: { name, description: t.desc, parameters: inputSchema(t) },
  }));
}

export function firstMessages(task: string, tab?: number): ChatMsg[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: tab ? `${task}\n(work in tab ${tab}: pass tab ${tab} to every page tool unless you open another)` : task },
  ];
}

function trimMessages(messages: ChatMsg[], maxBytes = 60_000) {
  // keep system + first user + newest turns; drop middle tool payloads first
  let total = 0;
  for (const m of messages) total += (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? "").length;
  let i = 2;
  while (total > maxBytes && i < messages.length - 4) {
    const m = messages[i];
    if (m.role === "tool" && m.content && m.content.length > 200) {
      total -= m.content.length - 100;
      m.content = m.content.slice(0, 100) + "\n[trimmed]";
    }
    i += 1;
  }
}

async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const local = CONTEXT_TOOLS[name];
  return local ? local.run(args) : invoke(name, args, true);
}

// Runs the conversation on from where messages leave off, until the model
// answers with nothing queued, a stop arrives, or the steps run out.
// messages grows in place.
export async function runAgent(messages: ChatMsg[], cfg: AgentConfig): Promise<{ answer: string; status: AgentStatus }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const queued: string[] = [];
  const steers: string[] = [];
  let stopped = false;
  let answer = "";

  // Takes in what the inbox holds; true when the step in flight should give
  // way (a steer or a stop). Steers join the conversation only between
  // steps, so none lands between a model reply and the tool results it
  // asked for.
  const takeInbox = async (): Promise<boolean> => {
    let urgent = false;
    for (const c of (await cfg.inbox?.()) ?? []) {
      if (c.kind === "stop") stopped = true;
      else if (c.text) {
        (c.kind === "queue" ? queued : steers).push(c.text);
        cfg.onEvent({ type: "user", text: c.text, kind: c.kind });
      }
      urgent ||= c.kind !== "queue";
    }
    return urgent;
  };
  const joinSteers = () => {
    for (const text of steers.splice(0)) messages.push({ role: "user", content: text });
  };

  for (let step = 0; step < cfg.maxSteps; step++) {
    await takeInbox();
    if (stopped) return { answer, status: "stopped" };
    joinSteers();
    trimMessages(messages);
    const body = { model: cfg.model, messages, tools: toolSchemas(), tool_choice: "auto", stream: false };
    // A steer or stop that arrives while the model thinks cuts the reply short.
    const cut = new AbortController();
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        await Bun.sleep(500);
        if (watching && (await takeInbox())) cut.abort();
      }
    })();
    let resp: Response | null = null;
    let failure = "";
    try {
      resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: cut.signal });
      if (!resp.ok) failure = `model error ${resp.status}: ${(await resp.text()).slice(0, 400)}`;
    } catch (e) {
      if (!cut.signal.aborted) failure = `model endpoint unreachable: ${String(e)}`;
    }
    const data = resp && !failure && !cut.signal.aborted ? ((await resp.json().catch(() => null)) as { choices?: { message: ChatMsg }[] } | null) : null;
    watching = false;
    await watcher;
    if (stopped) return { answer, status: "stopped" };
    if (cut.signal.aborted) continue;
    if (failure) {
      cfg.onEvent({ type: "error", text: failure });
      return { answer, status: "failed" };
    }
    const msg = data?.choices?.[0]?.message;
    if (!msg) {
      cfg.onEvent({ type: "error", text: "empty completion" });
      return { answer, status: "failed" };
    }
    messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });

    if (msg.tool_calls?.length) {
      if (msg.content?.trim()) cfg.onEvent({ type: "plan", text: msg.content.trim() });
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; } catch { /* tolerate */ }
        if (!ALL_TOOLS[name]) {
          cfg.onEvent({ type: "tool", name, args, ok: false, error: "unknown tool" });
          messages.push({ role: "tool", tool_call_id: call.id, content: `error: unknown tool ${name}` });
          continue;
        }
        try {
          const value = await runTool(name, args);
          cfg.onEvent({ type: "tool", name, args, ok: true, result: value });
          messages.push({ role: "tool", tool_call_id: call.id, content: formatResult(value).slice(0, 30_000) });
        } catch (e) {
          const em = String(e instanceof Error ? e.message : e);
          cfg.onEvent({ type: "tool", name, args, ok: false, error: em });
          messages.push({ role: "tool", tool_call_id: call.id, content: `error: ${em}` });
        }
      }
      await cfg.save?.(messages);
      continue;
    }

    answer = (msg.content ?? "").trim();
    cfg.onEvent({ type: "answer", text: answer });
    await cfg.save?.(messages);
    await takeInbox();
    if (stopped) return { answer, status: "stopped" };
    if (steers.length) continue;
    const next = queued.shift();
    if (next === undefined) return { answer, status: "done" };
    messages.push({ role: "user", content: next });
  }
  cfg.onEvent({ type: "error", text: `step budget (${cfg.maxSteps}) exhausted` });
  return { answer: answer || "(no final answer)", status: "out of steps" };
}
