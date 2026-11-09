import { expect, test } from "bun:test";
import { formatResult } from "./tools.ts";

test("a gathered read says which dialogs its page raised and how each was answered", () => {
  const url = "http://feed.example/";
  const text = formatResult({
    url,
    title: "Feed",
    text: "Item 1",
    harvested: "scrolled 18 times, 150 items, stopped: nothing new",
    dialogs: [
      { type: "alert", message: "Batch three arrived", answer: null, url },
      { type: "confirm", message: "Keep loading?", answer: false, url },
      { type: "prompt", message: "Your name?", answer: "Ann", url },
    ],
  });
  expect(text).toContain('alert "Batch three arrived"');
  expect(text).toContain('confirm "Keep loading?", dismissed');
  expect(text).toContain('prompt "Your name?", answered "Ann"');
});

test("an open prints its tab on one line, without the window's name or a state that judges nothing", () => {
  const opened = {
    id: 577636,
    url: "https://x.com/avec/status/1",
    title: "X",
    windowId: 577173,
    space: { name: "agent 52047", group: "waiting" },
    pageState: { kind: "unjudged", next: "read a whole-page snapshot or extract before judging what is available." },
    note: "loaded in your tab 577636 on x.com, in place of https://x.com/home; new: true opens a second tab",
  };
  expect(formatResult(opened)).toBe('{"id":577636,"url":"https://x.com/avec/status/1","title":"X","windowId":577173}\nnote: loaded in your tab 577636 on x.com, in place of https://x.com/home; new: true opens a second tab');
});

test("an open keeps a state the agent acts on, an error page's warning, and why its window stays plain", () => {
  const opened = {
    id: 9,
    url: "https://www.ebay.com/sch",
    title: "Error Page | eBay",
    ok: false,
    warning: "www.ebay.com answered with its error page",
    loading: true,
    challenge: { where: "page", kind: "cloudflare" },
    space: { name: "agent 1", group: "plain", why: "groups are off until 11-09" },
    pageState: { kind: "unjudged", next: "the page shows a bot check; wait for it to clear in Safari, then use another permitted source if it persists." },
  };
  const { space: _, ...rest } = opened;
  expect(JSON.parse(formatResult(opened))).toEqual({ ...rest, space: { group: "plain", why: "groups are off until 11-09" } });
  const loading = { url: "https://a.example/", title: "", ready: "loading", pageState: { kind: "loading", next: "wait for expected page text, then read the page again." } };
  expect(JSON.parse(formatResult(loading))).toEqual(loading);
});

test("eval prints the script's result without the envelope, and a failure whole", () => {
  expect(formatResult({ ok: true, result: { clicked: true, inputs: ["Username"] } })).toBe('{\n "clicked": true,\n "inputs": [\n  "Username"\n ]\n}');
  expect(formatResult({ ok: true, result: null })).toBe("null");
  expect(JSON.parse(formatResult({ ok: false, error: "ReferenceError: x is not defined" }))).toEqual({ ok: false, error: "ReferenceError: x is not defined" });
  expect(JSON.parse(formatResult({ ok: true, result: { ok: false, error: "not signed in" } }))).toEqual({ ok: true, result: { ok: false, error: "not signed in" } });
});
