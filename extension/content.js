// Safari Harness content script.
// Runs in every page. Implements the DOM-side verbs the daemon calls:
// aria snapshots with stable element refs, click/type/scroll by ref,
// JS evaluation, extraction, and network capture.
//
// This is a clean-room implementation of the same contract Aside's
// injected.ts snapshot module provides for Chrome, adapted to Safari's
// Web Extension API (no chrome.debugger available).

(() => {
  if (window.__safariHarnessInjected) return;
  window.__safariHarnessInjected = true;

  const REF_ATTR = "data-sh-ref";
  let refSeq = 0;
  const refMap = new Map(); // ref -> element

  // ---------- role / name computation (ARIA-lite) ----------

  const ROLE_MAP = {
    A: (el) => (el.hasAttribute("href") ? "link" : null),
    BUTTON: () => "button",
    INPUT: (el) => {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      if (t === "file") return "button";
      return "textbox";
    },
    TEXTAREA: () => "textbox",
    SELECT: (el) => (el.multiple ? "listbox" : "combobox"),
    FORM: () => "form",
    NAV: () => "navigation",
    MAIN: () => "main",
    ARTICLE: () => "article",
    SECTION: (el) => (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null),
    ASIDE: () => "complementary",
    HEADER: (el) => (closestLandmark(el) ? null : "banner"),
    FOOTER: (el) => (closestLandmark(el) ? null : "contentinfo"),
    DIALOG: () => "dialog",
    PROGRESS: () => "progressbar",
    IMG: (el) => (el.alt === "" ? "presentation" : "img"),
    H1: () => "heading", H2: () => "heading", H3: () => "heading",
    H4: () => "heading", H5: () => "heading", H6: () => "heading",
  };

  function closestLandmark(el) {
    return el.closest("article, aside, main, nav, section, form");
  }

  function getExplicitRole(el) {
    const r = el.getAttribute && el.getAttribute("role");
    if (r) return r.split(/\s+/)[0];
    const fn = ROLE_MAP[el.tagName];
    return fn ? fn(el) : null;
  }

  const NAMED_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox",
    "radio", "slider", "heading", "img", "navigation", "main", "form", "dialog",
    "article", "banner", "contentinfo", "complementary", "region", "tab",
    "tabpanel", "menu", "menubar", "menuitem", "tree", "treeitem", "grid",
    "table", "alert", "alertdialog", "status", "tooltip", "progressbar",
  ]);

  const INTERACTIVE_TAGS = new Set([
    "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "DETAILS",
    "LABEL", "OPTION", "VIDEO", "AUDIO", "IFRAME",
  ]);

  function isInteractive(el) {
    if (el.tabIndex >= 0 && !el.hasAttribute("disabled")) return true;
    const role = getExplicitRole(el);
    if (role && ["button", "link", "textbox", "checkbox", "radio", "combobox", "listbox", "menuitem", "tab", "slider", "switch"].includes(role)) return true;
    if (el.onclick || el.onmousedown || el.onpointerdown) return true;
    return INTERACTIVE_TAGS.has(el.tagName);
  }

  function isVisible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (style.position === "fixed" && el.getClientRects().length === 0) return false;
    }
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function textOf(el, max = 120) {
    let t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > max) t = t.slice(0, max) + "…";
    return t;
  }

  function accessibleName(el) {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => textOf(n, 80));
      if (parts.some(Boolean)) return parts.filter(Boolean).join(" ");
    }
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    if (el.tagName === "IMG") return (el.getAttribute("alt") || "").trim();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.labels && el.labels.length) return textOf(el.labels[0], 80);
      const ph = el.getAttribute("placeholder");
      if (ph) return ph.trim();
      const name = el.getAttribute("name");
      if (name) return name.trim();
    }
    if (el.tagName === "BUTTON" || el.tagName === "A" || /^H[1-6]$/.test(el.tagName) ||
        el.tagName === "LABEL" || el.tagName === "SUMMARY") {
      return textOf(el, 80);
    }
    const title = el.getAttribute("title");
    if (title) return title.trim();
    return "";
  }

  function stateOf(el) {
    const s = [];
    if (el.hasAttribute("disabled")) s.push("disabled");
    if (el.getAttribute("aria-expanded") === "true") s.push("expanded");
    if (el.getAttribute("aria-checked") === "true" || el.checked === true) s.push("checked");
    if (el.getAttribute("aria-selected") === "true" || el.selected === true) s.push("selected");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      s.push("focused=" + (document.activeElement === el));
      const v = el.value;
      if (v) s.push(`value="${v.length > 40 ? v.slice(0, 40) + "…" : v}"`);
    }
    if (el.tagName === "SELECT" && el.options.length) {
      const sel = el.selectedOptions[0];
      if (sel) s.push(`value="${textOf(sel, 40)}"`);
    }
    if (el.href) {
      try { s.push("url=" + new URL(el.href, location.href).href); } catch {}
    }
    return s;
  }

  // ---------- snapshot ----------

  function ensureRef(el) {
    let ref = el.getAttribute(REF_ATTR);
    if (!ref) {
      refSeq += 1;
      ref = String(refSeq);
      el.setAttribute(REF_ATTR, ref);
    }
    refMap.set(ref, el);
    return ref;
  }

  function pruneRefs() {
    // drop refs whose elements left the DOM
    for (const [ref, el] of refMap) {
      if (!el.isConnected) refMap.delete(ref);
    }
  }

  function snapshot(opts = {}) {
    pruneRefs();
    const root = opts.root ? document.querySelector(opts.root) : document.body;
    if (!root) return { error: "root not found" };
    const lines = [];
    const maxNodes = opts.maxNodes || 600;
    let count = 0;

    const interesting = (el) => {
      const role = getExplicitRole(el);
      if (role && NAMED_ROLES.has(role)) return true;
      if (isInteractive(el)) return true;
      if (el.tagName === "P" || el.tagName === "LI") {
        const t = textOf(el, 200);
        return t.length > 0;
      }
      return false;
    };

    const walk = (el, depth) => {
      if (count >= maxNodes) return;
      if (!isVisible(el)) return;
      const role = getExplicitRole(el);
      const name = accessibleName(el);
      const keep = interesting(el);
      if (keep) {
        count += 1;
        const ref = ensureRef(el);
        const parts = ["  ".repeat(depth), `[${ref}] `];
        parts.push(role || el.tagName.toLowerCase());
        if (name) parts.push(` "${name}"`);
        const st = stateOf(el);
        if (st.length) parts.push(` {${st.join(", ")}}`);
        if ((el.tagName === "P" || el.tagName === "LI") && !name) {
          const t = textOf(el, 160);
          if (t) parts.push(` "${t}"`);
        }
        lines.push(parts.join(""));
      }
      const childDepth = keep ? depth + 1 : depth;
      for (const child of el.children) walk(child, childDepth);
    };

    walk(root, 0);
    return {
      url: location.href,
      title: document.title,
      nodes: count,
      truncated: count >= maxNodes,
      snapshot: lines.join("\n"),
    };
  }

  // ---------- actions ----------

  function resolve(ref) {
    const el = refMap.get(String(ref));
    if (!el || !el.isConnected) {
      const dom = document.querySelector(`[${REF_ATTR}="${ref}"]`);
      if (dom) { refMap.set(String(ref), dom); return dom; }
      return null;
    }
    return el;
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }

  function fireMouse(el, type, x, y) {
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0,
    }));
  }

  async function click(ref) {
    const el = resolve(ref);
    if (!el) return { error: `stale ref ${ref}; re-run snapshot` };
    // Reading the position below forces layout, so no frame wait is needed;
    // background tabs never run requestAnimationFrame, so waiting on one hangs.
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const { x, y } = centerOf(el);
    const target = document.elementFromPoint(x, y) || el;
    fireMouse(target, "pointerdown", x, y);
    fireMouse(target, "mousedown", x, y);
    fireMouse(target, "pointerup", x, y);
    fireMouse(target, "mouseup", x, y);
    target.dispatchEvent(new MouseEvent("click", {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0,
    }));
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) target.focus();
    return { ok: true, at: { x, y }, tag: target.tagName };
  }

  async function typeText(ref, text, opts = {}) {
    const el = resolve(ref);
    if (!el) return { error: `stale ref ${ref}; re-run snapshot` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (el.isContentEditable) {
      if (!opts.append) {
        el.textContent = "";
      }
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else if ("value" in el) {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const before = opts.append ? String(el.value || "") : "";
      setter.call(el, before + text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { error: "element is not editable" };
    }
    return { ok: true, value: (el.value ?? el.textContent ?? "").slice(0, 200) };
  }

  function pressKey(ref, key) {
    const el = resolve(ref) || document.activeElement || document.body;
    const common = { bubbles: true, cancelable: true, key };
    el.dispatchEvent(new KeyboardEvent("keydown", common));
    el.dispatchEvent(new KeyboardEvent("keyup", common));
    if (key === "Enter" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      const form = el.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    }
    return { ok: true };
  }

  function scrollBy(dx, dy) {
    window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    return { ok: true, scrollY: Math.round(window.scrollY), maxY: Math.round(document.documentElement.scrollHeight - innerHeight) };
  }

  function extract(opts = {}) {
    const mode = opts.selector ? "selector" : "main";
    let root = null;
    if (mode === "selector") root = document.querySelector(opts.selector);
    else root = document.querySelector("main, article, [role=main]") || document.body;
    if (!root) return { error: "no content root" };
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,svg,canvas,template").forEach((n) => n.remove());
    const text = (clone.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const limit = opts.maxBytes || 20000;
    return {
      url: location.href,
      title: document.title,
      text: text.length > limit ? text.slice(0, limit) + "\n…truncated" : text,
      truncated: text.length > limit,
    };
  }

  function tabInfo() {
    return {
      url: location.href,
      title: document.title,
      ready: document.readyState,
      scrollY: Math.round(window.scrollY),
      viewport: { w: innerWidth, h: innerHeight },
    };
  }

  // ---------- network capture ----------

  const netLog = [];
  let netOn = false;

  function record(entry) {
    if (!netOn) return;
    netLog.push({ ...entry, t: Date.now() });
    if (netLog.length > 500) netLog.shift();
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || "GET";
    const start = Date.now();
    try {
      const res = await origFetch.apply(this, arguments);
      record({ kind: "fetch", url, method, status: res.status, ms: Date.now() - start });
      return res;
    } catch (e) {
      record({ kind: "fetch", url, method, error: String(e), ms: Date.now() - start });
      throw e;
    }
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sh = { method, url };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    xhr.addEventListener("loadend", () => {
      record({ kind: "xhr", url: xhr.__sh && xhr.__sh.url, method: xhr.__sh && xhr.__sh.method, status: xhr.status, ms: Date.now() });
    });
    return origSend.apply(this, arguments);
  };

  // ---------- console capture ----------

  const consoleLog = [];
  let consoleOn = false;
  for (const level of ["log", "warn", "error"]) {
    const orig = console[level];
    console[level] = function (...args) {
      if (consoleOn) {
        consoleLog.push({ level, text: args.map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" ").slice(0, 500), t: Date.now() });
        if (consoleLog.length > 500) consoleLog.shift();
      }
      return orig.apply(this, args);
    };
  }

  // ---------- message dispatch ----------

  const handlers = {
    snapshot,
    click,
    type: (ref, text, opts) => typeText(ref, text, opts),
    press: pressKey,
    scroll: (dx, dy) => scrollBy(dx || 0, dy || 0),
    extract,
    tabInfo,
    eval: (src) => {
      // eslint-disable-next-line no-new-func
      const result = new Function(`return (${src})`)();
      if (result && typeof result.then === "function") {
        return result.then((v) => ({ ok: true, result: safeClone(v) }));
      }
      return { ok: true, result: safeClone(result) };
    },
    net: (on) => { netOn = !!on; if (on) netLog.length = 0; return { ok: true }; },
    netRead: () => ({ entries: netLog.slice(-100) }),
    console: (on) => { consoleOn = !!on; if (on) consoleLog.length = 0; return { ok: true }; },
    consoleRead: () => ({ entries: consoleLog.slice(-100) }),
    wait: waitFor,
    // Resolves once the tab has drawn two frames, i.e. it is visible and painted.
    painted: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ ok: true })))),
    clickAt,
    setFiles,
  };

  // Sleep for ms, or, given a selector or text, poll until it is present
  // (ms is then the timeout). Resolves either way; `found` says which.
  async function waitFor(ms, selector, text) {
    const limit = Math.min(ms ?? 10000, 30000);
    const present = () =>
      (!selector || document.querySelector(selector) !== null) &&
      (!text || (document.body?.innerText ?? "").includes(text));
    if (!selector && !text) {
      await new Promise((r) => setTimeout(r, limit));
      return { ok: true };
    }
    const start = Date.now();
    while (!present()) {
      if (Date.now() - start >= limit) return { ok: true, found: false, waitedMs: Date.now() - start };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: true, found: true, waitedMs: Date.now() - start };
  }

  function clickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { error: "no element at point" };
    fireMouse(el, "pointerdown", x, y);
    fireMouse(el, "mousedown", x, y);
    fireMouse(el, "pointerup", x, y);
    fireMouse(el, "mouseup", x, y);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
    return { ok: true, tag: el.tagName };
  }

  function setFiles(ref, names) {
    const el = resolve(ref);
    if (!el || el.type !== "file") return { error: "ref is not a file input" };
    return { ok: true, staged: names, accept: el.accept || "*" };
  };

  function safeClone(v) {
    try {
      if (v === undefined) return null;
      JSON.stringify(v);
      return v;
    } catch {
      return String(v);
    }
  }

  const api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__safariHarness !== 1) return;
    const fn = handlers[msg.op];
    if (!fn) return Promise.resolve({ id: msg.id, error: `unknown op ${msg.op}` });
    let out;
    try {
      out = fn(...(msg.args || []));
    } catch (e) {
      return Promise.resolve({ id: msg.id, error: String(e && e.message || e) });
    }
    if (out && typeof out.then === "function") {
      return out.then(
        (value) => ({ id: msg.id, value }),
        (err) => ({ id: msg.id, error: String(err && err.message || err) })
      );
    }
    return Promise.resolve({ id: msg.id, value: out });
  });
})();
