// The tools an MCP server offers, as one release has them. The server
// (mcp.ts) holds its client's connection for the whole agent session, across
// deploys, and runs each call with this module from the newest release the
// daemon runs (fresh.ts). Servers started on older releases call these three
// exports of newer ones: keep their names and signatures as they are.

import { join } from "node:path";
import { TOOLS, codeFrom, inputSchema, replyText, type Tool } from "./tools.ts";
import { CALLER_GROUPS, CALLER_TOOLS } from "./caller.ts";
import { invoke } from "./call.ts";
import { checkCall } from "./guard.ts";
import { HarnessError, readFailure } from "./failures.ts";
import { affectsPage } from "./lanes.ts";
import type { ReplResult, ReplSession } from "./repl.ts";
import { withTask } from "./rpc.ts";

// This connection's own REPL session: its bindings last as long as the
// connection runs this release, and its tabs close with it.
let repl: ReplSession | undefined;

// Each release's session for this connection, in the server's process: a
// deploy loads this module again from the new release (fresh.ts), its
// session empty. On 10-22 the first call after one failed "mp is not
// defined", the page bound an hour before; the session that made a new
// one says so with its first answer, and names the pages to attach again.
type Made = { started: string; tabs: () => { id: number; url: string }[] };
const MADE = Symbol.for("safari-harness.mcp-repl");
let fresh: string | undefined;

function connectionSession(make: () => ReplSession): ReplSession {
  if (repl) return repl;
  const before = Reflect.get(globalThis, MADE) as Made | undefined;
  const session = make();
  const made: Made = { started: new Date().toISOString(), tabs: () => session.tabs.map((p) => ({ id: p.id, url: p.url() })) };
  Reflect.set(globalThis, MADE, made);
  if (before) {
    const pages = before.tabs().map((t) => `${t.id} ${t.url}`).join(", ");
    fresh = `this repl session started fresh at ${made.started} (the harness was updated); earlier bindings are gone; reattach with attachBrowserTab(id)${pages ? `: ${pages}` : ""}`;
  }
  return (repl = session);
}

const REPL_TOOL: Tool = {
  desc: "Run JS in Safari; bindings persist; last value/console.log returned. 120 s limit; some clients 60 s: split waits. p.waitForChange() for new lines. API and site kits: safari guide <site|repl>.",
  params: { code: { type: "string", description: "JS, top-level await (or file: path)" }, file: { type: "string" }, session: { type: "string", description: "a named session, shared with safari repl --session; omit: this connection's own" } },
  run: async (a) => {
    // The repl's modules (node:vm, the site kits) load on its first call:
    // most sessions never make one, and this server lives as long as its session.
    const [{ ReplSession }, { REPL_DIR, runInSession }] = await Promise.all([import("./repl.ts"), import("./repl-host.ts")]);
    if ((a.code === undefined) === (a.file === undefined)) throw new Error("repl takes code, or file: the code's absolute path (one of them)");
    const code = a.file === undefined ? String(a.code) : await codeFrom(a.file);
    const own = a.session === undefined;
    const r: ReplResult & { hint?: string } = own
      ? await connectionSession(() => new ReplSession(`mcp-${process.pid}`, { cwd: join(REPL_DIR, `mcp-${process.pid}`) })).run(code)
      : await runInSession(String(a.session), code, { host: process.env.SAFARI_HARNESS_HOST });
    const notice = own && fresh !== undefined ? `${fresh}\n` : "";
    if (own) fresh = undefined;
    // The error first: output printed before it can be a page's snapshot.
    if (r.error) throw new Error(`${notice}${r.error}${r.output ? `\noutput before the error:\n${r.output}` : ""}`);
    const out = `${notice}${r.output || "(no output; return or console.log what you want back)"}`;
    return r.hint === undefined ? out : `${out}\nhint: ${r.hint}`;
  },
};

const SESSION_NOTES: Record<string, string> = {
  close: " Not needed once you have the answer: your tabs close themselves when your turn ends. Reply instead.",
};

// A tool's schema as the client gets it. do is never listed required: the
// daemon takes action and go as do (guard.ts) and refuses a call with none,
// but omp checks required before a call leaves it, and refused real_input
// {action: "click"} for want of do before the daemon could take it
// (01a0f145, 09-30).
function published(t: Tool) {
  const schema = inputSchema(t);
  const entries = Object.entries(schema.properties);
  const properties = entries.some(([, param]) => param.description === "")
    ? Object.fromEntries(entries.map(([name, param]) => [name, param.description === "" ? { ...param, description: undefined } : param]))
    : schema.properties;
  return { ...schema, properties, ...(t.required?.includes("do") ? { required: t.required.filter((k) => k !== "do") } : {}) };
}

// Caller tools run in the server's process, not in the daemon: it inherits
// the terminal's permissions (see caller.ts).
export function listTools(): unknown[] {
  return [
    ...Object.entries(TOOLS).filter(([, t]) => !t.hidden).map(([name, t]) => ({ name, description: `${t.desc}${SESSION_NOTES[name] ?? ""}`, inputSchema: published(t) })),
    { name: "repl", description: REPL_TOOL.desc, inputSchema: published(REPL_TOOL) },
    ...CALLER_GROUPS.flatMap((g) => Object.entries(g.tools).filter(([, t]) => !t.hidden).map(([name, t]) => ({ name, description: `[${g.label}] ${t.desc}`, inputSchema: published(t) }))),
  ];
}

const RUN_STEP_TOOLS = { ...TOOLS, ...CALLER_TOOLS };

// A call's answer as the client reads it; a failed call throws.
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const { __safariTask, ...input } = args;
  const task = typeof __safariTask === "string" && __safariTask.trim() ? __safariTask : undefined;
  return withTask(task, async () => {
    const value = name === "repl" ? await REPL_TOOL.run(checkCall({ repl: REPL_TOOL }, name, input, true).args) : await invoke(name, input, true);
    const answer = await replyText(value);
    const runSteps: unknown[] | undefined = name === "run" && value !== null && typeof value === "object"
      && "steps" in value && Array.isArray(value.steps) ? value.steps : undefined;
    const failed = runSteps?.find((step) => step !== null && typeof step === "object" && "error" in step);
    if (failed && typeof failed === "object") {
      const failure = "failure" in failed ? readFailure(failed.failure) : undefined;
      const acted = runSteps?.some((step) => {
        if (step === null || typeof step !== "object" || !("value" in step) || !("step" in step) || typeof step.step !== "number") return false;
        const request: unknown = Array.isArray(input.steps) ? input.steps[step.step - 1] : undefined;
        if (request === null || typeof request !== "object" || !("tool" in request) || typeof request.tool !== "string") return false;
        const stepArgs = "args" in request && request.args !== null && typeof request.args === "object" && !Array.isArray(request.args)
          ? request.args as Record<string, unknown> : {};
        const checked = checkCall(RUN_STEP_TOOLS, request.tool, stepArgs, true);
        return checked.tool === "open" || affectsPage(checked.tool, checked.args);
      });
      const uncertain = runSteps?.some((step) => step !== null && typeof step === "object" && "failure" in step
        && readFailure(step.failure)?.effect === "possibly_effected");
      const effect = acted || uncertain ? "possibly_effected" : "none";
      throw new HarnessError(failure?.code ?? "command_failed", answer, {
        effect, retryable: effect === "none" ? failure?.retryable : false,
        next: effect === "none" ? failure?.next : undefined,
      });
    }
    return answer;
  });
}

// The connection ends: the REPL session's tabs close.
export async function closeSession(): Promise<void> {
  await repl?.close();
}

// A server lists its own release's tools by running this file, until a
// call loads them (fresh.ts).
if (import.meta.main) console.log(JSON.stringify(listTools()));
