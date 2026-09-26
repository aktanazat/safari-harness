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
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    if (el.getClientRects().length === 0 && (style.display === "none" || style.position === "fixed")) return false;
    return true;
  }

  // Roles whose accessible name comes from their text (ARIA "name from content").
  const NAME_FROM_CONTENT = new Set(["button", "link", "heading", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "checkbox", "radio", "switch", "treeitem", "cell", "gridcell",
    "columnheader", "rowheader", "tooltip"]);

  function textOf(el, max = 120) {
    let t;
    if (el.querySelector("select")) {
      // a label wrapping its dropdown: leave out the option list
      const copy = el.cloneNode(true);
      for (const s of copy.querySelectorAll("select")) s.remove();
      t = copy.textContent;
    } else {
      t = el.innerText || el.textContent || "";
    }
    t = t.replace(/\s+/g, " ").trim();
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
        el.tagName === "LABEL" || el.tagName === "SUMMARY" || NAME_FROM_CONTENT.has(el.getAttribute("role"))) {
      const t = textOf(el, 80);
      if (t) return t;
      // image-only links and icon buttons: name them by their picture's label
      const inner = el.querySelector("img[alt]:not([alt='']), [aria-label]");
      if (inner) return (inner.getAttribute("aria-label") || inner.getAttribute("alt")).trim().slice(0, 80);
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
      if (document.activeElement === el) s.push("focused");
      const v = el.value;
      if (v) s.push(`value="${v.length > 40 ? v.slice(0, 40) + "…" : v}"`);
    }
    if (el.tagName === "SELECT" && el.options.length) {
      const sel = el.selectedOptions[0];
      if (sel) s.push(`value="${textOf(sel, 40)}"`);
      s.push(`${el.options.length} options`);
    }
    if (el.href) {
      const u = shortUrl(el.href);
      if (u) s.push("url=" + u);
    }
    return s;
  }

  // Link targets cost most of a snapshot's bytes, mostly tracking queries.
  // Same-site links show their path, long queries collapse to "?…", and
  // links to this same page are omitted. The ref still clicks the full URL.
  function shortUrl(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return null; }
    if (u.protocol === "javascript:") return null;
    if (u.origin === location.origin && u.pathname === location.pathname && u.search === location.search) return null;
    const base = u.origin === location.origin ? u.pathname : u.origin + u.pathname;
    return base + (u.search.length > 41 ? "?…" : u.search);
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

  // opts.query: keep only lines containing this text (case-insensitive), as a
  // flat list, so an agent can find one element without reading the page.
  function snapshot(opts = {}) {
    pruneRefs();
    const root = opts.root ? document.querySelector(opts.root) : document.body;
    if (!root) return { error: "root not found" };
    const lines = [];
    const maxNodes = opts.maxNodes || 600;
    const query = opts.query ? String(opts.query).toLowerCase() : null;
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
      const keep = interesting(el);
      if (keep) {
        const role = getExplicitRole(el);
        const name = accessibleName(el);
        const parts = [role || el.tagName.toLowerCase()];
        if (name) parts.push(` "${name}"`);
        const st = stateOf(el);
        if (st.length) parts.push(` {${st.join(", ")}}`);
        if ((el.tagName === "P" || el.tagName === "LI") && !name) {
          const t = textOf(el, 160);
          if (t) parts.push(` "${t}"`);
        }
        const body = parts.join("");
        if (!query || body.toLowerCase().includes(query)) {
          count += 1;
          lines.push(`${query ? "" : "  ".repeat(depth)}[${ensureRef(el)}] ${body}`);
        }
      }
      // a <select> lists its option count; pick one with the select tool
      if (el.tagName === "SELECT") return;
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

  // A target is a ref from the latest snapshot ("12"), a CSS selector
  // ("#email"), or an element's visible text or label ("Sign in"), so an
  // action can run without a snapshot first. A bare word is tried as text
  // before CSS: "Menu" should reach the button, not the <menu> element.
  const CSS_HINT = /[#.[\]:>*=~^$|+()]/;
  function resolve(target) {
    const key = String(target).trim();
    if (/^\d+$/.test(key)) {
      const el = refMap.get(key);
      if (el && el.isConnected) return el;
      const dom = document.querySelector(`[${REF_ATTR}="${key}"]`);
      if (dom) refMap.set(key, dom);
      return dom;
    }
    return CSS_HINT.test(key) ? bySelector(key) ?? byText(key) : byText(key) ?? bySelector(key);
  }

  // isVisible alone passes the children of a display:none parent, because
  // the snapshot never walks into one; a target found by search must also
  // have a box on the page.
  function shown(el) {
    return el.getClientRects().length > 0 && isVisible(el);
  }

  function bySelector(selector) {
    let all;
    try { all = [...document.querySelectorAll(selector)]; } catch { return null; }
    return all.find(shown) ?? all[0] ?? null;
  }

  // Controls whose name is the text win, then any element whose own text it
  // is (the innermost), then controls whose name contains it. A label stands
  // for its field.
  function byText(text) {
    const want = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (!want) return null;
    const all = document.body.querySelectorAll("*");
    let partial = null;
    let found = null;
    for (const el of all) {
      if (!isInteractive(el)) continue;
      const name = accessibleName(el).replace(/\s+/g, " ").toLowerCase();
      if (name === want && shown(el)) { found = el; break; }
      if (!partial && name.includes(want) && shown(el)) partial = el;
    }
    for (const el of found ? [] : all) {
      if (found && !found.contains(el)) break;
      if (textOf(el, want.length + 1).toLowerCase() === want && shown(el)) found = el;
    }
    found ??= partial;
    return found && found.tagName === "LABEL" && found.control ? found.control : found;
  }

  function missing(target) {
    return { error: /^\d+$/.test(String(target).trim()) ? `stale ref ${target}; re-run snapshot` : `nothing on the page matches ${target}` };
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

  function fireClick(el, x, y) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) fireMouse(el, type, x, y);
  }

  function click(ref) {
    const el = resolve(ref);
    if (!el) return missing(ref);
    // Reading the position below forces layout, so no frame wait is needed;
    // background tabs never run requestAnimationFrame, so waiting on one hangs.
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const { x, y } = centerOf(el);
    // The topmost element at that point gets the click only when it is part
    // of the target (an overlay inside a link); anything else is a cover
    // that would swallow the click, so click the target itself.
    const hit = document.elementFromPoint(x, y);
    const target = hit && el.contains(hit) ? hit : el;
    fireClick(target, x, y);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) el.focus();
    return { ok: true };
  }

  function hover(ref) {
    const el = resolve(ref);
    if (!el) return missing(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const { x, y } = centerOf(el);
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) fireMouse(el, type, x, y);
    return { ok: true };
  }

  function selectOption(ref, choice) {
    const el = resolve(ref);
    if (!el) return missing(ref);
    if (el.tagName !== "SELECT") return { error: "not a <select>; click it, then click the option in a fresh snapshot" };
    const options = [...el.options];
    const want = String(choice).trim().toLowerCase();
    const opt = options.find((o) => o.label.trim().toLowerCase() === want || o.value.toLowerCase() === want) ??
      options.find((o) => o.label.toLowerCase().includes(want));
    if (!opt) return { error: `no option "${choice}"; options: ${options.slice(0, 40).map((o) => o.label.trim()).join(" | ")}` };
    // the native setter, so framework value trackers see a real change
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: opt.label.trim() };
  }

  // files: [{ name, type, data (base64) }]. File inputs are usually hidden
  // behind a styled button, so the ref may be that button's container; with
  // no ref, the page's only file input is used.
  function upload(ref, files) {
    let input;
    if (ref !== null && ref !== undefined) {
      const el = resolve(ref);
      if (!el) return missing(ref);
      input = el.matches("input[type=file]") ? el : el.querySelector("input[type=file]");
      if (!input) return { error: "no file input at that ref; retry without a ref to use the page's only file input" };
    } else {
      const all = document.querySelectorAll("input[type=file]");
      if (all.length !== 1) return { error: `page has ${all.length} file inputs; pass the ref of the upload area` };
      input = all[0];
    }
    if (files.length > 1 && !input.multiple) return { error: "this input takes one file" };
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, files: [...input.files].map((f) => f.name) };
  }

  function historyGo(to) {
    if (to === "back") history.back();
    else if (to === "forward") history.forward();
    else if (to === "reload") location.reload();
    else return { error: `go must be back, forward, or reload` };
    return { ok: true };
  }

  // The native setter, so framework value trackers (React) see a real edit.
  function setValue(el, value, data) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function typeText(ref, text, opts = {}) {
    const el = resolve(ref);
    if (!el) return missing(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (el.isContentEditable) {
      if (!opts.append) {
        el.textContent = "";
      }
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else if ("value" in el) {
      setValue(el, (opts.append ? String(el.value || "") : "") + text, text);
    } else {
      return { error: "element is not editable" };
    }
    if (el.type === "password") return { ok: true };
    return { ok: true, value: (el.value ?? el.textContent ?? "").slice(0, 200) };
  }

  // ---------- Apple Passwords fill ----------

  // The sign-in fields on this page: the current-password field (never a
  // new-password one, so a sign-up form is left alone) and the username
  // field before it. A username-first page (Google, Apple) has only the
  // latter, which must then say it is a username or email field.
  function loginFields() {
    const usable = (el) => !el.disabled && !el.readOnly && shown(el);
    const password = [...document.querySelectorAll("input[type=password]")]
      .find((el) => usable(el) && el.getAttribute("autocomplete") !== "new-password") ?? null;
    const scope = password?.form ?? document;
    const texts = [...scope.querySelectorAll("input:not([type]), input[type=text], input[type=email], input[type=tel]")].filter(usable);
    const tagged = texts.find((el) => /\b(username|email)\b/.test(el.getAttribute("autocomplete") ?? ""));
    const username = tagged ?? (password
      ? texts.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
      : texts.find((el) => el.type === "email" || /user|login|email|account|identifier/i.test(`${el.name} ${el.id}`)));
    return { username: username ?? null, password };
  }

  // The daemon passes the hostname the login is saved for; a page that has
  // moved elsewhere gets nothing. The reply never carries what was typed.
  function loginForm(host) {
    if (location.hostname !== host) return { error: `the page moved to ${location.hostname}; try again` };
    const f = loginFields();
    return { username: f.username !== null, password: f.password !== null };
  }

  function fillLogin(host, username, password) {
    if (location.hostname !== host) return { error: `the page moved to ${location.hostname}; nothing was filled` };
    const f = loginFields();
    const filled = [];
    for (const [field, value, name] of [[f.username, username, "username"], [f.password, password, "password"]]) {
      if (!field || !value) continue;
      field.focus();
      setValue(field, value, value);
      filled.push(name);
    }
    if (!filled.length) return { error: "the login form is gone; nothing was filled" };
    return { ok: true, filled };
  }

  // "Shift+Option+C" -> key "C" with shiftKey and altKey. A key that is not
  // a known combo ("+", "Enter") is sent as is.
  const MODIFIERS = { shift: "shiftKey", option: "altKey", alt: "altKey", cmd: "metaKey", command: "metaKey", meta: "metaKey", ctrl: "ctrlKey", control: "ctrlKey" };
  function parseKey(spec) {
    const parts = spec.split("+");
    const flags = {};
    if (parts.length < 2 || parts[parts.length - 1] === "") return { key: spec, flags };
    for (const p of parts.slice(0, -1)) {
      const flag = MODIFIERS[p.trim().toLowerCase()];
      if (!flag) return { key: spec, flags: {} };
      flags[flag] = true;
    }
    let key = parts[parts.length - 1];
    if (key.length === 1) key = flags.shiftKey ? key.toUpperCase() : key.toLowerCase();
    return { key, flags };
  }

  function keyCode(key) {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^\d$/.test(key)) return `Digit${key}`;
    return { "/": "Slash", "?": "Slash", ".": "Period", ",": "Comma", " ": "Space" }[key] ?? key;
  }

  function pressKey(ref, spec) {
    const el = (ref === null || ref === undefined ? null : resolve(ref)) || document.activeElement || document.body;
    const { key, flags } = parseKey(spec);
    const common = { bubbles: true, cancelable: true, key, code: keyCode(key), ...flags };
    el.dispatchEvent(new KeyboardEvent("keydown", common));
    el.dispatchEvent(new KeyboardEvent("keyup", common));
    if (key === "Enter" && !Object.keys(flags).length && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      const form = el.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    }
    return { ok: true, key, ...flags };
  }

  function scrollBy(dx, dy) {
    window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    return { ok: true, scrollY: Math.round(window.scrollY), maxY: Math.round(document.documentElement.scrollHeight - innerHeight) };
  }

  // innerText, minus text drawn in boxes of at most one pixel. Pages hide
  // decoys that way (ebay interleaves random letters into item labels and
  // parks them off-screen); innerText keeps them because they do render.
  function visibleText(root) {
    const text = root.innerText || "";
    const decoys = [];
    for (const el of root.querySelectorAll("*")) {
      if (decoys.length && decoys[decoys.length - 1].contains(el)) continue;
      const rects = el.getClientRects();
      if (!rects.length) continue; // not rendered, so not in innerText either
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1 && el.textContent.trim()) decoys.push(el);
    }
    // Cut each decoy at its next occurrence, in document order.
    let out = "";
    let at = 0;
    for (const el of decoys) {
      const t = el.innerText;
      const i = t ? text.indexOf(t, at) : -1;
      if (i < 0) continue;
      out += text.slice(at, i);
      at = i + t.length;
    }
    return out + text.slice(at);
  }

  // Default root: the page's main region, or its only article; otherwise the
  // whole body (the first of many articles is a card, not the content).
  // query keeps the lines containing it, searched across the whole body.
  function extract(opts = {}) {
    let root;
    if (opts.selector) root = document.querySelector(opts.selector);
    else if (opts.query) root = document.body;
    else {
      const articles = document.querySelectorAll("article");
      root = document.querySelector("main, [role=main]") || (articles.length === 1 ? articles[0] : document.body);
    }
    if (!root) return { error: "no content root" };
    let text = visibleText(root).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (opts.query) {
      const q = String(opts.query).toLowerCase();
      text = text.split("\n").filter((line) => line.toLowerCase().includes(q)).join("\n");
    }
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
    present: (selector, text) => ({
      found: (!selector || document.querySelector(selector) !== null) &&
        (!text || (document.body?.innerText ?? "").includes(text)),
    }),
    // Resolves once the tab has drawn two frames, i.e. it is visible and painted.
    painted: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ ok: true })))),
    clickAt,
    hover,
    select: selectOption,
    upload,
    history: historyGo,
    loginForm,
    fillLogin,
  };

  function clickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { error: "no element at point" };
    fireClick(el, x, y);
    return { ok: true, tag: el.tagName };
  }

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
    // Handlers report expected failures (stale ref, no such option) as
    // { error }; send those as errors so callers never mistake them for success.
    const settle = (value) => value && typeof value === "object" && typeof value.error === "string"
      ? { id: msg.id, error: value.error }
      : { id: msg.id, value };
    let out;
    try {
      out = fn(...(msg.args || []));
    } catch (e) {
      return Promise.resolve({ id: msg.id, error: String(e && e.message || e) });
    }
    if (out && typeof out.then === "function") {
      return out.then(settle, (err) => ({ id: msg.id, error: String(err && err.message || err) }));
    }
    return Promise.resolve(settle(out));
  });

  // Tell the extension this document can take requests; this lands well
  // before the tab's "complete", which also waits on ads and trackers.
  api.runtime.sendMessage({ __safariHarnessReady: 1 }).catch(() => {});
})();
