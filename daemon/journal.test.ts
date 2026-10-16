import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { note, recent } from "./journal.ts";

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

test("a run of alike events keeps its count across a restart", async () => {
  const path = join(dir, "alike.jsonl");
  const script = `
    import { note, openJournal } from ${JSON.stringify(join(import.meta.dir, "journal.ts"))};
    openJournal(${JSON.stringify(path)});
    for (let i = 0; i < 3; i++) note("timeout", { op: "tabs.list", ms: 5000 });
    console.error(JSON.stringify(openJournal(${JSON.stringify(path)}).at(-1)));
  `;
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(err.trim().split("\n").at(-1) ?? "")).toMatchObject({ kind: "timeout", op: "tabs.list", n: 3 });
});

// A storm notes about one event a second, nearly all one timeout again and
// again, and /health showed only the latest 20 (DaemonLogs).
test("events alike in a row are kept as one, counted, with when the first came", () => {
  note("test", { name: "alike events" });
  note("timeout", { op: "tabs.list", ms: 5000 });
  const first = recent(1)[0];
  note("timeout", { op: "tabs.list", ms: 5000 });
  note("timeout", { op: "tabs.list", ms: 5000 });
  note("timeout", { op: "tabs.close", ms: 5000 });
  expect(recent(3)).toEqual([
    { t: expect.any(String), kind: "test", name: "alike events" },
    { t: expect.any(String), kind: "timeout", op: "tabs.list", ms: 5000, n: 3, since: first.t },
    { t: expect.any(String), kind: "timeout", op: "tabs.close", ms: 5000 },
  ]);
});
