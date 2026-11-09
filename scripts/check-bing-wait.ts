import { invoke, type Invoke } from "../daemon/call.ts";
import { ownCalls } from "../daemon/rpc.ts";
import { bingSearch } from "../daemon/sites/bing-search.ts";
import { SiteKit } from "../daemon/sites/kit.ts";

ownCalls();
const pageWorld = process.argv[2] === "page";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response('<!doctype html><title>search wait fixture</title><main id="b_results"></main>', { headers: { "content-type": "text/html" } });
  },
});
const send: Invoke = async (tool, args, model) => {
  if (tool === "open" || tool === "goto") {
    const query = new URL(String(args.url)).searchParams;
    return invoke(tool, { ...args, url: `http://127.0.0.1:${server.port}/?${query}` }, model);
  }
  if (tool === "eval") {
    const state = await invoke("eval", { tab: args.tab, expression: "document.hidden", read: true }) as { result: boolean };
    if (state.result !== true) throw new Error("the fixture must be hidden to check the background reader");
    return invoke(tool, { ...args, page: pageWorld, timeoutMs: 10000 }, model);
  }
  return invoke(tool, args, model);
};
const kit = new SiteKit(send);
try {
  const page = await bingSearch(kit).search("hidden reader fixture");
  if (page.query !== "hidden reader fixture" || page.results.length !== 0) throw new Error("the empty fixture returned an unexpected search result");
  console.log(`hidden bing reader (${pageWorld ? "page" : "extension"} world): passed; the empty page completed inside the eval limit`);
} catch (error) {
  console.error(`hidden bing reader: failed; ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await kit.close();
  server.stop(true);
}
