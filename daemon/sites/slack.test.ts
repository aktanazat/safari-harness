import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Invoke } from "../call.ts";
import { SiteKit } from "./kit.ts";
import { slack } from "./slack.ts";

// Safari as the slack global sees it: app.slack.com's store holds one
// signed-in workspace, its web API answers each method from methods, and
// files.slack.com answers each fetch of a file with the next of files.
// asked lists the methods called; fetched, each file fetch and when it came.
type Served = { status: number; type: string; retryAfter?: string; body: Buffer };

const TEAM = { teamId: "T1", name: "Acme", domain: "acme", url: "https://acme.slack.com/", userId: "U1", signedIn: true, lastActive: true };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const DOWNLOAD = "https://files.slack.com/files-pri/T1-F1/download/image.png";
// A file as Slack's API lists it.
const FILE = { id: "F1", name: "image.png", mimetype: "image/png", size: PNG.length, url_private: "https://files.slack.com/files-pri/T1-F1/image.png", url_private_download: DOWNLOAD };

const dir = mkdtempSync("/private/var/tmp/slack-test-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Requests are paced and a 429 is waited out, on the fake clock.
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

function safari(methods: Record<string, object>, files: Served[]) {
  const asked: string[] = [];
  const fetched: { url: string; at: number }[] = [];
  const send: Invoke = async (tool, args) => {
    if (tool === "open") return { id: 1 };
    if (tool === "eval") {
      const method = /\/api\/([\w.]+)/.exec(String(args.expression))?.[1];
      if (method === undefined) return { result: { lastActiveTeamId: TEAM.teamId, teams: [TEAM] } };
      asked.push(method);
      return { result: { status: 200, retryAfter: null, text: JSON.stringify({ ok: true, ...methods[method] }), truncated: false } };
    }
    if (tool === "fetch") {
      fetched.push({ url: String(args.url), at: Date.now() });
      const f = files.shift();
      if (!f) throw new Error("no file left to serve");
      const headers = [["content-type", f.type], ...(f.retryAfter === undefined ? [] : [["retry-after", f.retryAfter]])];
      return { status: f.status, url: String(args.url), type: f.type, headers, data: f.body.toString("base64"), truncated: false };
    }
    throw new Error(`no ${tool} in this Safari`);
  };
  return { client: () => waited(slack(new SiteKit(send, undefined, dir)).getClient()), asked, fetched };
}

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

// Work on the fake clock, which moves on 250 ms at a time once Safari has
// answered all it was asked.
async function waited<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const end = () => {
    done = true;
  };
  void work.then(end, end);
  while (!done) {
    await settled();
    jest.advanceTimersByTime(250);
  }
  return work;
}

test("a file history lists downloads from the address it carries, with no files.info call, at a path in the session's folder", async () => {
  const s = safari({ "conversations.history": { messages: [{ ts: "1.0", user: "U2", files: [FILE] }] } }, [{ status: 200, type: "image/png", body: PNG }]);
  const c = await s.client();
  const file = (await waited(c.history("D1"))).messages[0]?.files?.[0];
  if (!file) throw new Error("history listed no file");
  expect(await waited(c.download(file, "listed.png"))).toEqual({ path: join(dir, "listed.png"), size: PNG.length, type: "image/png" });
  expect(readFileSync(join(dir, "listed.png"))).toEqual(PNG);
  expect(s.fetched.map((f) => f.url)).toEqual([DOWNLOAD]);
  expect(s.asked).toEqual(["conversations.history"]);
});

// On 10-07 a burst of Akyl's image downloads drew a 429. A page reads only
// a few of files.slack.com's headers, so its Retry-After may not come.
test.each([
  ["the seconds its Retry-After names", "1", 1_000],
  ["5 s, when no Retry-After comes", undefined, 5_000],
])("a file Slack answers with 429 is fetched again after %s", async (_, retryAfter, wait) => {
  const s = safari({ "files.info": { file: FILE } }, [{ status: 429, type: "text/plain", retryAfter, body: Buffer.from("ratelimited") }, { status: 200, type: "image/png", body: PNG }]);
  const c = await s.client();
  const out = join(dir, `after-${wait}.png`);
  await waited(c.download("F1", out));
  expect(readFileSync(out)).toEqual(PNG);
  const [first, second] = s.fetched.map((f) => f.at);
  expect(second - first).toBeGreaterThanOrEqual(wait);
  expect(second - first).toBeLessThan(wait + 1_000);
});

test("a web page in place of a file's bytes fails, and nothing is saved", async () => {
  const s = safari({ "files.info": { file: FILE } }, [{ status: 200, type: "text/html; charset=utf-8", body: Buffer.from("<!DOCTYPE html><title>Sign in | Slack</title>") }]);
  const c = await s.client();
  const out = join(dir, "signed-out.png");
  await expect(waited(c.download("F1", out))).rejects.toThrow("Slack answered a web page for file F1, not its image/png");
  expect(existsSync(out)).toBe(false);
});
