import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool } from "./tools.ts";

// A stand-in extension for tab 1: its request log, each entry with the
// 300-character start of its body, and the bodies each frame's page keeps,
// found by url and time the way dialogs.js finds them.
const CASE = `{"case":"${"c".repeat(4000)}"}`;
const OLD_CASE = `{"case":"old"}`;
const FRAMED = "framed ".repeat(1000);
const start = (text: string) => `${text.slice(0, 300)}…`;
const LOG = [
  { kind: "fetch", method: "POST", url: "https://portal.example/case", status: 200, t: 10, body: OLD_CASE },
  { kind: "fetch", method: "GET", url: "https://widget.example/feed", status: 200, t: 20, frame: 3, body: start(FRAMED) },
  { kind: "fetch", method: "GET", url: "https://portal.example/export", status: 200, t: 25, body: start(CASE) },
  { kind: "fetch", method: "GET", url: "https://portal.example/events", status: 200, t: 27, body: start(CASE) },
  { kind: "fetch", method: "POST", url: "https://portal.example/case", status: 200, t: 30, body: start(CASE) },
];
const KEPT: Record<string, { text: string; truncated: boolean; arriving: boolean }> = {
  "0 https://portal.example/case 10": { text: OLD_CASE, truncated: false, arriving: false },
  "3 https://widget.example/feed 20": { text: FRAMED, truncated: false, arriving: false },
  "0 https://portal.example/export 25": { text: CASE.slice(0, 900), truncated: true, arriving: false },
  "0 https://portal.example/events 27": { text: CASE.slice(0, 900), truncated: false, arriving: true },
  "0 https://portal.example/case 30": { text: CASE, truncated: false, arriving: false },
};
function answer(op: string, args: unknown[]): { value?: unknown; error?: string } {
  const [tab, dom, [key], , frame] = args as [number, string, [{ url: string; t: number }], number, number];
  if (op !== "relay" || tab !== 1) return { value: [] };
  if (dom === "netRead") return { value: { entries: LOG } };
  const kept = KEPT[`${frame} ${key.url} ${key.t}`];
  return kept ? { value: kept } : { error: "that request's body is not kept" };
}
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    bridge.handleMessage(JSON.stringify({ id, ...answer(op, args) }));
  },
  close() {},
});

test("a body named by part of its url comes back whole, from the latest request with that url", async () => {
  const got = await callTool("net", { tab: 1, body: "portal.example/case" });
  expect(got).toMatchObject({ url: "https://portal.example/case", t: 30, text: CASE });
  expect(got).not.toHaveProperty("note");
});

test("a body named by its place in the list comes back whole, counting from the end below 0, from the frame that made it", async () => {
  expect(await callTool("net", { tab: 1, body: 0 })).toMatchObject({ t: 10, text: OLD_CASE });
  expect(await callTool("net", { tab: 1, body: "-4" })).toMatchObject({ url: "https://widget.example/feed", frame: 3, text: FRAMED });
});

test("a body cut at the cap comes back with a note giving where it was cut", async () => {
  expect(await callTool("net", { tab: 1, body: "export" })).toMatchObject({ text: CASE.slice(0, 900), note: expect.stringContaining("900") });
});

test("a body still arriving comes back with a note", async () => {
  expect(await callTool("net", { tab: 1, body: "events" })).toMatchObject({ text: CASE.slice(0, 900), note: expect.any(String) });
});

test("a body the list has no request for is an error naming what was asked", async () => {
  await expect(callTool("net", { tab: 1, body: 5 })).rejects.toThrow(/\b5\b/);
  await expect(callTool("net", { tab: 1, body: "nowhere.example" })).rejects.toThrow(/nowhere\.example/);
});

// On 10-04 an agent piped the list through python twelve times to find one
// API's requests.
test("a list read for part of a url holds only those requests, each with the index body takes", async () => {
  const { entries } = (await callTool("net", { tab: 1, url: "portal.example/case" })) as { entries: { index: number; t: number }[] };
  expect(entries.map((e) => e.t)).toEqual([10, 30]);
  for (const e of entries) expect(await callTool("net", { tab: 1, body: e.index })).toMatchObject({ t: e.t });
});
