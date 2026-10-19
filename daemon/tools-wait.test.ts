import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool } from "./tools.ts";

// A page that went quiet showing nothing: its quiet wait is met at once,
// and the check of what it shows says nothing drew. Its console holds the
// entries given.
function blankPage(entries: { level: string; text: string; t: number; uncaught?: true }[]) {
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      const answers: Record<string, unknown> = { wait: { found: true }, eval: { result: false }, consoleRead: { entries } };
      const value = op === "relay" ? (answers[String(args[1])] ?? { ok: true }) : [];
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  });
}

// On 10-09 an agent waited 25 s on a page whose script had thrown, then
// read an empty console (S99PartB); a blank snapshot names those errors,
// and so does a wait that ends on such a page.
test("a quiet wait that ends on a blank page that hit errors is a miss naming the latest 3", async () => {
  blankPage([
    { level: "error", text: "TypeError: undefined is not an object (evaluating 'a.b')", t: 1, uncaught: true },
    { level: "log", text: "booting", t: 2 },
    { level: "error", text: "failed to load https://cdn.example/app.js", t: 3, uncaught: true },
    { level: "error", text: "ReferenceError: Can't find variable: config", t: 4, uncaught: true },
    { level: "error", text: "Unhandled Promise Rejection: Error: 401", t: 5, uncaught: true },
  ]);
  expect(await callTool("wait", { tab: 7, quiet: true, ms: 100 })).toMatchObject({
    ok: false,
    found: false,
    empty: true,
    hint: "the page went quiet but shows nothing, and it hit 4 errors, the latest: failed to load https://cdn.example/app.js; ReferenceError: Can't find variable: config; Unhandled Promise Rejection: Error: 401. Waiting for its text may not help: read them with console (do: read), or reload it (history, do: reload)",
  });
});

test("a quiet wait that ends on a blank page with no errors says it shows nothing yet", async () => {
  blankPage([{ level: "log", text: "booting", t: 2 }]);
  expect(await callTool("wait", { tab: 7, quiet: true, ms: 100 })).toMatchObject({
    ok: false,
    found: false,
    empty: true,
    hint: "the page went quiet but shows nothing yet: no text, picture, or frame; wait on words it should show",
  });
});

// On 10-16, with Safari taking 4 to 13 s a call after a deploy, a wait for
// "Example Domain" on example.com, which showed it all along, answered
// after 11 s that the page never showed those words.
test("a text wait the page gives no answer by its end says it cannot tell, never that the words did not show", async () => {
  const waits: string[] = [];
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      if (op === "relay" && args[1] === "wait") return void waits.push(id);
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value: op === "relay" ? { ok: true } : [] })));
    },
    close() {},
  });
  const got = await callTool("wait", { tab: 7, text: "Example Domain", ms: 100 });
  expect(got).toMatchObject({ ok: false, found: false, unanswered: true, hint: expect.stringContaining("says nothing of what it shows") });
  expect(JSON.stringify(got)).not.toMatch(/never showed/);
  for (const id of waits) bridge.handleMessage(JSON.stringify({ id, value: { found: true } }));
});

// A page that gives a wait no answer would hold the read after it too.
test("a wait the page gave no answer leaves out the page its snapshot asked for", async () => {
  const waits: string[] = [];
  const reads: string[] = [];
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      if (op === "relay" && args[1] === "wait") return void waits.push(id);
      if (op === "relay" && args[1] === "snapshot") reads.push(id);
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value: op === "relay" ? { ok: true } : [] })));
    },
    close() {},
  });
  const got = await callTool("wait", { tab: 7, text: "Example Domain", ms: 100, snapshot: true });
  expect(got).toMatchObject({ ok: false, found: false, unanswered: true });
  expect(reads).toEqual([]);
  for (const id of waits) bridge.handleMessage(JSON.stringify({ id, value: { found: true } }));
});

// A page that answers its wait once the daemon stops it, at the limit, with
// stopped, as a page does with what changed meanwhile. Each tabs.list is
// kept unanswered in lists when listing is false.
function answersWhenStopped(stopped: unknown, listing = true) {
  const lists: string[] = [];
  let wait: string | undefined;
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      if (op === "tabs.list" && !listing) return void lists.push(id);
      if (op === "relay" && args[1] === "wait") return void (wait = id);
      queueMicrotask(() => {
        if (op === "relay" && args[1] === "waitStop") bridge.handleMessage(JSON.stringify({ id: wait, value: stopped }));
        bridge.handleMessage(JSON.stringify({ id, value: op === "relay" ? { ok: true } : [] }));
      });
    },
    close() {},
  });
  return lists;
}

// On 10-16 a 3 s wait failed "extension request tabs.list timed out after
// 5000ms" as it read where the tab was, on a Mac too loaded to list them.
test("a missed wait answers by its ms and a second more while Safari lists no tabs, leaving out the address", async () => {
  const lists = answersWhenStopped({ found: false, meanwhile: ["new: Loading"] }, false);
  const start = Date.now();
  const got = await callTool("wait", { tab: 7, text: "zzz", ms: 100 });
  // tabs.list's own limit is 5 s (LIST_MS in bridge.ts)
  expect(Date.now() - start).toBeLessThan(5000);
  expect(lists).toHaveLength(1);
  expect(got).toMatchObject({ ok: false, found: false, meanwhile: ["new: Loading"], hint: expect.stringContaining("never showed those words") });
  expect(JSON.stringify(got)).not.toContain('"url"');
  for (const id of lists) bridge.handleMessage(JSON.stringify({ id, value: [] }));
});

// A page that saw the words as it was stopped answers found after the
// limit: they are on the page all the same.
test("a wait the page answers found in the second after its limit is found", async () => {
  answersWhenStopped({ found: true });
  expect(await callTool("wait", { tab: 7, text: "Example Domain", ms: 100 })).toMatchObject({ ok: true, found: true });
});

// On 10-16 wait --tab front listed Safari's tabs before its time began, and
// a list Safari was slow to give held a 3 s wait 5 s more (smoke run after
// the deploy).
test("a wait on the front tab counts finding it in its ms, and says the page gave no answer while Safari lists no tabs", async () => {
  const lists = answersWhenStopped({ found: true }, false);
  const start = Date.now();
  const got = await callTool("wait", { tab: "front", text: "Example Domain", ms: 100 });
  // tabs.list's own limit is 5 s (LIST_MS in bridge.ts)
  expect(Date.now() - start).toBeLessThan(1000);
  expect(got).toMatchObject({ ok: false, found: false, unanswered: true, hint: expect.stringContaining("says nothing of what it shows") });
  for (const id of lists) bridge.handleMessage(JSON.stringify({ id, value: [] }));
}, 10_000);
