import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as imessage from "./imessage.ts";
import { findCode } from "./imessage.ts";

// imessage_wait_code types whatever findCode returns into a sign-in form, so
// a wrong number is worse than none.

test("finds the code in common sign-in texts", () => {
  expect(findCode("Your Apple Account code is: 482913. Don't share it with anyone.")).toBe("482913");
  expect(findCode("G-551203 is your Google verification code.")).toBe("551203");
  expect(findCode("Chase: your one-time code is 123-456. We will never call to ask for it.")).toBe("123456");
});

test("picks the number next to the sign-in word, not a date or amount", () => {
  expect(findCode("On Sep 25 2026 your verification code is 4829")).toBe("4829");
  expect(findCode("Payment of 2500 pending. Your login code: 771204")).toBe("771204");
});

test("ignores numbers in texts that are not sign-in codes", () => {
  expect(findCode("Your order #58213 has shipped and is confirmed")).toBeNull();
  expect(findCode("Verification for order #58213 failed, reply HELP")).toBeNull();
  expect(findCode("Your order 58213 has shipped")).toBeNull();
  expect(findCode("Lunch at 1230?")).toBeNull();
  expect(findCode("Use code SAVE20 to get $15 off")).toBeNull();
  expect(findCode("A login attempt at 10:45 was blocked")).toBeNull();
});

// textOwner texts the user's own phone and says how far the text got.
// Messages is a fake: a scratch database with the columns the harness
// reads, where a copy over a service that works is sent and the line comes
// back as received 4 s later, and one over a service that fails is
// recorded with error 4, sent or not as his Mac recorded them: an SMS one
// unsent, an RCS one sent. The clock moves on only while textOwner sleeps.

const OWN = "+15550100000";
const HANDLE = { SMS: 1, RCS: 2 };
const LINE = "shop.example is waiting on a check in safari. reply done, skip or stop";

let dir = "";
let db: Database;
// what fails, as "SMS line" or "RCS picture"
let fails = new Set<string>();
let sent: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "safari-imessage-"));
  fails = new Set();
  sent = [];
  db = new Database(join(dir, "chat.db"));
  db.run("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)");
  db.run("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER, handle_id INTEGER, service TEXT, is_sent INTEGER, error INTEGER, cache_has_attachments INTEGER, destination_caller_id TEXT)");
  db.query("INSERT INTO handle VALUES (?, ?), (?, ?)").run(HANDLE.SMS, OWN, HANDLE.RCS, OWN);
  // his newest message, which says his number
  db.query("INSERT INTO message (text, is_from_me, handle_id, service, is_sent, error, cache_has_attachments, destination_caller_id) VALUES ('hi', 1, ?, 'RCS', 1, 0, 0, ?)").run(HANDLE.RCS, OWN);
  spyOn(imessage, "openChatDb").mockImplementation(() => new Database(join(dir, "chat.db")));
  spyOn(imessage, "textOver").mockImplementation(async (service, to, what, picture = false) => {
    const kind = picture ? "picture" : "line";
    sent.push(`${service} ${kind}`);
    const failing = fails.has(`${service} ${kind}`);
    db.query("INSERT INTO message (text, is_from_me, handle_id, service, is_sent, error, cache_has_attachments) VALUES (?, 1, ?, ?, ?, ?, ?)")
      .run(picture ? null : what, HANDLE[service], service, failing && service === "SMS" ? 0 : 1, failing ? 4 : 0, picture ? 1 : 0);
    if (!failing && !picture && to === OWN) setTimeout(() => db.query("INSERT INTO message (text, is_from_me, handle_id, service, is_sent, error, cache_has_attachments) VALUES (?, 0, ?, 'RCS', 0, 0, 0)").run(what, HANDLE.RCS), 4000);
  });
  jest.useFakeTimers();
  spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    jest.advanceTimersByTime(Number(ms));
  });
});
afterEach(() => {
  mock.restore();
  jest.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a line whose SMS copy fails goes again over RCS, and counts as received once that copy comes back", async () => {
  fails.add("SMS line");
  expect(await imessage.textOwner(LINE)).toEqual({ status: "received", to: OWN, after: 1 });
  expect(sent).toEqual(["SMS line", "RCS line"]);
});

test("a line that fails over SMS and over RCS fails, naming both errors", async () => {
  fails.add("SMS line").add("RCS line");
  await expect(imessage.textOwner(LINE)).rejects.toThrow("Messages reported error 4 over SMS and error 4 over RCS texting the user's phone");
});

test("a picture that fails over SMS and over RCS never costs the line, and the result says why it did not go", async () => {
  fails.add("SMS picture").add("RCS picture");
  expect(await imessage.textOwner(LINE, "/tmp/screen.png")).toEqual({
    status: "received",
    picture: "Messages reported error 4 over SMS and error 4 over RCS sending the picture",
    to: OWN,
    after: 1,
  });
  expect(sent).toEqual(["SMS picture", "SMS line", "RCS picture"]);
});
