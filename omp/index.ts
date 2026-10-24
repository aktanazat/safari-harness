import { daemonHttp } from "../daemon/rpc.ts";
import { newRun, unanswered, webResult, type Block, type ToolResult } from "./walls.ts";

type AgentEnd = { willContinue?: boolean };
type Context = {
  mode: string;
  agent?: { kind: "main" | "sub"; id: string; parentId?: string };
  sessionManager?: { getSessionId(): string };
};
type ToolCall = { toolName: string; input: Record<string, unknown> };
type ToolCallResult = { input: Record<string, unknown> } | { block: true; reason: string };
type ExtensionApi = {
  on(event: "agent_end", handler: (event: AgentEnd, ctx: Context) => void | Promise<void>): void;
  on(event: "tool_call", handler: (event: ToolCall, ctx: Context) => ToolCallResult | undefined): void;
  on(event: "tool_result", handler: (event: ToolResult, ctx: Context) => Promise<{ content: Block[] } | undefined>): void;
  on(event: "session_stop", handler: (event: unknown, ctx: Context) => { continue: true; additionalContext: string } | undefined): void;
  on(event: "before_agent_start", handler: (event: unknown, ctx: Context) => void): void;
  logger?: { warn(message: string): void };
};

// omp runs each helper in a session of its own. A helper's task also names
// its lead's session, fixed at the helper's first call, so the daemon keeps
// a session's reads for its helpers too (daemon/reads.ts). By agent id, the
// lead's session of that agent's latest call; by helper session, its lead's.
const leadOfAgent = new Map<string, string>();
const leadOfHelper = new Map<string, string>();

function taskOf(ctx: Context): string | undefined {
  const session = ctx.sessionManager?.getSessionId();
  const agent = ctx.agent;
  if (!session || !agent?.id) return undefined;
  const parent = agent.parentId === undefined ? undefined : leadOfAgent.get(agent.parentId);
  const lead = agent.kind === "main" ? session : leadOfHelper.get(session) ?? parent ?? session;
  if (agent.kind === "sub") leadOfHelper.set(session, lead);
  leadOfAgent.set(agent.id, lead);
  return JSON.stringify(lead === session ? [session, agent.id] : [session, agent.id, lead]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// One shell word at the start of text as the shell reads it, and the text
// after it; undefined when the word would expand or there is none.
function word(text: string): { value: string; rest: string } | undefined {
  let value = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      value += text.slice(i + 1, end);
      i = end + 1;
    } else if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) return undefined;
      if (next !== "\n") value += next;
      i += 2;
    } else if (c === '"') {
      i++;
      for (;;) {
        const d = text[i];
        if (d === undefined || d === "$" || d === "`") return undefined;
        if (d === '"') break;
        const next = text[i + 1];
        if (d === "\\" && next !== undefined && '"\\$`\n'.includes(next)) {
          if (next !== "\n") value += next;
          i += 2;
        } else {
          value += d;
          i++;
        }
      }
      i++;
    } else if (/[\w@%+=:,./-]/.test(c)) {
      value += c;
      i++;
    } else break;
  }
  return i === 0 ? undefined : { value, rest: text.slice(i) };
}

// eval's arguments when they are plain words to the end, joined as eval
// joins them.
function evalText(text: string): string | undefined {
  const values: string[] = [];
  let rest = text.replace(/^[ \t]+/, "");
  while (rest.trim()) {
    const w = word(rest);
    if (w === undefined || (w.rest.trim() && !/^[ \t]/.test(w.rest))) return undefined;
    values.push(w.value);
    rest = w.rest.replace(/^[ \t]+/, "");
  }
  return values.length ? values.join(" ") : undefined;
}

const ASSIGNED = "SAFARI_HARNESS_TASK=";

// Transcripts keep the wrapped command, and agents copy it: wrappers
// nested 2-5 deep, and a copied inner assignment overrode the hook's
// (AH1, HD-4). Every leading copied assignment goes, and an eval of one
// quoted command it carried gives back that command, unwrapped in turn
// when more commands follow it.
function unwrapped(command: string): string {
  for (;;) {
    const lead = command.trimStart();
    if (!lead.startsWith(ASSIGNED)) return command;
    const after = lead.slice(ASSIGNED.length);
    const rest = /^[ \t]/.test(after) ? after : word(after)?.rest;
    if (rest === undefined || !/^[ \t]/.test(rest)) return command;
    const body = rest.replace(/^[ \t]+/, "");
    if (!/^[^\s;&|<>()#]/.test(body)) return command;
    if (!/^eval[ \t]/.test(body)) {
      command = body;
      continue;
    }
    const whole = evalText(body.slice(4));
    if (whole !== undefined) {
      command = whole;
      continue;
    }
    const first = word(body.slice(4).replace(/^[ \t]+/, ""));
    return first === undefined ? body : `eval ${shellQuote(unwrapped(first.value))}${first.rest}`;
  }
}

export default function safariTurnEnd(pi: ExtensionApi) {
  pi.on("tool_call", (event, ctx) => {
    // A helper ends its run by calling yield; one whose run met a page
    // that did not load, with no Safari attempt at it, is sent back once.
    if (event.toolName === "yield" && ctx.agent?.kind === "sub") {
      const session = ctx.sessionManager?.getSessionId();
      const reason = session === undefined ? undefined : unanswered(session);
      return reason === undefined ? undefined : { block: true, reason };
    }
    const task = taskOf(ctx);
    if (task === undefined) return;
    if (event.toolName.startsWith("mcp__safari_")) {
      // Nested write xd:// dispatches emit this same canonical tool event.
      return { input: { ...event.input, __safariTask: task } };
    }
    // Every shell command carries the task, not only those naming safari:
    // scripts and REPL code they start reach the daemon through rpc.ts,
    // which reads it from the environment.
    if (event.toolName === "bash" && typeof event.input.command === "string") {
      // The tool exposes no env field; eval preserves persistent shell state.
      return { input: { ...event.input, command: `SAFARI_HARNESS_TASK=${shellQuote(task)} eval ${shellQuote(unwrapped(event.input.command))}` } };
    }
  });
  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue || (ctx.mode === "print" && ctx.agent?.kind !== "sub")) return;
    if (ctx.agent?.kind !== "sub") return release(pi);
    const task = taskOf(ctx);
    if (task === undefined) {
      pi.logger?.warn("safari-harness turn end: helper task identity is unavailable; leaving its pages protected");
      return;
    }
    return release(pi, task);
  });
  pi.on("tool_result", (event, ctx) => webResult(event, ctx.sessionManager?.getSessionId(), () => taskOf(ctx)));
  // A lead's run that would end the same way continues once.
  pi.on("session_stop", (_event, ctx) => {
    const session = ctx.sessionManager?.getSessionId();
    const reason = session === undefined ? undefined : unanswered(session);
    return reason === undefined ? undefined : { continue: true, additionalContext: reason };
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const session = ctx.sessionManager?.getSessionId();
    if (session !== undefined && ctx.agent?.kind !== "sub") newRun(session);
  });
}

async function release(pi: ExtensionApi, task?: string): Promise<void> {
  const admission = { owner: process.pid, ...(task === undefined ? {} : { task }) };
  try {
    const prepare = await fetch(`${daemonHttp()}/turn-end/prepare`, { method: "POST", body: JSON.stringify(admission) });
    if (!prepare.ok) throw new Error(`prepare: ${prepare.status} ${await prepare.text()}`);
    const prepared: unknown = await prepare.json();
    const res = await fetch(`${daemonHttp()}/turn-end`, { method: "POST", body: JSON.stringify({ ...admission, prepared }) });
    if (!res.ok) throw new Error(`release: ${res.status} ${await res.text()}`);
    const result: unknown = await res.json();
    if (result && typeof result === "object" && "failed" in result && typeof result.failed === "number" && result.failed > 0) {
      throw new Error(`could not close ${result.failed} tab(s); they close when this process exits`);
    }
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && e.code === "ConnectionRefused") return;
    pi.logger?.warn(`safari-harness turn end: ${e instanceof Error ? e.message : String(e)}`);
  }
}
