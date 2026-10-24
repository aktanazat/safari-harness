import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A command's flags become its tool's parameters. The daemon here records
// what each call asked for.
const calls: { tool: string; args: Record<string, unknown> }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { tool, args }: { tool: string; args: Record<string, unknown> } = await req.json();
    calls.push({ tool, args });
    return Response.json({ ok: true, value: "done" });
  },
});
afterAll(() => server.stop(true));
const home = mkdtempSync(join(tmpdir(), "flags-cli-"));

async function safari(argv: string[], stdin?: string) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "safari.ts"), ...argv], {
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${server.port}` },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { err: err.trim(), code };
}

// On 10-04 `safari eval --page true "const ..."` sent "true const ..." as
// the code, which failed at its second word.
test("a true or false after a flag that takes no value sets that flag and is not part of the command's words", async () => {
  calls.length = 0;
  expect(await safari(["eval", "--page", "true", "const a = 1; a", "--tab", "7"])).toEqual({ err: "", code: 0 });
  expect(await safari(["eval", "--page", "false", "document.title", "--tab", "7"])).toEqual({ err: "", code: 0 });
  expect(calls.map((c) => c.args)).toEqual([
    { tab: 7, expression: "const a = 1; a", page: true },
    { tab: 7, expression: "document.title", page: false },
  ]);
});

// The page after an action, whole or for some words, comes in its answer
// (PAGE in tools.ts). A word after a bare --snapshot stays the command's.
test("--snapshot reads the page after an action whole, and --snapshot=<words> only its lines that have them", async () => {
  calls.length = 0;
  for (const argv of [["press", "Enter", "--tab", "7", "--snapshot"], ["press", "Enter", "--tab", "7", "--snapshot=Total"], ["wait", "--tab", "7", "--snapshot", "3000"], ["wait", "--tab", "7", "--snapshot=false", "3000"]]) {
    expect(await safari(argv)).toEqual({ err: "", code: 0 });
  }
  expect(calls.map((c) => c.args)).toEqual([
    { tab: 7, key: "Enter", snapshot: true },
    { tab: 7, key: "Enter", snapshot: "Total" },
    { tab: 7, ms: 3000, snapshot: true },
    { tab: 7, ms: 3000 },
  ]);
});

// On 10-07 and 10-08 `safari snapshot --interactive` failed twice: the
// snapshot took no such flag, though the repl's snapshot does.
test("--interactive asks the snapshot for only the lines with refs", async () => {
  calls.length = 0;
  expect(await safari(["snapshot", "--interactive", "--tab", "7"])).toEqual({ err: "", code: 0 });
  expect(calls).toEqual([{ tool: "snapshot", args: { tab: 7, interactive: true } }]);
});

// On 09-29 `safari learn geico.com --note "..."` saved nothing and said
// nothing: the CLI dropped every flag its tool did not name.
test("an unsupported flag is rejected before any call", async () => {
  calls.length = 0;
  const result = await safari(["learn", "geico.com", "--fcat", "The quote asks for the address twice"]);
  expect(result.code).toBe(2);
  expect(result.err).not.toBe("");
  expect(calls).toEqual([]);
});

test("a flag a model's call may use for a parameter is taken as that parameter, with a note", async () => {
  calls.length = 0;
  const result = await safari(["learn", "geico.com", "--note", "The quote asks for the address twice"]);
  expect(result.code).toBe(0);
  expect(result.err).toContain("--fact");
  expect(result.err).toContain("--note");
  expect(calls).toEqual([{ tool: "learn", args: { site: "geico.com", fact: "The quote asks for the address twice" } }]);
});

// On 09-30 an agent passed each call's JSON as the command's word:
// `safari dialog --tab front '{"do":"read"}'` sent the whole object as do,
// and open, snapshot, and goto failed with errors that hid the cause.
test("a JSON object supplied in place of command words is rejected before any call", async () => {
  calls.length = 0;
  for (const argv of [["dialog", "--tab", "front", '{"do":"read"}'], ["goto", "--tab", "24299", '{"url":"https://example.com"}'], ["snapshot", '{"tab":24299}']]) {
    const { err, code } = await safari(argv);
    expect(code).toBe(2);
    expect(err).not.toBe("");
  }
  expect(calls).toEqual([]);
});

test("a JSON object is still a call's arguments", async () => {
  calls.length = 0;
  expect(await safari(["call", "dialog", '{"do":"read","tab":7}'])).toEqual({ err: "", code: 0 });
  expect(calls).toEqual([{ tool: "dialog", args: { do: "read", tab: 7 } }]);
});

// On 10-22 two agents' --steps-file held the MCP call's object, as the run
// guide shows it, and was refused: "run needs steps".
test.each([
  ["a bare array", '[{"tool": "info", "args": {"tab": 7}}]'],
  ["the MCP call's object", '{"steps": [{"tool": "info"}], "tab": 7}'],
])("run --steps-file holding %s runs its steps", async (_shape, json) => {
  calls.length = 0;
  const file = join(home, "steps.json");
  writeFileSync(file, json);
  expect(await safari(["run", "--steps-file", file])).toEqual({ err: "", code: 0 });
  expect(calls.filter((c) => c.tool === "info")).toEqual([{ tool: "info", args: { tab: 7 } }]);
});
