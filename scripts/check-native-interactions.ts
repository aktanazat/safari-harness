import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { INPUT_TOOLS } from "../daemon/input.ts";
import { ownCalls, rpc } from "../daemon/rpc.ts";
import { ReplSession } from "../daemon/repl.ts";

ownCalls();
const html = await readFile(join(import.meta.dir, "..", "bench", "fixtures", "native-interactions.html"), "utf8");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(html, { headers: { "content-type": "text/html" } }); } });
let tab: number | undefined;
const repl = new ReplSession("native-interactions-smoke", { cwd: join(import.meta.dir, ".."), quiet: true });
let passed = 0;
function checked(scenario: string) {
  passed++;
  console.log(JSON.stringify({ pass: scenario }));
}
async function evaluate<T>(expression: string): Promise<T> {
  const reply = await rpc("eval", { tab, expression, page: true }) as { result: T };
  return reply.result;
}
try {
  const opened = await rpc("open", { url: `http://127.0.0.1:${server.port}`, background: true, new: true });
  if (!opened || typeof opened !== "object" || !("id" in opened) || typeof opened.id !== "number") throw new Error("the fixture tab did not open");
  tab = opened.id;
  await rpc("snapshot", { tab });
  const dragged = await repl.run(`var nativePage = (await getTabs()).find(p => p.id === ${tab}); if (!nativePage) throw new Error("owned fixture page missing"); await nativePage.locator("#card").dragTo(nativePage.locator("#drop"));`);
  assert.equal(dragged.error, undefined, dragged.error);
  assert.deepEqual(await evaluate("({dropped:document.body.dataset.dropped,drag:document.body.dataset.dragTrusted,drop:document.body.dataset.dropTrusted,parent:document.querySelector('#card').parentElement.id})"), { dropped: "true", drag: "true", drop: "true", parent: "drop" });
  checked("the REPL sends a trusted native drag that moves an HTML draggable into its drop target");

  await rpc("snapshot", { tab });
  const points = await evaluate<{ x: number; y: number; targetX: number; targetY: number }>("(()=>{const r=document.querySelector('#drawing').getBoundingClientRect();return {x:r.left+30,y:r.top+30,targetX:r.left+400,targetY:r.top+60}})()");
  await INPUT_TOOLS.real_input.run({ tab, do: "drag", ...points });
  const drawing = await evaluate<{ points: number; released: string; trusted: string }>("({points:Number(document.body.dataset.drawPoints),released:document.body.dataset.drawReleased,trusted:document.body.dataset.drawTrusted})");
  assert.ok(drawing.points >= 2);
  assert.equal(drawing.released, "true");
  assert.equal(drawing.trusted, "true");
  checked("a trusted coordinate drag draws a path and releases the mouse");

  await rpc("snapshot", { tab });
  await assert.rejects(INPUT_TOOLS.real_input.run({ tab, do: "drag", ref: "#covered", target: "#drop" }), /covered|visible/);
  await assert.rejects(INPUT_TOOLS.real_input.run({ tab, do: "drag", ref: "#offscreen", target: "#drop" }), /visible|viewport|offscreen/);
  assert.equal(await evaluate("window.scrollY"), 0);
  checked("covered and offscreen drag endpoints refuse without scrolling");

  const text = "name\tamount\nada\t42";
  const table = "<table><tbody><tr><th>name</th><th>amount</th></tr><tr><td>ada</td><td>42</td></tr></tbody></table>";
  await rpc("snapshot", { tab });
  const pasted = await repl.run(`await nativePage.locator("#editor").paste(${JSON.stringify(text)}, ${JSON.stringify({ html: table, tsv: text })});`);
  assert.equal(pasted.error, undefined, pasted.error);
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#editor table tr'),row=>Array.from(row.cells,cell=>cell.textContent))"), [["name", "amount"], ["ada", "42"]]);
  assert.equal(await evaluate("document.body.dataset.pasteTrusted"), "true");
  checked("the REPL natively pastes the supplied table into the actual contenteditable editor");

  await evaluate("(()=>{document.querySelector('#editor').replaceChildren(); document.querySelector('#editor').focus(); document.body.dataset.delayPaste='true';})()");
  await rpc("snapshot", { tab });
  await INPUT_TOOLS.real_input.run({ tab, do: "paste", text: "delayed native paste" });
  assert.equal(await evaluate("document.querySelector('#editor').innerText"), "delayed native paste");
  assert.equal(await evaluate("document.body.dataset.delayedPasteHandled"), "true");
  checked("paste retains its clipboard until Safari processes a deliberately delayed paste command");

  await rpc("snapshot", { tab });
  await assert.rejects(INPUT_TOOLS.real_input.run({ tab, do: "paste", ref: "#password", text: "fixture-only" }), /password/);
  assert.equal(await evaluate("document.querySelector('#password').value"), "");
  checked("the new paste surface refuses password fields");
  console.log(`${passed} passed; 0 failed; real Safari native interaction scenarios`);
} finally {
  try { if (tab !== undefined) await rpc("close", { tab }); }
  finally { try { await repl.close(); } finally { server.stop(true); } }
}
