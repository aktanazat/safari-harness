import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { callTool } from "./tools.ts";

// A page longer than the 20,000 characters extract answers with by default,
// with characters UTF-8 writes in two bytes.
const TEXT = Array.from({ length: 3000 }, (_, i) => `line ${i}: café`).join("\n");
const VALUES: Record<string, unknown> = { html: "<p>hi</p>", rows: [{ a: 1 }] };

// A stand-in extension for tab 1, cutting text the way content.js does. The
// ops the page is asked to run are noted.
const asked: string[] = [];
function answer(op: string, args: unknown[]): unknown {
  if (op !== "relay") return [];
  const [, dom, [opts]] = args as [number, string, [Record<string, unknown>]];
  asked.push(dom);
  if (dom === "extract") {
    if (opts.selector === "#none") return { error: "no content root" };
    const limit = Number(opts.maxBytes) || 20000;
    return { url: "https://shop.example/items", title: "Items", text: TEXT.length > limit ? `${TEXT.slice(0, limit)}\n…truncated` : TEXT, truncated: TEXT.length > limit };
  }
  if (dom === "eval") return { ok: true, result: VALUES[String(opts)] };
  return { status: 200, url: "https://shop.example/api", type: "application/json", text: "{}", truncated: false };
}
bridge.attach({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    bridge.handleMessage(JSON.stringify({ id, value: answer(op, args) }));
  },
  close() {},
});

const dir = mkdtempSync(join(tmpdir(), "save-"));

test("a saved read holds the whole output, past the limit a reply is cut at", async () => {
  const path = join(dir, "whole.txt");
  await callTool("extract", { tab: 1, save: path });
  expect(readFileSync(path, "utf8")).toBe(TEXT);
});

test("a saved read answers with only the file's path, its size in bytes, and its first 500 characters", async () => {
  const path = join(dir, "reply.txt");
  expect(await callTool("extract", { tab: 1, save: path })).toEqual({ saved: path, bytes: Buffer.byteLength(TEXT), head: TEXT.slice(0, 500) });
});

test("an expression's string value is saved as its text, any other value as JSON", async () => {
  const [html, rows, none] = [join(dir, "page.html"), join(dir, "rows.json"), join(dir, "none.json")];
  await callTool("eval", { tab: 1, expression: "html", save: html });
  await callTool("eval", { tab: 1, expression: "rows", save: rows });
  await callTool("eval", { tab: 1, expression: "none", save: none });
  expect(readFileSync(html, "utf8")).toBe("<p>hi</p>");
  expect(JSON.parse(readFileSync(rows, "utf8"))).toEqual([{ a: 1 }]);
  expect(JSON.parse(readFileSync(none, "utf8"))).toBeNull();
});

test("an error the page answers with comes back as it is, and no file is written", async () => {
  const path = join(dir, "none.txt");
  expect(await callTool("extract", { tab: 1, selector: "#none", save: path })).toEqual({ error: "no content root" });
  expect(existsSync(path)).toBe(false);
});

// The daemon's folder is not the caller's; and a request that changes
// something must not be sent for a save that cannot happen.
test("a save path that is not absolute is refused before the page gets any request", async () => {
  asked.length = 0;
  const post = callTool("fetch", { tab: 1, url: "https://shop.example/api/order", method: "POST", body: "{}", save: "order.json" });
  await expect(post).rejects.toThrow("save must be true or an absolute file path");
  expect(asked).toEqual([]);
});
