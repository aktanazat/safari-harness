const UPGRADE_STORAGE = "agent-upgrade-origins";

function upgradeOrigin(value) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value || url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("give an exact https origin, or a local development origin");
  return url;
}

async function upgradeSettings() {
  return (await api.storage.local.get(UPGRADE_STORAGE))[UPGRADE_STORAGE] ?? {};
}

async function upgradeDocuments(tabId) {
  const results = await api.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({ document: window.__safariHarnessFrame ?? null, url: location.href }),
  });
  return results.filter((result) => result.result && typeof result.result.document === "string").sort((a, b) => a.frameId - b.frameId);
}

async function upgradeDocumentId(tabId) {
  const documents = await upgradeDocuments(tabId);
  if (!documents.some((result) => result.frameId === 0)) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(documents.map((result) => [result.frameId, result.result.document])));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function upgradeContext(tabId) {
  const [top] = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => ({ origin: location.origin, document: window.__safariHarnessFrame ?? null }) });
  if (!top?.result || typeof top.result.document !== "string") throw new Error("read this page first so safari can identify its document");
  const settings = await upgradeSettings();
  return { tab: tabId, ...top.result, frame: 0, enabled: settings[top.result.origin] ?? { react: false, siteActions: false } };
}

async function upgradeConfigure(tabId, feature, enabled) {
  if (!["react", "siteActions"].includes(feature) || typeof enabled !== "boolean") throw new Error("choose react or siteActions and enabled true or false");
  const context = await upgradeContext(tabId);
  const url = upgradeOrigin(context.origin);
  const settings = await upgradeSettings();
  const scope = `${url.protocol}//${url.hostname}`;
  const bytes = new TextEncoder().encode(`${scope}:${feature}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = `sh-${feature}-${Array.from(new Uint8Array(digest).subarray(0, 12), (value) => value.toString(16).padStart(2, "0")).join("")}`;
  const next = { ...settings, [url.origin]: { ...settings[url.origin], [feature]: enabled } };
  if (Object.keys(next).length > 128) throw new Error("too many development origins are enabled; disable one first");
  const registered = await api.scripting.getRegisteredContentScripts({ ids: [id] });
  const wanted = Object.entries(next).some(([origin, policy]) => {
    const candidate = new URL(origin);
    return `${candidate.protocol}//${candidate.hostname}` === scope && policy[feature] === true;
  });
  if (wanted && !registered.length) {
    const files = feature === "react" ? ["vendor/react-hook-18.3.1.js", "app-checks.js", "app-checks-start.js"] : ["site-actions.js", "site-actions-start.js"];
    await api.scripting.registerContentScripts([{ id, matches: [`${scope}/*`], js: files, runAt: "document_start", allFrames: false, world: "MAIN", persistAcrossSessions: true }]);
  } else if (!wanted && registered.length) {
    await api.scripting.unregisterContentScripts({ ids: [id] });
  }
  try {
    await api.storage.local.set({ [UPGRADE_STORAGE]: next });
  } catch (error) {
    if (wanted && !registered.length) await api.scripting.unregisterContentScripts({ ids: [id] });
    throw error;
  }
  if (!enabled) {
    await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: (which) => {
      if (which === "react") return window.__safariHarnessAppChecks?.react.disable();
      window.__safariHarnessSiteActions?.dispose();
      return null;
    }, args: [feature] });
  }
  return { origin: context.origin, feature, enabled, reloadRequired: true, injectionScope: `${scope} (all ports)`, note: "only enable this for a development site you want to inspect; reload the page to apply or fully remove its startup hook" };
}

async function upgradeAudit(tabId, options) {
  const frames = await upgradeDocuments(tabId);
  const audited = [];
  const skipped = [];
  for (const frame of frames) {
    try {
      const target = { tabId, frameIds: [frame.frameId] };
      const [loaded] = await api.scripting.executeScript({ target, func: () => typeof window.__safariHarnessAppChecks?.audit === "function" });
      if (loaded?.result !== true) await api.scripting.executeScript({ target, files: ["vendor/axe-4.10.3.min.js", "app-checks.js"] });
      const [result] = await bounded(api.scripting.executeScript({ target, func: (opts) => window.__safariHarnessAppChecks.audit(opts), args: [options] }), "accessibility audit", Date.now() + 20000);
      if (!result || result.error || result.result?.ok !== true) throw new Error(result?.result?.reason ?? "the frame did not return a completed accessibility audit");
      audited.push({ frame: frame.frameId, url: frame.result.url, result: result.result });
    } catch (error) {
      skipped.push({ frame: frame.frameId, url: frame.result.url, reason: String(error.message ?? error) });
    }
  }
  if (!frames.some((frame) => frame.frameId === 0)) skipped.push({ frame: 0, reason: "the top page could not be read" });
  const expectedFrames = 1 + audited.reduce((sum, frame) => sum + frame.result.embeddedFrames.length, 0);
  if (expectedFrames > frames.length) skipped.push({ frame: null, count: expectedFrames - frames.length, reason: "embedded documents without a readable extension world were not audited" });
  const inventoryComplete = audited.every((frame) => frame.result.frameInventoryTruncated !== true);
  return { ok: audited.length > 0, audited, skipped, complete: skipped.length === 0 && inventoryComplete, note: "automated checks do not establish accessibility compliance; embedded pages the extension cannot read are not audited" };
}

async function upgradeReact(tabId, method, options) {
  if (!["status", "inspect"].includes(method)) throw new Error("react takes status, inspect, enable, or disable");
  const context = await upgradeContext(tabId);
  if (context.enabled.react !== true) throw new Error("enable react inspection for this development origin first; its startup hook covers this scheme and hostname on all ports");
  await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", files: ["app-checks.js"] });
  const [result] = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: (operation, opts) => window.__safariHarnessAppChecks.react[operation](opts), args: [method, options] });
  if (!result) throw new Error("the app did not return its component information");
  return result.result;
}

async function upgradeSite(tabId, binding, method, args, timeoutMs = 10000) {
  if (!["catalog", "schema", "invoke", "cancel"].includes(method)) throw new Error("unknown site action operation");
  const settings = await upgradeSettings();
  if (settings[binding.origin]?.siteActions !== true) throw new Error("site actions are not enabled for this exact origin");
  const [result] = await bounded(api.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (expected, operation, params, ms) => {
      if (window.__safariHarnessFrame !== expected.document || location.origin !== expected.origin) return { status: "refused", reason: "the page changed before the action could start", retry: false };
      return new Promise((resolve) => {
        const id = crypto.randomUUID();
        const eventName = `__sh_site_action_reply_${id}`;
        const done = (value) => { clearTimeout(timer); document.removeEventListener(eventName, hear); resolve(value); };
        const hear = (event) => {
          if (typeof event.detail !== "string" || event.detail.length > 262144) return;
          try { done(JSON.parse(event.detail)); } catch { done({ status: "unknown", reason: "the site returned an unreadable answer", retry: false }); }
        };
        const timer = setTimeout(() => done({ status: operation === "invoke" ? "unknown" : "refused", reason: "the site did not answer in time", retry: false }), ms);
        document.addEventListener(eventName, hear);
        document.dispatchEvent(new CustomEvent("__sh_site_action_request", { detail: JSON.stringify({ id, method: operation, args: params }) }));
      });
    },
    args: [binding, method, args, timeoutMs],
  }), "site action", Date.now() + timeoutMs + 1000);
  if (!result) throw new Error("the site did not answer the action request");
  return result.result;
}

async function upgradeParentPoint(tabId, frameId, initial, deadline, candidates, scroll = true) {
  let point = initial;
  let childFrame = frameId;
  const chain = [{ frame: frameId, document: point.frame }];
  const visited = new Set([childFrame]);
  while (childFrame !== 0) {
    let parent;
    for (const candidate of candidates) {
      if (visited.has(candidate)) continue;
      const result = await toTab(tabId, "assertFrameClickable", [point.frame, { x: point.x, y: point.y }, { scroll }], deadline - Date.now(), candidate);
      if (result?.error) throw new Error(result.error);
      if (result?.value?.found === true) {
        if (result.value.blocker) throw new Error(result.value.blocker);
        parent = candidate;
        point = result.value;
        break;
      }
    }
    if (parent === undefined) throw new Error("the containing frame could not be checked safely; read the page again before acting");
    childFrame = parent;
    visited.add(parent);
    chain.push({ frame: parent, document: point.frame });
  }
  return { point: { x: point.x, y: point.y }, chain };
}

async function upgradeFrameClick(tabId, op, args, deadline, frameId, kept) {
  if (frameId === 0 || !(op === "click" || op === "downloadClick" || op === "select" && args[1] !== undefined)) return;
  const candidates = [0, ...(await frameTokens(tabId)).values()];
  const probe = await toTab(tabId, "clickProbe", [args[0], op === "select" ? "select" : "click"], deadline - Date.now(), frameId, kept);
  if (probe?.error) return probe;
  await upgradeParentPoint(tabId, frameId, probe.value, deadline, candidates);
  return probe;
}

async function upgradeNativePreflight(tabId, options) {
  if (options.do !== "drag" && options.do !== "paste") throw new Error("native preflight takes drag or paste");
  const source = frameOf([options.ref]);
  const target = frameOf([options.target]);
  const frameId = source.frameId;
  if (options.target !== undefined && target.frameId !== frameId) throw new Error("drag endpoints must be in the same frame; use two refs from that frame or top-page coordinates");
  if (frameId !== 0 && (options.x !== undefined || options.y !== undefined || options.targetX !== undefined || options.targetY !== undefined)) throw new Error("embedded-frame drag needs two refs from that frame; coordinates name the top viewport");
  const deadline = Date.now() + 10000;
  const document = await upgradeDocumentId(tabId);
  if (!document) throw new Error("read this page first so safari can identify its document");
  const localOptions = { kind: options.do, ref: source.args[0], target: target.args[0], x: options.x, y: options.y, targetX: options.targetX, targetY: options.targetY, ...(options.expected ? { expected: options.expected.local } : {}) };
  const probe = await toTab(tabId, "nativeProbe", [localOptions], deadline - Date.now(), frameId);
  if (probe?.error) throw new Error(probe.error);
  const local = probe?.value;
  if (!local?.from || typeof local.document !== "string") throw new Error("the native target did not return a safe point");
  const candidates = frameId === 0 ? [0] : [0, ...(await frameTokens(tabId)).values()];
  const from = await upgradeParentPoint(tabId, frameId, { ...local.from, frame: local.document }, deadline, candidates, false);
  const to = local.to ? await upgradeParentPoint(tabId, frameId, { ...local.to, frame: local.document }, deadline, candidates, false) : undefined;
  if (to && JSON.stringify(from.chain) !== JSON.stringify(to.chain)) throw new Error("the drag's containing document changed during preparation");
  const [top] = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => ({ document: window.__safariHarnessFrame, innerWidth, innerHeight }) });
  if (!top?.result || top.result.document !== from.chain.at(-1).document || await upgradeDocumentId(tabId) !== document) throw new Error("the page changed during native input preparation");
  const result = { document, innerWidth: top.result.innerWidth, innerHeight: top.result.innerHeight, from: from.point, ...(to ? { to: to.point } : {}), ...(local.focus ? { focus: local.focus } : {}), inputFrame: frameId, local, binding: { tab: tabId, frame: frameId, chain: from.chain } };
  if (options.expected && JSON.stringify(result) !== JSON.stringify(options.expected)) throw new Error("the native target or its containing viewport changed before input");
  return result;
}
