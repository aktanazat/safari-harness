import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool, formatResult } from "./tools.ts";

// A page longer than the 20,000 characters extract answers with by default,
// with characters UTF-8 writes in two bytes.
const TEXT = Array.from({ length: 3000 }, (_, i) => `line ${i}: café`).join("\n");
const VALUES: Record<string, unknown> = { html: "<p>hi</p>", rows: [{ a: 1 }] };
// An API that answers its rate limit.
const LIMITED = "https://shop.example/api/limited";
const LIMITED_BODY = '{"error":"rate limited"}';

// The page's text as content.js answers extract: up to the reply's limit
// (maxBytes), or on to whole for the saved folder, with the whole's length
// when it is past the limit.
function extractOf(opts: Record<string, unknown>) {
  const limit = Number(opts.maxBytes) || 20000;
  return { url: "https://shop.example/items", title: "Items", text: TEXT.slice(0, Math.max(limit, Number(opts.whole) || 0)), truncated: TEXT.length > limit, ...(TEXT.length > limit ? { total: TEXT.length } : {}) };
}

// A stand-in extension for tab 1. The ops the page is asked to run are
// noted.
const asked: string[] = [];
function answer(op: string, args: unknown[]): unknown {
  if (op !== "relay") return [];
  const [, dom, [opts]] = args as [number, string, [Record<string, unknown>]];
  asked.push(dom);
  if (dom === "extract") return opts.selector === "#none" ? { error: "no content root" } : extractOf(opts);
  if (dom === "eval") return { ok: true, result: VALUES[String(opts)] };
  if (opts === LIMITED) return { status: 429, url: LIMITED, type: "application/json", text: LIMITED_BODY, truncated: false };
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

// A read past the reply's limit saves to the saved folder unasked, so it
// runs in a process of its own with a scratch HOME, against the same page;
// it prints the reply and the saved folder's files.
async function readInScratchHome(args: Record<string, unknown>): Promise<{ reply: Record<string, unknown>; files: string[] }> {
  const home = mkdtempSync(join(tmpdir(), "save-home-"));
  homes.push(home);
  const at = (file: string) => JSON.stringify(join(import.meta.dir, file));
  const code = `import { bridge } from ${at("bridge.ts")};
import { connect } from ${at("fake-safari.ts")};
import { callTool } from ${at("tools.ts")};
import { SAVED_DIR } from ${at("save.ts")};
import { existsSync, readdirSync } from "node:fs";
const TEXT = ${JSON.stringify(TEXT)};
const extractOf = ${extractOf.toString()};
connect({ send(data) { const { id, op, args } = JSON.parse(data); bridge.handleMessage(JSON.stringify({ id, value: op === "relay" ? extractOf(args[2][0]) : [] })); }, close() {} });
const reply = await callTool("extract", ${JSON.stringify(args)});
console.log(JSON.stringify({ reply, files: existsSync(SAVED_DIR) ? readdirSync(SAVED_DIR) : [] }));`;
  const proc = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "inherit" });
  return JSON.parse(await new Response(proc.stdout).text());
}

// On 10-29 default reads kept 3.8 to 21.7% of long pages, and said only
// that they were cut.
test("a read past the reply's limit answers with its start and the whole text's length, and saves all of it where the reply says", async () => {
  const { reply, files } = await readInScratchHome({ tab: 1 });
  expect(reply).toMatchObject({ text: TEXT.slice(0, 20000), truncated: true, total: TEXT.length });
  expect(files).toEqual([basename(String(reply.saved))]);
  expect(readFileSync(String(reply.saved), "utf8")).toBe(TEXT);
  expect(formatResult(reply)).toContain(String(reply.saved));
});

// secret.ts reads the page that shows a sign-in code so: the code must
// never reach a file.
test("a read with save: false past the limit is cut, and writes nothing", async () => {
  const { reply, files } = await readInScratchHome({ tab: 1, save: false });
  expect(reply).toMatchObject({ text: TEXT.slice(0, 20000), truncated: true });
  expect(reply).not.toHaveProperty("saved");
  expect(files).toEqual([]);
});

// The daemon's folder is not the caller's; and a request that changes
// something must not be sent for a save that cannot happen.
test("a save path that is not absolute is refused before the page gets any request", async () => {
  asked.length = 0;
  const post = callTool("fetch", { tab: 1, url: "https://shop.example/api/order", method: "POST", body: "{}", save: "order.json" });
  await expect(post).rejects.toThrow("save must be true or an absolute file path");
  expect(asked).toEqual([]);
});

// On 10-23 saved reads of three pages not found and of an API's rate limit
// answered like any other (K4).
test("a saved read keeps the page's status, type, and state: an API's rate limit is saved, and says it is an error", async () => {
  const path = join(dir, "limited.json");
  const reply = await callTool("fetch", { tab: 1, url: LIMITED, save: path });
  expect(reply).toMatchObject({ saved: path, status: 429, type: "application/json", pageState: { kind: "error" } });
  expect(readFileSync(path, "utf8")).toBe(LIMITED_BODY);
});
