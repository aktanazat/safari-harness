import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { download } from "./tools.ts";

// download of a url with no tab is the extension's own fetch, with no
// page's cookies (fetchFile in background.js): it answers what the site
// sent from where its redirects ended.
let served = { url: "", type: "", body: Buffer.alloc(0) };
connect({
  send(data: string) {
    const { id, op } = JSON.parse(data) as { id: string; op: string };
    const reply = op === "fetchFile"
      ? { value: { name: "", type: served.type, size: served.body.length, disposition: null, url: served.url, data: served.body.toString("base64") } }
      : { error: `nothing answers ${op}` };
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
  },
  close() {},
});

const dir = mkdtempSync("/private/var/tmp/download-test-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const IMAGE = "https://files.slack.com/files-pri/T1-F1/download/image.png";
const SIGN_IN = "https://acme.slack.com/?redir=%2Ffiles-pri%2FT1-F1%2Fdownload%2Fimage.png";
const PAGE = Buffer.from("<!DOCTYPE html><html><head><title>Sign in</title></head><body>Sign in to Acme</body></html>");
const page = (url: string) => {
  served = { url, type: "text/html; charset=utf-8", body: PAGE };
};

test("download of a page's url saves the page, and so does any url saved at an out ending in .html", async () => {
  page("https://example.com/");
  const saved = await download({ url: "https://example.com/" }, dir);
  expect(readFileSync(saved.path)).toEqual(PAGE);
  page(SIGN_IN);
  const kept = join(dir, "kept.html");
  await download({ url: IMAGE, out: kept }, dir);
  expect(readFileSync(kept)).toEqual(PAGE);
});
