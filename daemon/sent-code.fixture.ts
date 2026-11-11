import { afterAll, afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { Failure } from "./failures.ts";

// The site's code comes to a stand-in Messages (a chat.db under an
// isolated home) or a stand-in Gmail, searched as Gmail's search is; the
// page keeps what type puts in its field; the clock is fake. Each call the
// code's wait makes is logged as the daemon logs a call (main.ts).
const home = mkdtempSync("/private/var/tmp/sent-code-");
const originalOs = { ...os };
mock.module("node:os", () => ({ ...originalOs, homedir: () => home }));
// Static loading would capture the real home, with the owner's Messages
// and record of codes typed, before the test puts this one in its place.
const { bridge } = await import("./bridge.ts");
const { invoke } = await import("./call.ts");
const { logCall, openCalls } = await import("./calls.ts");
const { connect } = await import("./fake-safari.ts");
const { failureOf } = await import("./failures.ts");
const { recent } = await import("./journal.ts");
const { affectsPage } = await import("./lanes.ts");
const { watched } = await import("./mission.ts");
const daemonRpc = await import("./rpc.ts");
const { callTool } = await import("./tools.ts");

const CODE = "482915";
const OTHER = "777777";
const CALL = { tab: 6001, ref: "1", text: "{{code}}" };
const CALLS = join(home, "calls.jsonl");
openCalls(CALLS);

const folder = join(home, "Library", "Messages");
mkdirSync(folder, { recursive: true });
const db = new Database(join(folder, "chat.db"));
db.exec(`
  CREATE TABLE handle (id TEXT);
  CREATE TABLE message (date INTEGER, is_from_me INTEGER, text TEXT, attributedBody BLOB,
    cache_has_attachments INTEGER, handle_id INTEGER, item_type INTEGER, associated_message_type INTEGER,
    is_sent INTEGER, is_delivered INTEGER, error INTEGER);
  INSERT INTO handle VALUES ('63641'),('22395');
`);
const APPLE = Date.UTC(2001, 0, 1);
// A text at ms at from handle 1, the shop's short code, or 2, another site's.
function text(body: string, at = Date.now(), handle = 1) {
  db.query("INSERT INTO message VALUES (?, 0, ?, NULL, 0, ?, 0, 0, 0, 1, 0)").run((at - APPLE) * 1e6, body, handle);
}

let fields: unknown[] = [];
const SHOP = "https://www.shop.example/account/verify";
let page = SHOP;
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const ask = op === "relay" ? String(args[1]) : op;
    if (op === "relay" && ask !== "tabInfo") fields.push(args[2]);
    const value = ask === "tabInfo" ? { url: page, title: "Verify it's you", ready: "complete" } : op === "relay" ? { ok: true, kept: true } : [];
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
  },
  close() {},
});

// Gmail: mails that land at their time, each its own thread, found by the
// terms google.ts searches with ({from:a "b"}, from:a, after:) and read in
// its print view. Its tabs are 9001 on; one takes 10.3 s to open, the
// week's median to 11-11, and a call in one closed fails as the daemon's
// does. searching runs as a search starts.
type Mail = { thread: string; at: number; email: string; subject: string; body: string };
let mailbox: Mail[] = [];
const GMAIL_TABS = 9001;
const gmailTabs = new Set<number>();
let nextTab = GMAIL_TABS;
let view = { hash: "#inbox", rows: [] as unknown[] };
let searching = () => {};
let openMs = 10_300;

function searched(hash: string): unknown[] {
  const query = decodeURIComponent(hash.replace(/^#search\//, "").replace(/\+/g, " "));
  const after = Number(/after:(\d+)/.exec(query)?.[1] ?? 0) * 1000;
  const terms = query.match(/from:[^\s})]+|"[^"]*"/g) ?? [];
  const hit = (m: Mail) => terms.some((t) => (t.startsWith("from:") ? m.email.includes(t.slice(5)) : `${m.subject} ${m.body}`.includes(t.slice(1, -1))));
  return mailbox.filter((m) => m.at <= Date.now() && m.at >= after && hit(m)).map((m) => ({
    id: m.thread, threadId: `thread-f:${BigInt(`0x${m.thread}`)}`, from: m.email, fromEmail: m.email, senders: [{ name: "", email: m.email }],
    subject: m.subject, snippet: m.body, date: new Date(Math.floor(m.at / 60_000) * 60_000).toISOString(), unread: true, last: (BigInt(m.at) << 20n).toString(16),
  }));
}

async function gmailCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (tool === "open") {
    await Bun.sleep(openMs);
    const id = nextTab++;
    gmailTabs.add(id);
    return { id };
  }
  if (tool === "tabs") return { tabs: [...gmailTabs].map((id) => ({ id, url: "https://mail.google.com/mail/u/0/#inbox", title: "Inbox (3) - aktanaazat@gmail.com - Gmail" })) };
  if (tool === "close") {
    gmailTabs.delete(Number(args.tab));
    return { ok: true };
  }
  if (!gmailTabs.has(Number(args.tab))) throw new Error(`that tab is gone (${String(args.tab)})`);
  const expression = String(args.expression);
  const to = /location\.hash = ("[^"]*")/.exec(expression)?.[1];
  if (to) {
    const hash = JSON.parse(to) as string;
    if (hash === view.hash) return { result: false };
    searching();
    await Bun.sleep(600);
    view = { hash, rows: searched(hash) };
    return { result: true };
  }
  if (expression.includes("tr.zA")) return { result: { counter: null, empty: !view.rows.length, rows: view.rows } };
  const m = mailbox.find((x) => expression.includes(`th=${x.thread}`));
  if (!m) throw new Error(`no stand-in for this Gmail read: ${expression.slice(0, 80)}`);
  return { result: { status: 200, url: `https://mail.google.com/mail/u/0/?view=pt&search=all&th=${m.thread}`, subject: m.subject, messages: [{ from: `Shop <${m.email}>`, date: new Date(m.at).toISOString(), lines: [], body: `<p>${m.body}</p>`, attachments: [] }] } };
}

const isGmail = (tool: string, args: Record<string, unknown>) =>
  tool === "tabs" || (tool === "open" && String(args.url).startsWith("https://mail.google.com")) || Number(args.tab) >= GMAIL_TABS;
spyOn(daemonRpc, "rpc").mockImplementation(async (tool: string, args: Record<string, unknown> = {}, model = false) => {
  const t = Date.now();
  const log = (reply: { ok: true; value: unknown } | { ok: false; failure: Failure }) =>
    logCall({ t, ms: Date.now() - t, owner: process.pid, task: undefined, tool, args, reply, bytes: JSON.stringify(reply).length });
  try {
    const value = isGmail(tool, args) ? await gmailCall(tool, args) : await watched(process.pid, tool, args, () => callTool(tool, args, model));
    log({ ok: true, value });
    return value;
  } catch (e) {
    log({ ok: false, failure: failureOf(e, { effectful: affectsPage(tool, args) }) });
    throw e;
  }
});

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  db.exec("DELETE FROM message");
  mailbox = [];
  fields = [];
  gmailTabs.clear();
  nextTab = GMAIL_TABS;
  view = { hash: "#inbox", rows: [] };
  searching = () => {};
  page = SHOP;
  openMs = 10_300;
  rmSync(join(home, ".local"), { recursive: true, force: true });
});
afterAll(() => {
  db.close();
  mock.restore();
  rmSync(home, { recursive: true, force: true });
});

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

// A call on the fake clock, which moves on 100 ms at a time once the call
// has done all it can.
async function waited<T>(call: Promise<T>): Promise<T> {
  let done = false;
  const end = () => {
    done = true;
  };
  void call.then(end, end);
  while (!done) {
    await settled();
    jest.advanceTimersByTime(100);
  }
  return call;
}

const typedCode = (code: string) => [["1", code, { append: false, secret: true }]];

// 01a0e50b: an agent typed an emailed code by hand, and type echoed it back.
test("a code texted after the call starts is typed, not one from minutes before, and is nowhere in the answer, journal, or call log", async () => {
  text(`Shop Example: ${OTHER} is your verification code.`, Date.now() - 2 * 60_000);
  setTimeout(() => text(`Shop Example: ${CODE} is your verification code.`), 3_000);
  expect(await waited(invoke("type", CALL, true))).toEqual({ ok: true, kept: true, typed: "code, 6 chars", source: "text from 63641" });
  expect(fields).toEqual(typedCode(CODE));
  expect(JSON.stringify(recent(500))).not.toContain(CODE);
  const log = readFileSync(CALLS, "utf8");
  expect(log).toContain('"tool":"type"');
  expect(log).not.toContain(CODE);
});

// A site that sends its code again sends a new one; until 11-11 type took
// the one it had typed again, at once.
test("a code typed before is passed over, and the one the site sends again is typed", async () => {
  text(`Shop Example: ${OTHER} is your verification code.`, Date.now() - 20_000);
  await waited(invoke("type", CALL, true));
  fields = [];
  setTimeout(() => text(`Shop Example: ${CODE} is your verification code.`), 3_000);
  expect(await waited(invoke("type", CALL, true))).toMatchObject({ ok: true, source: "text from 63641" });
  expect(fields).toEqual(typedCode(CODE));
});

// A text whose last line is @other.example #777777 is for that site
// (WebOTP), whichever page waits for a code.
test("a texted code bound to another site is passed over for the page's own", async () => {
  setTimeout(() => text(`Other Example: ${OTHER} is your sign-in code.\n\n@other.example #${OTHER}`, Date.now(), 2), 1_000);
  setTimeout(() => text(`Shop Example: ${CODE} is your verification code.`), 3_000);
  expect(await waited(invoke("type", CALL, true))).toMatchObject({ ok: true, source: "text from 63641" });
  expect(fields).toEqual(typedCode(CODE));
});

// Until the 11-11 review mail that named the domain counted from any sender.
test("mail from a lookalike of the site's domain is passed over for the site's own, though newer and naming it", async () => {
  mailbox = [
    { thread: "19a0c3d4e5f60718", at: Date.now() + 2_000, email: "codes@mail.shop.example", subject: "Your Shop Example code", body: `Your verification code is ${CODE}.` },
    { thread: "19a0c3d4e5f60700", at: Date.now() + 5_000, email: "codes@shop.example.evil.test", subject: "Your shop.example code", body: `Your verification code is ${OTHER}.` },
  ];
  expect(await waited(invoke("type", { ...CALL, secret: "mail" }, true))).toMatchObject({ ok: true, source: "mail from codes@mail.shop.example" });
  expect(fields).toEqual(typedCode(CODE));
  expect(gmailTabs.size).toBe(0);
});

// 11-11: a mailed code took five calls, the model read it, and secret page
// typed the mail's ZIP code for it, as the code ended a sentence.
test("a mailed code is typed in one call, not the mail's ZIP code, and its Gmail tab is closed", async () => {
  mailbox = [{ thread: "19a0c3d4e5f60718", at: Date.now() + 4_000, email: "codes@mail.shop.example", subject: "Your Shop Example verification code", body: `Your verification code is ${CODE}. Shop Example, 100 Market St, Springfield 62701` }];
  expect(await waited(invoke("type", CALL, true))).toEqual({ ok: true, kept: true, typed: "code, 6 chars", source: "mail from codes@mail.shop.example" });
  expect(fields).toEqual(typedCode(CODE));
  expect(gmailTabs.size).toBe(0);
  expect(JSON.stringify(recent(500))).not.toContain(CODE);
  expect(readFileSync(CALLS, "utf8")).not.toContain(CODE);
});

test("a code that never comes types nothing after 30 s, and says where it looked and what it passed over, never a code", async () => {
  setTimeout(() => text(`Other Example: ${OTHER} is your sign-in code.\n\n@other.example #${OTHER}`, Date.now(), 2), 1_000);
  const start = Date.now();
  const error = await waited(invoke("type", CALL, true)).then(() => undefined, (e: Error) => e.message);
  expect(error).toBe("no code for shop.example came by text or in Gmail in 30 s; passed over a code for other.example (text from 22395); have the site send it again, then call type again; a site that texts without its name or mails from another domain needs sender: the number or domain its guide or page gives");
  expect(Date.now() - start).toBeGreaterThanOrEqual(30_000);
  expect(Date.now() - start).toBeLessThan(31_000);
  expect(fields).toEqual([]);
  expect(gmailTabs.size).toBe(0);
});

// A code that comes while Gmail is searched is typed at once, and the tab
// closes as the search ends: closed under it, its next call would open
// another (kit.ts).
test("a code texted while Gmail searches is typed, and no Gmail tab is left open", async () => {
  searching = () => text(`Shop Example: ${CODE} is your verification code.`);
  expect(await waited(invoke("type", CALL, true))).toMatchObject({ ok: true, source: "text from 63641" });
  await waited(Bun.sleep(15_000));
  expect(fields).toEqual(typedCode(CODE));
  expect(nextTab).toBe(GMAIL_TABS + 1);
  expect(gmailTabs.size).toBe(0);
});

// 11-11 review: a text that named no site was taken, so a code another
// site texted in the same minute went into the page that asked.
test("a texted code that does not name the page's site is passed over, unless it comes from the sender given", async () => {
  text(`Chase: ${OTHER} is your one-time passcode.`, Date.now() - 20_000, 2);
  setTimeout(() => text(`${CODE} is your verification code.`), 1_000);
  const error = await waited(invoke("type", { ...CALL, secret: "sms" }, true)).then(() => undefined, (e: Error) => e.message);
  expect(error).toContain("passed over a code that does not name shop.example (text from 22395); a code that does not name shop.example (text from 63641)");
  expect(fields).toEqual([]);
  expect(await waited(invoke("type", { ...CALL, sender: "63641" }, true))).toMatchObject({ ok: true, source: "text from 63641" });
  expect(fields).toEqual(typedCode(CODE));
});

// 11-11 review: anyone can make a form on docs.google.com, and one that
// asked for "the code we sent" got his Google code, texted or mailed. Two
// apps on herokuapp.com are two sites too.
test("a page anyone can make on a shared domain takes no code sent for another host there", async () => {
  page = "https://docs.google.com/forms/d/e/1FAIpQL/viewform";
  setTimeout(() => text(`G-${OTHER} is your Google verification code.`, Date.now(), 2), 1_000);
  mailbox = [{ thread: "19a0c3d4e5f60718", at: Date.now() + 2_000, email: "no-reply@accounts.google.com", subject: "Your Google verification code", body: `Your verification code is ${OTHER}.` }];
  const error = await waited(invoke("type", CALL, true)).then(() => undefined, (e: Error) => e.message);
  expect(error).toStartWith("no code for docs.google.com came by text or in Gmail in 30 s");
  page = "https://attacker.herokuapp.com/verify";
  setTimeout(() => text(`Your code is ${OTHER}.\n\n@victim.herokuapp.com #${OTHER}`, Date.now(), 2), 1_000);
  await waited(invoke("type", { ...CALL, secret: "sms" }, true)).catch(() => undefined);
  expect(fields).toEqual([]);
});

// 11-11 review: a code texted 11 s in was typed at 35.7 s, after a Gmail
// that took 25 s to open, and a wait for none ended then too.
test("a wait ends as a code comes, or at 30 s, however long Gmail takes to open, and its tab closes once open", async () => {
  openMs = 25_000;
  setTimeout(() => text(`Shop Example: ${CODE} is your verification code.`), 11_000);
  let start = Date.now();
  expect(await waited(invoke("type", CALL, true))).toMatchObject({ ok: true, source: "text from 63641" });
  expect(Date.now() - start).toBeLessThan(12_000);
  start = Date.now();
  const error = await waited(invoke("type", CALL, true)).then(() => undefined, (e: Error) => e.message);
  expect(error).toStartWith("no code for shop.example came by text or in Gmail in 30 s");
  expect(Date.now() - start).toBeLessThan(31_000);
  await waited(Bun.sleep(30_000));
  expect(gmailTabs.size).toBe(0);
  expect(nextTab).toBe(GMAIL_TABS + 2);
});
