// Live checks against the real Safari extension through the running daemon.
// Needs `safari status` to show the extension connected. Works only in tabs
// it opens in the background, and closes them; the user's tabs stay as they are.
//
//   bun scripts/check-live.ts
//
// Pages are built inside example.com with eval, so the checks do not depend on
// any site's markup changing.

const HTTP = "http://127.0.0.1:37334/rpc";

type Tab = { id: number; active: boolean };

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

const front = ((await call("tabs")) as Tab[]).find((t) => t.active)?.id;

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

  const opened = await call("click", { tab, ref: refOf(snap, /"Elsewhere"/) });
  check("a click that opens a tab reports newTab", opened.newTab?.url === "https://example.org/", opened);
  if (opened.newTab) await call("close", { tab: opened.newTab.id });
  const activeNow = ((await call("tabs")) as Tab[]).find((t) => t.active)?.id;
  check("a new tab from a background tab leaves the user's tab in front", activeNow === front, { front, activeNow });

  const nav = await call("click", { tab, ref: refOf(snap, /"Next page"/) });
  check("a click that loads a page reports navigated", nav.navigated?.url === "https://example.org/", nav);
  const back = await call("history", { tab, go: "back" });
  check("back reports the previous page", back.navigated?.url === "https://example.com/", back);
  const fwd = await call("history", { tab, go: "forward", snapshot: true });
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

// Text that is on the page for one instant: the page adds it and takes it
// away in the next microtask. The page reports the change as it happens, so
// wait sees it; polling the page, however often, never could.
const FLASH_JS = `document.head.appendChild(Object.assign(document.createElement("script"),
  { textContent: 'setTimeout(() => { const p = document.getElementById("flash"); p.textContent = "saved"; queueMicrotask(() => { p.textContent = ""; }); }, 800)' }))`;

await withPage(`<p id="flash"></p>`, FLASH_JS, async (tab) => {
  const r = await call("wait", { tab, text: "saved", ms: 5000 });
  check("wait sees text the page shows for only an instant", r.found === true, r);
});

// ---------- secrets in the outline ----------

// Autofill fills these without the agent typing: a password from Apple
// Passwords, a saved card, a code from Messages. The snapshot says filled.
const SECRETS = { p: "dummy-pass-XYZ", c: "4111111111111111", o: "123456" };
const SECRET_FIELDS = '<label>Pw <input type=password id=p></label>' +
  '<label>Card <input autocomplete=cc-number id=c></label><label>Code <input autocomplete=one-time-code id=o></label><label>Name <input id=n></label>';
const SECRETS_JS = `for (const [id, v] of Object.entries(${JSON.stringify({ ...SECRETS, n: "Ada" })})) document.getElementById(id).value = v`;

await withPage(SECRET_FIELDS, SECRETS_JS, async (tab) => {
  const s = (await call("snapshot", { tab })).snapshot as string;
  check("a snapshot never prints a password, card number, or one-time code",
    Object.values(SECRETS).every((v) => !s.includes(v)) && (s.match(/\{filled\}/g) ?? []).length === 3 && s.includes('value="Ada"'), s);
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

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
