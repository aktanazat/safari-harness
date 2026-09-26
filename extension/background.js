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
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      handle(msg).then((value) => {
        if (msg.id !== undefined) send({ id: msg.id, value });
      }, (err) => {
        if (msg.id !== undefined) send({ id: msg.id, error: String(err && err.message || err) });
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
const ACTIONS = new Set(["click", "clickAt", "type", "press", "select", "upload", "history", "hover", "fillLogin"]);
// Actions that commonly load a page or open a tab a moment after they run.
const MAY_NAVIGATE = new Set(["click", "clickAt", "press", "select", "history"]);
const SETTLE_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function toTab(tabId, op, args, timeoutMs = 30000) {
  const msg = { __safariHarness: 1, id: nextId(), op, args };
  await waitReady(tabId, 15000);
  try {
    const res = await sendUntilNavigation(tabId, msg, timeoutMs);
    if (res !== undefined) return res;
  } catch (e) {
    if (e.navigated) {
      if (ACTIONS.has(op)) return { value: { ok: true } };
      await waitReady(tabId, 15000);
      const res = await sendUntilNavigation(tabId, msg, timeoutMs);
      if (res !== undefined) return res;
    }
  }
  // The page has no content script (Safari skipped injecting it, e.g. after a
  // redirect): the send rejects, or resolves undefined because no listener
  // answered. Inject it and ask once more.
  await ensureContent(tabId);
  const res = await sendUntilNavigation(tabId, msg, timeoutMs);
  if (res === undefined) throw new Error("the page did not answer; reload it with goto and retry");
  return res;
}

// Run an action and report what it caused: a new page in this tab
// (`navigated`) or a new tab (`newTab`), each once readable. A new tab that
// jumps in front while the agent works in a background tab is sent behind
// the user's tab again.
async function act(tabId, op, args) {
  const source = await api.tabs.get(tabId);
  const [front] = await api.tabs.query({ active: true, windowId: source.windowId });
  let opened = null;
  let navigated = false;
  const onCreated = (t) => {
    if (opened === null && (t.openerTabId === undefined || t.openerTabId === tabId)) opened = t.id;
  };
  // Safari repeats the unchanged url in some updates (e.g. load complete), so
  // only a new load or a different address counts as navigating.
  const onUpdated = (id, info) => {
    if (id === tabId && (info.status === "loading" || (info.url && info.url !== source.url))) navigated = true;
  };
  api.tabs.onCreated.addListener(onCreated);
  api.tabs.onUpdated.addListener(onUpdated);
  try {
    const res = await toTab(tabId, op, args);
    if (res && res.error) return res;
    if (opened === null && !navigated && MAY_NAVIGATE.has(op)) await sleep(SETTLE_MS);
    const value = { ...(res && res.value) };
    if (navigated) {
      await waitReady(tabId, 20000);
      const t = await api.tabs.get(tabId);
      value.navigated = { url: t.url, title: t.title };
    }
    if (opened !== null) {
      if (front && !source.active) await api.tabs.update(front.id, { active: true });
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
function sendUntilNavigation(tabId, msg, ms) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(t); api.tabs.onUpdated.removeListener(onNav); };
    const onNav = (id, info) => {
      if (id !== tabId || info.status !== "loading") return;
      stop();
      reject(Object.assign(new Error("page navigated"), { navigated: true }));
    };
    const t = setTimeout(() => { stop(); reject(new Error(`tab ${ms}ms timeout`)); }, ms);
    api.tabs.onUpdated.addListener(onNav);
    api.tabs.sendMessage(tabId, msg).then((v) => { stop(); resolve(v); }, (err) => { stop(); reject(err); });
  });
}

async function ensureContent(tabId) {
  try {
    await api.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    log("inject failed", String(e));
  }
}

// ---------- handlers ----------

async function handle(msg) {
  const { op, args = [] } = msg;
  switch (op) {
    case "tabs.list": {
      const tabs = await api.tabs.query({});
      return tabs
        .filter((t) => t.id !== undefined)
        .map((t) => ({ id: t.id, url: t.url, title: t.title, active: !!t.active, windowId: t.windowId }));
    }
    case "tabs.open": {
      const [url, background] = args;
      const tab = await api.tabs.create({ url: url || "about:blank", active: !background });
      if (ready.get(tab.id) !== true) ready.set(tab.id, false);
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
      try {
        await api.tabs.remove(tabId);
        await gone;
      } finally {
        api.tabs.onRemoved.removeListener(onRemoved);
      }
      return { ok: true };
    }
    case "tabs.navigate": {
      const [tabId, url] = args;
      ready.set(tabId, false);
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
      const [tabId, domOp, domArgs] = args;
      const res = ACTIONS.has(domOp) ? await act(tabId, domOp, domArgs) : await toTab(tabId, domOp, domArgs);
      if (res && res.error) throw new Error(res.error);
      return res && res.value;
    }
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
});
api.runtime.onMessage.addListener((m, sender) => {
  if (m && m.__safariHarnessReady === 1 && sender.tab) markReady(sender.tab.id);
});

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
