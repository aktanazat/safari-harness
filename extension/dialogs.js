// Safari Harness page-world script: runs in the page's own world at
// document_start in every frame, so it is in place before the page's
// scripts. It does nothing until content.js arms it (see "dialogs" in
// content.js): a dialog in a user's tab still shows as usual.
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
})();
