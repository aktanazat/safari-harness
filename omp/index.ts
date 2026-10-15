// The owning OMP runtime, not an ended answer or idle time, authorizes
// release. It drains without closing, rechecks canonical task/job/input/UI
// state, then holds new input dispatch across the awaited external release.
// Safari independently rechecks exact ownership, call generation, active
// calls, forms, front pages and handoffs. Older runtimes preserve resources.

import { daemonHttp } from "../daemon/rpc.ts";

type AgentEnd = { willContinue?: boolean };
type TaskIdentity = {
  runtimeId: string; sessionId: string; agentId: string | null; sessionFile: string | null;
  branchLeafId: string | null; promptGeneration: number; promptSequence: number; submissionGeneration: number;
};
type TaskState = { identity: TaskIdentity; outcome: "completed" | "incomplete" | "cancelled" | "failed" | "unknown"; blockers: string[] };
type Prepared = { owner: number; epoch: string; tabs: number[] };
type Context = {
  mode: string;
  getTaskCompletion?(): TaskState;
  waitForIdle?(): Promise<void>;
  releaseTaskUI?<T>(
    request: { expected: TaskIdentity; reason: "completed" | "cancelled" | "failed"; resource: "temporary" },
    lifecycle: { prepare(signal: AbortSignal): Promise<T>; release(prepared: T): Promise<void> },
  ): Promise<{ released: boolean; state: TaskState }>;
};
type ExtensionApi = {
  on(event: "agent_end", handler: (event: AgentEnd, ctx: Context) => void): void;
  logger?: { warn(message: string): void };
};

export default function safariTurnEnd(pi: ExtensionApi) {
  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue || ctx.mode === "print" || !ctx.getTaskCompletion || !ctx.releaseTaskUI || !ctx.waitForIdle) return;
    const expected = ctx.getTaskCompletion().identity;
    const authority = { getTaskCompletion: ctx.getTaskCompletion, releaseTaskUI: ctx.releaseTaskUI, waitForIdle: ctx.waitForIdle };
    // This hook itself is tracked work. It must return before the owning
    // runtime can settle. Idle only drains; the fresh gate decides eligibility.
    queueMicrotask(() => { void releaseAfterIdle(authority, expected, pi); });
  });
}

async function releaseAfterIdle(ctx: Required<Pick<Context, "getTaskCompletion" | "releaseTaskUI" | "waitForIdle">>, expected: TaskIdentity, pi: ExtensionApi): Promise<void> {
  try {
    await ctx.waitForIdle();
    const state = ctx.getTaskCompletion();
    const reason = state.outcome;
    if (state.blockers.length || (reason !== "completed" && reason !== "cancelled" && reason !== "failed")) return;
    await ctx.releaseTaskUI({ expected, reason, resource: "temporary" }, {
      async prepare(signal) {
        const res = await fetch(`${daemonHttp()}/turn-end/prepare`, { method: "POST", body: JSON.stringify({ owner: process.pid }), signal });
        if (!res.ok) throw new Error(`prepare: ${res.status} ${await res.text()}`);
        const value: unknown = await res.json();
        if (!value || typeof value !== "object" || !("owner" in value) || typeof value.owner !== "number" || value.owner !== process.pid || !("epoch" in value) || typeof value.epoch !== "string" || !("tabs" in value) || !Array.isArray(value.tabs) || !value.tabs.every((tab: unknown) => typeof tab === "number" && Number.isInteger(tab) && tab > 0)) throw new Error("invalid owned-resource preparation");
        const prepared: Prepared = { owner: value.owner, epoch: value.epoch, tabs: value.tabs };
        return prepared;
      },
      async release(prepared) {
        const res = await fetch(`${daemonHttp()}/turn-end`, { method: "POST", body: JSON.stringify({ owner: process.pid, prepared }) });
        if (!res.ok) throw new Error(`release: ${res.status} ${await res.text()}`);
        const result: unknown = await res.json();
        if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("failed" in result) || typeof result.failed !== "number") throw new Error("invalid owned-resource cleanup receipt");
        if ("invalidated" in result && result.invalidated) throw new Error("new browser work invalidated cleanup; its resources remain open");
        if (result.failed) throw new Error(`could not close ${result.failed} tab(s); they remain tracked for another admitted attempt`);
        if ("deferred" in result && result.deferred) throw new Error("cleanup was deferred; resources remain open until another admitted attempt");
      },
    });
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && e.code === "ConnectionRefused") return;
    if (e instanceof Error && e.name === "AbortError") return;
    pi.logger?.warn(`safari-harness turn end: ${e instanceof Error ? e.message : String(e)}`);
  }
}
