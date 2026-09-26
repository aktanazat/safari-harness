// CDP shim: a Chrome-DevTools-Protocol-compatible endpoint backed by the
// Safari extension bridge. Chrome-facing clients (chrome-devtools-mcp,
// puppeteer-core with a custom transport, any ws JSON-RPC client) connect
// to ws://127.0.0.1:PORT/devtools/browser or /devtools/page/<tabId> and get
// the subset of CDP that Safari can honestly serve through a web extension.
//
// Domains implemented: Target, Page (navigate/screenshot/history/frames),
// Runtime (evaluate + console events), Input (mouse/key), Network (fetch/XHR
// capture via polling), Log, plus no-op acks for common enable calls.

import * as tools from "./tools.ts";
export type CdpMsg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
type Send = (obj: Record<string, unknown>) => void;

const targetId = (tabId: number) => `SH-${tabId}`;
const tabFromTarget = (t: string): number => {
  const n = Number(String(t).replace(/^SH-/, ""));
  if (!Number.isFinite(n)) throw new Error(`bad targetId ${t}`);
  return n;
};

function ok(id: number | undefined, result: unknown): Record<string, unknown> {
  return { id, result };
}
function err(id: number | undefined, message: string): Record<string, unknown> {
  return { id, error: { code: -32000, message } };
}

// ---------- event polling ----------

type EventPump = {
  tabId: number;
  netOn: boolean;
  consoleOn: boolean;
  lastNetT: number;
  lastConsoleT: number;
  timer: ReturnType<typeof setInterval>;
};

const pumps: Record<string, EventPump> = {};

function startPump(send: Send, tabId: number, connId: number) {
  const key = `${connId}:${tabId}`;
  if (pumps[key]) return pumps[key];
  const pump: EventPump = {
    tabId,
    netOn: false,
    consoleOn: false,
    lastNetT: 0,
    lastConsoleT: 0,
    timer: setInterval(async () => {
      try {
        if (pump.netOn) {
          const res = (await tools.netRead({ tab: tabId })) as { entries: { kind: string; url: string; method: string; status?: number; error?: string; ms: number; t: number }[] };
          for (const e of res.entries) {
            if (e.t <= pump.lastNetT) continue;
            pump.lastNetT = e.t;
            const requestId = `n${e.t}`;
            send({
              method: "Network.requestWillBeSent",
              params: {
                requestId,
                frameId: "1",
                loaderId: "l1",
                documentURL: "",
                timestamp: e.t / 1000,
                wallTime: e.t / 1000,
                type: "XHR",
                request: { url: e.url, method: e.method, headers: {}, postData: "", hasPostData: e.method !== "GET" },
              },
            });
            if (e.status !== undefined) {
              send({
                method: "Network.responseReceived",
                params: {
                  requestId,
                  frameId: "1",
                  loaderId: "l1",
                  timestamp: (e.t + e.ms) / 1000,
                  type: "XHR",
                  response: { url: e.url, status: e.status, statusText: "", headers: {}, mimeType: "application/json", securityStatus: "Secure" },
                },
              });
              send({ method: "Network.loadingFinished", params: { requestId, timestamp: (e.t + e.ms) / 1000, encodedDataLength: 0 } });
            } else {
              send({ method: "Network.loadingFailed", params: { requestId, timestamp: (e.t + e.ms) / 1000, errorText: e.error ?? "failed", canceled: false } });
            }
          }
        }
        if (pump.consoleOn) {
          const res = (await tools.consoleRead({ tab: tabId })) as { entries: { level: string; text: string; t: number }[] };
          for (const e of res.entries) {
            if (e.t <= pump.lastConsoleT) continue;
            pump.lastConsoleT = e.t;
            send({
              method: "Runtime.consoleAPICalled",
              params: {
                type: e.level === "log" ? "log" : e.level,
                args: [{ type: "string", value: e.text }],
                timestamp: e.t / 1000,
                executionContextId: 1,
              },
            });
          }
        }
      } catch {
        // tab gone or bridge hiccup; the next poll or a detach will clean up
      }
    }, 800),
  };
  pumps[key] = pump;
  return pump;
}
// pumps are keyed per (connection, tab) so a dead socket's send is never
// reused by a later attach to the same tab
export function stopConnPumps(connId: number) {
  for (const key of Object.keys(pumps)) {
    if (!key.startsWith(`${connId}:`)) continue;
    clearInterval(pumps[key].timer);
    delete pumps[key];
  }
}

export function stopAllPumps() {
  for (const key of Object.keys(pumps)) {
    clearInterval(pumps[key].timer);
    delete pumps[key];
  }
}

// ---------- dispatch ----------

export async function handleCdp(send: Send, msg: CdpMsg, scope: { kind: "browser" | "page"; tabId?: number; connId: number }) {
  const { id, method } = msg;
  const params = msg.params ?? {};
  // page sockets pin their tab; browser sockets can address one via the
  // sessionId handed out by Target.attachToTarget
  const sessionTab = msg.sessionId?.startsWith("s-") ? Number(msg.sessionId.slice(2)) : undefined;
  const effTab = scope.tabId ?? (Number.isFinite(sessionTab) ? sessionTab : undefined);
  try {
    switch (method) {
      // ----- Target -----
      case "Target.getTargets": {
        const tabs = await tools.listTabs();
        return send(ok(id, {
          targetInfos: tabs.map((t) => ({
            targetId: targetId(t.id),
            type: "page",
            title: t.title ?? "",
            url: t.url ?? "",
            attached: false,
            canAccessOpener: false,
          })),
        }));
      }
      case "Target.createTarget": {
        const t = await tools.openTab(String(params.url ?? "about:blank"), !!params.background);
        return send(ok(id, { targetId: targetId(t.id) }));
      }
      case "Target.attachToTarget": {
        const tabId = tabFromTarget(String(params.targetId));
        return send(ok(id, { sessionId: `s-${tabId}` }));
      }
      case "Target.detachFromTarget":
        return send(ok(id, {}));
      case "Target.closeTarget": {
        tools.closeTab(tabFromTarget(String(params.targetId))).catch(() => {});
        return send(ok(id, { success: true }));
      }
      case "Target.setDiscoverTargets": {
        const tabs = await tools.listTabs();
        for (const t of tabs) send({ method: "Target.targetCreated", params: { targetInfo: { targetId: targetId(t.id), type: "page", title: t.title ?? "", url: t.url ?? "", attached: false, canAccessOpener: false } } });
        return send(ok(id, {}));
      }
      case "Target.getTargetInfo": {
        const tabId = effTab ?? (params.targetId ? tabFromTarget(String(params.targetId)) : await tools.resolveTab());
        const info = (await tools.tabInfo({ tab: tabId })) as { url: string; title: string };
        return send(ok(id, { targetInfo: { targetId: targetId(tabId), type: "page", title: info.title, url: info.url, attached: true, canAccessOpener: false } }));
      }

      // ----- Page -----
      case "Page.navigate": {
        const tabId = effTab ?? (await tools.resolveTab());
        const r = await tools.navigate(tabId, String(params.url));
        return send(ok(id, { frameId: "1", loaderId: `l${Date.now()}`, url: (r as { url?: string }).url }));
      }
      case "Page.captureScreenshot": {
        const tabId = effTab ?? (await tools.resolveTab());
        const { data } = await tools.captureTab(tabId);
        return send(ok(id, { data }));
      }
      case "Page.getFrameTree": {
        const tabId = effTab ?? (await tools.resolveTab());
        const info = (await tools.tabInfo({ tab: tabId })) as { url: string };
        return send(ok(id, { frameTree: { frame: { id: "1", loaderId: "l1", url: info.url, domainAndRegistry: "", securityOrigin: new URL(info.url || "about:blank").origin, mimeType: "text/html", secureContext: true, crossOriginIsolatedContextType: "NotIsolated" } } }));
      }
      case "Page.getNavigationHistory": {
        const tabId = effTab ?? (await tools.resolveTab());
        const info = (await tools.tabInfo({ tab: tabId })) as { url: string; title: string };
        return send(ok(id, { currentIndex: 0, entries: [{ id: 0, url: info.url, title: info.title }] }));
      }
      case "Page.reload": {
        const tabId = effTab ?? (await tools.resolveTab());
        await tools.history({ tab: tabId, go: "reload" });
        return send(ok(id, {}));
      }
      case "Page.enable":
      case "Page.setLifecycleEventsEnabled":
        return send(ok(id, {}));

      // ----- Runtime -----
      case "Runtime.evaluate": {
        const tabId = effTab ?? (await tools.resolveTab());
        const r = (await tools.evaluate({ tab: tabId, expression: String(params.expression ?? "") })) as { ok?: boolean; result?: unknown };
        const value = r?.result;
        return send(ok(id, {
          result: {
            type: typeof value === "object" && value !== null ? "object" : (typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string"),
            value: typeof value === "object" && value !== null ? JSON.stringify(value) : value,
            ...(typeof value === "object" && value !== null ? { subtype: "node", description: "Object" } : {}),
          },
        }));
      }
      case "Runtime.callFunctionOn": {
        const tabId = effTab ?? (await tools.resolveTab());
        const fn = String(params.functionDeclaration ?? "function(){}");
        const argJson = JSON.stringify((params.arguments as unknown[] | undefined)?.[0]?.value ?? null);
        const r = (await tools.evaluate({ tab: tabId, expression: `(${fn})(${argJson})` })) as { result?: unknown };
        return send(ok(id, { result: { type: "string", value: JSON.stringify(r?.result ?? null) } }));
      }
      case "Runtime.enable": {
        const tabId = effTab ?? (await tools.resolveTab());
        const pump = startPump(send, tabId, scope.connId);
        pump.consoleOn = true;
        return send(ok(id, {}));
      }
      case "Runtime.runIfWaitingForDebugger":
        return send(ok(id, {}));

      // ----- Input -----
      case "Input.dispatchMouseEvent": {
        const tabId = effTab ?? (await tools.resolveTab());
        const type = String(params.type);
        const x = Number(params.x ?? 0);
        const y = Number(params.y ?? 0);
        if (type === "mouseReleased") {
          const r = await tools.click({ tab: tabId, x, y });
          return send(ok(id, r));
        }
        return send(ok(id, {}));
      }
      case "Input.dispatchKeyEvent": {
        const tabId = effTab ?? (await tools.resolveTab());
        const type = String(params.type);
        if (type === "keyUp") return send(ok(id, {}));
        const key = String(params.key ?? params.text ?? "");
        const r = await tools.press({ tab: tabId, key });
        return send(ok(id, r));
      }
      case "Input.insertText": {
        const tabId = effTab ?? (await tools.resolveTab());
        const r = await tools.evaluate({ tab: tabId, expression: `(() => { const el = document.activeElement; if (!el) return "no focus"; if (el.isContentEditable) { document.execCommand("insertText", false, ${JSON.stringify(String(params.text ?? ""))}); return "editable"; } if ("value" in el) { const s = Object.getOwnPropertyDescriptor(el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set; s.call(el, (el.value || "") + ${JSON.stringify(String(params.text ?? ""))}); el.dispatchEvent(new InputEvent("input", { bubbles: true })); return "input"; } return "not editable"; })()` });
        return send(ok(id, r));
      }
      case "Input.dispatchTouchEvent":
        return send(ok(id, {}));

      // ----- Network / Log -----
      case "Network.enable": {
        const tabId = effTab ?? (await tools.resolveTab());
        await tools.netStart({ tab: tabId });
        const pump = startPump(send, tabId, scope.connId);
        pump.netOn = true;
        return send(ok(id, {}));
      }
      case "Network.disable": {
        const tabId = effTab ?? (await tools.resolveTab());
        await tools.netStop({ tab: tabId });
        const p = pumps[`${scope.connId}:${tabId}`];
        if (p) p.netOn = false;
        return send(ok(id, {}));
      }
      case "Log.enable": {
        const tabId = effTab ?? (await tools.resolveTab());
        const pump = startPump(send, tabId, scope.connId);
        pump.consoleOn = true;
        return send(ok(id, {}));
      }

      // ----- no-op acks for things Safari cannot honestly provide -----
      case "DOM.enable":
      case "CSS.enable":
      case "Debugger.enable":
      case "Profiler.enable":
      case "Performance.enable":
      case "Page.setInterceptFileChooserDialog":
      case "Page.addScriptToEvaluateOnNewDocument":
      case "Emulation.setDeviceMetricsOverride":
      case "Emulation.setCPUThrottlingRate":
      case "Network.setExtraHTTPHeaders":
      case "Network.setCookies":
      case "Network.getCookies": {
        if (method === "Page.addScriptToEvaluateOnNewDocument") return send(ok(id, { identifier: String(Date.now()) }));
        if (method === "Network.getCookies") {
          const tabId = effTab ?? (await tools.resolveTab());
          return send(ok(id, { cookies: await tools.cookies({ tab: tabId, url: params.urls ? String((params.urls as string[])[0]) : undefined }) }));
        }
        return send(ok(id, {}));
      }

      default:
        return send(err(id, `CDP method ${method} not supported by the Safari shim`));
    }
  } catch (e) {
    return send(err(id, String(e instanceof Error ? e.message : e)));
  }
}
