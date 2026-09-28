import { expect, test } from "bun:test";

type Call = { tool: string; args: Record<string, unknown> };

// MCP clients put the whole tool list in front of the model on every turn, so
// each byte here is paid on every step of every browsing task. The list was
// 13,569 bytes before it was trimmed to 10,573; run then added 651, and pays
// for itself by saving whole turns. Targets by selector or text (90) and an
// extract query (96) save the look-first turn; Apple Passwords (700) brought
// it to 12,111. Telling close that background tabs close with the session
// (114) saves the turn agents spent on close. Telling eval that a selector
// remembered from training may be gone (73) saves the retry after one misses.
// Closing the gaps with Aside's Chrome tools (3,930) brought it to 16,228:
// fetch, download, dialog, pdf, window, browsing_history, and real_input,
// plus snapshot diff and frames, page-world eval, cookie set, and element
// and full-page shots. Each is a task an agent could not finish before.
// The repl tool (665) brought it to 16,893: one call runs a whole script, a
// loop over pages or a download or a signed-in site's own API, that would
// otherwise cost a turn per step; the address and Bitwarden fill tools stay
// off the list, reached through repl and the CLI. Holding a tab on screen
// during wait (76) brought it to 16,979: a routine can finish a sign-in
// page that stalls in a hidden tab without Accessibility permission.
// Trading passwords lock for status (14) brought it to 16,993: one agent's
// lock had locked the shared pairing for every other agent, and status says
// why it is locked. The handoff tool (496, with activate saying it raises
// Safari) brought it to 17,489: a bot check or a passkey prompt now goes to
// the user in one call instead of a stalled wait and a chat round trip.
// Requiring tab on the page tools (259: tab joins their required lists, and
// open says what tab "front" means) brought it to 17,748: a call without
// tab now fails instead of reading the user's front tab, as one did his
// medical records page. Saying that net records from the start of the page
// load, in every frame, with the start of each response body (74) brought it
// to 17,822: an agent reads a failed request at once instead of starting
// capture and reloading, as one could not on CVS's insurance form.
// Passwords' done and one-touch pairing (62) brought it to 17,884: a locked
// call pairs after the user's Touch ID, and a session lets go of the pairing
// when done.
const TOOL_LIST_MAX_BYTES = 17_884;

async function toolList(): Promise<unknown> {
  const server = Bun.spawn(["bun", `${import.meta.dir}/mcp.ts`], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  server.stdin.end();
  const out = await new Response(server.stdout).text();
  const reply: unknown = JSON.parse(out.split("\n")[0]);
  if (reply && typeof reply === "object" && "result" in reply && reply.result && typeof reply.result === "object" && "tools" in reply.result) return reply.result.tools;
  throw new Error(`no tool list in: ${out.slice(0, 200)}`);
}

test("the MCP tool list stays small", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(await toolList())).length;
  expect(bytes).toBeLessThanOrEqual(TOOL_LIST_MAX_BYTES);
});

// A stand-in daemon: open hands out ids 1, 2, 3...; a click in tab 1 opens
// tab 100; run reports each step's value as the daemon would.
function fakeDaemon(calls: Call[]) {
  let next = 0;
  const value = (c: Call): unknown => {
    if (c.tool === "open") return { id: ++next, url: c.args.url };
    if (c.tool === "click" && c.args.tab === 1) return { ok: true, newTab: { id: 100, url: "https://example.org/" } };
    if (c.tool === "run") {
      const steps = c.args.steps as Call[];
      return { steps: steps.map((s, i) => ({ step: i + 1, tool: s.tool, value: value({ tool: s.tool, args: s.args ?? {} }) })), notRun: 0 };
    }
    return { ok: true };
  };
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const c = (await req.json()) as Call;
      calls.push(c);
      return Response.json({ ok: true, value: value(c) });
    },
  });
}

test("a session's background tabs, and tabs they open, close when it ends; a front tab stays", async () => {
  const calls: Call[] = [];
  const daemon = fakeDaemon(calls);
  const server = Bun.spawn(["bun", `${import.meta.dir}/mcp.ts`], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${daemon.port}` },
  });
  const lines = server.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  let id = 0;
  async function callTool(name: string, args: Record<string, unknown>) {
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    server.stdin.flush();
    while (!pending.includes("\n")) pending += (await lines.read()).value ?? "";
    pending = pending.slice(pending.indexOf("\n") + 1);
  }
  await callTool("open", { url: "https://example.com/", background: true }); // tab 1
  await callTool("click", { tab: 1, ref: "Elsewhere" }); // opens tab 100
  await callTool("open", { url: "https://example.com/" }); // tab 2, in front
  await callTool("run", { steps: [{ tool: "open", args: { url: "https://example.com/", background: true } }, { tool: "click", args: { ref: "x" } }] }); // tab 3
  await callTool("open", { url: "https://example.com/", background: true }); // tab 4
  await callTool("close", { tab: 4 });
  const before = calls.length;
  server.stdin.end();
  await server.exited;
  daemon.stop();
  const closed = calls.slice(before).filter((c) => c.tool === "close").map((c) => c.args.tab).sort((a, b) => Number(a) - Number(b));
  expect(closed).toEqual([1, 3, 100]);
});
