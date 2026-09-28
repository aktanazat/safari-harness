import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as phone from "./phone.ts";
import { saveRecording } from "./recordings.ts";
import { replay } from "./replay.ts";

// Recordings are saved as the daemon saves them, into a folder of the
// test's own; the page is a set of tool answers, and every call is kept.
// The clock's sleeps pass at once, so a target that never shows costs no
// wait.

afterEach(() => mock.restore());

type Fp = { role: string; name: string; tag: string; near: string; path: string; index: number; count: number };
const fp = (role: string, name: string): Fp => ({ role, name, tag: role === "textbox" ? "input" : role === "link" ? "a" : "button", near: "", path: "", index: 0, count: 1 });
const candidate = (ref: number, f: Fp) => ({ ref, role: f.role, name: f.name, tag: f.tag, near: f.near, path: f.path });

function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

function page(answers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    const answer = answers[tool];
    if (!answer) throw new Error(`the test page has no ${tool}`);
    return answer(args);
  };
  return { calls, call, tools: () => calls.map(([tool]) => tool) };
}

// The fingerprint a lookalikes call looks for.
const wanted = (a: Record<string, unknown>) => a.target as Fp;

function recorded(steps: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), "replay-"));
  spyOn(phone, "dataFile").mockImplementation((name) => join(home, name));
  return saveRecording({ url: "https://shop.example/", title: "Shop", startedAt: Date.now(), steps });
}

const SEARCH = fp("textbox", "Search");
const GO = fp("button", "Go");
const searchField = { type: "search", autocomplete: "off", name: "q", id: "", label: "Search" };

test("a replay finds each step's target, types a var over the recorded text, reads the last value, and closes the tab it opened", async () => {
  const name = recorded([
    { kind: "type", url: "https://shop.example/", target: SEARCH, field: searchField, value: "socks" },
    { kind: "click", url: "https://shop.example/", target: GO },
    { kind: "navigate", url: "https://shop.example/find?q=socks", from: "step" },
    { kind: "read", url: "https://shop.example/find?q=socks", target: fp("paragraph", "3 results"), selector: "#count" },
  ]);
  const p = page({
    open: () => ({ id: 7, url: "https://shop.example/", title: "Shop" }),
    lookalikes: (a) => [candidate(wanted(a).name === "Search" ? 11 : 12, wanted(a))],
    type: () => ({ ok: true, kept: true, typed: "5 chars" }),
    click: () => ({ ok: true, navigated: { url: "https://shop.example/find?q=shoes", title: "Results" } }),
    wait: () => ({ ok: true, found: true, waitedMs: 3 }),
    element: () => "  12\n results ",
    close: () => ({ ok: true }),
  });
  expect(await replay({ name, vars: { q: "shoes" } }, p.call, clock())).toEqual({ ok: true, name, steps: 4, value: "12 results" });
  expect(p.calls).toEqual([
    ["open", { url: "https://shop.example/", background: true }],
    ["lookalikes", { tab: 7, target: SEARCH }],
    ["type", { tab: 7, ref: 11, text: "shoes" }],
    ["lookalikes", { tab: 7, target: GO }],
    ["click", { tab: 7, ref: 12 }],
    ["wait", { tab: 7, selector: "#count", ms: 10_000 }],
    ["element", { tab: 7, ref: "#count", what: "innerText" }],
    ["close", { tab: 7 }],
  ]);
});

// A guess among lookalikes deletes the wrong row: the step fails instead.
test("a target the matcher cannot tell from its lookalikes fails its step with what it looked for, clicks nothing, and leaves the tab open", async () => {
  const name = recorded([
    { kind: "click", url: "https://shop.example/", target: fp("link", "Cart") },
    { kind: "click", url: "https://shop.example/cart", target: fp("button", "Delete") },
  ]);
  const p = page({
    open: () => ({ id: 7 }),
    lookalikes: (a) => (wanted(a).name === "Cart" ? [candidate(3, wanted(a))] : [candidate(21, wanted(a)), candidate(22, wanted(a))]),
    click: () => ({ ok: true, effect: { added: 4 } }),
    snapshot: () => ({ url: "https://shop.example/cart", title: "Cart", nodes: 1, snapshot: "" }),
  });
  expect(await replay({ name }, p.call, clock())).toEqual({
    ok: false, name, steps: 2, failedAt: 2,
    error: 'step 2 (click): 2 elements on the page look like button "Delete", and none is clearly the one recorded',
    tab: 7, url: "https://shop.example/cart", title: "Cart",
  });
  expect(p.calls.filter(([tool]) => tool === "click")).toEqual([["click", { tab: 7, ref: 3 }]]);
  expect(p.tools()).not.toContain("close");
});

test("a target that never shows, after the page ignored the step before, fails naming both steps", async () => {
  const name = recorded([
    { kind: "click", url: "https://shop.example/", target: fp("button", "More") },
    { kind: "click", url: "https://shop.example/", target: fp("link", "Next") },
  ]);
  const p = page({
    open: () => ({ id: 7 }),
    lookalikes: (a) => (wanted(a).name === "More" ? [candidate(5, wanted(a))] : []),
    click: () => ({ ok: true, effect: "none", next: "the page did not react" }),
    snapshot: () => ({ url: "https://shop.example/", title: "Shop", nodes: 1, snapshot: "" }),
  });
  expect(await replay({ name }, p.call, clock())).toMatchObject({
    ok: false, failedAt: 2,
    error: 'step 2 (click): nothing on the page looks like link "Next" (the page did not react to step 1)',
  });
});

// The password was never recorded (recordings.ts): Apple Passwords fills
// it, and a locked one stops the replay at that step, never around it.
test("a password step fills the chosen login from Apple Passwords, and a locked vault fails that step", async () => {
  const name = recorded([
    { kind: "type", url: "https://shop.example/", target: fp("textbox", "Email"), field: { type: "email", autocomplete: "username", name: "email", id: "", label: "Email" }, value: "me@example.com" },
    { kind: "type", url: "https://shop.example/", target: fp("textbox", "Password"), field: { type: "password", autocomplete: "", name: "pw", id: "", label: "Password" }, value: "hunter2" },
  ]);
  const p = page({
    open: () => ({ id: 7 }),
    lookalikes: (a) => [candidate(4, wanted(a))],
    type: () => ({ ok: true, kept: true }),
    passwords: () => { throw new Error("Apple Passwords is locked: the pairing ended. Pair now: call passwords {do: \"pair\"} with the tab."); },
    snapshot: () => ({ url: "https://shop.example/", title: "Sign in", nodes: 1, snapshot: "" }),
  });
  expect(await replay({ name, vars: { username: "me@example.com" } }, p.call, clock())).toMatchObject({
    ok: false, failedAt: 2, tab: 7,
    error: 'step 2 (type): Apple Passwords is locked: the pairing ended. Pair now: call passwords {do: "pair"} with the tab.',
  });
  expect(p.calls.filter(([tool]) => tool === "type" || tool === "passwords")).toEqual([
    ["type", { tab: 7, ref: 4, text: "me@example.com" }],
    ["passwords", { do: "fill", tab: 7, username: "me@example.com" }],
  ]);
});

test("a bot check on the first page is left open for the user to clear", async () => {
  const name = recorded([{ kind: "click", url: "https://shop.example/", target: GO }]);
  const p = page({ open: () => ({ id: 7, challenge: { kind: "cloudflare", where: "page" } }) });
  expect(await replay({ name }, p.call, clock())).toEqual({
    ok: false, name, steps: 1, failedAt: 0,
    error: "the first page: the page shows a bot check (cloudflare); hand tab 7 to the user with handoff, then replay again with tab: 7",
    tab: 7, challenge: { kind: "cloudflare", where: "page" },
  });
  expect(p.tools()).toEqual(["open"]);
});

test("vars that name no field of the recording are refused before anything opens", async () => {
  const name = recorded([{ kind: "type", url: "https://shop.example/", target: SEARCH, field: searchField, value: "socks" }]);
  const p = page({});
  await expect(replay({ name, vars: { query: "shoes" } }, p.call, clock())).rejects.toThrow("no field in this recording is named query; its fields: username, q, Search");
  expect(p.calls).toEqual([]);
});
