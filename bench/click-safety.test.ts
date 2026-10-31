import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { benchRows, runner, type Row, type Step } from "./bench.ts";

const targets = "click-safety-targets.html";
const identity = "click-safety-identity.html";
const evaluate = (source: string, result: unknown): Step => ({ op: "eval", args: [source], answer: { value: { ok: true, result } } });
// what a click refused before its first event carries (failures.ts)
const unsent = { code: "stale_view", effect: "none" };
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
const relabel = (name: string): Step => evaluate(`(() => {
  document.querySelector("#descendant span").textContent = ${JSON.stringify(name)};
  return true;
})()`, true);

const clickEvents = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
const recordInputs = (selector: string): Step => evaluate(`(() => {
  document.body.dataset.inputs = "[]";
  const target = document.querySelector(${JSON.stringify(selector)});
  for (const type of ${JSON.stringify(clickEvents)}) target.addEventListener(type, (event) => {
    const inputs = JSON.parse(document.body.dataset.inputs);
    inputs.push(event.type);
    document.body.dataset.inputs = JSON.stringify(inputs);
  });
  return true;
})()`, true);
const inputs = (result: string[]): Step => evaluate("JSON.parse(document.body.dataset.inputs)", result);

const positionedLayout = (body: string, markup: string, root = ""): Step => evaluate(`(() => {
  document.documentElement.style.cssText = ${JSON.stringify(root)};
  document.body.style.cssText = ${JSON.stringify(`margin:0;overflow:visible;${body}`)};
  document.body.innerHTML = ${JSON.stringify(markup)};
  document.body.dataset.clicks = "0";
  document.getElementById("action").addEventListener("click", () => {
    document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1);
  });
  return true;
})()`, true);

const positionedLayouts: { name: string; body: string; markup: string; root?: string; ref?: string; error?: string }[] = [
  {
    name: "a viewport-fixed editor control remains clickable when scroll locking leaves the body empty",
    body: "overflow:hidden",
    markup: '<button id="action" style="position:fixed;left:100px;top:100px;width:180px;height:48px">Save</button>',
  },
  {
    name: "body overflow propagated to the viewport does not clip a control to the body's empty box",
    body: "height:0;overflow:hidden",
    markup: '<button id="action" style="position:relative;left:100px;top:100px;width:180px;height:48px">Save</button>',
  },
  {
    name: "a descendant of a viewport-fixed toolbar remains clickable outside the empty body",
    body: "overflow:hidden",
    markup: '<div style="position:fixed;left:100px;top:100px"><button id="action" style="width:180px;height:48px"><span style="display:block">Save</span></button></div>',
    ref: "#action span",
  },
  {
    name: "a viewport-fixed control escapes an overflow ancestor that does not contain its position",
    body: "overflow:hidden",
    markup: '<div style="width:0;height:0;overflow:hidden"><button id="action" style="position:fixed;left:100px;top:100px;width:180px;height:48px">Save</button></div>',
  },
  {
    name: "an absolute viewport control escapes a static overflow body and intermediate overflow box",
    root: "overflow:hidden",
    body: "height:0;overflow:hidden",
    markup: '<div style="width:0;height:0;overflow:hidden"><button id="action" style="position:absolute;left:100px;top:100px;width:180px;height:48px">Save</button></div>',
  },
  {
    name: "a fixed control clicks the narrow visible area inside its transformed containing block",
    body: "overflow:hidden",
    markup: '<div style="position:relative;transform:translateZ(0);overflow:hidden;width:24px;height:36px;margin:100px"><button id="action" style="position:fixed;left:0;top:0;width:240px;height:36px">Save</button></div>',
  },
  {
    name: "a fixed control outside its transformed containing block remains unclickable",
    body: "overflow:hidden",
    markup: '<div style="transform:translateZ(0);overflow:clip;width:24px;height:36px;margin:100px"><button id="action" style="position:fixed;left:100px;top:0;width:240px;height:36px">Save</button></div>',
    error: "visible",
  },
  {
    name: "an enlarged overflow box keeps a visible control clickable beyond its unscaled width",
    body: "overflow:hidden",
    markup: '<div style="position:relative;transform:scale(2);transform-origin:0 0;overflow:hidden;width:100px;height:60px;border:8px solid black;margin:100px"><button id="action" style="position:relative;left:70px;top:30px;width:20px;height:20px;padding:0">Save</button></div>',
  },
  {
    name: "a shrunk overflow box clicks the visible sliver inside its scaled borders",
    body: "overflow:hidden",
    markup: '<div style="position:relative;transform:scale(.5);transform-origin:0 0;overflow:clip;width:24px;height:36px;border:40px solid black;margin:100px"><button id="action" style="position:absolute;left:0;top:0;width:240px;height:36px;padding:0">Save</button></div>',
  },
  {
    name: "an overflow box inherits its ancestor's scale when locating a visible control",
    body: "overflow:hidden",
    markup: '<div style="transform:scale(2);transform-origin:0 0;margin:100px"><div style="position:relative;overflow:hidden;width:100px;height:60px;border:8px solid black"><button id="action" style="position:relative;left:70px;top:30px;width:20px;height:20px;padding:0">Save</button></div></div>',
  },
  {
    name: "an overflow box scales its horizontal and vertical clipping bounds independently",
    body: "overflow:hidden",
    markup: '<div style="position:relative;transform:scale(2,3);transform-origin:0 0;overflow:hidden;width:100px;height:60px;border:8px solid black;margin:100px"><button id="action" style="position:relative;left:70px;top:30px;width:20px;height:20px;padding:0">Save</button></div>',
  },
  {
    name: "a scaled control behind a real cover receives no click",
    body: "overflow:hidden",
    markup: '<div style="position:relative;transform:scale(2);transform-origin:0 0;overflow:hidden;width:100px;height:60px;border:8px solid black;margin:100px"><button id="action" style="position:relative;left:70px;top:30px;width:20px;height:20px;padding:0">Save</button></div><div style="position:fixed;inset:0;z-index:2;background:white">Blocking notice</div>',
    error: "covered",
  },
  {
    name: "a fixed control outside its scaled containing block receives no click",
    body: "overflow:hidden",
    markup: '<div style="position:relative;transform:scale(.5);transform-origin:0 0;overflow:clip;width:24px;height:36px;margin:100px"><button id="action" style="position:fixed;left:100px;top:0;width:240px;height:36px">Save</button></div>',
    error: "visible",
  },
  {
    name: "a rotated scaled control behind a real cover receives no click",
    body: "overflow:hidden",
    markup: '<div style="position:relative;transform:rotate(20deg) scale(2);transform-origin:0 0;overflow:hidden;width:100px;height:60px;border:8px solid black;margin:100px"><button id="action" style="position:relative;left:70px;top:30px;width:20px;height:20px;padding:0">Save</button></div><div style="position:fixed;inset:0;z-index:2;background:white">Blocking notice</div>',
    error: "covered",
  },
  {
    name: "root overflow clips to the viewport rather than the root element's smaller box",
    root: "overflow:hidden;width:24px;height:36px",
    body: "",
    markup: '<button id="action" style="position:relative;left:100px;top:100px;width:180px;height:48px">Save</button>',
  },
  {
    name: "body overflow still clips its positioned child when root overflow prevents propagation",
    root: "overflow:hidden",
    body: "position:relative;overflow:hidden;width:24px;height:36px",
    markup: '<button id="action" style="position:absolute;left:0;top:0;width:240px;height:36px">Save</button>',
  },
  {
    name: "a covered viewport-fixed editor control receives no click despite escaping body overflow",
    body: "overflow:hidden",
    markup: '<button id="action" style="position:fixed;left:100px;top:100px;width:180px;height:48px">Save</button><div style="position:fixed;inset:0;z-index:2;background:white">Blocking notice</div>',
    error: "covered",
  },
  {
    name: "a covered link's refusal names its address, which goto opens",
    body: "overflow:hidden",
    markup: '<a id="action" href="https://example.com/servers" style="position:fixed;left:100px;top:100px;width:180px;height:48px;display:block">Servers</a><div style="position:fixed;inset:0;z-index:2;background:white">Blocking notice</div>',
    error: "links to https://example.com/servers, which goto opens",
  },
];

const positionedClicks: Row[] = positionedLayouts.map(({ name, body, markup, root, ref, error }) => ({
  name,
  page: targets,
  steps: [
    positionedLayout(body, markup, root),
    { op: "click", args: [ref ?? "#action"], answer: error ? { error: expect.stringContaining(error), failure: unsent } : { value: { ok: true } } },
    evaluate("document.body.dataset.clicks", error ? "0" : "1"),
  ],
}));

const coveredClicks: Row[] = [
  { name: "a covered selector target receives no click and names its cover", setup: [], target: "#covered" },
  { name: "a covered text target receives no click and names its cover", setup: [], target: "Covered action" },
  { name: "a covered reference target receives no click and names its cover", setup: [{ op: "snapshot" }], target: "1" },
].map(({ name, setup, target }) => ({
  name,
  page: targets,
  steps: [
    ...setup,
    { op: "click", args: [target], answer: { error: expect.stringContaining("covered by"), failure: unsent } },
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
    { op: "click", args: [target], answer: { error: expect.stringContaining(reason), failure: unsent } },
    state(`safety.${counter}`, 0),
  ],
}));

const secretPaste: Row[] = [
  { name: "shown current password", autocomplete: "current-password" },
  { name: "shown new password", autocomplete: "new-password" },
  { name: "one-time code", autocomplete: "one-time-code" },
  { name: "card number", autocomplete: "cc-number" },
  { name: "card security code", autocomplete: "cc-csc" },
  { name: "card expiry", autocomplete: "cc-exp" },
  { name: "billing card expiry month", autocomplete: "billing cc-exp-month" },
  { name: "card expiry year", autocomplete: "cc-exp-year" },
].map(({ name, autocomplete }) => ({
  name: `native paste preparation refuses a ${name} field before focusing it`,
  page: targets,
  steps: [
    evaluate(`(() => {
      const field = document.getElementById("keyboard");
      document.body.prepend(field);
      field.autocomplete = ${JSON.stringify(autocomplete)};
      document.getElementById("descendant").focus();
      return true;
    })()`, true),
    { op: "nativeProbe", args: [{ kind: "paste", ref: "#keyboard" }], answer: { error: expect.stringContaining("native paste refuses") } },
    evaluate("document.activeElement.id", "descendant"),
  ],
}));

benchRows("safe clicks in WebKit", [
  ...coveredClicks,
  ...unavailableClicks,
  ...positionedClicks,
  ...secretPaste,
  // On 10-23 a link in a list the page was still drawing had no area to
  // click; the agent went to its address instead. The page's own timer
  // shows the target 300 ms on, after the click's first look found none.
  {
    name: "a target the page shows a moment after the click asks gets the click",
    page: targets,
    steps: [
      positionedLayout("", '<div id="wrap" style="height:0;overflow:hidden"><button id="action" style="width:180px;height:48px">Save</button></div>'),
      evaluate('(() => { setTimeout(() => { document.getElementById("wrap").style.height = "auto"; }, 300); return true; })()', true),
      { op: "click", args: ["#action"], answer: { value: { ok: true } } },
      evaluate("document.body.dataset.clicks", "1"),
    ],
  },
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
    name: "a styled hidden checkbox points to its visible label without toggling until that label is clicked",
    page: targets,
    steps: [
      { op: "click", args: ["#checkbox"], answer: { error: expect.stringContaining("click its label ["), failure: { ...unsent, retryable: false, next: "click the visible label instead" } } },
      evaluate("document.getElementById('checkbox').checked", false),
      { op: "click", args: ["#checkbox-label"], answer: { value: { ok: true } } },
      evaluate("document.getElementById('checkbox').checked", true),
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
    name: "Enter submits a form only from a one-line text field whose keydown and keypress the page let through",
    page: targets,
    steps: [
      evaluate(`(() => {
        const form = document.createElement("form");
        form.innerHTML = '<textarea id="note" aria-label="Note"></textarea><input id="search" aria-label="Search"><input id="chat" aria-label="Chat"><input id="agree" type="checkbox" aria-label="Agree"><input id="plain" aria-label="Plain"><button>Send</button>';
        document.body.prepend(form);
        document.body.dataset.submits = "0";
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          document.body.dataset.submits = String(Number(document.body.dataset.submits) + 1);
        });
        document.getElementById("search").addEventListener("keydown", (event) => { if (event.keyCode === 13) event.preventDefault(); });
        document.getElementById("chat").addEventListener("keypress", (event) => { if (event.key === "Enter") event.preventDefault(); });
        return true;
      })()`, true),
      { op: "press", args: ["#note", "Enter", { noWaitAfter: true }] },
      { op: "press", args: ["#search", "Enter", { noWaitAfter: true }] },
      { op: "press", args: ["#chat", "Enter", { noWaitAfter: true }] },
      { op: "press", args: ["#agree", "Enter", { noWaitAfter: true }] },
      evaluate("document.body.dataset.submits", "0"),
      { op: "press", args: ["#plain", "Enter", { noWaitAfter: true }] },
      evaluate("document.body.dataset.submits", "1"),
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
    name: "a covered click names the close control of the dialog covering it, which clears the way",
    page: targets,
    steps: [
      evaluate(`(() => {
        const target = document.getElementById("descendant");
        target.scrollIntoView({ block: "center", behavior: "instant" });
        const rect = target.getBoundingClientRect();
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-label", "Confirm your address");
        dialog.style.cssText = "position:fixed;z-index:10000;background:white";
        Object.assign(dialog.style, { left: rect.left - 20 + "px", top: rect.top - 20 + "px", width: rect.width + 240 + "px", height: rect.height + 40 + "px" });
        dialog.innerHTML = '<div style="position:absolute;right:0;top:0"><button>Cancel subscription</button><button>Close</button></div>';
        dialog.querySelector("button:last-child").addEventListener("click", () => dialog.remove());
        document.body.append(dialog);
        return true;
      })()`, true),
      { op: "click", args: ["#descendant"], answer: { error: 'that target is covered by dialog "Confirm your address"; its close control is [1] button "Close"', failure: unsent } },
      state("safety.descendant", 0),
      { op: "click", args: ["1"], answer: { value: { ok: true } } },
      { op: "click", args: ["#descendant"], answer: { value: { ok: true } } },
      state("safety.descendant", 1),
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
    name: "native paste preparation refuses a field previously filled as secret without stealing focus",
    page: targets,
    steps: [
      evaluate("(() => { document.body.prepend(document.getElementById('keyboard')); return true; })()", true),
      { op: "type", args: ["#keyboard", "fixture-only", { secret: true, noWaitAfter: true }], answer: { value: { ok: true, kept: true } } },
      evaluate("(() => { document.getElementById('descendant').focus(); return true; })()", true),
      { op: "nativeProbe", args: [{ kind: "paste", ref: "#keyboard" }], answer: { error: expect.stringContaining("secret fields") } },
      evaluate("document.activeElement.id", "descendant"),
    ],
  },
  {
    name: "native paste preparation refuses an already focused one-time code field without a ref",
    page: targets,
    steps: [
      evaluate(`(() => {
        const field = document.getElementById("keyboard");
        document.body.prepend(field);
        field.autocomplete = "one-time-code";
        field.focus();
        return true;
      })()`, true),
      { op: "nativeProbe", args: [{ kind: "paste" }], answer: { error: expect.stringContaining("secret fields") } },
      evaluate("document.activeElement.id", "keyboard"),
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

const changedIdentifiers: Row[] = [
  { name: "account", before: "Transfer to account (1234)", after: "Transfer to account (9876)" },
  { name: "invoice", before: "Invoice [1234]", after: "Invoice [9876]" },
  { name: "year", before: "Year (2025)", after: "Year (2026)" },
  { name: "page", before: "Page (2)", after: "Page (3)" },
].map(({ name, before, after }) => ({
  name: `a changed bracketed ${name} identifier refuses a snapshotted click before any input event`,
  page: targets,
  steps: [
    relabel(before),
    recordInputs("#descendant"),
    { op: "snapshot" },
    relabel(after),
    { op: "click", args: ["2"], answer: { error: `that control changed since the snapshot: it was button "${before}", now button "${after}"; re-run snapshot`, failure: unsent } },
    inputs([]),
  ],
}));

const delayedIdentity: Row[] = ["1", "#action"].flatMap((target) => [true, false].map((changed): Row => ({
  name: `a delayed click via ${target} ${changed ? "refuses a relabeled control before any event" : "presses the unchanged control"} while reads remain nonacting`,
  page: targets,
  steps: [
    positionedLayout("", '<div id="wrap"><button id="action" style="width:180px;height:48px">Save draft</button></div>'),
    recordInputs("#action"),
    { op: "snapshot", answer: { value: { snapshot: '[1] button "Save draft"' } } },
    evaluate(`(async () => {
      const wrap = document.getElementById("wrap");
      const button = document.getElementById("action");
      wrap.style.cssText = "height:0;overflow:hidden";
      const pending = window.__safariHarnessRun({ id: "delayed", op: "click", args: [${JSON.stringify(target)}, { noWaitAfter: true }] });
      ${changed ? 'button.textContent = "Delete account";' : ""}
      wrap.style.height = "auto";
      const read = await window.__safariHarnessRun({ id: "read", op: "element", args: ["1", "text"] });
      const action = await pending;
      return { read, action };
    })()`, {
      read: { value: { value: changed ? "Delete account" : "Save draft" } },
      action: changed
        ? { error: 'that control changed since the snapshot: it was button "Save draft", now button "Delete account"; re-run snapshot', failure: unsent }
        : { value: { ok: true } },
    }),
    inputs(changed ? [] : clickEvents),
  ],
})));

const healedAliases: Row[] = [true, false].map((changed) => ({
  name: `an old reference healed by a read after reload ${changed ? "refuses a relabeled control before any event" : "still presses the unchanged control"}`,
  page: `${identity}?single`,
  steps: [
    { op: "snapshot" },
    { load: "blank.html" },
    { load: `${identity}?single#reloaded` },
    recordInputs("#orders button"),
    { op: "element", args: ["1", "text"], kept: true, answer: { value: { value: "Approve", healed: { ref: "1", now: "2" } } } },
    ...changed ? [evaluate('(() => { document.querySelector("#orders button").textContent = "Delete account"; return true; })()', true)] : [],
    { op: "click", args: ["1"], answer: changed
      ? { error: 'that control changed since the snapshot: it was button "Approve", now button "Delete account"; re-run snapshot', failure: unsent }
      : { value: { ok: true } } },
    inputs(changed ? [] : clickEvents),
    approvals(changed ? [] : ["A"]),
  ],
}));

benchRows("replacement identity in WebKit", [
  ...changedIdentifiers,
  ...delayedIdentity,
  ...healedAliases,
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
  {
    name: "an action on a ref the page redrew as another control is refused before any event until a snapshot prints it again",
    page: targets,
    steps: [
      relabel("Cart (2)"),
      { op: "snapshot" },
      relabel("Cart (3)"),
      { op: "click", args: ["2"], answer: { value: { ok: true } } },
      evaluate(`(() => {
        document.querySelector("#descendant span").textContent = "Delete account";
        document.getElementById("keyboard").setAttribute("aria-label", "Card number");
        return true;
      })()`, true),
      { op: "element", args: ["2", "visible"], answer: { value: { value: true } } },
      { op: "click", args: ["2"], answer: { error: 'that control changed since the snapshot: it was button "Cart (2)", now button "Delete account"; re-run snapshot', failure: unsent } },
      { op: "type", args: ["12", "4242", { noWaitAfter: true }], answer: { error: 'that control changed since the snapshot: it was textbox "Keyboard field", now textbox "Card number"; re-run snapshot', failure: unsent } },
      state("({ clicks: safety.descendant, typed: document.getElementById('keyboard').value })", { clicks: 1, typed: "" }),
      { op: "snapshot" },
      { op: "click", args: ["2"], answer: { value: { ok: true } } },
      state("safety.descendant", 2),
    ],
  },
  {
    name: "a count in a ref's name may change, appear or vanish, but any other number in it must match",
    page: targets,
    steps: [
      relabel("Basket (2) 0 items"),
      { op: "snapshot" },
      relabel("Basket [3] 1 item"),
      { op: "click", args: ["2"], answer: { value: { ok: true } } },
      relabel("Basket"),
      { op: "click", args: ["2"], answer: { value: { ok: true } } },
      relabel("Page 2"),
      { op: "snapshot" },
      relabel("Page 3"),
      { op: "click", args: ["2"], answer: { error: 'that control changed since the snapshot: it was button "Page 2", now button "Page 3"; re-run snapshot', failure: unsent } },
      relabel("Pickup at 7:00 PM"),
      { op: "snapshot" },
      relabel("Pickup at 9:30 PM"),
      { op: "click", args: ["2"], answer: { error: 'that control changed since the snapshot: it was button "Pickup at 7:00 PM", now button "Pickup at 9:30 PM"; re-run snapshot', failure: unsent } },
      state("safety.descendant", 2),
    ],
  },
  {
    name: "a query snapshot leaves alone the fingerprint of a heading link it does not print",
    page: "blank.html",
    steps: [
      evaluate(`(() => {
        document.body.innerHTML = '<h3><a id="book" href="#attic">A Light in the Attic</a></h3><button>Add to basket</button>';
        return true;
      })()`, true),
      { op: "snapshot", answer: { value: { snapshot: 'h3 [1] link "A Light in the Attic"\n[2] button "Add to basket"' } } },
      evaluate(`(() => { document.getElementById("book").textContent = "Delete my account"; return true; })()`, true),
      { op: "snapshot", args: [{ query: "basket" }], answer: { value: { snapshot: '[2] button "Add to basket"' } } },
      { op: "click", args: ["1"], answer: { error: 'that control changed since the snapshot: it was link "A Light in the Attic", now link "Delete my account"; re-run snapshot', failure: unsent } },
    ],
  },
]);

type FrameReply = { value?: { x: number; y: number; frame: string }; error?: string };

type WebKitRequest = <T = FrameReply>(message: object) => Promise<T>;

async function withWebKit<T>(run: (request: WebKitRequest) => Promise<T>): Promise<T> {
  const process = Bun.spawn([runner, join(import.meta.dir, "..", "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const errors = new Response(process.stderr).text();
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const request: WebKitRequest = async <R>(message: object): Promise<R> => {
    process.stdin.write(JSON.stringify(message) + "\n");
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        return JSON.parse(line) as R;
      }
      const next = await reader.read();
      if (next.done) throw new Error("the WebKit fixture closed before answering");
      buffered += decoder.decode(next.value, { stream: true });
    }
  };
  try {
    const result = await run(request);
    process.stdin.end();
    expect(await process.exited).toBe(0);
    expect(await errors).toBe("");
    return result;
  } finally {
    if (process.exitCode === null) {
      process.kill();
      await process.exited;
    }
    await reader.cancel();
    await errors;
  }
}

describe.skipIf(!runner)("cross-origin frame checks", () => {
  test.each([true, false])("a cross-origin frame's parent checks its cover before dispatch (covered=%s)", async (covered) => {
    const fixture = pathToFileURL(join(import.meta.dir, "fixtures", "click-safety-frame-parent.html")).href + (covered ? "" : "?clear");
    const child = pathToFileURL(join(import.meta.dir, "fixtures", "click-safety-frame-child.html")).href;
    await withWebKit(async (request) => {
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
    });
  }, 20_000);

  test("a guarded click and its frame probe refuse a replaced control without delivering an event", async () => {
    const fixture = pathToFileURL(join(import.meta.dir, "fixtures", targets)).href;
    await withWebKit(async (request) => {
      expect(await request({ load: fixture })).toMatchObject({ url: fixture });
      await request({ op: "snapshot" });
      const marker = await request<{ value: { result: { token: string; ref: string } } }>({
        op: "eval", args: ["({token:window.__safariHarnessFrame,ref:document.getElementById('descendant').getAttribute('data-sh-ref')})"],
      });
      const { token, ref } = marker.value.result;
      expect(ref).toMatch(/^\d+$/);
      await request({ op: "eval", args: ["(()=>{const old=document.getElementById('descendant');const next=old.cloneNode(true);document.body.dataset.guardClicks='0';next.addEventListener('click',()=>document.body.dataset.guardClicks=String(Number(document.body.dataset.guardClicks)+1));old.replaceWith(next);return true})()"] });
      const opts = { expectedDocument: token, expectedTarget: ref };
      expect(await request({ op: "click", args: ["#descendant", opts] })).toMatchObject({ error: "the target changed before the click; re-run snapshot" });
      expect(await request({ op: "clickProbe", args: ["#descendant", "click", opts] })).toMatchObject({ error: "the target changed before the click; re-run snapshot" });
      expect(await request({ op: "eval", args: ["document.body.dataset.guardClicks"] })).toMatchObject({ value: { result: "0" } });
    });
  }, 20_000);
});
