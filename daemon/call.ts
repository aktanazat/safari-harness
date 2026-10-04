// One way for code outside the daemon to run any tool by name: the tools
// that need this process's permissions (Messages, history, real input) run
// here, the rest in the daemon over its RPC port. On another Mac (safari
// host), those tools run on that Mac over ssh.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { CALLER_TOOLS } from "./caller.ts";
import { keeperRunning } from "./groups.ts";
import { beside, checkCall, checkStep, nameIn } from "./guard.ts";
import { quietly, rpc, takesNews } from "./rpc.ts";
import { remoteCall } from "./host.ts";
import { secretType, typeSecret } from "./secret.ts";
import { TOOLS, runSteps } from "./tools.ts";

// model: the call counts as the model's own, as invoke's does.
export type Invoke = (tool: string, args: Record<string, unknown>, model?: boolean) => Promise<unknown>;

const CALLER_NAMES = Object.keys(CALLER_TOOLS);
const DAEMON_NAMES = Object.keys(TOOLS);
const STEP_TOOLS = { ...TOOLS, ...CALLER_TOOLS };

// A call that runs in this process: a caller tool, a type that fills in a
// code (secret.ts), or a run with one among its steps or with real: true,
// however a model wrote their names (browsing-history).
export function runsHere(tool: string, args: Record<string, unknown>): boolean {
  return callerSteps(tool, args) || nameIn(CALLER_NAMES, tool) !== undefined || secretType(tool, args);
}

function callerSteps(tool: string, args: Record<string, unknown>): boolean {
  const steps = args.steps;
  return nameIn(DAEMON_NAMES, tool) === "run" && Array.isArray(steps) && (args.real === true || steps.some((s: unknown) => !!s && typeof s === "object" && "tool" in s && typeof s.tool === "string" && runsHere(s.tool, "args" in s && s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {})));
}

// A model's click or type on a ref goes as real input (real_input), and
// only so, on a site marked for it (learn {site, real: true}; notes.ts) or
// in a run with real: true: on 09-30 EOIR's Submit and egov.uscis.gov's
// Check Status ignored scripted clicks, and my.uscis.gov kept no scripted
// text. Answers the real_input call it becomes and why, or undefined. The
// harness's own calls (a site's helpers) go as written.
type Routed = { args: Record<string, unknown>; snapshot: boolean; why: string };

async function asReal(tool: string, args: Record<string, unknown>, real: boolean): Promise<Routed | undefined> {
  const name = nameIn(DAEMON_NAMES, tool);
  if (name !== "click" && name !== "type") return undefined;
  const { snapshot, ...a } = checkCall(TOOLS, tool, args, true).args;
  if (a.ref === undefined) return undefined;
  const site = real ? undefined : await rpc("real_site", { tab: a.tab });
  if (!real && typeof site !== "string") return undefined;
  return { args: { ...a, do: name }, snapshot: snapshot === true, why: real ? "sent as real input: the run has real: true" : `sent as real input: ${String(site)} is marked for it (learn)` };
}

// model: the call is one a model wrote. The daemon checks the calls it
// runs (guard.ts), and this process the ones that run here. real: the call
// is a step of a run with real: true (asReal).
export async function invoke(tool: string, args: Record<string, unknown>, model = false, real = false): Promise<unknown> {
  // Model runs stay here so each step checks the site's real-input mark,
  // even without real: true (EOIR, 09-30). Internal runs keep the scripted
  // daemon path unless they explicitly contain a caller tool.
  if ((model && nameIn(DAEMON_NAMES, tool) === "run") || callerSteps(tool, args)) return runSteps(args.steps, (t, a) => invoke(t, a, model, args.real === true), (t, a) => checkStep(STEP_TOOLS, t, a), args.tab);
  const coded = secretType(tool, args);
  // A type that fills in a code keeps its own way (secret.ts): nothing
  // reaches the daemon before the code has come.
  const routed = model && !coded ? await asReal(tool, args, real) : undefined;
  if (!routed && !coded && nameIn(CALLER_NAMES, tool) === undefined) {
    const result = await rpc(tool, args, model);
    claimSpaces(nameIn(DAEMON_NAMES, tool) ?? tool, result);
    return result;
  }
  return withNews(args.tab, () => runHere(tool, args, model, coded, routed));
}

// A call that runs here makes daemon calls along the way (real input's
// locate and press, a handoff's watch, a card's fields). Their answers
// leave the agent's news (continuity.ts) to this call's, which takes it
// once at the end. Before, each took it and dropped it, so a tab a real
// click opened was never reported. A failed call leaves it for the next.
async function withNews(tab: unknown, run: () => Promise<unknown>): Promise<unknown> {
  const result = await quietly(run);
  if (!takesNews() || process.env.SAFARI_HARNESS_REMOTE || result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const news = await rpc("news", tab === undefined ? {} : { tab }).catch(() => ({}));
  return { ...result, ...(news as object) };
}

async function runHere(tool: string, args: Record<string, unknown>, model: boolean, coded: boolean, routed: Routed | undefined): Promise<unknown> {
  if (routed) {
    const result = beside(await invoke("real_input", routed.args, model), "note", routed.why);
    return routed.snapshot ? { ...(result as object), page: await rpc("snapshot", { tab: routed.args.tab }) } : result;
  }
  if (nameIn(CALLER_NAMES, tool) === undefined) {
    const a = checkCall(TOOLS, tool, args, model).args;
    return typeSecret(a, model, (text) => rpc("type", { ...a, secret: true, text }, model));
  }
  // real_input takes a code's source as type does, and its own parameters
  // go to it (secret.ts).
  const call = checkCall(CALLER_TOOLS, tool, args, model);
  const { secret: _secret, from: _from, from_selector: _fromSelector, ...rest } = call.args;
  const remote = process.env.SAFARI_HARNESS_REMOTE;
  const run = (a: Record<string, unknown>) => (remote ? remoteCall(remote, call.tool, a) : CALLER_TOOLS[call.tool].run(a));
  const result = await (coded ? typeSecret(call.args, model, (text) => run({ ...rest, text })) : run(call.args));
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
