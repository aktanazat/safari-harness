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
    what: "the only element that looked like it, and still the only one",
    fp: recorded(button("Save"), 0, 1),
    now: [button("Cancel"), button("Save", "Draft saved 2 min ago")],
    want: { index: 1 },
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
    what: "lookalikes in boxes that read the same, told apart by their path",
    fp: recorded(button("Edit", "Settings", "section:nth-of-type(2)>button:nth-of-type(1)"), 1, 2),
    now: [button("Edit", "Settings", "section:nth-of-type(1)>button:nth-of-type(1)"), button("Edit", "Settings", "section:nth-of-type(2)>button:nth-of-type(1)")],
    want: { index: 1 },
  },
  {
    what: "identical lookalikes, as many as before: the one in the same place",
    fp: recorded(button("Reply"), 1, 3),
    now: [button("Reply"), button("Reply"), button("Reply")],
    want: { index: 1 },
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

