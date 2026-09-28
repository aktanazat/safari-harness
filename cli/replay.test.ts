import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// watch.ts runs `safari replay <name> --json`, parses its one line, and
// reads exit 2 with "unknown command: replay" as a safari without replay.
// The daemon here answers replay by the recording's name.
const GOOD = { ok: true, name: "good", steps: 2, value: "42" };
const BAD = { ok: false, name: "bad", steps: 2, failedAt: 1, error: 'step 1 (click): nothing on the page looks like button "Go"', tab: 9 };
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { args }: { args: { name?: string } } = await req.json();
    if (args.name === "good") return Response.json({ ok: true, value: GOOD });
    if (args.name === "bad") return Response.json({ ok: true, value: BAD });
    return Response.json({ ok: false, error: `no recording named ${String(args.name)}; recordings lists them` });
  },
});
afterAll(() => server.stop(true));
const home = mkdtempSync(join(tmpdir(), "replay-cli-"));

async function safari(...argv: string[]) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "safari.ts"), ...argv], {
    env: { ...process.env, HOME: home, SAFARI_HARNESS_HTTP: `http://127.0.0.1:${server.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { lines: out.trimEnd().split("\n"), code };
}

test("replay --json prints one line of JSON and exits 0 only when every step went through", async () => {
  const [good, bad, gone] = await Promise.all([safari("replay", "good", "--json"), safari("replay", "bad", "--json"), safari("replay", "gone", "--json")]);
  expect(good).toEqual({ lines: [JSON.stringify(GOOD)], code: 0 });
  expect(bad).toEqual({ lines: [JSON.stringify(BAD)], code: 1 });
  expect(gone).toEqual({ lines: [JSON.stringify({ ok: false, error: "no recording named gone; recordings lists them" })], code: 1 });
});

test("safari has a replay command, so a watch can play recordings", async () => {
  const help = await safari("replay", "--help");
  expect(help.code).toBe(0);
  expect(help.lines[0]).toStartWith("  safari replay <name>");
});
