import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// safari eval hands the daemon the code and where to save its answer. The
// daemon here records what each call asked for.
const calls: { tool: string; args: Record<string, unknown> }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { tool, args }: { tool: string; args: Record<string, unknown> } = await req.json();
    calls.push({ tool, args });
    return Response.json({ ok: true, value: { result: 2 } });
  },
});
afterAll(() => server.stop(true));
const home = mkdtempSync(join(tmpdir(), "eval-cli-"));

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

// On 09-28 an agent's `--save /private/var/tmp/cw-rows.json` went into its
// code, which then failed with "Unexpected keyword 'const'".
test("a path after --save names the file and stays out of the code", async () => {
  calls.length = 0;
  expect(await safari(["eval", "const a = 1; a + 1", "--tab", "7", "--page", "--save", "/private/var/tmp/rows.json"])).toEqual({ err: "", code: 0 });
  expect(await safari(["eval", "document.title", "--save", "--tab", "7"])).toEqual({ err: "", code: 0 });
  expect(calls).toEqual([
    { tool: "eval", args: { tab: 7, save: "/private/var/tmp/rows.json", expression: "const a = 1; a + 1", page: true } },
    { tool: "eval", args: { tab: 7, save: true, expression: "document.title", page: false } },
  ]);
});

test("a script comes from --file or stdin as written, quotes and lines and all", async () => {
  const script = `const s = "it's";\nconst t = \`a "b"\`;\n[s, t]\n`;
  const file = join(home, "script.js");
  writeFileSync(file, script);
  calls.length = 0;
  expect(await safari(["eval", "--file", file, "--tab", "7"])).toEqual({ err: "", code: 0 });
  expect(await safari(["eval", "--tab", "7", "--page"], script)).toEqual({ err: "", code: 0 });
  expect(calls.map((c) => c.args.expression)).toEqual([script, script]);
});
