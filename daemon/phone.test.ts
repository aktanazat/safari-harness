import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as imessage from "./imessage.ts";
import * as phone from "./phone.ts";

// Every text to the user's phone goes through phone.ts: it holds them to six
// an hour, and picks his replies out of his thread with his own number.
// Messages is a fake: a scratch database with the columns the harness reads,
// where a line texted to his own number shows twice, as sent and, a second
// later, as received.

const OWN = "+15550100000";
// his number over SMS and over RCS, and someone else's
const [SMS, RCS, OTHER] = [1, 2, 3];
const ALERT = "shop.example is waiting on a check in safari. the agent carries on by itself once you clear it. reply done, skip or stop";

let dir = "";
let db: Database;
let sent: string[] = [];
let failing = false;

function write(text: string, o: { me: boolean; handle: number; tapback?: true; at?: number }) {
  db.query("INSERT INTO message (text, is_from_me, handle_id, item_type, associated_message_type, date) VALUES (?, ?, ?, 0, ?, ?)")
    .run(text, o.me ? 1 : 0, o.handle, o.tapback ? 2001 : 0, ((o.at ?? Date.now()) - Date.UTC(2001, 0, 1)) * 1e6);
}
function both(text: string, at = Date.now()) {
  write(text, { me: true, handle: SMS, at });
  write(text, { me: false, handle: RCS, at: at + 1000 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "safari-phone-"));
  sent = [];
  failing = false;
  db = new Database(join(dir, "chat.db"));
  db.run("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)");
  db.run("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER, handle_id INTEGER, item_type INTEGER, associated_message_type INTEGER, date INTEGER)");
  db.query("INSERT INTO handle VALUES (?, ?), (?, ?), (?, ?)").run(SMS, OWN, RCS, OWN, OTHER, "+15550199999");
  spyOn(phone, "dataFile").mockImplementation((name) => join(dir, name));
  spyOn(imessage, "openChatDb").mockImplementation(() => new Database(join(dir, "chat.db")));
  spyOn(imessage, "textOwner").mockImplementation(async (line) => {
    if (failing) throw new Error("Messages did not send: no network");
    const after = db.query<{ n: number }, []>("SELECT IFNULL(MAX(ROWID), 0) n FROM message").get()?.n ?? 0;
    sent.push(line);
    both(line);
    return { status: "received", to: OWN, after };
  });
  spyOn(imessage, "textOwnNumber").mockImplementation(async (_to, line) => {
    sent.push(line);
    both(line);
  });
});
afterEach(() => {
  mock.restore();
  setSystemTime();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the harness texts the user's phone at most six times an hour, whatever the text; the seventh waits until the first is an hour old", async () => {
  const start = Date.UTC(2026, 8, 28, 12);
  const kinds = ["ask", "handoff", "note", "ask", "handoff", "note"] as const;
  for (const [i, kind] of kinds.entries()) {
    setSystemTime(start + i * 60_000);
    await phone.text(`text ${i}`, kind, kind === "note" ? { to: OWN } : {});
  }
  setSystemTime(start + 30 * 60_000);
  // the agent learns when it may text again
  await expect(phone.text("text 6", "ask")).rejects.toThrow(/\b30 min\b/);
  setSystemTime(start + 60 * 60_000);
  await phone.text("text 6", "ask");
  expect(sent).toEqual(["text 0", "text 1", "text 2", "text 3", "text 4", "text 5", "text 6"]);
});

test("a text Messages fails to send gives back its place in the hour", async () => {
  failing = true;
  await expect(phone.text("text 0", "ask")).rejects.toThrow("Messages did not send");
  failing = false;
  for (let i = 1; i <= 6; i++) await phone.text(`text ${i}`, "ask");
  expect(sent).toHaveLength(6);
});

test("his replies come from his own thread after the text: a reply to an earlier text, a tapback, or someone else's text never counts, and a line that shows twice counts once", async () => {
  // the same alert an hour ago, and his reply to that one
  const hourAgo = Date.now() - 3_600_000;
  both(ALERT, hourAgo);
  both("skip", hourAgo + 60_000);
  const { thread } = await phone.text(ALERT, "handoff");
  write("stop", { me: false, handle: OTHER });
  write("stop", { me: false, handle: RCS, tapback: true });
  both("Done");
  expect(phone.replies(thread)).toEqual(["Done"]);
});

test("with a question and a handoff out at once, a word the handoff takes goes to it, and any other reply to the question", async () => {
  const asked = await phone.text("an agent asks: which color? reply 1 for red, 2 for blue", "ask");
  const handed = await phone.text(ALERT, "handoff");
  both("skip");
  both("blue");
  expect(phone.replies(handed.thread)).toEqual(["skip"]);
  expect(phone.replies(asked.thread)).toEqual(["blue"]);
});
