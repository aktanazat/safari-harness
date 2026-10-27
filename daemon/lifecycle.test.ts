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

test("helper completion closes only its own window while unrelated task calls leave its admission valid", async () => {
  expect(await fixture("helper-isolation")).toMatchObject({
    separateWindows: true,
    afterHelper: { first: false, firstWindow: true, second: true, main: true, kept: true, personal: true },
    afterMain: { main: false, second: false, kept: true, personal: true },
    receipt: { closed: 1, retained: 0, failed: 0 },
  });
});

test.each(["helper-stale", "helper-foreign"])("%s cannot release a helper's pages with an invalid admission", async mode => {
  expect(await fixture(mode)).toMatchObject({ afterHelper: { first: true, second: true, main: true }, receipt: { invalidated: true, closed: 0 } });
});

test.each(["helper-busy", "helper-shared-read", "helper-shared-front"])("%s finishes its page's pending work before releasing it", async mode => {
  expect(await fixture(mode)).toMatchObject({ whileBusy: { reported: false, first: true, second: true }, first: false, second: true, main: true, receipt: { closed: 1, retained: 0 } });
});

test("helper completion does not wait for a busy sibling on a different page", async () => {
  expect(await fixture("helper-sibling-busy")).toMatchObject({ whileBusy: { reported: true, first: false, second: true }, first: false, second: true, main: true, receipt: { closed: 1, retained: 0 } });
});

test("a helper's deferred completion survives restart and a sibling's next call", async () => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  expect(await fixture("helper-seed", directory)).toEqual({ deferred: true, retained: 1 });
  expect(await fixture("helper-restart", directory)).toEqual({ first: false, firstWindow: true, second: true, main: true, kept: true, personal: true });
});

test("a returned background handoff cannot block helper completion and stays protected until the user finishes", async () => {
  expect(await fixture("helper-background-handoff")).toMatchObject({
    pending: { handoff: true, result: false, second: true, main: true, kept: true, personal: true },
    afterUser: false,
    receipt: { closed: 1, retained: 1, failed: 0 },
  });
});

test("same-address sibling pages retain their task after a browser restart reverses tab ids without aliases", async () => {
  expect(await fixture("helper-reversed-restore")).toMatchObject({
    first: false, second: true, main: true, kept: true, personal: true,
    receipt: { closed: 1, retained: 0, failed: 0 },
  });
});

test("completion stays pending until owned pages close and leaves a kept page open", async () => {
  expect(await fixture("completion")).toMatchObject({ reportedWhileBusy: false, remaining: false, kept: true, receipt: { closed: 1, retained: 0, failed: 0 } });
});

test.each(["inflight", "nested-run", "late-open"])("completion waits for %s work before closing its disposable pages", async (mode) => {
  expect(await fixture(mode)).toMatchObject({ retainedWhileBusy: true, reportedWhileBusy: false, remaining: false, residentPages: 0, kept: true });
});

test("a refused automatic close remains tracked and closes on the next completion attempt", async () => {
  expect(await fixture("refusal")).toMatchObject({ receipt: { closed: 0, retained: 1, failed: 1 }, retry: { closed: 1, retained: 0, failed: 0 }, remaining: false });
});

test.each([
  ["deferred-restart", false],
  ["deferred-resume", true],
  ["deferred-same-restart", false],
  ["deferred-same-resume", true],
] as const)("%s preserves completion across restart until new work invalidates it", async (mode, resumed) => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  expect(await fixture("deferred-seed", directory)).toEqual({ deferred: true, retained: 5 });
  expect(await fixture(mode, directory)).toEqual({ disposable: [resumed, resumed, resumed, resumed], kept: true, handoff: true, personal: true, completedWindow: resumed });
});

test("a trusted browser remap allows completed pages with nonrecoverable addresses to close", async () => {
  expect(await fixture("remap-completed")).toEqual({ disposable: false, kept: true });
});

test("cancellation closes its disposable pages even when a field is filled in", async () => {
  expect(await fixture("cancel")).toEqual({ plain: false, form: false });
});

test("an automatic script-session close preserves a form in progress", async () => {
  expect(await fixture("session")).toEqual({ retainedForm: true });
});

test("a fresh daemon opens a closed result once for concurrent reads without reviving other completed pages", async () => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  expect(await fixture("seed", directory)).toMatchObject({ savedText: false, savedCredential: false });
  expect(await fixture("restart", directory)).toMatchObject({ opened: 1, results: [{ text: "fixture result" }, { text: "fixture result" }], protected: [false, false, false], savedText: false, savedCredential: false });
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

test.each([
  ["live-restart", { plain: true, form: true, front: true, recent: true }],
  ["live-restart-idle", { plain: false, form: true, front: true, recent: true }],
  ["live-restart-completed", { plain: false, form: false, front: false, recent: false }],
] as const)("%s preserves a living owner's pages until idle cleanup or explicit completion admits their close", async (mode, expected) => {
  const directory = mkdtempSync(join(import.meta.dir, "../.build/lifecycle-test-")); directories.push(directory);
  expect(await fixture("live-seed", directory)).toEqual({ seeded: true });
  expect(await fixture(mode, directory)).toEqual({ ...expected, kept: true, handoff: true, personal: true, marker: true });
});

test("unused changed pages close after twenty minutes without closing forms, kept pages, the front page, or recently used pages", async () => {
  expect(await fixture("idle-cleanup")).toEqual({ plain: false, form: true, kept: true, front: true, recent: true });
});

test("an exited task immediately closes its changed pages, filled fields, and front page while preserving a kept page", async () => {
  expect(await fixture("exit-cleanup")).toEqual({ plain: false, form: false, kept: true, front: false, recent: false });
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

test("five-minute recovery opens a single user page without reviving the ended task or exposing secret addresses", async () => {
  expect(await fixture("recover")).toEqual({
    listed: true,
    unsafeListed: false,
    samePage: true,
    reopened: "https://fixture.example/recover",
    userPageRemains: true,
    userPageOwned: false,
    listedAfterReopen: false,
    ownerAccessRefused: true,
  });
});

test("recovery expires at five minutes and removes its durable address", async () => {
  expect(await fixture("recovery-expiry")).toEqual({ beforeExpiry: true, afterExpiry: false, refused: true, persisted: false });
});

test("recovery removes its durable records automatically after the last task window closes", async () => {
  expect(await fixture("recovery-timer")).toEqual({ expiredAutomatically: true, residentPages: 0 });
});

test("recovery records redact verification codes and known secrets from titles before saving", async () => {
  expect(await fixture("recovery-title")).toEqual({ savedCode: false, savedKnownSecret: false, listedCode: false, listedKnownSecret: false });
});

test.each(["recovery-user-first", "recovery-agent-first"])("%s lets only the first claimant reopen the page", async mode => {
  expect(await fixture(mode)).toEqual({ pagesOpened: 1, firstSucceeded: true, secondSucceeded: false });
});
