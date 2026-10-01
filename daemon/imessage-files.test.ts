import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
      cache_has_attachments INTEGER, handle_id INTEGER, item_type INTEGER, associated_message_type INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE attachment (guid TEXT, transfer_name TEXT, mime_type TEXT, total_bytes INTEGER,
      filename TEXT, transfer_state INTEGER, hide_attachment INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO chat VALUES ('iMessage;-;fixture@example.com','fixture@example.com',NULL,'iMessage',45);
    INSERT INTO handle VALUES ('fixture@example.com');
    INSERT INTO chat_handle_join VALUES (1,1);
    INSERT INTO message VALUES ('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',812678400000000000,0,'photos',NULL,1,1,0,0);
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
  expect(result.value.files.map((file: { path: string }) => file.path)).toEqual([join(out, "photo 2.jpg"), join(out, "photo 3.jpg")]);
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
