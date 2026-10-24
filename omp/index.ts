import { daemonHttp } from "../daemon/rpc.ts";
import { setSessionTask } from "../daemon/session-task.ts";
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
    // Every shell command's calls carry the task, not only safari's:
    // scripts and REPL code it starts reach the daemon through rpc.ts too.
    const session = ctx.sessionManager?.getSessionId();
    if (event.toolName === "bash" && session) {
      try {
        setSessionTask(session, task);
      } catch (e: unknown) {
        // omp blocks a command whose tool_call handler throws
        pi.logger?.warn(`safari-harness: shell commands go without their task: ${e instanceof Error ? e.message : String(e)}`);
      }
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
