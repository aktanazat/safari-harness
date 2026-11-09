import { connectionRefused, daemonBack, daemonHttp, type Missed } from "../daemon/rpc.ts";
import { setSessionTask } from "../daemon/session-task.ts";
import { newRun, unanswered, webResult, type Block, type ToolResult } from "./walls.ts";

type AgentEnd = { willContinue?: boolean };
type Context = {
  mode: string;
  agent?: { kind: "main" | "sub"; id: string; parentId?: string };
  sessionManager?: { getSessionId(): string };
};
type ToolCall = { toolName: string; toolCallId?: string; input: Record<string, unknown> };
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

// A lead's turn end releases its pages this long after its agent_end,
// unless its session starts again first. omp ends a reply the user's
// message interrupts with a final agent_end and starts the next run about
// a second later: from 11-02 to 11-04, 19 tab closes came within the same
// minute as such a steer, and each cost the agent a failed call and a
// fresh load (AuditSafariHarness-2). A helper's end releases at once.
const RELEASE_DELAY_MS = 15_000;
// By lead session, its release waiting out that pause.
const releasing = new Map<string, Timer>();

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
      // omp's eval bridge names its calls js-<tool>-<uuid>: their answers
      // reach the cell's code, so they read whole pages (mcp-tools.ts).
      const script = event.toolCallId?.startsWith("js-") ? { __safariScript: true } : {};
      return { input: { ...event.input, __safariTask: task, ...script } };
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
    const task = taskOf(ctx);
    if (ctx.agent?.kind !== "sub") {
      // The lead's own task, which also reaches the pages no task names:
      // its helpers' pages are theirs to release, and they may still run.
      const session = ctx.sessionManager?.getSessionId() ?? "";
      clearTimeout(releasing.get(session));
      const timer = setTimeout(() => {
        releasing.delete(session);
        void release(pi, task);
      }, RELEASE_DELAY_MS);
      timer.unref();
      releasing.set(session, timer);
      return;
    }
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
    if (ctx.agent?.kind === "sub") return;
    clearTimeout(releasing.get(session ?? ""));
    releasing.delete(session ?? "");
    if (session !== undefined) newRun(session);
  });
}

// How long one release waits on the daemon. It first drains the task's
// calls in flight, and a lead interrupted mid-call may have one waiting on
// a page or the user for minutes; its pages then close when unused for 20
// minutes or as this process exits.
const RELEASE_MS = 30_000;

// A release the daemon missed as it restarted (a deploy) goes again once
// it answers: before 11-06 it was dropped, and the turn's pages stayed
// until the 20-minute idle close (AuditSafariHarness-10).
async function release(pi: ExtensionApi, task?: string): Promise<void> {
  const admission = { owner: process.pid, ...(task === undefined ? {} : { task }) };
  const base = daemonHttp();
  try {
    let missed = await releaseOnce(base, admission);
    if (missed !== undefined && await daemonBack(base, missed)) missed = await releaseOnce(base, admission);
    if (missed === "restarting") throw new Error("the daemon was restarting, and did not answer again in time");
  } catch (e: unknown) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    pi.logger?.warn(`safari-harness turn end: ${timedOut ? `no answer within ${RELEASE_MS / 1000} s; its pages close when unused for 20 minutes or when this process exits` : e instanceof Error ? e.message : String(e)}`);
  }
}

async function releaseOnce(base: string, admission: { owner: number; task?: string }): Promise<Missed | undefined> {
  const signal = AbortSignal.timeout(RELEASE_MS);
  const post = async (path: string, body: unknown): Promise<Response | Missed> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), signal });
    } catch (e: unknown) {
      if (connectionRefused(e)) return "refused";
      throw e;
    }
    if (res.ok) return res;
    const text = await res.text();
    if (res.status === 503 && /"restarting":true/.test(text)) return "restarting";
    throw new Error(`${path}: ${res.status} ${text}`);
  };
  const prepare = await post("/turn-end/prepare", admission);
  if (typeof prepare === "string") return prepare;
  const prepared: unknown = await prepare.json();
  const res = await post("/turn-end", { ...admission, prepared });
  if (typeof res === "string") return res;
  const result: unknown = await res.json();
  if (result && typeof result === "object" && "failed" in result && typeof result.failed === "number" && result.failed > 0) {
    throw new Error(`could not close ${result.failed} tab(s); they close when this process exits`);
  }
  return undefined;
}
