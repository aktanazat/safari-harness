// Payment cards the user keeps in this Mac's keychain behind his Touch ID,
// filled into a checkout without the agent seeing a digit. The keychain
// items belong to Safari Harness Cards, a helper app inside the Safari
// Harness app (its Xcode project): only an app signed into the team's
// keychain group can keep a card there. An agent names a card by its label
// or last 4 (cards lists them); the helper hands its digits to this
// process, which sends each frame of the checkout only what that frame's
// fields take, and only to frames on the page's own site or a card
// processor's. No answer carries a digit, and the tab's answers have the
// number and security code cut from then on (card_fill in tools.ts).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { INPUT_TOOLS } from "./input.ts";
import { navigatedOf } from "./navigated.ts";
import { waitsOut } from "./pair.ts";
import { ANSWER_MS, localTime, within } from "./passwords.ts";
import { isAway } from "./phone.ts";
import { rpc } from "./rpc.ts";

const HELPER = "/Applications/Safari Harness.app/Contents/Helpers/Safari Harness Cards.app/Contents/MacOS/Safari Harness Cards";

// One Touch ID opens card fills for 5 minutes (the owner's choice, 10-01):
// a checkout that takes the card twice, after a decline or on its next
// page, asks him once. The approval lives in one helper process (serve),
// which the first fill past those 5 minutes ends, as do done and this
// process's end; the helper keeps it no longer either. Each fill reads
// its card again, rather than caching one for the next fill. The tab's
// secret scrubber still holds the number and code until the tab closes.
// For those 5 minutes, anything driving this process can fill a saved card
// without another prompt. A CLI process ends after its call, so it cannot
// reuse an earlier CLI call's approval.
const APPROVAL_MS = 5 * 60_000;

// Embedded card fields served by Stripe, Braintree, or Adyen. Do not trust
// arbitrary pages on the processors' parent domains.
const PROCESSOR_FRAME = /^(?:[a-z0-9-]+\.)*js\.stripe\.com$|^(?:[a-z0-9-]+\.)+braintreegateway\.com$|^checkoutshopper-[a-z0-9-]+\.adyen\.com$|^(?:[a-z0-9-]+\.)*cdn\.adyen\.com$/;

type Reply = Record<string, unknown>;
// What names a saved card: all an agent sees of one.
type Listed = { id: string; label: string; brand: string; last4: string; exp: string; name: string };
// What fills one in, held only by the fill it was read for.
type Card = { number: string; month: number; year: number; csc: string; name: string; zip: string };
// A frame of the checkout holding card fields (cardForm in content.js).
type Frame = { frame: number; host: string; https: boolean; fields: string[] };
// A field of a frame the page did not take the card into (fillCard).
type Miss = { field: string; token: string; ref?: string };

// The helper's answer: one JSON object, never quoted back, as it may hold
// a card.
function replyOf(text: string): Reply {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the card helper gave an answer this release cannot read");
  return Object.fromEntries(Object.entries(value));
}

function spawnError(e: Error): Error {
  if ("code" in e && e.code === "ENOENT") return new Error("this Mac's Safari Harness app has no card helper yet; tell the user its next install brings one");
  return new Error(`the card helper did not start: ${e.message}`);
}

// One command of the helper: its answer, or the error it gave. A card to
// save goes in on its input, never its arguments, which any process sees.
function helper(args: string[], input = ""): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const child = spawn(process.env.SAFARI_HARNESS_CARDS ?? HELPER, args);
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString();
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  child.on("error", (e) => reject(spawnError(e)));
  child.on("close", (code) => {
    if (code !== 0) return reject(new Error(err.trim() || "the card helper stopped without an answer"));
    try {
      resolve(replyOf(out));
    } catch (e) {
      reject(e);
    }
  });
  return promise;
}

// The helper process holding the user's approval, the replies it owes in
// order, when its first card came (the approval's start), and when it
// first asked for Touch ID.
type Session = { child: ChildProcessWithoutNullStreams; owed: PromiseWithResolvers<Reply>[]; approvedAt?: number; askedAt?: string };
let session: Session | undefined;

function serve(): Session {
  const child = spawn(process.env.SAFARI_HARNESS_CARDS ?? HELPER, ["serve"]);
  const s: Session = { child, owed: [] };
  const stop = () => child.kill();
  process.once("exit", stop);
  let expiry: Timer | undefined;
  const ended = (why: Error) => {
    process.off("exit", stop);
    clearTimeout(expiry);
    if (session === s) session = undefined;
    for (const owed of s.owed.splice(0)) owed.reject(why);
  };
  child.on("error", (e) => ended(spawnError(e)));
  child.on("close", () => ended(new Error("the card helper stopped before it answered")));
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", (line) => {
    const owed = s.owed.shift();
    try {
      const reply = replyOf(line);
      if ("card" in reply && s.approvedAt === undefined) {
        s.approvedAt = Date.now();
        expiry = setTimeout(() => {
          if (session === s) endApproval();
        }, APPROVAL_MS);
        expiry.unref();
      }
      owed?.resolve(reply);
    } catch (e) {
      owed?.reject(e);
    }
  });
  return s;
}

// Ends the approval: the next fill asks Touch ID again. done calls it.
export function endApproval(): void {
  session?.child.kill();
  session = undefined;
}

function cardOf(value: unknown): Card {
  const c = value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
  if (typeof c.number !== "string" || typeof c.month !== "number" || typeof c.year !== "number" || typeof c.csc !== "string") throw new Error("the card helper gave no card");
  return { number: c.number, month: c.month, year: c.year, csc: c.csc, name: typeof c.name === "string" ? c.name : "", zip: typeof c.zip === "string" ? c.zip : "" };
}

// The card's digits, through the approval that is open or a new one. A
// Touch ID he has not answered within ANSWER_MS stays up, and the call
// says so; the next call's read queues behind it and asks nothing more.
async function read(card: Listed, host: string): Promise<Card | { waiting: string }> {
  if (session?.approvedAt !== undefined && Date.now() - session.approvedAt >= APPROVAL_MS) endApproval();
  if (session?.approvedAt === undefined && (await isAway().catch(() => false))) throw new Error("the user is away from the Mac, and a card fill needs his Touch ID there: he must come to the Mac");
  const s = (session ??= serve());
  if (s.approvedAt === undefined) s.askedAt ??= localTime();
  const owed = Promise.withResolvers<Reply>();
  s.owed.push(owed);
  s.child.stdin.write(`${JSON.stringify({ read: card.id, site: host })}\n`);
  if (!waitsOut() && !(await within(owed.promise, ANSWER_MS))) {
    owed.promise.catch(() => {});
    return { waiting: `the Mac is asking the user to approve card fills with Touch ID (since ${s.askedAt}); ask him to approve, then call card-fill again` };
  }
  const reply = await owed.promise;
  if (typeof reply.error === "string") throw new Error(reply.error);
  return cardOf(reply.card);
}

async function listed(): Promise<Listed[]> {
  const { cards } = await helper(["list"]);
  if (!Array.isArray(cards)) throw new Error("the card helper gave no list of cards");
  return cards.map((v: unknown) => {
    const c = v && typeof v === "object" ? Object.fromEntries(Object.entries(v)) : {};
    return { id: String(c.id ?? ""), label: String(c.label ?? ""), brand: String(c.brand ?? ""), last4: String(c.last4 ?? ""), exp: String(c.exp ?? ""), name: String(c.name ?? "") };
  });
}

// The saved card an agent named, by its label or its last 4; the only
// card, when it named none.
function pick(saved: Listed[], which: unknown): Listed {
  if (saved.length === 0) throw new Error("no card is saved: card-save has the user type one at the Mac");
  const all = saved.map((c) => `${c.label} (ends ${c.last4})`).join(", ");
  if (which === undefined) {
    if (saved.length === 1) return saved[0];
    throw new Error(`name the card by its label or last 4: ${all}`);
  }
  const want = String(which).trim().toLowerCase();
  const found = saved.filter((c) => c.label.toLowerCase() === want || c.last4 === want.replace(/^\D+/, "") || c.id.toLowerCase() === want);
  if (found.length === 1) return found[0];
  throw new Error(found.length ? `${found.length} saved cards match ${String(which)}; name one by its label: ${all}` : `no saved card is ${String(which)}; saved: ${all}`);
}

// A helper command that waits on the user at the Mac (Touch ID, the add
// window): up to ANSWER_MS, then what he is asked, as read does.
async function onHim(asking: Promise<Reply>, waiting: string): Promise<unknown> {
  if (waitsOut() || (await within(asking, ANSWER_MS))) return asking;
  asking.catch(() => {});
  return { waiting: `${waiting} (since ${localTime()})` };
}

// card-save: the card the user gave in the chat, or with none a window at
// the Mac where he types it, whose digits reach no agent.
async function save(a: Reply): Promise<unknown> {
  if (a.number !== undefined) return helper(["save"], JSON.stringify({ number: a.number, exp: a.exp, csc: a.cvc, name: a.name, zip: a.zip, label: a.card }));
  if (await isAway().catch(() => false)) throw new Error("the user is away from the Mac, where he types the card: he must come to the Mac");
  return onHim(helper(["add", ...(a.card === undefined ? [] : ["--label", String(a.card)])]), "a window on the Mac asks the user to type the card; ask him to fill it in there, never in the chat, then call cards");
}

async function remove(a: Reply): Promise<unknown> {
  if (a.card === undefined) throw new Error("card-rm needs card: the card's label or last 4");
  const card = pick(await listed(), a.card);
  if (await isAway().catch(() => false)) throw new Error("the user is away from the Mac, where he approves removing a card with Touch ID: he must come to the Mac");
  return onHim(helper(["rm", card.id]), `the Mac is asking the user to approve removing ${card.label} with Touch ID; ask him to approve, then call cards`);
}

function framesOf(value: unknown): Frame[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v: unknown) => {
    if (!v || typeof v !== "object" || !("frame" in v) || typeof v.frame !== "number" || !("origin" in v) || typeof v.origin !== "string" || !("fields" in v) || !Array.isArray(v.fields)) return [];
    const url = URL.parse(v.origin);
    return url ? [{ frame: v.frame, host: url.hostname, https: url.protocol === "https:", fields: v.fields.map(String) }] : [];
  });
}

// The part of the card a frame's fields take, and no more.
function partFor(fields: string[], card: Card): Partial<Card> {
  const part: Partial<Card> = {};
  if (fields.includes("cc-number")) part.number = card.number;
  if (fields.includes("cc-csc")) part.csc = card.csc;
  if (fields.some((t) => t.startsWith("cc-exp"))) Object.assign(part, { month: card.month, year: card.year });
  if (card.name && fields.some((t) => t === "cc-name" || t === "cc-given-name" || t === "cc-family-name")) part.name = card.name;
  if (card.zip && fields.includes("postal-code")) part.zip = card.zip;
  return part;
}

// What real keys type into a field that took no text from a script. The
// expiry goes as MM/YY, which a field's mask takes as typed.
function keysFor(token: string, card: Card): string {
  const [given = "", ...family] = card.name.trim().split(/\s+/);
  const month = String(card.month).padStart(2, "0");
  switch (token) {
    case "cc-number":
      return card.number;
    case "cc-csc":
      return card.csc;
    case "cc-exp":
      return `${month}/${String(card.year % 100).padStart(2, "0")}`;
    case "cc-exp-month":
      return month;
    case "cc-exp-year":
      return String(card.year);
    case "cc-name":
      return card.name;
    case "cc-given-name":
      return given;
    case "cc-family-name":
      return family.join(" ");
    case "postal-code":
      return card.zip;
  }
  return "";
}

function missesOf(res: unknown): Miss[] {
  if (!res || typeof res !== "object" || !("missed" in res) || !Array.isArray(res.missed)) return [];
  return res.missed.flatMap((m: unknown) =>
    m && typeof m === "object" && "field" in m && "token" in m ? [{ field: String(m.field), token: String(m.token), ...("ref" in m && typeof m.ref === "string" ? { ref: m.ref } : {}) }] : [],
  );
}

// card-fill: the named card into the tab's checkout. The page must be
// https, and a frame gets the card only while it is on the page's own site
// or a card processor's. A text field the page did not take the card into
// from a script gets it by real keys (real_input), as GEICO's card frame
// needs (docs/sites/geico.md). No Touch ID is asked of a page with no card
// fields to take it.
async function fill(a: Reply): Promise<unknown> {
  const resolved = await rpc("resolve_tab", { tab: a.tab });
  const tab = resolved && typeof resolved === "object" && "tab" in resolved && typeof resolved.tab === "number" ? resolved.tab : undefined;
  if (tab === undefined) throw new Error("the tab did not resolve; name it by the id open returned");
  const card = pick(await listed(), a.card);
  const frames = framesOf(await rpc("card_form", { tab }));
  const top = frames.find((f) => f.frame === 0);
  if (!top) throw new Error("the page did not answer; reload it with goto and try again");
  if (!top.https) throw new Error(`a card goes only to an https page, and ${top.host || "this one"} is not one`);
  const holding = frames.filter((f) => f.fields.length > 0);
  const trusted = holding.filter((f) => f.https && (f.host === top.host || f.host.endsWith(`.${top.host}`) || PROCESSOR_FRAME.test(f.host)));
  const skipped = holding.filter((f) => !trusted.includes(f)).map((f) => f.host);
  if (trusted.length === 0) {
    throw new Error(skipped.length ? `the card fields here sit in frames from ${skipped.join(", ")}, neither ${top.host} nor a card processor the harness knows; nothing was filled` : "the page shows no card fields: open the step that asks for the card, then call card-fill again");
  }
  const got = await read(card, top.host);
  if ("waiting" in got) return got;
  const filled: string[] = [];
  const typed: string[] = [];
  const unfilled: string[] = [];
  const failed: string[] = [];
  let navigated: unknown;
  for (const f of trusted) {
    const part = partFor(f.fields, got);
    if (Object.keys(part).length === 0) continue;
    let res: unknown;
    try {
      res = await rpc("card_fill", { tab, frame: f.frame, site: f.host, card: part });
    } catch (e) {
      failed.push(`${f.host}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (res && typeof res === "object" && "filled" in res && Array.isArray(res.filled)) filled.push(...res.filled.map(String));
    navigated ??= navigatedOf(res);
    for (const miss of missesOf(res)) {
      if (miss.ref === undefined || !f.fields.includes(miss.token)) {
        unfilled.push(miss.field);
        continue;
      }
      try {
        const now = framesOf(await rpc("card_form", { tab }));
        if (!now.some((n) => n.frame === 0 && n.https && n.host === top.host) || !now.some((n) => n.frame === f.frame && n.https && n.host === f.host)) {
          unfilled.push(miss.field);
          continue;
        }
        await INPUT_TOOLS.real_input.run({ tab, do: "type", ref: f.frame === 0 ? miss.ref : `f${f.frame}:${miss.ref}`, text: keysFor(miss.token, got) });
        typed.push(miss.field);
      } catch {
        unfilled.push(miss.field);
      }
    }
  }
  if (filled.length === 0 && typed.length === 0 && !navigated) {
    if (failed.length) throw new Error(`nothing was filled: ${failed.join("; ")}`);
    throw new Error(`the page took none of the card${unfilled.length ? ` (${unfilled.join(", ")})` : ""}; ask the user to type it into the page at the Mac, never in the chat`);
  }
  return {
    card: card.label,
    site: top.host,
    filled,
    ...(typed.length ? { typed } : {}),
    ...(unfilled.length ? { unfilled } : {}),
    ...(failed.length ? { failed } : {}),
    ...(skipped.length ? { skipped: `frames from ${skipped.join(", ")}, neither this site nor a card processor` } : {}),
    ...(navigated ? { navigated } : {}),
    next: unfilled.length || failed.length
      ? "ask the user to type what is missing into the page at the Mac, never in the chat; then check the order and get his yes in the chat before you pay"
      : "check the page shows the order he wants, then ask him in the chat and wait for his yes before you press pay",
  };
}

// The card steps of the passwords tool, which fill.ts sends here.
export async function cards(a: Reply): Promise<unknown> {
  switch (a.do) {
    case "cards": {
      const saved = await listed();
      return saved.length ? { cards: saved, next: "fill one with card-fill and its label; never ask the user for its digits" } : { cards: [], next: "none is saved: card-save has the user type one at the Mac" };
    }
    case "card-save":
      return save(a);
    case "card-fill":
      return fill(a);
    case "card-rm":
      return remove(a);
  }
  throw new Error("do must be cards, card-save, card-fill, or card-rm");
}
