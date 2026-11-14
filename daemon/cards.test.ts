import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { invoke } from "./call.ts";
import * as cardVault from "./card-vault.ts";
import { connect } from "./fake-safari.ts";
import { recent } from "./journal.ts";
import { watched } from "./mission.ts";
import { tabSecrets } from "./redact.ts";
import * as daemonRpc from "./rpc.ts";
import * as telegram from "./telegram.ts";
import { callTool } from "./tools.ts";

// The card vault is kept in memory here; card-vault.test.ts runs the real
// one. The checkout is a page on shop.example whose own frame holds the
// name, a Stripe frame the rest, and a frame from evil.example card fields
// too; the page records which card each frame's fillCard got, and names the
// fields as content.js does.
const away = process.env.SAFARI_HARNESS_AWAY;
process.env.SAFARI_HARNESS_AWAY = "0";

const TAB = 7001;
const NUMBER = "4242424242424242";
const VISA = {
  listed: { id: "card-1", label: "Visa", brand: "Visa", last4: "4242", exp: "07/29", name: "Ada Lovelace" },
  card: { number: NUMBER, month: 7, year: 2029, csc: "737", name: "Ada Lovelace", zip: "94107" },
};
let kept: { listed: cardVault.Listed; card: cardVault.Card }[] = [];
const vault: cardVault.CardVault = {
  list: async () => kept.map((k) => k.listed),
  read: async (id) => {
    const found = kept.find((k) => k.listed.id === id);
    if (!found) throw new Error("the card vault holds no such card");
    return found.card;
  },
  keep: async (cards) =>
    cards.map((c) => {
      const listed = { id: `card-${kept.length + 1}`, label: c.label, brand: c.brand, last4: c.number.slice(-4), exp: `${String(c.month).padStart(2, "0")}/${String(c.year).slice(-2)}`, name: c.name };
      kept = [...kept.filter((k) => k.listed.label !== c.label), { listed, card: { number: c.number, month: c.month, year: c.year, csc: c.csc, name: c.name, zip: c.zip } }];
      return listed;
    }),
  remove: async (id) => {
    kept = kept.filter((k) => k.listed.id !== id);
  },
};

const FRAMES = [
  { frame: 0, origin: "https://shop.example", fields: ["cc-name"] },
  { frame: 3, origin: "https://js.stripe.com", fields: ["cc-number", "cc-exp", "cc-csc", "postal-code"] },
  { frame: 4, origin: "https://evil.example", fields: ["cc-number", "cc-csc"] },
];
let frames = FRAMES;
const NAMES: Record<string, string> = { number: "number", month: "expiry", csc: "security code", name: "name", zip: "zip" };
const fillCalls: { frame: unknown; site: unknown; card: unknown }[] = [];
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    let value: unknown = [];
    if (op === "probe") value = frames;
    if (op === "relay" && args[1] === "fillCard" && Array.isArray(args[2])) {
      const [site, card] = args[2];
      fillCalls.push({ frame: args[4], site, card });
      value = { ok: true, filled: Object.keys(card).flatMap((k) => (Object.hasOwn(NAMES, k) ? [NAMES[k]] : [])) };
    }
    if (op === "relay" && args[1] === "extract") value = { title: "Checkout", url: "https://shop.example", text: `Card ${NUMBER}, spaced 4242 4242 4242 4242, code 737. Order 1737.` };
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
  },
  close() {},
});
const fillVisa = (card = "Visa") => invoke("passwords", { do: "card-fill", tab: TAB, card }, true);

beforeEach(() => {
  kept = [];
  spyOn(cardVault, "memSecretCards").mockReturnValue(vault);
  spyOn(daemonRpc, "rpc").mockImplementation((tool: string, args: Record<string, unknown> = {}, model = false) => watched(process.pid, tool, args, () => callTool(tool, args, model)));
});

afterEach(() => {
  mock.restore();
  frames = FRAMES;
  fillCalls.length = 0;
  tabSecrets.clear();
  process.env.SAFARI_HARNESS_AWAY = "0";
});
afterAll(() => {
  if (away === undefined) delete process.env.SAFARI_HARNESS_AWAY;
  else process.env.SAFARI_HARNESS_AWAY = away;
});

test("a card given in the chat is saved, listed by its label and last 4, filled, and removed by its last 4", async () => {
  const saved = await invoke("passwords", { do: "card-save", card: "Work", number: "3782 8224 6310 005", exp: "09/30", cvc: "7373", name: "Ada Lovelace", zip: "94107" }, true);
  expect(saved).toMatchObject({ saved: { label: "Work", last4: "0005", exp: "09/30" } });
  expect(await invoke("passwords", { do: "cards" }, true)).toMatchObject({ cards: [{ label: "Work", last4: "0005", name: "Ada Lovelace" }] });
  await fillVisa("Work");
  expect(fillCalls).toContainEqual({ frame: 3, site: "js.stripe.com", card: { number: "378282246310005", csc: "7373", month: 9, year: 2030, zip: "94107" } });
  expect(await invoke("passwords", { do: "card-rm", card: "0005" }, true)).toMatchObject({ removed: { label: "Work" } });
  expect(await invoke("passwords", { do: "cards" }, true)).toMatchObject({ cards: [] });
});

test.each([
  ["a mistyped digit", { number: "4242424242424241", exp: "07/29", cvc: "737" }, "that card number fails the check every card number passes"],
  ["an expiry already past", { number: NUMBER, exp: "01/20", cvc: "737" }, "that card expired at the end of 01/20"],
  ["a 2 digit security code", { number: NUMBER, exp: "07/29", cvc: "73" }, "the security code must be 3 or 4 digits"],
  ["a NUL in the name, which would leave the vault unreadable", { number: NUMBER, exp: "07/29", cvc: "737", name: "Ada\u0000" }, "control character"],
])("card-save refuses a card with %s and keeps nothing", async (_, card, why) => {
  await expect(invoke("passwords", { do: "card-save", ...card }, true)).rejects.toThrow(why);
  expect(await invoke("passwords", { do: "cards" }, true)).toMatchObject({ cards: [] });
});

test("a card goes to the page's own frames and a card processor's, each only what its fields take; a frame from another site gets none and is named", async () => {
  kept = [VISA];
  const result = await fillVisa("4242");
  expect(result).toMatchObject({ card: "Visa", site: "shop.example", filled: ["name", "number", "security code", "expiry", "zip"], skipped: expect.stringContaining("evil.example") });
  expect(fillCalls).toEqual([
    { frame: 0, site: "shop.example", card: { name: "Ada Lovelace" } },
    { frame: 3, site: "js.stripe.com", card: { number: NUMBER, csc: "737", month: 7, year: 2029, zip: "94107" } },
  ]);
  expect(JSON.stringify(result)).not.toContain(NUMBER);
  expect(JSON.stringify(result)).not.toContain("737");
  expect(await invoke("extract", { tab: TAB }, true)).toMatchObject({ text: "Card ..., spaced ..., code .... Order 1737." });
  expect(JSON.stringify(recent(500))).not.toContain(NUMBER);
});

// The owner's order (11-13): a card fill asks him nothing, at the Mac or
// away from it, where it once asked his iPhone's Face ID.
test("away from the Mac, a card fill fills the card and sends his phone nothing", async () => {
  kept = [VISA];
  process.env.SAFARI_HARNESS_AWAY = "1";
  const alerts = spyOn(telegram, "sendTelegram").mockResolvedValue(undefined);
  expect(await fillVisa()).toMatchObject({ card: "Visa", filled: ["name", "number", "security code", "expiry", "zip"] });
  expect(alerts).not.toHaveBeenCalled();
});

test.each([
  ["http://shop.example", "https://js.stripe.com"],
  ["https://shop.example", "https://evil.example"],
  ["https://shop.example", "https://stripe.com"],
  ["https://shop.example", "https://js.stripe.com.evil.example"],
  ["https://shop.example", "https://up.cybersource.com.evil.example"],
  ["https://shop.example", "https://evil.cybersource.com"],
])("a checkout at %s with card fields at %s is refused, and no frame gets the card", async (topOrigin, origin) => {
  kept = [VISA];
  frames = [{ ...FRAMES[0], origin: topOrigin, fields: [] }, { ...FRAMES[1], origin }];
  await expect(fillVisa()).rejects.toThrow(/an https page|nor a card processor/);
  expect(fillCalls).toEqual([]);
});
