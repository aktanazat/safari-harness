// Payment cards kept in this Mac's card vault (card-vault.ts), filled into
// a checkout without the agent seeing a digit and without asking the user
// anything: no Touch ID, no Face ID on his phone, no window (the owner's
// order of 11-13). An agent names a card by its label or last 4 (cards
// lists them); this process reads that card's digits from the vault and
// sends each frame of the checkout only what that frame's fields take, and
// only to frames on the page's own site or a card processor's. No answer
// carries a digit, and the tab's answers have the number and security code
// cut from then on (card_fill in tools.ts).

import { type Card, cardOf, type Listed, memSecretCards } from "./card-vault.ts";
import { INPUT_TOOLS } from "./input.ts";
import { navigatedOf } from "./navigated.ts";
import { rpc } from "./rpc.ts";

// Embedded card fields served by Stripe, Braintree, Adyen, or Cybersource
// Unified Checkout (AAA's renewal, 10-19). Do not trust arbitrary pages on
// the processors' parent domains.
const PROCESSOR_FRAME = /^(?:[a-z0-9-]+\.)*js\.stripe\.com$|^(?:[a-z0-9-]+\.)+braintreegateway\.com$|^checkoutshopper-[a-z0-9-]+\.adyen\.com$|^(?:[a-z0-9-]+\.)*cdn\.adyen\.com$|^up\.cybersource\.com$/;

type Reply = Record<string, unknown>;
// A frame of the checkout holding card fields (cardForm in content.js).
type Frame = { frame: number; host: string; https: boolean; fields: string[] };
// A field of a frame the page did not take the card into (fillCard).
type Miss = { field: string; token: string; ref?: string };

// What to do when no card is saved. On 10-05 an agent told only to have
// him save one stopped at a checkout that offered Apple Pay, which paid
// with his card once he asked for it (01a10eb8).
const NONE_SAVED = "card-save keeps a card the user gives in the chat; or, where the checkout offers Apple Pay, choose it, press its pay button with real_input, and handoff so he confirms with Touch ID";

// The saved card an agent named, by its label or its last 4; the only
// card, when it named none.
function pick(saved: Listed[], which: unknown): Listed {
  if (saved.length === 0) throw new Error(`no card is saved: ${NONE_SAVED}`);
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

// card-save: the card the user gave in the chat.
async function save(a: Reply): Promise<unknown> {
  if (a.number === undefined) throw new Error("card-save keeps the card the user gave: its number, exp (MM/YY), and cvc, and its name and zip if he gave them");
  const [saved] = await memSecretCards().keep([cardOf({ number: a.number, exp: a.exp, csc: a.cvc, name: a.name, zip: a.zip, label: a.card })]);
  return { saved };
}

async function remove(a: Reply): Promise<unknown> {
  if (a.card === undefined) throw new Error("card-rm needs card: the card's label or last 4");
  const vault = memSecretCards();
  const card = pick(await vault.list(), a.card);
  await vault.remove(card.id);
  return { removed: card };
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
// needs (docs/sites/geico.md). The card's digits are read from the vault
// only for a page with card fields to take them.
async function fill(a: Reply): Promise<unknown> {
  const resolved = await rpc("resolve_tab", { tab: a.tab });
  const tab = resolved && typeof resolved === "object" && "tab" in resolved && typeof resolved.tab === "number" ? resolved.tab : undefined;
  if (tab === undefined) throw new Error("the tab did not resolve; name it by the id open returned");
  const vault = memSecretCards();
  const card = pick(await vault.list(), a.card);
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
  const got = await vault.read(card.id);
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
      const saved = await memSecretCards().list();
      return saved.length ? { cards: saved, next: "fill one with card-fill and its label; never ask the user for its digits" } : { cards: [], next: `none is saved: ${NONE_SAVED}` };
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
