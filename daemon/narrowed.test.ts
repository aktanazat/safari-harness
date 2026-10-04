import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool, formatResult } from "./tools.ts";

// A sign-in page with no <main>. Its script answers a root or selector
// that matches nothing as content.js does (noMatch), and a read of the
// whole page with the page; the extension finds nothing else.
const PAGE = { url: "https://shop.example/login", title: "Sign in" };
type Read = { root?: string; selector?: string };
function read(dom: string, opts: Read) {
  const option = opts.root !== undefined ? "root" : opts.selector !== undefined ? "selector" : undefined;
  if (option !== undefined) return { error: `nothing on the page matches ${option} "${opts[option]}"; leave ${option} out to read the whole page` };
  return { value: dom === "snapshot" ? { ...PAGE, nodes: 1, truncated: false, snapshot: '[1] button "Sign in"' } : { ...PAGE, text: "Sign in", truncated: false } };
}
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: [number, string, [Read]] };
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...(op === "relay" ? read(args[1], args[2][0]) : { value: [] }) })));
  },
  close() {},
});

// On 10-04 three reads named a root or selector "main" a page did not
// have; two next calls read the page without it.
test("a snapshot root or extract selector that matches nothing reads the whole page and says so", async () => {
  expect(formatResult(await callTool("snapshot", { tab: 7, root: "main" }))).toBe('# Sign in — https://shop.example/login (1 nodes)\n[1] button "Sign in"\nnote: nothing on the page matches root "main", so this is the whole page');
  expect(formatResult(await callTool("extract", { tab: 7, selector: "main" }))).toBe('# Sign in — https://shop.example/login\n\nSign in\nnote: nothing on the page matches selector "main", so this is the whole page');
});
