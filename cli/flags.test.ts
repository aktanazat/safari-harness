import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

// On 09-29 `safari learn geico.com --note "..."` saved nothing and said
// nothing: the CLI dropped every flag its tool did not name.
test("a flag the command does not take fails before any call, naming the flags it does take", async () => {
  calls.length = 0;
  expect(await safari(["learn", "geico.com", "--fcat", "The quote asks for the address twice"])).toEqual({
    err: "error: learn takes no --fcat; did you mean --fact? (flags: --site --fact --forget --reader --expression --page; safari learn --help says what each does)",
    code: 2,
  });
  expect(calls).toEqual([]);
});

test("a flag a model's call may use for a parameter is taken as that parameter, with a note", async () => {
  calls.length = 0;
  expect(await safari(["learn", "geico.com", "--note", "The quote asks for the address twice"])).toEqual({ err: "note: used --fact for --note", code: 0 });
  expect(calls).toEqual([{ tool: "learn", args: { site: "geico.com", fact: "The quote asks for the address twice" } }]);
});

// On 09-30 an agent passed each call's JSON as the command's word:
// `safari dialog --tab front '{"do":"read"}'` sent the whole object as do,
// and open, snapshot, and goto failed with errors that hid the cause.
test("a JSON object given as a command's word fails before any call, pointing at safari call", async () => {
  calls.length = 0;
  for (const argv of [["dialog", "--tab", "front", '{"do":"read"}'], ["goto", "--tab", "24299", '{"url":"https://example.com"}'], ["snapshot", '{"tab":24299}']]) {
    const { err, code } = await safari(argv);
    expect(code).toBe(2);
    expect(err).toMatch(new RegExp(`safari call ${argv[0]} '`));
  }
  expect(calls).toEqual([]);
});

test("a JSON object is still a call's arguments", async () => {
  calls.length = 0;
  expect(await safari(["call", "dialog", '{"do":"read","tab":7}'])).toEqual({ err: "", code: 0 });
  expect(calls).toEqual([{ tool: "dialog", args: { do: "read", tab: 7 } }]);
});
