import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { download, TOOLS } from "./tools.ts";

// download of a url with no tab is the extension's own fetch, with no
// page's cookies (fetchFile in background.js): it answers what the site
// sent from where its redirects ended, or fails as refuse says. In tab 7,
// a download by ref and the page's own fetch get no answer ("Load
// failed"), and the ref's link goes to link. An address in images answers
// that JPEG, or 404 when it maps to null.
let served = { url: "", type: "", body: Buffer.alloc(0) };
let refuse: string | undefined;
let link = "";
const fetched: string[] = [];
const images = new Map<string, Buffer | null>();
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const page = op === "relay" ? String(args[1]) : "";
    if (op === "fetchFile") fetched.push(String(args[0]));
    const image = op === "fetchFile" ? images.get(String(args[0])) : undefined;
    const reply = image === null ? { error: "download failed: HTTP 404" }
      : image ? { value: { name: "", type: "image/jpeg", size: image.length, disposition: null, url: String(args[0]), data: image.toString("base64") } }
      : op === "fetchFile" && refuse !== undefined ? { error: refuse }
      : op === "fetchFile" ? { value: { name: "", type: served.type, size: served.body.length, disposition: null, url: served.url, data: served.body.toString("base64") } }
      : op === "tabs.list" ? { value: [{ id: 7, url: "https://developer.apple.com/account/resources/authkeys/list", title: "Keys", windowId: 1, active: true }] }
      : page === "download" || page === "fetchFile" ? { error: "Load failed" }
      : page === "element" ? { value: { value: link } }
      : page === "downloadStop" ? { value: { ok: true } }
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

const KEY_URL = "https://developer.apple.com/account/auth/key/download?keyId=9FRH7PU7RZ";
const KEY = Buffer.from("the key file's bytes");

// On 10-12 a download by ref of an Apple key failed "Load failed" in 0.7 s,
// and its agent dug the address out of the page to fetch it by url
// (AkylUsage).
test("a download by ref that got no answer is fetched again once from its link, and says so", async () => {
  link = "/account/auth/key/download?keyId=9FRH7PU7RZ";
  refuse = undefined;
  served = { url: KEY_URL, type: "application/octet-stream", body: KEY };
  fetched.length = 0;
  const out = join(dir, "AuthKey_9FRH7PU7RZ.p8");
  expect(await download({ tab: 7, ref: "81", out }, dir)).toEqual({ path: out, name: "AuthKey_9FRH7PU7RZ.p8", size: KEY.length, type: "application/octet-stream", note: `the page's own fetch of the file got no answer (Load failed), so it was fetched again from ${KEY_URL}` });
  expect(readFileSync(out)).toEqual(KEY);
  expect(fetched).toEqual([KEY_URL]);
});

test("a download by ref whose second fetch fails too says both failed and where the link goes, and is not tried a third time", async () => {
  link = "http://127.0.0.1:9/auth/key/download?keyId=9FRH7PU7RZ";
  refuse = "Load failed";
  fetched.length = 0;
  await expect(download({ tab: 7, ref: "81", out: join(dir, "again.p8") }, dir)).rejects.toThrow(`; the link goes to ${link}, and fetching it again failed too: Load failed`);
  expect(fetched).toEqual([link]);
  refuse = undefined;
});

// The key that came by url was application/json, saved as a .p8 (AkylUsage).
test("JSON in place of the kind of file out names is kept, and the answer is not ok and quotes it", async () => {
  refuse = undefined;
  const error = JSON.stringify({ resultCode: 35, userString: "This key was already downloaded." });
  served = { url: KEY_URL, type: "application/json", body: Buffer.from(error) };
  const out = join(dir, "AuthKey_X.p8");
  expect(await download({ url: KEY_URL, out }, dir)).toEqual({ ok: false, path: out, name: "AuthKey_X.p8", size: error.length, type: "application/json", warning: `the site answered JSON, not a .p8 file; that is most often an error, and it reads: ${error}` });
  expect(readFileSync(out, "utf8")).toBe(error);
  const asked = join(dir, "answer.json");
  expect(await download({ url: KEY_URL, out: asked }, dir)).not.toHaveProperty("warning");
});

// On 10-22 an agent fetched ten product images through ten map calls in
// nine minutes.
test("download of several urls saves each under its place in the list, reports a failed one in its place, and a second run writes over the first", async () => {
  const [a, gone, b] = ["https://cdn.example/p/a.jpg", "https://cdn.example/p/gone.jpg", "https://cdn.example/p/b.jpg"];
  images.set(a, Buffer.from("a's bytes")).set(gone, null).set(b, Buffer.from("b's bytes"));
  const folder = join(dir, "batch");
  const answer = { folder, files: [
    { path: join(folder, "01-a.jpg"), name: "01-a.jpg", size: 9, type: "image/jpeg" },
    { url: gone, error: "download failed: HTTP 404: nothing is at that address; take a file's address from its page (a ref's link) or the site's API rather than building it" },
    { path: join(folder, "03-b.jpg"), name: "03-b.jpg", size: 9, type: "image/jpeg" },
  ] };
  expect(await TOOLS.download.run({ urls: [a, gone, b], out: folder })).toEqual(answer);
  expect(await TOOLS.download.run({ urls: [a, gone, b], out: folder })).toEqual(answer);
  expect(readdirSync(folder).sort()).toEqual(["01-a.jpg", "03-b.jpg"]);
  expect(readFileSync(join(folder, "03-b.jpg"), "utf8")).toBe("b's bytes");
});
