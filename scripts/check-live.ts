// Live checks against the real Safari extension through the running daemon.
// Needs `safari status` to show the extension connected. Works only in tabs
// it opens in the background, and closes them; the user's tabs stay as they are.
//
//   bun scripts/check-live.ts
//
// Pages are built inside example.com with eval, so the checks do not depend on
// any site's markup changing.

import { CALLER_TOOLS } from "../daemon/caller.ts";
import { invoke } from "../daemon/call.ts";
import { inFront } from "../daemon/front.ts";

const HTTP = "http://127.0.0.1:37334/rpc";

type Tab = { id: number; active: boolean; front?: boolean };

async function call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(HTTP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args }) });
  const r = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!r.ok) throw new Error(`${tool}: ${r.error}`);
  return r.value;
}

let failed = 0;
function check(name: string, pass: boolean, detail: unknown) {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : `\n     got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

function refOf(snap: string, pattern: RegExp): string {
  const line = snap.split("\n").find((l) => pattern.test(l));
  if (!line) throw new Error(`no line matching ${pattern} in:\n${snap}`);
  return line.match(/\[(\d+)\]/)![1];
}

// Runs `body` in a fresh background tab on example.com with `html` as its page.
// Links in the fixtures lead only to example.org, so any example.org tab that
// appears meanwhile is ours, even when a failing check lost track of it.
async function withPage(html: string, setup: string, body: (tab: number) => Promise<void>) {
  const before = new Set(((await call("tabs")) as Tab[]).map((t) => t.id));
  const tab = (await call("open", { url: "https://example.com/", background: true })).id as number;
  try {
    await call("eval", { tab, expression: `(() => { document.body.innerHTML = ${JSON.stringify(html)}; ${setup}; return 1; })()` });
    await body(tab);
  } finally {
    await call("close", { tab });
    const strays = ((await call("tabs")) as (Tab & { url: string })[])
      .filter((t) => !before.has(t.id) && t.url.startsWith("https://example.org/"));
    for (const t of strays) await call("close", { tab: t.id });
  }
}

// ---------- actions ----------

const FORM = '<label>Size <select id=s><option value="">pick</option><option value="7">US 7</option><option value="8">US 8</option></select></label>' +
  "<div id=h role=button tabindex=0>Menu</div><div id=hout></div><div id=kout></div>" +
  "<label>Photo <input type=file id=f></label><div id=fout></div>" +
  '<a href="https://example.org/">Next page</a> <a href="https://example.org/" target=_blank>Elsewhere</a>';
const FORM_JS = `
  document.getElementById("h").addEventListener("mouseenter", () => { document.getElementById("hout").textContent = "hovered"; });
  document.addEventListener("keydown", (e) => { document.getElementById("kout").textContent = "key " + e.key + " " + e.code + " shift=" + e.shiftKey + " alt=" + e.altKey + " meta=" + e.metaKey; });
  document.getElementById("s").addEventListener("change", (e) => { document.title = "size " + e.target.value; });
  document.getElementById("f").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    document.getElementById("fout").textContent = "got " + f.name + " " + (await f.text()).trim();
  })`;

await withPage(FORM, FORM_JS, async (tab) => {
  const snap = (await call("snapshot", { tab })).snapshot as string;

  const q = await call("snapshot", { tab, query: "size" });
  check("snapshot query keeps only matching lines, without dropdown options",
    /^\[\d+\] label "Size"\n\[\d+\] combobox "Size" \{value="pick", 3 options\}$/.test(q.snapshot), q.snapshot);

  check("a div with role=button is named by its text", /\] button "Menu"/.test(snap), snap);

  const rejected = (p: Promise<unknown>) => p.then((v) => `resolved: ${JSON.stringify(v)}`, (e: Error) => e.message);
  const stale = await rejected(call("click", { tab, ref: "999" }));
  check("a stale ref is an error, not a success", stale.startsWith("click: stale ref 999"), stale);

  const combo = refOf(snap, /combobox/);
  const unknown = await rejected(call("select", { tab, ref: combo, option: "US 12" }));
  check("select with an unknown option errors and lists the options",
    unknown.startsWith("select: no option") && unknown.includes("options: pick | US 7 | US 8"), unknown);
  await call("select", { tab, ref: combo, option: "US 8" });
  const title = (await call("info", { tab })).title;
  check("select fires change with the chosen value", title === "size 8", title);

  await call("hover", { tab, ref: refOf(snap, /"Menu"/) });
  check("hover fires mouseenter", (await call("wait", { tab, text: "hovered", ms: 3000 })).found === true, "no hover text");

  await call("press", { tab, key: "Shift+Option+C" });
  const keyed = (await call("eval", { tab, expression: 'document.getElementById("kout").textContent' })).result;
  check("a key combo arrives as its key with the modifiers held", keyed === "key C KeyC shift=true alt=true meta=false", keyed);

  const file = "/private/var/tmp/safari-harness-upload-check.txt";
  await Bun.write(file, "hello from safari harness\n");
  await call("upload", { tab, paths: [file] });
  check("upload delivers the file's name and bytes",
    (await call("wait", { tab, text: "got safari-harness-upload-check.txt hello from safari harness", ms: 3000 })).found === true,
    await call("eval", { tab, expression: 'document.getElementById("fout").textContent' }));
  await Bun.file(file).delete();

  const userFront = ((await call("tabs")) as Tab[]).find((t) => t.front)?.id;
  const opened = await call("click", { tab, ref: refOf(snap, /"Elsewhere"/) });
  check("a click that opens a tab reports newTab", opened.newTab?.url === "https://example.org/", opened);
  if (opened.newTab) await call("close", { tab: opened.newTab.id });
  const activeNow = ((await call("tabs")) as Tab[]).find((t) => t.front)?.id;
  check("a new tab from a background tab leaves the user's tab in front", activeNow === userFront, { userFront, activeNow });

  const nav = await call("click", { tab, ref: refOf(snap, /"Next page"/) });
  check("a click that loads a page reports navigated", nav.navigated?.url === "https://example.org/", nav);
  const back = await call("history", { tab, do: "back" });
  check("back reports the previous page", back.navigated?.url === "https://example.com/", back);
  const fwd = await call("history", { tab, do: "forward", snapshot: true });
  check("snapshot: true returns the page the action led to", /h1 "Example Domain"/.test(fwd.page?.snapshot ?? ""), fwd);
});

// ---------- several steps in one call ----------

const tabsBefore = new Set(((await call("tabs")) as Tab[]).map((t) => t.id));
const read = await call("run", { steps: [
  { tool: "open", args: { url: "https://example.com/", background: true } },
  { tool: "eval", args: { expression: 'document.querySelector("h1").textContent' } },
  { tool: "close" },
] });
const leftover = ((await call("tabs")) as Tab[]).filter((t) => !tabsBefore.has(t.id));
for (const t of leftover) await call("close", { tab: t.id });
check("run opens, reads, and closes its own tab in one call",
  read.steps.length === 3 && read.steps[1].value?.result === "Example Domain" && leftover.length === 0, { read, leftover });

// After a failing step, later steps must not act on the page.
const stopped = await call("run", { steps: [
  { tool: "open", args: { url: "https://example.com/", background: true } },
  { tool: "click", args: { ref: "999" } },
  { tool: "eval", args: { expression: 'document.title = "later step ran"' } },
] });
const stoppedTab = stopped.steps[0].value?.id;
const stoppedTitle = stoppedTab === undefined ? undefined : (await call("info", { tab: stoppedTab })).title;
if (stoppedTab !== undefined) await call("close", { tab: stoppedTab });
check("run stops at the first failing step and says so",
  stopped.steps.length === 2 && /^stale ref 999/.test(stopped.steps[1].error ?? "") && stopped.notRun === 1 && stoppedTitle === "Example Domain",
  { stopped, stoppedTitle });

// A failed run must not leave its tab open: close steps still run.
const before2 = new Set(((await call("tabs")) as Tab[]).map((t) => t.id));
const cleaned = await call("run", { steps: [
  { tool: "open", args: { url: "https://example.com/", background: true } },
  { tool: "click", args: { ref: "999" } },
  { tool: "eval", args: { expression: "1" } },
  { tool: "close" },
] });
const left2 = ((await call("tabs")) as Tab[]).filter((t) => !before2.has(t.id));
for (const t of left2) await call("close", { tab: t.id });
check("a failed run still runs its close step",
  left2.length === 0 && cleaned.notRun === 1 && cleaned.steps.at(-1)?.tool === "close" && cleaned.steps.at(-1)?.step === 4 && cleaned.steps.at(-1)?.error === undefined,
  { cleaned, left2 });

// ---------- which tab ----------

// On 09-28 an agent that left out tab read the user's MyChart page.
const untargeted = await call("snapshot", {}).then(() => "resolved", (e: Error) => e.message);
check("a page tool without tab is an error, not a read of the front tab", untargeted.startsWith("snapshot: tab is required"), untargeted);

// Brings Safari to the front for a moment, then gives back the app and tab
// that were in front. A failure prints only whose tab it was: the other
// is the user's.
const TAB_OPS = { tabs: () => call("tabs") as Promise<Tab[]>, activate: (tab: number) => call("activate", { tab }) };
await withPage("<p>front check</p>", 'document.title = "front check"', async (tab) => {
  const named = await inFront(tab, TAB_OPS, () => call("info", { tab: "front" }));
  check('tab "front" names the tab in front', named.title === "front check", named.title === "front check" ? "ours" : "another tab");
});

const closed = (await call("open", { url: "https://example.com/", background: true })).id as number;
await call("close", { tab: closed });
const closeStart = Date.now();
const closedAgain = await call("close", { tab: closed }).then(() => "resolved", (e: Error) => e.message);
const closeMs = Date.now() - closeStart;
check("closing a tab that is gone says so at once", closedAgain.startsWith("close: that tab is gone") && closeMs < 5000, { closedAgain, closeMs });

// ---------- acting without a snapshot ----------

// A hidden copy of the button comes first, and a <menu> element shares the
// button's text as its tag name; neither may take the click.
const TARGETS = '<div style="display:none"><button onclick="document.title=\'hidden copy\'">Menu</button></div>' +
  "<menu><li>list</li></menu><label>Email <input id=em></label><label>Secret <input id=pw type=password></label>" +
  "<button id=go>Menu</button><article>card one</article><article>card two</article><form>19 results</form>";
const TARGETS_JS = 'document.getElementById("go").onclick = () => { document.title = "clicked " + document.getElementById("em").value; }';

await withPage(TARGETS, TARGETS_JS, async (tab) => {
  const r = await call("run", { steps: [
    { tool: "type", args: { tab, ref: "Email", text: "a@b.c" } },
    { tool: "click", args: { tab, ref: "Menu" } },
    { tool: "info", args: { tab } },
  ] });
  check("type by label and click by text act on the visible control, without a snapshot",
    r.steps[2]?.value?.title === "clicked a@b.c", r);

  await call("type", { tab, ref: "#em", text: "by css" });
  const byCss = (await call("eval", { tab, expression: 'document.getElementById("em").value' })).result;
  check("type by CSS selector reaches the field", byCss === "by css", byCss);

  const none = await call("click", { tab, ref: "Nowhere to be found" }).then((v) => `resolved: ${JSON.stringify(v)}`, (e: Error) => e.message);
  check("a target that matches nothing is an error", none.includes("nothing on the page matches Nowhere to be found"), none);

  const typed = await call("type", { tab, ref: "Secret", text: "hunter2" });
  check("typing into a password field does not echo it", !JSON.stringify(typed).includes("hunter2"), typed);

  const q = await call("extract", { tab, query: "results" });
  check("extract query keeps only the matching lines, from anywhere on the page", q.text === "19 results", q.text);
  const whole = await call("extract", { tab });
  check("extract reads the whole page when it has several articles and no main", /card one[\s\S]*card two/.test(whole.text), whole.text);
});

// ---------- no fixed pause after an action ----------

// Each control's script retitles the page 150 ms after the click. An action
// that starts no load returns at once, so the page it returns still has the
// old title; a fixed pause after clicks (it used to be 400 ms), or a wait for
// a load that never comes, would show the new one. The order of two events,
// not a time budget. The link's scheme has no handler, so no app opens.
const LATER_JS = `document.head.appendChild(Object.assign(document.createElement("script"),
  { textContent: 'for (const id of ["later", "app"]) document.getElementById(id).onclick = () => setTimeout(() => { document.title = id + " retitled"; }, 150)' }))`;

await withPage('<button id=later>Later</button> <a id=app href="shnohandler-zz:abc">App link</a>', LATER_JS, async (tab) => {
  const r = await call("click", { tab, ref: "#later", snapshot: true });
  check("a click that starts no load returns before the page's later script runs",
    r.page?.title === "Example Domain" && r.navigated === undefined, { title: r.page?.title, navigated: r.navigated });
  const app = await call("click", { tab, ref: "#app", snapshot: true });
  check("a click on an app link (mailto:, tel:) does not wait for a page load",
    app.page?.title !== "app retitled" && app.navigated === undefined, { title: app.page?.title, navigated: app.navigated });
});

// ---------- page text in the outline ----------

// Pages put instructions in headings; the login benchmark lost a turn when
// its credentials fell past an 80-character cut.
const INSTRUCTIONS = "This is where you can log into the secure area. Enter tomsmith for the username and SuperSecretPassword! for the password.";

await withPage(`<h4>${INSTRUCTIONS}</h4>`, "", async (tab) => {
  const s = await call("snapshot", { tab });
  check("a long heading keeps its instructions in the snapshot", s.snapshot.includes(`h4 "${INSTRUCTIONS}"`), s.snapshot);
});

// Answers often sit in plain text outside any paragraph: a result count in a
// form, a status box, a table row. Each once cost a follow-up extract.
const LOOSE_TEXT = "<form><strong>19</strong> results.</form><div id=flash>You logged into a secure area!</div>" +
  "<table><tr><th>UPC</th><td>a897fe39b1053632</td></tr></table>";

await withPage(LOOSE_TEXT, "", async (tab) => {
  const s = (await call("snapshot", { tab })).snapshot as string;
  check("a snapshot shows the page's plain text: a count, a status, a table row",
    ["19 results.", "You logged into a secure area!", "UPC | a897fe39b1053632"].every((t) => s.includes(t)), s);
});

// ---------- waiting in a hidden tab ----------

// Safari stops a content script's timers in a hidden tab about two seconds
// after it opens, while the page's own timers keep running. The page script
// below shows text 6 s in, well after that point.
const LATE_JS = `document.head.appendChild(Object.assign(document.createElement("script"),
  { textContent: 'setTimeout(() => { document.getElementById("late").textContent = "arrived late"; }, 6000)' }))`;

await withPage(`<p id="late">waiting</p>`, LATE_JS, async (tab) => {
  const r = await call("wait", { tab, text: "arrived late", ms: 15000 });
  check("wait in a hidden tab sees text the page adds after several seconds", r.found === true && r.waitedMs < 10000, r);
});

// Safari draws nothing in a hidden tab and soon nearly stops its timers; a
// tab the harness opened runs them anyway (see dialogs.js), so a web app in
// it renders without coming to the front. The page counts 40 frame callbacks
// and 40 chained timers, in the top page and in an embedded frame.
const COUNT_JS = (out: string) => `
  let frames = 0, timers = 0;
  const show = () => { if (frames >= 40 && timers >= 40) ${out}.textContent = "kept running " + document.visibilityState; };
  const frame = () => { frames++; show(); if (frames < 40) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const timer = () => { timers++; show(); if (timers < 40) setTimeout(timer, 20); };
  setTimeout(timer, 20);`;
const COUNT_TOP_JS = `document.head.appendChild(Object.assign(document.createElement("script"), { textContent: ${JSON.stringify(COUNT_JS('document.getElementById("run")'))} }))`;
const COUNT_FRAME_JS = `const f = document.createElement("iframe"); f.src = "https://example.com/";
  f.onload = () => { f.contentDocument.head.appendChild(Object.assign(f.contentDocument.createElement("script"), { textContent: ${JSON.stringify(COUNT_JS('parent.document.getElementById("run")'))} })); };
  document.body.appendChild(f)`;

for (const [where, setup] of [["top page", COUNT_TOP_JS], ["embedded frame", COUNT_FRAME_JS]]) {
  await withPage(`<p id="run"></p>`, setup, async (tab) => {
    const r = await call("wait", { tab, text: "kept running visible", ms: 15000 });
    check(`a hidden tab it opened runs the ${where}'s frames and timers, and reads visible`, r.found === true, r);
  });
}

// A page too busy to answer must not hold wait past its limit.
const BUSY_JS = `document.head.appendChild(Object.assign(document.createElement("script"),
  { textContent: 'const c = new MessageChannel(); c.port1.onmessage = () => { const end = Date.now() + 4000; while (Date.now() < end); }; c.port2.postMessage(0)' }))`;

await withPage("<p>busy</p>", BUSY_JS, async (tab) => {
  const r = await call("wait", { tab, text: "never shown", ms: 1500 });
  check("wait on a page too busy to answer still ends at its limit", r.found === false && r.waitedMs < 3000, r);
});

// Text that is on the page for one instant: the page adds it and takes it
// away in the next microtask. The page reports the change as it happens, so
// wait sees it; polling the page, however often, never could.
const FLASH_JS = `document.head.appendChild(Object.assign(document.createElement("script"),
  { textContent: 'setTimeout(() => { const p = document.getElementById("flash"); p.textContent = "saved"; queueMicrotask(() => { p.textContent = ""; }); }, 800)' }))`;

await withPage(`<p id="flash"></p>`, FLASH_JS, async (tab) => {
  const r = await call("wait", { tab, text: "saved", ms: 5000 });
  check("wait sees text the page shows for only an instant", r.found === true, r);
});

// Case and spacing aside, as a click finds its target.
await withPage("<h2>Tretinoin   cream 0.05%</h2>", "", async (tab) => {
  const r = await call("wait", { tab, text: "TRETINOIN cream", ms: 1500 });
  check("wait matches text in any case", r.found === true, r);
});

// A page that navigates while wait runs (a sign-in redirect, or a chain of
// them) is read again after each load; a miss says where the tab landed.
await withPage("<p>start</p>", "setTimeout(() => location.reload(), 300)", async (tab) => {
  const pending = call("wait", { tab, text: "never shown", ms: 5000 }).catch((e: Error) => e.message);
  await Bun.sleep(1500);
  await call("eval", { tab, expression: `(() => { setTimeout(() => { location.href = "https://example.org/"; }, 200); return 1; })()` });
  const r = await pending;
  check("wait lasts through two navigations and gives the page the tab landed on", r?.found === false && r.url === "https://example.org/", r);
});

// ---------- shadow roots ----------

// Web components draw into shadow roots, which a plain query and innerText
// never enter (CVS's insurance-card upload lives in them). The outline, the
// text, waits, clicks, and uploads read open ones as part of the page, and a
// <slot> as what the host put in it. The page's own script, not the
// extension's, reacts and adds the later text, as a site's would.
const SHADOW_PAGE_JS = `const r = document.getElementById("host").shadowRoot;
  r.getElementById("sf").onchange = (e) => { r.getElementById("sout").textContent = "got " + e.target.files[0].name; };
  setTimeout(() => r.getElementById("sp").append(", back side"), 1500);`;
const SHADOW_JS = `document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
  '<p id=sp>Insurance card</p><button onclick="this.textContent = \\'front chosen\\'">Upload front</button><label>Card <input type=file id=sf></label><div id=sout></div><slot></slot>';
  document.head.appendChild(Object.assign(document.createElement("script"), { textContent: ${JSON.stringify(SHADOW_PAGE_JS)} }))`;

await withPage("<div id=host><span>slotted words</span></div>", SHADOW_JS, async (tab) => {
  const snap = (await call("snapshot", { tab })).snapshot as string;
  check("snapshot shows a shadow root's text, its buttons, and slotted text",
    snap.includes("Insurance card") && /button "Upload front"/.test(snap) && snap.includes("slotted words"), snap);
  const text = (await call("extract", { tab })).text as string;
  check("extract reads text inside a shadow root", text.includes("Insurance card") && text.includes("slotted words"), text);
  const later = await call("wait", { tab, text: "back side", ms: 5000 });
  check("wait sees text a shadow root adds later", later.found === true && later.waitedMs < 5000, later);
  const sel = await call("wait", { tab, selector: "#sf", ms: 1000 });
  check("wait finds a selector inside a shadow root", sel.found === true, sel);
  const clicked = await call("click", { tab, ref: "Upload front" }).catch((e: Error) => e.message);
  const shown = await call("wait", { tab, text: "front chosen", ms: 2000 });
  check("click by text reaches a button inside a shadow root", shown.found === true, { clicked, shown });
  const file = "/private/var/tmp/safari-harness-shadow-check.txt";
  await Bun.write(file, "card\n");
  const up = await call("upload", { tab, paths: [file] }).catch((e: Error) => e.message);
  const got = await call("wait", { tab, text: "got safari-harness-shadow-check.txt", ms: 3000 });
  check("upload without a ref finds the file input inside a shadow root", got.found === true, { up, got });
  await Bun.file(file).delete();
});

// ---------- secrets in the outline ----------

// Autofill fills these without the agent typing: a password from Apple
// Passwords, a saved card, a code from Messages. A show-password toggle
// leaves a password in a text field. The snapshot says filled.
const SECRETS = { p: "dummy-pass-XYZ", s: "dummy-shown-XYZ", c: "4111111111111111", o: "123456" };
const SECRET_FIELDS = '<label>Pw <input type=password id=p></label><label>Shown <input autocomplete=current-password id=s></label>' +
  '<label>Card <input autocomplete=cc-number id=c></label><label>Code <input autocomplete=one-time-code id=o></label><label>Name <input id=n></label>';
const SECRETS_JS = `for (const [id, v] of Object.entries(${JSON.stringify({ ...SECRETS, n: "Ada" })})) document.getElementById(id).value = v`;

await withPage(SECRET_FIELDS, SECRETS_JS, async (tab) => {
  const s = (await call("snapshot", { tab })).snapshot as string;
  check("a snapshot never prints a password, card number, or one-time code",
    Object.values(SECRETS).every((v) => !s.includes(v)) && (s.match(/\{filled\}/g) ?? []).length === 4 && s.includes('value="Ada"'), s);
});

// ---------- network and console capture ----------

// The page's own script makes these calls. Its fetch, XHR, and console are
// not the content script's copies, which is all the capture once patched.
const PAGE_CALLS_JS = `document.head.appendChild(Object.assign(document.createElement("script"),
  { textContent: 'document.getElementById("go").onclick = () => { fetch("/?page-fetch", { method: "POST" }).then((r) => console.log("page fetch", r.status)); const x = new XMLHttpRequest(); x.open("GET", "/?page-xhr"); x.send(); }' }))`;

await withPage("<button id=go>Load</button><p id=out></p>", PAGE_CALLS_JS, async (tab) => {
  await call("net", { tab, do: "start" });
  await call("console", { tab, do: "start" });
  await call("click", { tab, ref: "#go" });
  let net: { kind: string; url: string; method: string }[] = [];
  let logs: { text: string }[] = [];
  for (let i = 0; i < 20 && (net.length < 2 || logs.length < 1); i++) {
    await Bun.sleep(100);
    net = (await call("net", { tab, do: "read" })).entries;
    logs = (await call("console", { tab, do: "read" })).entries;
  }
  const seen = net.map((e) => `${e.kind} ${e.method} ${new URL(e.url, "https://example.com/").search}`).sort();
  check("net and console record the page's own requests and logs",
    JSON.stringify(seen) === JSON.stringify(["fetch POST ?page-fetch", "xhr GET ?page-xhr"]) && /^page fetch \d+$/.test(logs[0]?.text ?? ""),
    { net, logs });
});

// ---------- controls without a role ----------

// A span with a hand cursor, a label, and a click handler added from script
// (CloudKit's "Add field") is a control. Text inside a hand-cursor control,
// and plain text under a hand cursor, are not.
const POINTER = '<span id=add style="cursor:pointer" aria-label="Add field" data-testid="add-new-field-button">+</span><p id=added></p>' +
  '<div style="cursor:pointer" aria-label="Product card"><span title="Price">$5</span></div><div style="cursor:pointer"><span>plain one</span></div>';
const POINTER_JS = 'document.getElementById("add").addEventListener("click", () => { document.getElementById("added").textContent = "added"; })';

await withPage(POINTER, POINTER_JS, async (tab) => {
  const snap = (await call("snapshot", { tab })).snapshot as string;
  check("a hand-cursor element with a label gets a ref; text inside one, and plain hand-cursor text, do not",
    /^\[\d+\] span "Add field"$/m.test(snap) && /^\[\d+\] div "Product card"$/m.test(snap) && !/\] span "Price"/.test(snap) && /^plain one$/m.test(snap), snap);
  await call("click", { tab, ref: refOf(snap, /span "Add field"/) });
  check("clicking that ref runs the page's handler", (await call("wait", { tab, text: "added", ms: 3000 })).found === true, "no added text");
});

// ---------- requests from the page's load ----------

// The page keeps its own copy of fetch and calls it before any net start
// (CVS's insurance form did). net still sees the calls, with the start of
// each body, and the page still reads each whole body.
const LOAD_CALLS = 'const f = window.fetch; window.got = {}; f("/nope").then((r) => r.text()).then((t) => { got.missing = t.length; });' +
  ' f("data:text/plain," + "a".repeat(100000)).then((r) => r.text()).then((t) => { got.long = t.length; });';
const LOAD_CALLS_JS = `document.head.appendChild(Object.assign(document.createElement("script"), { textContent: ${JSON.stringify(LOAD_CALLS)} }))`;

await withPage("<p>calls</p>", LOAD_CALLS_JS, async (tab) => {
  let net: { url: string; status?: number; body?: string }[] = [];
  let got: { missing?: number; long?: number } = {};
  for (let i = 0; i < 30 && (got.missing === undefined || got.long === undefined || !net.some((e) => e.status === 404 && e.body)); i++) {
    await Bun.sleep(100);
    net = (await call("net", { tab, do: "read" })).entries;
    got = (await call("eval", { tab, page: true, expression: "window.got" })).result ?? {};
  }
  const missing = net.find((e) => e.url === "https://example.com/nope");
  const long = net.find((e) => e.url.startsWith("data:text/plain,"));
  check("net shows requests from before any start, made with the page's own copy of fetch, with the start of each body",
    missing?.status === 404 && /^<!doctype html>/i.test(missing.body ?? "") && long?.status === 200 && long.body === "a".repeat(300) + "…", net);
  check("the page still reads each whole body itself", got.long === 100000 && (got.missing ?? 0) > 300, got);
});

// ---------- frames ----------

// A srcdoc frame gets no extension script in Safari, so the page reads it
// inline; a cross-origin frame runs its own copy, and its lines come back
// under the <iframe> with refs naming the frame.
const FRAMES = `<iframe id=inner srcdoc="<button onclick='this.textContent=&quot;inner clicked&quot;'>Inner button</button>" style="width:300px;height:80px"></iframe>` +
  '<iframe id=outer src="https://example.org/" style="width:500px;height:300px;margin-left:40px"></iframe>';

await withPage(FRAMES, "", async (tab) => {
  let s = "";
  for (let i = 0; i < 30 && !/\[f\d+:\d+\] link "Learn more"/.test(s); i++) {
    await Bun.sleep(200);
    s = (await call("snapshot", { tab })).snapshot;
  }
  check("a snapshot includes a same-origin frame's content", /^  \[\d+\] button "Inner button"$/m.test(s), s);
  check("a snapshot includes a cross-origin frame's content with frame refs", /\[f\d+:\d+\] link "Learn more"/.test(s), s);
  await call("click", { tab, ref: "Inner button" });
  const after = (await call("snapshot", { tab, diff: true })).snapshot;
  check("click by text reaches a button inside a frame, and diff shows only the change",
    after === '-   [2] button "Inner button"\n+   [2] button "inner clicked"', after);
  const ref = s.match(/\[(f\d+:\d+)\] link "Learn more"/)![1];
  const box = await call("locate", { tab, ref });
  const frame = await call("eval", { tab, expression: "(() => { const r = document.getElementById('outer').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()" });
  const f = frame.result as { x: number; y: number; w: number; h: number };
  check("locate places a cross-origin frame's element inside that frame's box",
    box.x > f.x && box.y > f.y && box.x + box.width < f.x + f.w && box.y + box.height < f.y + f.h, { box, frame: f });
  // Apple's sign-in form is a frame from another site: the login goes to
  // that frame, as its own site's. An f<id>: expression runs in that frame.
  const id = Number(ref.match(/^f(\d+):/)![1]);
  await call("eval", { tab, expression: `f${id}:(() => { document.body.insertAdjacentHTML("beforeend", "<form><input name=username autocomplete=username><input type=password name=password></form>"); return 1; })()` });
  const form = await call("login_form", { tab });
  check("a sign-in form in an embedded frame belongs to that frame's own site",
    form.site === "example.org" && form.frame === id && form.username === true && form.password === true, form);
  const field = await call("wait", { tab, selector: "input[type=password]", ms: 3000 });
  check("wait finds a selector only an embedded frame has", field.found === true, field);
});

// A frame that loads while a wait runs joins it: sign-in frames load last.
await withPage("<p>no frame yet</p>", "", async (tab) => {
  await call("eval", { tab, page: true, expression: "setTimeout(() => { const f = document.createElement('iframe'); f.src = 'https://example.org/'; document.body.append(f); }, 1000), 1" });
  const late = await call("wait", { tab, text: "Learn more", ms: 10000 });
  check("wait finds text in a frame that loads while it runs", late.found === true && late.waitedMs >= 500, late);
});

// Safari runs no animation in a background tab, so a form fading in stays
// transparent there; it is shown all the same. A transparent field is not.
const FADE = "<style>@keyframes sh-in { to { opacity: 1 } }</style>" +
  '<div style="opacity:0;animation:sh-in .3s forwards"><input aria-label="Fading field"></div><input aria-label="Clear field" style="opacity:0">';

await withPage(FADE, "", async (tab) => {
  const s = (await call("snapshot", { tab })).snapshot;
  check("a snapshot shows a form still fading in, but not a transparent field", /textbox "Fading field"/.test(s) && !/Clear field/.test(s), s);
});

// ---------- bot checks ----------

// A Turnstile-style box that the page removes 2.5 s later, the way a passed
// check goes away. handoff brings the tab to the front, so the tab the user
// had in front is put back after, unless he closed it meanwhile.
const BOT_CHECK = '<form><div class="cf-turnstile" style="width:300px;height:65px"></div><button>Sign in</button></form>';
const BOT_CHECK_JS = `document.head.appendChild(Object.assign(document.createElement("script"), { textContent: "setTimeout(() => document.querySelector('.cf-turnstile').remove(), 2500)" }))`;
await withPage(BOT_CHECK, BOT_CHECK_JS, async (tab) => {
  const snap = await call("snapshot", { tab });
  check("snapshot says the tab shows a bot check", snap.challenge?.kind === "cloudflare" && snap.challenge?.where === "box", snap.challenge);
  const userFront = ((await call("tabs")) as Tab[]).find((t) => t.front)?.id;
  const handed = await call("handoff", { tab, why: "Safari Harness self-test: nothing to do", ms: 8000 });
  check("handoff returns once the check is gone", handed.done === true && handed.challenge === undefined && handed.waitedMs < 8000, handed);
  if (userFront !== undefined) await call("activate", { tab: userFront }).catch((e: Error) => { if (!e.message.includes("that tab is gone")) throw e; });
});

// ---------- dialogs ----------

const DIALOG = `<button id=ask onclick="document.getElementById('o').textContent = String(confirm('Sure?')) + ' ' + prompt('Name?')">Ask</button><p id=o></p>`;

await withPage(DIALOG, "", async (tab) => {
  const first = await call("click", { tab, ref: "#ask" });
  const out1 = (await call("eval", { tab, expression: "document.getElementById('o').textContent" })).result;
  check("a confirm and a prompt are dismissed and reported with the click",
    out1 === "false null" && first.dialogs?.map((d: { type: string }) => d.type).join() === "confirm,prompt", { out1, first });
  await call("dialog", { tab, do: "accept", text: "Ada" });
  await call("click", { tab, ref: "#ask" });
  const out2 = (await call("eval", { tab, expression: "document.getElementById('o').textContent" })).result;
  check("after dialog accept, a confirm is accepted and a prompt gets the text", out2 === "true Ada", out2);
});

// ---------- files ----------

// Inline handlers see document.URL as URL, hence window.URL.
const FILES = '<a id=dl download="hello.txt" href="data:text/plain,hello%20world">Get file</a>' +
  `<button id=blob onclick="const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob(['blob body'], { type: 'text/plain' })); a.download = 'made.txt'; a.click()">Make file</button>`;
const FILE_DIR = `/private/var/tmp/safari-harness-check-${process.pid}`;

await withPage(FILES, "", async (tab) => {
  const link = await call("download", { tab, ref: "#dl", out: `${FILE_DIR}/hello.txt` });
  const blob = await call("download", { tab, ref: "#blob", out: `${FILE_DIR}/made.txt` });
  const url = await call("download", { tab, url: "https://example.com/", out: `${FILE_DIR}/page.html` });
  check("download saves a data link, a file the page builds on click, and a url",
    await Bun.file(link.path).text() === "hello world" && await Bun.file(blob.path).text() === "blob body" &&
    (await Bun.file(url.path).text()).includes("<title>Example Domain</title>"), { link, blob, url });
  const got = await call("fetch", { tab, url: "/", maxBytes: 100 });
  check("fetch returns the page's response, clipped", got.status === 200 && got.truncated === true && got.text.startsWith("<!doctype html>"), got);
  const pdfOut = `${FILE_DIR}/page.pdf`;
  const saved = await call("pdf", { tab, out: pdfOut });
  const read = await call("pdf", { do: "read", path: pdfOut });
  check("pdf prints the page and reads its text back", saved.pages === 1 && read.text.includes("Get file"), { saved, read });
});
await Bun.$`mv ${FILE_DIR} ${process.env.HOME}/.Trash/`.quiet().nothrow();

// ---------- page world, cookies, window ----------

const PAGE_VAR_JS = `document.head.appendChild(Object.assign(document.createElement("script"), { textContent: "window.fromPage = 42" }))`;

await withPage("<p>page</p>", PAGE_VAR_JS, async (tab) => {
  const isolated = (await call("eval", { tab, expression: "typeof window.fromPage" })).result;
  const page = (await call("eval", { tab, expression: "window.fromPage", page: true })).result;
  check("eval page: true sees the page's own variables", isolated === "undefined" && page === 42, { isolated, page });
  await call("cookies", { tab, do: "set", name: "sh_check", value: "1", expires: Math.floor(Date.now() / 1000) + 60 });
  const names = ((await call("cookies", { tab })) as { name: string }[]).map((c) => c.name);
  const seen = (await call("eval", { tab, expression: "document.cookie" })).result as string;
  check("cookies set adds a cookie the page sees", names.includes("sh_check") && seen.includes("sh_check=1"), { names, seen });
  await call("window", { tab, width: 480, height: 700 });
  const width = (await call("eval", { tab, expression: "innerWidth" })).result as number;
  check("window gives the tab a narrow viewport", width > 300 && width <= 480, width);
});

// YouTube and Google demand Trusted Types, which refuse a plain string of code.
const TRUSTED_TYPES_JS = `document.head.appendChild(Object.assign(document.createElement("meta"), { httpEquiv: "Content-Security-Policy", content: "require-trusted-types-for 'script'" }))`;

await withPage("<p>page</p>", `${PAGE_VAR_JS}; ${TRUSTED_TYPES_JS}`, async (tab) => {
  const r = (await call("eval", { tab, page: true, expression: `(() => { try { eval("1"); return "plain eval allowed"; } catch { return window.fromPage; } })()` })).result;
  check("eval page: true runs on a page that demands Trusted Types", r === 42, r);
});

// Safari passes results on as JSON and aborts the whole browser on a NaN or
// Infinity; a result holding them must come back, with Safari still up. Its
// native side does not keep an object's key order.
await withPage("<p>page</p>", "", async (tab) => {
  for (const page of [false, true]) {
    const r = (await call("eval", { tab, page, expression: "({ a: NaN, b: [Infinity, 1] })" })).result;
    check(`eval${page ? " page: true" : ""} returns NaN and Infinity as null without crashing Safari`, r.a === null && JSON.stringify(r.b) === "[null,1]" && Object.keys(r).length === 2, r);
  }
});

// ---------- screenshots ----------

function pngSize(bytes: Uint8Array): { w: number; h: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

await withPage('<button id=b style="width:200px;height:50px">Shot</button><div style="height:4000px"></div><p>end</p>', "", async (tab) => {
  const view = pngSize(await Bun.file((await call("shot", { tab })).path).bytes());
  const one = pngSize(await Bun.file((await call("shot", { tab, ref: "#b" })).path).bytes());
  const full = await call("shot", { tab, fullPage: true });
  const whole = pngSize(await Bun.file(full.path).bytes());
  check("shot of a ref is that element's size", Math.abs(one.w / one.h - 4) < 0.3 && one.w < view.w, { view, one });
  check("shot fullPage is taller than the viewport", whole.h > view.h * 2 && whole.w === view.w, { view, whole, full });
  await call("shot", { tab, annotate: true });
  const left = (await call("eval", { tab, expression: "document.getElementById('__safari_harness_annotate') === null" })).result;
  check("annotate leaves nothing on the page", left === true, left);
});

// ---------- real input ----------

// Brings Safari to the front for about a second, then gives back the app
// and tab that were in front.
const TRUST = `<button id=b onclick="this.dataset.trusted = event.isTrusted">Real</button><input id=f>`;

await withPage(TRUST, "", async (tab) => {
  const userFront = ((await call("tabs")) as Tab[]).find((t) => t.front)?.id;
  await call("click", { tab, ref: "#b" });
  const scripted = (await call("eval", { tab, expression: "document.getElementById('b').dataset.trusted" })).result;
  await CALLER_TOOLS.real_input.run({ tab, do: "click", ref: "#b" });
  const real = (await call("eval", { tab, expression: "document.getElementById('b').dataset.trusted" })).result;
  check("real_input click is a trusted event where click is not", scripted === "false" && real === "true", { scripted, real });
  await CALLER_TOOLS.real_input.run({ tab, do: "type", ref: "#f", text: "abc" });
  await CALLER_TOOLS.real_input.run({ tab, do: "key", key: "Backspace" });
  const typed = (await call("eval", { tab, expression: "document.getElementById('f').value" })).result;
  const nowFront = ((await call("tabs")) as Tab[]).find((t) => t.front)?.id;
  check("real_input types and presses keys, and gives the front tab back", typed === "ab" && nowFront === userFront, { typed, nowFront, userFront });
});

// run takes every tool: a real_input step runs in this process, and the run
// goes step by step from here.
const mixed = await invoke("run", { steps: [
  { tool: "open", args: { url: "https://example.com/", background: true } },
  { tool: "eval", args: { expression: `(() => { document.body.innerHTML = ${JSON.stringify(TRUST)}; return 1; })()` } },
  { tool: "real_input", args: { do: "click", ref: "#b" } },
  { tool: "eval", args: { expression: "document.getElementById('b').dataset.trusted" } },
  { tool: "close" },
] });
const mixedSteps = mixed && typeof mixed === "object" && "steps" in mixed && Array.isArray(mixed.steps) ? mixed.steps : [];
check("run takes a real_input step", mixedSteps.length === 5 && mixedSteps.every((s) => s.error === undefined) && mixedSteps[3].value?.result === "true", mixed);

// A tab it opened runs its scripts while hidden but draws only on screen: a
// CSS animation ends once the tab is shown. The daemon runs wait's front
// itself, under launchd, where only the helper verbs that need no
// Accessibility permission work. This covers bringing the tab forward in its
// window; Safari coming to the front matters only when another app covers
// Safari's window, which a check cannot arrange.
const SHOWN = `<style>@keyframes sh-fade { from { opacity: 0 } }</style><p id=out style="animation: sh-fade 100ms">drawing</p>`;
const SHOWN_JS = `document.getElementById("out").addEventListener("animationend", (e) => { e.target.textContent = "Now drawn"; })`;

await withPage(SHOWN, SHOWN_JS, async (tab) => {
  const userFront = ((await call("tabs")) as Tab[]).find((t) => t.front)?.id;
  const hidden = await call("wait", { tab, text: "Now drawn", ms: 1500 });
  const shown = await call("wait", { tab, text: "Now drawn", ms: 5000, front: true });
  const nowFront = ((await call("tabs")) as Tab[]).find((t) => t.front)?.id;
  check("wait front shows a hidden tab until it draws, then gives the front tab back", !hidden.found && shown.found && nowFront === userFront, { hidden, shown, nowFront, userFront });
});

// ---------- browsing history ----------

// Runs in this process: reading History.db needs the terminal's Full Disk Access.
const visits = (await CALLER_TOOLS.browsing_history.run({ text: "example.com", days: 1 })) as { url: string }[];
check("browsing_history finds the page these checks just opened", visits.some((v) => v.url.startsWith("https://example.com/")), visits.slice(0, 3));

// ---------- tabs close with the program that opened them ----------

// Here that program is a bun process that runs the CLI and exits. The
// daemon looks every 5 s, so the tab is gone within about 10 s; the --keep
// tab must outlive a look after that.
const CLI = new URL("../cli/safari.ts", import.meta.url).pathname;
async function openFromChild(keep: boolean): Promise<number> {
  const argv = [process.execPath, CLI, "open", "https://example.com/", "--bg", "--json", ...(keep ? ["--keep"] : [])];
  const child = Bun.spawn([process.execPath, "-e", `const r = Bun.spawnSync(${JSON.stringify(argv)}); process.stdout.write(r.stdout); process.stderr.write(r.stderr)`], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  const opened: unknown = JSON.parse(out || "null");
  if (!opened || typeof opened !== "object" || !("id" in opened) || typeof opened.id !== "number") throw new Error(`safari open failed: ${err.trim() || out}`);
  return opened.id;
}
const tabIds = async () => new Set(((await call("tabs")) as Tab[]).map((t) => t.id));
const [owned, kept] = await Promise.all([openFromChild(false), openFromChild(true)]);
try {
  let ownedLeft = true;
  for (let waited = 0; ownedLeft && waited < 15000; waited += 1000) {
    await Bun.sleep(1000);
    ownedLeft = (await tabIds()).has(owned);
  }
  await Bun.sleep(6000);
  const keptLeft = (await tabIds()).has(kept);
  check("a background tab closes once the program that opened it exits, unless --keep", !ownedLeft && keptLeft, { ownedLeft, keptLeft });
} finally {
  const left = await tabIds();
  for (const t of [owned, kept]) if (left.has(t)) await call("close", { tab: t });
}

// ---------- snapshot size ----------

// A shop-like listing: every card links twice with a long tracking query,
// has an image-only link, and the page carries a 60-option dropdown.
const TRACK = "?_trkparms=" + "amclksrc%3DITM%26aid%3D777008%26algo%3DPERSONAL.TOPIC%26ao%3D1".repeat(4);
const CARDS = Array.from({ length: 40 }, (_, i) =>
  `<li><article><a href="/itm/${100000 + i}${TRACK}"><img alt="" src="data:,"></a>` +
  `<button>Watch item ${i}</button><a href="/itm/${100000 + i}${TRACK}">Item number ${i}</a></article></li>`).join("");
const OPTIONS = Array.from({ length: 60 }, (_, i) => `<option>Choice ${i}</option>`).join("");
const LISTING = `<select aria-label="Sort">${OPTIONS}</select><ul>${CARDS}</ul>`;

// 40 cards x 2 lines, plus the dropdown: about 110 bytes a card. A picture
// link repeating its card's text link prints once; full tracking URLs alone
// would add about 40 x 250 = 10 kB. It was 8,000 before the one-walk outline.
const LISTING_MAX_BYTES = 5000;

await withPage(LISTING, "", async (tab) => {
  const s = await call("snapshot", { tab });
  const bytes = new TextEncoder().encode(s.snapshot).length;
  check(`listing snapshot stays under ${LISTING_MAX_BYTES} bytes (was ${bytes})`, bytes <= LISTING_MAX_BYTES, `${bytes} bytes`);
});

// ---------- snapshot work ----------

// A long page's outline stops reading at its last line. The render used to
// go on through the rest: on Wikipedia's World War II article it parsed
// 5,010 link addresses for 600 printed lines, 40% of a warm snapshot.
const LINKS = Array.from({ length: 2000 }, (_, i) => `<p><a href="https://example.org/${i}">Link ${i}</a></p>`).join("");
const COUNT_URLS = "const U = URL; window.__urls = 0; window.URL = new Proxy(U, { construct(t, a) { window.__urls++; return new t(...a); } })";

await withPage(LINKS, COUNT_URLS, async (tab) => {
  const s = await call("snapshot", { tab, maxNodes: 100 });
  const urls = (await call("eval", { tab, expression: "window.__urls" })).result;
  check("a snapshot cut at 100 lines parses no link address past them",
    s.truncated === true && s.nodes === 100 && urls <= s.nodes + 1, { urls, nodes: s.nodes, truncated: s.truncated });
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
