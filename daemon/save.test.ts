import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
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
connect({
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

test("a saved read summarizes the file's path, page address, byte size, and first 500 characters without returning the full content", async () => {
  const path = join(dir, "reply.txt");
  const reply = await callTool("extract", { tab: 1, save: path });
  expect(reply).toMatchObject({ saved: path, url: "https://shop.example/items", bytes: Buffer.byteLength(TEXT), head: TEXT.slice(0, 500) });
  expect(reply).not.toHaveProperty("text");
  expect(reply).not.toHaveProperty("result");
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

test("a page's error is preserved without reporting or writing a saved file", async () => {
  const path = join(dir, "none.txt");
  const reply = await callTool("extract", { tab: 1, selector: "#none", save: path });
  expect(reply).toMatchObject({ error: "no content root" });
  expect(reply).not.toHaveProperty("saved");
  expect(existsSync(path)).toBe(false);
});

// Saved reads hold signed-in pages' text, so the saved folder keeps a week
// of them. save.ts takes that folder from HOME as it loads, so a process of
// its own with a scratch HOME does each save. Two files there, saved 8 and
// 6 days ago; the save's own path is printed.
const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});
async function saveWithOldFiles(call: string): Promise<{ saved: string; folder: string; path: string }> {
  const home = mkdtempSync(join(tmpdir(), "save-home-"));
  homes.push(home);
  const saved = join(home, ".local/share/safari-harness/saved");
  const folder = join(home, "chosen");
  const day = 24 * 60 * 60;
  const now = Date.now() / 1000;
  for (const dir of [saved, folder]) {
    mkdirSync(dir, { recursive: true });
    for (const [name, days] of [["old.txt", 8], ["recent.txt", 6]] as const) {
      writeFileSync(join(dir, name), "page text");
      utimesSync(join(dir, name), now - days * day, now - days * day);
    }
  }
  const script = `const save = await import(${JSON.stringify(join(import.meta.dir, "save.ts"))});
const folder = ${JSON.stringify(folder)};
console.log(${call});`;
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "inherit" });
  const path = (await new Response(proc.stdout).text()).trim();
  return { saved, folder, path };
}

test("a read saved to the saved folder deletes the reads saved there over a week ago, and keeps the rest", async () => {
  const { saved, path } = await saveWithOldFiles(`await save.saveAnswer("new")`);
  expect(readdirSync(saved).sort()).toEqual([basename(path), "recent.txt"].sort());
});

test("a read saved to a folder the caller named leaves that folder's old files alone", async () => {
  const { folder, path } = await saveWithOldFiles(`(await save.saveOutput("extract", { text: "new", url: "https://shop.example/" }, { dir: folder }, async () => "")).saved`);
  expect(readdirSync(folder).sort()).toEqual([basename(path), "old.txt", "recent.txt"].sort());
});

// The daemon's folder is not the caller's; and a request that changes
// something must not be sent for a save that cannot happen.
test("a save path that is not absolute is refused before the page gets any request", async () => {
  asked.length = 0;
  const post = callTool("fetch", { tab: 1, url: "https://shop.example/api/order", method: "POST", body: "{}", save: "order.json" });
  await expect(post).rejects.toThrow("save must be true or an absolute file path");
  expect(asked).toEqual([]);
});
