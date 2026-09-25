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
  "<div id=h role=button tabindex=0>Menu</div><div id=hout></div>" +
  "<label>Photo <input type=file id=f></label><div id=fout></div>" +
  '<a href="https://example.org/">Next page</a> <a href="https://example.org/" target=_blank>Elsewhere</a>';
const FORM_JS = `
  document.getElementById("h").addEventListener("mouseenter", () => { document.getElementById("hout").textContent = "hovered"; });
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
  check("snapshot: true returns the page the action led to", /heading "Example Domain"/.test(fwd.page?.snapshot ?? ""), fwd);
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

// 40 cards x 3 lines, plus the dropdown. Shortened URLs keep a card near 170
// bytes; full tracking URLs alone would add about 40 x 2 x 250 = 20 kB.
const LISTING_MAX_BYTES = 8000;

await withPage(LISTING, "", async (tab) => {
  const s = await call("snapshot", { tab });
  const bytes = new TextEncoder().encode(s.snapshot).length;
  check(`listing snapshot stays under ${LISTING_MAX_BYTES} bytes (was ${bytes})`, bytes <= LISTING_MAX_BYTES, `${bytes} bytes`);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
