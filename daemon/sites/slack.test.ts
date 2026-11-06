import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Invoke } from "../call.ts";
import { PACE_TOOL } from "../pace.ts";
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
// Requests are paced and a 429 is waited out, on one fake clock for every
// test: the daemon's pacer keeps its turns across clients (pace.ts), and
// the daemon's clock never goes back.
beforeAll(() => {
  jest.useFakeTimers();
});
afterAll(() => {
  jest.useRealTimers();
});

// A method's answer is an object, or a list answered one per call in turn.
// goneAfter names a method whose next call reaches Slack and then fails as
// the extension answers when the tab closed before the answer came back.
function safari(methods: Record<string, object | object[]>, files: Served[], opts: { goneAfter?: string } = {}) {
  const asked: string[] = [];
  // Each web-API call with the params the page would send.
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fetched: { url: string; at: number }[] = [];
  let tabs = 0;
  let goneAfter = opts.goneAfter;
  const send: Invoke = async (tool, args) => {
    if (tool === "open") return { id: ++tabs };
    if (tool === "pace") return PACE_TOOL.run(args);
    if (tool === "eval") {
      const method = /\/api\/([\w.]+)/.exec(String(args.expression))?.[1];
      if (method === undefined) return { result: { lastActiveTeamId: TEAM.teamId, teams: [TEAM] } };
      asked.push(method);
      calls.push({ method, params: JSON.parse(/Object\.entries\((\{.*?\})\)\) body\.set/s.exec(String(args.expression))?.[1] ?? "{}") });
      const answers = methods[method];
      const answer = Array.isArray(answers) ? answers.shift() : answers;
      if (goneAfter === method) {
        goneAfter = undefined;
        throw new Error("that tab is gone: the user or its own page closed it 0 s ago; find it with tabs, or open it again");
      }
      return { result: { status: 200, retryAfter: null, text: JSON.stringify({ ok: true, ...answer }), truncated: false } };
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
  const kit = new SiteKit(send, undefined, dir);
  return { client: () => waited(slack(kit).getClient()), kit, asked, calls, fetched };
}

// A draft made, then approved by its draftId in the session's next run, as
// the owner's yes comes between two REPL calls.
async function approved<T>(kit: SiteKit, write: (approved?: string) => Promise<T>): Promise<T> {
  const draft = (await waited(write())) as { status: string; draftId: string };
  expect(draft.status).toBe("draft");
  kit.run++;
  return waited(write(draft.draftId));
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

// Edits and deletes act on the owner's own messages in his name: an
// unapproved call must change nothing and show what would be replaced.
const OLD = { "conversations.history": { messages: [{ ts: "7.0", user: "U1", text: "old text" }] } };

test("update without approval sends nothing and shows the text it would replace", async () => {
  const s = safari(OLD, []);
  const draft = await waited((await s.client()).update("D1", "7.0", "new text"));
  expect(draft).toMatchObject({ status: "draft", text: "new text", was: "old text" });
  expect(s.asked).toEqual(["conversations.history"]);
});

test("delete without approval sends nothing and shows the message it would remove", async () => {
  const s = safari(OLD, []);
  const draft = await waited((await s.client()).delete("D1", "7.0"));
  expect(draft).toMatchObject({ status: "draft", text: "old text" });
  expect(s.asked).toEqual(["conversations.history"]);
});

// An admin's delete of a member's message is permanent.
test("delete refuses a message someone else wrote, even approved, and deletes nothing", async () => {
  const s = safari({ "conversations.history": { messages: [{ ts: "7.0", user: "U2", text: "lgtm" }] } }, []);
  await expect(waited((await s.client()).delete("D1", "7.0", { approved: true }))).rejects.toThrow("message 7.0 in D1 is not the owner's");
  expect(s.asked).toEqual(["conversations.history"]);
});

// A retried postThread would post the top message and earlier replies again.
test("postThread that fails midway names the top message and the replies already posted", async () => {
  const s = safari({ "chat.postMessage": [{ ts: "9.0", channel: "D1" }, { ts: "9.1" }, { ok: false, error: "msg_too_long" }] }, []);
  const c = await s.client();
  await expect(approved(s.kit, (ok) => c.postThread("D1", "summary", ["details 1", "details 2"], { approved: ok }))).rejects.toThrow("postThread posted the top message 9.0 in D1 and 1 of 2 replies, then failed");
});

// Audit SH-25: called again after such a failure, postThread posted a
// second top message. Its next draft says what is left, and its send posts
// only that, under the top message already posted.
test("postThread called again after a failure part way posts only the remaining replies, under the same top message", async () => {
  const s = safari({ "chat.postMessage": [{ ts: "9.0", channel: "D1" }, { ts: "9.1" }, { ok: false, error: "msg_too_long" }, { ts: "9.2" }] }, []);
  const c = await s.client();
  const thread = (ok?: string) => c.postThread("D1", "summary", ["details 1", "details 2"], { approved: ok });
  await expect(approved(s.kit, thread)).rejects.toThrow("postThread posted the top message 9.0");
  s.kit.run++;
  const draft = await waited(thread());
  expect(draft.action).toBe("post the last 1 thread reply of 2 under message 9.0 in D1 (the top message and 1 thread reply were posted before a failure)");
  s.kit.run++;
  const sent = await waited(thread(draft.draftId));
  expect(sent).toMatchObject({ status: "sent", result: { ts: "9.0", channel: "D1", replies: ["9.1", "9.2"], resumed: true } });
  expect(s.calls.map((x) => [x.params.text, x.params.thread_ts])).toEqual([["summary", undefined], ["details 1", "9.0"], ["details 2", "9.0"], ["details 2", "9.0"]]);
});

// On 11-04 chained postMessage calls put a "thread reply" at the top level
// when the top message's ts was read from the wrong field.
test("postThread posts every reply in the thread of the top message it just posted", async () => {
  const s = safari({ "chat.postMessage": { ts: "9.0", channel: "D1" } }, []);
  const c = await s.client();
  const sent = await approved(s.kit, (ok) => c.postThread("D1", "summary", ["details 1", "details 2"], { approved: ok }));
  expect(sent.status).toBe("sent");
  expect(s.calls.map((x) => x.params.thread_ts)).toEqual([undefined, "9.0", "9.0"]);
});

// Audit SH-21 and E-10: approval was a flag the model set. It sent on a
// first call no one saw, sent other text to another channel than the
// draft's, and could be set in the same script that drafted.
test("approved: true sends nothing; approval takes the draft's id", async () => {
  const s = safari({ "chat.postMessage": { ts: "1.0", channel: "C1" } }, []);
  const c = await s.client();
  await expect(waited(c.postMessage("C1", "never shown", { approved: true }))).rejects.toThrow("nothing was sent: approved takes the draftId");
  await expect(waited(c.postMessage("C1", "never shown", { approved: "0123456789ab" }))).rejects.toThrow("nothing was sent: no draft 0123456789ab");
  expect(s.asked).toEqual([]);
});

test("a draft's id approves only that draft's text, channel and sender, once, and not in the run that made it", async () => {
  const s = safari({ "chat.postMessage": { ts: "1.0", channel: "C1" } }, []);
  const c = await s.client();
  const draft = await waited(c.postMessage("C1", "the text the owner saw"));
  expect(draft).toMatchObject({ status: "draft", to: "C1", from: "Acme (acme.slack.com), as U1", text: "the text the owner saw" });
  await expect(waited(c.postMessage("C1", "the text the owner saw", { approved: draft.draftId }))).rejects.toThrow("made in this same run");
  s.kit.run++;
  await expect(waited(c.postMessage("C1", "other text", { approved: draft.draftId }))).rejects.toThrow("nothing was sent: this post in C1 is not draft");
  await expect(waited(c.postMessage("C2", "the text the owner saw", { approved: draft.draftId }))).rejects.toThrow("nothing was sent: this post in C2 is not draft");
  expect(s.asked).toEqual([]);
  expect(await waited(c.postMessage("C1", "the text the owner saw", { approved: draft.draftId }))).toMatchObject({ status: "sent", draftId: draft.draftId, result: { ts: "1.0" } });
  await expect(waited(c.postMessage("C1", "the text the owner saw", { approved: draft.draftId }))).rejects.toThrow("approved once already");
  expect(s.calls).toEqual([{ method: "chat.postMessage", params: { channel: "C1", text: "the text the owner saw" } }]);
});

// Audit SH-24: the extension says a tab is gone after the request left it
// too, and the kit sent a post again in a new tab: two posts.
test("an approved post whose tab vanished after the request ran is not sent again", async () => {
  const s = safari({ "chat.postMessage": { ts: "1.0", channel: "C1" } }, [], { goneAfter: "chat.postMessage" });
  const c = await s.client();
  const failed = await approved(s.kit, (ok) => c.postMessage("C1", "hello", { approved: ok })).then(() => undefined, (e: unknown) => e);
  expect(failed).toMatchObject({ code: "effect_unknown", message: expect.stringContaining("may have gone through; it was not sent again") });
  expect(s.asked).toEqual(["chat.postMessage"]);
});

test("a read whose tab vanished is still asked again in a new tab", async () => {
  const s = safari({ "conversations.history": { messages: [{ ts: "1.0", user: "U2", text: "hi" }] } }, [], { goneAfter: "conversations.history" });
  const c = await s.client();
  expect((await waited(c.history("C1"))).messages).toHaveLength(1);
  expect(s.asked).toEqual(["conversations.history", "conversations.history"]);
});

// On 11-04 every first Slack call of a turn failed: the kit's tab had
// closed as the turn ended, and the daemon opened it again fresh as a new
// tab and refused the eval there. The kit's parked page holds nothing, so
// the call runs once more in that tab.
test("a call whose tab was opened again fresh after the turn ended runs there", async () => {
  const evalTabs: unknown[] = [];
  let stale = true;
  const send: Invoke = async (tool, args) => {
    if (tool === "open") return { id: 1 };
    if (tool === "pace") return PACE_TOOL.run(args);
    if (tool !== "eval") throw new Error(`no ${tool} in this Safari`);
    evalTabs.push(args.tab);
    if (args.tab === 1 && stale) {
      stale = false;
      throw new Error("tab 1 had closed as its agent's turn ended at Nov 4 at 9:04 AM; it is open again on https://app.slack.com/safari-repl, loaded fresh as tab 2, so its refs and anything typed there are gone: an eval that only reads can run there again; else snapshot it, then act");
    }
    return { result: { lastActiveTeamId: TEAM.teamId, teams: [TEAM] } };
  };
  const kit = slack(new SiteKit(send, undefined, dir));
  expect(await waited(kit.listWorkspaces())).toEqual([TEAM]);
  await waited(kit.listWorkspaces());
  expect(evalTabs).toEqual([1, 2, 2]);
});
