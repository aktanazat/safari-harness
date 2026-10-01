// omp's side of closing tabs when a turn ends: scripts/dev-install.sh links
// this directory into ~/.omp/agent/extensions, and omp loads it as its
// sessions start. A turn ends when omp hands it back to the user, and the
// daemon then closes every tab this omp process opened but those it kept
// for him, and then the agent's window (endTurn, daemon/tools.ts). Its MCP
// server and the safari commands its shells run are its children, so their
// tabs are its (owner.ts). The user's order of 09-28: close a tab once it
// has served its purpose; keep only one waiting on his answer.
//
// The turn's end is agent_end, not session_stop: omp skips session_stop
// when the user interrupts a turn (Escape), when it fails, and when it
// stops mid-tool call, and on 09-30 the tabs and windows of agents he had
// stopped stayed open until they exited.

import { daemonHttp } from "../daemon/rpc.ts";

type AgentEnd = { willContinue?: boolean };
type Context = { mode: string; getAsyncJobSnapshot(): { running: unknown[] } | null };
type ExtensionApi = {
  on(event: "agent_end", handler: (event: AgentEnd, ctx: Context) => undefined): void;
  logger?: { warn(message: string): void };
};

export default function safariTurnEnd(pi: ExtensionApi) {
  pi.on("agent_end", (event, ctx) => {
    // omp goes on by itself: a retry, a hook's follow-up, a background
    // result arriving.
    if (event.willContinue) return undefined;
    // A subagent runs headless in this same process ("print"); its end is
    // not its parent's. A one-shot omp -p exits as it ends, and the daemon
    // closes its tabs then.
    if (ctx.mode === "print") return undefined;
    // An interrupted turn can leave a background job (a subagent, a shell)
    // working in its tabs; its result wakes the session, whose end then
    // closes them.
    if ((ctx.getAsyncJobSnapshot()?.running.length ?? 0) > 0) return undefined;
    // Nothing here holds the turn. A daemon that is not running has no tabs
    // to close, so a refused connection is no failure.
    fetch(`${daemonHttp()}/turn-end`, { method: "POST", body: JSON.stringify({ owner: process.pid }) })
      .then(async (res) => {
        if (!res.ok) pi.logger?.warn(`safari-harness turn end: ${res.status} ${await res.text()}`);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && "code" in e && e.code === "ConnectionRefused") return;
        pi.logger?.warn(`safari-harness turn end: ${e instanceof Error ? e.message : String(e)}`);
      });
    return undefined;
  });
}
