// Card fills the user approves with Face ID on his iPhone while he is away
// from the Mac. card-phone sets a card up at the Mac (cards.ts): his Touch
// ID gives the card, his phone makes a passkey for it on the approval page
// (passkey.ts), and the card is sealed with AES-256-GCM under a key HKDF
// derives from that passkey's PRF output, which his phone gives only after
// Face ID. This Mac keeps the sealed copy alone (phone-cards.json, 0600),
// never its key. Away, card-fill sends his phone the page's link; the
// answer, once the daemon has checked it, gives the key, which opens that
// card on that one site for WINDOW_MS and is then wiped.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ANSWER_MS, localTime } from "./passwords.ts";
import { alert, dataFile, readJson, writeJson } from "./phone.ts";
import { rpc } from "./rpc.ts";

// One Face ID covers a checkout's retry after a declined card, and its next
// page; a fill on another site asks his phone again.
const WINDOW_MS = 30 * 60_000;
const FILE = "phone-cards.json";
const TAG_BYTES = 16;

// A card set up for his phone: its passkey, and its sealed copy.
type Enrolled = { rpId: string; credential: { id: string; key: string }; salt: string; iv: string; box: string; at: string };
// What names a card on his phone.
type Named = { id: string; label: string; last4: string };
// A link his phone was sent, and the token that alone takes its answer.
type Asked = { request: string; token: string; since: string };

// The keys his phone's Face ID gave, each for one card on one site, by
// "<card id> <site>"; none outlives this process.
const windows = new Map<string, { key: Buffer; until: number; timer: Timer }>();
// The links out to his phone, by the window each would open, or by
// "enroll <card id>": a call made again waits on the one already sent.
const asking = new Map<string, Promise<Asked>>();

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
}

function isEnrolled(v: unknown): v is Enrolled {
  const e = record(v);
  const c = record(e.credential);
  return typeof e.rpId === "string" && typeof c.id === "string" && typeof c.key === "string" && typeof e.salt === "string" && typeof e.iv === "string" && typeof e.box === "string";
}

// The cards set up for his phone, by card id.
function enrolled(): Record<string, Enrolled> {
  return Object.fromEntries(Object.entries(record(readJson(dataFile(FILE)))).filter((entry): entry is [string, Enrolled] => isEnrolled(entry[1])));
}

// The ids of the cards set up for his phone.
export function phoneCardIds(): Set<string> {
  return new Set(Object.keys(enrolled()));
}

function shut(at: string): void {
  const w = windows.get(at);
  if (!w) return;
  clearTimeout(w.timer);
  w.key.fill(0);
  windows.delete(at);
}

// Drops the sealed copies of cards no longer saved, with their windows.
export function forgetPhoneCards(keep: Set<string>): void {
  const all = Object.entries(enrolled());
  const kept = all.filter(([id]) => keep.has(id));
  for (const at of windows.keys()) if (!keep.has(at.slice(0, at.indexOf(" ")))) shut(at);
  if (kept.length < all.length) writeJson(dataFile(FILE), Object.fromEntries(kept), 0o600);
}

// Ends every window his phone opened and forgets the links out; done ends
// them with the Mac's Touch ID approval (endApproval).
export function endPhoneApprovals(): void {
  for (const at of windows.keys()) shut(at);
  asking.clear();
}

// The card's key, from his passkey's PRF output, which is then wiped.
function keyOf(prf: unknown, salt: string, id: string): Buffer {
  const input = Buffer.from(typeof prf === "string" ? prf : "", "base64url");
  if (input.length !== 32) throw new Error("his phone's answer held no key for the card");
  const key = Buffer.from(hkdfSync("sha256", input, Buffer.from(salt, "base64url"), `safari-harness card ${id}`, 32));
  input.fill(0);
  return key;
}

function seal(key: Buffer, id: string, plain: unknown): { iv: string; box: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`card ${id}`));
  const text = Buffer.from(JSON.stringify(plain));
  const box = Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()]);
  text.fill(0);
  return { iv: iv.toString("base64url"), box: box.toString("base64url") };
}

// The card in its sealed copy, which only its own key opens.
function unsealed(key: Buffer, id: string, e: Enrolled): unknown {
  const box = Buffer.from(e.box, "base64url");
  let text: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64url"));
    decipher.setAAD(Buffer.from(`card ${id}`));
    decipher.setAuthTag(box.subarray(box.length - TAG_BYTES));
    text = decipher.update(box.subarray(0, box.length - TAG_BYTES));
    decipher.final();
  } catch {
    text?.fill(0);
    throw new Error("his phone's answer did not open the card's sealed copy, and nothing was filled; set Face ID up again with card-phone, at the Mac");
  }
  try {
    return JSON.parse(text.toString("utf8"));
  } finally {
    text.fill(0);
  }
}

// The link out to his phone for at, sent once, after line.
function sent(at: string, ask: Record<string, unknown>, line: string): Promise<Asked> {
  const out = asking.get(at);
  if (out) return out;
  const asked = (async (): Promise<Asked> => {
    const r = record(await rpc("card_phone", ask));
    if (typeof r.request !== "string" || typeof r.token !== "string" || typeof r.link !== "string") throw new Error("the daemon gave no approval link");
    try {
      await alert(`${line}\n${r.link}`);
    } catch (e) {
      await rpc("card_phone", { do: "drop", request: r.request, token: r.token }).catch(() => undefined);
      throw e;
    }
    return { request: r.request, token: r.token, since: localTime() };
  })();
  asking.set(at, asked);
  asked.catch(() => {
    if (asking.get(at) === asked) asking.delete(at);
  });
  return asked;
}

// His phone's answer, waited on as the Mac's Touch ID prompt is: up to
// ANSWER_MS for an MCP call, which then says it waits; until it comes for
// the CLI. A request the daemon no longer has ends the wait.
async function answerOf(at: string, asked: Promise<Asked>, waitOut: boolean, what: string, again: string): Promise<Record<string, unknown> | { waiting: string }> {
  const a = await asked;
  let got: Record<string, unknown>;
  do {
    try {
      got = record(await rpc("card_phone", { do: "wait", request: a.request, token: a.token, ms: ANSWER_MS }));
    } catch (e) {
      if (asking.get(at) === asked) asking.delete(at);
      throw e;
    }
    if (got.pending === true && !waitOut) return { waiting: `the user's phone has a link to approve ${what} with Face ID (since ${a.since}); ask him to approve it there, then call ${again} again` };
  } while (got.pending === true);
  if (asking.get(at) === asked) asking.delete(at);
  if (got.approved === true) return got;
  if (got.declined === true) throw new Error(`the user declined ${what} on his phone; ask him in your chat before you try again`);
  if (got.expired === true) throw new Error(`the user did not answer the link on his phone for ${what} within 10 minutes; call ${again} again to send a new one`);
  throw new Error(`the approval for ${what} ended before this call took its answer (the harness restarted, or another call took it); call ${again} again`);
}

// card-phone's second half, once his Touch ID gave the card at the Mac: his
// phone makes the card's passkey with Face ID, and the card is sealed under
// the key its PRF output derives.
export async function enrollOnPhone(card: Named, plain: unknown, waitOut: boolean): Promise<unknown> {
  const at = `enroll ${card.id}`;
  const asked = sent(at, { do: "ask", kind: "enroll", card: `${card.label} ending ${card.last4}`, user: card.id }, `set up face id for card fills with ${card.label} ending ${card.last4}. open this link in safari on your iphone:`);
  const got = await answerOf(at, asked, waitOut, `setting up Face ID for ${card.label}`, "card-phone");
  if ("waiting" in got) return got;
  const credential = record(got.credential);
  if (typeof got.rpId !== "string" || typeof got.salt !== "string" || typeof credential.id !== "string" || typeof credential.key !== "string") throw new Error("the daemon gave no passkey for the card");
  const key = keyOf(got.prf, got.salt, card.id);
  let sealed: { iv: string; box: string };
  try {
    sealed = seal(key, card.id, plain);
  } finally {
    key.fill(0);
  }
  for (const w of windows.keys()) if (w.startsWith(`${card.id} `)) shut(w);
  const entry: Enrolled = { rpId: got.rpId, credential: { id: credential.id, key: credential.key }, salt: got.salt, ...sealed, at: new Date().toISOString() };
  writeJson(dataFile(FILE), { ...enrolled(), [card.id]: entry }, 0o600);
  return { enrolled: { card: card.label, last4: card.last4 }, next: "while the user is away from the Mac, card-fill asks his iPhone to approve with Face ID" };
}

// The card, through a window his phone's Face ID opened for it on site.
export function openedOnPhone(card: Named, site: string): { card: unknown } | undefined {
  const at = `${card.id} ${site}`;
  const w = windows.get(at);
  if (!w) return undefined;
  const e = enrolled()[card.id];
  if (!e || Date.now() >= w.until) {
    shut(at);
    return undefined;
  }
  try {
    return { card: unsealed(w.key, card.id, e) };
  } catch (err) {
    shut(at);
    throw err;
  }
}

// A card fill's approval on his phone while he is away: the card, once his
// Face ID answered; waiting, while the link is out; undefined, when the
// card was never set up for his phone.
export async function approveOnPhone(card: Named, site: string, amount: string | undefined, waitOut: boolean): Promise<{ card: unknown } | { waiting: string } | undefined> {
  const e = enrolled()[card.id];
  if (!e) return undefined;
  const at = `${card.id} ${site}`;
  const test = process.env.SAFARI_HARNESS_AWAY === "1" ? "test of the card alert: " : "";
  const ask = { do: "ask", kind: "approve", card: `${card.label} ending ${card.last4}`, site, rpId: e.rpId, credential: e.credential, salt: e.salt, ...(amount === undefined ? {} : { amount }) };
  const asked = sent(at, ask, `${test}approve ${card.label} ending ${card.last4} on ${site}${amount === undefined ? "" : ` for ${amount}`} with face id. open this link in safari:`);
  const got = await answerOf(at, asked, waitOut, `filling ${card.label} on ${site}`, "card-fill");
  if ("waiting" in got) return got;
  const key = keyOf(got.prf, e.salt, card.id);
  let plain: unknown;
  try {
    plain = unsealed(key, card.id, e);
  } catch (err) {
    key.fill(0);
    throw err;
  }
  shut(at);
  const timer = setTimeout(() => shut(at), WINDOW_MS);
  timer.unref();
  windows.set(at, { key, until: Date.now() + WINDOW_MS, timer });
  return { card: plain };
}
