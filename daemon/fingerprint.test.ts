import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Candidate, type Fingerprint, type Match, matchFingerprint } from "./fingerprint.ts";

// The page heals a stale ref with its own copy of the matcher (content.js
// has no module system), and a replay finds each step's target with the
// daemon's. Both must pick the same element, or refuse the same way: the
// table below runs through each copy.
const CONTENT = readFileSync(join(import.meta.dir, "../extension/content.js"), "utf8");
const begin = CONTENT.indexOf("// ---- shared with daemon/fingerprint.ts: begin ----");
const end = CONTENT.indexOf("// ---- shared with daemon/fingerprint.ts: end ----");
const pageCopy = new Function(`${CONTENT.slice(begin, end)}\nreturn matchFingerprint;`)() as typeof matchFingerprint;

const button = (name: string, near = "", path = "div:nth-of-type(1)>button:nth-of-type(1)"): Candidate => ({ role: "button", name, tag: "button", near, path });
const recorded = (c: Candidate, index: number, count: number): Fingerprint => ({ ...c, index, count });

const CASES: { what: string; fp: Fingerprint; now: Candidate[]; want: Match }[] = [
  {
    what: "the only context-free element that looked like it, and still the only one",
    fp: recorded(button("Save"), 0, 1),
    now: [button("Cancel"), button("Save")],
    want: { index: 1 },
  },
  {
    what: "a unique control replaced by another row's control is not the same business target",
    fp: recorded(button("Save", "Invoice 42"), 0, 1),
    now: [button("Save", "Invoice 43")],
    want: { count: 1 },
  },
  {
    what: "a unique context-free control moved into a named row needs a fresh read",
    fp: recorded(button("Save"), 0, 1),
    now: [button("Save", "Invoice 43")],
    want: { count: 1 },
  },
  {
    what: "a unique row's control remains recoverable with the same nearby business text",
    fp: recorded(button("Save", "Invoice 42"), 0, 1),
    now: [button("Save", "Invoice 42", "#replacement>button:nth-of-type(1)")],
    want: { index: 0 },
  },
  {
    what: "a row's missing nearby business text cannot be replaced by position",
    fp: recorded(button("Save", "Invoice 42"), 0, 1),
    now: [button("Save")],
    want: { count: 1 },
  },
  {
    what: "an empty nearby text does not identify the one blank row left among prior lookalikes",
    fp: recorded(button("Delete"), 1, 3),
    now: [button("Delete", "Invoice 41"), button("Delete"), button("Delete", "Invoice 43")],
    want: { count: 3 },
  },
  {
    what: "one remaining context-free lookalike cannot prove which prior row survived",
    fp: recorded(button("Delete"), 1, 3),
    now: [button("Delete")],
    want: { count: 1 },
  },
  {
    what: "nothing like it on the page",
    fp: recorded(button("Save"), 0, 1),
    now: [button("Cancel")],
    want: { count: 0 },
  },
  {
    what: "the same name on another kind of element",
    fp: recorded(button("Save"), 0, 1),
    now: [{ role: "link", name: "Save", tag: "a", near: "", path: "a:nth-of-type(1)" }],
    want: { count: 0 },
  },
  {
    what: "one of two lookalikes now, alike in every way, where there was one",
    fp: recorded(button("Save", "Profile"), 0, 1),
    now: [button("Save", "Profile"), button("Save", "Profile")],
    want: { count: 2 },
  },
  {
    what: "the row's own Delete, found by its row after the rows moved",
    fp: recorded(button("Delete", "Invoice 42"), 1, 3),
    now: [button("Delete", "Invoice 42"), button("Delete", "Invoice 41"), button("Delete", "Invoice 43")],
    want: { index: 0 },
  },
  {
    what: "the lone Delete left is another row's: refused, not guessed",
    fp: recorded(button("Delete", "Invoice 42"), 1, 3),
    now: [button("Delete", "Invoice 43")],
    want: { count: 1 },
  },
  {
    what: "the lone Delete left is its own row's",
    fp: recorded(button("Delete", "Invoice 42"), 1, 3),
    now: [button("Delete", "Invoice 42")],
    want: { index: 0 },
  },
  {
    what: "lookalikes in boxes that read the same stay ambiguous even on the same CSS path",
    fp: recorded(button("Edit", "Settings", "section:nth-of-type(2)>button:nth-of-type(1)"), 1, 2),
    now: [button("Edit", "Settings", "section:nth-of-type(1)>button:nth-of-type(1)"), button("Edit", "Settings", "section:nth-of-type(2)>button:nth-of-type(1)")],
    want: { count: 2 },
  },
  {
    what: "identical lookalikes stay ambiguous even when their count and ordinal are unchanged",
    fp: recorded(button("Reply"), 1, 3),
    now: [button("Reply"), button("Reply"), button("Reply")],
    want: { count: 3 },
  },
  {
    what: "identical lookalikes, fewer than before: its place proves nothing",
    fp: recorded(button("Reply"), 1, 3),
    now: [button("Reply"), button("Reply")],
    want: { count: 2 },
  },
];

for (const { what, fp, now, want } of CASES) {
  test(`matcher: ${what}`, () => {
    expect(matchFingerprint(fp, now)).toEqual(want);
    expect(pageCopy(fp, now)).toEqual(want);
  });
}

