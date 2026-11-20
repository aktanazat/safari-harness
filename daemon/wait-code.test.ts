import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// A stand-in Messages under an isolated home. imessage.ts reads the home as
// it loads, so the waits run in a child that starts with that home.
const home = mkdtempSync("/private/var/tmp/wait-code-");
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("a resent code is answered, not the expired one before it, and not twice", async () => {
  const folder = join(home, "Library", "Messages");
  mkdirSync(folder, { recursive: true });
  const db = new Database(join(folder, "chat.db"));
  db.exec(`
    CREATE TABLE handle (id TEXT);
    CREATE TABLE message (date INTEGER, is_from_me INTEGER, text TEXT, attributedBody BLOB,
      cache_has_attachments INTEGER, handle_id INTEGER, item_type INTEGER, associated_message_type INTEGER,
      is_sent INTEGER, is_delivered INTEGER, error INTEGER);
    INSERT INTO handle VALUES ('63641');
  `);
  const insert = db.query("INSERT INTO message VALUES (?, 0, ?, NULL, 0, 1, 0, 0, 0, 1, 0)");
  for (const [code, ago] of [["111111", 20_000], ["222222", 10_000]] as const) insert.run((Date.now() - ago - Date.UTC(2001, 0, 1)) * 1e6, `Your Example verification code is ${code}`);
  db.close();
  const child = Bun.spawn([process.execPath, "-e", `
    import { waitCode } from "./imessage.ts";
    const first = await waitCode({ seconds: 1 });
    console.log(JSON.stringify([first, await waitCode({ seconds: 1, since: first.since })]));
  `], { cwd: import.meta.dir, env: { ...process.env, HOME: home }, stdout: "pipe" });
  const [first, second] = JSON.parse(await new Response(child.stdout).text());
  expect(first).toMatchObject({ status: "received", code: "222222" });
  expect(second).toMatchObject({ status: "timeout" });
});
