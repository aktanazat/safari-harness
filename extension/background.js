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

// The daemon refuses the copy of this extension in a Safari that Apple's
// safaridriver launched for WebDriver, with 4002 (automation.ts): that
// copy sees none of the user's windows, so it stops trying for good.
let automationCopy = false;

// Each socket's handlers act on that socket alone. They once used the
// latest one: an old socket closing after its replacement opened dropped
// the new one and opened a third, and a request's answer went out on
// whichever socket was newest. The daemon then saw each socket miss its
// ping and swapped them every 1.5 s, failing every request (09-29).
function connect() {
  if (automationCopy) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  getPort().then((p) => {
    // another wake-up may have connected while the port was read
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    port = p;
    let sock;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      backoff = 500;
      log("connected to daemon on", port);
      send({ op: "hello", role: "extension", ua: navigator.userAgent });
      if (awake.size > 0) send({ op: "ticks", on: true });
      sendRecordings().catch(() => {});
      // the new ids a reload gave the tabs (sendIds); an adopt not begun
      // yet sends them itself once it ends
      adopted?.then(sendIds, () => {});
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.op === "tick") return tick();
      // The daemon asks for this once the extension has answered nothing
      // for a minute, or when safari extension reload asks (bridge.ts):
      // Safari unloads it and loads it again, as turning it off and on in
      // Safari Settings does, but asks for no password (10-13). Nothing
      // answers it: this page goes with the reload.
      if (msg.op === "reload") return api.runtime.reload();
      const answer = (obj) => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj)); };
      handle(msg).then((value) => {
        if (msg.id !== undefined) answer({ id: msg.id, value });
      }, async (err) => {
        if (msg.id === undefined) return;
        const text = String(err && err.message || err);
        // An id Safari no longer knows that no reload maps (adopt): the
        // answer says what closed its tab, as far as this page saw (goneText).
        const lost = /Tab not found|Tab '(\d+)' was not found/.exec(text);
        answer({ id: msg.id, error: lost ? await goneText(Number(lost[1] ?? msg.args?.[0])) : text });
      });
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      clearTimeout(memoryTimer);
      memoryPolicy = { enabled: false, sites: [], excludedSites: [] };
      memoryRevision = -1;
      if (ev.code === 4002) automationCopy = true;
      else scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  });
}

// The daemon comes back within seconds of a restart, and a request waits
// for the extension only briefly (CONNECT_MS in bridge.ts), so retries stay
// close together.
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 2000);
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

// Ops that only read the page. If the page navigates while one is pending
// (a redirect, or a chain of them), it is asked again of each new page. Any
// other op may act on the page, so a navigation while it is pending is what
// it caused: act reports that instead of sending it again (never act twice).
const READS = new Set(["snapshot", "extract", "tabInfo", "locate", "element", "painted", "wait", "data", "lookalikes", "pressMark", "pressDone", "typeMark", "typeField", "sendButton", "netBody", "memoryPage", "clickProbe", "assertFrameClickable"]);
// How long an action's predicted change may take to start (see withOutcome
// in content.js): a load or tab it surely began, or a move the page's script
// may make. Anything else returns at once.
const START_MS = { load: 3000, tab: 3000, script: 400 };
// How long a page gets to show its script is there. A page that answers
// nothing (a dialog open on it, or one stuck loading) fails the request
// then, not at the request's own limit; a heavy page starting up answers
// well within it.
const PING_MS = 5000;
// A page silent to a ping stays so for a while: a dialog stays open, a load
// stays stuck. Through 10-16 the daemon's log holds 807 silent pings, 62.6
// minutes of requests each waiting out PING_MS, one tab silent 39 times.
// For SILENT_MS after, a request to that frame asks it once, for QUICK_MS,
// and fails then (unlessSilent); an answer, or a new document in the frame,
// forgets it.
const SILENT_MS = 30_000;
const QUICK_MS = 1000;
const silent = new Map(); // tabId -> Map of frameId -> { from, at }: silent since from, last seen so at
// A Safari call that may never answer is given up at its deadline, with the
// phase it was in (bounded), and one that takes SLOW_MS is noted. On 10-13
// and 10-16 tab lists came in storms, each waiting out the daemon's limit,
// and one Safari call that never answers holds a list as long. A list says
// which window is in front within LIST_MS, adopt reads each page's mark
// within MARK_MS, and a close reads a page's forms within FORM_MS.
const SLOW_MS = 2000;
const LIST_MS = 2500;
const MARK_MS = 2000;
const FORM_MS = 3000;
function bounded(step, phase, until) {
  const began = Date.now();
  const late = Promise.withResolvers();
  const timer = setTimeout(() => late.reject(Object.assign(new Error(`Safari did not answer ${phase} in time`), { phase })), Math.max(0, until - began));
  return Promise.race([step, late.promise]).finally(() => {
    clearTimeout(timer);
    const ms = Date.now() - began;
    if (ms >= SLOW_MS) send({ op: "note", kind: "slow-phase", phase, ms });
  });
}
// The page lays out at a window's new size a moment after Safari sizes it,
// so the window tool reads the viewport again until it changes, for up to
// VIEWPORT_MS: seven window calls in one slice answered the viewport from
// before (390 asked, 1440 told), and their agent reloaded pages and
// measured innerWidth to be sure (S99).
const VIEWPORT_MS = 1000;
// This load of the extension. A reload leaves each open page's script world
// in place, bound to the old load's messaging, which reaches no one: a copy
// of the script this load puts in such a world is asked through
// executeScript instead (window.__safariHarnessRun in content.js).
const LOAD = crypto.randomUUID();

// Asks the content script in the tab's frame to run op, and settles within
// timeoutMs, whatever the page does: the daemon gives up 2 s later. kept
// goes with an op sent again after a stale ref (see "refs across a load").
async function toTab(tabId, op, args, timeoutMs = 30000, frameId = 0, kept = null) {
  const began = Date.now();
  const deadline = began + timeoutMs;
  const left = () => Math.max(deadline - Date.now(), 500);
  const msg = { __safariHarness: 1, id: nextId(), op, args, ...(kept && { kept }) };
  let refused = false;
  if (op !== "memoryPage") keepAwake(tabId);
  for (;;) {
    await waitReady(tabId, Math.min(15000, deadline - Date.now() - 1000));
    let sent = false;
    try {
      await unlessSilent(tabId, frameId);
      // A document known to answer takes the request at once: one trip, not
      // a ping and then the request. One that takes nothing did not run it,
      // and is asked as below.
      const known = knownWay(tabId, frameId, op);
      if (known) {
        sent = true;
        const res = await unlessHeld(tabId, frameId, known === "script", sendUntilNavigation(tabId, msg, left(), frameId, known === "script"), began);
        if (res !== undefined) return res;
        sent = false;
        ways.get(tabId)?.delete(frameId);
      }
      // A page may hold no copy of the script that answers: one left behind
      // when the extension reloaded answers nothing, and Safari skips
      // injecting some pages (after a redirect). Put a fresh copy in. An
      // embedded frame that took none is not given one again until the tab
      // loads anew or the frame reports in: through 10-16, 3,599 of 3,603
      // copies put in embedded frames (ads, trackers) answered nothing,
      // each a line in the log.
      let how = await reach(tabId, frameId, Math.min(PING_MS, left()), began);
      if (!how) {
        if (frameId === 0 && failedPage(await api.tabs.get(tabId))) break;
        if (shutFrames.get(tabId)?.has(frameId)) break;
        refused = await ensureContent(tabId, frameId, Math.min(PING_MS, left()), true);
        how = refused ? null : await reach(tabId, frameId, Math.min(PING_MS, left()), began);
        if (!refused && (frameId === 0 || how)) send({ op: "note", kind: "reinject", tab: tabId, frame: frameId, answered: how !== null, ...(how === "script" ? { through: "script" } : {}) });
        if (!how) {
          if (frameId !== 0) {
            if (!shutFrames.has(tabId)) shutFrames.set(tabId, new Set());
            shutFrames.get(tabId).add(frameId);
          }
          break;
        }
      }
      learnWay(tabId, frameId, how);
      sent = true;
      const res = await sendUntilNavigation(tabId, msg, left(), frameId, how === "script");
      if (res !== undefined) return res;
      break;
    } catch (e) {
      if (e.timedOut && op === "eval") throw await ranPast(tabId, timeoutMs);
      if (!e.navigated) throw e;
      if (sent && !READS.has(op)) return { value: { ok: true } };
      if (Date.now() >= deadline) throw new Error("the page kept navigating; read it again once it settles");
    }
  }
  const t = await api.tabs.get(tabId);
  if (frameId !== 0 && !(await hasFrame(tabId, frameId))) throw new Error(`that ref's frame is gone; the tab is now at ${t.url}; snapshot again`);
  if (failedPage(t)) throw unopened(t.url);
  // Safari puts no script in a blank tab, and a reload leaves it blank: a
  // popup opened with no address was told to reload, and its agent read,
  // reloaded, and tried to close it for a minute (01a0f14c, 09-30).
  if (frameId === 0 && (!t.url || t.url === "about:blank") && t.status === "complete") throw new Error("this tab is blank (a popup opened with no address): there is nothing in it to read; goto an address in it, or close it");
  // Safari keeps the extension off a site the user has not allowed it on.
  // Through 10-16 it refused 451 times, in 357 tabs, and each request was
  // told to reload a page that reloading could not open to it.
  if (refused && frameId === 0) {
    const host = /^https?:\/\/([^/?#]+)/.exec(t.url || "")?.[1];
    throw new Error(host
      ? `Safari has not allowed the extension on ${host}: in Safari Settings, Extensions, Safari Harness Bridge: Edit Websites, set ${host} to Allow; then retry`
      : `Safari lets no extension into ${t.url}: goto a web address in this tab, or use another`);
  }
  throw new Error(`the page at ${t.url || "about:blank"} did not answer in ${Math.round((Date.now() - began) / 1000)} s; reload it with goto and retry`);
}

// Safari's own page for a site that never answered takes no script: a
// fresh copy will not help, and the address is what went wrong. Its title
// is "Failed to open page", or, for a load that failed in place, its own
// address: goto answered Paradox's reset link with the title
// safari-resource:/ErrorPage.html, as if the page had opened (09-29).
function failedPage(t) {
  return t.title === "Failed to open page" || (t.title ?? "").startsWith("safari-resource:");
}
const unopened = (url) => new Error(`Safari could not open ${url}: the site did not answer`);

// An eval the page took but did not finish in time is the agent's code
// running long: a page that answers nothing fails its ping first, in words
// of its own. On 09-30 evals that scrolled and slept in a loop were told
// the page did not answer (01a0f039, 01a0f031). In a tab behind another, a
// video's play() and an animation never settle: on 10-16 an eval that
// awaited play() there ran out its 30 s (AkylUsage).
async function ranPast(tabId, ms) {
  const behind = await api.tabs.get(tabId).then((t) => !t.active, () => false);
  return new Error(`your code ran past ${Math.round(ms / 1000)} s; the page answered and is fine.${behind ? " This tab is behind another in its window, where a video's play() and an animation never settle: activate it first, or don't await them." : ""} Keep sleeps and long loops out of eval: a loop across steps goes in repl, and wait {text} waits for words the page will show`);
}

// Whether the tab still holds the frame: one the page took away (GEICO's,
// 09-29) answers nothing, while the page itself may be fine.
async function hasFrame(tabId, frameId) {
  const results = await api.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => true }).catch(() => []);
  return results.some((r) => r.frameId === frameId);
}

// How a copy of the script that answers is reached in the frame: by
// message, through executeScript (a page open since before a reload), or
// not at all (null). since: when the request began, for its error.
async function reach(tabId, frameId, ms, since) {
  if (await ping(tabId, frameId, ms, false, since)) return "message";
  return (await ping(tabId, frameId, ms, true, since)) ? "script" : null;
}

// Whether that copy answers, asked the one way: false at once when none
// took the message. A page that says nothing in ms is held (see PING_MS),
// and the request fails, saying how long the page has answered nothing:
// since the request began (since), or since an earlier one did while it
// stayed silent. On 10-14 a page a print sheet held was said to have not
// answered "within 5 s" after 43.7 s (AkylUsage).
async function ping(tabId, frameId, ms, script, since = Date.now()) {
  try {
    const res = await sendUntilNavigation(tabId, { __safariHarness: 1, id: nextId(), op: "ping" }, ms, frameId, script);
    const answered = !!res && res.value === true;
    if (answered) silent.get(tabId)?.delete(frameId);
    return answered;
  } catch (e) {
    if (!e.timedOut) throw e;
    const was = silent.get(tabId)?.get(frameId);
    if (!was) send({ op: "note", kind: "silent", tab: tabId, frame: frameId, ms });
    const from = Math.min(since, was?.from ?? since);
    if (!silent.has(tabId)) silent.set(tabId, new Map());
    silent.get(tabId).set(frameId, { from, at: Date.now() });
    const { url } = await api.tabs.get(tabId);
    throw new Error(`the page at ${url || "about:blank"} did not answer in ${Math.round((Date.now() - from) / 1000)} s (a dialog open on it, or a page stuck loading, holds it); reload it with goto and retry`);
  }
}

// A frame silent within SILENT_MS is asked once, for QUICK_MS, before a
// request goes to it, and the request fails then if it still is.
async function unlessSilent(tabId, frameId) {
  const was = silent.get(tabId)?.get(frameId);
  if (!was) return;
  if (Date.now() - was.at >= SILENT_MS) {
    silent.get(tabId).delete(frameId);
    return;
  }
  await ping(tabId, frameId, QUICK_MS, ways.get(tabId)?.get(frameId) === "script", was.from);
}

// Run an action and report what it caused: a new page in this tab
// (`navigated`) or a new tab (`newTab`), each once readable. A new tab that
// jumps in front while the agent works in a background tab is sent behind
// the user's tab again. Its waits end by the action's time limit.
async function act(tabId, op, args, timeoutMs = 30000, frameId = 0, kept = null) {
  const deadline = Date.now() + timeoutMs;
  const preflight = await upgradeFrameClick(tabId, op, args, deadline, frameId, kept);
  if (preflight?.error) return preflight;
  const healed = preflight?.value?.healed;
  const source = await api.tabs.get(tabId);
  const [front] = await api.tabs.query({ active: true, windowId: source.windowId });
  let opened = null;
  let navigated = false;
  let wake = () => {};
  // The tab this page opens, as the popup matcher below hands it over. A
  // new tab reads "complete" while still blank, so it is not ready until
  // its page reports in (as for tabs.open).
  const claim = (t) => {
    if (opened !== null) return;
    opened = t.id;
    drive(t.id);
    if (ready.get(t.id) !== true) ready.set(t.id, false);
    wake();
  };
  // Safari repeats the unchanged url in some updates (e.g. load complete), so
  // only a new load or a different address counts as navigating.
  const onUpdated = (id, info) => {
    if (id === tabId && (info.status === "loading" || (info.url && info.url !== source.url))) { navigated = true; wake(); }
  };
  acting.set(tabId, claim);
  api.tabs.onUpdated.addListener(onUpdated);
  try {
    const res = await toTab(tabId, op, args, deadline - Date.now(), frameId, kept);
    if (res && res.error) return res;
    // an action answers an object; anything else is passed on as it came
    if (!res || !res.value || typeof res.value !== "object" || Array.isArray(res.value)) return res;
    const { expect, ...value } = res.value;
    if (healed && value.healed === undefined) value.healed = healed;
    // A copy that answers through executeScript (a page open since before
    // the extension reloaded) cannot message it, so the tab its link or
    // window.open is making is announced from its answer instead.
    if (expect === "tab" && opened === null && ways.get(tabId)?.get(frameId) === "script") announce(tabId);
    const ms = START_MS[expect];
    if (ms && opened === null && !navigated) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(ms, deadline - Date.now()));
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    if (navigated) {
      await waitReady(tabId, Math.min(20000, deadline - Date.now()));
      const t = await api.tabs.get(tabId);
      value.navigated = { url: t.url, title: t.title };
    }
    if (opened !== null) {
      if (front && !source.active) await api.tabs.update(front.id, { active: true });
      if (await ownsTab(tabId)) await ownTab(opened);
      await waitReady(opened, Math.min(20000, deadline - Date.now()));
      const t = await api.tabs.get(opened);
      readyUnlessLoading(t);
      value.newTab = { id: t.id, url: t.url, title: t.title };
    }
    return { value };
  } finally {
    if (acting.get(tabId) === claim) acting.delete(tabId);
    api.tabs.onUpdated.removeListener(onUpdated);
  }
}

// Calls fn when the frame's document gives way to another: Safari's tab
// update "loading", or the new document's script reporting in (content.js).
// A page's own script that sends the tab on (location.href, location.replace)
// reaches the tab as one update already "complete", with no "loading", the
// same update a change of the address's hash makes; only the new copy of
// the script tells the two apart. On 10-06 a wait sent to a page that did
// so never answered: the new page had what it waited for.
function onNewDocument(tabId, frameId, fn) {
  const onNav = (id, info) => { if (id === tabId && info.status === "loading") fn(); };
  const onReady = (m, sender) => { if (m && m.__safariHarnessReady === 1 && sender.tab?.id === tabId && (sender.frameId || 0) === frameId) fn(); };
  api.tabs.onUpdated.addListener(onNav);
  api.runtime.onMessage.addListener(onReady);
  return () => {
    api.tabs.onUpdated.removeListener(onNav);
    api.runtime.onMessage.removeListener(onReady);
  };
}

// Safari never settles a message whose page unloads mid-request, so race it
// against a new document in the frame. A message no copy of the script took
// settles undefined, whether Safari says so or finds no listener; through
// executeScript, only a copy this load put in takes it.
function sendUntilNavigation(tabId, msg, ms, frameId = 0, script = false) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(t); off(); };
    const off = onNewDocument(tabId, frameId, () => {
      stop();
      reject(Object.assign(new Error("page navigated"), { navigated: true }));
    });
    const t = setTimeout(() => {
      stop();
      reject(Object.assign(new Error(`the page did not answer ${msg.op} within ${Math.round(ms / 1000)} s`), { timedOut: true }));
    }, ms);
    const reply = script
      ? api.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: (load, m) => (window.__safariHarnessLoad === load && window.__safariHarnessRun ? window.__safariHarnessRun(m) : null),
        args: [LOAD, msg],
      }).then(([r]) => r?.result ?? undefined)
      : api.tabs.sendMessage(tabId, msg, { frameId });
    reply.then((v) => { stop(); resolve(v); }, () => { stop(); resolve(undefined); });
  });
}

// A page that says it is still loading (a skeleton or "The page is loading.
// Please wait" line where its text will come, a spinner and nothing else,
// or aria-busy) is waited on for up to LOADING_MS within the open's limit,
// and the answer says when it still was (USCIS, 09-30). A page with a
// "Loading…" line that never goes (a widget below the fold) would
// otherwise hold every open its whole 15 s. A page no copy of the script
// took the message in (a PDF) settles at once. A page that sends the tab
// on to another address meanwhile is followed, including while its title
// is awaited: the page the tab lands on is waited for and asked in turn,
// within the same limit. On 10-05 open and goto answered Cvent's sign-on
// page, a spinner on its way to AWS's sign-in, as the page they had opened.
const LOADING_MS = 5000;
async function openedPage(tabId, until) {
  let navigated = false;
  const off = onNewDocument(tabId, 0, () => { navigated = true; });
  try {
    for (;;) {
      await waitReady(tabId, Math.max(0, until - Date.now()));
      if (ready.get(tabId) === false && Date.now() < until) continue;
      navigated = false;
      const left = until - Date.now();
      const ms = Math.min(left, LOADING_MS);
      let loading = false;
      if (ms > 0) {
        try {
          const res = await sendUntilNavigation(tabId, { __safariHarness: 1, id: nextId(), op: "loaded", args: [ms] }, Math.min(ms + 500, left));
          loading = res?.value?.loading === true;
        } catch (e) {
          if (e.navigated && Date.now() < until) continue;
        }
      }
      const tab = await titled(tabId, Math.max(0, Math.min(1500, until - Date.now())));
      if (!navigated || Date.now() >= until) return { tab, loading };
    }
  } finally {
    off();
  }
}

// Puts a copy of content.js in the frame, where Safari left none; with
// takeOver, a fresh one that takes over from any copy already there (see
// the claim at the top of content.js). The copy is marked this load's. A
// page stuck loading may never run it, so this gives up after ms. Answers
// whether Safari keeps the extension out of the frame.
async function ensureContent(tabId, frameId = 0, ms = PING_MS, takeOver = false) {
  const target = { tabId, frameIds: [frameId] };
  const release = api.scripting.executeScript({
    target,
    func: (load, take) => {
      if (take) window.__safariHarnessInjected = null;
      if (!window.__safariHarnessInjected) window.__safariHarnessLoad = load;
    },
    args: [LOAD, takeOver],
  });
  const inject = release
    .then(() => api.scripting.executeScript({ target, files: ["content.js"] }))
    .then(() => false, (e) => {
      send({ op: "note", kind: "inject failed", tab: tabId, frame: frameId, error: String(e) });
      return /does not have access/.test(String(e));
    });
  const late = Promise.withResolvers();
  const timer = setTimeout(late.resolve, ms, false);
  return Promise.race([inject, late.promise]).finally(() => clearTimeout(timer));
}

// ---------- one trip per request ----------
// A request goes to a frame's document without a ping first once that
// document is known to answer, and how: it reported in (content.js does as
// it starts) or answered a ping. A new load in the tab forgets its frames,
// whose new documents may hold no copy of the script yet. A document gone
// without a load being seen takes nothing, which settles undefined, and the
// request is then asked as before.
const ways = new Map(); // tabId -> Map of frameId -> "message" | "script"
const shutFrames = new Map(); // tabId -> Set of embedded frames that took no fresh copy (toTab)

function learnWay(tabId, frameId, how) {
  if (!ways.has(tabId)) ways.set(tabId, new Map());
  ways.get(tabId).set(frameId, how);
}

// How op may go to the frame's document unasked. Through executeScript, a
// request left unanswered may have run before its page went away, so only a
// read, which may be asked again, goes that way unasked.
function knownWay(tabId, frameId, op) {
  const how = ways.get(tabId)?.get(frameId);
  return how === "message" || READS.has(op) ? how : undefined;
}

// A page that a dialog or a stuck load holds answers nothing. A request sent
// without a ping first is followed by one after PING_MS: a page silent to
// that too fails the request then, as the ping first would have, not at the
// request's own limit, and a page busy with a long request (a wait, a slow
// fetch) answers it and goes on.
function unlessHeld(tabId, frameId, script, reply, since) {
  const held = Promise.withResolvers();
  const timer = setTimeout(() => ping(tabId, frameId, PING_MS, script, since).catch(held.reject), PING_MS);
  return Promise.race([reply, held.promise]).finally(() => clearTimeout(timer));
}

// Code in the page's own world runs by executeScript, which has no limit:
// it gets eval's here, as a relayed eval does in toTab, and a page silent
// to a ping after PING_MS fails it then, as above; one that navigates
// meanwhile is left to the script's answer. On 09-30 page-world code past
// 30 s was told only that the daemon's request timed out.
function pageTimed(tabId, frameId, ms, run) {
  const began = Date.now();
  const stop = Promise.withResolvers();
  const held = setTimeout(() => reach(tabId, frameId, PING_MS, began).catch((e) => e.navigated || stop.reject(e)), PING_MS);
  const late = setTimeout(() => ranPast(tabId, ms).then(stop.reject), ms);
  return Promise.race([run, stop.promise]).finally(() => {
    clearTimeout(held);
    clearTimeout(late);
  });
}

// A new load forgets what was known of the tab's frames; a frame that
// reports in is neither silent nor shut.
api.tabs.onUpdated.addListener((id, info) => {
  if (info.status !== "loading") return;
  ways.delete(id);
  silent.delete(id);
  shutFrames.delete(id);
});
api.tabs.onRemoved.addListener((id) => {
  ways.delete(id);
  silent.delete(id);
  shutFrames.delete(id);
});
api.runtime.onMessage.addListener((m, sender) => {
  if (!m || m.__safariHarnessReady !== 1 || !sender.tab) return;
  const frameId = sender.frameId || 0;
  learnWay(sender.tab.id, frameId, "message");
  silent.get(sender.tab.id)?.delete(frameId);
  shutFrames.get(sender.tab.id)?.delete(frameId);
});

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
// and one more snapshot, after their answers, places them. The fingerprints
// a frame's snapshot answers with go into kept, not to the daemon (see
// "refs across a load").
async function snapshotFrame(tabId, args, timeoutMs, frameId, kept) {
  let res = await toTab(tabId, "snapshot", args, timeoutMs, frameId);
  if (res && res.value && res.value.unlinked) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    res = await toTab(tabId, "snapshot", args, timeoutMs, frameId);
  }
  if (res && res.value) {
    const { url, fingerprints, last } = res.value;
    if (fingerprints) kept.set(frameId, { url, last, fingerprints });
    delete res.value.unlinked;
    delete res.value.fingerprints;
    delete res.value.last;
  }
  return res;
}

// Puts each embedded frame's own snapshot under its <iframe> line, with
// its refs prefixed by the frame's id. Frames nest, so this recurses.
async function stitchFrames(tabId, snap, opts, tokens, depth, kept) {
  const lines = snap.snapshot.split("\n");
  if (!lines.some((l) => MARK.test(l))) return snap;
  tokens ??= await frameTokens(tabId);
  const out = [];
  let truncated = snap.truncated;
  const limit = opts.maxNodes || 600;
  // "a|b" keeps lines containing either, and a leading (?i) is dropped, as
  // in the frame's own snapshot (alternatives in content.js)
  const alts = String(opts.query ?? "").replace(/^\(\?i\)/, "").toLowerCase().split("|").map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const m = MARK.exec(line);
    if (!m) { out.push(line); continue; }
    const head = line.replace(MARK, "");
    const frameId = tokens.get(m[1]);
    let inner = [];
    if (frameId !== undefined && depth < 4 && out.length < limit) {
      try {
        const res = await snapshotFrame(tabId, [{ ...opts, root: undefined, refPrefix: `f${frameId}:`, maxNodes: Math.max(50, limit - out.length) }], 10000, frameId, kept);
        if (res && res.value && typeof res.value.snapshot === "string") {
          const child = await stitchFrames(tabId, res.value, opts, tokens, depth + 1, kept);
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
    const identify = args?.[0]?.identifyDocument === true;
    const beforeDocument = identify ? await upgradeDocumentId(tabId) : undefined;
    const kept = new Map();
    const res = await snapshotFrame(tabId, args, timeoutMs, frameId, kept);
    if (!res || !res.value || typeof res.value.snapshot !== "string") return res;
    const value = await stitchFrames(tabId, res.value, (args && args[0]) || {}, null, 0, kept);
    if (identify) {
      const afterDocument = await upgradeDocumentId(tabId);
      if (beforeDocument && beforeDocument === afterDocument) value.documentId = afterDocument;
    }
    snapshotRefs.set(tabId, kept);
    return { value };
  }
  const deadline = Date.now() + timeoutMs;
  const send = (id, ms = timeoutMs, kept = null) => READS.has(domOp) ? toTab(tabId, domOp, args, ms, id, kept) : act(tabId, domOp, args, ms, id, kept);
  let res = await send(frameId);
  // a ref from a snapshot taken before the page loaded anew (refs across a load)
  const again = keptFor(tabId, frameId, res);
  if (again) res = await send(frameId, deadline - Date.now(), again);
  if (frameId === 0 && res && typeof res.error === "string" && MISS.test(res.error)) {
    const tokens = await frameTokens(tabId).catch(() => new Map());
    for (const id of tokens.values()) {
      const r = await send(id).catch(() => null);
      if (r && !(typeof r.error === "string" && MISS.test(r.error))) return r;
    }
  }
  if (domOp === "extract") res = await extractFrames(tabId, res, (args && args[0]) || {});
  return frame || frameId === 0 ? res : prefixed(res, frameId);
}

// extract adds the text of each embedded frame shown in what it read, after
// the frame's own, under the <iframe>'s name: a page cannot read a frame of
// another site, and SheerID's form open over Adorama read as the empty
// dialog it sat in (10-19). A frame's lines stand in for the notes of a
// page that had none of its own.
async function extractFrames(tabId, res, opts, tokens = null, depth = 0) {
  const value = res && res.value;
  if (!value || !Array.isArray(value.frames)) return res;
  const { frames, ...own } = value;
  if (depth >= 4) return { ...res, value: own };
  tokens ??= await frameTokens(tabId).catch(() => new Map());
  const parts = [];
  for (const { token, name } of frames) {
    const frameId = tokens.get(token);
    if (frameId === undefined) continue;
    const read = await toTab(tabId, "extract", [{ ...opts, selector: undefined }], 10000, frameId).catch(() => null);
    const inner = (await extractFrames(tabId, read, opts, tokens, depth + 1))?.value;
    if (inner && inner.text) parts.push({ name, inner });
  }
  if (!parts.length) return { ...res, value: own };
  const { note, hint, ...rest } = own;
  const text = [own.text, ...parts.map((p) => `${p.name}:\n${p.inner.text}`)].filter(Boolean).join("\n\n");
  const notes = [own.text ? note : undefined, ...parts.map((p) => p.inner.note)].filter(Boolean);
  const limit = opts.maxBytes || 20000;
  return {
    ...res,
    value: {
      ...rest,
      text: text.length > limit ? text.slice(0, limit) + "\n…truncated" : text,
      truncated: text.length > limit || parts.some((p) => p.inner.truncated),
      ...(notes.length ? { note: notes.join("; ") } : {}),
      ...(own.text && hint ? { hint } : {}),
    },
  };
}

// A ref of an embedded frame reads "f<frameId>:<ref>", and the frame's own
// script knows only the ref: a stale ref it reports, or a heal it made,
// gets the frame's prefix back, so the agent reads the ref it sent.
function prefixed(res, frameId) {
  if (res && typeof res.error === "string") return { ...res, error: res.error.replace(/^stale ref (\d+)/, `stale ref f${frameId}:$1`) };
  const healed = res && res.value && res.value.healed;
  if (!healed) return res;
  return { ...res, value: { ...res.value, healed: { ref: `f${frameId}:${healed.ref}`, now: `f${frameId}:${healed.now}` } } };
}

// ---------- refs across a load ----------
// A load starts a page's refs over, while the agent still holds the ones
// its snapshot gave: on 10-07 Akyl's audit agents ran goto on the page they
// were reading, then clicked a ref from their snapshot of it, and each
// click failed as a stale ref (partners, calendar, inbox). The fingerprints
// of the refs the tab's latest snapshot printed stay here, by frame, with
// the frame's address and the last ref its page gave then. An action whose
// page calls its ref stale goes once more with that ref's fingerprint, and
// the page heals the ref only at that address, its hash aside (adopt in
// content.js). A stale answer means the page did nothing, so sending again
// never acts twice. One snapshot per tab, kept until the next one or until
// the tab closes.
const snapshotRefs = new Map(); // tabId -> Map of frameId -> { url, last, fingerprints }

// What an action whose answer calls its ref stale goes again with: the
// ref's fingerprint from the tab's latest snapshot, with that frame's
// address and last ref then; null when that snapshot printed no such ref.
function keptFor(tabId, frameId, res) {
  const stale = res && typeof res.error === "string" ? /^stale ref (\d+)/.exec(res.error) : null;
  const snap = stale && snapshotRefs.get(tabId)?.get(frameId);
  const fingerprint = snap && snap.fingerprints[stale[1]];
  return fingerprint ? { url: snap.url, last: snap.last, fingerprints: { [stale[1]]: fingerprint } } : null;
}

api.tabs.onRemoved.addListener((id) => { snapshotRefs.delete(id); });

// ---------- waiting in every frame ----------
// A wait is answered by whichever frame shows the text or selector first (a
// sign-in form often sits in an embedded frame), and a frame that loads
// meanwhile joins in. The top page's answer stands for the whole tab: a
// miss there (stopped, or ended by a newer wait) ends the wait. gone holds
// only once no frame shows the text: each embedded frame is asked for gone
// alone, and a found from the top page waits for them. Only the top page
// was asked before, and SheerID's form, still up in its frame over
// Adorama, read as gone (10-19). waitStop from the daemon asks the top page
// to end it and report what changed, then ends the other frames. The id
// keeps that from ending a newer wait.
const frameWaits = new Map(); // tabId -> Map of wait id -> { join, stop }

async function waitInFrames(tabId, args, timeoutMs) {
  // A run's look before an action must reach every current frame before
  // the action starts; the first frame's answer alone is not enough.
  if (args[1]?.look != null) {
    const tokens = await frameTokens(tabId);
    const [top] = await Promise.all([0, ...tokens.values()].map((frameId) => toTab(tabId, "wait", args, timeoutMs, frameId)));
    return top;
  }
  const id = nextId();
  const deadline = Date.now() + timeoutMs;
  const asked = new Set();
  const waits = frameWaits.get(tabId) || new Map();
  frameWaits.set(tabId, waits);
  return new Promise((resolve, reject) => {
    const gone = args[1]?.gone != null;
    const showing = new Set(); // embedded frames that still show the text gone names
    let top = null; // the top page's found, held while a frame shows that text
    let listed = false; // every frame there was as the wait began has been asked
    let lingered = false; // a frame showed it as it was asked: not gone before the wait
    const end = (settle) => {
      if (!waits.delete(id)) return;
      if (waits.size === 0 && frameWaits.get(tabId) === waits) frameWaits.delete(tabId);
      const stop = { __safariHarness: 1, id: nextId(), op: "waitStop", args: [id] };
      for (const frameId of asked) api.tabs.sendMessage(tabId, stop, { frameId }).catch(() => {});
      settle();
    };
    const finish = () => {
      if (!top || !listed || showing.size) return;
      const value = { ...top.value };
      if (lingered) { delete value.already; delete value.hint; }
      end(() => resolve({ ...top, value }));
    };
    const join = (frameId) => {
      asked.add(frameId);
      const watch = gone && frameId !== 0;
      if (watch) showing.add(frameId);
      const spec = watch ? [null, { gone: args[1].gone }, id] : [args[0] ?? null, args[1] ?? null, id];
      toTab(tabId, "wait", spec, Math.max(deadline - Date.now(), 1000), frameId).then((res) => {
        const found = !!(res && res.value && res.value.found);
        if (watch) {
          if (!found) return;
          if (!res.value.already) lingered = true;
          showing.delete(frameId);
          return finish();
        }
        if (frameId === 0 && gone && found) {
          top = res;
          return finish();
        }
        if (frameId === 0 || found) end(() => resolve(res));
      }, (e) => {
        if (frameId === 0) return end(() => reject(e));
        // a frame gone, or one that answers nothing, shows nobody the text
        if (watch) { showing.delete(frameId); finish(); }
      });
    };
    const stopped = () => end(() => resolve({ value: { found: false } }));
    waits.set(id, { join, stop: () => (top ? stopped() : toTab(tabId, "waitStop", [id], 1000, 0).catch(stopped)) });
    join(0);
    frameTokens(tabId).then((tokens) => { for (const frameId of tokens.values()) if (waits.has(id)) join(frameId); }, () => {}).finally(() => {
      listed = true;
      finish();
    });
  });
}

// Asks every frame of the tab what it holds (__safariHarnessProbe in
// content.js), top page first: a sign-in form or a bot check may sit in an
// embedded frame of another site. The top page is asked alone first, and
// the embedded frames get FRAMES_MS after it: one that answers nothing (a
// frame stuck loading) held every probe until the daemon gave up at 2 s,
// 1,060 times through 10-16, 35.8 minutes in all.
const FRAMES_MS = 500;
async function probeFrames(tabId, what, arg) {
  keepAwake(tabId);
  await waitReady(tabId, 15000);
  await unlessSilent(tabId, 0);
  const ask = (frames) => api.scripting.executeScript({
    target: { tabId, ...frames },
    func: (w, a) => (window.__safariHarnessProbe ? window.__safariHarnessProbe[w](a) : null),
    args: [what, arg ?? null],
  });
  let [top] = await ask({ frameIds: [0] });
  // Safari skipped injecting the top page's script (after a redirect): add it.
  if (!top?.result) {
    await ensureContent(tabId, 0);
    [top] = await ask({ frameIds: [0] });
  }
  const embedded = await bounded(ask({ allFrames: true }), "probe frames", Date.now() + FRAMES_MS).catch(() => []);
  return [top, ...embedded.filter((r) => r.frameId !== 0)].filter((r) => r?.result).map((r) => ({ frame: r.frameId, ...r.result }));
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
  drive(tabId);
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
    const page = window[Symbol.for("safari-harness.page")];
    const net = page?.net;
    if (!net) return null;
    if (cmd === "read") return net.log.slice(-100);
    if (cmd === "start") page.logNet?.();
    net.on = cmd === "start";
    if (net.on) net.log.length = 0;
    return true;
  }
  const key = Symbol.for("safari-harness.capture");
  // The page's uncaught errors and failed script loads since it loaded
  // come too, start or not, kept by dialogs.js from the page's first
  // script: a page that threw as it loaded read 0 nodes, and console read
  // had none of its errors (S99PartB). A read puts nothing in the page: the
  // daemon's wait reads them on a page that drew nothing.
  if (cmd === "read") {
    const thrown = (window[Symbol.for("safari-harness.page")]?.errors ?? []).map(({ t, message }) => ({ level: "error", text: message, t, uncaught: true }));
    return { entries: [...thrown, ...(window[key]?.console.log ?? [])].sort((a, b) => a.t - b.t).slice(-100) };
  }
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
  c.on = cmd === "start";
  if (c.on) c.log.length = 0;
  return { ok: true };
}

// Runs in the page's own world, so it must be self-contained. A page that
// demands Trusted Types (YouTube, Google) refuses a plain string, so the
// code goes through a policy of our own. A page whose policy forbids eval
// may still run a script tag of its own kind: one with the nonce its own
// scripts carry, or one loaded from a blob: address. On 10-07 four page:
// true evals were refused on Robinhood, whose policy takes both, and on
// Slack, which takes blob:. Such a tag hands its value back through a
// page global. A page that allows neither still refuses it.
async function pageEval(src) {
  const code = `return (${src})`;
  const refused = (e) => /unsafe-eval|Content Security Policy/i.test(String(e && e.message));
  async function asTag(e) {
    const key = `__safariHarness${Math.random().toString(36).slice(2)}`;
    const body = `window[${JSON.stringify(key)}] = (async () => { ${code} })();`;
    let policy;
    const typed = (kind, s) => {
      if (!globalThis.trustedTypes) return s;
      try {
        policy ??= trustedTypes.createPolicy(`safari-harness-${Math.random().toString(36).slice(2)}`, { createScript: (x) => x, createScriptURL: (x) => x });
        return kind === "url" ? policy.createScriptURL(s) : policy.createScript(s);
      } catch {
        return s;
      }
    };
    const nonce = [...document.querySelectorAll("script[nonce]")].map((s) => s.nonce).find(Boolean);
    try {
      if (nonce) {
        const tag = document.createElement("script");
        tag.nonce = nonce;
        tag.textContent = typed("script", body);
        document.documentElement.append(tag);
        tag.remove();
        if (key in window) return await window[key];
      }
      const url = URL.createObjectURL(new Blob([body], { type: "text/javascript" }));
      try {
        const { promise: loaded, resolve } = Promise.withResolvers();
        const tag = document.createElement("script");
        tag.onload = () => { tag.remove(); resolve(true); };
        tag.onerror = () => { tag.remove(); resolve(false); };
        tag.src = typed("url", url);
        document.documentElement.append(tag);
        const ran = await loaded;
        if (ran && key in window) return await window[key];
      } finally {
        URL.revokeObjectURL(url);
      }
      throw e;
    } finally {
      delete window[key];
    }
  }
  try {
    let v;
    try {
      v = await new Function(code)();
    } catch (e) {
      if (refused(e)) v = await asTag(e);
      else {
        if (!globalThis.trustedTypes || !/Trusted ?Type/i.test(String(e && e.message))) throw e;
        const policy = trustedTypes.createPolicy(`safari-harness-${Math.random().toString(36).slice(2)}`, { createScript: (s) => s });
        v = await new Function(policy.createScript(code))();
      }
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

// Runs in the page's own world, so it must be self-contained: the state a
// framework leaves in page globals, for the data tool, each as plain JSON
// (Safari aborts on a NaN passed on, as for pageEval). One answer must stay
// well under the 16 MB a message to the daemon may hold, so a value past
// what is left of 4 million characters is only measured.
function pageGlobals() {
  const read = {
    next: () => window.__NEXT_DATA__,
    nuxt: () => window.__NUXT__,
    remix: () => window.__remixContext?.state,
    apollo: () => window.__APOLLO_STATE__ ?? window.__APOLLO_CLIENT__?.cache?.extract(),
    state: () => window.__INITIAL_STATE__ ?? window.__PRELOADED_STATE__,
  };
  const values = {};
  const tooBig = {};
  let room = 4e6;
  for (const [name, get] of Object.entries(read)) {
    try {
      const json = JSON.stringify(get());
      if (json === undefined) continue;
      if (json.length > room) {
        tooBig[name] = new Blob([json]).size;
      } else {
        values[name] = JSON.parse(json);
        room -= json.length;
      }
    } catch {
      // a value that holds itself, or a getter that throws, is no data
    }
  }
  return { values, tooBig };
}

// Safari gives a page its address as a title until the page names itself,
// and a new page's script may name it just after it loads: a web page gets
// a moment for a title of its own, and without one it reports none.
function titled(tabId, ms = 1500) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(onUpdated);
      resolve(api.tabs.get(tabId));
    };
    const onUpdated = (id, info, tab) => { if (id === tabId && info.title !== undefined && realTitle(tab)) done(); };
    const timer = setTimeout(done, ms);
    api.tabs.onUpdated.addListener(onUpdated);
    api.tabs.get(tabId).then((t) => { if (realTitle(t) || !/^https?:/.test(t.url || "")) done(); }, done);
  });
}

// A title that only repeats the address is none.
function realTitle(t) {
  const bare = (s) => String(s || "").replace(/^[a-z]+:\/\/(www\.)?/i, "").replace(/\/$/, "");
  return t.title && bare(t.title) !== bare(t.url) ? t.title : undefined;
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
// A page's animations stall in a tab behind another, and an agent worked
// around them by hand before its shots (S99PartA). Unless live, a shot
// first finishes the page's finite ones, and those they start, for up to
// SETTLE_MS.
const SETTLE_MS = 1000;

const captureWindows = new Map();
const screenshotPrivacyError = (message) => new Error(`screenshot privacy: ${message}`);

async function protectedCapture(tabId, mark, phase, secrets, frameId = 0) {
  let value;
  try {
    const res = await toTab(tabId, "capturePrivacy", [mark, phase, secrets], 10000, frameId);
    if (res?.error) throw new Error(res.error);
    value = res?.value;
  }
  catch (error) {
    if (String(error.message).startsWith("screenshot privacy: ")) throw error;
    throw screenshotPrivacyError("the page could not confirm protection");
  }
  if (value?.ok !== true) throw screenshotPrivacyError("the page did not confirm protection");
  return value;
}

async function privateGrab(tabId, windowId, mark, secrets) {
  let changed = false;
  const onUpdated = (id, info) => { if (id === tabId && (info.status === "loading" || info.url !== undefined)) changed = true; };
  const onActivated = (info) => { if (info.windowId === windowId && info.tabId !== tabId) changed = true; };
  api.tabs.onUpdated.addListener(onUpdated);
  api.tabs.onActivated.addListener(onActivated);
  let bitmap;
  try {
    const state = await protectedCapture(tabId, mark, "prepare", secrets);
    const viewport = state.source?.viewport;
    if (!viewport || ![viewport.width, viewport.height, viewport.devicePixelRatio].every((n) => Number.isFinite(n) && n > 0) ||
        typeof state.source.url !== "string" || typeof state.source.title !== "string" ||
        !Array.isArray(state.regions) || state.masked !== state.regions.length ||
        !state.regions.every((r) => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= viewport.width && r.y + r.height <= viewport.height)) {
      throw screenshotPrivacyError("the page returned incomplete protection");
    }
    const painted = await toTab(tabId, "painted", [], 3000).catch(() => null);
    if (painted?.value?.ok !== true) throw screenshotPrivacyError("the protected page did not paint");
    const active = async () => (await api.tabs.query({ active: true, windowId })).some((t) => t.id === tabId);
    if (changed || !(await active())) throw screenshotPrivacyError("the protected tab is no longer visible");
    const capturedAt = new Date().toISOString();
    const raw = await api.tabs.captureVisibleTab(windowId, { format: "png" });
    await protectedCapture(tabId, mark, "check", secrets);
    if (changed || !(await active())) throw screenshotPrivacyError("the protected tab changed during capture");
    bitmap = await dataUrlBitmap(raw);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = "#000";
    const sx = bitmap.width / viewport.width, sy = bitmap.height / viewport.height;
    for (const r of state.regions) {
      const x = Math.floor(r.x * sx), y = Math.floor(r.y * sy);
      ctx.fillRect(x, y, Math.ceil((r.x + r.width) * sx) - x, Math.ceil((r.y + r.height) * sy) - y);
    }
    return { canvas, state, capturedAt };
  } finally {
    bitmap?.close();
    api.tabs.onUpdated.removeListener(onUpdated);
    api.tabs.onActivated.removeListener(onActivated);
  }
}

async function captureTiles(canvas, tileHeight) {
  const tiles = [];
  for (let y = 0; y < canvas.height;) {
    const height = Math.min(tileHeight, canvas.height - y);
    const piece = new OffscreenCanvas(canvas.width, height);
    piece.getContext("2d").drawImage(canvas, 0, y, canvas.width, height, 0, 0, canvas.width, height);
    tiles.push({ data: await pngOf(piece), region: { x: 0, y, width: canvas.width, height } });
    if (y + height === canvas.height) break;
    y += height - 64;
  }
  return tiles;
}

async function screenshot(tabId, opts) {
  const { windowId } = await api.tabs.get(tabId);
  const previous = captureWindows.get(windowId) ?? Promise.resolve();
  const capture = previous.catch(() => {}).then(() => screenshotInWindow(tabId, windowId, opts));
  captureWindows.set(windowId, capture);
  try { return await capture; }
  finally { if (captureWindows.get(windowId) === capture) captureWindows.delete(windowId); }
}

async function screenshotInWindow(tabId, windowId, opts) {
  // Tile height and overlap are original raster pixels, independent of DPR.
  const tileHeight = opts.tileHeight ?? 1400;
  if (opts.tiles && (!Number.isInteger(tileHeight) || tileHeight < 256 || tileHeight > 8192)) throw new Error("tileHeight must be an integer from 256 to 8192 raster pixels");
  const beforeDocument = await upgradeDocumentId(tabId);
  const secrets = opts.secrets ?? [];
  const [front] = await api.tabs.query({ active: true, windowId });
  const flip = front && front.id !== tabId;
  const mark = crypto.randomUUID();
  let started = false;
  let annotated = false;
  let selected = false;
  let failure;
  let box;
  let page;
  const shots = [];
  const cropFrames = [];
  try {
    started = true;
    const initial = await protectedCapture(tabId, mark, "start", secrets);
    if (opts.ref) {
      for (const frameId of (await frameTokens(tabId)).values()) {
        cropFrames.push(frameId);
        await protectedCapture(tabId, mark, "start", secrets, frameId);
      }
    }
    box = opts.ref ? await relayOp(tabId, "locate", [opts.ref], 10000).then((r) => { if (r && r.error) throw new Error(r.error); return r.value; }) : null;
    page = opts.fullPage && !box ? initial : null;
    if (opts.annotate) { annotated = true; await pageValue(tabId, "annotate", [true]); }
    if (flip) { selected = true; await api.tabs.update(tabId, { active: true }); }
    const settle = async () => {
      await toTab(tabId, "painted", [], 3000).catch(() => {});
      if (opts.live) return;
      const settled = await toTab(tabId, "settle", [SETTLE_MS], SETTLE_MS + 2000).catch(() => null);
      if (settled?.value?.finished) await toTab(tabId, "painted", [], 3000).catch(() => {});
    };
    const grab = async () => {
      await settle();
      const shot = await privateGrab(tabId, windowId, mark, secrets);
      shots.push(shot);
      await protectedCapture(tabId, mark, "clear", secrets);
      return shot;
    };
    if (!page) await grab();
    else {
      const viewport = page.source?.viewport;
      if (!viewport || !Number.isFinite(viewport.height) || viewport.height <= 0 || !Number.isFinite(page.page?.height)) throw screenshotPrivacyError("the page size could not be inspected");
      let covered = 0;
      for (let y = 0; y < page.page.height && shots.length < FULL_PAGE_MAX; y += viewport.height) {
        await pageValue(tabId, "eval", [`(scrollTo({left:0,top:${y},behavior:"instant"}), 1)`]);
        const shot = await grab();
        const actualY = shot.state.page?.y;
        if (!Number.isFinite(actualY) || actualY < 0 || actualY > covered ||
            shot.state.source.url !== page.source.url || shot.state.source.viewport.width !== viewport.width || shot.state.source.viewport.height !== viewport.height ||
            (shots.length > 1 && (shot.canvas.width !== shots[0].canvas.width || shot.canvas.height !== shots[0].canvas.height))) throw new Error("the page changed size or left a gap during full-page capture");
        if (shots.length > 1 && actualY + viewport.height <= covered) { shots.pop(); break; }
        covered = actualY + viewport.height;
        if (covered >= page.page.height) break;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    const clean = async (run) => { try { await run(); } catch (error) { failure ??= error; } };
    for (const frameId of cropFrames) await clean(() => protectedCapture(tabId, mark, "restore", secrets, frameId));
    if (started) await clean(() => protectedCapture(tabId, mark, "restore", secrets));
    if (annotated) await clean(() => pageValue(tabId, "annotate", [false]));
    if (selected) await clean(() => api.tabs.update(front.id, { active: true }));
  }
  if (failure) throw failure;
  const afterDocument = await upgradeDocumentId(tabId);
  if (beforeDocument && beforeDocument !== afterDocument) throw new Error("screenshot privacy: a page document changed during capture");
  const first = shots[0];
  let canvas = first.canvas;
  const source = { ...first.state.source, capturedAt: first.capturedAt, width: canvas.width, height: canvas.height, privacy: { masked: shots.reduce((sum, shot) => sum + shot.state.masked, 0) } };
  const result = {};
  if (box) {
    const sx = canvas.width / source.viewport.width, sy = canvas.height / source.viewport.height;
    const x = Math.max(0, Math.floor(box.x * sx)), y = Math.max(0, Math.floor(box.y * sy));
    const right = Math.min(canvas.width, Math.ceil((box.x + box.width) * sx)), bottom = Math.min(canvas.height, Math.ceil((box.y + box.height) * sy));
    if (right <= x || bottom <= y) throw new Error("the screenshot target is outside the captured viewport");
    const crop = new OffscreenCanvas(right - x, bottom - y);
    crop.getContext("2d").drawImage(canvas, x, y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    canvas = crop;
    source.crop = { x: x / sx, y: y / sy, width: canvas.width / sx, height: canvas.height / sy };
  } else if (page) {
    const scale = canvas.height / source.viewport.height;
    const last = shots[shots.length - 1];
    const pageHeight = Math.max(page.page.height, ...shots.map((shot) => shot.state.page.height));
    const height = Math.min(Math.ceil(pageHeight * scale), Math.round(last.state.page.y * scale) + last.canvas.height);
    const stitched = new OffscreenCanvas(canvas.width, height);
    const ctx = stitched.getContext("2d");
    for (const shot of shots) ctx.drawImage(shot.canvas, 0, Math.round(shot.state.page.y * scale));
    canvas = stitched;
    result.screens = shots.length;
    result.cut = height < Math.ceil(pageHeight * scale);
  }
  source.width = canvas.width;
  source.height = canvas.height;
  return { data: await pngOf(canvas), ...result, source, ...(beforeDocument ? { document: beforeDocument } : {}), ...(opts.tiles ? { tiles: await captureTiles(canvas, tileHeight) } : {}) };
}

// Runs in the page: empties what its origin keeps, and says the origin
// (storage.clear). A database the page holds open goes once the page
// closes, as clearSite in daemon/tools.ts closes it next. A page that is
// not secure has no caches and no service workers. Safari's cookie API
// (cookies.clear, after this) deletes the stored cookies, but a page
// process keeps its own copy, which the site's script goes on reading
// (10-02: httpbin.org's server got no cookie, a new tab's script still
// read it). Only a delete written by script clears that copy, and it must
// name the domain and path the cookie was set for, which a script cannot
// read, so each that could hold one is tried.
async function emptyStorage() {
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const db of await window.indexedDB.databases()) window.indexedDB.deleteDatabase(db.name);
  for (const key of (await window.caches?.keys()) ?? []) await window.caches.delete(key);
  for (const r of (await window.navigator.serviceWorker?.getRegistrations()) ?? []) await r.unregister();
  const { hostname, pathname } = window.location;
  const labels = hostname.split(".");
  const domains = ["", ...labels.slice(0, -1).map((_, i) => `; domain=${labels.slice(i).join(".")}`)];
  const paths = new Set(pathname.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/") || "/"));
  for (const pair of window.document.cookie.split("; ").filter(Boolean)) {
    const name = pair.split("=")[0];
    for (const path of paths) for (const domain of domains) window.document.cookie = `${name}=; max-age=0; path=${path}${domain}`;
  }
  return { origin: window.location.origin };
}

// ---------- handlers ----------

async function handle(msg) {
  const { op, args = [] } = msg;
  // A tab id from before the extension reloaded names its tab's new id.
  // Every op with a number first takes a tab id, but these four.
  if (typeof args[0] === "number" && op !== "daemonPort" && op !== "windows.focus" && op !== "windows.resolve" && op !== "windows.regrouping") args[0] = await resolveTab(args[0]);
  switch (op) {
    case "memory.configure": {
      const [config, revision, captureCurrent = true] = args;
      clearTimeout(memoryTimer);
      memoryPolicy = config;
      memoryRevision = revision;
      if (captureCurrent) void considerMemoryFront();
      return { ok: true };
    }
    case "memory.capture": {
      const [tabId, url, revision] = args;
      if (revision !== memoryRevision || !await memoryAllowed(tabId, url) || revision !== memoryRevision) return { skipped: true };
      const result = await toTab(tabId, "memoryPage", [url], 5000);
      if (revision !== memoryRevision || !await memoryAllowed(tabId, url) || revision !== memoryRevision) return { skipped: true };
      if (result?.error) throw new Error("the page could not be read for memory");
      if (result?.value?.visible !== true) return { skipped: true };
      return result.value;
    }
    case "tabs.list": {
      const tabs = await bounded(api.tabs.query({}), "tabs.query", Date.now() + 2 * LIST_MS);
      // Every window has an active tab; front is the one in the window the
      // user had in front last, the tab tab: "front" names. shown is the one
      // Safari shows in front, which may be in an agent window an agent raised.
      // Past LIST_MS the tabs go without either, each partial with the phase
      // Safari did not answer (see LIST_MS).
      const until = Date.now() + LIST_MS;
      const fronts = await Promise.all([frontWindow(false, until), frontWindow(true, until)]).then(([focused, shown]) => ({ focused, shown }), (e) => {
        if (!e.phase) throw e;
        return { partial: e.phase };
      });
      return tabs
        .filter((t) => t.id !== undefined)
        .map((t) => ({ id: t.id, url: t.url, title: t.title, active: !!t.active, windowId: t.windowId, ...(fronts.partial ? { partial: fronts.partial } : {}), ...(t.active && t.windowId === fronts.focused ? { front: true } : {}), ...(t.active && t.windowId === fronts.shown ? { shown: true } : {}) }));
    }
    case "tabs.open": {
      // owned: the daemon may close it, and its dialogs are answered here
      const [url, background, windowId, owned = background] = args;
      const [tab] = await harnessMade(async () => [await api.tabs.create({ url: url || "about:blank", active: !background, ...(typeof windowId === "number" ? { windowId } : {}) })]);
      if (ready.get(tab.id) !== true) ready.set(tab.id, false);
      drive(tab.id);
      if (owned) await ownTab(tab.id);
      const { tab: t, loading } = await openedPage(tab.id, Date.now() + 15000);
      if (failedPage(t)) {
        closing.add(t.id);
        api.tabs.remove(t.id).catch(() => closing.delete(t.id));
        throw unopened(url);
      }
      return { id: t.id, url: t.url, ...(realTitle(t) ? { title: t.title } : {}), windowId: t.windowId, ...(loading ? { loading: true } : {}) };
    }
    case "tabs.close": {
      const [tabId, only] = args;
      if (only && !(await ownsTab(tabId))) return { ok: false };
      if (only && await inFront(tabId)) return { ok: false, front: true };
      if (only) {
        // Inspect every frame without returning a field's value. If a page
        // cannot be inspected, or does not answer within FORM_MS (a dialog
        // holds it), automatic cleanup leaves it alone.
        const frames = await bounded(api.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => [...window.document.querySelectorAll("input, textarea, select, [contenteditable]")].some((field) => {
            if (field.isContentEditable) return field.textContent.trim().length > 0;
            if (field.tagName === "SELECT") {
              const options = [...field.options];
              const hasDefault = options.some((option) => option.defaultSelected);
              return options.some((option, index) => option.selected !== (hasDefault ? option.defaultSelected : index === 0 && !field.multiple));
            }
            if (field.type === "checkbox" || field.type === "radio") return field.checked !== field.defaultChecked;
            return field.value !== field.defaultValue;
          }),
        }), "forms", Date.now() + FORM_MS).catch(() => []);
        if (!frames.length || frames.some((frame) => typeof frame.result !== "boolean")) return { ok: false, protected: "unreadable" };
        if (frames.some((frame) => frame.result)) return { ok: false, protected: "form" };
      }
      // resolve once Safari has dropped the tab, so a following list omits it
      let onRemoved;
      const gone = new Promise((resolve) => {
        onRemoved = (id) => { if (id === tabId) resolve(true); };
        api.tabs.onRemoved.addListener(onRemoved);
      });
      // A native sheet on the tab (a sign-in or permission prompt) or a
      // window off screen can hold it open, and Safari then never answers:
      // on 09-27 three closes each hung 30 s behind an Apple sign-in sheet.
      // A tab of the harness's own is sent to a blank page then and closed
      // again each second: Safari stops waiting on a page that does not
      // answer a load (behind a print sheet, a close 7 s after the load
      // went through in 21 ms; one 1 s after it still hung).
      const timers = [];
      const within = (p, ms) => Promise.race([p, new Promise((resolve) => timers.push(setTimeout(resolve, ms, false)))]);
      closing.add(tabId);
      try {
        if (await within(api.tabs.remove(tabId).then(() => gone), 5000)) return { ok: true };
        if (!only && await ownsTab(tabId)) {
          api.tabs.update(tabId, { url: "about:blank" }).catch(() => {});
          for (let i = 0; i < 10; i++) {
            if (await within(gone, 1000)) return { ok: true };
            api.tabs.remove(tabId).catch(() => {});
          }
        }
        throw new Error("Safari did not close the tab: a native sheet (a sign-in or permission prompt) or a window off screen holds it. Tell the user; closing again will not help");
      } finally {
        for (const t of timers) clearTimeout(t);
        api.tabs.onRemoved.removeListener(onRemoved);
        closing.delete(tabId);
      }
    }
    case "tabs.navigate": {
      const [tabId, url] = args;
      ready.set(tabId, false);
      keepAwake(tabId);
      await api.tabs.update(tabId, { url });
      const { tab: t, loading } = await openedPage(tabId, Date.now() + 20000);
      if (failedPage(t)) throw unopened(url);
      return { id: t.id, url: t.url, ...(realTitle(t) ? { title: t.title } : {}), ...(loading ? { loading: true } : {}) };
    }
    // With bounds, the window moves as well: left and top count from the
    // top-left of the screen it is on (daemon/tools.ts, showTab). The
    // answer carries the window's size, by which the daemon finds it.
    case "tabs.activate": {
      const [tabId, bounds] = args;
      const t = await api.tabs.get(tabId);
      const w = await api.windows.update(t.windowId, bounds ? { focused: true, ...bounds, state: "normal" } : { focused: true });
      await api.tabs.update(tabId, { active: true });
      return { ok: true, windowId: t.windowId, width: w.width, height: w.height };
    }
    // Shows a tab in its window and leaves the window where it is:
    // real_input presses an element through its window's accessibility
    // tree, which holds only the tab the window shows.
    case "tabs.select": {
      const [tabId] = args;
      await api.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    case "relay": {
      const [tabId, domOp, domArgs, timeoutMs, frameId] = args;
      if (domOp in CAPTURE) return capture(tabId, domOp, domArgs);
      const version = memoryRevision;
      const reading = (domOp === "extract" || domOp === "snapshot") && !frameId && memoryPolicy.researchEnabled === true;
      const readArgs = (domOp === "extract" || domOp === "snapshot") ? [{ ...(domArgs?.[0] ?? {}), memoryResearch: reading }, ...(domArgs?.slice(1) ?? [])] : domArgs;
      const res = await relayOp(tabId, domOp, readArgs, timeoutMs, frameId);
      if (res && res.error) throw new Error(res.error);
      const value = res && res.value;
      if (!value || typeof value !== "object" || !Object.hasOwn(value, "memorySource")) return value;
      const { memorySource, ...result } = value;
      if (!reading || !await publicMemorySource(tabId, memorySource, version)) return result;
      return { ...result, memorySource };
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
    // A tab's window: its size, by which the daemon finds it among the
    // windows on screen (daemon/place.ts), and its state. With bounds it
    // moves first, taking no focus: left and top count from the top-left of
    // the screen it is on, as with tabs.activate. Safari moves only a normal
    // window; one minimized, zoomed or in full screen stays as it is.
    case "windows.frame": {
      const [tabId, bounds] = args;
      const { windowId } = await api.tabs.get(tabId);
      const w = bounds ? await api.windows.update(windowId, { left: Math.round(bounds.left), top: Math.round(bounds.top) }) : await api.windows.get(windowId);
      return { width: w.width, height: w.height, state: w.state };
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
    // How many cookies a site and its subdomains hold, counted before a
    // clear's pages delete those their scripts read (clearSite in
    // daemon/tools.ts).
    case "cookies.count": {
      const [site] = args;
      return (await api.cookies.getAll({ domain: site })).length;
    }
    // Every cookie of a site and its subdomains (clearSite). Safari removes
    // one a call, the first of that name the url would carry, so each goes
    // by its own host and path. The answer counts those left, no value.
    case "cookies.clear": {
      const [site] = args;
      const all = await api.cookies.getAll({ domain: site });
      for (const c of all) await api.cookies.remove({ url: `https://${c.domain.replace(/^\./, "")}${c.path}`, name: c.name });
      return { left: (await api.cookies.getAll({ domain: site })).length };
    }
    case "storage.clear": {
      const [tabId] = args;
      const [r] = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: emptyStorage });
      if (!r) throw new Error("the page did not run it");
      return r.result;
    }
    case "dialogs": {
      const [tabId, policy] = args;
      if (policy) await store.set({ [`dialogs:${tabId}`]: policy });
      const res = await toTab(tabId, "dialogs", [policy || null]);
      if (res && res.error) throw new Error(res.error);
      return res && res.value;
    }
    case "evalPage": {
      const [tabId, src, frameId, timeoutMs] = args;
      keepAwake(tabId);
      const [r] = await pageTimed(tabId, frameId, timeoutMs, api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func: pageEval, args: [src] }));
      if (!r) throw new Error("the page did not run it");
      if (r.result && r.result.error) throw new Error(r.result.error);
      return r.result;
    }
    case "pageData": {
      const [tabId] = args;
      const [r] = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: pageGlobals });
      if (!r) throw new Error("the page did not run it");
      return r.result;
    }
    case "upgrade.context":
      return upgradeContext(args[0]);
    case "upgrade.configure":
      return upgradeConfigure(args[0], args[1], args[2]);
    case "upgrade.audit":
      return upgradeAudit(args[0], args[1] ?? {});
    case "upgrade.react":
      return upgradeReact(args[0], args[1], args[2] ?? {});
    case "upgrade.site":
      return upgradeSite(args[0], args[1], args[2], args[3], args[4]);
    case "upgrade.native":
      return upgradeNativePreflight(args[0], args[1]);
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
    // whole: the tab is in its agent's window (daemon/spaces.ts), which
    // takes the size with the agent's other tabs and its name: on 10-07
    // each size an agent asked for split its tab into a window of its own,
    // which named no agent. That window keeps a size no other window has,
    // by which its keeper finds it. A tab in a window of the user's goes to
    // one of its own, and his keeps its size.
    case "window": {
      const [tabId, size, whole] = args;
      const t = await api.tabs.get(tabId);
      const alone = (await api.tabs.query({ windowId: t.windowId })).length === 1;
      const dims = { width: Math.round(size.width), height: Math.round(size.height) };
      const view = () => toTab(tabId, "tabInfo", [], 5000).then((r) => r?.value?.viewport, () => undefined);
      const was = await view();
      let sized;
      if (whole || alone) {
        const others = (await api.windows.getAll()).filter((w) => w.id !== t.windowId);
        while (others.some((w) => w.width === dims.width && w.height === dims.height)) dims.height++;
        sized = await api.windows.update(t.windowId, { ...dims, state: "normal" });
      } else {
        const w = await api.windows.create({ tabId, focused: false, ...dims });
        await markAgentWindow(w.id);
        sized = await api.windows.update(w.id, dims);
      }
      let viewport = await view();
      for (const end = Date.now() + VIEWPORT_MS; viewport && was && viewport.w === was.w && viewport.h === was.h && Date.now() < end;) {
        const pause = Promise.withResolvers();
        setTimeout(pause.resolve, 100);
        await pause.promise;
        viewport = await view();
      }
      return { ok: true, windowId: sized.id, size: { width: sized.width, height: sized.height }, viewport };
    }
    // A window of an agent's own (daemon/spaces.ts), made behind the user's
    // without focus, of a size no other window has: its keeper, which sees
    // windows only through Accessibility, finds it by size.
    case "windows.open": {
      const [url, size] = args;
      const dims = size ? { width: Math.round(size.width), height: Math.round(size.height) } : {};
      const [tab] = await harnessMade(async () => {
        const w = await api.windows.create({ url, focused: false, ...dims });
        return w.tabs && w.tabs.length ? w.tabs : api.tabs.query({ windowId: w.id });
      });
      await markAgentWindow(tab.windowId);
      await ownTab(tab.id);
      if (size) await api.windows.update(tab.windowId, dims);
      return { windowId: tab.windowId, tabId: tab.id };
    }
    // The id a window the daemon knew before the extension reloaded has
    // now, or null once it is gone.
    case "windows.resolve": {
      const id = await resolveWindow(args[0]);
      return (await api.windows.get(id).then(() => true, () => false)) ? id : null;
    }
    // The tab group keeper begins, or is done, making a window's tab group
    // (spaces.ts); a tab Safari makes in the window meanwhile is its own.
    case "windows.regrouping": {
      const [windowId, on] = args;
      const id = await resolveWindow(windowId);
      if (on) regrouping.set(id, Date.now());
      else regrouping.delete(id);
      return { ok: true };
    }
    // A tab an agent opened for the user leaves the agent's window, which
    // goes with its tab group, for one of his own; only while it is still
    // in that window.
    case "tabs.detach": {
      const [tabId, windowId] = args;
      if ((await api.tabs.get(tabId)).windowId !== await resolveWindow(windowId)) return { ok: false };
      await api.windows.create({ tabId, focused: false });
      return { ok: true };
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
  pageLoads.delete(id);
  awake.delete(id);
  if (drivenTabs.delete(id)) store.set({ driven: [...drivenTabs] }).catch(() => {});
  harnessTabs.delete(id);
  store.remove(`dialogs:${id}`).catch(() => {});
  api.storage.local.get("tabAliases").then(({ tabAliases }) => {
    if (!tabAliases) return;
    for (const k of Object.keys(tabAliases)) if (tabAliases[k] === id) delete tabAliases[k];
    return api.storage.local.set({ tabAliases });
  }).catch(() => {});
});
// Embedded frames report too; only the top document makes the tab ready, and
// a frame that loads while a wait runs (a sign-in frame) joins the wait.
// Each gets back how to answer dialogs, if the harness owns its tab.
api.runtime.onMessage.addListener((m, sender) => {
  if (!m || m.__safariHarnessReady !== 1 || !sender.tab) return;
  if (!sender.frameId) markReady(sender.tab.id);
  else for (const w of frameWaits.get(sender.tab.id)?.values() ?? []) w.join(sender.frameId);
  return Promise.all([policyOf(sender.tab.id), drivenRead]).then(([dialogs]) => ({ dialogs, tab: sender.tab.id, window: sender.tab.windowId, net: dialogs !== null || drivenTabs.has(sender.tab.id) }));
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
  // A fast open or popup may have loaded before its ownership was saved.
  const load = pageLoads.get(tabId);
  if (load) await reportLoad(tabId, load);
  else {
    const tab = await api.tabs.get(tabId);
    if (tab.status === "complete") loaded(tabId, tab.url);
  }
  await toTab(tabId, "dialogs", [policy], 5000).catch(() => {});
}

// ---------- tabs gone ----------
// Why a tab the daemon names is gone. The answer once named the end of a
// turn, 20 minutes unused, or the user, whatever closed it: on 10-16 a
// Safari panic reset ended six hunt agents' windows, and each of 12 calls
// after was told its turn had ended (HuntsUsage). Safari says when a tab
// goes with its window, the harness marks its own closes, and the rest are
// the user's or the page's own. A tab not seen to go was given its id
// before this load of the extension. Kept in session storage, which
// outlives this page while Safari runs and empties as the extension goes.
const GONE_KEPT = 500;
const closedTabs = new Map(); // tabId -> { at, how: "harness" | "window" | "user" }
const closing = new Set(); // tabs the harness is closing now
const goneRead = store.get(["gone", "goneSince"]).then(async ({ gone = [], goneSince }) => {
  const seen = [...closedTabs];
  closedTabs.clear();
  for (const [id, closed] of [...gone, ...seen]) closedTabs.set(id, closed);
  if (goneSince === undefined) await store.set({ goneSince: Date.now() });
  return goneSince ?? Date.now();
}, () => Date.now());

api.tabs.onRemoved.addListener((id, info) => {
  closedTabs.delete(id);
  closedTabs.set(id, { at: Date.now(), how: closing.delete(id) ? "harness" : info?.isWindowClosing ? "window" : "user" });
  for (const old of closedTabs.keys()) {
    if (closedTabs.size <= GONE_KEPT) break;
    closedTabs.delete(old);
  }
  goneRead.then(() => store.set({ gone: [...closedTabs] })).catch(() => {});
});

// What the daemon is told of a tab Safari no longer knows.
async function goneText(tabId) {
  const since = await goneRead;
  const closed = closedTabs.get(tabId);
  const ago = (at) => {
    const s = Math.round((Date.now() - at) / 1000);
    return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} minutes` : `${Math.round(s / 3600)} hours`;
  };
  const why = !Number.isSafeInteger(tabId) ? ""
    : closed?.how === "harness" ? `: the harness closed it ${ago(closed.at)} ago (at the end of a turn, or after 20 minutes unused); a tab you need past your turn must be kept with keep`
    : closed?.how === "window" ? `: it closed with its window ${ago(closed.at)} ago`
    : closed ? `: the user or its own page closed it ${ago(closed.at)} ago`
    : `: Safari has had no tab ${tabId} in the ${ago(since)} since the extension started, so it closed before then (Safari quit or crashed, or the extension reloaded), or that id was never a tab's`;
  return `that tab is gone${why}; find it with tabs, or open it again`;
}

// On 09-30 the daemon noted only loads a tool answered with: eval, a later
// redirect or refresh, and real input still looked like the user's visits.
// Safari's tab updates see all of those. drivenTabs is not ownership: an
// agent may read the user's tab without making its later visits the agent's.
const pageLoads = new Map();

function loaded(tabId, url, at = Date.now()) {
  if (!url) return;
  const before = pageLoads.get(tabId);
  if (before?.url === url) return;
  const load = { url, from: before?.url ? at : before?.from ?? at, to: at, loading: before?.loading ?? false, sent: false };
  pageLoads.set(tabId, load);
  void reportLoad(tabId, load);
}

async function reportLoad(tabId, load) {
  if (!load.url || load.sent || !(await ownsTab(tabId)) || load.sent) return;
  load.sent = send({ op: "load", url: load.url, from: load.from, to: load.to });
}

api.tabs.onUpdated.addListener((tabId, info, tab) => {
  const at = Date.now();
  // A reload visits the same address again. URL and complete updates of
  // that one load, including Safari's repeated unchanged URL, do not.
  if (info.status === "loading" && !pageLoads.get(tabId)?.loading) pageLoads.set(tabId, { from: at, loading: true });
  if (info.url || info.status === "complete") loaded(tabId, info.url || tab.url, at);
  if (info.status === "complete") {
    const load = pageLoads.get(tabId);
    if (load) load.loading = false;
  }
});


// The daemon's own closes (an agent gone, a tab left idle) take only a tab
// the harness owns, so an id Safari has since given another tab is left
// alone; an idle one stays while the user has it in front: in his own
// front window, or in an agent window Safari shows in front. On 10-05 an
// OAuth consent tab an agent had raised (activate) closed as its turn
// ended while he was authorizing in it, its callback with it (01a10ea8).
async function inFront(tabId) {
  const t = await api.tabs.get(tabId);
  if (!t.active) return false;
  // a front Safari cannot tell in time counts as his: the tab stays
  const until = Date.now() + LIST_MS;
  return Promise.all([frontWindow(false, until), frontWindow(true, until)]).then(([his, shown]) => t.windowId === his || t.windowId === shown, (e) => {
    if (!e.phase) throw e;
    return true;
  });
}

// ---------- ids across a reload ----------
// Safari gives every tab and window a new id when the extension reloads (a
// deploy, or the daemon's reload in connect), and agents and the daemon
// still hold the old ones. Each page keeps the ids its tab and window had
// when it reported in (content.js), in the extension's own world, which
// outlives the reload. The extension reads those marks once it is reloaded,
// or at the first request for a tab or window Safari no longer knows: each
// old id maps to the new id, and the marks become the new ids for the next
// reload. The maps live in storage.local, which outlives a reload too; an
// alias goes with its tab. On a Mac nearly out of memory Safari refuses
// every write there ("Disk I/O error", 10-20 and 10-21) until it is quit:
// the ids still reach the daemon, and are only not kept for the next reload.
// The daemon is told each old tab id's new one (sendIds), so what it keeps
// per tab, and the ids agents hold, follow their tabs. What is kept here in
// session storage (the tabs the harness owns, and those it drives) does
// not: Safari empties session storage when it unloads the extension.
// A window is found through its pages, so an agent's window opens on one
// (the daemon's /space), not on about:blank, which has no content script.
let adopted = null;

async function resolveTab(tabId) {
  if (await api.tabs.get(tabId).then(() => true, () => false)) return tabId;
  adopted ??= adopt();
  return (await adopted).tabs[tabId] ?? tabId;
}

async function resolveWindow(windowId) {
  if (await api.windows.get(windowId).then(() => true, () => false)) return windowId;
  adopted ??= adopt();
  return (await adopted).windows[windowId] ?? windowId;
}

async function adopt() {
  const { tabAliases: tabs = {}, windowAliases: windows = {} } = await api.storage.local.get(["tabAliases", "windowAliases"]);
  const open = await api.tabs.query({});
  // A page that never answers (stuck loading, or a dialog holds it) held
  // adopt, and every list and close behind it: each mark gets MARK_MS.
  const marks = await Promise.all(open.map((t) => bounded(api.scripting.executeScript({
    target: { tabId: t.id, frameIds: [0] },
    func: (tab, win) => {
      const was = { tab: window.__safariHarnessTab, window: window.__safariHarnessWindow };
      window.__safariHarnessTab = tab;
      window.__safariHarnessWindow = win;
      return was;
    },
    args: [t.id, t.windowId],
  }), "adopt", Date.now() + MARK_MS).then(([r]) => r && r.result, () => undefined)));
  for (const [i, t] of open.entries()) {
    alias(tabs, marks[i]?.tab, t.id);
    alias(windows, marks[i]?.window, t.windowId);
  }
  // The agent windows, and the order he focused his in, by their new ids;
  // queued, so they read the map as it is here.
  const moved = { ...windows };
  const lists = Promise.all([updateList("agentWindows", (ids) => ids.map((id) => moved[id] ?? id)), updateList("focusOrder", (ids) => ids.map((id) => moved[id] ?? id))]);
  // an old id Safari has since given to another tab or window names that one
  for (const t of open) {
    delete tabs[t.id];
    delete windows[t.windowId];
  }
  await Promise.all([api.storage.local.set({ tabAliases: tabs, windowAliases: windows }).catch(() => {}), lists]);
  if (Object.keys(tabs).length || Object.keys(windows).length) log("ids after the reload", JSON.stringify({ tabs, windows }));
  const ids = { tabs, windows };
  sendIds(ids);
  return ids;
}

// The daemon keeps tab ids too (tools.ts), and agents hold them: it is told
// each old id and its tab's id now once they are read, and again each time
// it connects, since a restarted daemon has only its own list of tabs.
function sendIds({ tabs }) {
  if (Object.keys(tabs).length > 0) send({ op: "tab", kind: "renumbered", tabs });
}
api.runtime.onInstalled.addListener(() => { adopted ??= adopt(); });
// A tab moved to another window (window, or the user dragging it) marks
// that one.
api.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  api.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (win) => { if (window.__safariHarnessTab !== undefined) window.__safariHarnessWindow = win; },
    args: [newWindowId],
  }).catch(() => {});
});

// Maps the old id was to now, and every id that named was before to now.
function alias(map, was, now) {
  if (typeof was !== "number" || was === now) return;
  for (const k of Object.keys(map)) if (map[k] === was) map[k] = now;
  map[was] = now;
}

// ---------- agent windows ----------
// The windows made for agents (windows.open, window), which never hold the
// user's front tab. Safari's getLastFocused names the newest window, even
// one made behind his without focus, so the order he focused windows in is
// kept here, and agent windows are left out when it is read. Both lists
// outlive a reload (adopt maps them to the new ids); a Safari that starts
// again numbers its windows anew, and they start empty.
// The lists are read from storage.local once, as this page starts, and
// kept here, each change written through. On 10-20 Safari left a read of
// them for each tab list unanswered past 2.5 s, again and again for two
// minutes, and tab: "front" failed for it. A read it leaves unanswered, or
// refuses, is asked again, every LIST_MS at first, then less often, up to
// every 30 s, and noted once: an empty answer in its place would be written
// back by the next change, forgetting the agent windows.
const windowLists = { agentWindows: [], focusOrder: [] };
function readLists() {
  return new Promise((resolve) => {
    const began = Date.now();
    let wait = LIST_MS;
    let asks = 0;
    let noted = false;
    let again = null;
    const ask = () => {
      asks += 1;
      if (asks > 1 && !noted) noted = send({ op: "note", kind: "slow-phase", phase: "window lists", ms: Date.now() - began });
      if (asks > 3) wait = Math.min(wait * 2, 30_000);
      again = setTimeout(ask, wait);
      api.storage.local.get(Object.keys(windowLists)).then((kept) => {
        clearTimeout(again);
        resolve(kept);
      }, () => {});
    };
    ask();
  });
}
let listsChanged = readLists().then((kept) => {
  for (const key of Object.keys(windowLists)) windowLists[key] = kept[key] || [];
});
let listsSaved = Promise.resolve();

// One change to one list, after the read and every change before it.
function updateList(key, change) {
  const next = listsChanged.then(() => {
    const list = change(windowLists[key]);
    windowLists[key] = list;
    listsSaved = listsSaved.then(() => api.storage.local.set({ [key]: list })).catch(() => {});
  });
  listsChanged = next.catch(() => {});
  return next;
}

function markAgentWindow(id) {
  return updateList("agentWindows", (ids) => [...ids, id]);
}

api.runtime.onStartup.addListener(() => {
  updateList("agentWindows", () => []);
  updateList("focusOrder", () => []);
  api.storage.local.remove(["tabAliases", "windowAliases"]).catch(() => {});
});
api.windows.onFocusChanged.addListener((id) => {
  if (id !== api.windows.WINDOW_ID_NONE) updateList("focusOrder", (ids) => [id, ...ids.filter((w) => w !== id)].slice(0, 10));
});
api.windows.onRemoved.addListener((id) => {
  updateList("agentWindows", (ids) => ids.filter((w) => w !== id));
  updateList("focusOrder", (ids) => ids.filter((w) => w !== id));
  regrouping.delete(id);
  api.storage.local.get("windowAliases").then(({ windowAliases }) => {
    if (!windowAliases) return;
    for (const k of Object.keys(windowAliases)) if (windowAliases[k] === id) delete windowAliases[k];
    return api.storage.local.set({ windowAliases });
  }).catch(() => {});
});

// The window focused last: with agents, whichever it is; without, the one
// the user had in front last, leaving agent windows out.
async function frontWindow(agents, until = Date.now() + LIST_MS) {
  // Right after a reload, the lists hold the old ids until adopt maps them.
  if (adopted) await bounded(adopted.catch(() => {}), "adopt", until);
  const [, open, last] = await Promise.all([
    bounded(listsChanged, "window lists", until),
    bounded(api.windows.getAll(), "windows.getAll", until),
    bounded(api.windows.getLastFocused(), "windows.getLastFocused", until).then((w) => w.id, (e) => {
      if (e.phase) throw e;
      return undefined;
    }),
  ]);
  const { focusOrder, agentWindows } = windowLists;
  const ids = new Set(open.map((w) => w.id));
  return [...focusOrder, last, ...ids].find((id) => ids.has(id) && (agents || !agentWindows.includes(id)));
}

// ---------- tabs agents work in ----------
// A tab the harness owns, opened, or sent a page request, and a tab one of
// those opened, keeps a request log on each new page (dialogs.js); any
// other tab's page drops its log once it reports in, so the user's own tabs
// run their own fetch. A tab is marked before its page can report in. Kept
// in session storage, which outlives this page while Safari runs.
const drivenTabs = new Set();
const drivenRead = store.get("driven").then(({ driven = [] }) => { for (const id of driven) drivenTabs.add(id); }, () => {});

function drive(tabId) {
  if (drivenTabs.has(tabId)) return;
  drivenTabs.add(tabId);
  drivenRead.then(() => store.set({ driven: [...drivenTabs] })).catch(() => {});
}

// ---------- tabs that change id, and popups ----------
// Safari may swap a tab for another under a new id (a page it prepared
// ahead, shown in the tab's place). What is kept for the old id moves to the
// new one, the old id becomes an alias of it (see "ids across a reload"),
// and the daemon moves what it keeps (continuity.ts).
if (api.tabs.onReplaced) {
  api.tabs.onReplaced.addListener(async (added, removed) => {
    pageLoads.delete(removed);
    send({ op: "tab", kind: "replaced", from: removed, to: added });
    for (const map of [awake, frameWaits, snapshotRefs]) {
      if (!map.has(removed)) continue;
      map.set(added, map.get(removed));
      map.delete(removed);
    }
    if (drivenTabs.delete(removed)) drive(added);
    // a wait for the old page to be ready waits for the new one
    const waiters = readyWaiters.get(removed);
    readyWaiters.delete(removed);
    ready.delete(removed);
    if (waiters) {
      if (!readyWaiters.has(added)) readyWaiters.set(added, new Set());
      for (const w of waiters) readyWaiters.get(added).add(w);
      api.tabs.get(added).then((t) => { if (ready.get(added) === true || t.status === "complete") markReady(added); }, () => {});
    }
    const policy = await policyOf(removed);
    if (policy) {
      await store.set({ [`dialogs:${added}`]: policy });
      await store.remove(`dialogs:${removed}`);
      await ownTab(added);
    }
    const { tabAliases = {} } = await api.storage.local.get("tabAliases");
    alias(tabAliases, removed, added);
    await api.storage.local.set({ tabAliases });
    adopted?.then((a) => alias(a.tabs, removed, added), () => {});
  });
}

// ---------- tabs a page opens ----------
// Safari sets no openerTabId on a tab a page opens, so the page says one is
// coming: a window.open (dialogs.js), or an action whose link or form opens
// a tab (withOutcome in content.js). The tab made with no opener within a
// second of that, before or after, is that page's (pairIn). One nothing
// announced is nobody's: Safari makes tabs of its own (the tab group
// keeper's New Tab Group made one while a replay clicked, and the click
// took it).
const POPUP_MS = 1000;
const acting = new Map(); // tabId -> act's claim, while an action on it runs
// Each page's word and each tab made with no opener, with its window. With
// one of each, a second page's word in the same second replaced the
// first's, and the first page's tab went to the second page, which may be
// another agent's (09-30).
const announced = new Map(); // opener tabId -> { windowId, at }
const unclaimed = new Map(); // tabId -> { tab, windowId, at }
// Tabs the harness makes (tabs.open, windows.open), and those Safari makes
// in a window while the keeper makes its tab group (spaces.ts), are no
// page's. On 09-30 a blank tab made while the keeper made a window's group
// went to an agent as a popup, which it could neither read nor close
// (01a0f14c); the page of an agent's window could go the same way.
const harnessTabs = new Set();
const creating = new Set(); // calls making tabs, each settled once they are in harnessTabs
const regrouping = new Map(); // windowId -> when the keeper began making its tab group
// A step that never tells its end (a keeper stopped midway) leaves the
// window's tabs a page's again after this; one takes seconds.
const REGROUP_MS = 60_000;

// Makes tabs through Safari, which may tell of one (onCreated) before the
// call that made it answers: a tab made while one runs waits for it.
async function harnessMade(make) {
  let done;
  const settled = new Promise((resolve) => { done = resolve; });
  creating.add(settled);
  try {
    const made = await make();
    for (const t of made) harnessTabs.add(t.id);
    return made;
  } finally {
    creating.delete(settled);
    done();
  }
}

// The entries said or made within POPUP_MS of now; the rest are forgotten.
function recent(entries, now = Date.now()) {
  for (const [id, e] of entries) if (now - e.at >= POPUP_MS) entries.delete(id);
  return [...entries];
}

// The id of entries ([id, { windowId }]) to pair with: the latest in
// windowId, as a page's tab opens beside it; with none there, the only
// one, when nothing else waits on this side (alone): a popup window. Any
// other would be a guess between pages, or between tabs.
function pairIn(entries, windowId, alone) {
  const here = entries.filter(([, e]) => e.windowId === windowId);
  if (here.length) return here.at(-1)[0];
  return alone && entries.length === 1 ? entries[0][0] : undefined;
}

// The tab goes to the action running on its opener. Outside an action, one
// an owned tab's page opens on its own (a sign-in popup a script opens
// later) is owned too, and the daemon gives it to the agent that owns the
// opener; a tab the user's own tabs open stays his. The daemon hears of it
// once it has an address, which tells the agent what it is.
function adoptPopup(t, opener) {
  const claim = acting.get(opener);
  if (claim) return claim(t);
  setTimeout(async () => {
    if (drivenTabs.has(t.id) || !(await ownsTab(opener))) return;
    drive(t.id);
    if (ready.get(t.id) !== true) ready.set(t.id, false);
    await ownTab(t.id);
    await waitReady(t.id, 3000);
    const now = await api.tabs.get(t.id).catch(() => null);
    if (now) readyUnlessLoading(now);
    send({ op: "tab", kind: "popup", tab: t.id, opener, url: (now ?? t).url || t.pendingUrl || "" });
  }, 0);
}

// A tab a page opens is not ready until its page reports in (claim in act,
// adoptPopup). One that reads "complete" once that wait ends is loading
// nothing more: a blank one takes no script, so it never reports in, and
// each request to it waited 15 s for a page before failing (01a0f14c,
// 09-30). It is ready as it stands; a load in it later is waited for.
function readyUnlessLoading(t) {
  if (t.status === "complete") markReady(t.id);
}

// A page said a tab is coming: one made with no opener within POPUP_MS
// before is its, else one made after (onCreated).
function announce(opener, windowId) {
  const alone = recent(announced).length === 0;
  const id = pairIn(recent(unclaimed).filter(([tabId]) => tabId !== opener), windowId, alone);
  if (id === undefined) {
    announced.set(opener, { windowId, at: Date.now() });
    return;
  }
  const { tab } = unclaimed.get(id);
  unclaimed.delete(id);
  adoptPopup(tab, opener);
}

api.runtime.onMessage.addListener((m, sender) => {
  if (m && m.__safariHarnessPopup === 1 && sender.tab) announce(sender.tab.id, sender.tab.windowId);
});

api.tabs.onCreated.addListener(async (t) => {
  // As of when Safari told of the tab, not after the wait on the harness's
  // own calls below: a page's word could expire meanwhile.
  const at = Date.now();
  const since = regrouping.get(t.windowId);
  if (since !== undefined && at - since < REGROUP_MS) harnessTabs.add(t.id);
  if (creating.size) await Promise.all(creating);
  if (harnessTabs.has(t.id)) return;
  const opener = t.openerTabId ?? pairIn(recent(announced, at), t.windowId, recent(unclaimed, at).length === 0);
  if (opener === undefined) {
    unclaimed.set(t.id, { tab: t, windowId: t.windowId, at });
    return;
  }
  announced.delete(opener);
  adoptPopup(t, opener);
});

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
  drive(tabId);
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

// ---------- teach mode ----------
// The user clicks the toolbar button to record what he does in that tab
// (content.js records each step), and clicks it again to stop; the daemon
// saves the recording for replay (daemon/recordings.ts). No other tab is
// recorded. A recording is kept in session storage, which outlives this
// page while Safari runs; it also stops when its tab closes, or after
// REC_MINUTES.
const REC_MINUTES = 30;
// The page moving to a new address this soon after a step (a link, a
// form, a redirect) is that step's doing, which a replay lets it do again.
const FOLLOWS_MS = 5000;
const recTabs = new Set(); // tabs being recorded
const stopping = new Set(); // tabs whose page is still handing over its last step
const recRead = store.get(null).then((all) => {
  for (const key of Object.keys(all)) if (key.startsWith("rec:")) recTabs.add(Number(key.slice(4)));
}, () => {});
let recQueue = Promise.resolve();

// Read-modify-write of a tab's recording, one change at a time; a change
// that returns false leaves it as it was.
function changeRecording(tabId, change) {
  const next = recQueue.then(async () => {
    const key = `rec:${tabId}`;
    const rec = (await store.get(key))[key];
    if (rec && change(rec) !== false) await store.set({ [key]: rec });
  });
  recQueue = next.catch((e) => log("recording not kept", String(e)));
  return recQueue;
}

function showRecording(tabId, on) {
  api.action.setBadgeText({ tabId, text: on ? "REC" : "" }).catch(() => {});
  api.action.setTitle({ tabId, title: on ? "recording: click to stop" : "Safari Harness" }).catch(() => {});
}

// Tells the tab's top page to record or stop, putting the script in first
// where Safari left none; a page still loading hears it when it reports
// in. The answer to a stop holds the step he was still typing.
async function tellPage(tabId, on) {
  try {
    let how = await reach(tabId, 0, PING_MS);
    if (!how && on) {
      await ensureContent(tabId, 0, PING_MS, true);
      how = await reach(tabId, 0, PING_MS);
    }
    if (!how) return null;
    const res = await sendUntilNavigation(tabId, { __safariHarness: 1, id: nextId(), op: "record", args: [on] }, PING_MS, 0, how === "script");
    return (res && res.value && res.value.pending) || null;
  } catch {
    return null;
  }
}

async function startRecording(tab) {
  await store.set({ [`rec:${tab.id}`]: { url: tab.url, title: tab.title, startedAt: Date.now(), steps: [], lastAt: 0 } });
  recTabs.add(tab.id);
  showRecording(tab.id, true);
  api.alarms.create(`sh-rec-${tab.id}`, { delayInMinutes: REC_MINUTES });
  await tellPage(tab.id, true);
}

// Ends the tab's recording and hands it to the daemon. why: stopped (the
// button), closed (the tab), or time limit.
async function stopRecording(tabId, why) {
  if (!recTabs.has(tabId) || stopping.has(tabId)) return;
  stopping.add(tabId);
  api.alarms.clear(`sh-rec-${tabId}`);
  const closed = why === "closed";
  if (!closed) showRecording(tabId, false);
  // steps he makes meanwhile still count, until the page has stopped
  const pending = closed ? null : await tellPage(tabId, false);
  recTabs.delete(tabId);
  stopping.delete(tabId);
  const key = `rec:${tabId}`;
  const done = recQueue.then(async () => {
    const rec = (await store.get(key))[key];
    await store.remove(key);
    if (!rec) return;
    if (pending) rec.steps.push(pending);
    delete rec.lastAt;
    await deliver({ ...rec, stoppedAt: Date.now(), why });
  });
  recQueue = done.catch((e) => log("recording lost", String(e)));
  return recQueue;
}

// The daemon saves it; while the daemon is away it waits here, and goes
// out once the socket opens again.
async function deliver(rec) {
  if (send({ op: "recording", recording: rec })) return;
  const { recOut = [] } = await store.get("recOut");
  await store.set({ recOut: [...recOut, rec] });
}

async function sendRecordings() {
  const { recOut = [] } = await store.get("recOut");
  if (recOut.length === 0) return;
  await store.remove("recOut");
  for (const rec of recOut) await deliver(rec);
}

api.action.onClicked.addListener((tab) => {
  recRead.then(() => (recTabs.has(tab.id) ? stopRecording(tab.id, "stopped") : startRecording(tab))).catch((e) => log("teach mode", String(e)));
});
api.runtime.onMessage.addListener((m, sender) => {
  if (!m || !sender.tab || sender.frameId !== 0) return;
  const tabId = sender.tab.id;
  if (m.__safariHarnessStep === 1) {
    recRead.then(() => {
      if (recTabs.has(tabId)) changeRecording(tabId, (rec) => { rec.steps.push(m.step); rec.lastAt = Date.now(); });
    });
  } else if (m.__safariHarnessReady === 1) {
    // each new page in the tab records too
    recRead.then(() => {
      if (!recTabs.has(tabId) || stopping.has(tabId)) return;
      showRecording(tabId, true);
      tellPage(tabId, true);
    });
  }
});
api.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  recRead.then(() => {
    if (!recTabs.has(tabId)) return;
    // the step the page sends as it leaves may come in just after this
    setTimeout(() => changeRecording(tabId, (rec) => {
      const at = rec.steps.findLast((s) => s.kind === "navigate")?.url ?? rec.url;
      if (info.url === at) return false;
      rec.steps.push({ kind: "navigate", url: info.url, from: Date.now() - rec.lastAt < FOLLOWS_MS ? "step" : "user" });
      rec.lastAt = Date.now();
    }), 300);
  });
});
api.alarms.onAlarm.addListener((a) => {
  const m = /^sh-rec-(\d+)$/.exec(a.name);
  if (m) recRead.then(() => stopRecording(Number(m[1]), "time limit"));
});
api.tabs.onRemoved.addListener((tabId) => {
  recRead.then(() => stopRecording(tabId, "closed"));
});

let memoryPolicy = { enabled: false, sites: [], excludedSites: [] };
let memoryRevision = -1;
let memoryTimer;

async function publicMemorySource(tabId, source, version) {
  if (!source || typeof source.url !== "string" || typeof source.body !== "string" || source.body.length < 40 || source.body.length > 24000) return false;
  if (version !== memoryRevision || memoryPolicy.researchEnabled !== true) return false;
  let url;
  try { url = new URL(source.url); } catch { return false; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || !host.includes(".") || host.includes(":") ||
      /^(?:\d+\.){3}\d+$/.test(host) || /\.(?:local|localhost|internal|lan|home)$/.test(host) ||
      memoryPolicy.excludedSites.includes(host) ||
      /(?:^|\/)(?:login|signin|sign-in|account|accounts|inbox|messages|settings|billing|checkout|admin|dashboard)(?:\/|$)/i.test(url.pathname)) return false;
  const tab = await api.tabs.get(tabId);
  if (tab.incognito !== false || tab.status !== "complete" || tab.url !== source.url) return false;
  return version === memoryRevision && memoryPolicy.researchEnabled === true && !memoryPolicy.excludedSites.includes(host);
}

async function memoryAllowed(tabId, expectedUrl) {
  if (!memoryPolicy.enabled) return false;
  await Promise.all([drivenRead, adopted, listsChanged]);
  const tab = await api.tabs.get(tabId);
  if (tab.incognito !== false || !tab.active || tab.status !== "complete" || tab.url !== expectedUrl) return false;
  if (drivenTabs.has(tabId) || harnessTabs.has(tabId) || windowLists.agentWindows.includes(tab.windowId) || await ownsTab(tabId)) return false;
  const window = await api.windows.getLastFocused();
  if (!window.focused || window.id !== tab.windowId || window.incognito === true) return false;
  let url;
  try { url = new URL(tab.url); } catch { return false; }
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && memoryPolicy.sites.includes(url.hostname) && !memoryPolicy.excludedSites.includes(url.hostname);
}

function considerMemory(tabId) {
  clearTimeout(memoryTimer);
  if (!memoryPolicy.enabled) return;
  const revision = memoryRevision;
  memoryTimer = setTimeout(async () => {
    try {
      const tab = await api.tabs.get(tabId);
      if (revision === memoryRevision && await memoryAllowed(tabId, tab.url) && revision === memoryRevision) send({ op: "memory", tab: tabId, url: tab.url, revision });
    } catch {
      return;
    }
  }, 1500);
}

async function considerMemoryFront() {
  if (!memoryPolicy.enabled) return;
  try {
    const window = await api.windows.getLastFocused();
    const [tab] = await api.tabs.query({ active: true, windowId: window.id });
    if (tab) considerMemory(tab.id);
  } catch {
    return;
  }
}

api.tabs.onActivated.addListener(({ tabId }) => considerMemory(tabId));
api.tabs.onUpdated.addListener((id, info, tab) => {
  if (tab.active && (info.status === "complete" || info.url)) considerMemory(id);
});
api.windows.onFocusChanged.addListener(() => { void considerMemoryFront(); });

connect();
pingLoop();
