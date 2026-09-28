// Safari Harness page-world script: runs in the page's own world at
// document_start in every frame, so it is in place before the page's
// scripts. It logs the page's fetch and XHR requests from the start, for
// the net tool. The rest does nothing until content.js arms it (see
// "dialogs" in content.js): a dialog in a user's tab still shows as usual.
//
// Armed, it answers alert, confirm, prompt, and print without showing them
// (a dialog blocks the page and every harness request with it), and keeps
// beforeunload from holding a navigation. While catching downloads, it
// takes a blob or data link the page clicks, or a window it opens, instead
// of letting Safari save it. In a tab the harness owns, it keeps the page
// running while the tab is hidden. All of it reports to content.js, and
// hears from it, through DOM events.

(() => {
  const KEY = Symbol.for("safari-harness.page");
  // A page keeps the first copy for its life, through extension reloads:
  // the page holds on to the wrappers below (a saved fetch, timers set
  // through them), so a newer copy could not take them back. A newer
  // content.js therefore works with an older copy: its events only grow.
  if (window[KEY]) return;
  const state = (window[KEY] = { armed: false, accept: false, text: null, catching: false });
  const native = {
    alert: window.alert, confirm: window.confirm, prompt: window.prompt, print: window.print, open: window.open, click: HTMLAnchorElement.prototype.click,
    caf: window.cancelAnimationFrame, clearTimeout: window.clearTimeout,
    hidden: Object.getOwnPropertyDescriptor(Document.prototype, "hidden").get,
  };
  const tell = (name, value) => document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(value) }));
  const seen = (type, message, answer) => tell("__sh_dialog_seen", { type, message: String(message ?? "").slice(0, 500), answer, url: location.href });

  window.alert = function (message) {
    if (!state.armed) return native.alert.apply(this, arguments);
    seen("alert", message, null);
  };
  window.confirm = function (message) {
    if (!state.armed) return native.confirm.apply(this, arguments);
    seen("confirm", message, state.accept);
    return state.accept;
  };
  window.prompt = function (message, value) {
    if (!state.armed) return native.prompt.apply(this, arguments);
    const answer = state.accept ? (state.text ?? (value === undefined ? "" : String(value))) : null;
    seen("prompt", message, answer);
    return answer;
  };
  window.print = function () {
    if (!state.armed) return native.print.apply(this, arguments);
    seen("print", "", null);
  };
  addEventListener("beforeunload", (e) => { if (state.armed) e.stopImmediatePropagation(); }, true);
  document.addEventListener("__sh_dialog_policy", (e) => {
    if (typeof e.detail !== "string") return;
    try {
      const p = JSON.parse(e.detail);
      state.armed = !!p.armed;
      state.accept = !!p.accept;
      state.text = typeof p.text === "string" ? p.text : null;
      if (p.owned) own();
    } catch {}
  });

  // ---------- downloads ----------
  const saves = (a) => a instanceof HTMLAnchorElement && (a.hasAttribute("download") || /^(blob|data):/.test(a.href));
  const caught = (url, name) => tell("__sh_download_seen", { url, name: name || "" });
  HTMLAnchorElement.prototype.click = function () {
    if (state.catching && saves(this)) {
      caught(this.href, this.getAttribute("download"));
      return;
    }
    return native.click.apply(this, arguments);
  };
  addEventListener("click", (e) => {
    if (!state.catching) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || !saves(a)) return;
    e.preventDefault();
    caught(a.href, a.getAttribute("download"));
  }, true);
  window.open = function (url) {
    if (state.catching && url) {
      caught(new URL(String(url), location.href).href, "");
      return null;
    }
    // Safari gives the tab this makes no opener, so the page says it is
    // opening one (tabs a page opens, in background.js).
    tell("__sh_popup", {});
    return native.open.apply(this, arguments);
  };
  document.addEventListener("__sh_download_catch", (e) => { state.catching = e.detail === "1"; });

  // ---------- keeping a harness tab running ----------
  // Safari draws nothing in a hidden tab, so frame callbacks never run, and
  // within about 20 s it slows the tab's timers to under one a second. A web
  // app in a background harness tab then stalls: web components never
  // render, and its redirects and polls wait until the tab comes to the
  // front. In a tab the harness owns, the extension sends a tick every 50 ms
  // while it works there (see "keeping owned tabs running" in
  // background.js); while the tab is hidden, each tick runs the frame
  // callbacks and timers that are due, each in its own task, as a visible
  // tab would. The page also reads as visible, so it does not pause itself.
  // Ownership is known only after the page's first scripts ran, so every
  // tab tracks its callbacks from the start; in a user's tab nothing else
  // changes.
  let owned = false;
  let announcing = false;
  const frames = new Map(); // native frame id -> callback not yet run
  const timers = new Map(); // native timer id -> { fn, args, due, every }

  // A wrapper is a proxy of the browser's own function, so it still reads
  // as native code to a site that checks (anti-bot scripts do).
  const wrap = (fn, apply) => new Proxy(fn, { apply });
  const forget = (map) => (clear, self, args) => {
    map.delete(Number(args[0]));
    return Reflect.apply(clear, self, args);
  };
  window.requestAnimationFrame = wrap(window.requestAnimationFrame, (raf, self, args) => {
    const [callback] = args;
    if (typeof callback !== "function") return Reflect.apply(raf, self, args);
    const id = Reflect.apply(raf, self, [(t) => { if (frames.delete(id)) callback(t); }]);
    frames.set(id, callback);
    return id;
  });
  window.setTimeout = wrap(window.setTimeout, (set, self, args) => {
    const [fn, ms, ...rest] = args;
    if (typeof fn !== "function") return Reflect.apply(set, self, args);
    const id = Reflect.apply(set, self, [() => { if (timers.delete(id)) fn.apply(window, rest); }, ms]);
    timers.set(id, { fn, args: rest, due: performance.now() + Math.max(0, Number(ms) || 0), every: 0 });
    return id;
  });
  window.setInterval = wrap(window.setInterval, (set, self, args) => {
    const [fn, ms, ...rest] = args;
    if (typeof fn !== "function") return Reflect.apply(set, self, args);
    const timer = { fn, args: rest, due: 0, every: Math.max(1, Number(ms) || 0) };
    timer.due = performance.now() + timer.every;
    // A late native run right after a tick ran it would run it twice.
    const id = Reflect.apply(set, self, [() => {
      if (owned && native.hidden.call(document) && performance.now() < timer.due) return;
      timer.due = performance.now() + timer.every;
      fn.apply(window, rest);
    }, ms]);
    timers.set(id, timer);
    return id;
  });
  window.cancelAnimationFrame = wrap(window.cancelAnimationFrame, forget(frames));
  window.clearTimeout = wrap(window.clearTimeout, forget(timers));
  window.clearInterval = wrap(window.clearInterval, forget(timers));

  for (const [name, visible] of [["visibilityState", "visible"], ["hidden", false]]) {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, name);
    Object.defineProperty(Document.prototype, name, { ...d, get: wrap(d.get, (get, self, args) => (owned ? visible : Reflect.apply(get, self, args))) });
  }
  addEventListener("visibilitychange", (e) => { if (owned && !announcing) e.stopImmediatePropagation(); }, true);

  // Each callback runs in a task of its own, so the page's promises settle
  // between them as they would; a message channel is not slowed in a
  // hidden tab.
  const queue = [];
  const runner = new MessageChannel();
  runner.port1.onmessage = () => queue.shift()?.();
  const soon = (run) => { queue.push(run); runner.port2.postMessage(null); };

  function own() {
    if (owned) return;
    owned = true;
    if (!native.hidden.call(document)) return;
    // A page that paused itself while hidden resumes on this.
    announcing = true;
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    announcing = false;
  }

  document.addEventListener("__sh_tick", () => {
    if (!owned || !native.hidden.call(document)) return;
    const now = performance.now();
    const due = [...timers].filter(([, t]) => t.due <= now).sort((a, b) => a[1].due - b[1].due);
    for (const [id, t] of due) {
      soon(() => {
        // cleared, or run by an overlapping tick, since it was queued
        if (timers.get(id) !== t || t.due > performance.now()) return;
        if (t.every) t.due = performance.now() + t.every;
        else {
          timers.delete(id);
          native.clearTimeout.call(window, id);
        }
        t.fn.apply(window, t.args);
      });
    }
    for (const id of [...frames.keys()]) {
      soon(() => {
        const callback = frames.get(id);
        if (!callback) return;
        frames.delete(id);
        native.caf.call(window, id);
        callback(now);
      });
    }
  });

  // ---------- network log ----------
  // A page may keep its own copy of fetch from its first script (CVS's
  // insurance form did), so the log starts with the page: the net tool
  // (pageCapture in background.js) reads it, start clears it, and stop
  // ends it. An entry is added once its status is known, then gets the
  // start of a text or JSON body, read from a copy of the response, so the
  // page gets its own untouched. A failure in here never reaches the page.
  const net = (state.net = { on: true, log: [] });
  const LOG_MAX = 100;
  const URL_MAX = 500;
  const BODY_MAX = 300;
  const listen = EventTarget.prototype.addEventListener;
  const decoder = new TextDecoder();
  const textual = (type) => /^text\/|[/+]json\b/i.test(type ?? "");
  const cut = (s, max) => (s.length > max ? s.slice(0, max) + "…" : s);
  const address = (url) => {
    let href = String(url);
    try { href = new URL(href, document.baseURI).href; } catch {}
    return cut(href, URL_MAX);
  };
  const record = (entry, start) => {
    if (!net.on) return false;
    entry.ms = Math.round(performance.now() - start);
    entry.t = Date.now();
    net.log.push(entry);
    if (net.log.length > LOG_MAX) net.log.shift();
    return true;
  };

  const fetched = (entry, start, res) => {
    entry.status = res.status;
    if (!record(entry, start) || !textual(res.headers.get("content-type"))) return;
    const reader = res.clone().body?.getReader();
    reader?.read()
      .then(({ value }) => { if (value) entry.body = cut(decoder.decode(value.subarray(0, BODY_MAX * 4)), BODY_MAX); })
      .catch(() => {})
      .finally(() => reader.cancel().catch(() => {}));
  };
  const XHR = XMLHttpRequest.prototype;
  const plain = { fetch: window.fetch, open: XHR.open, send: XHR.send };
  const ours = {};
  // Requests begun and not yet answered, with when each began, for an
  // action's receipt (below): a page still waiting on its own site is busy.
  const flying = new Map(); // entry -> Date.now() at its start
  ours.fetch = wrap(plain.fetch, (fetch, self, args) => {
    const start = performance.now();
    const pending = Reflect.apply(fetch, self, args);
    let entry;
    try {
      const [input, init] = args;
      const req = input instanceof Request ? input : null;
      entry = { kind: "fetch", url: address(req ? req.url : input), method: String(init?.method ?? req?.method ?? "GET").toUpperCase() };
    } catch {
      return pending;
    }
    flying.set(entry, Date.now());
    return pending.then((res) => {
      flying.delete(entry);
      try { fetched(entry, start, res); } catch {}
      return res;
    }, (e) => {
      flying.delete(entry);
      try { record({ ...entry, error: String(e) }, start); } catch {}
      throw e;
    });
  });

  // An XHR's entry is written when it ends, or when the page opens the same
  // request again first (from its own load handler, while the answer is
  // still there to read).
  const xhrs = new WeakMap(); // request -> { entry, start } from open
  const listening = new WeakSet();
  const ended = (xhr) => {
    const req = xhrs.get(xhr);
    if (!req || req.start === null) return;
    xhrs.delete(xhr);
    flying.delete(req.entry);
    const { entry, start } = req;
    const answered = xhr.readyState === 4 && xhr.status > 0;
    if (answered) entry.status = xhr.status;
    else entry.error = "no response";
    if (!record(entry, start) || !answered) return;
    const type = xhr.responseType;
    if ((type === "" || type === "text") && textual(xhr.getResponseHeader("content-type"))) entry.body = cut(xhr.responseText.slice(0, BODY_MAX + 1), BODY_MAX);
  };
  ours.open = wrap(plain.open, (open, self, args) => {
    try { ended(self); } catch {}
    const out = Reflect.apply(open, self, args);
    try { xhrs.set(self, { entry: { kind: "xhr", url: address(args[1]), method: String(args[0]).toUpperCase() }, start: null }); } catch {}
    return out;
  });
  ours.send = wrap(plain.send, (send, self, args) => {
    try {
      const req = xhrs.get(self);
      if (req) {
        req.start = performance.now();
        flying.set(req.entry, Date.now());
        if (!listening.has(self)) {
          listening.add(self);
          // a loadend after the page opened the request again is the old one's
          Reflect.apply(listen, self, ["loadend", () => { try { if (self.readyState === 4) ended(self); } catch {} }]);
        }
      }
    } catch {}
    return Reflect.apply(send, self, args);
  });

  // A tab no agent works in keeps the page's own fetch and XMLHttpRequest:
  // content.js says so once the page reports in, and a copy the page took
  // meanwhile logs nothing. net start (pageCapture) puts the log back.
  const swap = (from, to) => {
    if (window.fetch === from.fetch) window.fetch = to.fetch;
    if (XHR.open === from.open) XHR.open = to.open;
    if (XHR.send === from.send) XHR.send = to.send;
  };
  state.logNet = () => swap(plain, ours);
  document.addEventListener("__sh_net_off", () => {
    net.on = false;
    net.log.length = 0;
    swap(ours, plain);
  });
  swap(plain, ours);

  // ---------- action receipts ----------
  // content.js asks, as it ends an action's watch (withReceipt there), what
  // the page did since the action began: the requests it made, from the
  // log (none while the log is off), those still out, and the errors it
  // did not catch, which are kept whether the log is on or not. The answer
  // goes back within the ask.
  const ERRORS_MAX = 20;
  const errors = []; // { t, message }
  const thrown = (message) => {
    errors.push({ t: Date.now(), message: cut(message, 200) });
    if (errors.length > ERRORS_MAX) errors.shift();
  };
  addEventListener("error", (e) => thrown(String(e.message)));
  addEventListener("unhandledrejection", (e) => {
    let why = "";
    try { why = e.reason instanceof Error ? e.reason.message : String(e.reason); } catch {}
    thrown(`unhandled rejection: ${why}`);
  });
  document.addEventListener("__sh_receipt_ask", (e) => {
    let since;
    try { since = JSON.parse(e.detail).since; } catch { return; }
    tell("__sh_receipt_answer", {
      requests: net.on ? net.log.filter((x) => x.t - x.ms >= since).map(({ method, url, status, error }) => ({ method, url, status, error })) : null,
      pending: net.on ? [...flying].filter(([, t]) => t >= since).map(([x]) => ({ method: x.method, url: x.url })) : null,
      errors: errors.filter((x) => x.t >= since).map((x) => x.message),
    });
  });
})();
