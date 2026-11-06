import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureOf } from "./failures.ts";

// The MCP server loads mcp-tools.ts again from each release a deploy puts
// in place (fresh.ts), in the same process. Two imports of it under
// different addresses stand in for two releases. Sessions keep their files
// under HOME, which is a folder of the test's own.
const home = mkdtempSync(join(tmpdir(), "mcp-repl-"));
const before = process.env.HOME;
process.env.HOME = home;
afterAll(() => {
  process.env.HOME = before;
  rmSync(home, { recursive: true, force: true });
});

// On 10-22 the first repl call after a deploy failed "ReferenceError: mp
// is not defined", nothing saying the session had started over.
test("the first answer of a connection's session made after a deploy says the earlier bindings are gone", async () => {
  const old = await import("./mcp-tools.ts?release=old");
  const updated = await import("./mcp-tools.ts?release=new");
  try {
    expect(await old.callTool("repl", { code: "globalThis.mp = 1; mp" })).toBe("1");
    const lost = updated.callTool("repl", { code: "mp" });
    await expect(lost).rejects.toThrow(/^this repl session started fresh at \S+ \(the harness was updated\); earlier bindings are gone; reattach with attachBrowserTab\(id\)\nReferenceError: mp is not defined/);
    expect(await updated.callTool("repl", { code: "globalThis.mp = 2; mp" })).toBe("2");
  } finally {
    await Promise.all([old.closeSession(), updated.closeSession()]);
  }
});

// Script pasted into JSON arguments broke 18 repl calls in the 10-15 to
// 10-28 logs on its quotes and backslashes; a file carries it as written.
test("a repl call given file runs the code in that file, quotes, backslashes and lines as written", async () => {
  // imported here, once HOME is the test's folder, as the test above does
  const { callTool, closeSession } = await import("./mcp-tools.ts?release=file");
  const file = join(home, "script.js");
  writeFileSync(file, 'const s = "it\'s \\"quoted\\"";\nconst re = /\\d+/;\n`${s} ${re.test("a1")}`\n');
  try {
    expect(await callTool("repl", { file })).toEndWith('it\'s "quoted" true');
  } finally {
    await closeSession();
  }
});

// A name the repl tool does not take ran no code and answered "(no
// output)", as if the script had run.
test("a repl call with a parameter the tool does not take fails naming the ones it does", async () => {
  const { callTool } = await import("./mcp-tools.ts?release=names");
  await expect(callTool("repl", { script: "1 + 1" })).rejects.toThrow("unknown parameter script for repl (params: code, file, session)");
});

// On 11-03 x.com's rate limit inside a run came back command_failed,
// effect none (AuditSafariHarness-23). The failure the run met is thrown
// as the harness throws one, with its own code and effect.
test("a repl run that fails on a rate limit answers rate_limited, as the server reports it", async () => {
  const { callTool, closeSession } = await import("./mcp-tools.ts?release=failure");
  try {
    const error = await callTool("repl", { code: `throw Object.assign(new Error("x.com rate-limited this"), { code: "rate_limited", effect: "none", retryable: true, next: "ask that site again after it resets" })` }).catch((e: unknown) => e);
    expect(failureOf(error, { effectful: false })).toMatchObject({ code: "rate_limited", effect: "none", retryable: true });
  } finally {
    await closeSession();
  }
});
