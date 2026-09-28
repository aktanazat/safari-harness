// Safari Harness background page (MV3 non-persistent background script).
// Maintains a WebSocket to the local daemon (ws://127.0.0.1:PORT) and
// relays daemon requests to content scripts in the target tab.
// Tab management (open/close/navigate/list) is handled here directly.

const api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;

const DEFAULT_PORT = 37333;
let ws = null;
let reconnectTimer = null;
let backoff = 500;
let port = DEFAULT_PORT;

function log(...a) { console.log("[sh-bg]", ...a); }

async function getPort() {
  try {
    const { daemonPort } = await api.storage.local.get("daemonPort");
    return daemonPort || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  getPort().then((p) => {
    port = p;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      backoff = 500;
      log("connected to daemon on", port);
      send({ op: "hello", role: "extension", ua: navigator.userAgent });
      if (awake.size > 0) send({ op: "ticks", on: true });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.op === "tick") return tick();
      handle(msg).then((value) => {
        if (msg.id !== undefined) send({ id: msg.id, value });
      }, (err) => {
        const text = String(err && err.message || err);
        // Safari gives every tab a new id when the extension restarts.
        if (msg.id !== undefined) send({ id: msg.id, error: /Tab not found|Tab '\d+' was not found/.test(text) ? "that tab is gone: it was closed, or Safari gave every tab a new id when the extension restarted; find it with tabs" : text });
      });
    };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 10000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// keep the worker alive while connected
function pingLoop() {
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) send({ op: "ping" });
    else connect();
  }, 20000);
}

// ---------- request relay ----------

function nextId() { nextId.n = (nextId.n || 0) + 1; return `r${nextId.n}`; }

// Ops that act on the page. If the page navigates while one is pending, the
// action caused it: report that instead of re-sending (never act twice).
const ACTIONS = new Set(["click", "clickAt", "type", "press", "select", "upload", "history", "hover", "fillLogin", "fillCode"]);
// How long an action's predicted change may take to start (see withOutcome
// in content.js): a load or tab it surely began, or a move the page's script
// may make. Anything else returns at once.
const START_MS = { load: 3000, tab: 3000, script: 400 };

async function toTab(tabId, op, args, timeoutMs = 30000, frameId = 0) {
  const msg = { __safariHarness: 1, id: nextId(), op, args };
  keepAwake(tabId);
  await waitReady(tabId, 15000);
  // A read asked of a page that navigates (a redirect, or a chain of them)
  // is asked again of each new page, until its time runs out.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await sendUntilNavigation(tabId, msg, Math.max(deadline - Date.now(), 1000), frameId);
      if (res !== undefined) return res;
      break;
    } catch (e) {
      if (!e.navigated) break;
      if (ACTIONS.has(op)) return { value: { ok: true } };
      if (Date.now() >= deadline) throw new Error("the page kept navigating; read it again once it settles");
      await waitReady(tabId, 15000);
    }
  }
  // The page has no content script (Safari skipped injecting it, e.g. after a
  // redirect): the send rejects, or resolves undefined because no listener
  // answered. Inject it and ask once more.
  await ensureContent(tabId, frameId);
  const res = await sendUntilNavigation(tabId, msg, timeoutMs, frameId);
  if (res !== undefined) return res;
  const { url } = await api.tabs.get(tabId);
  throw new Error(`the page at ${url || "about:blank"} did not answer; reload it with goto and retry`);
}

// Run an action and report what it caused: a new page in this tab
// (`navigated`) or a new tab (`newTab`), each once readable. A new tab that
// jumps in front while the agent works in a background tab is sent behind
// the user's tab again.
async function act(tabId, op, args, timeoutMs, frameId = 0) {
  const source = await api.tabs.get(tabId);
  const [front] = await api.tabs.query({ active: true, windowId: source.windowId });
  let opened = null;
  let navigated = false;
  let wake = () => {};
  // A new tab reads "complete" while still blank, so it is not ready until
  // its page reports in (as for tabs.open).
  const onCreated = (t) => {
    if (opened !== null || (t.openerTabId !== undefined && t.openerTabId !== tabId)) return;
    opened = t.id;
    if (ready.get(t.id) !== true) ready.set(t.id, false);
    wake();
  };
  // Safari repeats the unchanged url in some updates (e.g. load complete), so
  // only a new load or a different address counts as navigating.
  const onUpdated = (id, info) => {
    if (id === tabId && (info.status === "loading" || (info.url && info.url !== source.url))) { navigated = true; wake(); }
  };
  api.tabs.onCreated.addListener(onCreated);
  api.tabs.onUpdated.addListener(onUpdated);
  try {
    const res = await toTab(tabId, op, args, timeoutMs, frameId);
    if (res && res.error) return res;
    const { expect, ...value } = (res && res.value) || {};
    const ms = START_MS[expect];
    if (ms && opened === null && !navigated) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    if (navigated) {
      await waitReady(tabId, 20000);
      const t = await api.tabs.get(tabId);
      value.navigated = { url: t.url, title: t.title };
    }
    if (opened !== null) {
      if (front && !source.active) await api.tabs.update(front.id, { active: true });
      if (await ownsTab(tabId)) await ownTab(opened);
      await waitReady(opened, 20000);
      const t = await api.tabs.get(opened);
      value.newTab = { id: t.id, url: t.url, title: t.title };
    }
    return { value };
  } finally {
    api.tabs.onCreated.removeListener(onCreated);
    api.tabs.onUpdated.removeListener(onUpdated);
  }
}

// Safari never settles a message whose page unloads mid-request, so race it
// against the tab starting a new load.
function sendUntilNavigation(tabId, msg, ms, frameId = 0) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(t); api.tabs.onUpdated.removeListener(onNav); };
    const onNav = (id, info) => {
      if (id !== tabId || info.status !== "loading") return;
      stop();
      reject(Object.assign(new Error("page navigated"), { navigated: true }));
    };
    const t = setTimeout(() => { stop(); reject(new Error(`tab ${ms}ms timeout`)); }, ms);
    api.tabs.onUpdated.addListener(onNav);
    api.tabs.sendMessage(tabId, msg, { frameId }).then((v) => { stop(); resolve(v); }, (err) => { stop(); reject(err); });
  });
}

async function ensureContent(tabId, frameId = 0) {
  try {
    await api.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["content.js"],
    });
  } catch (e) {
    log("inject failed", String(e));
  }
}

// ---------- embedded frames ----------
// A ref from an embedded frame reads "f<frameId>:<ref>"; actions on it go to
// that frame. A selector or text the top page lacks is looked for in each
// frame in turn.
const FRAME_REF = /^f(\d+):(.+)$/;

function frameOf(args) {
  const m = Array.isArray(args) && typeof args[0] === "string" ? FRAME_REF.exec(args[0]) : null;
  return m ? { frameId: Number(m[1]), args: [m[2], ...args.slice(1)] } : { frameId: 0, args };
}

// Frame id -> the token its content script printed into its parent's snapshot.
async function frameTokens(tabId) {
  const results = await api.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => window.__safariHarnessFrame || null });
  const byToken = new Map();
  for (const r of results) if (r.frameId !== 0 && typeof r.result === "string") byToken.set(r.result, r.frameId);
  return byToken;
}

const MARK = / @@frame:([a-z0-9]+)@@$/;

// A frame that loaded before its parent's script listened may not have told
// the parent which frame it is, so its lines have no place in the parent's
// snapshot. The parent says hello to such frames (unlinked in content.js),
// and one more snapshot, after their answers, places them.
async function snapshotFrame(tabId, args, timeoutMs, frameId) {
  let res = await toTab(tabId, "snapshot", args, timeoutMs, frameId);
  if (res && res.value && res.value.unlinked) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    res = await toTab(tabId, "snapshot", args, timeoutMs, frameId);
  }
  if (res && res.value) delete res.value.unlinked;
  return res;
}

// Puts each embedded frame's own snapshot under its <iframe> line, with
// its refs prefixed by the frame's id. Frames nest, so this recurses.
async function stitchFrames(tabId, snap, opts, tokens, depth) {
  const lines = snap.snapshot.split("\n");
  if (!lines.some((l) => MARK.test(l))) return snap;
  tokens ??= await frameTokens(tabId);
  const out = [];
  let truncated = snap.truncated;
  const limit = opts.maxNodes || 600;
  // "a|b" keeps lines containing either, as in the frame's own snapshot
  const alts = String(opts.query ?? "").toLowerCase().split("|").map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const m = MARK.exec(line);
    if (!m) { out.push(line); continue; }
    const head = line.replace(MARK, "");
    const frameId = tokens.get(m[1]);
    let inner = [];
    if (frameId !== undefined && depth < 4 && out.length < limit) {
      try {
        const res = await snapshotFrame(tabId, [{ ...opts, root: undefined, refPrefix: `f${frameId}:`, maxNodes: Math.max(50, limit - out.length) }], 10000, frameId);
        if (res && res.value && typeof res.value.snapshot === "string") {
          const child = await stitchFrames(tabId, res.value, opts, tokens, depth + 1);
          truncated ||= child.truncated;
          inner = child.snapshot ? child.snapshot.split("\n") : [];
        }
      } catch (e) {
        log("frame snapshot failed", frameId, String(e));
      }
    }
    // with a query, the frame's line stood in for its matches
    if (!opts.query || alts.some((a) => head.toLowerCase().includes(a))) out.push(head);
    const indent = opts.query ? "" : head.match(/^ */)[0] + "  ";
    for (const l of inner) out.push(indent + l);
  }
  return { ...snap, snapshot: out.join("\n"), nodes: out.length, truncated };
}

const MISS = /^nothing on the page matches /;

// Runs a DOM op in the frame its ref names, or in frameId when the daemon
// names the frame; a text or selector the top page lacks is tried in each
// embedded frame. A snapshot takes in the frames' own snapshots, and a wait
// watches every frame.
async function relayOp(tabId, domOp, domArgs, timeoutMs, frame) {
  if (domOp === "wait") return waitInFrames(tabId, domArgs, timeoutMs);
  if (domOp === "waitStop") {
    for (const w of frameWaits.get(tabId)?.values() ?? []) w.stop();
    return { value: { ok: true } };
  }
  const { frameId, args } = frame ? { frameId: frame, args: domArgs } : frameOf(domArgs);
  if (domOp === "snapshot") {
    const res = await snapshotFrame(tabId, args, timeoutMs, frameId);
    if (res && res.value && typeof res.value.snapshot === "string") return { value: await stitchFrames(tabId, res.value, (args && args[0]) || {}, null, 0) };
    return res;
  }
  const send = (id) => ACTIONS.has(domOp) ? act(tabId, domOp, args, timeoutMs, id) : toTab(tabId, domOp, args, timeoutMs, id);
  const res = await send(frameId);
  if (frameId === 0 && res && typeof res.error === "string" && MISS.test(res.error)) {
    const tokens = await frameTokens(tabId).catch(() => new Map());
    for (const id of tokens.values()) {
      const r = await send(id).catch(() => null);
      if (r && !(typeof r.error === "string" && MISS.test(r.error))) return r;
    }
  }
  return res;
}

// ---------- waiting in every frame ----------
// A wait is answered by whichever frame shows the text or selector first (a
// sign-in form often sits in an embedded frame), and a frame that loads
// meanwhile joins in. The top page's answer stands for the whole tab: a
// miss there (stopped, or ended by a newer wait) ends the wait. waitStop
// from the daemon, at its time limit, ends it in every frame; the wait's id
// keeps that from ending a newer wait in the same frame.
const frameWaits = new Map(); // tabId -> Map of wait id -> { join, stop }

function waitInFrames(tabId, args, timeoutMs) {
  const id = nextId();
  const deadline = Date.now() + timeoutMs;
  const asked = new Set();
  const waits = frameWaits.get(tabId) || new Map();
  frameWaits.set(tabId, waits);
  return new Promise((resolve, reject) => {
    const end = (settle) => {
      if (!waits.delete(id)) return;
      if (waits.size === 0 && frameWaits.get(tabId) === waits) frameWaits.delete(tabId);
      const stop = { __safariHarness: 1, id: nextId(), op: "waitStop", args: [id] };
      for (const frameId of asked) api.tabs.sendMessage(tabId, stop, { frameId }).catch(() => {});
      settle();
    };
    const join = (frameId) => {
      asked.add(frameId);
      toTab(tabId, "wait", [args[0] ?? null, args[1] ?? null, id], Math.max(deadline - Date.now(), 1000), frameId).then((res) => {
        if (frameId === 0 || (res && res.value && res.value.found)) end(() => resolve(res));
      }, (e) => { if (frameId === 0) end(() => reject(e)); });
    };
    waits.set(id, { join, stop: () => end(() => resolve({ value: { found: false } })) });
    join(0);
    frameTokens(tabId).then((tokens) => { for (const frameId of tokens.values()) if (waits.has(id)) join(frameId); }, () => {});
  });
}

// Asks every frame of the tab at once what it holds (__safariHarnessProbe
// in content.js), top page first: a sign-in form or a bot check may sit in
// an embedded frame of another site.
async function probeFrames(tabId, what, arg) {
  keepAwake(tabId);
  await waitReady(tabId, 15000);
  const ask = () => api.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (w, a) => (window.__safariHarnessProbe ? window.__safariHarnessProbe[w](a) : null),
    args: [what, arg ?? null],
  });
  let results = await ask();
  // Safari skipped injecting the top page's script (after a redirect): add it.
  if (!results.some((r) => r.frameId === 0 && r.result)) {
    await ensureContent(tabId, 0);
    results = await ask();
  }
  const found = results.filter((r) => r.result);
  return [...found.filter((r) => r.frameId === 0), ...found.filter((r) => r.frameId !== 0)].map((r) => ({ frame: r.frameId, ...r.result }));
}

// ---------- network and console capture ----------
// Both are read in the page's own world: the content script's fetch, XHR,
// and console are its own copies. dialogs.js logs requests in every frame
// from the start of each page's load, since a page may keep its own copy
// of fetch from its first script; start clears the log and stop ends it.
// The console patch goes in on the first start, so a page carries it only
// when asked.
const CAPTURE = { net: "net", netRead: "net", console: "console", consoleRead: "console" };

async function capture(tabId, op, args) {
  const kind = CAPTURE[op];
  const cmd = op.endsWith("Read") ? "read" : args && args[0] ? "start" : "stop";
  if (kind === "console") {
    const [res] = await api.scripting.executeScript({ target: { tabId }, world: "MAIN", func: pageCapture, args: [kind, cmd] });
    return res && res.result;
  }
  const inFrames = () => api.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: pageCapture, args: [kind, cmd] });
  const logging = (results) => results.some((r) => r.frameId === 0 && r.result);
  let results = await inFrames();
  // Safari skipped the page's script (after a redirect): add it, to log
  // from now on.
  if (!logging(results)) {
    await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", files: ["dialogs.js"] });
    results = await inFrames();
    if (!logging(results)) throw new Error("this page is not logging its requests: reload it (history, do: reload), then use net again");
  }
  if (cmd !== "read") return { ok: true };
  const entries = results.flatMap((r) => (Array.isArray(r.result) ? r.result.map((e) => (r.frameId ? { ...e, frame: r.frameId } : e)) : []));
  return { entries: entries.sort((a, b) => a.t - b.t).slice(-100) };
}

// Runs in the page, so it must be self-contained.
function pageCapture(kind, cmd) {
  if (kind === "net") {
    const net = window[Symbol.for("safari-harness.page")]?.net;
    if (!net) return null;
    if (cmd === "read") return net.log.slice(-100);
    net.on = cmd === "start";
    if (net.on) net.log.length = 0;
    return true;
  }
  const key = Symbol.for("safari-harness.capture");
  let s = window[key];
  if (!s) {
    s = window[key] = { console: { on: false, log: [] } };
    for (const level of ["log", "warn", "error"]) {
      const orig = console[level];
      console[level] = function (...args) {
        const c = s.console;
        if (c.on) {
          c.log.push({ level, text: args.map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 500), t: Date.now() });
          if (c.log.length > 500) c.log.shift();
        }
        return orig.apply(this, args);
      };
    }
  }
  const c = s.console;
  if (cmd === "read") return { entries: c.log.slice(-100) };
  c.on = cmd === "start";
  if (c.on) c.log.length = 0;
  return { ok: true };
}

// Runs in the page's own world, so it must be self-contained. A page that
// demands Trusted Types (YouTube, Google) refuses a plain string, so the
// code goes through a policy of our own; a page whose policy forbids eval
// outright, or names the only policies it allows, still refuses it.
async function pageEval(src) {
  const code = `return (${src})`;
  try {
    let v;
    try {
      v = await new Function(code)();
    } catch (e) {
      if (!globalThis.trustedTypes || !/Trusted ?Type/i.test(String(e && e.message))) throw e;
      const policy = trustedTypes.createPolicy(`safari-harness-${Math.random().toString(36).slice(2)}`, { createScript: (s) => s });
      v = await new Function(policy.createScript(code))();
    }
    // Safari passes this result on as JSON and aborts the whole browser on a
    // NaN or Infinity anywhere in it, so it leaves as plain JSON.
    if (v === undefined) return { ok: true, result: null };
    if (typeof v === "number" && !Number.isFinite(v)) return { ok: true, result: String(v) };
    try { return { ok: true, result: JSON.parse(JSON.stringify(v)) }; } catch { return { ok: true, result: String(v) }; }
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

// ---------- screenshots ----------
// Safari captures only a window's visible tab: a tab behind another comes
// to the front for the capture and the tab that was there goes back. All
// that needs no drawing (the element's box, the page's height, the ref
// labels) happens first, so the user's tab is away only while the picture
// is taken. A tab in its own window (the window tool) is captured where it
// is.
async function dataUrlBitmap(url) {
  return createImageBitmap(await (await fetch(url)).blob());
}

async function pngOf(canvas) {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function pageValue(tabId, op, args) {
  const res = await toTab(tabId, op, args, 10000);
  if (res && res.error) throw new Error(res.error);
  return res && res.value;
}

const FULL_PAGE_MAX = 12; // screens

async function screenshot(tabId, opts) {
  const t = await api.tabs.get(tabId);
  const [front] = await api.tabs.query({ active: true, windowId: t.windowId });
  const flip = front && front.id !== tabId;
  const box = opts.ref ? await relayOp(tabId, "rect", [opts.ref], 10000).then((r) => { if (r && r.error) throw new Error(r.error); return r.value; }) : null;
  const page = opts.fullPage && !box ? await pageValue(tabId, "eval", ["({ h: document.documentElement.scrollHeight, y: scrollY, ih: innerHeight, iw: innerWidth })"]).then((v) => v.result) : null;
  const grab = () => api.tabs.captureVisibleTab(t.windowId, { format: "png" });
  const shots = [];
  try {
    if (opts.annotate) await pageValue(tabId, "annotate", [true]);
    if (flip) await api.tabs.update(tabId, { active: true });
    try {
      await toTab(tabId, "painted", [], 3000).catch(() => {});
      if (!page) shots.push({ y: 0, url: await grab() });
      for (let y = 0; page && y < page.h && shots.length < FULL_PAGE_MAX; y += page.ih) {
        await pageValue(tabId, "eval", [`(scrollTo(0, ${y}), scrollY)`]);
        await toTab(tabId, "painted", [], 3000).catch(() => {});
        shots.push({ y: (await pageValue(tabId, "eval", ["scrollY"])).result, url: await grab() });
      }
    } finally {
      if (flip) await api.tabs.update(front.id, { active: true });
    }
  } finally {
    if (page) await pageValue(tabId, "eval", [`(scrollTo(0, ${page.y}), 1)`]).catch(() => {});
    if (opts.annotate) await pageValue(tabId, "annotate", [false]).catch(() => {});
  }
  if (!box && shots.length === 1) return { data: shots[0].url.replace(/^data:[^,]*,/, "") };
  const first = await dataUrlBitmap(shots[0].url);
  if (box) {
    const scale = first.width / box.innerWidth;
    const x = Math.max(0, Math.floor(box.x * scale));
    const y = Math.max(0, Math.floor(box.y * scale));
    const w = Math.max(1, Math.min(first.width - x, Math.ceil(box.width * scale)));
    const h = Math.max(1, Math.min(first.height - y, Math.ceil(box.height * scale)));
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d").drawImage(first, x, y, w, h, 0, 0, w, h);
    return { data: await pngOf(c) };
  }
  const scale = first.width / page.iw;
  const height = Math.min(Math.ceil(page.h * scale), Math.ceil((shots[shots.length - 1].y + page.ih) * scale));
  const c = new OffscreenCanvas(first.width, height);
  const ctx = c.getContext("2d");
  for (const s of shots) ctx.drawImage(s === shots[0] ? first : await dataUrlBitmap(s.url), 0, Math.round(s.y * scale));
  return { data: await pngOf(c), screens: shots.length, cut: shots.length === FULL_PAGE_MAX && page.h > FULL_PAGE_MAX * page.ih };
}

// ---------- handlers ----------

async function handle(msg) {
  const { op, args = [] } = msg;
  switch (op) {
    case "tabs.list": {
      const tabs = await api.tabs.query({});
      // Every window has an active tab; front is the one in the window the
      // user had in front last, the tab tab: "front" names.
      const focused = await api.windows.getLastFocused().then((w) => w.id, () => undefined);
      return tabs
        .filter((t) => t.id !== undefined)
        .map((t) => ({ id: t.id, url: t.url, title: t.title, active: !!t.active, windowId: t.windowId, ...(t.active && t.windowId === focused ? { front: true } : {}) }));
    }
    case "tabs.open": {
      const [url, background] = args;
      const tab = await api.tabs.create({ url: url || "about:blank", active: !background });
      if (ready.get(tab.id) !== true) ready.set(tab.id, false);
      if (background) await ownTab(tab.id);
      await waitReady(tab.id, 15000);
      const t = await api.tabs.get(tab.id);
      return { id: t.id, url: t.url, title: t.title };
    }
    case "tabs.close": {
      const [tabId] = args;
      // resolve once Safari has dropped the tab, so a following list omits it
      let onRemoved;
      const gone = new Promise((resolve) => {
        onRemoved = (id) => { if (id === tabId) resolve(); };
        api.tabs.onRemoved.addListener(onRemoved);
      });
      // A native sheet on the tab (a sign-in or permission prompt) or a
      // window off screen can hold it open, and Safari then never answers:
      // on 09-27 three closes each hung 30 s behind an Apple sign-in sheet.
      let timer;
      const stuck = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Safari did not close the tab within 5 s: a native sheet (a sign-in or permission prompt) or a window off screen holds it. Tell the user; closing again will not help")), 5000);
      });
      try {
        await Promise.race([api.tabs.remove(tabId).then(() => gone), stuck]);
      } finally {
        clearTimeout(timer);
        api.tabs.onRemoved.removeListener(onRemoved);
      }
      return { ok: true };
    }
    case "tabs.navigate": {
      const [tabId, url] = args;
      ready.set(tabId, false);
      keepAwake(tabId);
      await api.tabs.update(tabId, { url });
      await waitReady(tabId, 20000);
      const t = await api.tabs.get(tabId);
      return { id: t.id, url: t.url, title: t.title };
    }
    case "tabs.activate": {
      const [tabId] = args;
      const t = await api.tabs.get(tabId);
      await api.windows.update(t.windowId, { focused: true });
      await api.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    case "relay": {
      const [tabId, domOp, domArgs, timeoutMs, frameId] = args;
      if (domOp in CAPTURE) return capture(tabId, domOp, domArgs);
      const res = await relayOp(tabId, domOp, domArgs, timeoutMs, frameId);
      if (res && res.error) throw new Error(res.error);
      return res && res.value;
    }
    case "probe":
      return probeFrames(args[0], args[1], args[2]);
    case "daemonPort": {
      port = args[0];
      await api.storage.local.set({ daemonPort: port });
      try { ws.close(); } catch {}
      ws = null;
      connect();
      return { ok: true };
    }
    case "windows.focus": {
      const [windowId] = args;
      await api.windows.update(windowId, { focused: true });
      return { ok: true };
    }
    case "cookies": {
      const [url] = args;
      if (!url || url.startsWith("about:")) return [];
      const all = await api.cookies.getAll({ url });
      return all.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate }));
    }
    case "cookies.set": {
      const [cookie] = args;
      const c = await api.cookies.set(cookie);
      if (!c) throw new Error("Safari refused the cookie; check its url, domain, and secure flag");
      return { ok: true, name: c.name, domain: c.domain, path: c.path };
    }
    case "dialogs": {
      const [tabId, policy] = args;
      if (policy) await store.set({ [`dialogs:${tabId}`]: policy });
      const res = await toTab(tabId, "dialogs", [policy || null]);
      if (res && res.error) throw new Error(res.error);
      return res && res.value;
    }
    case "evalPage": {
      const [tabId, src, ref] = args;
      const { frameId } = frameOf([ref || ""]);
      keepAwake(tabId);
      const [r] = await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func: pageEval, args: [src] });
      if (!r) throw new Error("the page did not run it");
      if (r.result && r.result.error) throw new Error(r.result.error);
      return r.result;
    }
    case "fetchFile": {
      const [url] = args;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const blob = await res.blob();
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      return { name: "", type: blob.type, size: blob.size, disposition: res.headers.get("content-disposition"), url: res.url, data };
    }
    case "shot":
      return screenshot(args[0], args[1] || {});
    case "window": {
      const [tabId, size] = args;
      const t = await api.tabs.get(tabId);
      const alone = (await api.tabs.query({ windowId: t.windowId })).length === 1;
      const dims = { width: Math.round(size.width), height: Math.round(size.height) };
      if (alone) await api.windows.update(t.windowId, { ...dims, state: "normal" });
      else {
        const w = await api.windows.create({ tabId, focused: false, ...dims });
        await api.windows.update(w.id, dims);
      }
      const r = await toTab(tabId, "tabInfo", []);
      return { ok: true, windowId: (await api.tabs.get(tabId)).windowId, viewport: r && r.value && r.value.viewport };
    }
    case "ping":
      return "pong";
    default:
      throw new Error(`unknown bg op ${op}`);
  }
}


// Safari suspends idle workers; alarms wake us back up to reconnect.
if (api.alarms) {
  api.alarms.create("sh-keepalive", { periodInMinutes: 0.5 });
  api.alarms.onAlarm.addListener((a) => { if (a.name === "sh-keepalive") connect(); });
}

// ---------- page readiness ----------
// A tab is ready once its document's content script has reported in, or the
// tab reports "complete" (pages where content scripts cannot run). Waiting
// for "complete" alone also waits on ads and trackers: seconds more.
const ready = new Map(); // tabId -> true once the current document is ready
const readyWaiters = new Map(); // tabId -> Set of resolvers

function markReady(tabId) {
  ready.set(tabId, true);
  const waiters = readyWaiters.get(tabId);
  if (!waiters) return;
  readyWaiters.delete(tabId);
  for (const w of waiters) w();
}

api.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading") ready.set(id, false);
  else if (info.status === "complete") markReady(id);
});
api.tabs.onRemoved.addListener((id) => {
  markReady(id);
  ready.delete(id);
  awake.delete(id);
  store.remove(`dialogs:${id}`).catch(() => {});
});
// Embedded frames report too; only the top document makes the tab ready, and
// a frame that loads while a wait runs (a sign-in frame) joins the wait.
// Each gets back how to answer dialogs, if the harness owns its tab.
api.runtime.onMessage.addListener((m, sender) => {
  if (!m || m.__safariHarnessReady !== 1 || !sender.tab) return;
  if (!sender.frameId) markReady(sender.tab.id);
  else for (const w of frameWaits.get(sender.tab.id)?.values() ?? []) w.join(sender.frameId);
  return policyOf(sender.tab.id).then((dialogs) => ({ dialogs }));
});

// ---------- owned tabs ----------
// A tab the harness opened in the background, and any tab it opened in
// turn, answers its own dialogs (dismissing them unless the dialog tool
// says accept). The answer is kept per tab, so each new page in it gets it.
const store = api.storage.session || api.storage.local;

async function policyOf(tabId) {
  const key = `dialogs:${tabId}`;
  return (await store.get(key))[key] || null;
}

async function ownsTab(tabId) {
  return (await policyOf(tabId)) !== null;
}

// Also tells the page, which may have reported in before the tab was owned.
async function ownTab(tabId) {
  const policy = (await policyOf(tabId)) || { accept: false, text: null };
  await store.set({ [`dialogs:${tabId}`]: policy });
  await toTab(tabId, "dialogs", [policy], 5000).catch(() => {});
}

// ---------- keeping owned tabs running ----------
// Safari draws nothing in a hidden tab and soon nearly stops its timers, so
// a web app in a background harness tab stalls. An owned tab the harness
// works in gets a tick every 50 ms in each frame, until a minute after the
// last request to it; dialogs.js runs the page's due frame callbacks and
// timers on each tick while the tab is hidden. A tab left open and unused
// stops ticking, so a forgotten tab costs nothing. The ticks come from the
// daemon, whose clock Safari leaves alone: it holds this page's timers to
// four a second.
const AWAKE_MS = 60000;
const awake = new Map(); // tabId -> when its ticks stop

function keepAwake(tabId) {
  ownsTab(tabId).then((owned) => {
    if (!owned) return;
    if (awake.size === 0) send({ op: "ticks", on: true });
    awake.set(tabId, Date.now() + AWAKE_MS);
  }, () => {});
}

// Each frame of an owned tab connects a "ticks" port (see takeTicks in
// content.js); the port closes with its page.
const tickPorts = new Map(); // tabId -> Set of ports, one per frame
api.runtime.onConnect.addListener((port) => {
  const id = port.sender && port.sender.tab && port.sender.tab.id;
  if (port.name !== "ticks" || id === undefined) return;
  if (!tickPorts.has(id)) tickPorts.set(id, new Set());
  tickPorts.get(id).add(port);
  port.onDisconnect.addListener(() => {
    const ports = tickPorts.get(id);
    ports?.delete(port);
    if (ports?.size === 0) tickPorts.delete(id);
  });
});

function tick() {
  const now = Date.now();
  for (const [id, until] of awake) {
    if (until < now) awake.delete(id);
    else for (const port of tickPorts.get(id) || []) port.postMessage(1);
  }
  if (awake.size === 0) send({ op: "ticks", on: false });
}

// Resolves when the tab is ready, or after ms regardless.
function waitReady(tabId, ms) {
  if (ready.get(tabId) === true) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      readyWaiters.get(tabId)?.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (!readyWaiters.has(tabId)) readyWaiters.set(tabId, new Set());
    readyWaiters.get(tabId).add(done);
    // tabs that loaded before this background page started have no entry yet
    if (!ready.has(tabId)) api.tabs.get(tabId).then((t) => { if (t.status === "complete") markReady(tabId); }, done);
  });
}

connect();
pingLoop();
