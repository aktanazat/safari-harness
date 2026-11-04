import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { invoke } from "./call.ts";
import { endApproval } from "./cards.ts";
import { connect } from "./fake-safari.ts";
import { FakePhone } from "./fake-phone.ts";
import { recent } from "./journal.ts";
import { watched } from "./mission.ts";
import * as phone from "./phone.ts";
import { tabSecrets } from "./redact.ts";
import * as daemonRpc from "./rpc.ts";
import * as telegram from "./telegram.ts";
import { callTool } from "./tools.ts";

// The keychain's card helper is fake-cards.ts, keeping its cards in a file
// and counting the Touch IDs it would have asked. The checkout is a page on
// shop.example whose own frame holds the name, a Stripe frame the rest, and
// a frame from evil.example card fields too; the page records which card
// each frame's fillCard got, and names the fields as content.js does. His
// iPhone is fake-phone.ts, which answers the approval page's links that
// reach his Telegram; each test keeps the harness's state files apart.
const dir = mkdtempSync(join(tmpdir(), "cards-test-"));
const store = join(dir, "cards.json");
const previousEnv = {
  FAKE_CARDS_DIR: process.env.FAKE_CARDS_DIR,
  SAFARI_HARNESS_CARDS: process.env.SAFARI_HARNESS_CARDS,
  SAFARI_HARNESS_AWAY: process.env.SAFARI_HARNESS_AWAY,
  SAFARI_HARNESS_PHONE_PORT: process.env.SAFARI_HARNESS_PHONE_PORT,
  SAFARI_HARNESS_PHONE_ORIGIN: process.env.SAFARI_HARNESS_PHONE_ORIGIN,
};
process.env.FAKE_CARDS_DIR = dir;
process.env.SAFARI_HARNESS_CARDS = join(import.meta.dir, "fake-cards.ts");
process.env.SAFARI_HARNESS_AWAY = "0";
// The approval page listens on a free port, at that address.
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
process.env.SAFARI_HARNESS_PHONE_PORT = String(probe.port);
process.env.SAFARI_HARNESS_PHONE_ORIGIN = `http://127.0.0.1:${probe.port}`;
await probe.stop(true);

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

// The harness's state files, and what reached his phone, in order.
let home = "";
let sent = 0;
let lines: PromiseWithResolvers<string>[] = [];
const line = (n: number) => (lines[n] ??= Promise.withResolvers<string>());
// The link in the nth message to his phone, once it went.
const link = async (n: number) => /https?:\/\/\S+/.exec(await line(n).promise)?.[0] ?? "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cards-home-"));
  sent = 0;
  lines = [];
  spyOn(phone, "dataFile").mockImplementation((name) => join(home, name));
  spyOn(telegram, "sendTelegram").mockImplementation(async (text) => {
    line(sent++).resolve(text);
  });
});

// Face ID set up for the Visa, as the user does it once at the Mac: his
// Touch ID there, then the link on his phone. Then he leaves, and the Mac
// locks.
async function setUpPhone(iphone: FakePhone): Promise<unknown> {
  const setup = invoke("passwords", { do: "card-phone", card: "Visa" }, true);
  const answered = await iphone.approve(await link(0));
  if (!answered.ok) throw new Error(`the page refused the setup: ${await answered.text()}`);
  const done = await setup;
  endApproval();
  return done;
}

afterEach(() => {
  mock.restore();
  frames = FRAMES;
  setSystemTime();
  fillCalls.length = 0;
  tabSecrets.clear();
  endApproval();
  process.env.SAFARI_HARNESS_AWAY = "0";
  rmSync(home, { recursive: true, force: true });
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

// The owner's choice (10-13): one Touch ID covers card fills until the Mac
// locks, for at most 12 hours (on 10-01 it was 5 minutes).
test("one Touch ID covers card fills past 5 minutes and up to 12 hours, and the first fill after them asks again", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  const before = approvals();
  const asked: number[] = [];
  const start = Date.parse("2026-10-13T08:00:00Z");
  for (const minutes of [0, 6, 12 * 60 - 1, 12 * 60]) {
    setSystemTime(new Date(start + minutes * 60_000));
    await fillVisa();
    asked.push(approvals() - before);
  }
  expect(asked).toEqual([1, 1, 1, 2]);
});

test("the Mac locking ends the approval: the next fill asks Touch ID again", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  const before = approvals();
  await fillVisa();
  const pid = Number(readFileSync(join(dir, "serve.pid"), "utf8"));
  process.kill(pid, "SIGUSR2");
  // The test cannot reach the helper cards.ts spawned to await its end, so
  // it looks until the helper's pid is gone.
  for (const deadline = performance.now() + 3000; performance.now() < deadline; await Bun.sleep(5)) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
  }
  await fillVisa();
  expect(approvals() - before).toBe(2);
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
  ["https://shop.example", "https://up.cybersource.com.evil.example"],
  ["https://shop.example", "https://evil.cybersource.com"],
])("a checkout at %s with card fields at %s is refused before asking Touch ID", async (topOrigin, origin) => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  frames = [{ ...FRAMES[0], origin: topOrigin, fields: [] }, { ...FRAMES[1], origin }];
  const before = approvals();
  await expect(fillVisa()).rejects.toThrow();
  expect(approvals()).toBe(before);
  expect(fillCalls).toEqual([]);
});

// Every string in a file of the harness's, as it reads and as the base64url
// or hex it may encode.
const readings = (v: unknown): string[] =>
  typeof v === "string" ? [v, Buffer.from(v, "base64url").toString("utf8"), Buffer.from(v, "hex").toString("utf8")] : v && typeof v === "object" ? Object.values(v).flatMap(readings) : [];

test("Face ID set up at the Mac keeps only a sealed copy of the card, in a file only the user can read", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  expect(await setUpPhone(new FakePhone())).toMatchObject({ enrolled: { card: "Visa", last4: "4242" } });
  const file = join(home, "phone-cards.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readings(JSON.parse(readFileSync(file, "utf8"))).join("\n")).not.toMatch(/4242424242424242|Lovelace/);
  expect(await invoke("passwords", { do: "cards" }, true)).toMatchObject({ cards: [{ label: "Visa", phone: true }] });
});

test("away, a card set up for his phone sends it a link, and fills only once his Face ID answer checks out", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  const iphone = new FakePhone();
  await setUpPhone(iphone);
  process.env.SAFARI_HARNESS_AWAY = "1";
  const before = approvals();
  const filling = fillVisa();
  const approve = await link(1);
  expect(await line(1).promise).toContain("Visa ending 4242 on shop.example");
  const answer = await iphone.answer(approve);
  expect(fillCalls).toEqual([]);
  expect((await iphone.post(approve, answer)).status).toBe(200);
  const result = await filling;
  expect(result).toMatchObject({ card: "Visa", site: "shop.example", filled: ["name", "number", "security code", "expiry", "zip"] });
  expect(fillCalls).toContainEqual({ frame: 3, site: "js.stripe.com", card: { number: NUMBER, csc: "737", month: 7, year: 2029, zip: "94107" } });
  expect(approvals()).toBe(before);
  expect(JSON.stringify(result)).not.toContain(approve);
});

test("an answer signed on another page or by another key, one Face ID did not verify, or one made for an earlier request is refused, and nothing is filled", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  const iphone = new FakePhone();
  await setUpPhone(iphone);
  process.env.SAFARI_HARNESS_AWAY = "1";
  const first = fillVisa();
  const earlier = await link(1);
  const used = await iphone.answer(earlier);
  expect((await iphone.post(earlier, used)).status).toBe(200);
  await first;
  fillCalls.length = 0;
  frames = [{ ...FRAMES[0], origin: "https://other.example" }, FRAMES[1]];
  const second = fillVisa();
  const now = await link(2);
  const refused = [
    (await iphone.approve(now, { signedFor: "https://evil.example" })).status,
    (await iphone.approve(now, { otherKey: true })).status,
    (await iphone.approve(now, { uv: false })).status,
    (await iphone.post(now, used)).status,
    (await iphone.post(earlier, used)).status,
  ];
  expect(refused).toEqual([403, 403, 403, 403, 410]);
  expect(fillCalls).toEqual([]);
  expect((await iphone.approve(now)).status).toBe(200);
  expect(await second).toMatchObject({ site: "other.example" });
});

test("one Face ID on his phone covers that card on that site for 30 minutes; after them, or on another site, his phone is asked again", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  const iphone = new FakePhone();
  await setUpPhone(iphone);
  process.env.SAFARI_HARNESS_AWAY = "1";
  const start = Date.parse("2026-10-22T08:00:00Z");
  setSystemTime(new Date(start));
  const first = fillVisa();
  await iphone.approve(await link(1));
  await first;
  setSystemTime(new Date(start + 29 * 60_000));
  await fillVisa();
  expect(sent).toBe(2);
  setSystemTime(new Date(start + 30 * 60_000));
  const later = fillVisa();
  await iphone.approve(await link(2));
  await later;
  frames = [{ ...FRAMES[0], origin: "https://other.example" }, FRAMES[1]];
  const elsewhere = fillVisa();
  expect(await line(3).promise).toContain("on other.example");
  await iphone.approve(await link(3));
  await elsewhere;
  expect(fillCalls.filter((c) => c.frame === 3)).toHaveLength(4);
});

test("an answer whose PRF output is not his passkey's opens no card: nothing is filled, and the next fill asks his phone again", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  const iphone = new FakePhone();
  await setUpPhone(iphone);
  process.env.SAFARI_HARNESS_AWAY = "1";
  const filling = fillVisa().catch((e: unknown) => e);
  expect((await iphone.approve(await link(1), { prf: randomBytes(32) })).status).toBe(200);
  expect(String(await filling)).toContain("did not open");
  expect(fillCalls).toEqual([]);
  const next = fillVisa();
  await iphone.approve(await link(2));
  await next;
  expect(fillCalls.filter((c) => c.frame === 3)).toHaveLength(1);
});

test("at the Mac, a card set up for his phone is still approved with Touch ID there", async () => {
  writeFileSync(store, JSON.stringify([VISA]));
  watchedPort();
  await setUpPhone(new FakePhone());
  const before = approvals();
  await fillVisa();
  expect(approvals() - before).toBe(1);
  expect(sent).toBe(1);
});

test("a model's own call to card_phone is refused, so no agent can take his phone's answer", async () => {
  watchedPort();
  await expect(invoke("card_phone", { do: "ask", kind: "enroll", card: "Visa ending 4242", user: "card-1" }, true)).rejects.toThrow("harness's own");
});
