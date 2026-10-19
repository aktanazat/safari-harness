// The main session's final agent_end releases this process's disposable
// pages. Subagents share the process id, so only the main session's end
// counts. The daemon drains active calls, keeps protected pages, and
// refuses a release that a newer call invalidated.

import { daemonHttp } from "../daemon/rpc.ts";

type AgentEnd = { willContinue?: boolean };
type Context = { mode: string; agent?: { kind: "main" | "sub" } };
type ExtensionApi = {
  on(event: "agent_end", handler: (event: AgentEnd, ctx: Context) => void): void;
  logger?: { warn(message: string): void };
};

export default function safariTurnEnd(pi: ExtensionApi) {
  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue || ctx.mode === "print" || ctx.agent?.kind === "sub") return;
    queueMicrotask(() => { void release(pi); });
  });
}

async function release(pi: ExtensionApi): Promise<void> {
  try {
    const prepare = await fetch(`${daemonHttp()}/turn-end/prepare`, { method: "POST", body: JSON.stringify({ owner: process.pid }) });
    if (!prepare.ok) throw new Error(`prepare: ${prepare.status} ${await prepare.text()}`);
    const prepared: unknown = await prepare.json();
    const res = await fetch(`${daemonHttp()}/turn-end`, { method: "POST", body: JSON.stringify({ owner: process.pid, prepared }) });
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
