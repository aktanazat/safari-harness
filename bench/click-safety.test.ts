import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { benchRows, runner, type Row, type Step } from "./bench.ts";

const targets = "click-safety-targets.html";
const identity = "click-safety-identity.html";
const evaluate = (source: string, result: unknown): Step => ({ op: "eval", args: [source], answer: { value: { ok: true, result } } });
const state = (expression: string, result: unknown): Step => evaluate(`(() => {
  const safety = JSON.parse(document.body.dataset.safety);
  return (${expression});
})()`, result);
const approvals = (result: string[]): Step => evaluate("JSON.parse(document.body.dataset.approvals)", result);
const redraw = (ids: string[], copyRefs = false, move = false): Step => evaluate(`(() => {
  const command = document.getElementById("draw-command");
  command.value = ${JSON.stringify(JSON.stringify({ ids, copyRefs, move }))};
  command.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`, true);
const cover = (selector: string): Step => evaluate(`(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  target.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = target.getBoundingClientRect();
  const notice = document.createElement("div");
  notice.textContent = "Blocking notice";
  notice.style.cssText = "position:fixed;z-index:10000;background:white";
  Object.assign(notice.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
  document.body.append(notice);
  return true;
})()`, true);

const coveredClicks: Row[] = [
  { name: "a covered selector target receives no click and names its cover", setup: [], target: "#covered" },
  { name: "a covered text target receives no click and names its cover", setup: [], target: "Covered action" },
  { name: "a covered reference target receives no click and names its cover", setup: [{ op: "snapshot" }], target: "1" },
].map(({ name, setup, target }) => ({
  name,
  page: targets,
  steps: [
    ...setup,
    { op: "click", args: [target], answer: { error: expect.stringContaining("covered by") } },
    state("({ target: safety.covered, cover: safety.cover })", { target: 0, cover: 0 }),
  ],
}));

const unavailableClicks: Row[] = [
  { target: "#hidden", counter: "hidden", reason: "visible", name: "a display-hidden selector target refuses without a click" },
  { target: "#transparent", counter: "transparent", reason: "visible", name: "a target under a transparent ancestor refuses without a click" },
  { target: "#disabled-child", counter: "disabled", reason: "disabled", name: "a descendant inside a disabled button refuses without a click" },
  { target: "#aria-disabled", counter: "aria", reason: "disabled", name: "a target under an aria-disabled control refuses without a click" },
  { target: "#inert", counter: "inert", reason: "inert", name: "an inert target refuses without a click" },
].map(({ target, counter, reason, name }) => ({
  name,
  page: targets,
  steps: [
    { op: "click", args: [target], answer: { error: expect.stringContaining(reason) } },
    state(`safety.${counter}`, 0),
  ],
}));

benchRows("safe clicks in WebKit", [
  ...coveredClicks,
  ...unavailableClicks,
  {
    name: "a visible descendant receives the click intended for its control",
    page: targets,
    steps: [
      { op: "click", args: ["#descendant"], answer: { value: { ok: true } } },
      state("safety.descendant", 1),
    ],
  },
  {
    name: "a visible shadow link receives one click without treating its host as a cover",
    page: targets,
    steps: [
      { op: "click", args: ["Shadow link"], answer: { value: { ok: true, expect: "script" } } },
      state("safety.shadow", 1),
    ],
  },
  {
    name: "a clipped control clicks its visible area rather than the clipped-away center",
    page: targets,
    steps: [
      { op: "click", args: ["#clipped"], answer: { value: { ok: true } } },
      state("safety.clipped", 1),
    ],
  },
  {
    name: "a wrapped inline link clicks one of its drawn rectangles",
    page: targets,
    steps: [
      { op: "click", args: ["#wrapped"], answer: { value: { ok: true } } },
      state("safety.wrapped", 1),
    ],
  },
  {
    name: "an offscreen control scrolls into view before its click is delivered",
    page: targets,
    steps: [
      { op: "click", args: ["#far"], answer: { value: { ok: true } } },
      state("safety.far", 1),
    ],
  },
  {
    name: "a visible label still toggles its styled hidden checkbox",
    page: targets,
    steps: [
      { op: "click", args: ["Accept terms"], answer: { value: { ok: true } } },
      evaluate("document.getElementById('checkbox').checked", true),
    ],
  },
  {
    name: "a covered label cannot toggle its styled hidden checkbox",
    page: targets,
    steps: [
      cover("#checkbox-label"),
      { op: "click", args: ["Accept terms"], answer: { error: expect.stringContaining("covered") } },
      evaluate("document.getElementById('checkbox').checked", false),
    ],
  },
  {
    name: "a covered native select refuses without changing its selected value",
    page: targets,
    steps: [
      cover("#plan"),
      { op: "select", args: ["#plan", "Pro"], answer: { error: expect.stringContaining("covered") } },
      state("safety.plan", "free"),
    ],
  },
  {
    name: "a covered combobox refuses without opening its list",
    page: targets,
    steps: [
      cover("#combo"),
      { op: "select", args: ["#combo", "Paris"], answer: { error: expect.stringContaining("covered") } },
      state("({ opened: safety.comboOpen, chosen: safety.comboChoice })", { opened: 0, chosen: "" }),
    ],
  },
  {
    name: "select propagates an option's click refusal instead of reporting it was chosen",
    page: targets,
    steps: [
      evaluate("(() => { document.getElementById('option-cover').hidden = false; return true; })()", true),
      { op: "select", args: ["#combo", "Paris"], answer: { error: expect.stringContaining("covered") } },
      state("({ opened: safety.comboOpen, chosen: safety.comboChoice })", { opened: 1, chosen: "" }),
    ],
  },
  {
    name: "a visible keyboard target still receives its key",
    page: targets,
    steps: [
      { op: "press", args: ["#keyboard", "ArrowDown"], answer: { value: { ok: true, key: "ArrowDown" } } },
      state("safety.key", 1),
    ],
  },
  {
    name: "a missing explicit keyboard target refuses instead of using the focused field",
    page: targets,
    steps: [
      evaluate("(() => { document.getElementById('keyboard').focus(); return true; })()", true),
      { op: "press", args: ["#absent", "ArrowDown"], answer: { error: expect.stringContaining("nothing on the page matches") } },
      state("safety.key", 0),
    ],
  },
  {
    name: "a hidden keyboard target refuses without sending its key",
    page: targets,
    steps: [
      evaluate("(() => { document.getElementById('keyboard').hidden = true; return true; })()", true),
      { op: "press", args: ["#keyboard", "ArrowDown"], answer: { error: expect.stringContaining("visible") } },
      state("safety.key", 0),
    ],
  },
  {
    name: "a cover appearing on mousedown stops the later click instead of clicking through it",
    page: targets,
    steps: [
      evaluate(`(() => {
        const target = document.getElementById("descendant");
        target.addEventListener("mousedown", () => {
          const notice = document.createElement("div");
          notice.style.cssText = "position:fixed;inset:0;z-index:10000;background:white";
          document.body.append(notice);
        });
        return true;
      })()`, true),
      { op: "click", args: ["#descendant"], answer: { error: expect.stringContaining("covered") } },
      state("safety.descendant", 0),
    ],
  },
  {
    name: "an unknown child frame token cannot authorize any frame",
    page: targets,
    steps: [
      { op: "assertFrameClickable", args: ["missing-frame", { x: 1, y: 1 }], answer: { value: { found: false } } },
      state("safety.covered", 0),
    ],
  },
  {
    name: "a covered inline frame target receives no click through its parent cover",
    page: "click-safety-inline-frame.html",
    steps: [
      { op: "click", args: ["Inline action"], answer: { error: expect.stringContaining("covered") } },
      evaluate("document.querySelector('iframe').contentDocument.getElementById('frame-action').dataset.clicks", "0"),
    ],
  },
  {
    name: "an uncovered inline frame target remains clickable",
    page: "click-safety-inline-frame.html?clear",
    steps: [
      { op: "click", args: ["Inline action"], answer: { value: { ok: true } } },
      evaluate("document.querySelector('iframe').contentDocument.getElementById('frame-action').dataset.clicks", "1"),
    ],
  },
  {
    name: "native drag preparation returns visible endpoints without scrolling or dispatching mouse events",
    page: targets,
    steps: [
      { op: "nativeProbe", args: [{ kind: "drag", ref: "#descendant", targetX: 4, targetY: 4 }], answer: { value: { document: expect.any(String), innerWidth: 1280, innerHeight: 800, from: { x: expect.any(Number), y: expect.any(Number) }, to: { x: 4, y: 4 } } } },
      state("safety.descendant", 0),
      evaluate("({ x: scrollX, y: scrollY })", { x: 0, y: 0 }),
    ],
  },
  {
    name: "native drag preparation refuses an offscreen target rather than scrolling it into view",
    page: targets,
    steps: [
      { op: "nativeProbe", args: [{ kind: "drag", ref: "#descendant", target: "#far" }], answer: { error: expect.stringContaining("visible") } },
      state("({ source: safety.descendant, target: safety.far })", { source: 0, target: 0 }),
      evaluate("({ x: scrollX, y: scrollY })", { x: 0, y: 0 }),
    ],
  },
  {
    name: "native drag preparation refuses a covered source without clicking through it",
    page: targets,
    steps: [
      { op: "nativeProbe", args: [{ kind: "drag", ref: "#covered", target: "#descendant" }], answer: { error: expect.stringContaining("covered") } },
      state("({ source: safety.covered, cover: safety.cover })", { source: 0, cover: 0 }),
    ],
  },
  {
    name: "native paste preparation focuses its editable without clearing text or moving the caret",
    page: targets,
    steps: [
      evaluate(`(() => {
        const field = document.getElementById("keyboard");
        document.body.prepend(field);
        field.value = "keep me";
        field.setSelectionRange(3, 3);
        return true;
      })()`, true),
      { op: "nativeProbe", args: [{ kind: "paste", ref: "#keyboard" }], answer: { value: { document: expect.any(String), focus: expect.any(String), from: { x: expect.any(Number), y: expect.any(Number) } } } },
      evaluate("({ value: document.getElementById('keyboard').value, caret: document.getElementById('keyboard').selectionStart, focused: document.activeElement.id, scrollY })", { value: "keep me", caret: 3, focused: "keyboard", scrollY: 0 }),
    ],
  },
  {
    name: "native paste preparation refuses password fields before focusing them",
    page: targets,
    steps: [
      evaluate("(() => { document.getElementById('keyboard').type = 'password'; return true; })()", true),
      { op: "nativeProbe", args: [{ kind: "paste", ref: "#keyboard" }], answer: { error: expect.stringContaining("password") } },
      evaluate("document.activeElement.id === 'keyboard'", false),
    ],
  },
  {
    name: "native paste revalidation refuses a changed document without stealing focus",
    page: targets,
    steps: [
      evaluate("(() => { document.getElementById('descendant').focus(); return true; })()", true),
      { op: "nativeProbe", args: [{ kind: "paste", ref: "#keyboard", expected: { document: "old-document", innerWidth: 1280, innerHeight: 800, focus: "old-field", from: { x: 1, y: 1 } } }], answer: { error: expect.stringContaining("document or viewport changed") } },
      evaluate("document.activeElement.id", "descendant"),
    ],
  },
]);

benchRows("replacement identity in WebKit", [
  {
    name: "indistinguishable reordered replacement controls refuse an old reference and request a fresh read",
    page: `${identity}?identical`,
    steps: [
      { op: "snapshot" },
      redraw(["C", "A", "B"]),
      { op: "click", args: ["2"], answer: { error: "stale ref 2; re-run snapshot" } },
      approvals([]),
      { op: "snapshot" },
      { op: "click", args: ["6"], answer: { value: { ok: true } } },
      approvals(["B"]),
    ],
  },
  {
    name: "matching nearby invoice text recovers the correct replacement after a reorder",
    page: identity,
    steps: [
      { op: "snapshot" },
      redraw(["C", "A", "B"]),
      { op: "click", args: ["2"], answer: { value: { ok: true, healed: { ref: "2" } } } },
      approvals(["B"]),
    ],
  },
  {
    name: "an exact connected reference keeps its business target when indistinguishable rows move",
    page: `${identity}?identical`,
    steps: [
      { op: "snapshot" },
      redraw(["C", "A", "B"], false, true),
      { op: "click", args: ["2"], answer: { value: { ok: true } } },
      approvals(["B"]),
    ],
  },
  {
    name: "cloned reference attributes cannot authorize a different indistinguishable replacement",
    page: `${identity}?identical`,
    steps: [
      { op: "snapshot" },
      redraw(["C", "A", "B"], true),
      { op: "click", args: ["2"], answer: { error: "stale ref 2; re-run snapshot" } },
      approvals([]),
    ],
  },
  {
    name: "cloned reference attributes do not override distinguishable nearby invoice identity",
    page: identity,
    steps: [
      { op: "snapshot" },
      redraw(["C", "A", "B"], true),
      { op: "click", args: ["2"], answer: { value: { ok: true, healed: { ref: "2" } } } },
      approvals(["B"]),
    ],
  },
  {
    name: "a single replacement with a different invoice is not the original business target",
    page: `${identity}?single`,
    steps: [
      { op: "snapshot" },
      redraw(["B"]),
      { op: "click", args: ["1"], answer: { error: "stale ref 1; re-run snapshot" } },
      approvals([]),
    ],
  },
  {
    name: "a full reload cannot recover indistinguishable rows by their old CSS position",
    page: `${identity}?identical`,
    steps: [
      { op: "snapshot" },
      { load: "blank.html" },
      { load: `${identity}?identical#reverse` },
      { op: "click", args: ["2"], kept: true, answer: { error: "stale ref 2; re-run snapshot" } },
      approvals([]),
    ],
  },
  {
    name: "a full reload recovers the matching invoice after its row moved",
    page: identity,
    steps: [
      { op: "snapshot" },
      { load: "blank.html" },
      { load: `${identity}#reverse` },
      { op: "click", args: ["2"], kept: true, answer: { value: { ok: true, healed: { ref: "2" } } } },
      approvals(["B"]),
    ],
  },
  {
    name: "a full reload with only another invoice refuses the old single reference",
    page: `${identity}?single`,
    steps: [
      { op: "snapshot" },
      { load: "blank.html" },
      { load: `${identity}?single#different` },
      { op: "click", args: ["1"], kept: true, answer: { error: "stale ref 1; re-run snapshot" } },
      approvals([]),
    ],
  },
  {
    name: "repeated redraws keep recovering the matching invoice rather than its latest ordinal",
    page: identity,
    steps: [
      { op: "snapshot" },
      redraw(["C", "A", "B"]),
      { op: "click", args: ["2"] },
      redraw(["B", "C", "A"]),
      { op: "click", args: ["2"], answer: { value: { ok: true, healed: { ref: "2" } } } },
      approvals(["B", "B"]),
    ],
  },
  {
    name: "an extension takeover cannot trust copied attributes as replacement identity",
    page: `${identity}?identical`,
    steps: [
      { op: "snapshot" },
      redraw(["C", "A", "B"], true),
      { takeover: true },
      { op: "click", args: ["2"], answer: { error: "stale ref 2; re-run snapshot" } },
      approvals([]),
    ],
  },
  {
    name: "an extension takeover recovers distinguishable business identity from kept fingerprints",
    page: identity,
    steps: [
      { op: "snapshot" },
      redraw(["C", "A", "B"], true),
      { takeover: true },
      { op: "click", args: ["2"], kept: true, answer: { value: { ok: true, healed: { ref: "2" } } } },
      approvals(["B"]),
    ],
  },
]);

type FrameReply = { value?: { x: number; y: number; frame: string }; error?: string };

describe.skipIf(!runner)("cross-origin frame checks", () => {
  test.each([true, false])("a cross-origin frame's parent checks its cover before dispatch (covered=%s)", async (covered) => {
    const root = join(import.meta.dir, "..");
    const fixture = pathToFileURL(join(import.meta.dir, "fixtures", "click-safety-frame-parent.html")).href + (covered ? "" : "?clear");
    const child = pathToFileURL(join(import.meta.dir, "fixtures", "click-safety-frame-child.html")).href;
    const process = Bun.spawn([runner, join(root, "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const errors = new Response(process.stderr).text();
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const request = async (message: object): Promise<FrameReply> => {
      process.stdin.write(JSON.stringify(message) + "\n");
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          return JSON.parse(line) as FrameReply;
        }
        const next = await reader.read();
        if (next.done) throw new Error("the WebKit fixture closed before answering its frame check");
        buffered += decoder.decode(next.value, { stream: true });
      }
    };
    try {
      expect(await request({ load: fixture, frames: 1 })).toMatchObject({ url: fixture });
      const probe = await request({ op: "clickProbe", frame: child, args: ["#frame-action"] });
      if (!probe.value) throw new Error(probe.error || "the frame's target has no safe click point");
      const { frame, x, y } = probe.value;
      expect(typeof frame).toBe("string");
      expect(frame.length).toBeGreaterThan(0);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      const checked = await request({ op: "assertFrameClickable", args: [frame, { x, y }] });
      expect(checked).toMatchObject(covered
        ? { value: { found: true, blocker: expect.stringContaining("covered") } }
        : { value: { found: true, x: expect.any(Number), y: expect.any(Number) } });
      if (!covered) expect(await request({ op: "click", frame: child, args: ["#frame-action"] })).toMatchObject({ value: { ok: true } });
      expect(await request({ op: "eval", frame: child, args: ["document.getElementById('frame-action').dataset.clicks"] })).toMatchObject({ value: { result: covered ? "0" : "1" } });
      process.stdin.end();
      expect(await process.exited).toBe(0);
      expect(await errors).toBe("");
    } finally {
      if (process.exitCode === null) {
        process.kill();
        await process.exited;
      }
      await reader.cancel();
      await errors;
    }
  }, 20_000);
});
