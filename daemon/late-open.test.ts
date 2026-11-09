import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const directories: string[] = [];
mkdirSync(join(import.meta.dir, "../.build"), { recursive: true });
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function fixture(mode: string): Promise<Record<string, unknown>> {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/late-open-test-"));
  directories.push(directory);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "late-open.fixture.ts"), directory, mode, String(process.pid)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4000 });
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`late-open ${mode} exited ${exit}: ${stderr}\n${stdout}`);
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

test.each(["retry", "stale-list"])("a late owned tab stays in cleanup after a failed close, including behind an older listing (%s)", async mode => {
  expect(await fixture(mode)).toMatchObject({
    timeout: expect.stringContaining("extension request tabs.open timed out"),
    beforeRetry: { page: true, saved: { owner: process.pid, task: `late-${mode}`, url: "https://late.example/", done: true } },
    afterRetry: { page: false, tracked: false },
  });
});

test("late cleanup closes its page while a real tab listing remains unanswered", async () => {
  expect(await fixture("blocked-list")).toMatchObject({
    timeout: expect.stringContaining("extension request tabs.open timed out"),
    listing: { requested: true, settled: false },
    afterRetry: { page: false, tracked: false },
  });
});

test("late cleanup preserves its completed owner's page through a failed close and reconnect", async () => {
  expect(await fixture("reconnect")).toMatchObject({
    timeout: expect.stringContaining("extension request tabs.open timed out"),
    beforeRetry: { page: true, saved: { owner: process.pid, task: "late-reconnect", url: "https://late.example/", done: true } },
    afterRetry: { page: false, tracked: false },
  });
});
