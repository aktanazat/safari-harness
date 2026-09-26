// Safari Harness page-world script: runs in the page's own world at
// document_start in every frame, so it is in place before the page's
// scripts. It does nothing until content.js arms it (see "dialogs" in
// content.js): a dialog in a user's tab still shows as usual.
//
// Armed, it answers alert, confirm, prompt, and print without showing them
// (a dialog blocks the page and every harness request with it), and keeps
// beforeunload from holding a navigation. While catching downloads, it
// takes a blob or data link the page clicks, or a window it opens, instead
// of letting Safari save it. Both report to content.js through DOM events.

(() => {
  const KEY = Symbol.for("safari-harness.page");
  if (window[KEY]) return;
  const state = (window[KEY] = { armed: false, accept: false, text: null, catching: false });
  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt, print: window.print, open: window.open, click: HTMLAnchorElement.prototype.click };
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
})();
