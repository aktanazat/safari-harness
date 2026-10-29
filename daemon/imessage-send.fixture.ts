import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { failureOf } from "./failures.ts";
import { affectsPage } from "./lanes.ts";

// Messages is replaced at the irreversible command boundary. The database
// and send tool are real, with an isolated home and a controlled clock.
const home = mkdtempSync("/private/var/tmp/imessage-send-");
const folder = join(home, "Library", "Messages");
const originalOs = { ...os };
const originalChildProcess = { ...childProcess };
const CHAT = "iMessage;-;fixture@example.com";
const TEXT = "fixture message";
const SEND = { to: CHAT, text: TEXT, approved: true };
type Plan = { start?: boolean; error?: Error; delay?: number; apply?: (argv: string[]) => void };
let plans: Plan[] = [];
let attempts: string[][] = [];
let db: Database;

const execFile = Object.assign(() => { throw new Error("unplanned direct process launch"); }, {
  [promisify.custom]: (file: string, args: string[]) => {
    if (file !== "osascript") throw new Error(`unexpected external command: ${file}`);
    const argv = args.slice(2);
    attempts.push(argv);
    const plan = plans.shift();
    if (!plan) throw new Error("unplanned Messages command");
    const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
    if (plan.start !== false) plan.apply?.(argv);
    setTimeout(() => plan.error ? reject(plan.error) : resolve({ stdout: "", stderr: "" }), plan.delay ?? 0);
    return Object.assign(promise, { child: { pid: plan.start === false ? undefined : 12345 } });
  },
});
mock.module("node:os", () => ({ ...originalOs, homedir: () => home }));
mock.module("node:child_process", () => ({ ...originalChildProcess, execFile }));
// Static loading would capture the real home and process launcher before
// the test installs these safety boundaries.
const { send } = await import("./imessage.ts");

beforeEach(() => {
  jest.useFakeTimers();
  plans = [];
  attempts = [];
  mkdirSync(folder, { recursive: true });
  db = new Database(join(folder, "chat.db"));
  db.exec(`
    CREATE TABLE chat (guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT, style INTEGER);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (date INTEGER, is_from_me INTEGER, text TEXT, attributedBody BLOB,
      cache_has_attachments INTEGER, handle_id INTEGER, item_type INTEGER, associated_message_type INTEGER,
      is_sent INTEGER, is_delivered INTEGER, error INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE attachment (transfer_name TEXT, transfer_state INTEGER, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO chat VALUES ('iMessage;-;fixture@example.com','fixture@example.com',NULL,'iMessage',45);
    INSERT INTO chat VALUES ('iMessage;-;other@example.com','other@example.com',NULL,'iMessage',45);
    INSERT INTO handle VALUES ('fixture@example.com'),('other@example.com');
    INSERT INTO chat_handle_join VALUES (1,1),(2,2);
  `);
  // A stale exact receipt must not confirm a new send.
  outgoing(TEXT);
});

afterEach(() => {
  jest.useRealTimers();
  db.close();
  rmSync(folder, { recursive: true, force: true });
});
afterAll(() => {
  mock.restore();
  rmSync(home, { recursive: true, force: true });
});

function outgoing(text: string, chat = 1, me = 1): number {
  const rowid = Number(db.query(`INSERT INTO message VALUES (812678400000000000, ?, ?, NULL, 0, ?, 0, 0, 1, 0, 0)`).run(me, text, chat).lastInsertRowid);
  db.query("INSERT INTO chat_message_join VALUES (?, ?, 812678400000000000)").run(chat, rowid);
  return rowid;
}

function attachment(name: string, chat = 1): number {
  const rowid = outgoing("", chat);
  const id = Number(db.query("INSERT INTO attachment VALUES (?, 5, 5)").run(name).lastInsertRowid);
  db.query("INSERT INTO message_attachment_join VALUES (?, ?)").run(rowid, id);
  return rowid;
}

const timedOut = () => Object.assign(new Error("command timed out"), { killed: true, signal: "SIGTERM", stderr: "" });

// Use the same controlled-clock pattern as map.test.ts, with a finite
// virtual-time bound so a broken confirmation loop cannot hang the suite.
async function waited<T>(run: Promise<T>): Promise<T> {
  let done = false;
  void run.then(() => { done = true; }, () => { done = true; });
  for (let elapsed = 0; !done && elapsed <= 160000; elapsed += 500) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
    jest.advanceTimersByTime(500);
  }
  expect(done).toBe(true);
  return run;
}

function result(args: Parameters<typeof send>[0]) {
  // This is the MCP server's real failure conversion, including its
  // non-page classification of imessage_send.
  return waited(send(args).then(
    (value) => ({ value, failure: null }),
    (error: unknown) => ({ value: null, failure: failureOf(error, { effectful: affectsPage("imessage_send", args) }) }),
  ));
}

test("a draft without approval sends nothing", async () => {
  const reply = await result({ ...SEND, approved: false });
  expect(reply.value).toMatchObject({ status: "draft", chat: CHAT, text: TEXT });
  expect(attempts).toEqual([]);
  expect(db.query("SELECT COUNT(*) n FROM message").get()).toEqual({ n: 1 });
});

test.each([
  { name: "timeout", delay: 20000, error: timedOut() },
  { name: "post-dispatch command error", delay: 0, error: Object.assign(new Error("command failed"), { stderr: "Apple event reply failed" }) },
])("a $name still confirms a late exact outgoing receipt without sending twice", async ({ delay, error }) => {
  plans.push({ error, delay, apply: () => { setTimeout(() => outgoing(TEXT), delay + 500); } });
  const reply = await result(SEND);
  expect(reply.failure).toBeNull();
  expect(reply.value).toMatchObject({ status: "sent" });
  expect(attempts).toEqual([[TEXT, CHAT]]);
  expect(db.query("SELECT COUNT(*) n FROM message WHERE is_from_me = 1 AND text = ?").get(TEXT)).toEqual({ n: 2 });
});

test("a timeout with no receipt stays uncertain and never authorizes an identical retry", async () => {
  plans.push({ error: timedOut(), delay: 20000 });
  const reply = await result(SEND);
  expect(reply.value).toBeNull();
  expect(reply.failure).toMatchObject({ code: "effect_unknown", effect: "possibly_effected", retryable: false });
  expect(reply.failure?.next).toContain(CHAT);
  expect(reply.failure?.next).toContain("Do not resend");
  expect(attempts).toEqual([[TEXT, CHAT]]);
});

test.each([
  { name: "another conversation", chat: 2, me: 1, text: TEXT },
  { name: "an incoming message", chat: 1, me: 0, text: TEXT },
  { name: "different text", chat: 1, me: 1, text: `${TEXT} extra` },
])("a receipt for $name cannot confirm the intended outgoing text", async ({ chat, me, text }) => {
  plans.push({ apply: () => { outgoing(text, chat, me); } });
  const reply = await result(SEND);
  expect(reply.value).toBeNull();
  expect(reply.failure).toMatchObject({ code: "effect_unknown", effect: "possibly_effected", retryable: false });
  expect(attempts).toEqual([[TEXT, CHAT]]);
});

test("a successful subprocess without a new outgoing receipt does not report success", async () => {
  plans.push({});
  const reply = await result(SEND);
  expect(reply.value).toBeNull();
  expect(reply.failure).toMatchObject({ code: "effect_unknown", effect: "possibly_effected", retryable: false });
});

test("a command that could not start reports no send effect", async () => {
  plans.push({ start: false, error: Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" }) });
  const reply = await result(SEND);
  expect(reply.value).toBeNull();
  expect(reply.failure).toMatchObject({ code: "command_failed", effect: "none", retryable: false });
});

test("an explicit Automation refusal reports no send effect", async () => {
  plans.push({ error: Object.assign(new Error("Apple event refused"), { stderr: "Not authorized to send Apple events to Messages. (-1743)" }) });
  const reply = await result(SEND);
  expect(reply.value).toBeNull();
  expect(reply.failure).toMatchObject({ code: "blocked", effect: "none", retryable: false });
});

test("losing database access after dispatch does not erase the possible send", async () => {
  plans.push({ apply: () => { db.exec("DROP TABLE message"); } });
  const reply = await result(SEND);
  expect(reply.value).toBeNull();
  expect(reply.failure).toMatchObject({ code: "effect_unknown", effect: "possibly_effected", retryable: false });
});

test("an explicit new recipient is confirmed only in its new direct conversation", async () => {
  const to = "new@example.com";
  plans.push({ apply: () => {
    db.query("INSERT INTO chat VALUES (?, ?, NULL, 'iMessage', 45)").run(`iMessage;-;${to}`, to);
    outgoing(TEXT, 3);
  } });
  const reply = await result({ ...SEND, to });
  expect(reply.failure).toBeNull();
  expect(reply.value).toMatchObject({ status: "sent", to });
  expect(attempts).toEqual([[TEXT, to]]);
});

test("a file timeout still reconciles its attachment before sending the approved text", async () => {
  const file = join(home, "photo.jpg");
  writeFileSync(file, "photo");
  plans.push(
    { error: timedOut(), delay: 20000, apply: () => { setTimeout(() => attachment("photo.jpg"), 20500); } },
    { apply: () => { outgoing(TEXT); } },
  );
  const reply = await result({ ...SEND, files: [file] });
  expect(reply.failure).toBeNull();
  expect(reply.value).toMatchObject({ status: "sent", files: [{ file: "photo.jpg", bytes: 5 }] });
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual([TEXT, CHAT]);
});

test("a same-named attachment in another conversation cannot release the remaining text", async () => {
  const file = join(home, "photo.jpg");
  writeFileSync(file, "photo");
  plans.push({ apply: () => { attachment("photo.jpg", 2); } });
  const reply = await result({ ...SEND, files: [file] });
  expect(reply.value).toBeNull();
  expect(reply.failure).toMatchObject({ code: "effect_unknown", effect: "possibly_effected", retryable: false });
  expect(attempts).toHaveLength(1);
  expect(reply.failure?.message).toContain("The text was not sent");
});

test("a later pre-dispatch failure preserves the already-sent file effect", async () => {
  const first = join(home, "first.jpg");
  const second = join(home, "second.jpg");
  writeFileSync(first, "photo");
  writeFileSync(second, "other");
  plans.push(
    { apply: () => { attachment("first.jpg"); } },
    { start: false, error: Object.assign(new Error("spawn osascript ENOENT"), { code: "ENOENT" }) },
  );
  const reply = await result({ ...SEND, files: [first, second] });
  expect(reply.value).toBeNull();
  expect(reply.failure).toMatchObject({ code: "effect_unknown", effect: "possibly_effected", retryable: false });
  expect(reply.failure?.message).toContain("Sent before this failure: first.jpg");
  expect(attempts).toHaveLength(2);
  expect(db.query("SELECT COUNT(*) n FROM attachment WHERE transfer_name = 'first.jpg'").get()).toEqual({ n: 1 });
});
