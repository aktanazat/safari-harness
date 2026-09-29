// omp's side of closing tabs when a turn ends: scripts/dev-install.sh links
// this directory into ~/.omp/agent/extensions, and omp loads it as its
// sessions start. A turn ends when omp hands it back to the user, and the
// daemon then closes every tab this omp process opened but those it kept
// for him (endTurn, daemon/tools.ts). Its MCP server and the safari
// commands its shells run are its children, so their tabs are its
// (owner.ts). The user's order of 09-28: close a tab once it has served its
// purpose; keep only one waiting on his answer.

import { daemonHttp } from "../daemon/rpc.ts";

type ExtensionApi = {
  on(event: "session_stop", handler: () => undefined): void;
  logger?: { warn(message: string): void };
};

export default function safariTurnEnd(pi: ExtensionApi) {
  pi.on("session_stop", () => {
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
