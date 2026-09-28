// One way for code outside the daemon to run any tool by name: the tools
// that need this process's permissions (Messages, history, real input) run
// here, the rest in the daemon over its RPC port. On another Mac (safari
// host), those tools run on that Mac over ssh.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { CALLER_TOOLS } from "./caller.ts";
import { keeperRunning } from "./groups.ts";
import { rpc } from "./rpc.ts";
import { remoteCall } from "./host.ts";
import { runSteps } from "./tools.ts";

export type Invoke = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export const invoke: Invoke = async (tool, args) => {
  // The daemon cannot run a caller tool, so a run with one among its steps
  // goes step by step from here, each step where it runs.
  const steps = args.steps;
  if (tool === "run" && Array.isArray(steps) && steps.some((s: unknown) => !!s && typeof s === "object" && "tool" in s && typeof s.tool === "string" && Object.hasOwn(CALLER_TOOLS, s.tool))) {
    return runSteps(steps, invoke);
  }
  const local = CALLER_TOOLS[tool];
  if (!local) {
    const result = await rpc(tool, args);
    claimSpaces(tool, result);
    return result;
  }
  const remote = process.env.SAFARI_HARNESS_REMOTE;
  return remote ? remoteCall(remote, tool, args) : local.run(args);
};

// The windows an open, or a run's open steps, went in (spaces.ts).
function spacesIn(tool: string, result: unknown): unknown[] {
  if (!result || typeof result !== "object") return [];
  if (tool === "open") return "space" in result ? [result.space] : [];
  if (tool !== "run" || !("steps" in result) || !Array.isArray(result.steps)) return [];
  return result.steps.flatMap((s: unknown) => spacesIn("open", s && typeof s === "object" && "value" in s ? s.value : undefined));
}

// Tab groups are made and deleted from here, where the terminal's
// Accessibility permission is (the daemon has none): after an open whose
// window is to be its task's group, or is one, a keeper (keeper.ts) watches
// it, unless one already does. Another Mac's Safari needs a keeper on that
// Mac, so none starts here then.
function claimSpaces(tool: string, result: unknown) {
  if (process.env.SAFARI_HARNESS_REMOTE) return;
  if (!spacesIn(tool, result).some((s) => !!s && typeof s === "object" && "group" in s && s.group !== "plain")) return;
  if (keeperRunning()) return;
  spawn(process.execPath, [join(import.meta.dir, "keeper.ts")], { detached: true, stdio: "ignore" }).unref();
}
