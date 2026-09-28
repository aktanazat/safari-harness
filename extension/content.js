// Safari Harness content script.
// Runs in every page. Implements the DOM-side verbs the daemon calls:
// aria snapshots with stable element refs, click/type/scroll by ref,
// JS evaluation, and extraction.
//
// This is a clean-room implementation of the same contract Aside's
// injected.ts snapshot module provides for Chrome, adapted to Safari's
// Web Extension API (no chrome.debugger available).

(() => {
  // One copy of this script answers in each page. The extension sets the
  // claim to null to put a fresh copy in where the one there answers
  // nothing (a copy left behind when the extension reloaded): the old copy
  // then ignores every message, and the new one numbers its refs after the
  // ones already on the page.
  if (window.__safariHarnessInjected) return;
  const takeover = window.__safariHarnessInjected === null;
  const claim = {};
  window.__safariHarnessInjected = claim;

  const REF_ATTR = "data-sh-ref";
  let refSeq = 0;
  const refMap = new Map(); // ref -> element
  if (takeover) for (const el of deepQueryAll(`[${REF_ATTR}]`)) refSeq = Math.max(refSeq, Number(el.getAttribute(REF_ATTR)) || 0);

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

  // A control the page made of a plain element, with no role or tab stop
  // and its click handler added from script (CloudKit's "Add field" span),
  // shows only as a hand cursor. It counts when the page also names it,
  // for assistive tech or its tests: plain text under a hand cursor stays
  // text. Inside a control that shows the hand (inHand), the hand is that
  // control's.
  function isInteractive(el, style, inHand = false) {
    if (el.tabIndex >= 0 && !el.hasAttribute("disabled")) return true;
    const role = getExplicitRole(el);
    if (role && ["button", "link", "textbox", "checkbox", "radio", "combobox", "listbox", "menuitem", "tab", "slider", "switch"].includes(role)) return true;
    if (el.onclick || el.onmousedown || el.onpointerdown) return true;
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (inHand || !(el.hasAttribute("aria-label") || el.hasAttribute("title") || el.hasAttribute("data-testid"))) return false;
    return (style ?? (el.ownerDocument.defaultView || window).getComputedStyle(el)).cursor === "pointer";
  }

  // Opacity 0 hides an element, but not one fading in: Safari runs no
  // animation in a hidden tab, so a form that fades in (Apple's sign-in
  // frame) would stay transparent until the tab came to the front.
  function transparent(el, style) {
    return parseFloat(style.opacity) === 0 && !el.getAnimations().some((a) => a.playState === "running");
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || transparent(el, style)) return false;
    if (el.getClientRects().length === 0 && (style.display === "none" || style.position === "fixed")) return false;
    return true;
  }

  // ---------- words no one sees ----------
  // Pages hide text from people but not from agents: instructions addressed
  // to an AI, parked where no one looks. The page as an agent reads it
  // (snapshot, extract) leaves such words out; showHidden keeps them.

  // A box whose content no scroll shows: a frame or an overflow-hidden box
  // of at most a pixel (the screen-reader-only pattern), a positioned box
  // clipped to nothing, or one moved wholly left of or above the page. A
  // collapsed panel, flat one way only, stays: its text is a click away.
  // Most boxes sit in the flow unclipped and skip the layout read.
  function unseenBox(el, style) {
    const frame = el.tagName === "IFRAME" || el.tagName === "FRAME";
    const shut = style.overflowX !== "visible" && style.overflowY !== "visible" && style.display !== "inline" && style.display !== "contents";
    const placed = style.position !== "static";
    if (!frame && !shut && !placed) return false;
    const r = el.getBoundingClientRect();
    if (frame ? r.width <= 1 || r.height <= 1 : shut && r.width <= 1 && r.height <= 1) return true;
    if ((style.position === "absolute" || style.position === "fixed") && clipShut(style.clip)) return true;
    if (!placed || !r.width || !r.height) return false;
    // a fixed box stays where the window puts it; the others scroll
    const view = el.ownerDocument.defaultView || window;
    const fixed = style.position === "fixed";
    return r.right + (fixed ? 0 : view.scrollX) <= 0 || r.bottom + (fixed ? 0 : view.scrollY) <= 0;
  }

  // clip: rect(top, right, bottom, left) leaving no room. An auto edge is
  // the box's own, which leaves room.
  function clipShut(clip) {
    const edges = /^rect\((.*)\)$/.exec(clip)?.[1].split(/[\s,]+/).map(parseFloat);
    return edges?.length === 4 && (edges[1] - edges[3] <= 1 || edges[2] - edges[0] <= 1);
  }

  // An element's own words drawn without ink: a font of at most a pixel,
  // or a clear fill (alpha 0) with no outline or shadow, unless a
  // background shows through the letters (a gradient heading's
  // background-clip: text). Its children can set their own.
  function faintText(el, style) {
    if (parseFloat(style.fontSize) <= 1) return true;
    if (!/^transparent$|^rgba\(.*,\s*0\)$|\/\s*0\)$/.test(style.getPropertyValue("-webkit-text-fill-color"))) return false;
    if (style.textShadow !== "none" || parseFloat(style.getPropertyValue("-webkit-text-stroke-width")) > 0) return false;
    for (let e = el; e; e = e.parentElement) {
      const s = e === el ? style : (e.ownerDocument.defaultView || window).getComputedStyle(e);
      if ((s.getPropertyValue("background-clip") + s.getPropertyValue("-webkit-background-clip")).includes("text")) return false;
    }
    return true;
  }

  // A text node's words no one sees: its element hides them or draws them
  // without ink. Whitespace only parts words, so it always counts.
  function unseenWords(text) {
    const el = text.parentElement;
    if (!el || !/\S/.test(text.nodeValue)) return false;
    const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    return style.visibility !== "visible" || faintText(el, style);
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

  // The name an element states itself: aria-labelledby, aria-label, an
  // image's alt, or a field's label. null when its name comes from its
  // content or title.
  function ownName(el) {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby.split(/\s+/)
        .map((id) => el.getRootNode().getElementById(id))
        .filter(Boolean)
        .map((n) => textOf(n, 80));
      if (parts.some(Boolean)) return parts.filter(Boolean).join(" ");
    }
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    if (el.tagName === "IMG") return (el.getAttribute("alt") || "").trim();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.labels && el.labels.length) return textOf(el.labels[0], 80);
      return (el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "").trim();
    }
    return null;
  }

  // Names from content: a heading is page text, and pages put instructions
  // in them, so it gets a paragraph's length, not a control label's.
  const NAME_MAX = 80;
  const TEXT_MAX = 160;
  const TEXT_NAMED_TAGS = /^(A|BUTTON|H[1-6]|LABEL|SUMMARY)$/;

  function namedByContent(el) {
    return TEXT_NAMED_TAGS.test(el.tagName) || NAME_FROM_CONTENT.has(el.getAttribute("role"));
  }

  function accessibleName(el) {
    const own = ownName(el);
    if (own !== null) return own;
    if (namedByContent(el)) {
      const t = textOf(el, /^H[1-6]$/.test(el.tagName) ? TEXT_MAX : NAME_MAX);
      if (t) return t;
      // image-only links and icon buttons: name them by their picture's label
      const inner = el.querySelector("img[alt]:not([alt='']), [aria-label]");
      if (inner) return (inner.getAttribute("aria-label") || inner.getAttribute("alt")).trim().slice(0, NAME_MAX);
    }
    return (el.getAttribute("title") || "").trim();
  }

  // A field whose value is a secret: its value is never printed, only
  // whether it is filled. Autofill puts these in without the agent typing,
  // and a show-password toggle turns a password field into a text field. A
  // field the harness typed a code into (type's secret) is one too.
  const secretFilled = new WeakSet();
  function secretField(el) {
    return secretFilled.has(el) || el.type === "password" || /\b(current-password|new-password|cc-(number|csc|exp)|one-time-code)/.test(el.getAttribute("autocomplete") ?? "");
  }

  function stateOf(el) {
    const s = [];
    if (el.hasAttribute("disabled")) s.push("disabled");
    if (el.getAttribute("aria-expanded") === "true") s.push("expanded");
    if (el.getAttribute("aria-checked") === "true" || el.checked === true) s.push("checked");
    if (el.getAttribute("aria-selected") === "true" || el.selected === true) s.push("selected");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.getRootNode().activeElement === el) s.push("focused");
      const v = el.value;
      if (v) s.push(secretField(el) ? "filled" : `value="${v.length > 40 ? v.slice(0, 40) + "…" : v}"`);
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
    // a file made in the page: its address is a long opaque string
    if (u.protocol === "data:" || u.protocol === "blob:") return `${u.protocol}…`;
    if (u.origin === location.origin && u.pathname === location.pathname && u.search === location.search) return null;
    const base = u.origin === location.origin ? u.pathname : u.origin + u.pathname;
    return base + (u.search.length > 41 ? "?…" : u.search);
  }

  // ---------- shadow roots ----------
  // Web components draw into shadow roots, which querySelector, innerText,
  // and a MutationObserver on the document never enter (CVS's insurance
  // forms live there). Open ones are read as part of the page, as drawn: a
  // host shows its shadow root, and a <slot> the host's children assigned to
  // it. A closed root stays unreadable.
  function drawnChildren(el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (el.tagName === "SLOT" && el.assignedNodes().length) return el.assignedNodes();
    return el.childNodes;
  }

  // Every element under root, each shadow root's right after its host.
  function* deepElements(root) {
    if (root.shadowRoot) yield* deepElements(root.shadowRoot);
    for (const el of root.querySelectorAll("*")) {
      yield el;
      if (el.shadowRoot) yield* deepElements(el.shadowRoot);
    }
  }

  function shadowRoots(root = document) {
    const out = root.shadowRoot ? [root.shadowRoot] : [];
    for (const el of deepElements(root)) if (el.shadowRoot) out.push(el.shadowRoot);
    return out;
  }

  function deepQueryAll(selector, root = document) {
    return [root, ...shadowRoots(root)].flatMap((r) => [...r.querySelectorAll(selector)]);
  }

  function deepQuery(selector) {
    return document.querySelector(selector) ?? deepQueryAll(selector)[0] ?? null;
  }

  // The innermost element at a point: elementFromPoint stops at a host.
  function deepPoint(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
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
    remember(ref, el);
    return ref;
  }

  function pruneRefs() {
    // drop refs whose elements left the DOM
    for (const [ref, el] of refMap) {
      if (!el.isConnected) refMap.delete(ref);
    }
  }

  // ---------- fingerprints ----------
  // A framework that draws the page anew replaces the elements a snapshot
  // gave refs, and the agent's next action would miss. Each ref keeps a
  // fingerprint of its element (daemon/fingerprint.ts says what one
  // holds), and a ref whose element is gone heals to the one element on
  // the page that matches it; the reply says so (healed: { ref, now }).
  const fingerprints = new Map(); // ref -> fingerprint, kept after its element leaves
  const FINGERPRINTS_MAX = 5000;
  let healedNow = null; // the heal the running request made
  // How much of an element's surroundings a fingerprint keeps: enough to
  // tell one row's "Delete" from the next.
  const NEAR_MAX = 80;
  const NO_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  // An id the page's author wrote, not one its framework numbers anew on
  // each load.
  const STABLE_ID = /^[A-Za-z][A-Za-z_-]*$/;

  function parentOf(el) {
    return el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
  }

  // The opening text in box outside el, read from its text nodes: reading
  // a whole large box, or laying it out for innerText, would cost every
  // ref a snapshot gives.
  function textAround(box, el) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n === el || NO_TEXT.has(n.nodeName) ? NodeFilter.FILTER_REJECT
        : n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    let t = "";
    for (let n = walker.nextNode(); n && t.length < NEAR_MAX; n = walker.nextNode()) {
      const d = n.data.trim();
      if (d) t += ` ${d}`;
    }
    return norm(t).slice(0, NEAR_MAX);
  }

  // The text of the nearest box around the element with text of its own
  // beside it: a row's, a list item's, a field's label.
  function nearText(el) {
    let up = 0;
    for (let box = parentOf(el); box && up < 6; box = parentOf(box), up++) {
      const t = textAround(box, el);
      if (t) return t;
    }
    return "";
  }

  // Up to depth steps from the element toward the top of its document or
  // shadow root: a stable id ends the path, else each step is the tag and
  // its place among its siblings of that tag.
  function cssPath(el, depth) {
    const steps = [];
    for (let e = el; e && steps.length < depth; e = e.parentElement) {
      if (STABLE_ID.test(e.id)) {
        steps.unshift(`#${CSS.escape(e.id)}`);
        break;
      }
      let k = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === e.localName) k++;
      steps.unshift(`${CSS.escape(e.localName)}:nth-of-type(${k})`);
    }
    return steps.join(">");
  }

  // An element as the matcher sees it; near and path are read only for
  // lookalikes (matchFingerprint).
  function candidateOf(el) {
    const tag = el.localName;
    return {
      role: getExplicitRole(el) || tag,
      name: accessibleName(el),
      tag,
      get near() { return nearText(el); },
      get path() { return cssPath(el, 4); },
    };
  }

  // The page's elements by tag, and each one's place among its lookalikes,
  // for the request running: a snapshot fingerprints hundreds of elements,
  // and the page holds still until it returns.
  let census = null;
  function censusNow() {
    if (!census) {
      census = { roots: [document, ...shadowRoots()], tags: new Map() };
      queueMicrotask(() => { census = null; });
    }
    return census;
  }

  // Every element of a tag, shadow roots included, in page order.
  function tagged(tag) {
    return censusNow().roots.flatMap((r) => [...r.querySelectorAll(CSS.escape(tag))]);
  }

  // Each element of the tag, with its place among those that look the same
  // (lookalikeKey) and how many of those there are.
  function placesOf(tag) {
    const c = censusNow();
    let places = c.tags.get(tag);
    if (!places) {
      const counts = new Map();
      places = new Map();
      for (const el of tagged(tag)) {
        const key = lookalikeKey(candidateOf(el));
        const index = counts.get(key) ?? 0;
        counts.set(key, index + 1);
        places.set(el, { key, index, counts });
      }
      c.tags.set(tag, places);
    }
    return places;
  }

  function fingerprintOf(el) {
    const { role, name, tag, near, path } = candidateOf(el);
    const at = placesOf(tag).get(el);
    return { role, name, tag, near, path, index: at ? at.index : 0, count: at ? at.counts.get(at.key) : 1 };
  }

  function remember(ref, el) {
    fingerprints.delete(ref);
    fingerprints.set(ref, fingerprintOf(el));
    if (fingerprints.size > FINGERPRINTS_MAX) fingerprints.delete(fingerprints.keys().next().value);
  }

  // ---- shared with daemon/fingerprint.ts: begin ----
  function lookalikeKey(c) {
    return `${c.role}\n${c.name}\n${c.tag}`;
  }

  function matchFingerprint(fp, candidates) {
    const want = lookalikeKey(fp);
    const same = [];
    for (let i = 0; i < candidates.length; i++) if (lookalikeKey(candidates[i]) === want) same.push(i);
    if (same.length === 1 && fp.count === 1) return { index: same[0] };
    // One of several lookalikes, then or now: the one whose surroundings read
    // the same; among several of those, the one on the same path, or the one
    // at the same place among as many lookalikes as before.
    const kin = same.filter((i) => candidates[i].near === fp.near);
    if (kin.length === 1) return { index: kin[0] };
    const onPath = kin.filter((i) => candidates[i].path === fp.path);
    if (onPath.length === 1) return { index: onPath[0] };
    const placed = same[fp.index];
    if (same.length === fp.count && kin.includes(placed)) return { index: placed };
    return { count: same.length };
  }
  // ---- shared with daemon/fingerprint.ts: end ----

  // The element a gone ref's fingerprint names, now with a ref of its own;
  // null when no one element matches (none, or lookalikes it cannot tell
  // apart), and the action fails as a stale ref.
  function heal(ref) {
    const fp = fingerprints.get(ref);
    if (!fp) return null;
    const els = tagged(fp.tag);
    const m = matchFingerprint(fp, els.map(candidateOf));
    if (!("index" in m)) return null;
    const el = els[m.index];
    healedNow = { ref, now: ensureRef(el) };
    refMap.set(ref, el);
    return el;
  }

  // A reply carries the heal its request made beside what the op answered.
  function withHeal(value, healed) {
    return healed && value && typeof value === "object" && !Array.isArray(value) ? { ...value, healed } : value;
  }

  // ---------- embedded frames ----------
  // Every frame runs this script. Each frame's copy has a token and tells
  // its parent frame; the parent maps the <iframe> element to that token and
  // prints it in the snapshot (FRAME_MARK), and the extension, which knows
  // each frame's token and id, puts the frame's own snapshot there. The
  // parent also says hello to frames loaded before it, so either may start
  // first.
  const FRAME_MARK = "@@frame:";
  const frameToken = Math.random().toString(36).slice(2, 10);
  window.__safariHarnessFrame = frameToken;
  const childToken = new WeakMap(); // <iframe> -> its document's token
  const greeted = new WeakSet(); // <iframe>s a snapshot found without a token and said hello to
  const offsetWaiters = new Map(); // request id -> resolve

  function frameElementOf(source) {
    for (const f of deepQueryAll("iframe, frame")) if (f.contentWindow === source) return f;
    return null;
  }

  // Where this frame's viewport sits in the top page's viewport, and the
  // top viewport's size; each ancestor adds its <iframe>'s content box.
  function frameOffset() {
    if (window === window.top) return Promise.resolve({ x: 0, y: 0, innerWidth, innerHeight });
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      offsetWaiters.set(id, resolve);
      parent.postMessage({ __shOffset: id }, "*");
      setTimeout(() => { if (offsetWaiters.delete(id)) resolve(null); }, 3000);
    });
  }

  addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || window.__safariHarnessInjected !== claim) return;
    if (typeof d.__shFrame === "string") {
      const f = frameElementOf(e.source);
      if (f) childToken.set(f, d.__shFrame);
    } else if (d.__shHello === 1 && e.source === parent) {
      parent.postMessage({ __shFrame: frameToken }, "*");
    } else if (typeof d.__shOffset === "string") {
      const f = frameElementOf(e.source);
      if (!f) return;
      f.scrollIntoView({ block: "nearest", behavior: "instant" });
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      frameOffset().then((o) => {
        if (!o) return;
        e.source.postMessage({
          __shOffsetReply: d.__shOffset,
          x: o.x + r.left + f.clientLeft + parseFloat(cs.paddingLeft),
          y: o.y + r.top + f.clientTop + parseFloat(cs.paddingTop),
          innerWidth: o.innerWidth,
          innerHeight: o.innerHeight,
        }, "*");
      });
    } else if (typeof d.__shOffsetReply === "string" && e.source === parent) {
      const resolve = offsetWaiters.get(d.__shOffsetReply);
      if (!resolve) return;
      offsetWaiters.delete(d.__shOffsetReply);
      resolve({ x: d.x, y: d.y, innerWidth: d.innerWidth, innerHeight: d.innerHeight });
    }
  });
  if (window !== window.top) parent.postMessage({ __shFrame: frameToken }, "*");
  for (const f of deepQueryAll("iframe, frame")) f.contentWindow?.postMessage({ __shHello: 1 }, "*");

  // The element's box in the top page's viewport, in CSS pixels, scrolled
  // into view: where a real mouse click must land.
  async function locate(ref) {
    const el = resolve(ref);
    if (!el) return missing(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const o = await frameOffset();
    if (!o) return { error: "could not place this frame on the page" };
    let x = r.x + o.x, y = r.y + o.y;
    // an element of a frame read inline: add each <iframe>'s content box
    for (let w = el.ownerDocument.defaultView; w && w !== window; w = w.parent) {
      const f = w.frameElement;
      if (!f) break;
      const fr = f.getBoundingClientRect();
      x += fr.left + f.clientLeft;
      y += fr.top + f.clientTop;
    }
    return { x, y, width: r.width, height: r.height, innerWidth: o.innerWidth, innerHeight: o.innerHeight };
  }

  // Safari runs no extension script in srcdoc and about:blank frames, so
  // such a frame never reports. It shares this page's origin, so this copy
  // reads its document directly, as part of the page.
  function inlineDoc(f) {
    if (childToken.has(f)) return null;
    try { return f.contentDocument?.body ? f.contentDocument : null; } catch { return null; }
  }
  function inlineBodies() {
    const out = [];
    for (const f of deepQueryAll("iframe, frame")) {
      const d = inlineDoc(f);
      if (d) out.push(d.body);
    }
    return out;
  }

  // One walk over the page. What an agent can act on prints with a ref;
  // headings, landmarks, and the page's own text print without one, each
  // run of text once, where it sits. Names come from the text gathered on
  // the way, so no element's text is read twice and nothing forces layout.
  //   article
  //     h3 [54] link "A Light in the Attic" /catalogue/a-light-in-the-attic_1000/index.html
  //     £51.77 · In stock
  //     [55] button "Add to basket"
  // opts.query keeps only lines containing that text (case-insensitive), as
  // a flat list, so an agent can find one element without reading the page;
  // "a|b" keeps lines containing either.
  const ACTION_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio",
    "slider", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "spinbutton"]);
  const BREAK = 0; // a block edge: the text on each side prints on its own line
  const CELL = 1; // a table cell's edge: joined with " | "

  const norm = (t) => t.replace(/\s+/g, " ").trim();
  const clip = (t, max) => { t = norm(t); return t.length > max ? t.slice(0, max) + "…" : t; };

  function snapshot(opts = {}) {
    pruneRefs();
    const root = opts.root ? deepQuery(opts.root) : document.body;
    if (!root) return { error: "root not found" };
    const maxLines = opts.maxNodes || 600;
    const query = opts.query ? queryMatch(opts.query) : null;
    // Refs in an embedded frame print with its frame's prefix ("f3:12"), so
    // the extension knows which frame an action goes to.
    const prefix = opts.refPrefix || "";
    // Frames printed without their token: a frame that loaded before this
    // script listened may not have told it which frame it is. The walk says
    // hello to each once, and the extension snapshots again after the
    // answers, so their lines have a place.
    let unlinked = 0;

    // Pass 1: the kept elements as a tree, with loose text and block edges
    // in page order. `named` holds the ancestors naming themselves by their
    // text; each gathers the text inside it.
    const top = { kids: [] };
    const walk = (el, parent, named, inItem, inHand, muted = false) => {
      // Never drawn, hidden or not: showHidden would print a page's script
      // source and style rules as its text.
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) return;
      const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      // showHidden keeps what the page hides (a collapsed menu, a closed
      // dialog), for reading; such an element cannot be clicked until shown.
      if (!opts.showHidden) {
        if (style.display === "none" || transparent(el, style)) return;
        if (style.position === "fixed" && el.getClientRects().length === 0) return;
      }
      // A child of a hidden element can show itself with visibility: visible
      // (Slack's workspace chooser does), so a hidden element loses only its
      // own line and words, and each child is judged by its own style. The
      // words in a box no one sees (unseenBox) print nowhere.
      const hidden = !opts.showHidden && style.visibility !== "visible";
      const boxed = muted || (!opts.showHidden && unseenBox(el, style));
      if ((hidden || boxed) && (el.tagName === "IFRAME" || el.tagName === "FRAME")) return;
      const role = getExplicitRole(el);
      const actionable = ACTION_ROLES.has(role) || isInteractive(el, style, inHand) || el.tagName === "IFRAME" || el.tagName === "FRAME";
      let node = parent;
      if (!hidden && (actionable || (role && NAMED_ROLES.has(role)))) {
        node = { el, role: role || el.tagName.toLowerCase(), actionable, name: ownName(el), kids: [] };
        parent.kids.push(node);
        if (node.name === null && namedByContent(el)) {
          node.text = [];
          named = [...named, node];
        }
      } else if ((el.tagName === "UL" || el.tagName === "OL") && inItem) {
        node = { group: true, kids: [] };
        parent.kids.push(node);
      }
      const pic = hidden ? null : el.tagName === "IMG" ? el.getAttribute("alt") : node.el !== el ? el.getAttribute("aria-label") : null;
      if (pic) for (const n of named) n.pic ??= pic.trim();
      const add = (x) => { node.kids.push(x); for (const n of named) n.text.push(typeof x === "string" ? x : " "); };
      // Words no one sees still name the control they sit in, as
      // screen-reader text does, but print nowhere; a hidden element's own
      // words do neither. Whitespace only parts words, so it always goes.
      let quiet = null;
      const words = (t) => {
        if (!/\S/.test(t)) return add(t);
        if (hidden) return;
        quiet ??= boxed || (!opts.showHidden && faintText(el, style));
        if (!quiet) return add(t);
        for (const n of named) n.text.push(t);
      };
      if (!/^(SELECT|TEXTAREA|IMG|svg|INPUT)$/.test(el.tagName)) {
        const d = style.display;
        const block = !d.startsWith("inline") && d !== "contents";
        const edge = d === "table-cell" ? CELL : BREAK;
        if (block) add(edge);
        for (const child of drawnChildren(el)) {
          if (child.nodeType === Node.TEXT_NODE) words(child.nodeValue);
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "BR") add(BREAK);
            else walk(child, node, named, inItem || el.tagName === "LI", inHand || (actionable && style.cursor === "pointer"), boxed);
          }
        }
        if (block) add(edge);
      }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        const d = inlineDoc(el);
        if (d) walk(d.body, node, [], false, false);
        else if (!childToken.has(el) && !greeted.has(el)) {
          greeted.add(el);
          el.contentWindow?.postMessage({ __shHello: 1 }, "*");
          unlinked++;
        }
      }
      if (node.el !== el) return;
      if (node.text) {
        const full = norm(node.text.join(""));
        const cap = /^H[1-6]$/.test(el.tagName) ? TEXT_MAX : NAME_MAX;
        if (full) {
          node.fromText = true;
          node.long = full.length > cap;
          node.name = node.long ? null : full;
        } else if (node.pic) {
          node.fromPic = true;
          node.name = node.pic.slice(0, NAME_MAX);
        } else node.name = (el.getAttribute("title") || "").trim();
        delete node.text;
        // a title cut short on screen ("A Light in the ...") with the whole
        // title in the title attribute
        const title = el.getAttribute("title");
        if (node.name && title && /(\.\.\.|…)$/.test(node.name) && title.startsWith(node.name.replace(/\s*(\.\.\.|…)$/, ""))) node.name = title.trim();
      } else if (node.name === null) node.name = (el.getAttribute("title") || "").trim();
    };
    walk(root, top, [], false, false);

    // Pass 2: print. A ref is given only to a line that is printed.
    const lines = [];
    let truncated = false;
    const push = (depth, text, n) => {
      // an embedded frame's line stays, whatever the query: the extension
      // puts the frame's own matching lines in its place
      if (query && !query(text) && !text.includes(FRAME_MARK)) return;
      if (lines.length >= maxLines) { truncated = true; return; }
      const line = n ? `[${prefix}${ensureRef(n.el)}] ${text}` : text;
      lines.push(query ? line : "  ".repeat(depth) + line);
    };
    const hrefOf = (n) => (n.el && n.el.href) || null;
    const tag = (n) => (n.role === "heading" && /^H[1-6]$/.test(n.el.tagName) ? n.el.tagName.toLowerCase() : n.role);
    // A line's text after its ref: role, name, bare URL, then states. A
    // stated name or title can run to a whole commit message: one line of it.
    const head = (n) => {
      const st = stateOf(n.el);
      const i = st.findIndex((s) => s.startsWith("url="));
      const url = i >= 0 ? st.splice(i, 1)[0].slice(4) : "";
      const name = n.name ? clip(n.name, TEXT_MAX) : "";
      const frame = n.el.tagName === "IFRAME" || n.el.tagName === "FRAME" ? childToken.get(n.el) : undefined;
      return `${tag(n)}${name ? ` "${name}"` : ""}${url ? " " + url : ""}${st.length ? ` {${st.join(", ")}}` : ""}${frame ? ` ${FRAME_MARK}${frame}@@` : ""}`;
    };
    // The text items from kids[from] up to the next element.
    const textItems = (kids, from) => {
      const items = [];
      let run = "";
      // Text between inline links arrives in pieces: drop the separators and
      // the unmatched bracket each piece starts or ends with ("(", ") · 291 points by").
      const flush = () => {
        const t = clip(run, TEXT_MAX).replace(/^[\s)\]|·•,;]+|[\s([|·•,;]+$/g, "").replace(/(\| ){2,}/g, "| ");
        if (t) items.push(t);
        run = "";
      };
      let i = from;
      for (; i < kids.length; i++) {
        const c = kids[i];
        if (typeof c === "string") run += c;
        else if (c === CELL) run += " | ";
        else if (c === BREAK) flush();
        else break;
      }
      flush();
      return { items, next: i };
    };
    const elementKids = (n) => n.kids.filter((k) => typeof k === "object");
    const allText = (n) => {
      const r = [];
      for (let i = 0; i < n.kids.length;) {
        if (typeof n.kids[i] === "object") { i++; continue; }
        const { items, next } = textItems(n.kids, i);
        r.push(...items);
        i = next;
      }
      return r;
    };
    const short = (t) => t.length <= 24 && !t.includes(" | ");
    const render = (node, depth) => {
      // nothing prints past the last line: stop reading the page there
      if (truncated) return;
      const kids = node.kids;
      // links that only show a picture, when a text link in the same block
      // goes to the same place
      const textHrefs = new Set();
      const scan = (n, d) => {
        for (const k of elementKids(n)) {
          if (k.actionable && k.fromText && hrefOf(k)) textHrefs.add(hrefOf(k));
          if (d < 2 && !k.actionable) scan(k, d + 1);
        }
      };
      scan(node, 0);
      for (let i = 0; i < kids.length && !truncated;) {
        const c = kids[i];
        if (typeof c !== "object") {
          let { items, next } = textItems(kids, i);
          i = next;
          if (node.fromText && !node.long) continue; // already the name
          // text a stated name already carries (aria-label ".cargo, (Directory)" over ".cargo")
          if (node.name && !node.fromText) items = items.filter((t) => !node.name.toLowerCase().includes(t.toLowerCase()));
          // short neighbours share a line ("£51.77 · In stock"); table rows and long text keep their own
          let line = "";
          for (const it of items) {
            if (line && !(short(it) && short(line.split(" · ").pop()) && line.length + it.length < TEXT_MAX)) { push(depth, line); line = ""; }
            line = line ? `${line} · ${it}` : it;
          }
          if (line) push(depth, line);
          continue;
        }
        i++;
        if (c.group) { render(c, depth + 1); continue; }
        if (!c.actionable && !c.name && (c.role === "form" || c.role === "region")) { render(c, depth); continue; }
        if (!c.actionable && c.role === "img" && node.actionable) continue;
        if (c.actionable && c.fromPic && hrefOf(c) && textHrefs.has(hrefOf(c))) continue;
        const ek = elementKids(c);
        const texts = allText(c);
        // a heading that only holds a link: one line
        if (c.role === "heading" && ek.length === 1 && ek[0].actionable && texts.length <= 1) {
          push(depth, `${tag(c)} [${prefix}${ensureRef(ek[0].el)}] ${head(ek[0])}`);
          render(ek[0], depth + 1);
          continue;
        }
        // a nameless box holding one text: "alert: Warning! …"
        if (!c.actionable && !c.name && ek.length === 0) {
          if (texts.length === 0) continue;
          if (texts.length === 1) { push(depth, `${tag(c)}: ${texts[0]}`); continue; }
        }
        push(depth, head(c), c.actionable ? c : null);
        render(c, depth + 1);
      }
    };
    render(top, 0);
    return { url: location.href, title: document.title, nodes: lines.length, truncated, snapshot: lines.join("\n"), ...(unlinked ? { unlinked } : {}) };
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
      const dom = deepQuery(`[${REF_ATTR}="${key}"]`);
      if (dom) refMap.set(key, dom);
      return dom ?? heal(key);
    }
    return CSS_HINT.test(key) ? bySelector(key) ?? byText(key) : byText(key) ?? bySelector(key);
  }

  // A label stands for its field. The snapshot gives a label that wraps its
  // field a ref of its own; typing into that ref or picking an option on it
  // means the field.
  function fieldOf(el) {
    return el && el.tagName === "LABEL" && el.control ? el.control : el;
  }

  // isVisible alone passes the children of a display:none parent, because
  // the snapshot never walks into one; a target found by search must also
  // have a box on the page.
  function shown(el) {
    return el.getClientRects().length > 0 && isVisible(el);
  }

  function bySelector(selector) {
    let all;
    try { all = deepQueryAll(selector); } catch { return null; }
    return all.find(shown) ?? all[0] ?? null;
  }

  // Controls whose name is the text win, then any element whose own text it
  // is (the innermost), then controls whose name contains it. A label stands
  // for its field.
  function byText(text) {
    const want = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (!want) return null;
    const all = [document.body, ...inlineBodies()].flatMap((b) => [...deepElements(b)]);
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
    return fieldOf(found);
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

  // What an action set in motion, read right after it ran, so the extension
  // waits for a load or a tab only when one is coming:
  //   "load"    this tab is loading another document
  //   "tab"     another tab is opening
  //   "script"  a link or form the page's script took over; it may move soon
  // Safari fires no navigate event for a synthetic link click, so links and
  // forms are read from their click and submit events; the page's own
  // location changes do fire navigate, synchronously.
  function withOutcome(act) {
    let nav = null;
    let submit = null;
    let clicked = null;
    const onNav = (e) => { nav ??= e; };
    const onSubmit = (e) => { submit ??= e; };
    const onClick = (e) => { clicked ??= e; };
    navigation.addEventListener("navigate", onNav);
    addEventListener("submit", onSubmit, true);
    addEventListener("click", onClick, true);
    let res;
    try {
      res = act();
    } finally {
      navigation.removeEventListener("navigate", onNav);
      removeEventListener("submit", onSubmit, true);
      removeEventListener("click", onClick, true);
    }
    if (!res || res.error) return res;
    const expect = nav ? (nav.destination.sameDocument ? null : "load")
      : submit ? submitOutcome(submit)
      : clicked ? linkOutcome(clicked)
      : null;
    return expect ? { ...res, expect } : res;
  }

  function opensTab(target) {
    return target !== "" && !["_self", "_top", "_parent"].includes(target.toLowerCase());
  }

  function submitOutcome(e) {
    if (e.defaultPrevented) return "script";
    const target = e.submitter?.getAttribute("formtarget") ?? e.target.getAttribute("target") ?? document.querySelector("base[target]")?.target ?? "";
    return opensTab(target) ? "tab" : "load";
  }

  function linkOutcome(e) {
    const a = e.target instanceof Element ? e.target.closest("a[href], area[href]") : null;
    if (!a || a.hasAttribute("download")) return null;
    if (e.defaultPrevented) return "script";
    const to = new URL(a.href, location.href);
    // mailto:, tel:, and app links hand off to another app; the tab stays.
    if (to.protocol !== "https:" && to.protocol !== "http:") return null;
    if (to.href.split("#")[0] === location.href.split("#")[0] && to.hash) return null;
    const target = a.getAttribute("target") ?? document.querySelector("base[target]")?.target ?? "";
    return opensTab(target) ? "tab" : "load";
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
    const hit = deepPoint(x, y);
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
    const el = fieldOf(resolve(ref));
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
      input = el.matches("input[type=file]") ? el : deepQueryAll("input[type=file]", el)[0];
      if (!input) return { error: "no file input at that ref; retry without a ref to use the page's only file input" };
    } else {
      const all = deepQueryAll("input[type=file]");
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

  // A traversal may stay in this document, so it is only a maybe; a reload
  // always loads.
  function historyGo(to) {
    if (to === "back") history.back();
    else if (to === "forward") history.forward();
    else if (to === "reload") location.reload();
    else return { error: `do must be back, forward, or reload` };
    return { ok: true, expect: to === "reload" ? "load" : "script" };
  }

  // ---------- dialogs ----------
  // dialogs.js runs in the page's own world and, once armed, answers
  // alert, confirm, prompt, and print itself instead of showing them, and
  // keeps beforeunload from holding a navigation. A tab the harness opened
  // is armed for good, and kept running while hidden; any other tab only
  // while an action runs, so a dialog the user meets later still shows.
  // Each dialog is reported to this world and returned with the action
  // that raised it.
  const dialogLog = [];
  let dialogPolicy = null; // { accept, text } once the extension armed this tab
  document.addEventListener("__sh_dialog_seen", (e) => {
    if (typeof e.detail !== "string") return;
    try { dialogLog.push(JSON.parse(e.detail)); } catch {}
    if (dialogLog.length > 50) dialogLog.shift();
  });
  function armDialogs(armed, policy) {
    const detail = JSON.stringify({ armed, owned: !!policy, accept: !!(policy && policy.accept), text: policy && typeof policy.text === "string" ? policy.text : null });
    document.dispatchEvent(new CustomEvent("__sh_dialog_policy", { detail }));
  }
  function setDialogs(policy) {
    if (policy) {
      dialogPolicy = policy;
      armDialogs(true, policy);
      takeTicks();
    }
    return { dialogs: dialogLog.slice(-20), answer: dialogPolicy && dialogPolicy.accept ? "accept" : "dismiss" };
  }

  // An owned tab takes the extension's ticks (see dialogs.js) over a port of
  // its own: a message per tick, 20 a second, leaves Safari answering the
  // harness's requests to the tab with nothing. A page restored from the
  // back-forward cache lost its port and connects again.
  let tickPort = null;
  function takeTicks() {
    if (tickPort) return;
    tickPort = api.runtime.connect({ name: "ticks" });
    tickPort.onMessage.addListener(() => document.dispatchEvent(new CustomEvent("__sh_tick")));
    tickPort.onDisconnect.addListener(() => { tickPort = null; });
  }
  addEventListener("pageshow", (e) => { if (e.persisted && dialogPolicy) takeTicks(); });

  // ---------- page fetch and downloads ----------
  // Requests from here carry the page's cookies, as the page's own would.
  // base64 returns the body's bytes (a PDF, an image) instead of its text.
  async function pageFetch(url, opts = {}) {
    const res = await fetch(new URL(url, location.href), {
      method: opts.method || "GET",
      headers: opts.headers || undefined,
      body: opts.body ?? undefined,
      credentials: "include",
    });
    const limit = opts.maxBytes || 50000;
    const head = { status: res.status, url: res.url, type: res.headers.get("content-type") };
    if (opts.base64) {
      const blob = await res.blob();
      const kept = blob.size > limit ? blob.slice(0, limit) : blob;
      return { ...head, headers: [...res.headers], data: await base64Of(kept), truncated: blob.size > limit };
    }
    const text = await res.text();
    return {
      ...head,
      text: text.length > limit ? text.slice(0, limit) : text,
      truncated: text.length > limit,
    };
  }

  function base64Of(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  const DOWNLOAD_MAX = 100 * 1024 * 1024;
  function nameFrom(disposition, url) {
    const m = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    }
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") return decodeURIComponent(u.pathname.split("/").pop() || "") || u.hostname;
    } catch {}
    return "";
  }

  // The file at url, fetched with the page's cookies: { name, type, size, data (base64) }.
  async function fetchFile(url, name) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { error: `download failed: HTTP ${res.status}` };
    const blob = await res.blob();
    if (blob.size > DOWNLOAD_MAX) return { error: `file is ${blob.size} bytes; the limit is ${DOWNLOAD_MAX}` };
    return { name: name || nameFrom(res.headers.get("content-disposition"), res.url), type: blob.type, size: blob.size, data: await base64Of(blob) };
  }

  // A download the page makes from script (a blob or data link it clicks,
  // or a window it opens) is caught in the page's own world (dialogs.js)
  // and handed here; the page's own save is cancelled so Safari does not
  // save a second copy. The daemon owns the time limit (downloadStop).
  let pendingDownload = null;
  let caughtDownload = null;
  document.addEventListener("__sh_download_seen", (e) => {
    if (typeof e.detail !== "string") return;
    try { caughtDownload = JSON.parse(e.detail); } catch { return; }
    pendingDownload?.(caughtDownload);
  });
  function catchDownloads(on) {
    document.dispatchEvent(new CustomEvent("__sh_download_catch", { detail: on ? "1" : "0" }));
  }

  async function download(ref) {
    const el = resolve(ref);
    if (!el) return missing(ref);
    const link = el.closest("a[href], area[href]");
    if (link && !link.href.startsWith("javascript:")) return fetchFile(link.href, link.getAttribute("download") || "");
    caughtDownload = null;
    catchDownloads(true);
    try {
      const clicked = withOutcome(() => click(ref));
      if (clicked && clicked.error) return clicked;
      const caught = caughtDownload ?? await new Promise((resolve) => { pendingDownload = resolve; });
      if (!caught) return { error: "the click started no download the page could see; it may be a server download: check ~/Downloads", clicked };
      return fetchFile(caught.url, caught.name);
    } finally {
      pendingDownload = null;
      catchDownloads(false);
    }
  }

  // ---------- annotated screenshots ----------
  // Draws each ref from the latest snapshot that is in view as a numbered
  // box, for one capture; clear removes them.
  const ANNOTATE_ID = "__safari_harness_annotate";
  function annotate(on) {
    document.getElementById(ANNOTATE_ID)?.remove();
    if (!on) return { ok: true };
    const layer = document.createElement("div");
    layer.id = ANNOTATE_ID;
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    let shown = 0;
    for (const [ref, el] of refMap) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const box = document.createElement("div");
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #e5484d;box-sizing:border-box`;
      const tag = document.createElement("span");
      tag.textContent = ref;
      tag.style.cssText = "position:absolute;left:-2px;top:-16px;background:#e5484d;color:#fff;font:bold 11px/14px -apple-system,sans-serif;padding:0 3px;border-radius:2px;white-space:nowrap";
      // A short row in a list: above would cover the row before it, so the
      // label sits to the left, where list markers and margins usually are.
      if (r.height < 30 && r.left > 8 * ref.length + 8) { tag.style.left = "auto"; tag.style.right = "calc(100% + 2px)"; tag.style.top = "0"; }
      else if (r.top < 16) tag.style.top = "0";
      box.append(tag);
      layer.append(box);
      shown++;
    }
    document.documentElement.append(layer);
    return { ok: true, shown, dpr: devicePixelRatio, innerWidth, innerHeight };
  }

  // The element's box in this viewport, for cropping a screenshot.
  function rectOf(ref) {
    const el = resolve(ref);
    if (!el) return missing(ref);
    el.scrollIntoView({ block: "nearest", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: devicePixelRatio, innerWidth, innerHeight };
  }

  // The native setter, so framework value trackers (React) see a real edit.
  function setValue(el, value, data) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // A rich editor (ProseMirror, Lexical, Draft.js, Slate) keeps its own
  // model of the text and redraws the element from it, so an edit reaches it
  // only as input events: clearing the element's text behind its back left
  // the old text in the model. execCommand edits as typing does. Where it
  // does nothing, the edit is offered as a beforeinput the editor may take
  // over, and made by hand only if it does not.
  function replaceEditable(el, text, append) {
    if (append && !text) return;
    const selection = getSelection();
    selection.selectAllChildren(el);
    if (append) selection.collapseToEnd();
    if (document.execCommand(text ? "insertText" : "delete", false, text)) return;
    const inputType = text ? "insertText" : "deleteContent";
    const data = text || null;
    if (!el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }))) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    if (append) range.collapse(false);
    range.deleteContents();
    if (text) range.insertNode(document.createTextNode(text));
    selection.selectAllChildren(el);
    selection.collapseToEnd();
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  }

  async function typeText(ref, text, opts = {}) {
    const el = fieldOf(resolve(ref));
    if (!el) return missing(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    const before = el.isContentEditable ? "" : String(el.value || "");
    if (el.isContentEditable) {
      replaceEditable(el, text, opts.append);
    } else if ("value" in el) {
      setValue(el, (opts.append ? before : "") + text, text);
    } else {
      return { error: "element is not editable" };
    }
    if (opts.secret) secretFilled.add(el);
    // Whether the field holds the text now: a page may reformat it (a phone
    // field adds dashes) or cut it (a length limit). The text itself never
    // comes back: type once echoed a one-time code into the transcript.
    const kept = el.isContentEditable ? (el.textContent ?? "").includes(text) : el.value === (opts.append ? before : "") + text;
    return { ok: true, kept };
  }

  // ---------- Apple Passwords fill ----------

  // The sign-in fields on this page: the current-password field (never a
  // new-password one, so a sign-up form is left alone) and the username
  // field before it. A username-first page (Google, Apple) has only the
  // latter, which must then say it is a username or email field.
  function loginFields() {
    const usable = (el) => !el.disabled && !el.readOnly && shown(el);
    const password = deepQueryAll("input[type=password]")
      .find((el) => usable(el) && el.getAttribute("autocomplete") !== "new-password") ?? null;
    const scope = password?.form ?? document;
    const texts = deepQueryAll("input:not([type]), input[type=text], input[type=email], input[type=tel]", scope).filter(usable);
    const tagged = texts.find((el) => /\b(username|email)\b/.test(el.getAttribute("autocomplete") ?? ""));
    const username = tagged ?? (password
      ? texts.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
      : texts.find((el) => el.type === "email" || /user|login|email|account|identifier/i.test(`${el.name} ${el.id}`)));
    return { username: username ?? null, password };
  }

  // Which frame's form a login goes into is the extension's to find: it asks
  // every frame at once (probeFrames in background.js), and each says what
  // it holds and which site it is on. The reply never carries what was typed.
  function loginForm() {
    const f = loginFields();
    return { origin: location.origin, username: f.username !== null, password: f.password !== null };
  }

  // The daemon sends the hostname the login is saved for to the frame that
  // holds the form; a frame that has moved elsewhere gets nothing.
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

  // A verification-code field: the one marked one-time-code, one named like
  // a code, or a row of one-character boxes (one digit each).
  function codeFields() {
    const usable = (el) => !el.disabled && !el.readOnly && shown(el);
    const inputs = deepQueryAll("input:not([type]), input[type=text], input[type=tel], input[type=number], input[type=password]").filter(usable);
    const marked = inputs.find((el) => el.getAttribute("autocomplete") === "one-time-code");
    if (marked) return [marked];
    const boxes = inputs.filter((el) => el.maxLength === 1);
    if (boxes.length >= 4 && boxes.length <= 8) return boxes;
    const named = inputs.find((el) => /otp|one.?time|totp|2fa|mfa|verif|security.?code|auth.?code|\bcode\b/i.test(`${el.name} ${el.id} ${el.getAttribute("aria-label") ?? ""} ${el.placeholder}`));
    return named ? [named] : [];
  }

  function codeField() {
    return { origin: location.origin, found: codeFields().length > 0 };
  }

  // What a bot check leaves in this frame (challenge.ts in the daemon names
  // the check): the frame's address and title, its text when that is short,
  // which of the markers show (a script or an iframe counts by being there),
  // which answer fields hold a token, and the addresses of the frames it
  // shows on the page.
  function challengeFacts({ markers, answers, textMax }) {
    const roots = [document, ...shadowRoots()];
    const all = (selector) => roots.flatMap((r) => [...r.querySelectorAll(selector)]);
    const onPage = (el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 30 && r.height >= 30 && r.bottom > 0 && r.right > 0 && shown(el);
    };
    return {
      origin: location.origin,
      url: location.href,
      title: document.title,
      text: shortText(textMax),
      markers: markers.filter((s) => all(s).some((el) => el.tagName === "SCRIPT" || el.tagName === "IFRAME" || onPage(el))),
      answered: answers.filter((s) => all(s).some((el) => el.value)),
      frames: all("iframe").filter(onPage).map((f) => f.src).filter(Boolean),
    };
  }

  // The frame's text as drawn when it is at most max characters, else "": a
  // wall says what it is in a few lines. Text nodes are counted first, which
  // needs no layout and stops past max, so a long page costs no more than a
  // short one.
  function shortText(max) {
    const body = document.body;
    if (!body) return "";
    const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let length = 0;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (/^(script|style|noscript|template)$/i.test(n.parentNode.nodeName)) continue;
      length += n.data.replace(/\s+/g, " ").trim().length;
      if (length > max) return "";
    }
    const text = (body.innerText ?? "").replace(/\s+/g, " ").trim();
    return text.length <= max ? text : "";
  }

  // What the extension asks every frame at once, by name.
  window.__safariHarnessProbe = { login: loginForm, code: codeField, challenge: challengeFacts };

  function fillCode(host, code) {
    if (location.hostname !== host) return { error: `the page moved to ${location.hostname}; nothing was filled` };
    const fields = codeFields();
    if (!fields.length) return { error: "the code field is gone; nothing was filled" };
    const parts = fields.length === 1 ? [code] : [...code];
    fields.forEach((field, i) => {
      if (parts[i] === undefined) return;
      field.focus();
      setValue(field, parts[i], parts[i]);
    });
    return { ok: true, filled: ["code"] };
  }

  // ---------- address fill ----------

  // What an address field wants: the last word of its autocomplete ("section-a
  // shipping postal-code"), else what its name, id, label, or placeholder
  // says. Card fields (cc-*, "card number", CVC, expiry) are never matched.
  const ADDRESS_HINTS = [
    ["postal-code", /zip|postal|post.?code/i],
    ["address-line2", /address.?(line)?.?2|apt|apartment|suite|\bunit\b/i],
    ["address-level2", /city|town|locality/i],
    ["address-level1", /state|province|region|county/i],
    ["country", /country/i],
    ["address-line1", /address|street/i],
    ["given-name", /first.?name|given.?name|fname/i],
    ["family-name", /last.?name|surname|family.?name|lname/i],
    ["organization", /company|organi[sz]ation/i],
    ["email", /e.?mail/i],
    ["tel", /phone|\btel\b|mobile/i],
    ["name", /full.?name|^name$|your.?name/i],
  ];
  const CARD_FIELD = /\bcc-|card|cvv|cvc|csc|expir|security.?code/i;

  function addressToken(el) {
    const auto = (el.getAttribute("autocomplete") ?? "").trim().toLowerCase().split(/\s+/).pop() ?? "";
    if (auto.startsWith("cc-")) return "card";
    if (auto && auto !== "on" && auto !== "off") return auto;
    const label = [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.labels?.[0]?.textContent].filter(Boolean).join(" ");
    if (CARD_FIELD.test(label)) return "card";
    return ADDRESS_HINTS.find(([, re]) => re.test(label))?.[0] ?? null;
  }

  function chooseOption(select, wanted) {
    const norm = (s) => String(s ?? "").trim().toLowerCase();
    for (const want of wanted.filter(Boolean).map(norm)) {
      const opt = [...select.options].find((o) => norm(o.value) === want || norm(o.textContent) === want);
      if (opt) return opt;
    }
    return null;
  }

  // Fills the page's empty address fields from values keyed by autocomplete
  // token, and chooses select options that match. The reply names the
  // fields, never what went in them.
  function fillAddress(values, root) {
    const scope = root ? deepQuery(root) : document;
    if (!scope) return missing(root);
    const filled = [];
    const kept = [];
    let cards = 0;
    for (const el of deepQueryAll("input, select, textarea", scope)) {
      if (el.disabled || el.readOnly || !shown(el) || secretField(el) || /^(hidden|submit|button|checkbox|radio|file|image|reset)$/.test(el.type)) continue;
      const token = addressToken(el);
      if (token === "card") { cards++; continue; }
      if (!token) continue;
      if (el.tagName === "SELECT") {
        const opt = chooseOption(el, [values[token], token === "country" ? values["country-name"] : undefined]);
        if (!opt) continue;
        el.value = opt.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        filled.push(token);
        continue;
      }
      const value = token === "country" && !el.getAttribute("autocomplete") ? values["country-name"] : values[token];
      if (!value) continue;
      if (el.value) { kept.push(token); continue; }
      el.focus();
      setValue(el, value, value);
      filled.push(token);
    }
    return { filled, kept, cardFieldsLeftAlone: cards };
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
    let el = ref === null || ref === undefined ? null : resolve(ref);
    if (!el) {
      el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    }
    el ??= document.body;
    const { key, flags } = parseKey(spec);
    const common = { bubbles: true, cancelable: true, key, code: keyCode(key), ...flags };
    el.dispatchEvent(new KeyboardEvent("keydown", common));
    el.dispatchEvent(new KeyboardEvent("keyup", common));
    if (key === "Enter" && !Object.keys(flags).length && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      const form = el.closest("form");
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    }
    // Enter outside a form usually runs the page's own search or send.
    return key === "Enter" ? { ok: true, key, ...flags, expect: "script" } : { ok: true, key, ...flags };
  }

  function scrollBy(dx, dy) {
    window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    return { ok: true, scrollY: Math.round(window.scrollY), maxY: Math.round(document.documentElement.scrollHeight - innerHeight) };
  }

  // innerText, minus the words no one sees: boxes of at most one pixel,
  // clear boxes, boxes no scroll shows (unseenBox), and an element's own
  // words drawn without ink (faintText). Pages hide decoys that way (ebay
  // interleaves random letters into item labels and parks them
  // off-screen), and text addressed to AI agents; innerText keeps them
  // because they do render.
  function visibleText(root) {
    const text = root.innerText || "";
    const cuts = []; // [node, its words], each cut at its next occurrence
    let skip = null;
    for (const el of root.querySelectorAll("*")) {
      if (skip?.contains(el)) continue;
      const rects = el.getClientRects();
      if (!rects.length) continue; // not rendered, so not in innerText either
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if ((r.width <= 1 && r.height <= 1) || transparent(el, style) || unseenBox(el, style)) {
        if (el.textContent.trim()) {
          skip = el;
          cuts.push([el, el.innerText]);
        }
        continue;
      }
      const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && /\S/.test(n.nodeValue));
      if (own.length && faintText(el, style)) for (const n of own) cuts.push([n, norm(n.nodeValue)]);
    }
    // An element's own words and its children's interleave: cut in page order.
    cuts.sort(([a], [b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    let out = "";
    let at = 0;
    for (const [, t] of cuts) {
      const i = t ? text.indexOf(t, at) : -1;
      if (i < 0) continue;
      out += text.slice(at, i);
      at = i + t.length;
    }
    return out + text.slice(at);
  }

  // innerText stops at a shadow root and reads a filled <slot> as empty. The
  // path from root down to each open shadow host and each filled slot is
  // read node by node, as drawn; each subtree off that path is read whole
  // by leaf (innerText, or visibleText).
  function readText(root, leaf) {
    const up = (n) => n.assignedSlot ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode);
    const path = new Set();
    for (const el of [root, ...deepElements(root)]) {
      if (!el.shadowRoot && !(el.tagName === "SLOT" && el.assignedNodes().length)) continue;
      for (let n = el; n && !path.has(n); n = n === root ? null : up(n)) path.add(n);
    }
    if (!path.size) return leaf(root);
    const read = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return unseenWords(node) ? "" : node.nodeValue.replace(/\s+/g, " ");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.tagName === "BR") return "\n";
      const style = getComputedStyle(node);
      const d = style.display;
      if (d === "none" || transparent(node, style) || unseenBox(node, style)) return "";
      const t = path.has(node) ? [...drawnChildren(node)].map(read).join("") : leaf(node);
      return d.startsWith("inline") || d === "contents" ? t : `\n${t}\n`;
    };
    return read(root);
  }

  // Default root: the page's main region, or its only article; otherwise the
  // whole body (the first of many articles is a card, not the content).
  // query keeps the lines containing it, searched across the whole body.
  function extract(opts = {}) {
    if (opts.as === "table") return tables(opts);
    let root;
    if (opts.selector) root = deepQuery(opts.selector);
    else if (opts.query) root = document.body;
    else {
      const articles = document.querySelectorAll("article");
      root = document.querySelector("main, [role=main]") || (articles.length === 1 ? articles[0] : document.body);
    }
    if (!root) return { error: "no content root" };
    let text = readText(root, visibleText).replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (opts.query) text = text.split("\n").filter(queryMatch(opts.query)).join("\n");
    const limit = opts.maxBytes || 20000;
    return {
      url: location.href,
      title: document.title,
      text: text.length > limit ? text.slice(0, limit) + "\n…truncated" : text,
      truncated: text.length > limit,
    };
  }

  // A query's test for one line: "a|b" matches a line containing either
  // alternative, as plain text, case-insensitive.
  function queryMatch(query) {
    const alts = String(query).toLowerCase().split("|").map((s) => s.trim()).filter(Boolean);
    return (line) => {
      const t = line.toLowerCase();
      return alts.some((a) => t.includes(a));
    };
  }

  // ---------- tables as rows ----------
  // extract with as: "table" reads the page's data as rows instead of text:
  // each table (a <table>, or an element with the ARIA table or grid role),
  // and each run of 3 or more cards of the same structure among siblings (a
  // product grid, search results). The rules are fixed, so the same page
  // always reads the same.

  const TABLE_ROLES = "[role=table],[role=grid],[role=treegrid]";
  const CELL_ROLES = "[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]";
  // A card with more fields than this is a section of the page, not a card.
  const CARD_FIELDS_MAX = 40;

  const cellText = (cell) => norm(cell.innerText || cell.textContent || "");
  const keyOf = (el) => el.localName + (el.classList.length ? `.${el.classList[0]}` : "");
  const drawn = (el) => el.getClientRects().length > 0;

  // Tables and card lists under the root, in page order, each list once: a
  // list inside a card of one already read is part of that card.
  function tables(opts) {
    const root = opts.selector ? deepQuery(opts.selector) : document.body;
    if (!root) return { error: "no content root" };
    const found = [];
    const lists = [];
    for (const el of [root, ...deepElements(root)]) {
      const table = tableOf(el);
      if (table) found.push(table);
      else if (!lists.some((p) => p.contains(el))) {
        const cards = cardsOf(el);
        if (cards.length) lists.push(el);
        found.push(...cards);
      }
    }
    return { url: location.href, title: document.title, ...withinLimit(found, opts) };
  }

  // query keeps the rows containing it; maxBytes (default 20000) bounds the
  // JSON of what is kept, and the first row past it ends the read.
  function withinLimit(found, opts) {
    const keep = opts.query ? queryMatch(opts.query) : () => true;
    const limit = opts.maxBytes || 20000;
    const out = [];
    let used = 0;
    for (const t of found) {
      const rows = [];
      let size = JSON.stringify({ ...t, rows }).length;
      for (const row of t.rows) {
        if (!keep(row.join(" | "))) continue;
        size += JSON.stringify(row).length + 1;
        if (used + size > limit) return { tables: rows.length ? [...out, { ...t, rows }] : out, truncated: true };
        rows.push(row);
      }
      if (!rows.length) continue;
      out.push({ ...t, rows });
      used += size;
    }
    return { tables: out, truncated: false };
  }

  // A drawn table's rows, or null for anything else. A table that holds
  // other tables, or says it is for layout, lays out the page instead.
  function tableOf(el) {
    if (el.tagName === "TABLE") {
      if (el.matches("[role=presentation],[role=none]") || el.querySelector("table") || !drawn(el)) return null;
      const rows = [...el.rows];
      const thead = rows.filter((row) => row.parentElement.tagName === "THEAD").length;
      const head = thead || (rows.length > 1 && [...rows[0].cells].every((c) => c.tagName === "TH") ? 1 : 0);
      return asTable(el.caption ? cellText(el.caption) : "", spanGrid(rows), head);
    }
    if (!el.matches(TABLE_ROLES) || !drawn(el)) return null;
    const rows = [...el.querySelectorAll("[role=row]")].filter((row) => row.closest(TABLE_ROLES) === el)
      .map((row) => [...row.querySelectorAll(CELL_ROLES)].filter((c) => c.closest("[role=row]") === row));
    const head = rows.length > 1 && rows[0].length && rows[0].every((c) => c.getAttribute("role") === "columnheader") ? 1 : 0;
    return asTable(el.getAttribute("aria-label") || "", rows.map((cells) => cells.map(cellText)), head);
  }

  // A cell that spans rows or columns fills each slot it covers, so every
  // row lines up with the headers (as pandas' read_html reads them).
  function spanGrid(rows) {
    const grid = rows.map(() => []);
    rows.forEach((row, r) => {
      let c = 0;
      for (const cell of row.cells) {
        while (grid[r][c] !== undefined) c++;
        const text = cellText(cell);
        const down = Math.min(Math.max(1, cell.rowSpan), rows.length - r);
        const across = Math.max(1, cell.colSpan);
        for (let dr = 0; dr < down; dr++) for (let dc = 0; dc < across; dc++) grid[r + dr][c + dc] = text;
        c += across;
      }
    });
    return grid;
  }

  // Header rows join by column: "Price" over "USD" reads "Price / USD"; a
  // table without them has none. Rows are padded to one width; empty ones
  // are dropped.
  function asTable(caption, grid, head) {
    const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
    const pad = (row) => Array.from({ length: width }, (_, c) => row[c] ?? "");
    const headers = head ? pad([]).map((_, c) => [...new Set(grid.slice(0, head).map((row) => row[c] ?? "").filter(Boolean))].join(" / ")) : [];
    const rows = grid.slice(head).map(pad).filter((row) => row.some(Boolean));
    return rows.length ? { kind: "table", ...(caption ? { caption } : {}), headers, rows } : null;
  }

  // The card lists among el's children: 3 or more drawn children with the
  // same tag, first class, and fields, each with 2 or more text fields (a
  // menu of bare links is not data).
  function cardsOf(el) {
    if (el.children.length < 3 || el.closest(`table,select,svg,${TABLE_ROLES}`)) return [];
    const lists = [];
    for (const alike of Map.groupBy(el.children, keyOf).values()) {
      if (alike.length < 3) continue;
      const cards = alike.map((card) => (drawn(card) ? cardFields(card) : null))
        .filter((fields) => fields && fields.filter((f) => !f.link).length >= 2);
      for (const same of Map.groupBy(cards, (fields) => fields.map((f) => f.key).join(" ")).values()) {
        if (same.length >= 3) lists.push({ kind: "cards", headers: same[0].map((f) => f.key), rows: same.map((fields) => fields.map((f) => f.value)) });
      }
    }
    return lists;
  }

  // A card's fields in page order: the own text of each drawn element
  // (React's "$<!-- -->9" reads "$9"), keyed by its tag and first class,
  // and each link's address after its text. null when it has too many.
  function cardFields(card) {
    const fields = [];
    const add = (el) => {
      const own = norm([...el.childNodes].map((n) => (n.nodeType === Node.TEXT_NODE ? n.nodeValue : n.nodeName === "BR" ? " " : "")).join(""));
      if (own && drawn(el)) fields.push({ key: keyOf(el), value: own });
      if (el.tagName === "A" && el.href) fields.push({ key: `${keyOf(el)} href`, value: el.href, link: true });
      return fields.length <= CARD_FIELDS_MAX;
    };
    if (!add(card)) return null;
    for (const el of deepElements(card)) if (!add(el)) return null;
    return fields;
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

  // ---------- wait ----------
  // Resolves once the selector or text is on the page. It listens for DOM
  // changes instead of polling: Safari stops a content script's timers in a
  // hidden tab, and runs that tab's own work in late batches, but a change
  // the page makes wakes an observer in the same task. The extension asks
  // every frame (waitInFrames in background.js), and the daemon owns the
  // time limit: waitStop ends the wait with that id early. A newer wait ends
  // an older one.
  let pendingWait = null; // { id, done }

  // Text matches as a click's target does: case and spacing aside.
  function present(selector, text) {
    if (selector && deepQuery(selector) === null) return false;
    if (!text) return true;
    const want = norm(text).toLowerCase();
    return [document.body, ...inlineBodies()].some((b) => b && norm(readText(b, (el) => el.innerText ?? "")).toLowerCase().includes(want));
  }

  function waitFor(selector, text, id = null) {
    pendingWait?.done(false);
    if (present(selector, text)) return { found: true };
    return new Promise((resolve) => {
      const opts = { childList: true, subtree: true, characterData: true, attributes: true };
      // a change inside a shadow root reaches only an observer on that root
      const watch = () => { for (const r of shadowRoots()) observer.observe(r, opts); };
      const observer = new MutationObserver(() => { watch(); if (present(selector, text)) done(true); });
      const done = (found) => {
        observer.disconnect();
        if (pendingWait?.done === done) pendingWait = null;
        resolve({ found });
      };
      pendingWait = { id, done };
      observer.observe(document.documentElement, opts);
      watch();
    });
  }

  // One fact about the element a target names (ref, selector, or text, as
  // actions take them), for the REPL's locators. count and visible answer
  // for a target that matches nothing; the rest report it missing.
  function elementInfo(target, what, name) {
    const key = String(target).trim();
    if (what === "count") {
      if (/^\d+$/.test(key)) return { value: resolve(key) ? 1 : 0 };
      if (CSS_HINT.test(key)) {
        try { return { value: deepQueryAll(key).length }; } catch { /* not a selector: count by text */ }
      }
      return { value: resolve(key) ? 1 : 0 };
    }
    const el = resolve(key);
    if (what === "visible") return { value: !!el && shown(el) };
    if (!el) return missing(target);
    switch (what) {
      case "text": return { value: el.textContent };
      case "innerText": return { value: el.innerText ?? el.textContent };
      case "html": return { value: el.innerHTML };
      case "value": return secretField(el) ? { error: "that is a password field; its value stays in the page" } : { value: "value" in el ? String(el.value ?? "") : null };
      case "checked": return { value: !!el.checked };
      case "attr": return { value: el.getAttribute(String(name)) };
      case "box": {
        const r = el.getBoundingClientRect();
        return { value: { x: r.x, y: r.y, width: r.width, height: r.height } };
      }
      default: return { error: `unknown element fact ${what}` };
    }
  }

  // ---------- the page's own data ----------
  // What the page declares about itself for machines, as the data tool
  // reads it: JSON-LD, microdata, meta tags, JSON in script tags (Next.js
  // and Nuxt keep their state there), and JSON in data- attributes of its
  // main region. background.js adds the state frameworks leave in page
  // globals, and the daemon shapes the whole (daemon/pagedata.ts). One
  // answer must stay well under the 16 MB a message to the daemon may hold,
  // so a source past what is left of DATA_BUDGET characters is only measured.
  const DATA_BUDGET = 4e6;
  const DATA_MAX_ITEMS = 50;

  function pageData() {
    const found = {
      jsonld: jsonLd(),
      microdata: [...document.querySelectorAll("[itemscope]:not([itemprop])")].slice(0, DATA_MAX_ITEMS).map((el) => microItem(el, 0)),
      meta: metaTags(),
      next: parseJson(document.getElementById("__NEXT_DATA__")?.textContent),
      nuxt: parseJson(document.getElementById("__NUXT_DATA__")?.textContent),
      scripts: jsonScripts(),
      attrs: jsonAttributes(),
    };
    const out = { url: location.href, title: document.title, tooBig: {} };
    let room = DATA_BUDGET;
    for (const [name, value] of Object.entries(found)) {
      if (value === undefined) continue;
      const json = JSON.stringify(value);
      if (json.length > room) {
        out.tooBig[name] = new Blob([json]).size;
      } else {
        out[name] = value;
        room -= json.length;
      }
    }
    return out;
  }

  // A missing or malformed one reads as nothing.
  function parseJson(text) {
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }

  // The page's JSON-LD blocks, a block that holds a list as its items.
  function jsonLd() {
    return [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => {
      const v = parseJson(s.textContent);
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    });
  }

  // Meta tags by name or property (og:, twitter:, product:), one given more
  // than once as a list, and the canonical address.
  function metaTags() {
    const out = new Map();
    const add = (key, value) => {
      if (key && value !== null) out.set(key, out.has(key) ? [].concat(out.get(key), value) : value);
    };
    for (const m of document.querySelectorAll("meta[property], meta[name]")) add(m.getAttribute("property") || m.getAttribute("name"), m.getAttribute("content"));
    add("canonical", document.querySelector("link[rel=canonical]")?.href ?? null);
    return Object.fromEntries(out);
  }

  // One microdata item: its type and properties, a nested item's as an item
  // of its own, and a property given more than once as a list.
  function microItem(item, depth) {
    const props = new Map();
    for (const p of item.querySelectorAll("[itemprop]")) {
      // a property of a nested item belongs to that item
      if (p.parentElement.closest("[itemscope]") !== item) continue;
      const value = !p.hasAttribute("itemscope") ? microValue(p) : depth < 5 ? microItem(p, depth + 1) : null;
      for (const name of p.getAttribute("itemprop").split(/\s+/).filter(Boolean)) {
        props.set(name, props.has(name) ? [].concat(props.get(name), [value]) : value);
      }
    }
    const type = item.getAttribute("itemtype");
    return { ...(type ? { type } : {}), props: Object.fromEntries(props) };
  }

  // Where a microdata property keeps its value, by tag (the HTML standard's
  // list); any other element's is its text, or the content attribute some
  // pages add for the value their text only shows ("$19.99" as "19.99").
  const MICRO_VALUE = { META: "content", AUDIO: "src", EMBED: "src", IFRAME: "src", IMG: "src", SOURCE: "src", TRACK: "src", VIDEO: "src", A: "href", AREA: "href", LINK: "href", OBJECT: "data", DATA: "value", METER: "value", TIME: "datetime" };

  function microValue(el) {
    const at = Object.hasOwn(MICRO_VALUE, el.tagName) ? MICRO_VALUE[el.tagName] : null;
    // an address reads resolved, as the page would follow it
    const v = at === "src" || at === "href" || at === "data" ? el[at] : at && el.getAttribute(at);
    return String(v || el.getAttribute("content") || norm(el.textContent)).slice(0, 2000);
  }

  // JSON a page keeps in script tags of its own (a store's product, a
  // framework's settings), with the tag's id where it has one.
  function jsonScripts() {
    return [...document.querySelectorAll('script[type="application/json"]')]
      .filter((s) => s.id !== "__NEXT_DATA__" && s.id !== "__NUXT_DATA__")
      .slice(0, DATA_MAX_ITEMS)
      .flatMap((s) => {
        const value = parseJson(s.textContent);
        return value === undefined ? [] : [s.id ? { id: s.id, value } : { value }];
      });
  }

  // JSON in data- attributes of the page's main region (a product card's
  // data-product), each with the element that holds it.
  function jsonAttributes() {
    const root = document.querySelector("main, [role=main]") || document.body;
    const out = [];
    if (!root) return out;
    for (const el of [root, ...root.querySelectorAll("*")]) {
      for (const a of el.attributes) {
        if (!a.name.startsWith("data-") || !/^\s*[[{]/.test(a.value)) continue;
        const value = parseJson(a.value);
        if (value === undefined) continue;
        const classes = [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
        out.push({ el: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes}`, [a.name]: value });
        if (out.length >= DATA_MAX_ITEMS) return out;
      }
    }
    return out;
  }

  // ---------- eval's helpers ----------
  // eval's code finds these as sh, in the extension's world only (page: true
  // runs it in the page's, which has no sh): q and qa query into shadow
  // roots, text reads what the user sees of an element or selector, jsonld
  // reads the page's JSON-LD, and wait sleeps.
  const SH = Object.freeze({
    q: deepQuery,
    qa: deepQueryAll,
    text: (target = document.body) => {
      const root = typeof target === "string" ? deepQuery(target) : target;
      return root ? readText(root, visibleText).replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : null;
    },
    jsonld: jsonLd,
    wait: sleep,
  });

  // Safari stops a content script's timers in a hidden tab, so a sleep there
  // also ends on the ticks an owned tab gets (takeTicks). It lasts at most
  // 25 s, inside eval's 30.
  function sleep(ms) {
    const until = Date.now() + Math.min(Math.max(Number(ms) || 0, 0), 25000);
    return new Promise((resolve) => {
      const check = () => { if (Date.now() >= until) done(); };
      const done = () => {
        clearTimeout(timer);
        document.removeEventListener("__sh_tick", check);
        resolve();
      };
      const timer = setTimeout(done, until - Date.now());
      document.addEventListener("__sh_tick", check);
    });
  }

  // A page whose security policy forbids eval refuses to build the code. The
  // daemon then runs it in the page's own world (evaluate in tools.ts),
  // where it may be allowed, and says this if it is refused there too.
  const EVAL_BLOCKED = "this page's security policy blocks eval; use snapshot, extract, or data";

  // ---------- message dispatch ----------

  const handlers = {
    snapshot,
    click: (ref) => withOutcome(() => click(ref)),
    type: (ref, text, opts) => typeText(ref, text, opts),
    press: (ref, spec) => withOutcome(() => pressKey(ref, spec)),
    scroll: (dx, dy) => scrollBy(dx || 0, dy || 0),
    extract,
    data: pageData,
    tabInfo,
    eval: (src) => {
      let run;
      try {
        // eslint-disable-next-line no-new-func
        run = new Function("sh", `return (${src})`);
      } catch (e) {
        // bad code is the caller's to fix; any other refusal is the page's policy
        if (e instanceof SyntaxError) throw e;
        return { error: EVAL_BLOCKED };
      }
      const result = run(SH);
      if (result && typeof result.then === "function") {
        return result.then((v) => ({ ok: true, result: safeClone(v) }));
      }
      return { ok: true, result: safeClone(result) };
    },
    wait: waitFor,
    waitStop: (id = null) => { if (pendingWait && (id === null || pendingWait.id === id)) pendingWait.done(false); return { ok: true }; },
    // Resolves once the tab has drawn two frames, i.e. it is visible and painted.
    painted: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ ok: true })))),
    clickAt: (x, y) => withOutcome(() => clickAt(x, y)),
    hover,
    select: (ref, choice) => withOutcome(() => selectOption(ref, choice)),
    upload,
    history: historyGo,
    fillLogin,
    fillCode,
    fillAddress,
    locate,
    rect: rectOf,
    annotate,
    dialogs: setDialogs,
    fetch: pageFetch,
    fetchFile,
    download,
    downloadStop: () => { pendingDownload?.(null); return { ok: true }; },
    element: elementInfo,
  };
  // Ops that may raise a dialog; the page's dialogs are armed while they run.
  const DIALOG_OPS = new Set(["click", "clickAt", "type", "press", "select", "hover", "upload", "history", "download"]);

  // Runs an op with dialogs armed, and returns the dialogs it raised with
  // its result.
  function withDialogs(run) {
    const seen = dialogLog.length;
    if (!dialogPolicy) armDialogs(true, null);
    const done = (value) => {
      if (!dialogPolicy) armDialogs(false, null);
      const raised = dialogLog.slice(seen);
      return raised.length && value && typeof value === "object" && typeof value.error !== "string" ? { ...value, dialogs: raised } : value;
    };
    let out;
    try {
      out = run();
    } catch (e) {
      done(null);
      throw e;
    }
    return out && typeof out.then === "function" ? out.then(done, (e) => { done(null); throw e; }) : done(out);
  }

  function clickAt(x, y) {
    const el = deepPoint(x, y);
    if (!el) return { error: "no element at point" };
    fireClick(el, x, y);
    return { ok: true, tag: el.tagName };
  }

  // Safari hands every reply to its native side as JSON, and a NaN or
  // Infinity anywhere in it aborts the whole browser (Foundation throws in
  // _writeJSONNumber), so replies go out as plain JSON: a non-finite number
  // on its own becomes its name, and one inside an object becomes null.
  function safeClone(v) {
    if (v === undefined) return null;
    if (typeof v === "number" && !Number.isFinite(v)) return String(v);
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return String(v);
    }
  }

  const api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;
  // Answers one request from the extension.
  function answer(msg) {
    // the extension asks this first, to know a copy that answers is here
    if (msg.op === "ping") return Promise.resolve({ id: msg.id, value: true });
    const fn = handlers[msg.op];
    if (!fn) return Promise.resolve({ id: msg.id, error: `unknown op ${msg.op}` });
    // Handlers report expected failures (stale ref, no such option) as
    // { error }; send those as errors so callers never mistake them for success.
    const settle = (value) => value && typeof value === "object" && typeof value.error === "string"
      ? { id: msg.id, error: value.error }
      : { id: msg.id, value: safeClone(withHeal(value, healed)) };
    let out;
    healedNow = null;
    try {
      out = DIALOG_OPS.has(msg.op) ? withDialogs(() => fn(...(msg.args || []))) : fn(...(msg.args || []));
    } catch (e) {
      return Promise.resolve({ id: msg.id, error: String(e && e.message || e) });
    }
    // Every handler resolves its target before its first await, so a heal
    // made now is this request's.
    const healed = healedNow;
    if (out && typeof out.then === "function") {
      return out.then(settle, (err) => ({ id: msg.id, error: String(err && err.message || err) }));
    }
    return Promise.resolve(settle(out));
  }
  // A page open since before the extension reloaded keeps this world bound
  // to the old load's messaging, which reaches no one: the extension asks
  // through executeScript then (sendUntilNavigation in background.js).
  window.__safariHarnessRun = (msg) => (window.__safariHarnessInjected === claim ? answer(msg) : null);
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__safariHarness !== 1 || window.__safariHarnessInjected !== claim) return;
    return answer(msg);
  });

  // Tell the extension this document can take requests; this lands well
  // before the tab's "complete", which also waits on ads and trackers. A tab
  // the harness owns gets back how to answer its dialogs.
  // It also keeps its tab's and window's ids, for the extension to map
  // after it reloads (adopt in background.js).
  api.runtime.sendMessage({ __safariHarnessReady: 1 }).then((r) => {
    if (!r) return;
    window.__safariHarnessTab = r.tab;
    window.__safariHarnessWindow = r.window;
    if (r.dialogs) setDialogs(r.dialogs);
    if (r.net === false) document.dispatchEvent(new Event("__sh_net_off"));
  }, () => {});
})();
