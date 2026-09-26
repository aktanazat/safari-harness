// Messages: read chats, history, and search from ~/Library/Messages/chat.db
// (read-only), wait for sign-in codes, look up contacts, and send through the
// Messages app. Reading needs Full Disk Access for the process that runs this,
// so these tools run in the caller (terminal, MCP server) rather than in the
// launchd daemon, which macOS denies. Sending needs the caller to be allowed to
// control Messages, and always returns a draft first.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./tools.ts";

const execFileAsync = promisify(execFile);
const HOME = homedir();
const CHAT_DB = join(HOME, "Library", "Messages", "chat.db");
const ADDRESS_BOOK = join(HOME, "Library", "Application Support", "AddressBook");

// chat.db dates are nanoseconds since 2001-01-01.
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const toDate = (ns: number) => new Date(APPLE_EPOCH_MS + Math.floor(ns / 1e6)).toISOString();
const toAppleNs = (ms: number) => (ms - APPLE_EPOCH_MS) * 1e6;

// Messages keep what counts as a real message: no tapbacks, no group events.
const REAL = "m.item_type = 0 AND NOT (m.associated_message_type BETWEEN 2000 AND 3999)";

function openChatDb(): Database {
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
    return { ...describe(db, c, names), messages: rows.reverse().map((r) => toMessage(r, names)) };
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
    return hits;
  } finally {
    db.close();
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

// argv carries the text and target, so nothing is spliced into the script.
const SEND_TO_CHAT = `on run argv
  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
end run`;
const SEND_TO_HANDLE = `on run argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send (item 1 of argv) to participant (item 2 of argv) of svc
  end tell
end run`;

export async function send(opts: { to: string; text: string; approved?: boolean }) {
  const text = String(opts.text ?? "");
  if (!text.trim()) throw new Error("send needs text");
  const to = String(opts.to ?? "").trim();
  const db = openChatDb();
  let draft: { to: string; chat: string | null; service: string; text: string; recent: { from: string; text: string }[] };
  let startRowid: number;
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
    draft = { to: c ? describe(db, c, names).name : to, chat: c?.guid ?? null, service: c?.svc ?? "iMessage", text, recent };
    startRowid = (db.query("SELECT IFNULL(MAX(ROWID), 0) n FROM message").get() as { n: number }).n;
  } finally {
    db.close();
  }
  if (opts.approved !== true) {
    return { status: "draft", ...draft, next: "show the user this recipient, text, and recent lines; call again with approved: true only after they say yes" };
  }
  const [script, target] = draft.chat ? [SEND_TO_CHAT, draft.chat] : [SEND_TO_HANDLE, to];
  try {
    await execFileAsync("osascript", ["-e", script, text, target], { timeout: 20000 });
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message);
    if (/-1743|not allowed|Not authorized/i.test(msg)) throw new Error("macOS has not allowed this app to control Messages: System Settings > Privacy & Security > Automation");
    throw new Error(`Messages did not send: ${msg.trim()}`);
  }
  // Confirm from the database: the sent row appears within a few seconds.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await Bun.sleep(700);
    const check = openChatDb();
    try {
      const row = check.query("SELECT is_sent, is_delivered, error FROM message WHERE ROWID > ? AND is_from_me = 1 AND text = ? ORDER BY ROWID DESC LIMIT 1").get(startRowid, text) as { is_sent: number; is_delivered: number; error: number } | null;
      if (row?.error) throw new Error(`Messages reported error ${row.error} sending to ${draft.to}`);
      if (row?.is_delivered) return { status: "delivered", to: draft.to };
      if (row?.is_sent) return { status: "sent", to: draft.to };
    } finally {
      check.close();
    }
  }
  return { status: "unconfirmed", to: draft.to, note: "handed to Messages; no sent receipt yet. Check imessage_history before retrying so it is not sent twice." };
}

// ---------- tool table ----------

export const IMESSAGE_TOOLS: Record<string, Tool> = {
  imessage_chats: {
    desc: "Recent Messages conversations, newest first: chat id, name, unread count, last message.",
    params: { limit: { type: "number", description: "default 20, max 100" } },
    run: async (a) => chats({ limit: a.limit as number | undefined }),
  },
  imessage_history: {
    desc: "Messages in one conversation, oldest to newest. chat is a chat id from imessage_chats, a phone number, an email, or a contact name that matches exactly one chat.",
    params: {
      chat: { type: "string", description: "chat id, phone, email, or contact name" },
      limit: { type: "number", description: "default 30, max 200" },
      since: { type: "number", description: "only messages after this rowid" },
    },
    required: ["chat"],
    run: async (a) => history(a as { chat: string; limit?: number; since?: number }),
  },
  imessage_search: {
    desc: "Search Messages text across all conversations (last 90 days by default). from narrows to a contact name, phone, or email.",
    params: {
      text: { type: "string", description: "words to find, case-insensitive" },
      from: { type: "string", description: "sender: contact name, phone, or email" },
      days: { type: "number", description: "how far back, default 90" },
      limit: { type: "number", description: "default 30, max 200" },
    },
    run: async (a) => search(a as { text?: string; from?: string; days?: number; limit?: number }),
  },
  imessage_wait_code: {
    desc: "Wait for a sign-in or verification code to arrive by text, including one that came in the last minute. Returns {status:'received', code, from} or {status:'timeout', since}; pass since back to keep waiting. Type the code into the page; never repeat it in chat.",
    params: {
      seconds: { type: "number", description: "how long to wait, default 30, max 90" },
      since: { type: "number", description: "rowid from a previous timeout" },
    },
    run: (a) => waitCode(a as { seconds?: number; since?: number }),
  },
  contacts: {
    desc: "Look up the user's contacts by name: phones and emails.",
    params: { name: { type: "string", description: "part of a name or company" } },
    required: ["name"],
    run: async (a) => contacts(a as { name: string }),
  },
  imessage_send: {
    desc: "Send one text through Messages. Without approved it sends nothing and returns a draft: show the user the recipient, the exact text, and the recent lines, and call again with approved: true only after they say yes. Never set approved on your own.",
    params: {
      to: { type: "string", description: "chat id, contact name matching one chat, or a phone/email for a new conversation" },
      text: { type: "string", description: "message text" },
      approved: { type: "boolean", description: "true only after the user approved this exact draft" },
    },
    required: ["to", "text"],
    run: (a) => send(a as { to: string; text: string; approved?: boolean }),
  },
};

// Read-only subset for unattended callers such as the local agent loop.
export const IMESSAGE_READ_TOOLS: Record<string, Tool> = Object.fromEntries(Object.entries(IMESSAGE_TOOLS).filter(([name]) => name !== "imessage_send"));
