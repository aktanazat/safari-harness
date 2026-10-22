// Inert factory. The extension calls it at document_start only for an explicitly
// enabled origin. The factory and returned transport are never permission.
// Compatibility, not native Safari WebMCP. Top-document imperative tools only.
// Sources: https://webmachinelearning.github.io/webmcp/ (2026-10-20)
// https://github.com/webmachinelearning/webmcp/pull/132 (legacy removal diff)
globalThis.__safariHarnessInstallSiteActions = function installSiteActions(options) {
  const unavailable = (reason) => Object.freeze({ status: "unavailable", reason });
  if (!options || typeof options.origin !== "string") return unavailable("disabled");
  if (window.top !== window) return unavailable("top_document_only");
  if (location.origin !== options.origin || location.origin === "null" || !isSecureContext) return unavailable("origin_not_enabled");
  if (document.readyState !== "loading") return unavailable("requires_document_start_reload");
  if ("modelContext" in document || "modelContext" in navigator) return unavailable("existing_api_untouched");

  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const origin = location.origin;
  const tools = new Map();
  const executions = new Map();
  const used = new Set();
  const MAX_TOOLS = 128;
  const MAX_SCHEMA = 32768;
  const MAX_RESULT = 65536;
  let revision = 0;
  let ended = false;
  let uncertain = false;
  const context = new EventTarget();
  let changeHandler = null;
  const change = () => {
    revision++;
    context.dispatchEvent(new Event("toolchange"));
  };
  Object.defineProperty(context, "ontoolchange", {
    get: () => changeHandler,
    set: (fn) => {
      if (changeHandler) context.removeEventListener("toolchange", changeHandler);
      changeHandler = typeof fn === "function" ? fn : null;
      if (changeHandler) context.addEventListener("toolchange", changeHandler);
    },
    enumerable: true,
  });
  const active = () => {
    if (ended || location.origin !== origin) throw new DOMException("document is no longer active", "InvalidStateError");
  };
  const json = (value, limit) => {
    const text = stringify(value);
    if (typeof text !== "string" || text.length > limit) throw new TypeError("JSON value exceeds compatibility limits");
    return parse(text);
  };
  const definition = (tool, legacy = false) => {
    if (!tool || typeof tool !== "object") throw new TypeError("tool must be an object");
    const { name, description, execute, title, annotations: hints, inputSchema: schema } = tool;
    if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new DOMException("invalid tool name", "InvalidStateError");
    if (typeof description !== "string" || !description || description.length > 4096 || typeof execute !== "function") throw new TypeError("tool requires a bounded description and execute callback");
    const inputSchema = schema === undefined ? undefined : json(schema, MAX_SCHEMA);
    if (inputSchema !== undefined && (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema))) throw new TypeError("inputSchema must be a JSON object");
    const annotations = {};
    for (const hint of ["readOnlyHint", "untrustedContentHint", "consequentialHint", "debugging"]) {
      if (typeof hints?.[hint] === "boolean") annotations[hint] = hints[hint];
    }
    return { name, title: typeof title === "string" ? title.slice(0, 256) : "", description, inputSchema, annotations, execute, legacy, detach: null };
  };
  const remove = (name) => {
    const tool = tools.get(name);
    if (!tool) return;
    tools.delete(name);
    tool.detach?.();
    change();
  };
  const insert = (tool, signal) => {
    active();
    if (tools.has(tool.name)) throw new DOMException("tool already registered", "InvalidStateError");
    if (tools.size >= MAX_TOOLS) throw new DOMException("compatibility tool limit reached", "QuotaExceededError");
    signal?.throwIfAborted();
    if (signal) {
      const abort = () => { if (tools.get(tool.name) === tool) remove(tool.name); };
      signal.addEventListener("abort", abort, { once: true });
      tool.detach = () => signal.removeEventListener("abort", abort);
    }
    tools.set(tool.name, tool);
    change();
  };
  const registerTool = async (tool, registration = {}) => {
    // Cross-frame exposure is deliberately unsupported, not silently emulated.
    if (registration.exposedTo?.length) throw new DOMException("cross-frame exposure is unsupported", "NotSupportedError");
    insert(definition(tool), registration.signal);
  };
  const registered = (tool) => ({ name: tool.name, title: tool.title, description: tool.description, ...(tool.inputSchema === undefined ? {} : { inputSchema: json(tool.inputSchema, MAX_SCHEMA) }), annotations: { ...tool.annotations }, origin, window });
  const getTools = async (query = {}) => {
    active();
    if (query.fromOrigins?.some((value) => value !== origin)) throw new DOMException("cross-frame discovery is unsupported", "NotSupportedError");
    return [...tools.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(registered);
  };
  const executeSiteTool = async (tool, input = {}, execution = {}) => {
    active();
    if (!tool || tool.window !== window || tool.origin !== origin) throw new DOMException("only this document is supported", "NotSupportedError");
    const entry = tools.get(tool.name);
    if (!entry) throw new DOMException("tool not found", "NotFoundError");
    const callId = crypto.randomUUID();
    execution.signal?.throwIfAborted();
    const abort = () => cancel(callId);
    execution.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await transport.invoke({ revision: String(revision), name: entry.name, input, callId });
      if (result.status !== "completed") throw new DOMException("tool did not confirm completion", result.status === "unknown" ? "AbortError" : "OperationError");
      return stringify(result.result);
    } finally {
      execution.signal?.removeEventListener("abort", abort);
    }
  };
  Object.assign(context, { registerTool, getTools, executeTool: executeSiteTool });

  // The older published navigator API is separate, synchronous, and opt-in.
  const legacy = options.legacyNavigator === true ? Object.freeze({
    registerTool(tool) { insert(definition(tool, true)); },
    unregisterTool(name) { active(); remove(String(name)); },
    provideContext(value = {}) {
      active();
      if (!Array.isArray(value.tools ?? [])) throw new TypeError("tools must be an array");
      const next = (value.tools ?? []).map((tool) => definition(tool, true));
      if (next.length > MAX_TOOLS || new Set(next.map((tool) => tool.name)).size !== next.length) throw new DOMException("duplicate or excessive tools", "InvalidStateError");
      for (const tool of tools.values()) tool.detach?.();
      tools.clear();
      for (const tool of next) tools.set(tool.name, tool);
      change();
    },
    clearContext() {
      active();
      if (!tools.size) return;
      for (const tool of tools.values()) tool.detach?.();
      tools.clear();
      change();
    },
  }) : null;
  Object.defineProperty(document, "modelContext", { value: context, configurable: true });
  if (legacy) Object.defineProperty(navigator, "modelContext", { value: legacy, configurable: true });

  const refused = (reason) => ({ status: "refused", reason, retry: false });
  const cancel = (callId) => {
    const execution = executions.get(callId);
    if (!execution) return { status: "not_pending" };
    execution.finish({ status: "unknown", reason: "cancelled_after_dispatch", retry: false });
    execution.controller.abort();
    return { status: "unknown", reason: "cancelled_after_dispatch", retry: false };
  };
  const dispose = () => {
    if (ended) return;
    ended = true;
    for (const callId of [...executions.keys()]) cancel(callId);
    for (const tool of tools.values()) tool.detach?.();
    tools.clear();
    revision++;
    window.removeEventListener("pagehide", dispose);
    if (document.modelContext === context) delete document.modelContext;
    if (legacy && navigator.modelContext === legacy) delete navigator.modelContext;
  };
  window.addEventListener("pagehide", dispose, { once: true });
  const transport = Object.freeze({
    status: "available",
    catalog() {
      active();
      return { status: "available", origin, frame: "top", revision: String(revision), tools: [...tools.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((tool) => ({ name: tool.name, title: tool.title, description: tool.description.slice(0, 160), annotations: { ...tool.annotations } })) };
    },
    schema(request) {
      active();
      if (String(revision) !== request.revision) return refused("stale_catalog");
      const tool = tools.get(request.name);
      if (!tool) return refused("tool_removed");
      return { status: "available", revision: String(revision), name: tool.name, inputSchema: tool.inputSchema === undefined ? {} : json(tool.inputSchema, MAX_SCHEMA) };
    },
    invoke(request) {
      if (ended || location.origin !== origin) return Promise.resolve(refused("document_ended"));
      if (!request || request.revision !== String(revision)) return Promise.resolve(refused("stale_catalog"));
      if (uncertain) return Promise.resolve(refused("previous_action_outcome_unknown_reload_required"));
      const tool = tools.get(request.name);
      if (!tool) return Promise.resolve(refused("tool_removed"));
      if (typeof request.callId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(request.callId) || used.has(request.callId)) return Promise.resolve(refused("invalid_or_repeated_call"));
      if (used.size >= 256 || executions.size) return Promise.resolve(refused("execution_limit"));
      let input;
      try {
        input = json(request.input, MAX_SCHEMA);
        if (!input || typeof input !== "object" || Array.isArray(input)) return Promise.resolve(refused("input_must_be_object"));
      } catch { return Promise.resolve(refused("input_not_json")); }
      // JSON conversion can run site code; recheck at the actual call boundary.
      if (ended || request.revision !== String(revision) || tools.get(request.name) !== tool) return Promise.resolve(refused("stale_catalog"));
      const timeoutMs = Number.isFinite(request.timeoutMs) ? Math.max(1, Math.min(60000, request.timeoutMs)) : 15000;
      used.add(request.callId);
      const { promise, resolve } = Promise.withResolvers();
      const controller = new AbortController();
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (value.status === "unknown") uncertain = true;
        clearTimeout(timer);
        executions.delete(request.callId);
        resolve(value);
      };
      executions.set(request.callId, { controller, finish });
      timer = setTimeout(() => {
        finish({ status: "unknown", reason: "timeout_after_dispatch", retry: false });
        controller.abort();
      }, timeoutMs);
      let result;
      try {
        const execution = { signal: controller.signal };
        if (tool.legacy) execution.requestUserInteraction = async () => {
          throw new DOMException("site-provided approval UI is unsupported; use the harness handoff", "NotSupportedError");
        };
        result = tool.execute(input, execution);
      } catch {
        finish({ status: "unknown", reason: "tool_rejected_after_dispatch", retry: false });
        return promise;
      }
      Promise.resolve(result).then((value) => {
        if (settled) return;
        try { finish({ status: "completed", result: json(value, MAX_RESULT), retry: false }); }
        catch { finish({ status: "unknown", reason: "unserializable_or_large_result_after_dispatch", retry: false }); }
      }, () => finish({ status: "unknown", reason: "tool_rejected_after_dispatch", retry: false }));
      return promise;
    },
    cancel,
    dispose,
  });
  return transport;
};
