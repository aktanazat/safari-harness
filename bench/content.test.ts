import { expect } from "bun:test";
import { benchRows } from "./bench.ts";

// content.js as it answers in Safari's WebKit, one page per behavior in
// bench/fixtures. Refs count from 1 in each fresh page; a comment on a
// setup snapshot names the refs the steps after it use.
benchRows("content.js in WebKit", [
  {
    name: "a snapshot leaves out text hidden by display, visibility, or opacity, but keeps text fading in",
    page: "hidden.html",
    steps: [{ op: "snapshot", answer: { value: { snapshot: "This sentence is shown on the page.\nThis sentence is fading in." } } }],
  },
  {
    name: "a snapshot that keeps hidden text still leaves out script, style, and noscript source",
    page: "source.html",
    steps: [{ op: "snapshot", args: [{ showHidden: true }], answer: { value: { snapshot: "Shown text. · Collapsed menu text." } } }],
  },
  {
    name: "a snapshot leaves out words no one sees, keeps a shown child of a hidden wrapper, and names a control by its screen-reader label",
    page: "unseen.html",
    steps: [{ op: "snapshot", answer: { value: { snapshot: 'Workspace shown inside a hidden wrapper.\nh2 "Gradient heading"\n[1] button "Close dialog"\nShown words.' } } }],
  },
  {
    name: "extract leaves out words no one sees and keeps a shown child of a hidden wrapper",
    page: "unseen.html",
    steps: [{ op: "extract", answer: { value: { text: "Workspace shown inside a hidden wrapper.\n\nGradient heading\n\nShown words." } } }],
  },
  {
    name: "a snapshot reads open shadow roots, with slotted text where its slot is drawn",
    page: "shadow.html",
    steps: [{ op: "snapshot", answer: { value: { snapshot: 'h2 "Ada Lovelace"\n[1] button "Follow"' } } }],
  },
  {
    name: "a snapshot gives each field's state, and a password field's value never",
    page: "form.html",
    steps: [{
      op: "snapshot",
      answer: {
        value: {
          snapshot: [
            '[1] label "Email"',
            '  [2] textbox "Email" {value="ada@example.com"}',
            '[3] label "Password"',
            '  [4] textbox "Password" {filled}',
            '[5] label "Remember me"',
            '  [6] checkbox "Remember me" {checked, value="on"}',
            '[7] label "Plan"',
            '  [8] combobox "Plan" {value="Pro", 2 options}',
            '[9] button "Sign in"',
          ].join("\n"),
        },
      },
    }],
  },
  {
    name: "typing on a label's ref types into the field it labels",
    page: "form.html",
    steps: [
      { op: "snapshot" }, // [1] label "Email"
      { op: "type", args: ["1", "grace@example.com"], answer: { value: { ok: true, kept: true } } },
    ],
  },
  {
    name: "select on a label's ref picks from the list it labels",
    page: "form.html",
    steps: [
      { op: "snapshot" }, // [7] label "Plan"
      { op: "select", args: ["7", "Free"], answer: { value: { ok: true, value: "Free" } } },
    ],
  },
  {
    name: "a snapshot reads a srcdoc frame as part of the page, as Safari runs no script in one",
    page: "srcdoc.html",
    steps: [{ op: "snapshot", answer: { value: { snapshot: '[1] iframe "Inline"\n  Inline frame text\n  [2] button "Inline button"' } } }],
  },
  {
    name: "a snapshot marks a frame running its own copy with that copy's token, where its lines go",
    page: "frames.html",
    frames: 1,
    steps: [{ op: "snapshot", answer: { value: { snapshot: '[1] iframe "Child" @@frame:<frame.html>@@' } } }],
  },
  {
    name: "a frame's own copy snapshots its document, its refs carrying the frame's prefix",
    page: "frames.html",
    frames: 1,
    steps: [{ op: "snapshot", args: [{ refPrefix: "f1:" }], frame: "frame.html", answer: { value: { snapshot: '[f1:1] button "Frame button"' } } }],
  },
  {
    name: "a click on a ref presses the element the snapshot gave that ref",
    page: "click.html",
    steps: [
      { op: "snapshot" }, // [1] Press
      { op: "click", args: ["1"], answer: { value: { ok: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Pressed 1 times") } } },
    ],
  },
  {
    name: "a click on a ref whose element left the page says the ref is stale",
    page: "click.html",
    steps: [
      { op: "snapshot" }, // [2] Remove the next button, [3] Doomed
      { op: "click", args: ["2"] },
      { op: "click", args: ["3"], answer: { error: "stale ref 3; re-run snapshot" } },
    ],
  },
  {
    name: "a click on a ref whose element the page drew anew presses the element that took its place, and says so",
    page: "heal.html",
    steps: [
      { op: "snapshot" }, // [1] Save, [4] Redraw
      { op: "click", args: ["4"] },
      { op: "click", args: ["1"], answer: { value: { ok: true, healed: { ref: "1", now: "7" } } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Saved") } } },
    ],
  },
  {
    name: "a ref drawn anew finds its own row's control by the text beside it, after the rows moved",
    page: "heal.html",
    steps: [
      { op: "snapshot" }, // [3] Bob's Delete, [6] Sort (Bob before Alice)
      { op: "click", args: ["6"] },
      { op: "click", args: ["3"], answer: { value: { ok: true, healed: { ref: "3", now: "7" } } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Deleted Bob") } } },
    ],
  },
  {
    name: "a ref drawn anew as one of lookalikes it cannot tell apart stays stale",
    page: "heal.html",
    steps: [
      { op: "snapshot" }, // [1] Save, [5] Redraw twice
      { op: "click", args: ["5"] },
      { op: "click", args: ["1"], answer: { error: "stale ref 1; re-run snapshot" } },
    ],
  },
  {
    name: "typing replaces a text field's value, with the input event the page listens for",
    page: "type.html",
    steps: [
      { op: "snapshot" }, // [1] Name
      { op: "type", args: ["1", "Ada"], answer: { value: { ok: true, kept: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Page saw Ada") } } },
    ],
  },
  {
    name: "typing replaces a contenteditable's text",
    page: "type.html",
    steps: [
      { op: "snapshot" }, // [2] Notes
      { op: "type", args: ["2", "New notes"], answer: { value: { ok: true, kept: true } } },
    ],
  },
  {
    name: "select picks an option by its label, with the change event the page listens for",
    page: "select.html",
    steps: [
      { op: "snapshot" }, // [1] Plan
      { op: "select", args: ["1", "Pro"], answer: { value: { ok: true, value: "Pro" } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Page saw pro") } } },
    ],
  },
  {
    name: "select with an option the list lacks names the options it has",
    page: "select.html",
    steps: [
      { op: "snapshot" }, // [1] Plan
      { op: "select", args: ["1", "Team"], answer: { error: 'no option "Team"; options: Free | Pro' } },
    ],
  },
  {
    name: "a wait for text answers found once the page's timer has added it",
    page: "wait.html",
    steps: [
      { op: "click", args: ["Search"] }, // adds "Results are ready" 300 ms later
      { op: "wait", args: [null, { text: "results are ready" }], answer: { value: { found: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Results are ready") } } },
    ],
  },
  {
    name: "extract reads the main region as drawn: shadow text in, hidden text and one-pixel decoys out",
    page: "extract.html",
    steps: [{ op: "extract", answer: { value: { text: "Pricing\n\nPro costs $12 a month.\n\nCode: BENCH\n\nBilled yearly" } } }],
  },
]);
