import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchDownloads } from "./downloads.ts";

const base = mkdtempSync("/private/var/tmp/safari-downloads-");
afterAll(() => rmSync(base, { recursive: true }));

let dirs = 0;
function folder(): string {
  const dir = join(base, String(++dirs));
  mkdirSync(dir);
  return dir;
}

// Time that passes only when the watcher sleeps; each sleep may change the
// folder the way Safari would meanwhile.
function clock(onSleep: (now: number) => void = () => {}) {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; onSleep(now); } };
}

test("only files new since the action began are reported, never the user's earlier or unfinished ones", async () => {
  const dir = folder();
  writeFileSync(join(dir, "old.pdf"), "old");
  mkdirSync(join(dir, "his.zip.download"));
  const done = await watchDownloads(dir, clock());
  // during the action: a download of its own, the Finder's hidden file, an
  // older file rewritten, and the user's own download finishing
  writeFileSync(join(dir, "statement.pdf"), "12345");
  writeFileSync(join(dir, ".DS_Store"), "x");
  writeFileSync(join(dir, "old.pdf"), "rewritten");
  rmSync(join(dir, "his.zip.download"), { recursive: true });
  writeFileSync(join(dir, "his.zip"), "his");
  expect(await done()).toEqual({ downloaded: [{ path: join(dir, "statement.pdf"), bytes: 5 }] });
});

test("a download still under way when the action ends is waited for until Safari finishes it", async () => {
  const dir = folder();
  const time = clock((now) => {
    if (now < 1000) return;
    rmSync(join(dir, "report.csv.download"), { recursive: true, force: true });
    writeFileSync(join(dir, "report.csv"), "a,b\n1,2\n");
  });
  const done = await watchDownloads(dir, time);
  mkdirSync(join(dir, "report.csv.download"));
  writeFileSync(join(dir, "report.csv.download", "report.csv"), "a,b");
  expect(await done()).toEqual({ downloaded: [{ path: join(dir, "report.csv"), bytes: 8 }] });
  expect(time.now()).toBeLessThan(30_000);
});

test("a download not finished after 30 s is reported by the path it will have", async () => {
  const dir = folder();
  const time = clock();
  const done = await watchDownloads(dir, time);
  mkdirSync(join(dir, "big.iso.download"));
  expect(await done()).toEqual({ downloading: [join(dir, "big.iso")] });
  expect(time.now()).toBeGreaterThanOrEqual(30_000);
  expect(time.now()).toBeLessThan(31_000);
});
