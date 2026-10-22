(() => {
  if (window.__safariHarnessSiteActions) return;
  const actions = window.__safariHarnessInstallSiteActions({ origin: location.origin, legacyNavigator: true });
  window.__safariHarnessSiteActions = actions;
  document.addEventListener("__sh_site_action_request", (event) => {
    if (typeof event.detail !== "string" || event.detail.length > 131072) return;
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (!request || typeof request.id !== "string" || !/^[a-f0-9-]{36}$/.test(request.id) || !["catalog", "schema", "invoke", "cancel"].includes(request.method) || !Array.isArray(request.args)) return;
    const reply = (value) => {
      let text;
      try { text = JSON.stringify(value); } catch { text = JSON.stringify({ status: "unknown", reason: "the site returned a value that cannot be encoded", retry: false }); }
      if (text.length > 262144) text = JSON.stringify({ status: "unknown", reason: "the site returned too much data", retry: false });
      document.dispatchEvent(new CustomEvent(`__sh_site_action_reply_${request.id}`, { detail: text }));
    };
    Promise.resolve().then(() => actions[request.method](...request.args)).then(reply, (error) => reply({ status: request.method === "invoke" ? "unknown" : "refused", reason: String(error?.message ?? error), retry: false }));
  });
})();
