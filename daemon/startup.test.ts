import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every CLI command and every MCP session starts a bun process, and each
// module it imports adds to that start. A tool call needs the tools, not
// the modules of the repl (node:vm and the site kits), agent sessions,
// guides, or launchd: loaded by every command, they were 5 of the 26 ms
// `safari info` took, and 2 MB of each MCP server for its whole session.
const COMMAND_ONLY = /\/daemon\/(repl|repl-host|sessions|agent|guides)\.ts$|\/daemon\/sites\/|\/cli\/launchd\.ts$/;

const REPO = join(import.meta.dir, "..");
const home = await mkdtemp(join(tmpdir(), "safari-startup-"));
// A stand-in daemon that answers every tool call with one page's info.
const daemon = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, value: { url: "https://example.com/", title: "Example Domain" } }) });
afterAll(async () => {
  daemon.stop();
  await rm(home, { recursive: true });
});

// Each process writes the modules it loaded as it exits.
const preload = join(home, "modules.ts");
await Bun.write(preload, 'process.on("exit", () => require("node:fs").writeFileSync(process.env.MODULES_OUT, Object.keys(require.cache).join("\\n")));');
let runs = 0;

function spawn(argv: string[]) {
  const out = join(home, `modules-${++runs}.txt`);
  const proc = Bun.spawn(["bun", "--preload", preload, ...argv], {
    cwd: home,
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    // HOME keeps the repl's files and the host settings in the scratch directory.
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${daemon.port}`, MODULES_OUT: out },
  });
  const modules = async () => (await Bun.file(out).text()).split("\n");
  return { proc, modules };
}

// An MCP session that makes one tool call: its reply's text, and the
// modules the server had loaded when it exited.
async function mcpCall(name: string, args: Record<string, unknown>) {
  const { proc, modules } = spawn([join(REPO, "daemon/mcp.ts")]);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  proc.stdin.flush();
  const lines = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let out = "";
  while (!out.includes("\n")) out += (await lines.read()).value ?? "";
  proc.stdin.end();
  await proc.exited;
  const reply = JSON.parse(out.slice(0, out.indexOf("\n"))) as { result: { content: { text: string }[] } };
  return { text: reply.result.content[0].text, modules: await modules() };
}

test("a tool call from the CLI loads none of the repl's, sessions', guides', or launchd's modules", async () => {
  const { proc, modules } = spawn([join(REPO, "cli/safari.ts"), "info", "--tab", "7"]);
  proc.stdin.end();
  expect(await new Response(proc.stdout).text()).toContain("Example Domain");
  expect(await proc.exited).toBe(0);
  expect((await modules()).filter((m) => COMMAND_ONLY.test(m))).toEqual([]);
});

test("the MCP server loads the repl's modules only when the repl runs", async () => {
  const plain = await mcpCall("info", { tab: 7 });
  expect(plain.text).toContain("Example Domain");
  expect(plain.modules.filter((m) => COMMAND_ONLY.test(m))).toEqual([]);
  expect((await mcpCall("repl", { code: "console.log(6 * 7)" })).text).toBe("42");
});
