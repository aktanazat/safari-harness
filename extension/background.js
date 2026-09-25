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

async function toTab(tabId, op, args, timeoutMs = 30000) {
  const msg = { __safariHarness: 1, id: nextId(), op, args };
  // content script may not be injected yet (e.g. added after page load):
  // try sendMessage, fall back to scripting.executeScript then retry.
  try {
    return await withTimeout(api.tabs.sendMessage(tabId, msg), timeoutMs);
  } catch (e) {
    await ensureContent(tabId);
    return await withTimeout(api.tabs.sendMessage(tabId, msg), timeoutMs);
  }
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`tab ${ms}ms timeout`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
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
      await waitLoaded(tab.id, 15000);
      return { id: tab.id, url: tab.url, title: tab.title };
    }
    case "tabs.close": {
      const [tabId] = args;
      await api.tabs.remove(tabId);
      return { ok: true };
    }
    case "tabs.navigate": {
      const [tabId, url] = args;
      await api.tabs.update(tabId, { url });
      await waitLoaded(tabId, 20000);
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
    case "tabs.createWindow": {
      const [url] = args;
      const w = await api.windows.create({ url: url || "about:blank", focused: true });
      const tab = w.tabs && w.tabs[0];
      if (tab) await waitLoaded(tab.id, 15000);
      return { windowId: w.id, tabId: tab && tab.id };
    }
    case "relay": {
      const [tabId, domOp, domArgs] = args;
      const res = await toTab(tabId, domOp, domArgs);
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
function waitLoaded(tabId, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      api.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    api.tabs.onUpdated.addListener(listener);
    api.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(); }, () => finish());
    const timer = setTimeout(finish, ms);
  });
}

connect();
pingLoop();

// also respond to direct messages (for future popup UI)
api.runtime.onMessage.addListener(() => {});
