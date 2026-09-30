// One way for code outside the daemon to run any tool by name: the tools
// that need this process's permissions (Messages, history, real input) run
// here, the rest in the daemon over its RPC port. On another Mac (safari
// host), those tools run on that Mac over ssh.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { CALLER_TOOLS } from "./caller.ts";
import { keeperRunning } from "./groups.ts";
import { beside, checkCall, nameIn } from "./guard.ts";
import { rpc } from "./rpc.ts";
import { remoteCall } from "./host.ts";
import { secretType, typeSecret } from "./secret.ts";
import { TOOLS, runSteps } from "./tools.ts";

export type Invoke = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

const CALLER_NAMES = Object.keys(CALLER_TOOLS);
const DAEMON_NAMES = Object.keys(TOOLS);

// A call that runs in this process: a caller tool, a type that fills in a
// code (secret.ts), or a run with one among its steps, however a model
// wrote their names (browsing-history).
export function runsHere(tool: string, args: Record<string, unknown>): boolean {
  return callerSteps(tool, args) || nameIn(CALLER_NAMES, tool) !== undefined || secretType(tool, args);
}

function callerSteps(tool: string, args: Record<string, unknown>): boolean {
  const steps = args.steps;
  return tool === "run" && Array.isArray(steps) && steps.some((s: unknown) => !!s && typeof s === "object" && "tool" in s && typeof s.tool === "string" && runsHere(s.tool, "args" in s && s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {}));
}

// model: the call is one a model wrote. The daemon checks the calls it
// runs (guard.ts), and this process the ones that run here.
export async function invoke(tool: string, args: Record<string, unknown>, model = false): Promise<unknown> {
  // The daemon cannot run a caller tool, so a run with one among its steps
  // goes step by step from here, each step where it runs.
  if (callerSteps(tool, args)) return runSteps(args.steps, (t, a) => invoke(t, a, model));
  const coded = secretType(tool, args);
  if (nameIn(CALLER_NAMES, tool) === undefined) {
    if (coded) {
      const a = checkCall(TOOLS, tool, args, model).args;
      return typeSecret(a, model, (text) => rpc("type", { ...a, secret: true, text }, model));
    }
    const result = await rpc(tool, args, model);
    claimSpaces(nameIn(DAEMON_NAMES, tool) ?? tool, result);
    return result;
  }
  // real_input takes a code's source as type does, and its own parameters
  // go to it (secret.ts).
  const { secret, from, ...rest } = args;
  const call = checkCall(CALLER_TOOLS, tool, coded ? rest : args, model);
  const remote = process.env.SAFARI_HARNESS_REMOTE;
  const run = (a: Record<string, unknown>) => (remote ? remoteCall(remote, call.tool, a) : CALLER_TOOLS[call.tool].run(a));
  const result = await (coded ? typeSecret({ ...call.args, secret, from }, model, (text) => run({ ...call.args, text })) : run(call.args));
  return call.notes.length ? beside(result, "note", call.notes.join("; ")) : result;
}

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
