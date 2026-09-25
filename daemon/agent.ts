// Agent loop: the "safari do <task>" brain. Model-agnostic over an
// OpenAI-compatible /chat/completions endpoint with tool calling
// (Ollama locally by default; any frontier API works via env).

import { TOOLS, formatResult, inputSchema } from "./tools.ts";
import { IMESSAGE_READ_TOOLS } from "./imessage.ts";

export type AgentEvent =
  | { type: "plan"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; ok: boolean; result?: unknown; error?: string }
  | { type: "answer"; text: string }
  | { type: "error"; text: string };

export type AgentConfig = {
  baseUrl: string;      // e.g. http://127.0.0.1:11434/v1
  model: string;        // e.g. gemma4:12b-mlx
  apiKey?: string;
  maxSteps: number;
  // When set, tools execute in the daemon over HTTP (the CLI process has no
  // extension socket). Unset means in-process (embedded use).
  rpcUrl?: string;
  onEvent: (ev: AgentEvent) => void;
};

const SYSTEM_PROMPT = `You are a browser agent controlling Safari on macOS through tools.

Rules:
- Call snapshot first to see the page. Elements are listed as "[ref] role "name" {state}".
- Click and type by ref. Refs go stale after navigation; re-snapshot then.
- After every click or type, call snapshot (or info + extract) to observe the result before acting again.
- Prefer extract for reading article text; eval for structured data (JSON from the DOM).
- Do one thing per step. Never invent refs you have not seen in a snapshot.
- If a page needs login the user is already logged into, use their existing session; do not ask for credentials.
- If a sign-in asks for a code sent by text, call imessage_wait_code and type the code in; never repeat it in your reply.
- When the task is done, reply with a short final answer and no tool call.
- If you cannot do something (Safari has no equivalent of a Chrome capability), say exactly what blocked you.`;

// The loop runs unattended, so it gets the Messages read tools but not send.
const ALL_TOOLS = { ...TOOLS, ...IMESSAGE_READ_TOOLS };

function toolSchemas() {
  return Object.entries(ALL_TOOLS).map(([name, t]) => ({
    type: "function" as const,
    function: { name, description: t.desc, parameters: inputSchema(t) },
  }));
}

type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

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
async function runToolOverRpc(rpcUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${rpcUrl.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: name, args }),
  });
  const data = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!data.ok) throw new Error(data.error ?? "rpc failed");
  return data.value;
}

export async function runAgent(task: string, cfg: AgentConfig, opts: { tab?: number } = {}): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const messages: ChatMsg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: opts.tab ? `${task}\n(start in tab ${opts.tab}; omit tab unless switching)` : task },
  ];

  let finalText = "";
  for (let step = 0; step < cfg.maxSteps; step++) {
    trimMessages(messages);
    const body = {
      model: cfg.model,
      messages,
      tools: toolSchemas(),
      tool_choice: "auto",
      stream: false,
    };
    let resp: Response;
    try {
      resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      cfg.onEvent({ type: "error", text: `model endpoint unreachable: ${String(e)}` });
      return finalText;
    }
    if (!resp.ok) {
      cfg.onEvent({ type: "error", text: `model error ${resp.status}: ${(await resp.text()).slice(0, 400)}` });
      return finalText;
    }
    const data = (await resp.json()) as {
      choices: { message: ChatMsg; finish_reason?: string }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) {
      cfg.onEvent({ type: "error", text: "empty completion" });
      return finalText;
    }
    messages.push(msg);

    if (msg.tool_calls?.length) {
      if (msg.content?.trim()) cfg.onEvent({ type: "plan", text: msg.content.trim() });
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; } catch { /* tolerate */ }
        const tool = ALL_TOOLS[name];
        if (!tool) {
          cfg.onEvent({ type: "tool", name, args, ok: false, error: "unknown tool" });
          messages.push({ role: "tool", tool_call_id: call.id, content: `error: unknown tool ${name}` });
          continue;
        }
        try {
          const value = cfg.rpcUrl && !IMESSAGE_READ_TOOLS[name] ? await runToolOverRpc(cfg.rpcUrl, name, args) : await tool.run(args);
          const text = formatResult(value);
          cfg.onEvent({ type: "tool", name, args, ok: true, result: value });
          messages.push({ role: "tool", tool_call_id: call.id, content: text.slice(0, 30_000) });
        } catch (e) {
          const em = String(e instanceof Error ? e.message : e);
          cfg.onEvent({ type: "tool", name, args, ok: false, error: em });
          messages.push({ role: "tool", tool_call_id: call.id, content: `error: ${em}` });
        }
      }
      continue;
    }

    finalText = (msg.content ?? "").trim();
    cfg.onEvent({ type: "answer", text: finalText });
    return finalText;
  }
  cfg.onEvent({ type: "error", text: `step budget (${cfg.maxSteps}) exhausted` });
  return finalText || "(no final answer)";
}
