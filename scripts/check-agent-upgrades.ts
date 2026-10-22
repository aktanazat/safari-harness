import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inFront } from "../daemon/front.ts";
import { removeCapture, verifyEvidence, type CaptureResult, type ConditionalCaptureResult } from "../daemon/evidence.ts";

const base = process.env.SAFARI_HARNESS_HTTP ?? "http://127.0.0.1:37334";
const ua = "OpenAI File Downloader, XaiImageApiFetch/1.0";
async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${base}/rpc`, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify({ tool, args, caller: process.pid, own: true }) });
  const reply = await response.json() as { ok: boolean; value: T; error?: string };
  if (!reply.ok) throw new Error(`${tool}: ${reply.error}`);
  return reply.value;
}
type Update = { kind: "full" | "delta" | "unchanged"; revision: string; baseRevision: string | null; edits?: { start: number; deleteCount: number; lines: string[] }[] };
type Snapshot = { snapshot: string; update: Update };
type Audit = { ok: boolean; complete: boolean; audited: { result: { violations: { id: string }[] } }[]; skipped: unknown[] };
type Inspection = { ok: boolean; status: string; components: { name: string; hooks: { slots: { value: unknown }[] } }[] };
const fixtures = join(import.meta.dir, "..", "bench", "fixtures");
const files = new Map<string, Uint8Array>();
for (const name of ["app-checks-react.html", "site-actions-cooperator.html", "app-checks-vendor/react-18.3.1.development.js", "app-checks-vendor/react-dom-18.3.1.development.js"]) files.set(`/${name}`, await readFile(join(fixtures, name)));
const html = '<!doctype html><html lang="en"><head><title>Safari upgrade check</title><style>body{font:18px system-ui;padding:30px}button{padding:15px}#cover{position:fixed;inset:0;background:#fff9;z-index:100;display:grid;place-items:center}#visual{width:180px;height:80px;background:navy;color:white}</style></head><body><button id="target" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">approve invoice</button><div id="cover">please review this dialog first</div><div id="visual">protected picture</div><input id="missing-label" value="private-form-fixture"><main>' + Array.from({ length: 160 }, (_, index) => `<p id="row-${index}">item ${index}: awaiting review</p>`).join("") + '</main></body></html>';
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const file = files.get(path);
  if (file) return new Response(file, { headers: { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html" } });
  return new Response(html, { headers: { "content-type": "text/html" } });
} });
const origin = `http://127.0.0.1:${server.port}`;
const captures: CaptureResult[] = [];
let tab: number | undefined;
let reactEnabled = false;
let actionsEnabled = false;
let passed = 0;
function checked(scenario: string, measurement: Record<string, unknown> = {}) {
  passed++;
  console.log(JSON.stringify({ pass: scenario, ...measurement }));
}
try {
  tab = (await call<{ id: number }>("open", { url: origin, background: true, new: true })).id;
  for (let run = 0; run < 3; run++) {
    await assert.rejects(call("click", { tab, ref: "#target" }), /covered|visible/);
    assert.equal((await call<{ result: number }>("eval", { tab, expression: "Number(document.body.dataset.clicks||0)" })).result, 0);
  }
  checked("covered buttons cannot be clicked", { attempts: 3, unintendedClicks: 0 });
  await call("eval", { tab, expression: "document.querySelector('#cover').remove()" });
  await call("click", { tab, ref: "#target" });
  assert.equal((await call<{ result: number }>("eval", { tab, expression: "Number(document.body.dataset.clicks)" })).result, 1);
  checked("an uncovered button still works");

  const full = await call<Snapshot>("snapshot", { tab, updates: true });
  assert.equal(full.update.kind, "full");
  const same = await call<Snapshot>("snapshot", { tab, since: full.update.revision });
  assert.equal(same.update.kind, "unchanged");
  assert.equal(same.snapshot, "");
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const sameBytes = Buffer.byteLength(JSON.stringify(same));
  assert.ok(sameBytes * 4 < fullBytes, "unchanged page response exceeded its guarded byte budget");
  await call("eval", { tab, expression: "document.querySelector('#row-80').textContent='item 80: approved'" });
  const changed = await call<Snapshot>("snapshot", { tab, since: full.update.revision });
  assert.equal(changed.update.kind, "delta");
  assert.equal(changed.update.baseRevision, full.update.revision);
  const reconstructed = full.snapshot.split("\n");
  for (const edit of [...(changed.update.edits ?? [])].reverse()) reconstructed.splice(edit.start, edit.deleteCount, ...edit.lines);
  const current = await call<Snapshot>("snapshot", { tab, updates: true });
  assert.equal(reconstructed.join("\n"), current.snapshot);
  await call("history", { tab, do: "reload" });
  const reloaded = await call<Snapshot>("snapshot", { tab, since: full.update.revision });
  assert.equal(reloaded.update.kind, "full");
  assert.notEqual(reloaded.update.revision, full.update.revision);
  checked("page updates reconstruct and recover after reload", { fullBytes, unchangedBytes: sameBytes, deltaBytes: Buffer.byteLength(JSON.stringify(changed)) });
  await call("eval", { tab, expression: "document.querySelector('#cover').remove()" });

  const audit = await call<Audit>("audit", { tab, rules: ["label"] });
  assert.equal(audit.ok, true);
  assert.ok(audit.audited.some((frame) => frame.result.violations.some((rule) => rule.id === "label")));
  await call("eval", { tab, expression: "document.querySelector('#missing-label').setAttribute('aria-label','order note')" });
  const fixed = await call<Audit>("audit", { tab, rules: ["label"] });
  assert.equal(fixed.ok, true);
  assert.ok(fixed.audited.every((frame) => !frame.result.violations.some((rule) => rule.id === "label")));
  assert.ok(!JSON.stringify([audit, fixed]).includes("private-form-fixture"));
  checked("real axe findings disappear after the form is fixed");

  const out = `/private/var/tmp/safari-upgrades-${process.pid}.png`;
  await inFront(tab, {
    tabs: async () => (await call<{ tabs: { id: number; windowId?: number; active?: boolean; front?: boolean }[] }>("tabs")).tabs,
    activate: (id) => call("activate", { tab: id }),
  }, async () => {
    for (let run = 0; run < 3; run++) {
      const picture = await call<ConditionalCaptureResult>("shot", { tab, out, ref: "#visual", ifChanged: true });
      if (run === 0) {
        assert.ok(!("unchanged" in picture));
        captures.push(picture);
      } else {
        assert.ok("unchanged" in picture);
        assert.deepEqual(picture.previous, captures[0]);
      }
    }
  });
  assert.equal((await readdir(`${out}.evidence`)).filter((name) => name.startsWith("capture-")).length, 1);
  await verifyEvidence(captures[0].evidence.path);
  checked("identical protected pictures return one image and its original receipt", { captureRequests: 3, returnedImages: captures.length, evidenceBundles: 1 });

  await call("goto", { tab, url: `${origin}/app-checks-react.html` });
  assert.equal((await call<{ result: string }>("eval", { tab, page: true, expression: "typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__" })).result, "undefined");
  await assert.rejects(call("react", { tab, do: "enable" }), /startupScope/);
  await call("react", { tab, do: "enable", startupScope: "host" });
  reactEnabled = true;
  await call("history", { tab, do: "reload" });
  const before = await call<Inspection>("react", { tab, do: "inspect", name: "Counter", includeValues: true });
  assert.equal(before.ok, true);
  assert.equal(before.components[0].hooks.slots[0].value, 1);
  await call("click", { tab, ref: "add one" });
  await call("wait", { tab, text: "items: 2" });
  const after = await call<Inspection>("react", { tab, do: "inspect", name: "Counter", includeValues: true });
  assert.equal(after.components[0].hooks.slots[0].value, 2);
  assert.ok(!JSON.stringify(after).includes("private-react-token-never-output"));
  await call("react", { tab, do: "disable" });
  reactEnabled = false;
  await call("history", { tab, do: "reload" });
  assert.equal((await call<{ result: string }>("eval", { tab, page: true, expression: "typeof window.__REACT_DEVTOOLS_GLOBAL_HOOK__" })).result, "undefined");
  checked("React inspection reads actual updated state and fully revokes on reload");

  await call("goto", { tab, url: `${origin}/site-actions-cooperator.html` });
  assert.equal((await call<{ result: string }>("eval", { tab, page: true, expression: "typeof document.modelContext" })).result, "undefined");
  await call("site_actions", { tab, do: "enable", startupScope: "host" });
  actionsEnabled = true;
  await call("history", { tab, do: "reload" });
  const catalog = await call<{ revision: string; tools: { name: string }[] }>("site_actions", { tab, do: "list" });
  assert.equal(catalog.tools[0].name, "add_item");
  const unchanged = await call<{ changed: boolean }>("site_actions", { tab, do: "list", since: catalog.revision });
  assert.equal(unchanged.changed, false);
  await call("site_actions", { tab, do: "schema", revision: catalog.revision, name: "add_item" });
  await assert.rejects(call("site_actions", { tab, do: "call", revision: catalog.revision, name: "add_item", input: { amount: "3" } }), /schema/);
  const action = await call<{ status: string; result: { total: number; calls: number } }>("site_actions", { tab, do: "call", revision: catalog.revision, name: "add_item", input: { amount: 3 } });
  assert.equal(action.status, "completed");
  assert.deepEqual(action.result, { total: 3, calls: 1 });
  assert.equal((await call<{ result: number }>("eval", { tab, page: true, expression: "siteActionsFixture.calls" })).result, 1);
  await call("site_actions", { tab, do: "disable" });
  actionsEnabled = false;
  await call("history", { tab, do: "reload" });
  assert.equal((await call<{ result: string }>("eval", { tab, page: true, expression: "typeof document.modelContext" })).result, "undefined");
  checked("cooperating website actions validate input, run once and revoke");
  console.log(`${passed} passed; 0 failed; real Safari upgrade scenarios`);
} finally {
  try {
    if (tab !== undefined) {
      try {
        if (reactEnabled) await call("react", { tab, do: "disable" });
        if (actionsEnabled) await call("site_actions", { tab, do: "disable" });
      } finally { await call("close", { tab }); }
    }
  } finally {
    try { await Promise.all(captures.map((capture) => removeCapture(capture.evidence.path))); }
    finally { server.stop(true); }
  }
}
