import { afterAll, afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { invoke } from "./call.ts";
import { endApproval } from "./cards.ts";
import { connect } from "./fake-safari.ts";
import { recent } from "./journal.ts";
import { watched } from "./mission.ts";
import { tabSecrets } from "./redact.ts";
import * as daemonRpc from "./rpc.ts";
import { callTool } from "./tools.ts";

// The keychain's card helper is fake-cards.ts, keeping its cards in a file
// and counting the Touch IDs it would have asked. The checkout is a page on
// shop.example whose own frame holds the name, a Stripe frame the rest, and
// a frame from evil.example card fields too; the page records which card
// each frame's fillCard got, and names the fields as content.js does.
const dir = mkdtempSync(join(tmpdir(), "cards-test-"));
const store = join(dir, "cards.json");
const previousEnv = {
  FAKE_CARDS_DIR: process.env.FAKE_CARDS_DIR,
  SAFARI_HARNESS_CARDS: process.env.SAFARI_HARNESS_CARDS,
  SAFARI_HARNESS_AWAY: process.env.SAFARI_HARNESS_AWAY,
};
process.env.FAKE_CARDS_DIR = dir;
process.env.SAFARI_HARNESS_CARDS = join(import.meta.dir, "fake-cards.ts");
process.env.SAFARI_HARNESS_AWAY = "0";

const TAB = 7001;
const NUMBER = "4242424242424242";
const VISA = { id: "card-1", label: "Visa", number: NUMBER, exp: "07/29", csc: "737", name: "Ada Lovelace", zip: "94107" };
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
const watchedPort = () => spyOn(daemonRpc, "rpc").mockImplementation((tool: string, args: Record<string, unknown> = {}, model = false) => watched(process.pid, tool, args, () => callTool(tool, args, model)));
const approvals = () => (existsSync(join(dir, "approvals")) ? readFileSync(join(dir, "approvals"), "utf8").split("\n").filter(Boolean).length : 0);
const fillVisa = (card = "Visa") => invoke("passwords", { do: "card-fill", tab: TAB, card }, true);

afterEach(() => {
  mock.restore();
  frames = FRAMES;
  setSystemTime();
  fillCalls.length = 0;
  tabSecrets.clear();
  endApproval();
  process.env.SAFARI_HARNESS_AWAY = "0";
});
afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a card given in the chat is saved, listed by its label and last 4, and removed by its last 4", async () => {
  writeFileSync(store, "[]");
  watchedPort();
  const saved = await invoke("passwords", { do: "card-save", card: "Work", number: "378282246310005", exp: "09/30", cvc: "7373", name: "Ada Lovelace", zip: "94107" }, true);
  expect(saved).toMatchObject({ saved: { label: "Work", last4: "0005", exp: "09/30" } });
  expect(await invoke("passwords", { do: "cards" }, true)).toMatchObject({ cards: [{ label: "Work", last4: "0005", name: "Ada Lovelace" }] });
  await fillVisa("Work");
  expect(fillCalls).toContainEqual({ frame: 3, site: "js.stripe.com", card: { number: "378282246310005", csc: "7373", month: 9, year: 2030, zip: "94107" } });
  expect(await invoke("passwords", { do: "card-rm", card: "0005" }, true)).toMatchObject({ removed: { label: "Work" } });
  expect(await invoke("passwords", { do: "cards" }, true)).toMatchObject({ cards: [] });
});

// The owner's choice (10-01): one Touch ID covers card fills for 5 minutes.
test("one Touch ID covers card fills for 5 minutes, and the first fill after them asks again", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  const before = approvals();
  const asked: number[] = [];
  const start = Date.parse("2026-10-01T12:00:00Z");
  for (const minutes of [0, 4, 6]) {
    setSystemTime(new Date(start + minutes * 60_000));
    await fillVisa();
    asked.push(approvals() - before);
  }
  expect(asked).toEqual([1, 1, 2]);
});

test("a card goes to the page's own frames and a card processor's, each only what its fields take; a frame from another site gets none and is named", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
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

test("away from the Mac, a card fill asks no Touch ID and fills nothing", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  process.env.SAFARI_HARNESS_AWAY = "1";
  const before = approvals();
  await expect(fillVisa()).rejects.toThrow("away from the Mac");
  expect(approvals()).toBe(before);
  expect(fillCalls).toEqual([]);
});

test.each([
  ["http://shop.example", "https://js.stripe.com"],
  ["https://shop.example", "https://evil.example"],
  ["https://shop.example", "https://stripe.com"],
  ["https://shop.example", "https://js.stripe.com.evil.example"],
])("a checkout at %s with card fields at %s is refused before asking Touch ID", async (topOrigin, origin) => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  frames = [{ ...FRAMES[0], origin: topOrigin, fields: [] }, { ...FRAMES[1], origin }];
  const before = approvals();
  await expect(fillVisa()).rejects.toThrow();
  expect(approvals()).toBe(before);
  expect(fillCalls).toEqual([]);
});
