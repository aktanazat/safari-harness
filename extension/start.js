// Safari Harness start script.
// Safari's manifest puts this, not content.js, in every frame of every page:
// content.js cost a page 0.9 MB of its WebContent process's memory, and
// 0.4 MB more for each embedded frame, against 0.03 MB a frame for this
// (11-11). This reports the frame in as its page loads; in a tab agents work
// in, background.js puts content.js in then, and any other tab gets it once
// an agent asks for that tab (drive in background.js). Until then this
// stands in for content.js where the page must hear before any agent comes.

(() => {
  window.__safariHarnessStart = true;
  const api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;

  // Reports the frame in as its page loads, and again when Safari puts the
  // page back from its back-forward cache with no copy of content.js in it.
  const report = () => api.runtime.sendMessage({ __safariHarnessStart: 1 }).then((r) => r, () => null).then((r) => {
    // The tab's and window's ids, by which the extension finds this tab
    // again after it reloads (adopt in background.js).
    if (r) {
      window.__safariHarnessTab = r.tab;
      window.__safariHarnessWindow = r.window;
    }
    // In a tab the harness owns, dialogs.js answers the page's dialogs from
    // now on, as content.js has it do once in (armDialogs).
    if (r?.dialogs) document.dispatchEvent(new CustomEvent("__sh_dialog_policy", { detail: JSON.stringify({ ...r.dialogs, armed: true, owned: true }) }));
    // content.js is coming, and tells dialogs.js the rest itself.
    if (r?.content) return;
    // A print the page raised as it loaded shows (dialogs.js).
    document.dispatchEvent(new Event("__sh_dialog_known"));
    // The page drops its request log and keeps its own fetch.
    if (r) document.dispatchEvent(new Event("__sh_net_off"));
  });
  report();
  addEventListener("pageshow", (e) => { if (e.persisted && !window.__safariHarnessInjected) report(); });

  // Safari gives a tab a page opens no opener, so the page says one is
  // coming (tabs a page opens, in background.js), as content.js does once
  // it is in: then a tab the user's page opens never goes to an agent
  // whose page said so in the same second.
  const announce = () => {
    if (!window.__safariHarnessInjected) api.runtime.sendMessage({ __safariHarnessPopup: 1 }).catch(() => {});
  };
  document.addEventListener("__sh_popup", announce);
  addEventListener("click", (e) => {
    const link = e.composedPath().find((el) => el instanceof Element && el.matches("a[href], area[href]"));
    if (!link || link.hasAttribute("download")) return;
    // Read once the click is done, when the page has had its say.
    setTimeout(() => {
      const target = link.getAttribute("target") ?? document.querySelector("base[target]")?.target ?? "";
      if (!e.defaultPrevented && /^https?:$/.test(new URL(link.href, location.href).protocol) && target !== "" && !["_self", "_top", "_parent"].includes(target.toLowerCase())) announce();
    });
  }, true);
})();
