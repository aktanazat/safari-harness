import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { callTool } from "./tools.ts";

// An action whose page navigates while it runs is answered by the extension
// for the page it went to (act in background.js): { ok: true, navigated }.
// page answers the ops relayed to the tab, extension the extension's own
// requests, such as its fetch of a file.
type Answer = { value: unknown } | { error: string };
let page: Record<string, (args: unknown[]) => Answer> = {};
let extension: Record<string, (args: unknown[]) => Answer> = {};
bridge.attach({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    // relay: [tab, op, args, ms, frame]
    const reply = op === "relay" ? page[String(args[1])]?.(args[2] as unknown[]) : extension[op]?.(args);
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...(reply ?? { error: `nothing answers ${op}` }) })));
  },
  close() {},
});

const dir = mkdtempSync("/private/var/tmp/navigated-test-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ACCOUNT = { url: "https://shop.example/account", title: "Your account" };
const REPORT = "https://shop.example/report.pdf";
const PDF = Buffer.from("%PDF-1.4 the report");
const went = (to: { url: string; title: string }) => () => ({ value: { ok: true, navigated: to } });
const served = (type: string, body: Buffer) => ({ value: { name: "", type, size: body.length, disposition: null, url: REPORT, data: body.toString("base64") } });

test.each([
  ["a username and password", { username: "ann", password: "pw" }, ["username", "password"]],
  ["a password alone", { username: null, password: "pw" }, ["password"]],
])("login_fill of %s into a form that submits itself reports the fields sent and where the page went", async (_, login, filled) => {
  page = { fillLogin: went(ACCOUNT) };
  expect(await callTool("login_fill", { tab: 7, site: "shop.example", ...login })).toEqual({ filled, navigated: ACCOUNT });
});

test("download of a ref whose click took the page to a file Safari shows saves that file", async () => {
  page = { download: went({ url: REPORT, title: "report.pdf" }) };
  extension = { fetchFile: ([url]) => (url === REPORT ? served("application/pdf", PDF) : { error: "download failed: HTTP 404" }) };
  const out = join(dir, "clicked.pdf");
  await callTool("download", { tab: 7, ref: "12", out });
  expect(readFileSync(out)).toEqual(PDF);
});

test("download of a ref whose click opened a page fails naming it and ~/Downloads, and saves nothing", async () => {
  page = { download: went(ACCOUNT) };
  extension = { fetchFile: () => served("text/html; charset=utf-8", Buffer.from("<html>account</html>")) };
  const out = join(dir, "page.pdf");
  await expect(callTool("download", { tab: 7, ref: "12", out })).rejects.toThrow(`the click went to the page ${ACCOUNT.url}, not a file; a download the site started itself is saved in ~/Downloads`);
  expect(existsSync(out)).toBe(false);
});

test("download of a url on a page that navigates while it fetches saves the file the extension fetches", async () => {
  page = { fetchFile: went(ACCOUNT) };
  extension = { fetchFile: ([url]) => (url === REPORT ? served("application/pdf", PDF) : { error: "download failed: HTTP 404" }) };
  const out = join(dir, "by-url.pdf");
  await callTool("download", { tab: 7, url: REPORT, out });
  expect(readFileSync(out)).toEqual(PDF);
});

test("pdf save of a page that keeps navigating while it is read asks to save it once it settles", async () => {
  page = { eval: went(ACCOUNT) };
  await expect(callTool("pdf", { tab: 7, out: join(dir, "moving.pdf") })).rejects.toThrow("the page kept navigating while it was read; save it once it settles");
});
