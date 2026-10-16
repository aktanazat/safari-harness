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
