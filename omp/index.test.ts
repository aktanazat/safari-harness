import { expect, test } from "bun:test";
import { join } from "node:path";
import safariTurnEnd from "./index.ts";
import reads from "./fixtures/reads.json";

type Context = { mode: string; agent: { kind: "main" | "sub"; id: string; parentId?: string }; sessionManager: { getSessionId(): string } };
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

// omp runs each helper in a session of its own. Its task also names the
// session its lead started it in, whose reads it shares (daemon/reads.ts),
// even after the lead moves to another session.
test("a helper's task names its lead's session, and keeps it after the lead moves to another session", async () => {
  await withHook(async (_end, tool) => {
    const lead = (session: string): Context => ({ mode: "rpc", agent: { kind: "main", id: "main" }, sessionManager: { getSessionId: () => session } });
    const helper = (session: string): Context => ({ mode: "rpc", agent: { kind: "sub", id: "reader", parentId: "main" }, sessionManager: { getSessionId: () => session } });
    const taskOf = (ctx: Context) => tool({ toolName: "mcp__safari_tabs", input: {} }, ctx)?.input.__safariTask;
    tool({ toolName: "task", input: {} }, lead("lead-a"));
    expect(taskOf(helper("helper-a"))).toBe(JSON.stringify(["helper-a", "reader", "lead-a"]));
    tool({ toolName: "task", input: {} }, lead("lead-b"));
    expect([taskOf(helper("helper-a")), taskOf(helper("helper-b"))]).toEqual([JSON.stringify(["helper-a", "reader", "lead-a"]), JSON.stringify(["helper-b", "reader", "lead-b"])]);
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

type Block = { type: string; text?: string };
type Result = { toolName: string; toolCallId: string; input: Record<string, unknown>; content: Block[] };
type WebHooks = {
  agent_end: (event: End, ctx: Context) => void | Promise<void>;
  tool_call: (event: ToolCall, ctx: Context) => { input: Record<string, unknown> } | { block: true; reason: string } | undefined;
  tool_result: (event: Result, ctx: Context) => Promise<{ content: Block[] } | undefined>;
  session_stop: (event: unknown, ctx: Context) => { continue: true; additionalContext: string } | undefined;
  before_agent_start: (event: unknown, ctx: Context) => void;
};
type Read = keyof typeof reads;

// Each run its own session, and each read its own call: what the hooks
// saw of either outlives a test.
let sessions = 0;
let calls = 0;
const fresh = (kind: "main" | "sub"): Context => {
  const session = `web-${++sessions}`;
  return { mode: "print", agent: { kind, id: kind === "main" ? "main" : "reader" }, sessionManager: { getSessionId: () => session } };
};
const readOf = (name: Read): Result => ({ toolName: "read", toolCallId: `read-${++calls}`, input: { path: reads[name].path }, content: [{ type: "text", text: reads[name].text }] });
const textOf = (patched: { content: Block[] } | undefined) => patched?.content.map((b) => b.text ?? "").join("\n") ?? "";

const PAGE = "Claude Code mascot Clawd crab plush toy, 9 inches, made to order in Portland. $34.00. Ships in 3 to 5 days from Oregon, United States. 1,204 sales, 4.9 stars from 312 reviews. Soft minky fabric, embroidered eyes, safe for all ages.";
const CHECKED = "a bot check stands in for the page; open it in a tab and wait a few seconds, since many checks clear on their own in a real Safari tab; hand it to the user with handoff only if it still stands and the page matters";
const NEXT_CHECK = "open it in a tab (safari open URL) and wait a few seconds, since many checks clear on their own in a real Safari tab; hand it to the user with handoff only if it still stands and the page matters";
const NEXT_THIN = "open it in a tab (safari open URL), wait for its text (safari wait), then read it (safari extract)";
// map's answers, as the daemon gave them on 10-23: Etsy's listing, the
// Lancet's Cloudflare check.
const copied = (url: string) => ({ ok: true, value: { pages: [{ url, ok: true, ms: 1200, value: { title: "Clawd plush", url, text: PAGE, pageState: { kind: "content", next: "" } } }] } });
const checked = (url: string) => ({ ok: true, value: { pages: [{ url, title: "Just a moment...", ok: false, ms: 9091, error: CHECKED, challenge: { kind: "cloudflare", where: "page" } }] } });

// The Safari helper's daemon as these hooks meet it: map answers each page
// as answer says, and every map asked is kept; "down" answers nothing.
async function withWeb(answer: ((url: string) => unknown) | "down", run: (hooks: WebHooks, maps: unknown[]) => Promise<void>) {
  const maps: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body: { tool?: string; args?: { urls?: string[] } } = await request.json();
    maps.push(body);
    return Response.json(answer === "down" ? {} : answer(body.args?.urls?.[0] ?? ""));
  } });
  const before = process.env.SAFARI_HARNESS_HTTP;
  process.env.SAFARI_HARNESS_HTTP = `http://127.0.0.1:${server.port}`;
  if (answer === "down") server.stop(true);
  const hooks: Partial<WebHooks> = {};
  safariTurnEnd({ on<E extends keyof WebHooks>(event: E, callback: WebHooks[E]) { hooks[event] = callback; } });
  const { agent_end, tool_call, tool_result, session_stop, before_agent_start } = hooks;
  try {
    if (!agent_end || !tool_call || !tool_result || !session_stop || !before_agent_start) throw new Error("the extension registers each hook");
    await run({ agent_end, tool_call, tool_result, session_stop, before_agent_start }, maps);
  } finally {
    server.stop(true);
    if (before === undefined) delete process.env.SAFARI_HARNESS_HTTP;
    else process.env.SAFARI_HARNESS_HTTP = before;
  }
}

// Real read answers from October transcripts that were not the page.
const WALLS: [Read, string, boolean][] = [
  ["etsy", "HTTP 403", false],
  ["h999", "HTTP 999", false],
  ["h429", "HTTP 429", false],
  ["h406", "HTTP 406", false],
  ["x", "X answers automated reads with nothing", true],
  ["eproto", "EPROTO: The TLS handshake failed. Does the server speak TLS on this port?", false],
  ["timeout", "The operation timed out.", false],
  ["first_cert", "unable to verify the first certificate", false],
  ["request_rejected", 'a bot check ("Request Rejected")', false],
  ["recaptcha_base", "a bot check at https://www.google.com/recaptcha/challengepage/", false],
  ["stile", "a bot check at https://spoolstreet.com/.stile/challenge?rung=nojs", false],
  ["walmart", "a bot check at https://www.walmart.com/blocked?url=", false],
  ["verify_human", "a bot check at https://developer.apple.com/forums/verify-human/verify.html", false],
  ["idmsa", "a sign-in page at https://idmsa.apple.com/IDMSWebAuth/signin.html", false],
  ["google_sites", "a sign-in page at https://accounts.google.com/v3/signin/identifier", false],
  ["reddit_login", "a sign-in page at https://old.reddit.com/login/?reason=lor2", false],
  ["stanford", "a sign-in page at https://applygrad.stanford.edu/account/login", false],
  ["instinct", "a sign-in page", false],
  ["chromium", "a sign-in page", false],
  ["tiziana", "the page draws itself with JavaScript", false],
  ["calrecycle", "HTTP 404 at https://www2.calrecycle.ca.gov/BevContainer/NotFound", false],
];

test.each(WALLS)("a web read that was not the page (%s) gets Safari's copy, loaded under this agent's task", async (name, why, post) => {
  await withWeb(copied, async (hooks, maps) => {
    const ctx = fresh("main");
    const url = reads[name].path;
    const text = textOf(await hooks.tool_result(readOf(name), ctx));
    expect(text).toStartWith(`${reads[name].text}\nsafari: read could not load this page (${why}`);
    expect(text).toContain(`); the Safari helper loaded it:\n## ${url} (1200 ms)\n`);
    expect(text).toEndWith(PAGE);
    expect(maps).toEqual([{ tool: "map", args: { urls: [url], ...(post ? { wait: { selector: "article" } } : {}) }, caller: process.pid, own: true, news: false, task: JSON.stringify([ctx.sessionManager.getSessionId(), ctx.agent.id]) }]);
  });
});

// Real read answers that were the page, or an error Safari would only
// repeat: none waits on Safari.
const PAGES: Read[] = ["xfinity", "passkey", "login_window", "hark_pricing", "docs_ok", "bun404", "cdtfa", "nfs", "enotfound", "refused_remote"];

test.each(PAGES)("a web read that was the page, or a plain error (%s), is left as it was and asks Safari nothing", async (name) => {
  await withWeb(copied, async (hooks, maps) => {
    expect(await hooks.tool_result(readOf(name), fresh("main"))).toBeUndefined();
    expect(maps).toEqual([]);
  });
});

test.each([
  ["meets a bot check", checked, `## Just a moment... — URL (9091 ms; challenge: {"kind":"cloudflare","where":"page"})\nerror: ${CHECKED}`, NEXT_CHECK],
  ["shows only a sign-in link, as the Chromium tracker's did", (url: string) => ({ ok: true, value: { pages: [{ url, ok: true, ms: 900, value: { title: "Chromium", url, text: "Sign in", pageState: { kind: "unjudged", next: "read a whole-page snapshot or extract before judging what is available." } } }] } }), "## URL (900 ms)\n# Chromium — URL\n\nSign in", NEXT_THIN],
  ["answers with an error", () => ({ ok: false, error: "the Safari extension is not connected" }), "error: the Safari extension is not connected", NEXT_THIN],
  ["is not running", "down" as const, "error: the Safari helper did not answer (", NEXT_THIN],
])("a read Safari does not load either (Safari %s) gets what Safari answered and the next step", async (_name, answer, answered, next) => {
  await withWeb(answer, async (hooks) => {
    const url = reads.etsy.path;
    const text = textOf(await hooks.tool_result(readOf("etsy"), fresh("main")));
    expect(text).toStartWith(`${reads.etsy.text}\nsafari: read could not load this page (HTTP 403), and the Safari helper did not load it either. Safari answered:\n${answered.replaceAll("URL", url)}`);
    expect(text).toEndWith(`\nsafari: next, ${next.replace("URL", url)}. If it still fails, quote what Safari answered when you report it.`);
  });
});

test("a read's result gets Safari's copy once, however often its hook sees it", async () => {
  await withWeb(copied, async (hooks, maps) => {
    const ctx = fresh("main");
    const event = readOf("etsy");
    const first = await hooks.tool_result(event, ctx);
    expect(await hooks.tool_result(event, ctx)).toBeUndefined();
    expect(await hooks.tool_result({ ...readOf("etsy"), content: first?.content ?? [] }, ctx)).toBeUndefined();
    expect(maps).toHaveLength(1);
  });
});

const BIKE_BARN = "https://bikebarn.ucdavis.edu/repairs";
const ETSY = "https://www.etsy.com/listing/4508385462/claude-code-mascot-clawd-crab-plush-toy";
// Shell fetches that met a wall: Bike Barn's curl and Hark's status check
// from October transcripts, a Cloudflare check's headers, and requests'
// error for a 403.
const SHELL_WALLS: [string, string, string, string, string, string][] = [
  ["Bike Barn's page", "bash", `for u in ${BIKE_BARN}; do echo "== $u"; curl -sL "$u" | sed -e 's/<[^>]*>//g' | tr -s ' \\n' ' ' | cut -c1-300; done`, `== ${BIKE_BARN}\n Attention Required! | Cloudflare Please enable cookies. Sorry, you have been blocked You are unable to access sfcf.ucdavis.edu Why have I been blocked?`, BIKE_BARN, "a Cloudflare wall"],
  ["a status check", "bash", "curl -s -o /dev/null -w '%{http_code} %{url_effective} %{size_download}\\n' https://app.hark.com/", "401 https://app.hark.com/ 12", "https://app.hark.com/", "HTTP 401"],
  ["a check's headers", "bash", `curl -sI ${ETSY}`, "HTTP/2 403 \ndate: Fri, 23 Oct 2026 06:12:09 GMT\ncontent-type: text/html; charset=UTF-8\ncf-mitigated: challenge\nserver: cloudflare", ETSY, "a Cloudflare wall"],
  ["requests' error", "eval", `import requests\nrequests.get("${ETSY}").raise_for_status()`, `requests.exceptions.HTTPError: 403 Client Error: Forbidden for url: ${ETSY}`, ETSY, "HTTP 403"],
];

test.each(SHELL_WALLS)("a shell fetch that met a wall (%s) gets the map command for its page, and Safari is not asked", async (_name, toolName, command, output, url, why) => {
  await withWeb(copied, async (hooks, maps) => {
    const input = toolName === "eval" ? { language: "py", code: command } : { command };
    const text = textOf(await hooks.tool_result({ toolName, toolCallId: "shell", input, content: [{ type: "text", text: output }] }, fresh("main")));
    expect(text).toBe(`${output}\nsafari: ${new URL(url).hostname.replace(/^www\./, "")} answered this fetch with ${why}; read the page in the Safari helper instead: safari map ${url}`);
    expect(maps).toEqual([]);
  });
});

test.each([
  ["a page that loaded", "curl -s https://bun.sh/docs/api/markdown | cut -c1-120", '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Markdown – Bun</title>'],
  ["a status that let it in", "curl -sI https://bun.sh/", "HTTP/2 200 \ncontent-type: text/html; charset=utf-8\nserver: cloudflare"],
  ["Safari's own answer", `safari map ${ETSY}`, `## Just a moment... — ${ETSY} (9091 ms; challenge: {"kind":"cloudflare","where":"page"})\nerror: ${CHECKED}`],
  ["a local service's refusal", "curl -si http://127.0.0.1:37334/rpc", "HTTP/1.1 403 Forbidden\ncontent-length: 0"],
])("a shell command's output with no wall it fetched (%s) is left as it was", async (_name, command, output) => {
  await withWeb(copied, async (hooks) => {
    expect(await hooks.tool_result({ toolName: "bash", toolCallId: "shell", input: { command }, content: [{ type: "text", text: output }] }, fresh("main"))).toBeUndefined();
  });
});

test("a lead's run that ends with a page Safari did not load either continues once, naming it and the next step; a new prompt starts over", async () => {
  await withWeb(checked, async (hooks) => {
    const ctx = fresh("main");
    await hooks.tool_result(readOf("etsy"), ctx);
    const told = hooks.session_stop({}, ctx);
    expect(told).toEqual({ continue: true, additionalContext: expect.stringContaining(`\n- ${ETSY} (read: HTTP 403)\n`) });
    expect(told?.additionalContext).toContain(`For a bot check: ${NEXT_CHECK}.`);
    expect(told?.additionalContext).toContain("If your instructions told you to leave a page, skip it and say so in your reply.");
    expect(hooks.session_stop({}, ctx)).toBeUndefined();
    hooks.before_agent_start({}, ctx);
    expect(hooks.session_stop({}, ctx)).toBeUndefined();
    await hooks.tool_result(readOf("etsy"), ctx);
    expect(hooks.session_stop({}, ctx)).toMatchObject({ continue: true });
  });
});

test("a helper that would yield with a page Safari did not load either is sent back once; its next yield passes", async () => {
  await withWeb(checked, async (hooks) => {
    const ctx = fresh("sub");
    const finish = { toolName: "yield", input: { data: "done" } };
    expect(hooks.tool_call(finish, ctx)).toBeUndefined();
    await hooks.tool_result(readOf("etsy"), ctx);
    expect(hooks.tool_call(finish, ctx)).toEqual({ block: true, reason: expect.stringContaining(`\n- ${ETSY} (read: HTTP 403)\n`) });
    expect(hooks.tool_call(finish, ctx)).toBeUndefined();
  });
});

const opened = `{\n "id": 239642,\n "url": "${ETSY}",\n "title": "Clawd plush"\n}`;
const stillChecked = `{\n "id": 239642,\n "url": "${ETSY}",\n "title": "Just a moment...",\n "challenge": {\n  "kind": "cloudflare",\n  "where": "page"\n }\n}`;
const snapshotChecked: Result = { toolName: "mcp__safari_snapshot", toolCallId: "s", input: { tab: 239642 }, content: [{ type: "text", text: `# Just a moment... — ${ETSY} (24 nodes)\nchallenge: {"kind":"cloudflare","where":"page"}\nVerifying you are human. This may take a few seconds.` }] };
// What a run did after a wall, and whether its end is held for it: a page
// Safari met a check on is answered by acting on the page in a tab, not by
// a read that meets the check again.
const LATER: [string, (url: string) => unknown, Result[], boolean][] = [
  ["nothing, its copy loaded", copied, [], false],
  ["nothing, its copy met a check", checked, [], true],
  ["a map that met the check again", checked, [{ toolName: "write", toolCallId: "w", input: { path: "xd://mcp__safari_map", content: JSON.stringify({ urls: [ETSY] }) }, content: [{ type: "text", text: `## Just a moment... — ${ETSY} (0 ms; challenge: {"kind":"cloudflare","where":"page"})\nerror: ${CHECKED}` }] }], true],
  ["an open of the page", checked, [{ toolName: "mcp__safari_open", toolCallId: "o", input: { url: ETSY }, content: [{ type: "text", text: opened }] }], false],
  ["the CLI's open of the page", checked, [{ toolName: "bash", toolCallId: "o", input: { command: `safari open '${ETSY}' --background` }, content: [{ type: "text", text: opened }] }], false],
  ["an open the check still stood in", checked, [{ toolName: "mcp__safari_open", toolCallId: "o", input: { url: ETSY }, content: [{ type: "text", text: stillChecked }] }], false],
  ["a snapshot of a tab the check stood in", copied, [snapshotChecked], true],
  ["a snapshot of a tab the check stood in, then a wait on that tab", copied, [snapshotChecked, { toolName: "mcp__safari_wait", toolCallId: "w", input: { tab: 239642, text: "Clawd", ms: 15000 }, content: [{ type: "text", text: '{"ok":true,"found":"Clawd","waitedMs":4200}' }] }], false],
];

test.each(LATER)("a read wall followed by %s holds the run's end: %p", async (_name, answer, later, held) => {
  await withWeb(answer, async (hooks) => {
    const ctx = fresh("main");
    await hooks.tool_result(readOf("etsy"), ctx);
    for (const event of later) await hooks.tool_result(event, ctx);
    expect(hooks.session_stop({}, ctx) !== undefined).toBe(held);
  });
});

test.each([
  ["no Safari call", [], true],
  ["a map of the page", [{ toolName: "mcp__safari_map", toolCallId: "m", input: { urls: [BIKE_BARN] }, content: [{ type: "text", text: `## Repairs — ${BIKE_BARN} (1342 ms)\n# Repairs — ${BIKE_BARN}\n\nBike Barn repairs: flat fix $12.` }] }], false],
  ["a read of the page whose Safari copy loaded", [{ toolName: "read", toolCallId: "r", input: { path: BIKE_BARN }, content: [{ type: "text", text: `URL: ${BIKE_BARN}\nContent-Type: text/html\nMethod: failed\nNotes: Failed to fetch URL (HTTP 403)\n\n---\n\n` }] }], false],
  ["a map of another site", [{ toolName: "mcp__safari_map", toolCallId: "m", input: { urls: ["https://bun.sh/docs"] }, content: [{ type: "text", text: "## Docs — https://bun.sh/docs (800 ms)\n# Docs — https://bun.sh/docs\n\nBun docs." }] }], true],
] as [string, Result[], boolean][])("a shell wall followed by %s holds the run's end: %p", async (_name, later, held) => {
  await withWeb(copied, async (hooks) => {
    const ctx = fresh("main");
    const [, , command, output] = SHELL_WALLS[0];
    await hooks.tool_result({ toolName: "bash", toolCallId: "curl", input: { command }, content: [{ type: "text", text: output }] }, ctx);
    for (const event of later) await hooks.tool_result(event, ctx);
    const told = hooks.session_stop({}, ctx);
    expect(told !== undefined).toBe(held);
    if (held) expect(told?.additionalContext).toContain(`\n- ${BIKE_BARN} (a shell fetch met a Cloudflare wall)\n`);
  });
});
