// Messages: read chats, history, and search from ~/Library/Messages/chat.db
// (read-only), wait for sign-in codes, look up contacts, and send texts and
// files through the Messages app. Reading needs Full Disk Access for the
// process that runs this, so these tools run in the caller (terminal, MCP
// server) rather than in the launchd daemon, which macOS denies. Sending needs
// the caller to be allowed to control Messages, and returns a draft first.

import { Database } from "bun:sqlite";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./tools.ts";

const execFileAsync = promisify(execFile);
const HOME = homedir();
const CHAT_DB = join(HOME, "Library", "Messages", "chat.db");
const ADDRESS_BOOK = join(HOME, "Library", "Application Support", "AddressBook");

const ATTACHMENTS = join(import.meta.dir, "..", "scripts", "attachments");
// chat.db dates are nanoseconds since 2001-01-01.
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const toDate = (ns: number) => new Date(APPLE_EPOCH_MS + Math.floor(ns / 1e6)).toISOString();
const toAppleNs = (ms: number) => (ms - APPLE_EPOCH_MS) * 1e6;

// Messages keep what counts as a real message: no tapbacks, no group events.
const REAL = "m.item_type = 0 AND NOT (m.associated_message_type BETWEEN 2000 AND 3999)";

export function openChatDb(): Database {
  try {
    return new Database(CHAT_DB, { readonly: true });
  } catch (e) {
    throw new Error(`cannot read Messages (${String(e instanceof Error ? e.message : e)}); the app running this needs Full Disk Access in System Settings > Privacy & Security`);
  }
}

// Newer macOS stores many messages only in attributedBody, an NSArchiver
// typedstream: "NSString", a few marker bytes, '+', a length, then UTF-8.
function decodeBody(blob: Uint8Array | null): string {
  if (!blob) return "";
  const buf = Buffer.from(blob);
  const at = buf.indexOf("NSString");
  if (at < 0) return "";
  let i = buf.indexOf(0x2b, at + 8);
  if (i < 0) return "";
  i++;
  let len = buf[i++];
  if (len === 0x81) { len = buf.readUInt16LE(i); i += 2; }
  else if (len === 0x82) { len = buf.readUInt32LE(i); i += 4; }
  return buf.subarray(i, i + len).toString("utf8");
}

// U+FFFC marks where an attachment sits in the text.
function messageText(text: string | null, body: Uint8Array | null): string {
  return (text ?? decodeBody(body)).replace(/\ufffc/g, "").trim();
}

// ---------- contacts ----------

type Contact = { name: string; phones: string[]; emails: string[] };

function handleKey(handle: string): string {
  if (handle.includes("@")) return handle.trim().toLowerCase();
  const digits = handle.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function addressBooks(): string[] {
  const dbs = [join(ADDRESS_BOOK, "AddressBook-v22.abcddb")];
  const sources = join(ADDRESS_BOOK, "Sources");
  if (existsSync(sources)) for (const s of readdirSync(sources)) dbs.push(join(sources, s, "AddressBook-v22.abcddb"));
  return dbs.filter((p) => existsSync(p));
}

function loadContacts(): Contact[] {
  const out: Contact[] = [];
  for (const path of addressBooks()) {
    const db = new Database(path, { readonly: true });
    try {
      const people = db.query(
        "SELECT Z_PK id, ZFIRSTNAME f, ZMIDDLENAME m, ZLASTNAME l, ZNICKNAME n, ZORGANIZATION o FROM ZABCDRECORD WHERE COALESCE(ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION) IS NOT NULL",
      ).all() as { id: number; f: string | null; m: string | null; l: string | null; n: string | null; o: string | null }[];
      const phones = db.query("SELECT ZOWNER owner, ZFULLNUMBER v FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL").all() as { owner: number; v: string }[];
      const emails = db.query("SELECT ZOWNER owner, ZADDRESS v FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL").all() as { owner: number; v: string }[];
      for (const p of people) {
        const full = [p.f, p.m, p.l].filter(Boolean).join(" ");
        const name = [full || p.o || "", p.n && p.n !== full ? `(${p.n})` : ""].filter(Boolean).join(" ");
        out.push({ name, phones: phones.filter((x) => x.owner === p.id).map((x) => x.v), emails: emails.filter((x) => x.owner === p.id).map((x) => x.v) });
      }
    } finally {
      db.close();
    }
  }
  return out;
}

function nameIndex(contacts: Contact[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const c of contacts) for (const h of [...c.phones, ...c.emails]) index.set(handleKey(h), c.name);
  return index;
}

export function contacts(opts: { name: string }): Contact[] {
  const q = String(opts.name ?? "").trim().toLowerCase();
  if (!q) throw new Error("contacts needs name");
  return loadContacts().filter((c) => c.name.toLowerCase().includes(q)).slice(0, 20);
}

// ---------- chats ----------

type ChatRow = { id: number; guid: string; ident: string; dn: string | null; svc: string; style: number };
type ChatInfo = { chat: string; name: string; service: string; group: boolean; participants: string[] };

function participants(db: Database, chatId: number): string[] {
  return (db.query("SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id = ?").all(chatId) as { id: string }[]).map((r) => r.id);
}

function describe(db: Database, c: ChatRow, names: Map<string, string>): ChatInfo {
  const handles = participants(db, c.id);
  const label = (h: string) => names.get(handleKey(h)) ?? h;
  return {
    chat: c.guid,
    name: c.dn || (handles.length ? handles.map(label).join(", ") : label(c.ident)),
    service: c.svc,
    group: c.style === 43,
    participants: handles.map(label),
  };
}

const CHAT_COLS = "c.ROWID id, c.guid, c.chat_identifier ident, c.display_name dn, c.service_name svc, c.style";

// A chat by guid, handle, group name, or contact name. A person's direct chat
// wins over group chats they are in; if that person has several direct chats
// (different numbers), the most recent one is theirs. Anything else ambiguous
// is an error listing the candidates.
function resolveChat(db: Database, q: string, names: Map<string, string>): ChatRow {
  const needle = String(q ?? "").trim();
  if (!needle) throw new Error("give a chat: its id from imessage_chats, a phone number, an email, or a contact name");
  const exact = db.query(`SELECT ${CHAT_COLS} FROM chat c WHERE c.guid = ?`).get(needle) as ChatRow | null;
  if (exact) return exact;
  const key = handleKey(needle);
  const lower = needle.toLowerCase();
  const all = db.query(`SELECT ${CHAT_COLS}, (SELECT MAX(message_date) FROM chat_message_join j WHERE j.chat_id = c.ROWID) d FROM chat c ORDER BY d DESC`).all() as (ChatRow & { d: number | null })[];
  const who = (c: ChatRow) => [c.ident, ...participants(db, c.id)];
  const isPerson = (c: ChatRow) => who(c).some((h) => (key.length >= 7 && handleKey(h) === key) || (names.get(handleKey(h)) ?? "").toLowerCase().includes(lower));
  const tiers = [
    all.filter((c) => c.dn?.toLowerCase() === lower),
    all.filter((c) => c.style !== 43 && isPerson(c)),
    all.filter((c) => c.dn?.toLowerCase().includes(lower)),
    all.filter((c) => c.style === 43 && isPerson(c)),
  ];
  const matches = tiers.find((t) => t.length) ?? [];
  if (!matches.length) throw new Error(`no chat matches "${needle}"`);
  const label = (c: ChatRow) => describe(db, c, names).name;
  if (matches.length === 1 || (matches[0].style !== 43 && matches.every((c) => label(c) === label(matches[0])))) return matches[0];
  const list = matches.slice(0, 8).map((c) => `${label(c)} (${c.guid})`).join("; ");
  throw new Error(`"${needle}" matches ${matches.length} chats; pass one chat id: ${list}`);
}

export function chats(opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(Number(opts.limit ?? 20), 1), 100);
  const db = openChatDb();
  try {
    const names = nameIndex(loadContacts());
    const rows = db.query(`
      WITH last AS (SELECT chat_id, MAX(message_date) d, message_id FROM chat_message_join GROUP BY chat_id ORDER BY d DESC LIMIT ?)
      SELECT ${CHAT_COLS}, m.date, m.text, m.attributedBody body, m.is_from_me me,
        (SELECT COUNT(*) FROM chat_message_join j JOIN message u ON u.ROWID = j.message_id
          WHERE j.chat_id = c.ROWID AND u.is_read = 0 AND u.is_from_me = 0 AND u.item_type = 0 AND u.error = 0) unread
      FROM last JOIN chat c ON c.ROWID = last.chat_id JOIN message m ON m.ROWID = last.message_id
      ORDER BY last.d DESC`).all(limit) as (ChatRow & { date: number; text: string | null; body: Uint8Array | null; me: number; unread: number })[];
    return rows.map((r) => ({
      ...describe(db, r, names),
      unread: r.unread,
      last: { at: toDate(r.date), fromMe: r.me === 1, text: messageText(r.text, r.body).slice(0, 200) },
    }));
  } finally {
    db.close();
  }
}

type MsgRow = { rowid: number; date: number; me: number; text: string | null; body: Uint8Array | null; att: number; handle: string | null };

function toMessage(r: MsgRow, names: Map<string, string>) {
  return {
    rowid: r.rowid,
    at: toDate(r.date),
    from: r.me === 1 ? "me" : r.handle ? names.get(handleKey(r.handle)) ?? r.handle : "unknown",
    text: messageText(r.text, r.body),
    ...(r.att ? { attachment: true } : {}),
  };
}

const MSG_COLS = "m.ROWID rowid, m.date, m.is_from_me me, m.text, m.attributedBody body, m.cache_has_attachments att, h.id handle";

export function history(opts: { chat: string; limit?: number; since?: number }) {
  const limit = Math.min(Math.max(Number(opts.limit ?? 30), 1), 200);
  const db = openChatDb();
  try {
    const names = nameIndex(loadContacts());
    const c = resolveChat(db, opts.chat, names);
    const rows = db.query(`
      SELECT ${MSG_COLS} FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE j.chat_id = ? AND m.ROWID > ? AND ${REAL} ORDER BY m.date DESC LIMIT ?`).all(c.id, Number(opts.since ?? 0), limit) as MsgRow[];
    const files = messageFiles(db, rows.map((r) => r.rowid));
    return { ...describe(db, c, names), messages: rows.reverse().map((r) => ({ ...toMessage(r, names), ...(files.has(r.rowid) ? { files: files.get(r.rowid) } : {}) })) };
  } finally {
    db.close();
  }
}

export function search(opts: { text?: string; from?: string; days?: number; limit?: number }) {
  const text = String(opts.text ?? "").trim().toLowerCase();
  const from = String(opts.from ?? "").trim();
  if (!text && !from) throw new Error("search needs text and/or from");
  const limit = Math.min(Math.max(Number(opts.limit ?? 30), 1), 200);
  const since = toAppleNs(Date.now() - Number(opts.days ?? 90) * 86_400_000);
  const db = openChatDb();
  try {
    const book = loadContacts();
    const names = nameIndex(book);
    // `from` is a handle or a contact name; a name covers all of that contact's handles.
    const fromKeys = new Set<string>();
    if (from) {
      const lower = from.toLowerCase();
      for (const c of book) if (c.name.toLowerCase().includes(lower)) for (const h of [...c.phones, ...c.emails]) fromKeys.add(handleKey(h));
      if (handleKey(from).length >= 7 || from.includes("@")) fromKeys.add(handleKey(from));
      if (!fromKeys.size) throw new Error(`no contact or handle matches "${from}"`);
    }
    const rows = db.query(`
      SELECT ${MSG_COLS}, c.guid chat, c.ROWID cid, c.chat_identifier ident, c.display_name dn, c.service_name svc, c.style
      FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.date >= ? AND ${REAL} AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
      ORDER BY m.date DESC`).all(since) as (MsgRow & { chat: string; cid: number; ident: string; dn: string | null; svc: string; style: number })[];
    const hits = [];
    for (const r of rows) {
      if (fromKeys.size && (r.me === 1 || !r.handle || !fromKeys.has(handleKey(r.handle)))) continue;
      const msg = toMessage(r, names);
      if (text && !msg.text.toLowerCase().includes(text)) continue;
      hits.push({ ...msg, chat: r.chat, chatName: describe(db, { id: r.cid, guid: r.chat, ident: r.ident, dn: r.dn, svc: r.svc, style: r.style }, names).name });
      if (hits.length >= limit) break;
    }
    const files = messageFiles(db, hits.map((r) => r.rowid));
    return hits.map((r) => ({ ...r, ...(files.has(r.rowid) ? { files: files.get(r.rowid) } : {}) }));
  } finally {
    db.close();
  }
}

// ---------- receiving files ----------

type AttachmentRow = {
  rowid: number; id: string; name: string | null; mime: string | null; bytes: number;
  path: string | null; state: number; message: number; messageGuid: string; date: number; chat: number;
};
type AttachmentInfo = { id: string; name: string; mime: string | null; bytes: number; downloaded: boolean; path?: string };

function attachmentRows(db: Database, where: string, values: (string | number)[]): AttachmentRow[] {
  const rows = db.query<AttachmentRow, (string | number)[]>(`
    SELECT DISTINCT a.ROWID rowid, a.guid id, a.transfer_name name, a.mime_type mime,
      a.total_bytes bytes, a.filename path, a.transfer_state state, m.ROWID message,
      m.guid messageGuid, m.date, cj.chat_id chat
    FROM attachment a JOIN message_attachment_join j ON j.attachment_id = a.ROWID
      JOIN message m ON m.ROWID = j.message_id JOIN chat_message_join cj ON cj.message_id = m.ROWID
    WHERE COALESCE(a.hide_attachment, 0) = 0 AND ${REAL} AND (${where})`).all(...values);
  // ROWID is download order, not the order of pictures within the message.
  const part = (r: AttachmentRow) => Number(/^at_(\d+)_/.exec(r.id)?.[1] ?? r.rowid);
  return rows.sort((a, b) => a.date - b.date || a.message - b.message || part(a) - part(b));
}

function localAttachment(row: AttachmentRow): string | undefined {
  if (!row.path || (row.state !== 0 && row.state !== TRANSFER_DONE)) return undefined;
  const path = row.path.startsWith("~/") ? join(HOME, row.path.slice(2)) : row.path;
  const st = statSync(path, { throwIfNoEntry: false });
  // State 5 can survive offloading, and state 0 can still have a local file.
  return st?.isFile() && st.size > 0 && (!row.bytes || st.size === row.bytes) ? path : undefined;
}

function attachmentInfo(row: AttachmentRow): AttachmentInfo {
  const path = localAttachment(row);
  return { id: row.id, name: basename(row.name || row.path || row.id), mime: row.mime, bytes: row.bytes, downloaded: path !== undefined, ...(path ? { path } : {}) };
}

function messageFiles(db: Database, messages: number[]) {
  const files = new Map<number, AttachmentInfo[]>();
  if (!messages.length) return files;
  for (const row of attachmentRows(db, `m.ROWID IN (${messages.map(() => "?").join(",")})`, messages)) {
    const group = files.get(row.message) ?? [];
    if (!group.some((file) => file.id === row.id)) group.push(attachmentInfo(row));
    files.set(row.message, group);
  }
  return files;
}

async function attachmentHelper(args: string[], request?: unknown): Promise<{ pressed?: string[]; launched?: number; error?: string; clipboard?: boolean }> {
  const running = execFileAsync(ATTACHMENTS, args, { timeout: 20000 });
  const kill = () => running.child.kill();
  process.once("exit", kill);
  running.child.stdin?.end(request === undefined ? undefined : JSON.stringify(request));
  try {
    return JSON.parse((await running).stdout);
  } catch (e) {
    const stderr = typeof e === "object" && e !== null && "stderr" in e ? String(e.stderr).trim() : "";
    throw new Error(`Messages files ${args[0]} failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  } finally {
    process.off("exit", kill);
  }
}

function requestedAttachments(db: Database, ids: string[]) {
  const rows = attachmentRows(db, `a.guid IN (${ids.map(() => "?").join(",")})`, ids);
  return ids.map((id) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`no visible Messages attachment: ${id}`);
    return row;
  });
}

function saveAttachment(source: string, folder: string, name: string): string {
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let n = 1; ; n++) {
    const path = join(folder, n === 1 ? name : `${stem} ${n}${ext}`);
    try {
      copyFileSync(source, path, constants.COPYFILE_EXCL);
      return path;
    } catch (e) {
      if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
}

async function receiveFiles(opts: { ids: string[]; out?: string; clipboard?: boolean }) {
  if (!Array.isArray(opts.ids) || !opts.ids.length || opts.ids.some((id) => typeof id !== "string" || !id.trim())) throw new Error("ids must be attachment ids from imessage_history or imessage_search");
  if (opts.out !== undefined && !isAbsolute(opts.out)) throw new Error("out must be an absolute folder path");
  const ids = [...new Set(opts.ids)];
  const db = openChatDb();
  let launched: number | undefined;
  try {
    let rows = requestedAttachments(db, ids);
    const names = nameIndex(loadContacts());
    for (;;) {
      const missing = rows.filter((row) => !localAttachment(row));
      if (!missing.length) break;
      const target = missing[0];
      const minute = Math.floor(target.date / 60e9) * 60e9;
      const minuteFiles = attachmentRows(db, "cj.chat_id = ? AND m.date >= ? AND m.date < ?", [target.chat, minute, minute + 60e9]);
      const chat = db.query<ChatRow, [number]>(`SELECT ${CHAT_COLS} FROM chat c WHERE c.ROWID = ?`).get(target.chat);
      if (!chat) throw new Error("the attachment's conversation no longer exists");
      const wanted = new Set(missing.filter((row) => row.chat === target.chat && row.date >= minute && row.date < minute + 60e9).map((row) => row.id));
      const request = {
        guid: target.messageGuid, at: APPLE_EPOCH_MS / 1000 + target.date / 1e9,
        conversation: [describe(db, chat, names).name, chat.ident, ...(chat.dn ? [chat.dn] : [])],
        files: minuteFiles.map((row) => ({ id: row.id, name: row.name || basename(row.path || row.id), wanted: wanted.has(row.id) && !localAttachment(row) })),
      };
      const result = await attachmentHelper(["fetch"], request);
      launched ??= result.launched;
      if (result.error) throw new Error(result.error);
      const pressed = result.pressed;
      if (!pressed?.length || pressed.some((id) => !wanted.has(id))) throw new Error("Messages did not request the selected attachment downloads");
      const deadline = Date.now() + TRANSFER_MS;
      for (;;) {
        rows = requestedAttachments(db, ids);
        const pending = rows.filter((row) => pressed.includes(row.id) && !localAttachment(row));
        if (!pending.length) break;
        const failed = pending.find((row) => row.state === TRANSFER_FAILED);
        if (failed) throw new Error(`Messages failed to download ${failed.name || failed.id}; clipboard unchanged`);
        if (Date.now() >= deadline) throw new Error(`Messages did not finish downloading ${pending.map((row) => row.name || row.id).join(", ")} within ${TRANSFER_MS / 1000} s; clipboard unchanged`);
        await Bun.sleep(250);
      }
    }
    if (opts.out) mkdirSync(opts.out, { recursive: true });
    const files = rows.map((row) => {
      const source = localAttachment(row);
      if (!source) throw new Error(`${row.name || row.id} is no longer on this Mac; clipboard unchanged`);
      const info = attachmentInfo(row);
      const path = opts.out ? saveAttachment(source, opts.out, info.name) : source;
      return { ...info, downloaded: true, path };
    });
    if (opts.clipboard) {
      const copied = await attachmentHelper(["copy", ...files.map((file) => file.path)]);
      if (copied.clipboard !== true) throw new Error("the clipboard copy was not confirmed");
    }
    return { files, ...(opts.clipboard ? { clipboard: true } : {}) };
  } finally {
    db.close();
    if (launched !== undefined) await attachmentHelper(["quit", String(launched)]);
  }
}

// ---------- sign-in codes ----------

// A code needs a sign-in word; among several numbers (a date, an amount),
// the one nearest that word is the code. Order numbers, times, and prices
// without such a word are not codes.
const CODE_HINT = /\b(code|verif\w*|passcode|otp|pin|log ?in|sign[- ]?in|2fa|one[- ]time|authenticat\w*)\b/gi;
const CODE = /(?<![\d$.,#:])(\d{3}[- ]\d{3}|\d{4,8})(?![\d%:])/g;

export function findCode(text: string): string | null {
  const hints = [...text.matchAll(CODE_HINT)].map((m) => [m.index, m.index + m[0].length]);
  if (!hints.length) return null;
  let best: { code: string; gap: number } | null = null;
  for (const m of text.matchAll(CODE)) {
    const [s, e] = [m.index, m.index + m[0].length];
    const gap = Math.min(...hints.map(([hs, he]) => (e <= hs ? hs - e : s >= he ? s - he : 0)));
    if (!best || gap < best.gap) best = { code: m[1].replace(/[- ]/g, ""), gap };
  }
  return best?.code ?? null;
}

// A poll is one read by row id: about a microsecond on a 160,000-message
// database, so a 90-second wait costs about 2 ms of CPU. At 1.5 s a code sat
// unseen for 0.75 s on average.
const CODE_POLL_MS = 100;

export async function waitCode(opts: { seconds?: number; since?: number } = {}) {
  const seconds = Math.min(Math.max(Number(opts.seconds ?? 30), 1), 90);
  const deadline = Date.now() + seconds * 1000;
  const db = openChatDb();
  try {
    const names = nameIndex(loadContacts());
    const incoming = db.query(`
      SELECT ${MSG_COLS} FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ? AND m.date >= ? AND m.is_from_me = 0 AND ${REAL} ORDER BY m.ROWID`);
    // Without `since`, look back a minute: the code often lands before the call.
    let cursor = Number(opts.since ?? 0);
    const floor = opts.since === undefined ? toAppleNs(Date.now() - 60_000) : 0;
    for (;;) {
      for (const r of incoming.all(cursor, floor) as MsgRow[]) {
        cursor = Math.max(cursor, r.rowid);
        const code = findCode(messageText(r.text, r.body));
        if (code) return { status: "received", code, from: toMessage(r, names).from, at: toDate(r.date), rowid: r.rowid };
      }
      if (Date.now() >= deadline) {
        const max = (db.query("SELECT IFNULL(MAX(ROWID), 0) n FROM message").get() as { n: number }).n;
        return { status: "timeout", since: Math.max(cursor, max) };
      }
      await Bun.sleep(CODE_POLL_MS);
    }
  } finally {
    db.close();
  }
}

// ---------- sending ----------

// argv carries the text or file path and the target, so nothing is spliced
// into the script.
function sendScript(what: "text" | "file", to: "chat" | "handle"): string {
  const item = what === "file" ? "(POSIX file (item 1 of argv)) as alias" : "item 1 of argv";
  const target = to === "chat"
    ? "send x to chat id (item 2 of argv)"
    : "set svc to 1st account whose service type = iMessage\n    send x to participant (item 2 of argv) of svc";
  return `on run argv
  set x to ${item}
  tell application "Messages"
    ${target}
  end tell
end run`;
}

// Messages is sandboxed and reads a file handed to it by AppleScript only
// under ~/Library/Messages. From ~/Pictures the send passes, and Messages
// marks it delivered, as an empty bubble with no attachment row; from
// elsewhere the transfer fails. So each file is copied into a folder of its
// own here first; Messages copies it into its Attachments on taking it.
const STAGING = join(HOME, "Library", "Messages", ".send-staging");

// Our own newest message after a rowid, by its text.
const OUR_ROW = "SELECT is_sent, is_delivered, error FROM message WHERE ROWID > ? AND is_from_me = 1 AND text = ? ORDER BY ROWID DESC LIMIT 1";
type OurRow = { is_sent: number; is_delivered: number; error: number };

// Our own attachment after a rowid, by file name. A file went only when its
// row reaches transfer_state 5; the message row alone says delivered even
// for the empty bubble.
const OUR_ATTACHMENT = `SELECT m.ROWID rowid, m.error, a.transfer_state state, a.total_bytes bytes FROM attachment a
  JOIN message_attachment_join j ON j.attachment_id = a.ROWID JOIN message m ON m.ROWID = j.message_id
  WHERE m.ROWID > ? AND m.is_from_me = 1 AND a.transfer_name = ? ORDER BY m.ROWID LIMIT 1`;
type OurAttachment = { rowid: number; error: number; state: number; bytes: number };
const TRANSFER_DONE = 5;
const TRANSFER_FAILED = 6;
// Messages writes the attachment row within a second or two of the send;
// none by then means it dropped the file.
const ATTACH_APPEAR_MS = 15000;
const TRANSFER_MS = 120000;

async function runSend(script: string, argv: string[]): Promise<void> {
  try {
    await execFileAsync("osascript", ["-e", script, ...argv], { timeout: 20000 });
  } catch (e) {
    const msg = typeof e === "object" && e !== null && "stderr" in e && e.stderr ? String(e.stderr) : e instanceof Error ? e.message : String(e);
    if (/-1743|not allowed|Not authorized/i.test(msg)) throw new Error("macOS has not allowed this app to control Messages: System Settings > Privacy & Security > Automation");
    throw new Error(`Messages did not send: ${msg.trim()}`);
  }
}

function newestRowid(): number {
  const db = openChatDb();
  try {
    return (db.query("SELECT IFNULL(MAX(ROWID), 0) n FROM message").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

type FileToSend = { path: string; name: string; bytes: number };

function filesToSend(paths: unknown): FileToSend[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths)) throw new Error("files is a list of absolute file paths");
  return paths.map((p) => {
    const path = String(p);
    if (!isAbsolute(path)) throw new Error(`give an absolute path, not ${path}`);
    if (!existsSync(path)) throw new Error(`no file at ${path}`);
    const st = statSync(path);
    if (!st.isFile()) throw new Error(`${path} is not a file`);
    if (st.size === 0) throw new Error(`${path} is empty`);
    return { path, name: basename(path), bytes: st.size };
  });
}

// Sends one file and waits for chat.db to show it went; returns the rowid of
// its message, after which the next send's rows are looked for.
async function sendFile(file: FileToSend, dir: string, index: number, chat: boolean, target: string, after: number, to: string): Promise<number> {
  const own = join(dir, String(index));
  mkdirSync(own);
  const staged = join(own, file.name);
  copyFileSync(file.path, staged);
  await runSend(sendScript("file", chat ? "chat" : "handle"), [staged, target]);
  const start = Date.now();
  for (;;) {
    await Bun.sleep(500);
    const db = openChatDb();
    let row: OurAttachment | null;
    try {
      row = db.query<OurAttachment, [number, string]>(OUR_ATTACHMENT).get(after, file.name);
    } finally {
      db.close();
    }
    const waited = Date.now() - start;
    if (!row) {
      if (waited > ATTACH_APPEAR_MS) throw new Error(`Messages took ${file.name} but attached nothing; ${to} may have got an empty message. Check imessage_history before trying again.`);
      continue;
    }
    if (row.error || row.state === TRANSFER_FAILED) throw new Error(`Messages failed to send ${file.name} to ${to} (transfer state ${row.state}, error ${row.error})`);
    if (row.state === TRANSFER_DONE) return row.rowid;
    if (waited > TRANSFER_MS) throw new Error(`${file.name} was still uploading to ${to} after ${TRANSFER_MS / 1000} s (transfer state ${row.state}). Check imessage_history before trying again.`);
  }
}

export async function send(opts: { to: string; text?: string; files?: string[]; approved?: boolean }) {
  const text = String(opts.text ?? "");
  const files = filesToSend(opts.files);
  if (!text.trim() && !files.length) throw new Error("send needs text, files, or both");
  const to = String(opts.to ?? "").trim();
  const db = openChatDb();
  let draft: { to: string; chat: string | null; service: string; text: string; files: string[]; recent: { from: string; text: string }[] };
  try {
    const names = nameIndex(loadContacts());
    let c: ChatRow | null = null;
    try {
      c = resolveChat(db, to, names);
    } catch (e) {
      // A new conversation is allowed only to an explicit phone number or email.
      const handleLike = to.includes("@") || handleKey(to).length >= 10;
      if (!handleLike || !/^no chat matches/.test(String((e as Error).message))) throw e;
    }
    const recent = c
      ? (db.query(`SELECT ${MSG_COLS} FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE j.chat_id = ? AND ${REAL} ORDER BY m.date DESC LIMIT 4`).all(c.id) as MsgRow[]).reverse().map((r) => {
          const m = toMessage(r, names);
          return { from: m.from, text: m.text.slice(0, 200) };
        })
      : [];
    draft = {
      to: c ? describe(db, c, names).name : to,
      chat: c?.guid ?? null,
      service: c?.svc ?? "iMessage",
      text,
      files: files.map((f) => `${f.path} (${Math.ceil(f.bytes / 1024)} KB)`),
      recent,
    };
  } finally {
    db.close();
  }
  if (opts.approved !== true) {
    return { status: "draft", ...draft, next: "show the user this recipient, text, files, and recent lines; call again with approved: true only after they say yes" };
  }
  const chat = draft.chat !== null;
  const target = draft.chat ?? to;
  // Files first, each confirmed before the next, so a failed file stops the
  // rest and the text.
  const sent: { file: string; bytes: number }[] = [];
  if (files.length) {
    mkdirSync(STAGING, { recursive: true });
    const dir = mkdtempSync(join(STAGING, "send-"));
    try {
      let after = newestRowid();
      for (const [i, f] of files.entries()) {
        try {
          after = await sendFile(f, dir, i, chat, target, after, draft.to);
        } catch (e) {
          const went = sent.length ? ` Sent before it: ${sent.map((s) => s.file).join(", ")}.` : "";
          throw new Error(`${e instanceof Error ? e.message : String(e)}${went}${text.trim() ? " The text was not sent." : ""}`);
        }
        sent.push({ file: f.name, bytes: f.bytes });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!text.trim()) return { status: "sent", to: draft.to, files: sent };
  const startRowid = newestRowid();
  await runSend(sendScript("text", chat ? "chat" : "handle"), [text, target]);
  const done = (status: string) => ({ status, to: draft.to, ...(sent.length ? { files: sent } : {}) });
  // Confirm from the database: the sent row appears within a few seconds.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await Bun.sleep(700);
    const check = openChatDb();
    try {
      const row = check.query<OurRow, [number, string]>(OUR_ROW).get(startRowid, text);
      if (row?.error) throw new Error(`Messages reported error ${row.error} sending to ${draft.to}`);
      if (row?.is_delivered) return done("delivered");
      if (row?.is_sent) return done("sent");
    } finally {
      check.close();
    }
  }
  return { ...done("unconfirmed"), note: "handed to Messages; no sent receipt yet. Check imessage_history before retrying so it is not sent twice." };
}

// ---------- tool table ----------

export const IMESSAGE_TOOLS: Record<string, Tool> = {
  imessage_chats: {
    desc: "Recent conversations: id, name, unread count, last message.",
    params: { limit: { type: "number", description: "default 20, max 100" } },
    run: async (a) => chats({ limit: a.limit as number | undefined }),
  },
  imessage_history: {
    desc: "Conversation messages and files, oldest first. Missing files: imessage_files.",
    params: {
      chat: { type: "string", description: "chat id, phone, email, or contact name" },
      limit: { type: "number", description: "default 30, max 200" },
      since: { type: "number", description: "only messages after this rowid" },
    },
    required: ["chat"],
    run: async (a) => history(a as { chat: string; limit?: number; since?: number }),
  },
  imessage_files: {
    desc: "Fetch history/search file ids, including iCloud. Opens Messages (may mark read). out saves originals without overwriting; clipboard copies verified file URLs.",
    params: {
      ids: { type: "array", items: { type: "string" } },
      out: { type: "string", description: "absolute folder" },
      clipboard: { type: "boolean" },
    },
    required: ["ids"],
    run: (a) => receiveFiles(a as { ids: string[]; out?: string; clipboard?: boolean }),
  },
  imessage_search: {
    desc: "Search texts across conversations; from limits the sender.",
    params: {
      text: { type: "string", description: "words to find, case-insensitive" },
      from: { type: "string", description: "sender: contact name, phone, or email" },
      days: { type: "number", description: "how far back, default 90" },
      limit: { type: "number", description: "default 30, max 200" },
    },
    run: async (a) => search(a as { text?: string; from?: string; days?: number; limit?: number }),
  },
  imessage_wait_code: {
    desc: "Wait for a sign-in code by text, including the last minute. Returns {status:'received',code,from} or {status:'timeout',since}; pass since back to keep waiting. Type it into the page; never repeat it in chat.",
    params: {
      seconds: { type: "number", description: "how long to wait, default 30, max 90" },
      since: { type: "number", description: "rowid from a previous timeout" },
    },
    run: (a) => waitCode(a as { seconds?: number; since?: number }),
  },
  contacts: {
    desc: "Find contact phones and emails.",
    params: { name: { type: "string", description: "part of a name or company" } },
    required: ["name"],
    run: async (a) => contacts(a as { name: string }),
  },
  imessage_send: {
    desc: "Draft text/files; files go first, separately. Show the recipient, exact text/files and recent lines. Send only after the user approves that draft: approved:true. Never approve it yourself. Fails unless every file uploads.",
    params: {
      to: { type: "string", description: "chat id, unique name, or phone/email" },
      text: { type: "string", description: "message text" },
      files: { type: "array", items: { type: "string" }, description: "absolute file paths" },
      approved: { type: "boolean", description: "true only after the user approved this exact draft" },
    },
    required: ["to"],
    run: (a) => send(a as { to: string; text?: string; files?: string[]; approved?: boolean }),
  },
};

// Read-only subset for unattended callers such as the local agent loop.
export const IMESSAGE_READ_TOOLS: Record<string, Tool> = Object.fromEntries(Object.entries(IMESSAGE_TOOLS).filter(([name]) => name !== "imessage_send" && name !== "imessage_files"));
