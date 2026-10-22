import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runner } from "./bench.ts";

const ROOT = join(import.meta.dir, "..");
const fixture = readFileSync(join(import.meta.dir, "fixtures", "site-actions-cooperator.html"), "utf8");
const existingAPI = readFileSync(join(import.meta.dir, "fixtures", "site-actions-existing-api.html"), "utf8");
const factory = readFileSync(join(ROOT, "extension", "site-actions.js"), "utf8");
type Request = { pageEval: string } | { siteActions: { method: string; args?: unknown[] } };

// Uses the shipping page factory in WebKit, not a simulated DOM. The bench's
// pageEval operation only prepares/observes this local cooperating website.
async function page(requests: Request[], enabled = true, existing = false): Promise<unknown[]> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new URL(request.url).pathname === "/site-actions-source.js"
      ? new Response(factory, { headers: { "Content-Type": "text/javascript" } })
      : new Response(existing ? existingAPI : fixture, { headers: { "Content-Type": "text/html" } }),
  });
  const proc = Bun.spawn([runner, join(ROOT, "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    proc.stdin.write([{ load: `http://127.0.0.1:${server.port}/site-actions-cooperator.html`, siteActions: enabled }, ...requests].map((request) => JSON.stringify(request) + "\n").join(""));
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`site action WebKit bench exited ${code}: ${stderr}`);
    return stdout.trim().split("\n").slice(1).map((line) => JSON.parse(line) as unknown);
  } finally {
    proc.kill();
    server.stop(true);
  }
}

describe.skipIf(!runner)("opt-in site action compatibility in WebKit", () => {
  test("an opted-out page retains its original absent document and navigator APIs", async () => {
    expect(await page([{ pageEval: "return {documentAPI: typeof document.modelContext, navigatorAPI: typeof navigator.modelContext, calls: siteActionsFixture.calls}" }], false)).toEqual([
      { value: { documentAPI: "undefined", navigatorAPI: "undefined", calls: 0 } },
    ]);
  });

  test("an existing document or navigator API is preserved instead of being replaced", async () => {
    expect(await page([{ pageEval: "return existingAPICheck" }], false, true)).toEqual([
      { value: { result: { status: "unavailable", reason: "existing_api_untouched" }, documentPreserved: true, navigatorPreserved: true, behavior: "existing implementation" } },
    ]);
  });

  test("a cooperating page discovers only compact metadata and can request one schema", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; const catalog = __safariHarnessSiteActions.catalog(); return {catalog, schema: __safariHarnessSiteActions.schema({revision:catalog.revision,name:'add_item'})}" },
    ])).toMatchObject([
      { value: { catalog: { status: "available", frame: "top", tools: [{ name: "add_item", description: expect.any(String) }] }, schema: { status: "available", name: "add_item", inputSchema: { properties: { amount: { minimum: 1 } } } } } },
    ]);
    const [reply] = await page([{ siteActions: { method: "catalog" } }]);
    expect(JSON.stringify(reply)).not.toContain("inputSchema");
  });

  test("an explicit invocation performs its actual callback once and rejects the same invocation id", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; const revision = __safariHarnessSiteActions.catalog().revision; const request = {revision,name:'add_item',input:{amount:3},callId:'one-action'}; const first = await __safariHarnessSiteActions.invoke(request); const second = await __safariHarnessSiteActions.invoke(request); return {first,second,total:siteActionsFixture.total,calls:siteActionsFixture.calls,text:document.getElementById('result').textContent}" },
    ])).toMatchObject([
      { value: { first: { status: "completed", result: { total: 3, calls: 1 } }, second: { status: "refused", reason: "invalid_or_repeated_call" }, total: 3, calls: 1, text: "3 items from 1 actions" } },
    ]);
  });

  test("a schema-only replacement changes the revision and refuses the old selection", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; const before = __safariHarnessSiteActions.catalog().revision; await siteActionsFixture.register(5); const after = __safariHarnessSiteActions.catalog().revision; return {changed:before!==after, old:await __safariHarnessSiteActions.invoke({revision:before,name:'add_item',input:{amount:1},callId:'stale-action'}), schema:__safariHarnessSiteActions.schema({revision:after,name:'add_item'}), calls:siteActionsFixture.calls}" },
    ])).toMatchObject([
      { value: { changed: true, old: { status: "refused", reason: "stale_catalog" }, schema: { inputSchema: { properties: { amount: { minimum: 5 } } } }, calls: 0 } },
    ]);
  });

  test("duplicate registration rejects without replacing the original action schema", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; let error; try { await document.modelContext.registerTool({name:'add_item',description:'Replacement attempt',inputSchema:{type:'object'},execute:()=>999}); } catch (failure) { error=failure.name; } const catalog = __safariHarnessSiteActions.catalog(); return {error,schema:__safariHarnessSiteActions.schema({revision:catalog.revision,name:'add_item'}),calls:siteActionsFixture.calls}" },
    ])).toMatchObject([{ value: { error: "InvalidStateError", schema: { inputSchema: { properties: { amount: { minimum: 1 } } } }, calls: 0 } }]);
  });

  test("aborting registration removes the tool without cancelling a previously started callback", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; await siteActionsFixture.registerPending(); const controller = new AbortController(); await document.modelContext.registerTool({name:'independent',description:'Pending independent change',execute:()=>new Promise(resolve=>{siteActionsFixture.finish=resolve})},{signal:controller.signal}); const catalog = __safariHarnessSiteActions.catalog(); const result = __safariHarnessSiteActions.invoke({revision:catalog.revision,name:'independent',input:{},callId:'independent-action'}); await Promise.resolve(); controller.abort(); siteActionsFixture.finish('finished'); return {result:await result,names:__safariHarnessSiteActions.catalog().tools.map(t=>t.name)}" },
    ])).toMatchObject([
      { value: { result: { status: "completed", result: "finished" }, names: ["add_item", "pending_item"] } },
    ]);
  });

  test("legacy provide replaces the registry, unregister removes a name, and clear removes all tools", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; const tool = name=>({name,description:'Legacy cooperating action',execute:()=>name}); navigator.modelContext.provideContext({tools:[tool('legacy_one'),tool('legacy_two')]}); const provided = __safariHarnessSiteActions.catalog().tools.map(t=>t.name); navigator.modelContext.unregisterTool('legacy_one'); const removed = __safariHarnessSiteActions.catalog().tools.map(t=>t.name); navigator.modelContext.clearContext(); return {provided,removed,cleared:__safariHarnessSiteActions.catalog().tools}" },
    ])).toEqual([{ value: { provided: ["legacy_one", "legacy_two"], removed: ["legacy_two"], cleared: [] } }]);
  });

  test("a legacy request for approval never executes its UI callback or fabricates consent", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; let interactionError; navigator.modelContext.registerTool({name:'legacy_approval',description:'Requires a separate human step',execute:async(_input,agent)=>{try {await agent.requestUserInteraction(()=>{siteActionsFixture.total++;return true})} catch(error) {interactionError=error.name;throw error}}}); const revision=__safariHarnessSiteActions.catalog().revision; const result=await __safariHarnessSiteActions.invoke({revision,name:'legacy_approval',input:{},callId:'legacy-approval'}); return {result,interactionError,total:siteActionsFixture.total}" },
    ])).toMatchObject([{ value: { result: { status: "unknown", retry: false }, interactionError: "NotSupportedError", total: 0 } }]);
  });

  test("cancelling an in-flight callback is unknown, propagates abort, and forbids another action", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; await siteActionsFixture.registerPending(); const revision = __safariHarnessSiteActions.catalog().revision; const pending = __safariHarnessSiteActions.invoke({revision,name:'pending_item',input:{},callId:'cancelled-action'}); await Promise.resolve(); const cancelled = __safariHarnessSiteActions.cancel('cancelled-action'); const result = await pending; const next = await __safariHarnessSiteActions.invoke({revision,name:'add_item',input:{amount:1},callId:'not-a-retry'}); siteActionsFixture.finish('late'); return {cancelled,result,next,aborted:siteActionsFixture.aborted,calls:siteActionsFixture.calls,total:siteActionsFixture.total}" },
    ])).toMatchObject([
      { value: { cancelled: { status: "unknown", retry: false }, result: { status: "unknown", retry: false }, next: { status: "refused", reason: "previous_action_outcome_unknown_reload_required" }, aborted: true, calls: 1, total: 0 } },
    ]);
  });

  test("ending a document cancels pending work as unknown and cannot invoke an old callback", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; await siteActionsFixture.registerPending(); const revision = __safariHarnessSiteActions.catalog().revision; const pending = __safariHarnessSiteActions.invoke({revision,name:'pending_item',input:{},callId:'ended-action'}); await Promise.resolve(); __safariHarnessSiteActions.dispose(); const result = await pending; const old = await __safariHarnessSiteActions.invoke({revision,name:'add_item',input:{amount:1},callId:'old-document'}); siteActionsFixture.finish('late'); return {result,old,calls:siteActionsFixture.calls,aborted:siteActionsFixture.aborted}" },
    ])).toMatchObject([{ value: { result: { status: "unknown", retry: false }, old: { status: "refused", reason: "document_ended" }, calls: 1, aborted: true } }]);
  });

  test("the current document API exposes copied schemas and executes a discovered local tool", async () => {
    expect(await page([
      { pageEval: "await siteActionsReady; const tools = await document.modelContext.getTools(); tools[0].inputSchema.properties.amount.minimum=99; const fresh = await document.modelContext.getTools(); return {minimum:fresh[0].inputSchema.properties.amount.minimum,result:JSON.parse(await document.modelContext.executeTool(fresh[0],{amount:2})),total:siteActionsFixture.total}" },
    ])).toEqual([{ value: { minimum: 1, result: { total: 2, calls: 1 }, total: 2 } }]);
  });
});
