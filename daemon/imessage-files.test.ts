import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync("/private/var/tmp/imessage-files-");
  homes.push(home);
  const folder = join(home, "Library", "Messages");
  mkdirSync(folder, { recursive: true });
  const db = new Database(join(folder, "chat.db"));
  db.exec(`
    CREATE TABLE chat (guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT, style INTEGER);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (guid TEXT, date INTEGER, is_from_me INTEGER, text TEXT, attributedBody BLOB,
      cache_has_attachments INTEGER, handle_id INTEGER, item_type INTEGER, associated_message_type INTEGER,
      thread_originator_guid TEXT, associated_message_guid TEXT, associated_message_emoji TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE attachment (guid TEXT, transfer_name TEXT, mime_type TEXT, total_bytes INTEGER,
      filename TEXT, transfer_state INTEGER, hide_attachment INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO chat VALUES ('iMessage;-;fixture@example.com','fixture@example.com',NULL,'iMessage',45);
    INSERT INTO handle VALUES ('fixture@example.com');
    INSERT INTO chat_handle_join VALUES (1,1);
    INSERT INTO message VALUES ('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',812678400000000000,0,'photos',NULL,1,1,0,0,NULL,NULL,NULL);
    INSERT INTO chat_message_join VALUES (1,1,812678400000000000);
    INSERT INTO attachment VALUES ('local','photo.jpg','image/jpeg',5,'~/Library/Messages/photo.jpg',0,0);
    INSERT INTO attachment VALUES ('cloud','cloud.jpg','image/jpeg',5,'~/Library/Messages/missing.jpg',5,0);
    INSERT INTO attachment VALUES ('preview','preview.pluginPayloadAttachment',NULL,5,NULL,5,1);
    INSERT INTO message_attachment_join VALUES (1,1),(1,2),(1,3);
  `);
  writeFileSync(join(folder, "photo.jpg"), "photo");
  return { home, db, folder };
}

async function invoke(home: string, tool: string, args: Record<string, unknown>) {
  const code = `import { IMESSAGE_TOOLS } from ${JSON.stringify(join(import.meta.dir, "imessage.ts"))};
    const {tool,args} = JSON.parse(await Bun.stdin.text());
    try { console.log(JSON.stringify(await IMESSAGE_TOOLS[tool].run(args))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const child = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ tool, args }));
  child.stdin.end();
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status, value: stdout ? JSON.parse(stdout) : null, error: stderr.trim() };
}

test("history distinguishes real local files from offloaded files and hidden previews", async () => {
  const { home, db, folder } = fixture();
  db.close();
  const result = await invoke(home, "imessage_history", { chat: "iMessage;-;fixture@example.com" });
  expect(result.error).toBe("");
  expect(result.status).toBe(0);
  expect(result.value.messages[0].files).toEqual([
    { id: "local", name: "photo.jpg", mime: "image/jpeg", bytes: 5, downloaded: true, path: join(folder, "photo.jpg") },
    { id: "cloud", name: "cloud.jpg", mime: "image/jpeg", bytes: 5, downloaded: false },
  ]);
});

// A reaction someone took back must not be reported as standing; taking
// one back from a part of a message leaves the same one on another part,
// and another device's clock can date a reaction before its message.
test("history shows what a reply answers and only the reactions still standing", async () => {
  const { home, db } = fixture();
  db.exec(`
    INSERT INTO message VALUES ('CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC',812678400000000010,1,'nice',NULL,0,0,0,0,'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',NULL,NULL);
    INSERT INTO message VALUES ('R1',812678399000000000,0,NULL,NULL,0,1,0,2001,NULL,'p:0/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',NULL);
    INSERT INTO message VALUES ('R2',812678400000000030,1,NULL,NULL,0,0,0,2000,NULL,'p:0/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',NULL);
    INSERT INTO message VALUES ('R3',812678400000000035,1,NULL,NULL,0,0,0,2000,NULL,'p:1/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',NULL);
    INSERT INTO message VALUES ('R4',812678400000000040,1,NULL,NULL,0,0,0,3000,NULL,'p:1/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',NULL);
    INSERT INTO message VALUES ('R5',812678400000000045,0,NULL,NULL,0,1,0,2003,NULL,'p:0/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',NULL);
    INSERT INTO message VALUES ('R6',812678400000000046,0,NULL,NULL,0,1,0,3003,NULL,'p:0/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',NULL);
    INSERT INTO message VALUES ('R7',812678400000000050,0,NULL,NULL,0,1,0,2006,NULL,'bp:CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC','★');
    INSERT INTO chat_message_join VALUES (1,2,812678400000000010),(1,3,812678399000000000),(1,4,812678400000000030),(1,5,812678400000000035),(1,6,812678400000000040),(1,7,812678400000000045),(1,8,812678400000000046),(1,9,812678400000000050);
  `);
  db.close();
  const result = await invoke(home, "imessage_history", { chat: "iMessage;-;fixture@example.com" });
  expect(result.error).toBe("");
  expect(result.value.messages).toHaveLength(2);
  const [photos, reply] = result.value.messages;
  expect(photos.reactions).toEqual([{ from: "fixture@example.com", reaction: "liked" }, { from: "me", reaction: "loved" }]);
  expect(reply.replyTo).toEqual({ rowid: 1, from: "fixture@example.com", text: "photos" });
  expect(reply.reactions).toEqual([{ from: "fixture@example.com", reaction: "★" }]);
});

// Messages on macOS before 11 has no reply column, before 15 no emoji one.
test("history and search still read a Messages database without reply or emoji columns", async () => {
  const { home, db } = fixture();
  db.exec(`
    INSERT INTO message VALUES ('R1',812678400000000020,0,NULL,NULL,0,1,0,2001,NULL,'p:0/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',NULL);
    INSERT INTO chat_message_join VALUES (1,2,812678400000000020);
    ALTER TABLE message DROP COLUMN thread_originator_guid;
    ALTER TABLE message DROP COLUMN associated_message_emoji;
  `);
  db.close();
  const history = await invoke(home, "imessage_history", { chat: "iMessage;-;fixture@example.com" });
  expect(history.error).toBe("");
  expect(history.value.messages.map((m: { text: string; reactions?: unknown }) => [m.text, m.reactions])).toEqual([["photos", [{ from: "fixture@example.com", reaction: "liked" }]]]);
  const search = await invoke(home, "imessage_search", { text: "photos", days: 36500 });
  expect(search.error).toBe("");
  expect(search.value.map((m: { text: string }) => m.text)).toEqual(["photos"]);
});

test("saving two same-named attachments preserves both files and an existing destination", async () => {
  const { home, db, folder } = fixture();
  db.exec("UPDATE attachment SET filename='~/Library/Messages/second.jpg', transfer_name='../photo.jpg' WHERE guid='cloud'");
  db.close();
  writeFileSync(join(folder, "second.jpg"), "other");
  const out = join(home, "saved");
  mkdirSync(out);
  writeFileSync(join(out, "photo.jpg"), "existing");
  const result = await invoke(home, "imessage_files", { ids: ["local", "cloud", "local"], out });
  expect(result.status).toBe(0);
  expect(result.value.files.map((file: { path: string }) => readFileSync(file.path, "utf8"))).toEqual(["photo", "other"]);
  expect(result.value.files.map((file: { path: string }) => dirname(file.path))).toEqual([out, out]);
  expect(readFileSync(join(out, "photo.jpg"), "utf8")).toBe("existing");
});

test("an unknown attachment prevents saving the rest of a requested batch", async () => {
  const { home, db } = fixture();
  db.close();
  const out = join(home, "saved");
  const result = await invoke(home, "imessage_files", { ids: ["local", "unknown"], out });
  expect(result.status).toBe(1);
  expect(result.error).toContain("no visible Messages attachment: unknown");
  expect(existsSync(out)).toBe(false);
});

// On 10-07 and 10-12 agents searched one conversation's texts by naming
// it, four times, and each call failed: search took no chat.
test("a search with a chat finds the words in that conversation only", async () => {
  const { home, db } = fixture();
  db.exec(`
    INSERT INTO chat VALUES ('iMessage;-;other@example.com','other@example.com',NULL,'iMessage',45);
    INSERT INTO handle VALUES ('other@example.com');
    INSERT INTO chat_handle_join VALUES (2,2);
    INSERT INTO message VALUES ('BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',812678400000000001,0,'more photos',NULL,0,2,0,0,NULL,NULL,NULL);
    INSERT INTO chat_message_join VALUES (2,2,812678400000000001);
  `);
  db.close();
  const all = await invoke(home, "imessage_search", { text: "photos", days: 36500 });
  const one = await invoke(home, "imessage_search", { text: "photos", chat: "other@example.com", days: 36500 });
  expect(all.value.map((m: { text: string }) => m.text)).toEqual(["more photos", "photos"]);
  expect(one.value.map((m: { text: string }) => m.text)).toEqual(["more photos"]);
  const cli = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli", "browser.ts"), "imessage", "search", "photos", "--chat", "other@example.com", "--days", "36500", "--json"], {
    env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const [printed] = await Promise.all([new Response(cli.stdout).text(), cli.exited]);
  expect(JSON.parse(printed).map((m: { text: string }) => m.text)).toEqual(["more photos"]);
});
