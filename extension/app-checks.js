// Optional app debugging bridge. Axe must be loaded immediately before this
// file in the extension's ISOLATED world. React inspection runs only in MAIN.
// No component, hook callback, component getter, effect or state updater is executed.
(() => {
  if (Object.hasOwn(window, "__safariHarnessAppChecks")) return;
  const extensionWorld = typeof browser !== "undefined" && typeof browser.runtime?.getURL === "function";
  const engine = extensionWorld && window.axe?.version === "4.10.3" && typeof window.axe.run === "function" ? window.axe : null;
  let auditing = false;
  let ownedHook = null;
  let inspectionEnabled = false;
  let disabled = false;
  let nextFiberId = 0;
  let fiberIds = new WeakMap();
  const own = (object, key) => {
    if (object === null || (typeof object !== "object" && typeof object !== "function")) return undefined;
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
  };
  const text = (value, max = 300) => typeof value === "string" ? value.slice(0, max) : "";
  const limit = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  const safeURL = (value) => {
    try {
      const url = new URL(value, location.href);
      if (!["http:", "https:", "file:"].includes(url.protocol)) return url.protocol;
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      return url.href.slice(0, 1000);
    } catch { return ""; }
  };
  const impact = (value) => ["minor", "moderate", "serious", "critical"].includes(value) ? value : null;

  // Structural paths never repeat a field value, an accessible name, or a
  // secret-bearing attribute. Each part after the first enters an open shadow.
  const selectorFor = (element) => {
    if (!(element instanceof Element)) return [];
    const segments = [];
    let el = element;
    let budget = 80;
    while (el && budget > 0) {
      const parts = [];
      while (el instanceof Element && budget-- > 0) {
        let index = 1;
        for (let sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.localName === el.localName) index++;
        const tag = CSS.escape(el.localName);
        parts.unshift(`${tag}:nth-of-type(${index})`);
        if (el.parentElement) el = el.parentElement;
        else break;
      }
      segments.unshift(parts.join(" > ").slice(0, 3000));
      const root = el?.getRootNode();
      el = root instanceof ShadowRoot ? root.host : null;
    }
    return segments;
  };

  const embeddedFrames = () => {
    const frames = [];
    const roots = [document];
    let scanned = 0;
    while (roots.length && scanned < 5000 && frames.length < 100) {
      const root = roots.pop();
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let element;
      while ((element = walk.nextNode()) && scanned++ < 5000) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (!["iframe", "frame"].includes(element.localName)) continue;
        let readable = false;
        try { readable = !!element.contentDocument?.documentElement; } catch { readable = false; }
        frames.push({ selector: selectorFor(element), url: safeURL(element.src || "about:blank"), readable, status: "skipped", reason: "separate frame; requires its own isolated-world audit" });
        if (frames.length >= 100) break;
      }
    }
    return { frames, truncated: scanned >= 5000 || frames.length >= 100 || roots.length > 0 };
  };

  async function audit(options = {}) {
    if (!engine) return { ok: false, status: "unavailable", reason: "bundled axe was not loaded in this isolated world" };
    if (auditing) return { ok: false, status: "busy", reason: "an axe audit is still running in this document" };
    let context = document;
    if (options.selector !== undefined) {
      if (typeof options.selector !== "string" || !options.selector || options.selector.length > 1000) return { ok: false, status: "invalid_argument", reason: "selector must be a nonempty CSS selector of at most 1000 characters" };
      try { context = document.querySelector(options.selector); } catch { return { ok: false, status: "invalid_argument", reason: "invalid CSS selector" }; }
      if (!context) return { ok: false, status: "not_found", reason: "the requested audit region does not exist" };
    }
    const rules = options.rules;
    if (rules !== undefined && (!Array.isArray(rules) || !rules.length || rules.length > 50 || rules.some((rule) => typeof rule !== "string" || !engine.getRules().some((known) => known.ruleId === rule)))) return { ok: false, status: "invalid_argument", reason: "rules must name between 1 and 50 bundled axe rules" };
    const maxRules = limit(options.maxRules, 50, 100);
    const maxNodes = limit(options.maxNodes, 100, 200);
    const nodesPerRule = limit(options.nodesPerRule, 10, 25);
    const timeoutMs = limit(options.timeoutMs, 8000, 15000);
    auditing = true;
    let timer;
    try {
      const running = engine.run(context, { iframes: false, preload: false, elementRef: true, resultTypes: ["violations", "incomplete"], ...(rules ? { runOnly: { type: "rule", values: rules } } : {}) });
      // A timeout does not cancel WebKit execution. Keep the busy gate closed
      // until axe actually settles, rather than starting overlapping audits.
      const completion = Promise.resolve(running).finally(() => { auditing = false; clearTimeout(timer); });
      const result = await Promise.race([completion, new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
      if (!result) return { ok: false, status: "timeout", reason: "axe did not finish; no audit result is available", running: auditing };
      let nodesLeft = maxNodes;
      let rulesLeft = maxRules;
      const serialize = (items) => items.slice(0, rulesLeft).map((rule) => {
        rulesLeft--;
        const shown = rule.nodes.slice(0, Math.min(nodesPerRule, nodesLeft));
        nodesLeft -= shown.length;
        return {
          id: text(rule.id, 100), impact: impact(rule.impact), help: text(rule.help, 600), description: text(rule.description, 800), helpUrl: safeURL(rule.helpUrl), tags: rule.tags.slice(0, 16).map((tag) => text(tag, 80)),
          nodeCount: rule.nodes.length,
          nodes: shown.map((node) => ({
            selector: selectorFor(node.element), impact: impact(node.impact),
            checks: [...node.any, ...node.all, ...node.none].slice(0, 12).map((check) => ({ id: text(check.id, 100), impact: impact(check.impact) })),
          })),
          truncated: shown.length < rule.nodes.length,
        };
      });
      const violations = serialize(result.violations);
      const incomplete = serialize(result.incomplete);
      const inventory = embeddedFrames();
      return {
        ok: true, status: "audited", engine: { name: "axe-core", version: engine.version }, url: safeURL(location.href),
        scope: options.selector ? "selected region in this document" : "this document", framesIncluded: false,
        violations, incomplete,
        counts: { violations: result.violations.length, incomplete: result.incomplete.length },
        truncated: violations.length < result.violations.length || incomplete.length < result.incomplete.length || [...violations, ...incomplete].some((rule) => rule.truncated),
        embeddedFrames: inventory.frames, frameInventoryTruncated: inventory.truncated,
        note: "automated findings only; empty findings do not establish accessibility compliance",
      };
    } catch {
      auditing = false;
      return { ok: false, status: "failed", reason: "axe could not complete this audit; no findings are available" };
    } finally { clearTimeout(timer); }
  }

  const sensitive = /(?:password|passwd|passphrase|secret|token|authorization|cookie|session|credential|private.?key|api.?key|otp|verification.?code|security.?code|card.?number|cvv|cvc)/i;
  const secretText = /(?:\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  function summarize(value, includeValues, key = "", depth = 0, seen = new WeakSet(), budget = { left: 150 }) {
    if (sensitive.test(key)) return { redacted: true };
    if (budget.left-- <= 0) return { truncated: true };
    if (value === null) return includeValues ? null : { type: "null", withheld: true };
    const type = typeof value;
    if (["undefined", "symbol", "bigint"].includes(type)) return { type, withheld: true };
    if (type === "string") return includeValues && !secretText.test(value) ? value.slice(0, 300) : { type, length: value.length, withheld: true };
    if (type === "number" || type === "boolean") return includeValues && (type !== "number" || Number.isFinite(value)) ? value : { type, withheld: true };
    if (type === "function") return { type, name: text(own(value, "name"), 80) };
    if (value instanceof Node) return { type: "dom-node", withheld: true };
    if (seen.has(value)) return { type: "circular" };
    if (depth >= 3) return { type: Array.isArray(value) ? "array" : "object", truncated: true };
    seen.add(value);
    if (own(value, "$$typeof")) return { type: "react-element", withheld: true };
    const keys = Object.getOwnPropertyNames(value);
    const entries = keys.slice(0, 25).map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return [name.slice(0, 100), descriptor && Object.hasOwn(descriptor, "value") ? summarize(descriptor.value, includeValues, name, depth + 1, seen, budget) : { type: "accessor", withheld: true }];
    });
    return { type: Array.isArray(value) ? "array" : "object", entries: Object.fromEntries(entries), ...(keys.length > 25 ? { truncated: true } : {}) };
  }

  const currentHook = () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__");
    // The upstream DevTools hook uses a getter. Reading that one conventional
    // entrypoint is necessary; component/state getters are never invoked.
    try { return descriptor ? window.__REACT_DEVTOOLS_GLOBAL_HOOK__ : null; } catch { return null; }
  };
  const rendererEntries = (hook) => {
    const renderers = own(hook, "renderers");
    if (own(hook, "supportsFiber") !== true || own(hook, "isDisabled") === true || typeof own(hook, "getFiberRoots") !== "function") return null;
    try {
      const entries = [];
      let truncated = false;
      for (const entry of Map.prototype.entries.call(renderers)) {
        if (entries.length >= 32) { truncated = true; break; }
        entries.push(entry);
      }
      return { entries, truncated };
    } catch { return null; }
  };
  const fiberId = (fiber) => {
    let id = fiberIds.get(fiber) ?? fiberIds.get(own(fiber, "alternate"));
    if (!id) id = ++nextFiberId;
    fiberIds.set(fiber, id);
    const alternate = own(fiber, "alternate");
    if (alternate && typeof alternate === "object") fiberIds.set(alternate, id);
    return id;
  };
  const componentName = (fiber) => {
    let type = own(fiber, "type");
    if (!type) type = own(fiber, "elementType");
    return text(own(type, "displayName") || own(type, "name") || own(own(type, "render"), "displayName") || own(own(type, "render"), "name") || own(own(type, "type"), "name") || "Anonymous", 150);
  };
  const sourceOf = (fiber) => {
    const source = own(fiber, "_debugSource");
    const file = own(source, "fileName");
    if (typeof file !== "string") return null;
    return { file: safeURL(file), line: own(source, "lineNumber") ?? null, column: own(source, "columnNumber") ?? null };
  };
  const ownersOf = (fiber) => {
    const owners = [];
    const seen = new Set();
    let owner = own(fiber, "_debugOwner");
    while (owner && owners.length < 20 && !seen.has(owner)) {
      seen.add(owner);
      owners.push({ name: componentName(owner), source: sourceOf(owner) });
      owner = own(owner, "_debugOwner");
    }
    return owners;
  };
  const singleSlotHooks = new Set(["useState", "useReducer", "useRef", "useMemo", "useCallback", "useEffect", "useLayoutEffect", "useInsertionEffect", "useImperativeHandle", "useId", "useDeferredValue"]);
  const zeroSlotHooks = new Set(["useContext", "useDebugValue"]);
  const hooksOf = (fiber, includeValues) => {
    const debugTypes = own(fiber, "_debugHookTypes");
    const types = Array.isArray(debugTypes) ? debugTypes.filter((kind) => !zeroSlotHooks.has(kind)) : [];
    const reliableKinds = types.length > 0 && types.every((kind) => singleSlotHooks.has(kind));
    const hooks = [];
    const seen = new Set();
    let cell = own(fiber, "memoizedState");
    while (cell && typeof cell === "object" && hooks.length < 40 && !seen.has(cell) && Object.hasOwn(cell, "memoizedState")) {
      seen.add(cell);
      const kind = reliableKinds ? types[hooks.length] ?? "storage-slot" : "storage-slot";
      const value = own(cell, "memoizedState");
      hooks.push({ index: hooks.length, kind, value: summarize(value, includeValues) });
      cell = own(cell, "next");
    }
    return { slots: hooks, truncated: !!cell, kinds: reliableKinds ? "development hook metadata" : "unclassified React storage slots; custom hook names and primitive kinds unavailable" };
  };

  const react = {
    enable() {
      disabled = false;
      const existing = currentHook();
      if (existing) {
        if (!rendererEntries(existing)) return { ok: false, status: "unsupported", reason: "the existing React hook is not a compatible Fiber DevTools hook; it was not changed" };
        inspectionEnabled = true;
        return { ok: true, status: "enabled", hook: ownedHook?.hook === existing ? "harness" : "existing", reloadRequired: false };
      }
      const create = own(window, "__safariHarnessCreateReactHook");
      if (typeof create !== "function") return { ok: false, status: "unavailable", reason: "the bundled React hook creator was not loaded" };
      const previous = Object.getOwnPropertyDescriptor(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__");
      if (previous) return { ok: false, status: "unsupported", reason: "a React hook property already exists; it was not replaced" };
      const controller = create();
      try { Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { configurable: true, value: controller.hook }); }
      catch { controller.disable(); return { ok: false, status: "unavailable", reason: "the page does not permit React hook registration" }; }
      ownedHook = controller;
      inspectionEnabled = true;
      return { ok: true, status: "enabled", hook: "harness", reloadRequired: document.readyState !== "loading", note: "the hook must be registered before React loads; reload if React already initialized" };
    },
    disable() {
      inspectionEnabled = false;
      disabled = true;
      const owned = ownedHook;
      let removedHook = false;
      if (owned) {
        owned.disable();
        if (currentHook() === owned.hook) removedHook = Reflect.deleteProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__");
      }
      ownedHook = null;
      fiberIds = new WeakMap();
      nextFiberId = 0;
      return { ok: true, status: "disabled", removedHook, reloadRecommended: !!owned, note: "unregister the opted-in document-start script before reloading; existing third-party hooks are untouched" };
    },
    status() {
      const hook = currentHook();
      if (!hook) return { ok: true, status: disabled ? "disabled" : "not_detected", hook: null, reloadRequired: false };
      const snapshot = rendererEntries(hook);
      if (!snapshot) return { ok: false, status: "unsupported", reason: "an incompatible React hook is present" };
      return { ok: true, status: disabled ? "disabled" : inspectionEnabled ? "enabled" : "existing_hook", hook: ownedHook?.hook === hook ? "harness" : "existing", renderers: snapshot.entries.map(([id, renderer]) => ({ id, version: text(own(renderer, "version"), 50), name: text(own(renderer, "rendererPackageName"), 100) })), truncated: snapshot.truncated, reloadRequired: snapshot.entries.length === 0 };
    },
    inspect(options = {}) {
      if (disabled) return { ok: false, status: "disabled", reason: "React inspection has been disabled for this document" };
      const hook = currentHook();
      if (!hook) return { ok: false, status: "not_detected", reason: "no React DevTools hook is present; explicitly enable before React loads and reload" };
      const snapshot = rendererEntries(hook);
      if (!snapshot) return { ok: false, status: "unsupported", reason: "the existing hook cannot expose Fiber roots safely" };
      const renderers = snapshot.entries;
      const maxComponents = limit(options.maxComponents, 50, 200);
      const maxFibers = limit(options.maxFibers, 5000, 10000);
      const includeValues = options.includeValues === true;
      const components = [];
      const unsupported = [];
      const stack = [];
      let roots = 0;
      let truncated = snapshot.truncated;
      for (const [rendererId, renderer] of renderers) {
        const version = text(own(renderer, "version"), 50);
        if (!/^(16|17|18|19)\./.test(version)) { unsupported.push({ rendererId, version, reason: "this React renderer version is not supported" }); continue; }
        let rendererRoots;
        try { rendererRoots = own(hook, "getFiberRoots").call(hook, rendererId); }
        catch { unsupported.push({ rendererId, version, reason: "the existing hook could not return its mounted roots" }); continue; }
        try {
          let count = 0;
          for (const root of Set.prototype.values.call(rendererRoots)) {
            if (count++ >= 32) { truncated = true; break; }
            const current = own(root, "current");
            if (current && own(current, "tag") === 3) { stack.push({ fiber: current, parentId: null, depth: 0, rendererId }); roots++; }
            else unsupported.push({ rendererId, version, reason: "the renderer returned an unsupported root shape" });
          }
        } catch { unsupported.push({ rendererId, version, reason: "the existing hook did not return a Fiber root set" }); }
      }
      const seen = new Set();
      let visited = 0;
      try {
        while (stack.length && visited < maxFibers && components.length < maxComponents) {
          const entry = stack.pop();
          const { fiber, parentId, depth, rendererId } = entry;
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          visited++;
          const sibling = own(fiber, "sibling");
          if (sibling) stack.push({ fiber: sibling, parentId, depth, rendererId });
          const tag = own(fiber, "tag");
          const component = [0, 1, 2, 11, 14, 15, 16, 17].includes(tag);
          const id = component ? fiberId(fiber) : parentId;
          if (component) {
            const name = componentName(fiber);
            if ((options.id === undefined || options.id === id) && (options.name === undefined || options.name === name)) {
              components.push({
                id, parentId, depth, rendererId, name, kind: tag === 1 || tag === 17 ? "class" : "function", props: summarize(own(fiber, "memoizedProps"), includeValues),
                ...(tag === 1 || tag === 17 ? { state: summarize(own(fiber, "memoizedState"), includeValues) } : { hooks: hooksOf(fiber, includeValues) }),
                owners: ownersOf(fiber), source: sourceOf(fiber),
              });
            }
          }
          const child = own(fiber, "child");
          if (child) stack.push({ fiber: child, parentId: id, depth: component ? depth + 1 : depth, rendererId });
        }
      } catch { return { ok: false, status: "unsupported", reason: "the renderer contains an unreadable Fiber value; no inspection was completed" }; }
      const retention = ownedHook?.limits;
      return {
        ok: true, status: roots ? "inspected" : unsupported.length ? "unsupported" : renderers.length ? "no_mounted_roots" : "not_detected", url: safeURL(location.href),
        hook: ownedHook?.hook === hook ? "harness" : "existing", components, roots, unsupported,
        truncated: truncated || stack.length > 0 || !!(retention?.renderers || retention?.roots), valuesIncluded: includeValues,
        note: "current committed Fiber data; no components or hook functions were executed; source, owners and hook kinds may be absent in production or newer React builds",
      };
    },
  };
  Object.defineProperty(window, "__safariHarnessAppChecks", { configurable: true, value: Object.freeze({ audit, react: Object.freeze(react) }) });
})();
