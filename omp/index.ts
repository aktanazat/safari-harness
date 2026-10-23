import { daemonHttp } from "../daemon/rpc.ts";

type AgentEnd = { willContinue?: boolean };
type Context = {
  mode: string;
  agent?: { kind: "main" | "sub"; id: string };
  sessionManager?: { getSessionId(): string };
};
type ToolCall = { toolName: string; input: Record<string, unknown> };
type ToolCallResult = { input: Record<string, unknown> };
type ExtensionApi = {
  on(event: "agent_end", handler: (event: AgentEnd, ctx: Context) => void | Promise<void>): void;
  on(event: "tool_call", handler: (event: ToolCall, ctx: Context) => ToolCallResult | undefined): void;
  logger?: { warn(message: string): void };
};

function taskOf(ctx: Context): string | undefined {
  const session = ctx.sessionManager?.getSessionId();
  const agent = ctx.agent?.id;
  return session && agent ? JSON.stringify([session, agent]) : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export default function safariTurnEnd(pi: ExtensionApi) {
  pi.on("tool_call", (event, ctx) => {
    const task = taskOf(ctx);
    if (task === undefined) return;
    if (event.toolName.startsWith("mcp__safari_")) {
      // Nested write xd:// dispatches emit this same canonical tool event.
      return { input: { ...event.input, __safariTask: task } };
    }
    if (event.toolName === "bash" && typeof event.input.command === "string") {
      // The tool exposes no env field; eval preserves persistent shell state.
      return { input: { ...event.input, command: `SAFARI_HARNESS_TASK=${shellQuote(task)} eval ${shellQuote(event.input.command)}` } };
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
