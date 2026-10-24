import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trimLog } from "./journal.ts";

const dir = mkdtempSync("/private/var/tmp/safari-journal-");
afterAll(() => rmSync(dir, { recursive: true }));

// In a process of its own: the journal is the daemon's, one per process, and
// this one's would send every other test's events to the file.
test("the journal file stays bounded however often the daemon restarts, and a restart keeps the latest events", async () => {
  const path = join(dir, "journal.jsonl");
  const script = `
    import { note, openJournal } from ${JSON.stringify(join(import.meta.dir, "journal.ts"))};
    for (let start = 0; start < 60; start++) {
      openJournal(${JSON.stringify(path)});
      for (let i = 0; i < 100; i++) note("call", { start, i });
    }
    const earlier = openJournal(${JSON.stringify(path)});
    console.error(JSON.stringify({ loaded: earlier.length, last: earlier.at(-1) }));
  `;
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(readFileSync(path, "utf8").trim().split("\n").length).toBeLessThan(4000);
  expect(JSON.parse(err.trim().split("\n").at(-1) ?? "")).toMatchObject({ loaded: 2000, last: { kind: "call", start: 59, i: 99 } });
});

// launchd's log of the daemon only grew, about 600 lines a day on 10-21,
// and launchd holds it open for appending: it is cut in place.
test("a log past its limit keeps its last lines, in the file launchd appends to", () => {
  const path = join(dir, "daemon.log");
  writeFileSync(path, Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join(""));
  const file = statSync(path).ino;
  trimLog(path, 10);
  expect(readFileSync(path, "utf8")).toBe(Array.from({ length: 10 }, (_, i) => `line ${i + 2}\n`).join(""));
  expect(statSync(path).ino).toBe(file);
});

