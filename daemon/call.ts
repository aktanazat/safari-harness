// One way for code outside the daemon to run any tool by name: the tools
// that need this process's permissions (Messages, history, real input) run
// here, the rest in the daemon over its RPC port. On another Mac (safari
// host), those tools run on that Mac over ssh.

import { CALLER_TOOLS } from "./caller.ts";
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
  if (!local) return rpc(tool, args);
  const remote = process.env.SAFARI_HARNESS_REMOTE;
  return remote ? remoteCall(remote, tool, args) : local.run(args);
};
