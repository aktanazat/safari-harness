import { expect, test } from "bun:test";
import { join } from "node:path";
import safariTurnEnd from "./index.ts";

type Context = { mode: string; agent: { kind: "main" | "sub"; id: string }; sessionManager: { getSessionId(): string } };
type End = { willContinue?: boolean };
type ToolCall = { toolName: string; input: Record<string, unknown> };
type ToolResult = { input: Record<string, unknown> } | undefined;
type Hooks = {
  agent_end: (event: End, ctx: Context) => void | Promise<void>;
  tool_call: (event: ToolCall, ctx: Context) => ToolResult;
};
const context = (kind: "main" | "sub", mode = "tui", id: string = kind): Context => ({ mode, agent: { kind, id }, sessionManager: { getSessionId: () => "session-a" } });
const task = JSON.stringify(["session-a", "helper"]);

async function withHook(run: (end: (event: End, ctx: Context) => unknown, tool: (event: ToolCall, ctx: Context) => ToolResult, requests: { path: string; body: unknown }[]) => Promise<void>) {
  const requests: { path: string; body: unknown }[] = [];
  const prepared = { owner: process.pid, task, epoch: "owned-generation", tabs: [101] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, body: await request.json() });
    if (path === "/rpc") return Response.json({ ok: true, value: { tabs: [] } });
    return Response.json(path === "/turn-end/prepare" ? prepared : { ok: true, closed: 1, retained: 0, failed: 0, deferred: false });
  } });
  const before = process.env.SAFARI_HARNESS_HTTP;
  process.env.SAFARI_HARNESS_HTTP = `http://127.0.0.1:${server.port}`;
  const hooks: Partial<Hooks> = {};
  safariTurnEnd({ on<E extends keyof Hooks>(event: E, callback: Hooks[E]) { hooks[event] = callback; } });
  try {
    await run(hooks.agent_end ?? (() => undefined), hooks.tool_call ?? (() => undefined), requests);
  } finally {
    server.stop(true);
    if (before === undefined) delete process.env.SAFARI_HARNESS_HTTP;
    else process.env.SAFARI_HARNESS_HTTP = before;
  }
}

test.each(["tui", "rpc", "json", "print"])("a helper's final completion in %s mode admits only its own task and is awaitable", async (mode) => {
  await withHook(async (end, _tool, requests) => {
    await end({}, context("sub", mode, "helper"));
    expect(requests).toEqual([
      { path: "/turn-end/prepare", body: { owner: process.pid, task } },
      { path: "/turn-end", body: { owner: process.pid, task, prepared: { owner: process.pid, task, epoch: "owned-generation", tabs: [101] } } },
    ]);
  });
});

test("main completion still admits every task owned by its process", async () => {
  await withHook(async (end, _tool, requests) => {
    await end({}, context("main"));
    expect(requests).toEqual([
      { path: "/turn-end/prepare", body: { owner: process.pid } },
      { path: "/turn-end", body: { owner: process.pid, prepared: { owner: process.pid, task, epoch: "owned-generation", tabs: [101] } } },
    ]);
  });
});

test.each([context("sub"), context("main"), context("sub", "print")])("a continuing turn admits no cleanup for %j", async (ctx) => {
  await withHook(async (end, _tool, requests) => {
    await end({ willContinue: true }, ctx);
    expect(requests).toEqual([]);
  });
});

test("main print completion preserves its no-cleanup policy", async () => {
  await withHook(async (end, _tool, requests) => {
    await end({}, context("main", "print"));
    expect(requests).toEqual([]);
  });
});

test("mounted Safari inputs replace untrusted task identity without changing caller input", async () => {
  await withHook(async (_end, tool) => {
    const input = { url: "https://example.com/", __safariTask: "forged" };
    expect(tool({ toolName: "mcp__safari_open", input }, context("sub", "rpc", "helper"))?.input).toEqual({ url: input.url, __safariTask: task });
    expect(input.__safariTask).toBe("forged");
  });
});

test("the same agent id in another session receives another task identity", async () => {
  await withHook(async (_end, tool) => {
    const ctx = context("sub", "rpc", "helper");
    ctx.sessionManager = { getSessionId: () => "session-b" };
    expect(tool({ toolName: "mcp__safari_tabs", input: {} }, ctx)?.input).toEqual({ __safariTask: JSON.stringify(["session-b", "helper"]) });
  });
});

test.each(["read", "write", "mcp__iris_capture", "mcp__safari2_open"])("a non-Safari %s input remains untouched", async (toolName) => {
  await withHook(async (_end, tool) => {
    expect(tool({ toolName, input: { path: "notes.txt", command: "echo ok" } }, context("sub"))).toBeUndefined();
  });
});

test("task tagging preserves shell state, inherited task and a failing command's status", async () => {
  await withHook(async (_end, tool) => {
    const command = "cd /private/var/tmp\nexport SAFARI_SMOKE_PERSIST=yes\nsmoke_keep() { printf preserved; }\nfalse";
    const wrapped = tool({ toolName: "bash", input: { command } }, context("sub"))?.input.command;
    if (typeof wrapped !== "string") throw new Error("shell command must remain text");
    const child = Bun.spawn(["/bin/bash", "-c", `${wrapped}\nstatus=$?\nprintf '%s|%s|%s|%s|' "$status" "$PWD" "$SAFARI_SMOKE_PERSIST" "$SAFARI_HARNESS_TASK"; smoke_keep`], {
      env: { ...process.env, SAFARI_HARNESS_TASK: "inherited" }, stdout: "pipe", stderr: "pipe",
    });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, error, output }).toEqual({ exit: 0, error: "", output: "1|/private/var/tmp|yes|inherited|preserved" });
  });
});

test("shell commands receive isolated task environments across a pipeline and chained commands", async () => {
  await withHook(async (_end, tool) => {
    const code = "process.stdout.write(process.env.SAFARI_HARNESS_TASK ?? 'missing')";
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} | /bin/cat && ${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
    const run = async (id: string) => {
      const replacement = tool({ toolName: "bash", input: { command, cwd: "/tmp", async: true } }, context("sub", "rpc", id));
      const actual = replacement?.input.command ?? command;
      expect(typeof actual).toBe("string");
      if (typeof actual !== "string") throw new Error("shell command must remain text");
      const child = Bun.spawn(["/bin/sh", "-c", actual], { env: { ...process.env, SAFARI_HARNESS_TASK: "inherited" }, stdout: "pipe", stderr: "pipe" });
      const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, error }).toEqual({ exit: 0, error: "" });
      return output;
    };
    expect(await Promise.all([run("helper'$(false)"), run("sibling")])).toEqual([
      JSON.stringify(["session-a", "helper'$(false)"]).repeat(2),
      JSON.stringify(["session-a", "sibling"]).repeat(2),
    ]);
  });
});

// Agents copy the wrapped command out of their transcript (AH1, HD-4).
const copiedFrom = (command: string, layers: number) => Array.from({ length: layers }, (_, i) => JSON.stringify(["session-b", `copied-${i}`]))
  .reduce((inner, other) => `SAFARI_HARNESS_TASK='${other.replaceAll("'", "'\\''")}' eval '${inner.replaceAll("'", "'\\''")}'`, command);

async function shell(command: string) {
  const child = Bun.spawn(["/bin/sh", "-c", command], { env: { ...process.env, SAFARI_HARNESS_TASK: "inherited" }, stdout: "pipe", stderr: "pipe" });
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exit, error, output };
}

test.each([0, 1, 3])("a command copied under %i task wrappers runs once, under this agent's own task", async (layers) => {
  await withHook(async (_end, tool) => {
    const command = `printf '%s|%s\\n' "it's" "$SAFARI_HARNESS_TASK" | /bin/cat && echo "done $((1 + 1))"`;
    const wrapped = tool({ toolName: "bash", input: { command: copiedFrom(command, layers) } }, context("sub", "rpc", "helper"))?.input.command;
    if (typeof wrapped !== "string") throw new Error("shell command must remain text");
    expect(await shell(wrapped)).toEqual({ exit: 0, error: "", output: `it's|${task}\ndone 2\n` });
    expect(wrapped).toBe(tool({ toolName: "bash", input: { command } }, context("sub", "rpc", "helper"))?.input.command);
  });
});

test("a copied wrapper with more commands after it still runs all of them under this agent's own task", async () => {
  await withHook(async (_end, tool) => {
    const command = `${copiedFrom(`printf '%s ' "$SAFARI_HARNESS_TASK"`, 2)} && printf '%s' "$SAFARI_HARNESS_TASK"`;
    const wrapped = tool({ toolName: "bash", input: { command } }, context("sub", "rpc", "helper"))?.input.command;
    if (typeof wrapped !== "string") throw new Error("shell command must remain text");
    expect(await shell(wrapped)).toEqual({ exit: 0, error: "", output: `${task} ${task}` });
  });
});

test("helper shell tools carry their exact task through the real Safari CLI to HTTP", async () => {
  await withHook(async (_end, tool, requests) => {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "../cli/safari.ts"))} tabs --json --host local`;
    const run = async (id: string) => {
      const input = tool({ toolName: "bash", input: { command } }, context("sub", "rpc", id))?.input;
      const actual = input?.command ?? command;
      if (typeof actual !== "string") throw new Error("shell command must remain text");
      const child = Bun.spawn(["/bin/sh", "-c", actual], { env: { ...process.env, SAFARI_HARNESS_TASK: "inherited" }, stdout: "pipe", stderr: "pipe" });
      const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, error }).toEqual({ exit: 0, error: "" });
      expect(JSON.parse(output)).toEqual({ tabs: [] });
    };
    await Promise.all([run("helper"), run("sibling")]);
    expect(requests).toEqual(expect.arrayContaining([
      { path: "/rpc", body: expect.objectContaining({ tool: "tabs", task }) },
      { path: "/rpc", body: expect.objectContaining({ tool: "tabs", task: JSON.stringify(["session-a", "sibling"]) }) },
    ]));
  });
});
