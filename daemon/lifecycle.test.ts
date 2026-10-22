// Lifecycle receipts and fresh-process resume, through the shipped tool API.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const directories: string[] = [];
mkdirSync(join(import.meta.dir, "../.build"), { recursive: true });
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function fixture(mode: string, directory?: string): Promise<Record<string, unknown>> {
  if (!directory) {
    directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-"));
    directories.push(directory);
  }
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "lifecycle.fixture.ts"), directory, mode, String(process.pid)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4000 });
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`lifecycle ${mode} exited ${exit}: ${stderr}\n${stdout}`);
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

test("completion stays pending until owned pages close and leaves a kept page open", async () => {
  expect(await fixture("completion")).toMatchObject({ reportedWhileBusy: false, remaining: false, kept: true, receipt: { closed: 1, retained: 0, failed: 0 } });
});

test.each(["inflight", "nested-run", "late-open"])("completion waits for %s work before closing its disposable pages", async (mode) => {
  expect(await fixture(mode)).toMatchObject({ retainedWhileBusy: true, reportedWhileBusy: false, remaining: false, residentPages: 0, kept: true });
});

test("a refused automatic close remains tracked and closes on the next completion attempt", async () => {
  expect(await fixture("refusal")).toMatchObject({ receipt: { closed: 0, retained: 1, failed: 1 }, retry: { closed: 1, retained: 0, failed: 0 }, remaining: false });
});

test("cancellation closes disposable pages but preserves a form in progress", async () => {
  expect(await fixture("cancel")).toEqual({ plain: false, form: true });
});

test("an automatic script-session close preserves a form in progress", async () => {
  expect(await fixture("session")).toEqual({ retainedForm: true });
});

test("a fresh daemon opens a closed result once for concurrent reads and preserves protected pages", async () => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  expect(await fixture("seed", directory)).toMatchObject({ savedText: false, savedCredential: false });
  expect(await fixture("restart", directory)).toMatchObject({ opened: 1, results: [{ text: "fixture result" }, { text: "fixture result" }], protected: [true, true, true], savedText: false, savedCredential: false });
});

test("an action on a resumed page asks for a fresh look without submitting anything", async () => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  await fixture("seed", directory);
  expect(await fixture("action", directory)).toMatchObject({ opened: 1, clicks: 0, error: expect.stringContaining("snapshot it, then act") });
});

test("a foreign owner cannot lazily reopen another owner's closed result", async () => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  await fixture("seed", directory);
  expect(await fixture("foreign", directory)).toMatchObject({ opened: 0, error: expect.stringContaining("open it again") });
});

test("unused changed pages close after twenty minutes without closing forms, kept pages, the front page, or recently used pages", async () => {
  expect(await fixture("idle-cleanup")).toEqual({ plain: false, form: true, kept: true, front: true, recent: true });
});

test("an exited task releases its changed pages while preserving forms, kept pages, and the front page", async () => {
  expect(await fixture("exit-cleanup")).toEqual({ plain: false, form: true, kept: true, front: true, recent: false });
});

test.each(["cap", "stopped"])("%s is not authority to close another unfinished task's pages", async mode => {
  expect(await fixture(mode)).toEqual({ retained: true, residentPages: mode === "cap" ? 9 : 1 });
});

test("a script action on a lazily reopened result never runs before a fresh look", async () => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  await fixture("seed", directory);
  expect(await fixture("fresh-eval", directory)).toMatchObject({ opened: 1, evaluations: 0, error: expect.stringContaining("snapshot it, then act") });
});

test("a state-changing request on a reopened result is never replayed", async () => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  await fixture("seed", directory);
  expect(await fixture("fresh-post", directory)).toMatchObject({ opened: 1, submissions: 0, error: expect.stringContaining("snapshot it, then act") });
});

test("preparing cleanup drains active work without physically closing anything", async () => {
  expect(await fixture("prepare-busy")).toMatchObject({ before: { prepared: false, retained: true }, retainedAfterPrepare: true, remaining: false, receipt: { closed: 1 } });
});

test("a current exact-resource preparation closes only after release is admitted", async () => {
  expect(await fixture("prepared")).toMatchObject({ retainedAfterPrepare: true, remaining: false, receipt: { closed: 1 } });
});

test.each(["stale-prepare", "foreign-prepare"])("%s cannot release resources after its preparation loses authority", async mode => {
  expect(await fixture(mode)).toMatchObject({ remaining: true, receipt: { invalidated: true, closed: 0 } });
});
