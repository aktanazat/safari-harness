// How long type, select and a click with no reaction wait in real Safari,
// and whether a page that rejects the input is still reported, for one or
// more copies of extension/. Safari is driven by safaridriver (WebDriver):
// dialogs.js, start.js and content.js run unmodified, all in the page's
// world, over the bench's runtime shim (scripts/bench.swift).
//
// Why the waits are still fixed (2026-11-18): a draft answered as soon as the
// page's world showed nothing outstanding (timers, frames, requests, loads,
// ports, sockets). On a page with none of those it answered in about 55 ms
// instead of 300 to 455 ms. It also answered kept: true for input the page
// then took back through work the page's world cannot see: a dynamic
// import() (syntax, so no wrapper can count it), WebCrypto, IndexedDB and a
// service worker's message. The fixed wait gets all four right. The draft is
// commit fe49dd4 (branch devin/1795049473-faster-type-select-waits); to
// measure it against a checkout:
//   git worktree add /tmp/draft fe49dd4
//   bun bench/waits-safari.ts original=extension draft=/tmp/draft/extension
// The run exits 1 when a later copy answers any cell worse than the first.
//
//   sudo safaridriver --enable && safaridriver -p 4444 &
//   bun bench/waits-safari.ts name=path/to/extension [name=path ...] [--reps 5] [--samples 20] [--out file.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const reps = Number(flag("--reps", "5"));
const samples = Number(flag("--samples", "20"));
const out = flag("--out", "");
const driver = flag("--driver", "http://127.0.0.1:4444");
const variants = new Map(args.map((a) => { const [name, dir] = a.split("="); return [name, resolve(dir)] as const; }));
if (!variants.size) variants.set("checkout", join(ROOT, "extension"));

const shim = readFileSync(join(ROOT, "scripts/bench.swift"), "utf8").split('let runtimeShim = #"""')[1].split('"""#')[0];
const bridge = "window.webkit={messageHandlers:{bench:{postMessage:()=>{}},benchStart:{postMessage:()=>Promise.resolve({content:true,dialogs:{accept:false,text:null},tab:1,window:1})}}};";
const fixture = readFileSync(join(import.meta.dir, "fixtures/settlement.html"), "utf8");
const js = { headers: { "Content-Type": "text/javascript" } };
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req, server) {
    const url = new URL(req.url);
    const [, kind, variant, file] = url.pathname.split("/");
    if (kind === "socket") return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
    if (kind === "ext" && variants.has(variant) && ["dialogs.js", "start.js", "content.js"].includes(file)) return new Response(readFileSync(join(variants.get(variant)!, file), "utf8"), js);
    if (kind === "shim.js") return new Response(bridge + shim, js);
    if (kind === "late.js") { await Bun.sleep(150); return new Response("export {};", js); }
    if (kind === "sw.js") return new Response("oninstall=()=>skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onmessage=e=>setTimeout(()=>e.source.postMessage('no'),150);", js);
    if (kind === "answer") {
      if (url.searchParams.get("mode") === "body") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("start"));
            setTimeout(() => { controller.enqueue(new TextEncoder().encode("end")); controller.close(); }, 200);
          },
        }));
      }
      await Bun.sleep(150);
      return new Response("done");
    }
    if (kind === "page" && variants.has(variant)) {
      const head = `<script src="/ext/${variant}/dialogs.js"></script><script src="/shim.js"></script>`;
      const tail = `<script src="/ext/${variant}/start.js"></script><script src="/ext/${variant}/content.js"></script>`;
      return new Response(fixture.replace("<!doctype html>", `<!doctype html>${head}`) + tail, { headers: { "Content-Type": "text/html" } });
    }
    return new Response(null, { status: 404 });
  },
  websocket: { message(ws) { setTimeout(() => ws.send("no"), 150); } },
});

const created = await (await fetch(`${driver}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "safari" } } }) })).json() as any;
const session = created.value?.sessionId;
if (!session) throw new Error(`no WebDriver session: ${JSON.stringify(created)}`);
async function wd(path: string, body: unknown) {
  const r = await fetch(`${driver}/session/${session}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json() as any;
  if (data.value?.error) throw new Error(JSON.stringify(data.value));
  return data.value;
}
async function inPage(variant: string, mode: string, fn: (...a: any[]) => Promise<unknown>, ...fnArgs: unknown[]) {
  await wd("/url", { url: `http://127.0.0.1:${server.port}/page/${variant}?mode=${mode}` });
  const answer = await wd("/execute/async", { script: `const done=arguments[arguments.length-1];(${fn.toString()})(...arguments[0]).then(value=>done({value}),e=>done({error:String(e.stack||e)}));`, args: [fnArgs] });
  if (answer.error) throw new Error(`${variant} ${mode}: ${answer.error}`);
  return answer.value;
}

// One page load: a type, a select that changes the value and one that does
// not, each followed by what the page had done to the control 700 ms later.
async function reject() {
  const w = window as any;
  let id = 20000;
  const send = (op: string, a: unknown[]) => w.__benchSend(JSON.stringify({ __safariHarness: 1, id: ++id, op, args: a })).then(JSON.parse);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const field = document.querySelector("#field") as HTMLInputElement;
  const choice = document.querySelector("#choice") as HTMLSelectElement;
  await w.ready;
  await sleep(300);
  const timed = async (op: string, a: unknown[]) => { const t = performance.now(); const reply = await send(op, a); return { reply, ms: performance.now() - t }; };
  w.prepare();
  const typed = await timed("type", ["#field", "sample"]);
  await sleep(700);
  const afterType = field.value;
  w.prepare();
  const changed = await timed("select", ["#choice", "B"]);
  await sleep(700);
  const afterChanged = choice.value;
  choice.value = "B";
  w.prepare();
  const unchanged = await timed("select", ["#choice", "B"]);
  await sleep(700);
  return {
    type: { ms: typed.ms, kept: typed.reply.value?.kept, rejected: afterType !== "sample" },
    select_changed: { ms: changed.ms, states: changed.reply.value?.receipt?.states?.length, rejected: afterChanged !== "B" },
    select_unchanged: { ms: unchanged.ms, states: unchanged.reply.value?.receipt?.states?.length, rejected: choice.value !== "B" },
  };
}

// The time from sending an action to its answer, n times on one page.
async function time(n: number) {
  const w = window as any;
  let id = 10000;
  const send = (op: string, a: unknown[]) => w.__benchSend(JSON.stringify({ __safariHarness: 1, id: ++id, op, args: a })).then(JSON.parse);
  const field = document.querySelector("#field") as HTMLInputElement;
  const choice = document.querySelector("#choice") as HTMLSelectElement;
  const cases = [
    { name: "type", op: "type", args: (i: number) => ["#field", `sample-${i}`], setup: () => { field.value = ""; }, ok: (r: any) => r.value?.kept === true },
    { name: "select_changed", op: "select", args: () => ["#choice", "B"], setup: () => { choice.value = "A"; }, ok: (r: any) => r.value?.ok === true && choice.value === "B" },
    { name: "select_unchanged", op: "select", args: () => ["#choice", "B"], setup: () => { choice.value = "B"; }, ok: (r: any) => r.value?.ok === true && choice.value === "B" },
    { name: "idle_click", op: "click", args: () => ["#noop"], setup: () => {}, ok: (r: any) => r.value?.ok === true },
  ];
  const result: Record<string, number[]> = {};
  await new Promise((r) => setTimeout(r, 300));
  for (const c of cases) {
    result[c.name] = [];
    for (let i = 0; i < n; i++) {
      c.setup();
      await new Promise((r) => setTimeout(r, 50));
      const t = performance.now();
      const reply = await send(c.op, c.args(i));
      const ms = performance.now() - t;
      if (!c.ok(reply)) throw new Error(`${c.name} ${i}: ${JSON.stringify(reply)}`);
      result[c.name].push(+ms.toFixed(1));
    }
  }
  return { userAgent: navigator.userAgent, visibility: document.visibilityState, result };
}

const modes = ["sync", "microtask", "0", "50", "150", "200", "string", "raf", "idle", "fetch", "body", "xhr", "img", "preexisting", "prefetch", "transition", "waapi", "interval", "channel", "ws", "iframe", "import", "crypto", "idb", "sw"];
const median = (list: number[]) => { const s = [...list].sort((a, b) => a - b); return +((s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2).toFixed(1); };
const report: any = { reps, samples, timing: {}, rejection: {} };
try {
  await wd("/timeouts", { script: 120000 });
  for (const page of ["quiet", "quietchannel"]) {
    for (const variant of variants.keys()) {
      const t = await inPage(variant, page, time, samples) as any;
      report.userAgent = t.userAgent;
      report.timing[`${page}/${variant}`] = t.result;
      for (const [name, list] of Object.entries(t.result as Record<string, number[]>)) {
        console.log(`TIME ${page.padEnd(12)} ${variant.padEnd(9)} ${name.padEnd(17)} n=${list.length} median=${median(list)} ms min=${Math.min(...list)} max=${Math.max(...list)} (${t.visibility})`);
      }
    }
  }
  // An answer is right when it says what the page did: kept is false for a
  // type the page rewrote; a select's receipt shows the control's state
  // changed exactly when the value ended other than it began.
  const right = (op: string, r: any) => op === "type" ? r.kept === !r.rejected : (r.states > 0) === (op === "select_changed" ? !r.rejected : r.rejected);
  for (const mode of modes) {
    for (const op of ["type", "select_changed", "select_unchanged"]) report.rejection[`${mode}/${op}`] = {};
    for (const variant of variants.keys()) {
      const runs: any[] = [];
      for (let i = 0; i < reps; i++) runs.push(await inPage(variant, mode, reject));
      for (const op of ["type", "select_changed", "select_unchanged"]) {
        const rows = runs.map((r) => r[op]);
        const cell = { rejected: rows.filter((r) => r.rejected).length, right: rows.filter((r) => right(op, r)).length, median_ms: median(rows.map((r) => r.ms)) };
        report.rejection[`${mode}/${op}`][variant] = cell;
        console.log(`REJECT ${mode.padEnd(11)} ${op.padEnd(17)} ${variant.padEnd(9)} page rejected ${cell.rejected}/${reps}, answer right ${cell.right}/${reps}, median ${cell.median_ms} ms`);
      }
    }
  }
  const names = [...variants.keys()];
  let worse = 0;
  for (const [key, cells] of Object.entries(report.rejection as Record<string, Record<string, any>>)) {
    for (const name of names.slice(1)) if (cells[name].right < cells[names[0]].right) { worse++; console.log(`WORSE ${key}: ${names[0]} right ${cells[names[0]].right}/${reps}, ${name} right ${cells[name].right}/${reps}`); }
  }
  console.log(`${report.userAgent}`);
  console.log(worse ? `${worse} cells answered worse than ${names[0]}` : `no cell answered worse than ${names[0]}`);
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  process.exitCode = worse ? 1 : 0;
} finally {
  await fetch(`${driver}/session/${session}`, { method: "DELETE" }).catch(() => {});
  server.stop(true);
}
