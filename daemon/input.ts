// Real mouse and keyboard input through scripts/input, which posts events the
// way a physical mouse and keyboard do, so pages see event.isTrusted true.
// Captcha checkboxes, some drag handles, and sites that check isTrusted
// ignore the extension's scripted events. Posting input needs Accessibility
// permission, which the launchd daemon lacks, so these tools run in the
// caller (terminal, MCP server) and reach the tab through the daemon's RPC
// port. Real input lands on whatever is on screen, so the tab comes to the
// front for the moment it takes, once the user has paused (inFront). A
// single click on a tab not in front, and text typed at a field's ref, go
// through Safari's accessibility tree instead, and nothing comes forward.

import { AsyncLocalStorage } from "node:async_hooks";
import { frontApp, inFront, input, SAFARI, type TabOps } from "./front.ts";
import { HarnessError } from "./failures.ts";
import type { InputState } from "./input-state.ts";
import { pageErrorsOf } from "./receipt.ts";
import { rpc } from "./rpc.ts";
import { REF, SECRET_ENV, TAB, TOOLS, type TabInfo, type Tool, WAIT_MAX_MS, X, Y } from "./tools.ts";
import { rowsOf } from "./tabs-view.ts";

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

// Real input reaches tabs through the daemon's RPC port. It gives the user
// back his own front tab, so it lists his tabs too (tabs-view.ts).
const VIA_RPC: TabOps = { tabs: async () => rowsOf(await rpc("tabs", { all: true })), activate: (tab) => rpc("activate", { tab }) };
const deliveryState = new AsyncLocalStorage<{ sent: boolean }>();


// Waits in the page, up to ms, until it has seen more than `after` marks and,
// when focus is asked for, has keyboard focus. Returns the count and the
// focus either way. Safari stops a hidden tab's timers, which would stall
// the wait in the page, so it has a limit here as well.
async function pageState(tab: number, want: { focus: boolean; after: number; ms: number }, frame = 0): Promise<InputState> {
  const { promise: late, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`tab ${tab} stopped answering`)), want.ms + 3000);
  try {
    const state = await Promise.race([rpc("input_state", { tab, frame, ...want }), late]);
    if (!state || typeof state !== "object" || !("marks" in state) || typeof state.marks !== "number" || !Number.isSafeInteger(state.marks) || state.marks < 0
      || !("focus" in state) || typeof state.focus !== "boolean") throw new Error(`tab ${tab} did not report its input state`);
    return { marks: state.marks, focus: state.focus };
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(tab: number, args: string[], timeout?: number, stdin?: string, preflight?: () => Promise<void>, completion?: () => Promise<boolean>): Promise<unknown> {
  const admitted = await rpc("action_admit", { tab }) as { ok?: boolean; tab?: number; permit?: string };
  if (admitted?.ok !== true || admitted.tab !== tab || typeof admitted.permit !== "string") throw new HarnessError("unavailable", "native input was not admitted", { effect: "none", retryable: true });
  const picture = args[0] !== "key" || args[1] !== "cmd+a";
  let result: unknown;
  if (preflight) {
    try {
      await preflight();
    } catch (e) {
      await rpc("action_finish", { tab, permit: admitted.permit, uncertain: false, picture: false });
      throw e;
    }
  }
  try {
    result = await input(args, timeout, stdin, completion);
  } catch (e) {
    try {
      await rpc("action_finish", { tab, permit: admitted.permit, uncertain: true, picture });
    } catch {
      throw new HarnessError("effect_unknown", "native input may have happened and its result could not be recorded; read this tab before acting again");
    }
    throw new HarnessError("effect_unknown", e instanceof Error ? e.message : "native input may have happened", { next: "snapshot or extract this tab and check the result before repeating input" });
  }
  try {
    const declined = result !== null && typeof result === "object" && ("pressed" in result && result.pressed === false || "set" in result && result.set === false);
    if (!declined) {
      const state = deliveryState.getStore();
      if (state) state.sent = true;
    }
    await rpc("action_finish", { tab, permit: admitted.permit, uncertain: false, picture: picture && !declined });
  } catch {
    throw new HarnessError("effect_unknown", "native input finished but its result could not be recorded; read this tab before acting again");
  }
  return result;
}

// Posts real input to the tab with a helper click, type, or key command.
// Safari hands an event to whichever tab is in front when it gets to it, not
// when it was posted, so both ends are guarded. Keys go only to a page that
// has keyboard focus. Afterwards this waits until the page has seen the
// helper's closing F20 press, which follows all the rest, before the user's
// tab can come back. A page does not see keys that go into an embedded
// frame, so that wait ends after half a second. Its failure is ignored: the
// input is already sent, and an error would invite a retry that repeats it.
async function post(tab: number, args: string[], keys: boolean, timeout?: number, stdin?: string, preflight?: () => Promise<void>, frame = 0): Promise<unknown> {
  const before = await pageState(tab, { focus: keys, after: -1, ms: keys ? 1000 : 0 }, frame);
  if (keys && !before.focus) throw new Error("the page does not have keyboard focus, so no keys were sent; click a field with real_input first");
  const completion = args[0] === "paste" ? async () => {
    const after = await pageState(tab, { focus: false, after: before.marks, ms: 3000 }, frame);
    return after.marks > before.marks;
  } : undefined;
  const result = await deliver(tab, args, timeout, stdin, preflight, completion);
  if (!completion) await pageState(tab, { focus: false, after: before.marks, ms: 500 }).catch(() => {});
  return result;
}

// Clicks the middle of ref, or the point x, y, with the real mouse; the tab
// must be in front. x and y are what click takes: a point of the viewport
// in CSS px, as the page's clientX and clientY count it. locate gives the
// target in CSS px within the top page's viewport, and that viewport's
// size, once the tab has painted: an element's box scrolled into view with
// frame offsets added, or the point as a box of no size. webarea gives the
// page area of Safari's front window in screen points; their width ratio
// is the page zoom. An area whose height at that zoom is not the
// viewport's shows another page (another window came in front), where the
// click would land, so nothing is clicked. A window with no page on show
// has a prompt or panel in front of it, such as Touch ID or a passkey,
// which only the user can answer. The point clicked is in global screen
// points, negative on a display above or left of the main one.
async function clickAt(tab: number, a: Record<string, unknown>, count: number, button: string): Promise<Point> {
  const point = a.ref === undefined;
  const what = point ? `${String(a.x)}, ${String(a.y)}` : String(a.ref);
  const box = ((await rpc("locate", point ? { tab, x: a.x, y: a.y } : { tab, ref: a.ref })) ?? {}) as Partial<Rect & { innerWidth: number; innerHeight: number }>;
  const { x, y, width, height, innerWidth, innerHeight } = box;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" || typeof innerWidth !== "number" || typeof innerHeight !== "number") {
    throw new Error(`locate returned no box for ${what}: ${JSON.stringify(box)}`);
  }
  const cx = x + width / 2;
  const cy = y + height / 2;
  if ((!point && (width <= 0 || height <= 0)) || cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) {
    throw new Error(`${what} is not visible in the page's ${innerWidth}x${innerHeight} viewport, so the mouse cannot reach it`);
  }
  const area = (await input(["webarea"]).catch((e: unknown) => {
    if (e instanceof Error && e.message.includes("no web page is showing")) {
      throw new Error(`Safari shows no page for tab ${tab}: a prompt or panel is in front of its window (Touch ID, a passkey, a permission), so no input was sent; the user must answer it (handoff)`);
    }
    throw e;
  })) as Rect;
  const scale = area.width / innerWidth;
  if (Math.abs(area.height / scale - innerHeight) > 2) {
    throw new Error(`Safari's front window shows a page of another size than tab ${tab}'s (another window or a panel came in front), so no input was sent; try again, and if a prompt is showing, the user must answer it (handoff)`);
  }
  const at = { x: Math.round(area.x + cx * scale), y: Math.round(area.y + cy * scale) };
  const since = Date.now();
  await post(tab, ["click", String(at.x), String(at.y), "--count", String(count), "--button", button], false);
  await rpc("popup_intent", { tab, since }).catch(() => {});
  return at;
}

type NativeProbe = { document: string; innerWidth: number; innerHeight: number; from?: Point; to?: Point; focus?: string; inputFrame?: number };

function isPoint(value: unknown): value is Point {
  return !!value && typeof value === "object" && "x" in value && typeof value.x === "number" && Number.isFinite(value.x)
    && "y" in value && typeof value.y === "number" && Number.isFinite(value.y);
}

async function nativeProbe(tab: number, a: Record<string, unknown>, expected?: NativeProbe): Promise<NativeProbe> {
  const value = await rpc("native_preflight", {
    tab, do: a.do,
    ...(a.ref === undefined ? {} : { ref: a.ref }),
    ...(a.x === undefined ? {} : { x: a.x, y: a.y }),
    ...(a.target === undefined ? {} : { target: a.target }),
    ...(a.targetX === undefined ? {} : { targetX: a.targetX, targetY: a.targetY }),
    ...(expected === undefined ? {} : { expected }),
  });
  if (!value || typeof value !== "object" || !("document" in value) || typeof value.document !== "string"
    || !("innerWidth" in value) || typeof value.innerWidth !== "number" || !Number.isFinite(value.innerWidth) || value.innerWidth <= 0
    || !("innerHeight" in value) || typeof value.innerHeight !== "number" || !Number.isFinite(value.innerHeight) || value.innerHeight <= 0) {
    throw new Error("the page did not confirm a safe native input target");
  }
  const probe: NativeProbe = {
    ...value, document: value.document, innerWidth: value.innerWidth, innerHeight: value.innerHeight,
    from: "from" in value && isPoint(value.from) ? value.from : undefined,
    to: "to" in value && isPoint(value.to) ? value.to : undefined,
    focus: "focus" in value && typeof value.focus === "string" ? value.focus : undefined,
    inputFrame: "inputFrame" in value && typeof value.inputFrame === "number" && Number.isInteger(value.inputFrame) && value.inputFrame >= 0 ? value.inputFrame : undefined,
  };
  if (expected && (probe.document !== expected.document || probe.innerWidth !== expected.innerWidth || probe.innerHeight !== expected.innerHeight || probe.focus !== expected.focus || probe.inputFrame !== expected.inputFrame)) {
    throw new HarnessError("stale_view", "the page changed before native input; read it again", { effect: "none" });
  }
  return probe;
}

async function dragAt(tab: number, a: Record<string, unknown>): Promise<object> {
  const probe = await nativeProbe(tab, a);
  const source = probe.from;
  const destination = probe.to;
  const visible = (point: Point | undefined): point is Point => !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x < probe.innerWidth && point.y < probe.innerHeight;
  if (!visible(source) || !visible(destination)) throw new Error("both drag endpoints must be visible in the same page viewport");
  const area = await input(["webarea"]) as Rect;
  const scale = area.width / probe.innerWidth;
  if (![area.x, area.y, area.width, area.height, scale].every(Number.isFinite) || scale <= 0 || Math.abs(area.height / scale - probe.innerHeight) > 2) {
    throw new Error("Safari's front window no longer shows this page viewport, so no drag was sent");
  }
  const screen = (point: Point): Point => ({ x: Math.round(area.x + point.x * scale), y: Math.round(area.y + point.y * scale) });
  const from = screen(source);
  const to = screen(destination);
  await post(tab, ["drag", String(from.x), String(from.y), String(to.x), String(to.y)], false, 10000, undefined, async () => {
    const checked = await nativeProbe(tab, a, probe);
    if (checked.from?.x !== probe.from?.x || checked.from?.y !== probe.from?.y || checked.to?.x !== probe.to?.x || checked.to?.y !== probe.to?.y) {
      throw new HarnessError("stale_view", "a drag endpoint moved before input; read the page again", { effect: "none" });
    }
    const current = await input(["webarea"]) as Rect;
    if (current.x !== area.x || current.y !== area.y || current.width !== area.width || current.height !== area.height) {
      throw new HarnessError("stale_view", "Safari's viewport moved before the drag, so nothing was dragged", { effect: "none" });
    }
  });
  return { ok: true, from, to, hint: "drag input was delivered; read the page to check its result before repeating it" };
}

async function pasteAt(tab: number, a: Record<string, unknown>): Promise<object> {
  if (typeof a.text !== "string") throw new Error("paste needs plain text, with optional html and tsv representations");
  if (a.html !== undefined && typeof a.html !== "string" || a.tsv !== undefined && typeof a.tsv !== "string") throw new Error("html and tsv must be strings");
  if (a.secret !== undefined || a.from !== undefined || a.from_selector !== undefined || a.env !== undefined || [a.text, a.html, a.tsv].some((value) => typeof value === "string" && value.includes("{{code}}"))) {
    throw new Error("paste does not fill secrets; use type or passwords for secret fields");
  }
  const payload = JSON.stringify({ text: a.text, ...(a.html === undefined ? {} : { html: a.html }), ...(a.tsv === undefined ? {} : { tsv: a.tsv }) });
  if (Buffer.byteLength(payload, "utf8") > 4 * 1024 * 1024) throw new Error("paste representations exceed 4 MiB");
  const probe = await nativeProbe(tab, a);
  if (typeof probe.focus !== "string" || !probe.focus) throw new Error("the page did not confirm a focused editable paste target");
  const result = await post(tab, ["paste"], true, 10000, payload, async () => { await nativeProbe(tab, a, probe); }, probe.inputFrame ?? 0);
  if (!result || typeof result !== "object" || !("pasted" in result) || result.pasted !== true) {
    throw new HarnessError("effect_unknown", "paste input was sent without a confirmed helper result; read the editor before repeating it");
  }
  return {
    ok: true, delivered: true,
    clipboardRestored: "clipboardRestored" in result && result.clipboardRestored === true,
    hint: "paste input was delivered, not proof the editor accepted the text or rich formats; read the editor before repeating it",
  };
}

// press_mark's answer once it has marked the element (pressMark in
// extension/content.js): the class the helper finds it by, and its
// window's size.
type Mark = { mark: string; width: number; height: number };
const isMark = (v: unknown): v is Mark =>
  !!v && typeof v === "object" && "mark" in v && typeof v.mark === "string" && "width" in v && typeof v.width === "number" && "height" in v && typeof v.height === "number";

// Runs act where Safari's accessibility tree holds tab's page. The tree
// holds only the tab each window shows, so a tab behind another in its
// agent window is shown there for act and put back after. Returns null,
// having run nothing, for a tab behind another in one of the user's
// windows, which is his to show.
async function inTree<T>(tab: number, tabs: TabInfo[], act: () => Promise<T | null>): Promise<T | null> {
  const target = tabs.find((t) => t.id === tab);
  if (!target) throw new Error(`no tab ${tab}`);
  const back = target.active ? undefined : tabs.find((t) => t.windowId === target.windowId && t.active);
  if (back && !(await rpc("select_tab", { tab }))) return null;
  try {
    return await act();
  } finally {
    if (back) await rpc("select_tab", { tab: back.id }).catch(() => {});
  }
}

// Presses ref through Safari's accessibility tree (press in
// scripts/input.swift), which reaches a page in a window behind another
// app's: the page gets a trusted click (mousedown, mouseup, and click; no
// pointer events, and a detail of 0), and Safari, its windows, and the
// pointer stay as they were. Returns the errors the page threw from the
// press on (pressDone in extension/content.js). Returns null, having
// pressed nothing, where the real mouse takes over: the tab Safari shows
// in front while Safari is the app in front, where it takes nothing from
// the user (so activate, then real_input, gives a page the real mouse); a
// tab the tree cannot reach (inTree); a control Safari answers with its
// own UI; and an element the tree lacks (a canvas) or offers no press on.
async function pressBehind(tab: number, ref: unknown): Promise<string[] | null> {
  const [app, tabs] = await Promise.all([frontApp(), VIA_RPC.tabs()]);
  if (app === SAFARI && tabs.find((t) => t.id === tab)?.shown) return null;
  return inTree(tab, tabs, async () => {
    const marked = await rpc("press_mark", { tab, ref });
    if (marked && typeof marked === "object" && "picker" in marked) return null;
    if (!isMark(marked)) throw new Error(`press_mark returned no mark for ${String(ref)}: ${JSON.stringify(marked)}`);
    let pressed = false;
    let done: unknown;
    try {
      const r = await deliver(tab, ["press", marked.mark, String(marked.width), String(marked.height)]);
      pressed = !!r && typeof r === "object" && "pressed" in r && r.pressed === true;
    } finally {
      done = await rpc("press_done", { tab, ref, mark: marked.mark, ms: pressed ? 500 : 0 }).catch(() => null);
    }
    if (!pressed) return null;
    const errors = done && typeof done === "object" && "errors" in done ? done.errors : [];
    return Array.isArray(errors) ? errors.filter((e): e is string => typeof e === "string") : [];
  });
}

// type_mark's answer (typeMark in extension/content.js): the field typed
// into, focused and with autocorrect off; how many boxes it begins of a
// row of code boxes, which takes a character a box; whether it takes line
// breaks (a textarea or editable text); and whether its text is plain (not
// editable text), which more can be set after.
type Field = Mark & { boxes: number; multiline: boolean; plain: boolean };

// Marks the field: ref's, or with no ref the focused element. null where
// there is no text field to check (a canvas editor, a frame of another
// site's, a page that keeps focus on its body).
async function markField(tab: number, ref: unknown, text: string, append: boolean): Promise<Field | null> {
  const r = await rpc("type_mark", { tab, ...(ref === undefined ? {} : { ref }), text, append });
  if (r && typeof r === "object" && "field" in r) return null;
  if (!isMark(r) || !("boxes" in r) || typeof r.boxes !== "number" || !("multiline" in r) || !("plain" in r)) throw new Error(`type_mark returned no mark: ${JSON.stringify(r)}`);
  return { mark: r.mark, width: r.width, height: r.height, boxes: r.boxes, multiline: r.multiline === true, plain: r.plain === true };
}

// Whether the field holds the text (after its own, with append) and has
// the page's focus (typeField in extension/content.js).
type Held = { kept: boolean; focused: boolean };
async function held(tab: number, ref: unknown, field: Field, text: string): Promise<Held> {
  const r = await rpc("type_field", { tab, ...(ref === undefined ? {} : { ref }), mark: field.mark, text });
  if (!r || typeof r !== "object" || !("kept" in r) || typeof r.kept !== "boolean") throw new Error(`type_field returned no answer: ${JSON.stringify(r)}`);
  return { kept: r.kept, focused: "focused" in r && r.focused === true };
}

// Sets the field's text through Safari's accessibility tree (setvalue in
// scripts/input.swift), from behind the user's app, or with append after
// its own: on 10-07 a 200-letter reply held his screen 15 s as real keys,
// and autocorrect sent "resham" as "gresham". Returns null, having set
// nothing, where the tree cannot reach the field.
async function setBehind(tab: number, ref: unknown, field: Field, text: string, append = false): Promise<Held | null> {
  const set = await inTree(tab, await VIA_RPC.tabs(), async () => {
    const r = await deliver(tab, ["setvalue", ...(append ? ["--append"] : []), field.mark, String(field.width), String(field.height)], 10000, text);
    return !!r && typeof r === "object" && "set" in r && r.set === true;
  });
  return set ? held(tab, ref, field, text) : null;
}

// A row of code boxes takes a character a box, so each box is set from
// behind as a field of its own, by the class typeMark gave it, and the
// row is checked after. null where a box could not be set.
async function setBoxes(tab: number, ref: unknown, row: Field, text: string): Promise<Held | null> {
  for (const [i, char] of [...text].entries()) {
    const at = `.${row.mark}_${i}`;
    const box = await markField(tab, at, char, false);
    if (!box || !(await setBehind(tab, at, box, char))?.kept) return null;
  }
  return held(tab, ref, row, text);
}

// The page's Send button for the field (sendButton in content.js): a ref
// for pressBehind, and its name for the answer; undefined where it shows
// none.
async function sendButtonOf(tab: number, ref: unknown, field: Field): Promise<{ ref: string; name: string } | undefined> {
  const r = await rpc("type_send", { tab, ...(ref === undefined ? {} : { ref }), mark: field.mark });
  if (!r || typeof r !== "object" || !("send" in r) || typeof r.send !== "string") return undefined;
  return { ref: r.send, name: "name" in r && typeof r.name === "string" ? r.name : "" };
}

// Real keys go FAST_GAP_MS apart where the field is checked after: text
// that came out wrong is typed again at the helper's own 40 ms, which a
// page that reformats the field after each key (a card mask) needs.
const FAST_GAP_MS = 8;

// Types text with real keys into the tab in front. A character takes about
// 60 ms at the slow pace (input.swift); allow twice that. Answers whether
// the field holds the text, where field can tell; whole: the text is all
// the field should hold, so typing it again after Cmd+A mends it.
async function typeKeys(tab: number, ref: unknown, field: Field | null, text: string, whole: boolean): Promise<boolean | undefined> {
  const timeout = 10000 + text.length * 120;
  if (field === null || !whole) {
    await post(tab, ["type"], true, timeout, text);
    return field === null ? undefined : (await held(tab, ref, field, text)).kept;
  }
  await post(tab, ["type", "--gap", String(FAST_GAP_MS)], true, timeout, text);
  if ((await held(tab, ref, field, text)).kept) return true;
  await post(tab, ["key", "cmd+a"], true);
  await post(tab, ["type"], true, timeout, text);
  return (await held(tab, ref, field, text)).kept;
}

// After a Return, whether the page took the text out of the field, as a
// chat does once it has sent it; undefined where the page cannot say (it
// moved on).
async function wasSent(tab: number, ref: unknown, field: Field, text: string): Promise<boolean | undefined> {
  const r = await rpc("type_field", { tab, ...(ref === undefined ? {} : { ref }), mark: field.mark, text, sent: true }).catch(() => undefined);
  return r && typeof r === "object" && "sent" in r && typeof r.sent === "boolean" ? r.sent : undefined;
}

// The answer to text sent, within ms of the call's start (WAIT_MAX_MS at
// most): wait with changed (tools.ts), whose look was taken as typing
// began, so the agent's own line is not counted, and a reply that comes
// before the wait still is. A Philips support chat took 4 or 5 calls a
// reply, and 160 waits of 30 s (10-07).
async function replyTo(tab: number, ms: number, start: number): Promise<object> {
  const left = Math.max(0, Math.min(ms, WAIT_MAX_MS) - (Date.now() - start));
  const r = (await rpc("wait", { tab, changed: true, ms: left })) as { found?: boolean; added?: string[]; hint?: string };
  return r.found ? { reply: r.added ?? [] } : { reply: null, ...(r.hint === undefined ? {} : { hint: r.hint }) };
}

// A line break at the end of type's text sends what comes before it, as
// Return does in a chat.
const SENDS = /\r?\n$/;

// Keep native actions on one guarded path without listing another tool.
const REAL: Record<string, (tab: number, a: Record<string, unknown>) => Promise<object>> = {
  click: async (tab, a) => {
    const count = a.count ?? 1;
    if (count !== 1 && count !== 2 && count !== 3) throw new Error("count must be 1, 2, or 3");
    const button = a.button ?? "left";
    if (button !== "left" && button !== "right") throw new Error("button must be left or right");
    // A press is one click of the left button on an element: two in a row
    // are two clicks, never a double click, the right button's menu opens
    // on screen over the user's app, and a point is for what the tree
    // cannot press (a canvas).
    if (count === 1 && button === "left" && a.ref !== undefined) {
      const errors = await pressBehind(tab, a.ref);
      if (errors) return { ok: true, background: true, ...pageErrorsOf(errors) };
    }
    const at = await inFront(tab, VIA_RPC, () => clickAt(tab, a, count, button));
    return { ok: true, at };
  },
  drag: (tab, a) => inFront(tab, VIA_RPC, () => dragAt(tab, a)),
  paste: (tab, a) => inFront(tab, VIA_RPC, () => pasteAt(tab, a)),
  // Text at a field's ref is set through Safari's accessibility tree
  // (setBehind, setBoxes) and checked; elsewhere, or where the field did
  // not take it, real keys type it in front. send, a ref of the page's
  // Send button, then clicks it as a click on a ref does; a line break at
  // the end clicks the button the page shows by the field (sendButton), or
  // where it shows none presses Return; any of these only where the text
  // came out as typed. The answer says whether the page took the text
  // (sent) and, with reply, what came back.
  type: async (tab, a) => {
    const text = a.text;
    if (typeof text !== "string") throw new Error("type needs text");
    const start = Date.now();
    // one kind of line break, as a textarea holds them
    const body = text.replace(SENDS, "").replace(/\r\n?/g, "\n");
    if (a.send !== undefined && SENDS.test(text)) throw new Error("send clicks the page's Send button in place of Return: end text without a line break, or leave out send");
    const sends = SENDS.test(text) || a.send !== undefined;
    if (a.reply !== undefined && !(sends && typeof a.reply === "number" && Number.isFinite(a.reply))) {
      throw new Error("reply is how many ms to wait for an answer to text sent with send or a line break at its end");
    }
    const append = a.append === true;
    const field = await markField(tab, a.ref, body, append);
    // what the check can judge: no Tab, which real keys take as a move to
    // the next field, and line breaks only in a field that holds them
    const checkable = field !== null && body !== "" && !body.includes("\t") && (field.multiline || !body.includes("\n")) ? field : null;
    const behind = checkable === null || a.ref === undefined ? null
      : checkable.boxes > 0 ? (append ? null : await setBoxes(tab, a.ref, checkable, body))
      : !append || checkable.plain ? await setBehind(tab, a.ref, checkable, body, append)
      : null;
    const found = !a.send && sends && behind?.kept && checkable ? await sendButtonOf(tab, a.ref, checkable) : undefined;
    const sendRef = a.send ?? found?.ref;
    const returns = sends && sendRef === undefined;
    // Return goes to the focused element, so the field must have focus
    const background = !!behind?.kept && (!returns || behind.focused);
    let kept = background ? true : undefined;
    if (!background || returns) {
      await inFront(tab, VIA_RPC, async () => {
        if (!background) {
          if (a.ref !== undefined) {
            await clickAt(tab, a, 1, "left");
            // Text typed at a ref replaces the field's, as type's does unless
            // append: a click leaves the caret where it lands, and on 09-30 a
            // field on my.uscis.gov took the text only after Cmd+A (USCIS, 09-30).
            if (!append) await post(tab, ["key", "cmd+a"], true);
          }
          // Typed again after Cmd+A only where it is all the field holds,
          // and where a line break inside it could not have sent half of it.
          const whole = checkable !== null && checkable.boxes === 0 && a.ref !== undefined && !append && !body.includes("\n");
          kept = await typeKeys(tab, a.ref, checkable, body, whole);
        }
        if (returns && kept !== false) await post(tab, ["key", "Enter"], true);
      });
    }
    if (!sends) return { ok: true, ...(background ? { background: true } : {}), ...(kept === undefined ? {} : { kept }) };
    if (kept === false) return { ok: true, kept, sent: false, hint: "the field does not hold the text as typed, so it was not sent: read the field, then type it again" };
    const pressed = sendRef === undefined ? undefined : await pressBehind(tab, sendRef);
    if (pressed === null) await inFront(tab, VIA_RPC, () => clickAt(tab, { ref: sendRef }, 1, "left"));
    const sent = checkable ? await wasSent(tab, a.ref, checkable, body) : undefined;
    const answer = {
      ok: true,
      ...(background && !returns && pressed !== null ? { background: true } : {}),
      ...(found ? { sendButton: found.name } : {}),
      ...(pressed ? pageErrorsOf(pressed) : {}),
      ...(sent === undefined ? {} : { sent }),
    };
    if (sent === false) return { ...answer, hint: sendRef === undefined ? "Return left the text in the field, so the page did not send it: pass its Send button's ref as send" : "the text stayed in the field after its Send button was clicked, so the page did not send it: look at the page" };
    return typeof a.reply === "number" ? { ...answer, ...(await replyTo(tab, a.reply, start)) } : answer;
  },
  key: async (tab, a) => {
    const key = a.key;
    if (typeof key !== "string") throw new Error("key needs key");
    await inFront(tab, VIA_RPC, () => post(tab, ["key", key], true));
    return { ok: true };
  },
};

export const INPUT_TOOLS: Record<string, Tool> = {
  real_input: {
    desc: "Real mouse/keyboard when scripts fail. Ref-click and ref-type stay behind; others briefly bring the tab forward. {{code}} fills unseen codes.",
    params: {
      tab: TAB,
      do: { type: "string", enum: ["click", "type", "key"] },
      ref: REF,
      text: { type: "string", description: "to type; a final line break sends it" },
      send: { description: "Send button's ref, if the auto one misses" },
      reply: { type: "number", description: "ms to wait for the answer to sent text" },
      secret: TOOLS.type.params.secret,
      from: TOOLS.type.params.from,
      from_selector: TOOLS.type.params.from_selector,
      key: { type: "string", description: "key name or combo" },
      count: { type: "number", description: "2 or 3: double or triple click" },
      button: { type: "string", enum: ["left", "right"], description: "default left" },
    },
    unlisted: {
      do: { type: "string", enum: ["click", "type", "key", "drag", "paste"], description: "native input action" },
      x: X, y: Y, target: { description: "drag destination ref or selector" },
      targetX: X, targetY: Y,
      html: { type: "string", description: "HTML paste representation; text is the plain fallback" },
      tsv: { type: "string", description: "tab-separated paste representation" },
      append: { type: "boolean", description: "keep the field's text" }, env: SECRET_ENV,
    },
    required: ["tab", "do"],
    run: async (a) => {
      const act = typeof a.do === "string" ? REAL[a.do] : undefined;
      if (!act) throw new Error("do must be click, type, key, drag, or paste");
      const point = a.x !== undefined || a.y !== undefined;
      if (point && (!["click", "drag"].includes(String(a.do)) || a.ref !== undefined)) throw new Error("x and y need click or drag without ref");
      if (point && !(Number.isFinite(a.x) && Number.isFinite(a.y))) throw new Error("a point needs x and y, both finite numbers");
      if ((a.do === "click" || a.do === "drag") && !point && a.ref === undefined) throw new Error(`${a.do} needs ref, or x and y`);
      const targetPoint = a.targetX !== undefined || a.targetY !== undefined;
      if (a.do === "drag") {
        if (targetPoint && a.target !== undefined) throw new Error("drag needs either target or targetX/targetY, not both");
        if (targetPoint && !(Number.isFinite(a.targetX) && Number.isFinite(a.targetY))) throw new Error("a drag destination needs finite targetX and targetY");
        if (!targetPoint && a.target === undefined) throw new Error("drag needs target, or targetX and targetY");
      } else if (targetPoint || a.target !== undefined) throw new Error("target and targetX/targetY are only for drag");
      // The daemon names the tab: it alone hears the new id a deploy gave a
      // tab the agent calls by its old one, and says so in replaced.
      const { tab, ...news } = (await rpc("resolve_tab", { tab: a.tab })) as { tab: number };
      return deliveryState.run({ sent: false }, async () => {
        try {
          return { ...(await act(tab, a)), ...news };
        } catch (error) {
          if (deliveryState.getStore()?.sent && error instanceof HarnessError && error.effect === "none") {
            throw new HarnessError("effect_unknown", error.message, { next: "input already reached the page; read it before repeating this action" });
          }
          throw error;
        }
      });
    },
  },
};
