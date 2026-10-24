import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
