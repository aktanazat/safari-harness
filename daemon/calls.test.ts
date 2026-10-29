import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastDay, logCall, logDrop, openCalls } from "./calls.ts";
import { failureOf, HarnessError } from "./failures.ts";

// safari status prints the last day of this log, which must not keep what
// a call typed or the address of the page it read.
test("the last day counts each call once, its failures by code, and the link's drops by why; a line keeps a page's host, not its address or what a call typed", () => {
  const dir = mkdtempSync(join(tmpdir(), "calls-"));
  const path = join(dir, "calls.jsonl");
  writeFileSync(path, `${JSON.stringify({ t: new Date(Date.now() - 2 * 86_400_000).toISOString(), tool: "click", outcome: "timeout" })}\n`);
  try {
    openCalls(path);
    const t = Date.now();
    logCall({ t, ms: 40, owner: 7, task: JSON.stringify(["session", "agent"]), tool: "type", args: { text: "hunter2", url: "https://bank.example/login?session=abc" }, reply: { ok: true, value: { ok: true } }, bytes: 20 });
    logCall({ t, ms: 30000, owner: 7, task: undefined, tool: "click", args: { ref: "e1" }, reply: { ok: false, failure: failureOf(new HarnessError("timeout", "the page did not answer")) }, bytes: 90 });
    logCall({ t, ms: 12, owner: undefined, task: undefined, tool: "extract", args: {}, reply: { ok: true, value: { error: "that tab is gone" } }, bytes: 50 });
    logDrop({ cause: "too_large", code: 1006, lost: 2 });
    const day = lastDay();
    expect([day.calls, day.failures.timeout, Object.values(day.failures).reduce((a, b) => a + b, 0), day.drops]).toEqual([3, 1, 2, { too_large: 1 }]);
    const log = readFileSync(path, "utf8");
    expect(log).toContain("bank.example");
    expect(log).not.toContain("hunter2");
    expect(log).not.toContain("session=abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
