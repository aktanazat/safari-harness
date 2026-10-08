import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// On 10-07 Slack's sign-in page came back for an image fetched without a
// signed-in tab, and was saved as the .png, with exit 0.
test.each([
  ["at the out given", "image.png"],
  ["named for itself", undefined],
])("download of a file's url answered with a web page fails naming where it went, and saves nothing %s", async (_, name) => {
  page(SIGN_IN);
  const folder = join(dir, name ?? "unnamed");
  const out = name === undefined ? undefined : join(folder, name);
  await expect(download({ url: IMAGE, out }, folder)).rejects.toThrow(`${IMAGE} answered a web page (it went to ${SIGN_IN}), not a .png file; nothing was saved`);
  expect(existsSync(folder)).toBe(false);
});

test("download of a page's url saves the page, and so does any url saved at an out ending in .html", async () => {
  page("https://example.com/");
  const saved = await download({ url: "https://example.com/" }, dir);
  expect(readFileSync(saved.path)).toEqual(PAGE);
  page(SIGN_IN);
  const kept = join(dir, "kept.html");
  await download({ url: IMAGE, out: kept }, dir);
  expect(readFileSync(kept)).toEqual(PAGE);
});
