import { createHash } from "node:crypto";

const STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: oklch(98.5% 0.004 90);
  --text: oklch(23% 0.01 90);
  --muted: oklch(45% 0.012 90);
  --line: oklch(89% 0.008 90);
  --hover: oklch(95% 0.006 90);
  --focus: oklch(45% 0.11 240);
  --on: oklch(45% 0.1 150);
  --error: oklch(50% 0.17 27);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(19% 0.006 90);
    --text: oklch(94% 0.006 90);
    --muted: oklch(73% 0.01 90);
    --line: oklch(31% 0.008 90);
    --hover: oklch(25% 0.008 90);
    --focus: oklch(79% 0.09 240);
    --on: oklch(79% 0.11 150);
    --error: oklch(73% 0.15 27);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { max-width: 58rem; padding: 2rem clamp(1rem, 4vw, 2.5rem) 4rem; }
h1, h2, h3 { overflow-wrap: anywhere; text-wrap: balance; }
h1 { margin: 0; font-size: 1.7rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.015em; }
h2 { margin: 0; font-size: 1.1rem; font-weight: 650; }
h3 { margin: 0 0 0.35rem; font-size: 0.95rem; font-weight: 600; }
p { margin: 0; text-wrap: pretty; }
a { color: var(--focus); text-underline-offset: 0.15em; overflow-wrap: anywhere; }
nav { margin-bottom: 1rem; }
nav a { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; }
button, input, select, textarea, summary, a { -webkit-tap-highlight-color: transparent; }
button, input, select, textarea { max-width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 6px; color: var(--text); background: var(--bg); font: inherit; }
button, input:not([type="checkbox"]), select { min-height: 44px; }
button { padding: 0.5rem 0.9rem; font-size: 0.9rem; font-weight: 550; cursor: pointer; overflow-wrap: anywhere; transition: background-color 0.15s ease-out, border-color 0.15s ease-out, color 0.15s ease-out; }
button:hover { background: var(--hover); border-color: var(--muted); }
button:active { background: var(--line); }
button.primary { background: var(--text); border-color: var(--text); color: var(--bg); }
button.primary:hover { background: var(--muted); border-color: var(--muted); }
button.danger { color: var(--error); }
button.danger:hover { border-color: var(--error); }
button:disabled, input:disabled, select:disabled, textarea:disabled { opacity: 0.55; cursor: default; }
button:focus-visible, a:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, .body-text:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
input:not([type="checkbox"]), select, textarea { width: 100%; padding: 0.55rem 0.7rem; }
textarea { display: block; min-height: 6rem; resize: vertical; }
input[type="checkbox"] { flex: 0 0 auto; width: 20px; height: 20px; margin: 0; accent-color: var(--focus); }
label { display: block; font-weight: 550; }
.field { display: grid; gap: 0.35rem; min-width: 0; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.bar, .actions, .section-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; }
.bar { margin-top: 1.25rem; }
.status { font-size: 1.1rem; font-weight: 650; }
.status.on { color: var(--on); }
.muted, .meta, .help { color: var(--muted); }
.meta, .help { font-size: 0.85rem; overflow-wrap: anywhere; }
.meta { font-variant-numeric: tabular-nums; }
.error { color: var(--error); overflow-wrap: anywhere; }
.message { min-height: 1.5em; margin-top: 0.5rem; }
.problem { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; margin-top: 0.5rem; }
.settings { margin-top: 1.25rem; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
summary { display: flex; align-items: center; gap: 0.6rem; min-height: 44px; padding: 0.5rem 0; font-weight: 550; cursor: pointer; list-style: none; overflow-wrap: anywhere; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "+"; flex: 0 0 1rem; color: var(--muted); font-variant-numeric: tabular-nums; }
details[open] > summary::before { content: "-"; }
.settings form { padding: 0.25rem 0 1.25rem; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 1.25rem; }
.setting-bottom { display: grid; grid-template-columns: minmax(8rem, 0.5fr) minmax(0, 1fr); align-items: start; gap: 1rem 1.25rem; margin-top: 1rem; }
.check { display: flex; align-items: center; gap: 0.65rem; min-height: 44px; cursor: pointer; }
.settings .actions { margin-top: 1rem; }
.saved { margin-top: 2rem; }
.section-head { justify-content: space-between; }
.filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(8rem, 0.6fr) auto; gap: 0.75rem; align-items: end; margin: 1rem 0; }
.results { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.25rem 1rem; margin-bottom: 0.6rem; }
.pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; margin-top: 1rem; }
ul { margin: 0; padding: 0; list-style: none; }
.rows > li { min-width: 0; border-top: 1px solid var(--line); }
.rows > li:last-child { border-bottom: 1px solid var(--line); }
.row-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 0.4rem; padding: 0.7rem 0; }
.open-page { width: 100%; padding: 0.15rem 0; border-color: transparent; border-radius: 3px; text-align: left; background: transparent; }
.open-page:hover { border-color: transparent; background: var(--hover); }
.open-page[aria-expanded="true"] { color: var(--focus); }
.row-title { display: block; font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
.row-meta { display: block; margin-top: 0.2rem; color: var(--muted); font-size: 0.85rem; font-weight: 400; overflow-wrap: anywhere; }
.row-state { align-self: center; max-width: 11rem; font-size: 0.8rem; text-align: right; color: var(--muted); overflow-wrap: anywhere; }
.preview { margin: 0.1rem 0 0.85rem; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.detail { padding: 0.1rem 0 1.25rem; }
.detail h3 { margin-top: 1.2rem; }
.detail .source { display: inline-flex; align-items: center; min-height: 44px; max-width: 100%; }
.detail time { display: block; }
.detail .copy { white-space: pre-wrap; overflow-wrap: anywhere; }
.detail .actions { margin-top: 1rem; }
.detail-editor { display: grid; gap: 0.9rem; margin-top: 1rem; }
.detail-editor fieldset { display: grid; gap: 0.9rem; }
.detail-editor textarea { min-height: 8rem; }
.body { margin-top: 1rem; }
.body-text { max-height: 32rem; overflow-y: auto; overscroll-behavior: contain; margin: 0; padding: 0.5rem 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.empty { padding: 1.25rem 0; color: var(--muted); }
.loading { min-height: 9rem; padding: 1.1rem 0; }
.bone { display: block; height: 1rem; width: 65%; margin-bottom: 0.65rem; background: var(--line); border-radius: 2px; }
.bone.short { width: 35%; height: 0.8rem; }
.loading p { margin-top: 1rem; color: var(--muted); font-size: 0.85rem; }
@media (max-width: 560px) {
  main { padding-top: 1rem; }
  .settings-grid, .setting-bottom { grid-template-columns: minmax(0, 1fr); }
  .filters { grid-template-columns: minmax(0, 1fr) auto; }
  .filters .search-field { grid-column: 1 / -1; }
  .row-head { grid-template-columns: minmax(0, 1fr); }
  .row-state { max-width: none; text-align: left; }
  .section-head { align-items: start; }
}
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;

const SCRIPT = String.raw`
"use strict";
{
  const byId = (id) => document.getElementById(id);
  const initial = new URL(location.href);
  const rows = new Map();
  const pageSize = 50;
  const requestedOffset = Number(initial.searchParams.get("offset") || 0);
  let offset = Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset / pageSize) * pageSize : 0;
  let status = null;
  let snapshot = null;
  let selectedId = initial.searchParams.get("id") || "";
  let selectedPage = null;
  let configDirty = false;
  let editing = false;
  let editDirty = false;
  let writing = false;
  let readFailed = false;
  let requestNumber = 0;
  let controller = null;
  let timer = 0;
  let rowNumber = 0;
  let query = initial.searchParams.get("query") || "";
  let site = initial.searchParams.get("site") || "";
  byId("query").value = query;
  byId("site").value = site;

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function showError(text) {
    setText(byId("request-error"), text);
    byId("request-problem").hidden = !text;
  }

  function updateLocation() {
    const url = new URL(location.href);
    url.search = "";
    if (query) url.searchParams.set("query", query);
    if (site) url.searchParams.set("site", site);
    if (selectedId) url.searchParams.set("id", selectedId);
    if (offset) url.searchParams.set("offset", String(offset));
    history.replaceState(null, "", url);
  }

  function hosts(text) {
    const result = [];
    for (const entry of text.split(/[\n,]+/)) {
      const host = entry.trim().toLowerCase();
      if (!host) continue;
      let url;
      try { url = new URL("https://" + host); } catch { throw new Error("use exact hosts, such as example.com."); }
      if (/[\/\\@?#*\s]/.test(host) || host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) || url.port || url.username || url.password || url.pathname !== "/" || !url.hostname) {
        throw new Error("use exact hosts without addresses, ports or wildcards.");
      }
      const normalized = url.hostname.replace(/\.$/, "");
      if (!result.includes(normalized)) result.push(normalized);
    }
    if (result.length > 100) throw new Error("use no more than 100 hosts per list.");
    return result;
  }

  function updateControls() {
    byId("settings-fields").disabled = !status || writing;
    byId("capture").disabled = !status || writing || !status.config.enabled && !status.config.sites.length;
    byId("save-settings").disabled = !status || writing || !configDirty;
    byId("reset-settings").disabled = !status || writing || !configDirty;
    byId("forget-all").disabled = !status || writing || status.total === 0;
    byId("previous").disabled = writing || offset === 0;
    byId("next").disabled = writing || !snapshot || offset + pageSize >= snapshot.total;
    for (const row of rows.values()) {
      row.open.disabled = writing;
      row.forgetPage.disabled = writing;
      row.forgetSite.disabled = writing;
      row.edit.disabled = writing || !selectedPage;
      row.editFields.disabled = writing;
      row.save.disabled = writing || !editDirty;
      row.cancel.disabled = writing;
    }
  }

  function fillSettings() {
    if (!status || configDirty) return;
    const config = status.config;
    const sites = byId("sites");
    const excluded = byId("excluded-sites");
    const retention = byId("retention");
    if (sites.value !== config.sites.join("\n")) sites.value = config.sites.join("\n");
    if (excluded.value !== config.excludedSites.join("\n")) excluded.value = config.excludedSites.join("\n");
    if (retention.value !== String(config.retentionDays)) retention.value = String(config.retentionDays);
    byId("summarize").checked = config.summarize;
  }

  function applyStatus(next) {
    const first = status === null;
    status = next;
    const config = status.config;
    setText(byId("capture-state"), config.enabled ? "capture is on" : "capture is off");
    byId("capture-state").classList.toggle("on", config.enabled);
    setText(byId("capture"), config.enabled ? "pause capture" : "start capture");
    setText(byId("capture-policy"), config.sites.length ? "" : "no hosts selected");
    byId("capture-policy").hidden = !!config.sites.length;
    setText(byId("pending"), status.pending ? status.pending + (status.pending === 1 ? " summary pending" : " summaries pending") : "");
    byId("pending").hidden = !status.pending;
    setText(byId("store-error"), status.error || "");
    byId("store-error").hidden = !status.error;
    if (first && !config.sites.length) byId("settings").open = true;
    fillSettings();
    updateControls();
  }

  function safeSource(anchor, raw) {
    let url;
    try { url = new URL(raw); } catch { url = null; }
    setText(anchor, raw);
    if (url && (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
      anchor.href = url.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.removeAttribute("aria-disabled");
    } else {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      anchor.setAttribute("aria-disabled", "true");
    }
  }

  function pageTime(page) {
    return new Date(page.visitedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function discardEdit() {
    return !editing || !editDirty || confirm("discard the unsaved correction?");
  }

  function setSelection(id) {
    if (!discardEdit()) return;
    selectedId = selectedId === id ? "" : id;
    selectedPage = null;
    editing = false;
    editDirty = false;
    updateLocation();
    for (const row of rows.values()) updateRowSelection(row);
    updateControls();
    load(true);
  }

  function editPage(row) {
    if (!selectedPage || selectedPage.id !== row.page.id) return;
    row.summaryInput.value = selectedPage.summary;
    row.noteInput.value = selectedPage.note;
    row.originalSummary = selectedPage.summary;
    row.originalNote = selectedPage.note;
    editing = true;
    editDirty = false;
    setText(row.editMessage, "");
    updateRowSelection(row);
    updateControls();
    row.summaryInput.focus();
  }

  function updateRowSelection(row) {
    const selected = row.page.id === selectedId;
    row.open.setAttribute("aria-expanded", String(selected));
    row.detail.hidden = !selected;
    const ready = selected && selectedPage && selectedPage.id === row.page.id;
    row.detailLoading.hidden = !!ready;
    row.detailContent.hidden = !ready;
    row.reading.hidden = editing && selected;
    row.editor.hidden = !editing || !selected;
    row.edit.hidden = editing && selected;
  }

  function newRow(page) {
    const li = make("li");
    const head = make("div", "row-head");
    const open = make("button", "open-page");
    open.type = "button";
    const title = make("span", "row-title");
    const meta = make("span", "row-meta");
    open.append(title, meta);
    const state = make("span", "row-state");
    head.append(open, state);
    const preview = make("p", "preview");
    const detail = make("section", "detail");
    detail.id = "memory-detail-" + ++rowNumber;
    title.id = detail.id + "-title";
    detail.setAttribute("aria-labelledby", title.id);
    detail.hidden = true;
    open.setAttribute("aria-controls", detail.id);
    const detailLoading = make("p", "muted", "loading page…");
    detailLoading.setAttribute("role", "status");
    const detailContent = make("div");
    detailContent.hidden = true;
    const source = make("a", "source");
    const time = make("time", "meta");
    const pageError = make("p", "error message");
    const reading = make("div");
    const summary = make("p", "copy");
    const note = make("p", "copy");
    const summaryMeta = make("p", "meta");
    const noteMeta = make("p", "meta");
    reading.append(make("h3", "", "summary"), summary, summaryMeta, make("h3", "", "note"), note, noteMeta);
    const editor = make("form", "detail-editor");
    editor.hidden = true;
    const editFields = make("fieldset");
    const summaryField = make("div", "field");
    const summaryLabel = make("label", "", "corrected summary");
    const summaryInput = make("textarea");
    summaryInput.id = detail.id + "-summary";
    summaryLabel.htmlFor = summaryInput.id;
    summaryInput.rows = 6;
    summaryInput.maxLength = 1600;
    summaryInput.autocomplete = "off";
    summaryField.append(summaryLabel, summaryInput);
    const noteField = make("div", "field");
    const noteLabel = make("label", "", "note");
    const noteInput = make("textarea");
    noteInput.id = detail.id + "-note";
    noteLabel.htmlFor = noteInput.id;
    noteInput.rows = 3;
    noteInput.maxLength = 4000;
    noteInput.autocomplete = "off";
    noteField.append(noteLabel, noteInput);
    const editActions = make("div", "actions");
    const save = make("button", "primary", "save correction");
    save.type = "submit";
    const cancel = make("button", "", "cancel");
    cancel.type = "button";
    editActions.append(save, cancel);
    const editMessage = make("p", "error message");
    editMessage.id = detail.id + "-error";
    editMessage.setAttribute("role", "alert");
    summaryInput.setAttribute("aria-describedby", editMessage.id);
    noteInput.setAttribute("aria-describedby", editMessage.id);
    editFields.append(summaryField, noteField, editActions);
    editor.append(editFields, editMessage);
    const body = make("details", "body");
    const bodyText = make("pre", "body-text");
    bodyText.tabIndex = 0;
    bodyText.setAttribute("aria-label", "saved page text");
    body.append(make("summary", "", "saved page text"), bodyText);
    const actions = make("div", "actions");
    const edit = make("button", "", "edit correction");
    const forgetPage = make("button", "danger", "forget page");
    const forgetSite = make("button", "danger", "forget site");
    for (const button of [edit, forgetPage, forgetSite]) button.type = "button";
    actions.append(edit, forgetPage, forgetSite);
    detailContent.append(source, time, pageError, reading, editor, body, actions);
    detail.append(detailLoading, detailContent);
    li.append(head, preview, detail);
    const row = { li, open, title, meta, state, preview, detail, detailLoading, detailContent, source, time, pageError, reading, summary, summaryMeta, note, noteMeta, editor, editFields, summaryInput, noteInput, originalSummary: "", originalNote: "", save, cancel, editMessage, bodyText, edit, forgetPage, forgetSite, page };
    open.addEventListener("click", () => setSelection(row.page.id));
    edit.addEventListener("click", () => editPage(row));
    editor.addEventListener("input", () => {
      editDirty = summaryInput.value !== row.originalSummary || noteInput.value !== row.originalNote;
      setText(editMessage, "");
      updateControls();
    });
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!editDirty || writing) return;
      mutate({ action: "edit", id: row.page.id, summary: summaryInput.value, note: noteInput.value }, () => {
        editing = false;
        editDirty = false;
        updateRowSelection(row);
        requestAnimationFrame(() => row.edit.focus());
      }, editMessage, "correction saved");
    });
    cancel.addEventListener("click", () => {
      if (!discardEdit()) return;
      editing = false;
      editDirty = false;
      updateRowSelection(row);
      updateControls();
      edit.focus();
    });
    forgetPage.addEventListener("click", () => {
      if (!confirm("forget this saved page, its summary and note from this mac? this cannot be undone.")) return;
      mutate({ action: "forget", id: row.page.id }, clearSelection, byId("request-error"), "page forgotten");
    });
    forgetSite.addEventListener("click", () => {
      if (!confirm("forget all saved pages, summaries and notes from " + row.page.site + " on this mac? this cannot be undone.")) return;
      mutate({ action: "forget", site: row.page.site }, clearSelection, byId("request-error"), "site forgotten");
    });
    return row;
  }

  function clearSelection(moveFocus = true) {
    selectedId = "";
    selectedPage = null;
    editing = false;
    editDirty = false;
    for (const row of rows.values()) updateRowSelection(row);
    updateControls();
    updateLocation();
    if (moveFocus) byId("refresh").focus();
  }

  function applyDetail(page) {
    selectedPage = page;
    const row = rows.get(page.id);
    if (!row || page.id !== selectedId) return;
    safeSource(row.source, page.url);
    row.time.dateTime = new Date(page.visitedAt).toISOString();
    setText(row.time, "viewed " + pageTime(page));
    setText(row.pageError, page.error || (page.state === "failed" ? "summary failed; saved page text is available." : ""));
    row.pageError.hidden = !row.pageError.textContent;
    setText(row.summary, page.summary || (page.state === "pending" ? "summary pending" : "no summary"));
    setText(row.note, page.note || "no note");
    const corrected = page.summaryEditedAt ? "corrected " + new Date(page.summaryEditedAt).toLocaleString() : "corrected summary";
    setText(row.summaryMeta, page.summarySource === "user" ? corrected : page.summarySource === "provider" ? "ai-provider summary" : "");
    row.summaryMeta.hidden = !row.summaryMeta.textContent;
    setText(row.noteMeta, page.noteEditedAt ? "edited " + new Date(page.noteEditedAt).toLocaleString() : "");
    row.noteMeta.hidden = !row.noteMeta.textContent;
    setText(row.bodyText, page.body);
    updateRowSelection(row);
    updateControls();
  }

  function renderList() {
    if (!snapshot) return;
    const list = byId("pages");
    const pages = snapshot.pages.slice();
    if (selectedPage && !pages.some((page) => page.id === selectedId)) pages.unshift(selectedPage);
    const keys = pages.map((page) => page.id);
    const structural = keys.length !== list.children.length || keys.some((id, index) => !rows.has(id) || rows.get(id).li !== list.children[index]);
    if (structural && list.contains(document.activeElement)) return;
    const keep = new Set(keys);
    for (const [id, row] of rows) {
      if (!keep.has(id)) {
        row.li.remove();
        rows.delete(id);
      }
    }
    const next = pages.map((page) => {
      let row = rows.get(page.id);
      if (!row) {
        row = newRow(page);
        rows.set(page.id, row);
      }
      row.page = page;
      setText(row.title, page.title || page.url);
      setText(row.meta, page.site + " · " + pageTime(page));
      setText(row.state, page.state === "pending" ? "summary pending" : page.state === "failed" ? "summary failed" : "");
      row.state.classList.toggle("error", page.state === "failed");
      row.state.hidden = !row.state.textContent;
      const preview = page.summary || page.excerpt || "";
      setText(row.preview, preview);
      row.preview.hidden = !preview || page.id === selectedId;
      updateRowSelection(row);
      return row.li;
    });
    if (structural) list.replaceChildren(...next);
    byId("loading").hidden = true;
    const empty = pages.length === 0;
    byId("empty").hidden = !empty;
    setText(byId("empty"), query || site ? "no matching pages" : "no saved pages");
    setText(byId("result-count"), snapshot.total + (snapshot.total === 1 ? " page" : " pages") + (query || site ? " matched" : " saved"));
    byId("pagination").hidden = snapshot.total <= pageSize;
    setText(byId("page-range"), snapshot.pages.length ? (offset + 1) + "–" + (offset + snapshot.pages.length) + " of " + snapshot.total : "0 pages");
    if (selectedPage) applyDetail(selectedPage);
    updateControls();
  }

  async function envelope(response) {
    let out;
    try { out = await response.json(); } catch { throw new Error("memory returned an unreadable response. reload this page."); }
    if (!response.ok) throw new Error(out && typeof out.error === "string" ? out.error : "memory refused the request. try again.");
    if (!out || !out.status || !out.status.config || !Array.isArray(out.pages) || typeof out.total !== "number") {
      throw new Error("memory returned an unreadable response. reload this page.");
    }
    return out;
  }

  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState === "visible") timer = setTimeout(() => load(false), 5000);
  }

  async function load(force) {
    clearTimeout(timer);
    if (writing || !force && document.visibilityState !== "visible") return;
    if (controller) controller.abort();
    controller = new AbortController();
    const number = ++requestNumber;
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (site) params.set("site", site);
    if (selectedId) params.set("id", selectedId);
    params.set("limit", String(pageSize));
    params.set("offset", String(offset));
    byId("saved").setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/memory/api?" + params, { cache: "no-store", mode: "same-origin", credentials: "same-origin", signal: controller.signal });
      const out = await envelope(response);
      if (number !== requestNumber) return;
      applyStatus(out.status);
      if (offset > 0 && offset >= out.total) {
        offset = out.total ? Math.floor((out.total - 1) / pageSize) * pageSize : 0;
        updateLocation();
        load(true);
        return;
      }
      snapshot = out;
      if (out.page && out.page.id === selectedId) selectedPage = out.page;
      else if (selectedId) {
        selectedPage = null;
        if (!out.pages.some((page) => page.id === selectedId)) {
          clearSelection();
          setText(byId("operation"), "that page is no longer saved");
        }
      }
      renderList();
      if (out.page && out.page.id === selectedId) applyDetail(out.page);
      if (selectedId && !out.page && rows.has(selectedId)) setText(rows.get(selectedId).detailLoading, "page details unavailable. refresh to try again.");
      const updated = byId("updated");
      const now = new Date();
      updated.dateTime = now.toISOString();
      setText(updated, "updated " + now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      if (force || readFailed) showError("");
      readFailed = false;
    } catch (error) {
      if (number !== requestNumber || error.name === "AbortError") return;
      readFailed = true;
      showError(error instanceof Error && error.message !== "Load failed" && error.message !== "Failed to fetch" ? error.message : "memory could not be reached. try again.");
      if (!snapshot) {
        byId("loading").hidden = true;
        byId("empty").hidden = false;
        setText(byId("empty"), "saved pages could not be loaded");
      }
    } finally {
      if (number === requestNumber) {
        byId("saved").setAttribute("aria-busy", "false");
        schedule();
      }
    }
  }

  async function mutate(change, after, errorTarget, success) {
    if (writing) return;
    writing = true;
    clearTimeout(timer);
    ++requestNumber;
    if (controller) controller.abort();
    readFailed = false;
    if (errorTarget === byId("request-error")) showError("");
    else setText(errorTarget, "");
    byId("saved").setAttribute("aria-busy", "false");
    setText(byId("operation"), "saving…");
    updateControls();
    let saved = false;
    try {
      const response = await fetch("/memory/api", {
        method: "POST",
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ token: document.body.dataset.token }, change)),
      });
      const out = await envelope(response);
      if (after) after();
      applyStatus(out.status);
      if (out.page && out.page.id === selectedId) applyDetail(out.page);
      setText(byId("operation"), success);
      saved = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "the change could not be confirmed. refresh before trying again.";
      if (errorTarget === byId("request-error")) showError(message);
      else setText(errorTarget, message);
      setText(byId("operation"), "change not confirmed");
    } finally {
      writing = false;
      updateControls();
      if (saved) load(true);
      else schedule();
    }
  }

  byId("capture").addEventListener("click", () => {
    if (!status) return;
    const enabled = !status.config.enabled;
    mutate({ action: "configure", config: { enabled } }, null, byId("request-error"), enabled ? "capture started" : "capture paused");
  });
  byId("settings-form").addEventListener("input", () => {
    configDirty = true;
    setText(byId("settings-error"), "");
    updateControls();
  });
  byId("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!configDirty || writing) return;
    let config;
    try {
      config = { sites: hosts(byId("sites").value), excludedSites: hosts(byId("excluded-sites").value), retentionDays: Number(byId("retention").value), summarize: byId("summarize").checked };
    } catch (error) {
      setText(byId("settings-error"), error.message);
      return;
    }
    const removals = status.config.sites.filter((host) => !config.sites.includes(host));
    const exclusions = config.excludedSites.filter((host) => !status.config.excludedSites.includes(host));
    const effects = [];
    if (config.retentionDays < status.config.retentionDays) effects.push("forget pages older than " + config.retentionDays + " days");
    if (removals.length || exclusions.length) effects.push("forget saved pages from " + [...new Set([...removals, ...exclusions])].join(", "));
    if (effects.length && !confirm("save settings and " + effects.join("; ") + "? summaries and notes are removed too. this cannot be undone.")) return;
    mutate({ action: "configure", config }, () => { configDirty = false; }, byId("settings-error"), "settings saved");
  });
  byId("reset-settings").addEventListener("click", () => {
    configDirty = false;
    fillSettings();
    setText(byId("settings-error"), "");
    updateControls();
  });
  byId("filters").addEventListener("submit", (event) => {
    event.preventDefault();
    if (writing) return;
    let nextSite;
    try {
      const parsed = hosts(byId("site").value);
      if (parsed.length > 1) throw new Error("filter by one exact host.");
      nextSite = parsed[0] || "";
    } catch (error) {
      setText(byId("filter-error"), error.message);
      return;
    }
    if (!discardEdit()) return;
    query = byId("query").value.trim();
    site = nextSite;
    offset = 0;
    byId("site").value = site;
    clearSelection(false);
    setText(byId("filter-error"), "");
    load(true);
  });
  byId("forget-all").addEventListener("click", () => {
    if (!confirm("forget all saved pages, summaries and notes from this mac? this cannot be undone.")) return;
    mutate({ action: "forget", all: true }, clearSelection, byId("request-error"), "all saved pages forgotten");
  });
  byId("refresh").addEventListener("click", () => load(true));
  byId("retry").addEventListener("click", () => load(true));
  for (const [id, direction] of [["previous", -1], ["next", 1]]) {
    byId(id).addEventListener("click", () => {
      if (writing || !snapshot || !discardEdit()) return;
      const nextOffset = offset + direction * pageSize;
      if (nextOffset < 0 || nextOffset >= snapshot.total) return;
      offset = nextOffset;
      clearSelection(false);
      load(true);
    });
  }
  byId("pages").addEventListener("focusout", () => {
    setTimeout(() => {
      if (!byId("pages").contains(document.activeElement)) renderList();
    }, 0);
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (document.visibilityState === "visible") load(false);
    else if (controller) controller.abort();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!configDirty && !editDirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  load(true);
}
`;

const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; script-src ${hash(SCRIPT)}; style-src ${hash(STYLE)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

export function browserMemoryPage(token: string): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>browser memory</title>
<style>${STYLE}</style>
</head>
<body data-token="${token.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)}">
<main>
<nav aria-label="safari harness"><a href="/agents">agents in safari</a></nav>
<header><h1>browser memory</h1></header>
<div class="bar">
<p id="capture-state" class="status" role="status">loading memory…</p>
<button id="capture" type="button" class="primary" disabled>start capture</button>
<span id="capture-policy" class="meta" hidden></span>
<span id="pending" class="meta" role="status" hidden></span>
</div>
<p id="store-error" class="error message" role="alert" hidden></p>
<p id="operation" class="message muted" role="status"></p>
<div id="request-problem" class="problem" hidden>
<p id="request-error" class="error" role="alert"></p>
<button id="retry" type="button">retry</button>
</div>
<details id="settings" class="settings">
<summary>capture settings</summary>
<form id="settings-form" autocomplete="off">
<fieldset id="settings-fields" disabled>
<div class="settings-grid">
<div class="field"><label for="sites">sites to remember · one per line</label><textarea id="sites" rows="4" placeholder="example.com" spellcheck="false" autocapitalize="none" aria-describedby="host-policy settings-error"></textarea></div>
<div class="field"><label for="excluded-sites">sites to exclude · one per line</label><textarea id="excluded-sites" rows="4" placeholder="example.com" spellcheck="false" autocapitalize="none" aria-describedby="host-policy settings-error"></textarea></div>
</div>
<p id="host-policy" class="help message">example.com does not include mail.example.com. removing or excluding a site erases its saved pages. pause capture to keep them. forms and filled editors are skipped.</p>
<div class="setting-bottom">
<div class="field"><label for="retention">keep pages for</label><select id="retention"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div>
<div><label class="check" for="summarize"><input id="summarize" type="checkbox" aria-describedby="provider-permission">allow ai-provider summaries</label><p id="provider-permission" class="help">this sends selected page text to your ai provider for summaries. saved pages and search stay on this mac. relevant saved text may also be included in ai tasks.</p></div>
</div>
<div class="actions"><button id="save-settings" class="primary" type="submit" disabled>save settings</button><button id="reset-settings" type="button" disabled>discard changes</button></div>
</fieldset>
<p id="settings-error" class="error message" role="alert"></p>
</form>
</details>
<section id="saved" class="saved" aria-labelledby="saved-heading" aria-busy="true">
<div class="section-head"><h2 id="saved-heading">saved pages</h2><div class="actions"><button id="refresh" type="button">refresh</button><button id="forget-all" class="danger" type="button" disabled>forget all</button></div></div>
<form id="filters" class="filters" role="search" autocomplete="off">
<div class="field search-field"><label for="query">search</label><input id="query" type="search" placeholder="words in saved pages" aria-describedby="filter-error"></div>
<div class="field"><label for="site">site</label><input id="site" type="text" placeholder="all sites" spellcheck="false" autocapitalize="none" aria-describedby="filter-error"></div>
<button type="submit">search</button>
</form>
<p id="filter-error" class="error message" role="alert"></p>
<div class="results"><p id="result-count" class="meta" role="status"></p><time id="updated" class="meta"></time></div>
<div id="loading" class="loading" role="status"><span class="bone" aria-hidden="true"></span><span class="bone short" aria-hidden="true"></span><p>loading saved pages…</p></div>
<p id="empty" class="empty" hidden></p>
<ul id="pages" class="rows" aria-label="saved pages"></ul>
<div id="pagination" class="pagination" hidden><button id="previous" type="button" disabled>previous</button><p id="page-range" class="meta" role="status"></p><button id="next" type="button" disabled>next</button></div>
<p class="help message">forgetting pages does not erase content already sent to providers or used in chats.</p>
</section>
<noscript><p class="error message">enable javascript to review and change browser memory.</p></noscript>
</main>
<script>${SCRIPT}</script>
</body>
</html>`, { headers: HEADERS });
}
