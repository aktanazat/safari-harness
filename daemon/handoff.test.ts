import { afterAll, afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import * as front from "./front.ts";
import { HANDOFF_TOOLS } from "./handoff.ts";
import * as phone from "./phone.ts";
import * as daemonRpc from "./rpc.ts";
import * as telegram from "./telegram.ts";
import { callTool } from "./tools.ts";

// handoff gives the user the tab for a step only they can take. The daemon's
// half raises the tab with a notice, looks at the page once a second, and
// gives back what the user had in front; the caller's half alerts their
// phone when they are away. Both run here, the caller's RPC calls going
// straight to the daemon's tools. Safari, the screen, notices, Telegram,
// and the clock are fakes: a test moves the clock on once every call it
// made has been taken up.

type Page = { url: string; check?: "box" | "block" | "wall"; text?: string };
type Mac = { app: string; activated: number[]; notices: string[]; texts: { line: string; picture: boolean }[]; use(tab: number): void };
const MAIL = "com.apple.mail";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Mail is in front. Safari's window shows the user's tab 3; the agent's tab
// sits alone in an agent window behind it, which never holds the front tab,
// on a page with a Cloudflare box, a Cloudflare block, or Cloudflare's
// "Just a moment..." wall, while page.check says so; a wait for text answers
// at once whether page.text holds it.
// Safari shows the window of the tab activated last. The Mac records the
// tabs the harness activates, the app in front, the notices, and the
// alerts, each with whether its picture was there to send.
function mac(tab: number, page: Page): Mac {
  const tabs = [{ id: 3, windowId: 1, url: "https://mail.example/", active: true }, { id: tab, windowId: 2, url: page.url, active: true }];
  let shown = 1;
  const m: Mac = { app: MAIL, activated: [], notices: [], texts: [], use: (id) => { shown = tabs.find((t) => t.id === id)!.windowId; } };
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      const answer = (reply: { value: unknown } | { error: string }) => queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
      if (op === "tabs.list") return answer({ value: tabs.map((t) => ({ ...t, url: t.id === tab ? page.url : t.url, ...(t.windowId === 1 ? { front: true } : {}), ...(t.windowId === shown ? { shown: true } : {}) })) });
      if (op === "tabs.activate") {
        m.activated.push(args[0]);
        m.use(args[0]);
        return answer({ value: { ok: true } });
      }
      if (op === "probe") {
        const frames = page.check === "box" ? ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2"] : [];
        return answer({ value: [{ frame: 0, url: page.url, title: page.check === "wall" ? "Just a moment..." : "Sign in", text: page.check === "block" ? "Sorry, you have been blocked" : "Sign in", markers: [], answered: [], frames }] });
      }
      if (op === "relay" && args[1] === "wait") return answer({ value: { found: (page.text ?? "").includes(args[2][1].text) } });
      if (op === "shot") return answer({ value: { data: PNG } });
      answer({ error: `no ${op} here` });
    },
    close() {},
  });
  spyOn(front, "input").mockImplementation(async (args) => {
    if (args[0] === "activate") m.app = args[1];
    return args[0] === "front" ? { bundleId: m.app } : {};
  });
  spyOn(front, "notify").mockImplementation((text) => void m.notices.push(text));
  spyOn(telegram, "sendTelegram").mockImplementation(async (line, picture) => void m.texts.push({ line, picture: picture !== undefined && existsSync(picture) }));
  return m;
}

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => new Promise<void>((r) => setImmediate(r));
const tick = async (ms = 1000) => {
  jest.advanceTimersByTime(ms);
  await settled();
};

// A second at a time, so what one second sets going is under way by the next.
const ticks = async (seconds: number) => {
  for (let s = 0; s < seconds; s++) await tick();
};

type Args = Record<string, unknown>;
// Settles once the daemon has taken up the caller's next handoff call that
// matches, and all it set going that needs no clock has run.
let next: { is(a: Args): boolean; taken(): void } | undefined;
function taken(is: (a: Args) => boolean): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  next = { is, taken: resolve };
  return promise.then(settled);
}
// a call with this why that waits, rather than starting the handoff or asking to alert
const waits = (why: string) => (a: Args) => a.why === why && Number(a.ms) > 0 && a.away !== true;

const away = process.env.SAFARI_HARNESS_AWAY;
let dir = "";
beforeEach(() => {
  jest.useFakeTimers();
  process.env.SAFARI_HARNESS_AWAY = "0";
  dir = mkdtempSync(join(tmpdir(), "safari-handoff-"));
  spyOn(phone, "dataFile").mockImplementation((name) => join(dir, name));
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => {
    const result = callTool(tool, args);
    if (tool === "handoff_wait" && next?.is(args)) next.taken();
    return result;
  });
});
afterEach(() => {
  mock.restore();
  jest.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  if (away === undefined) delete process.env.SAFARI_HARNESS_AWAY;
  else process.env.SAFARI_HARNESS_AWAY = away;
});

const handoff = (tab: number, why: string, ms = 10000) => HANDOFF_TOOLS.handoff.run({ tab, why, ms });

test("a second handoff of the tab joins the first: one notice, and both return once the user has cleared the check", async () => {
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(71, page);
  let t = taken(waits("Clear the check on shop.example"));
  const first = handoff(71, "Clear the check on shop.example");
  await t;
  t = taken(waits("Clear it again"));
  const again = handoff(71, "Clear it again");
  await t;
  page.check = undefined;
  await tick();
  expect(await first).toEqual(expect.not.objectContaining({ joined: true }));
  expect(await first).toMatchObject({ done: true });
  expect(await again).toMatchObject({ done: true, joined: true });
  expect(m.notices).toEqual(["Clear the check on shop.example"]);
});

test.each([
  ["stays on the tab", () => {}, { activated: [72, 3], app: MAIL }],
  ["has gone to another app", (m: Mac) => { m.app = "com.apple.Notes"; }, { activated: [72], app: "com.apple.Notes" }],
  ["has gone to another tab", (m: Mac) => m.use(3), { activated: [72], app: front.SAFARI }],
])("a user who %s when the check clears gets back only what they have not taken back themselves", async (_how, act, after) => {
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(72, page);
  const t = taken(waits("Clear the check"));
  const handed = handoff(72, "Clear the check");
  await t;
  act(m);
  page.check = undefined;
  await tick();
  expect(await handed).toMatchObject({ done: true });
  expect({ activated: m.activated, app: m.app }).toEqual(after);
});

test("a page that blocks the browser is not handed off: the call fails at once, with no tab raised and no notice", async () => {
  const m = mac(73, { url: "https://shop.example/", check: "block" });
  const handed = handoff(73, "Clear the check").then(() => "handed off", (e: Error) => e.message);
  // handed off, it would wait out its 10 seconds
  await settled();
  await tick(10000);
  expect(await handed).toContain("no one can clear it");
  expect(m).toMatchObject({ activated: [], app: MAIL, notices: [] });
});

test("with no check on the page (a passkey prompt), the user is done once the page moves on, not before", async () => {
  const page: Page = { url: "https://shop.example/login" };
  mac(74, page);
  let t = taken(waits("Touch the sensor"));
  const handed = handoff(74, "Touch the sensor", 2000);
  await t;
  await tick(2000);
  expect(await handed).toMatchObject({ done: false });
  page.url = "https://shop.example/account";
  t = taken(waits("Touch the sensor"));
  const again = handoff(74, "Touch the sensor");
  await t;
  await tick();
  expect(await again).toMatchObject({ done: true, joined: true, url: "https://shop.example/account" });
});

test("a user at the Mac gets the notice and no alert", async () => {
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(75, page);
  const t = taken(waits("Clear the check"));
  const handed = handoff(75, "Clear the check");
  await t;
  page.check = undefined;
  await tick();
  expect(await handed).toMatchObject({ done: true, alerted: expect.stringMatching(/^not sent/) });
  expect(m).toMatchObject({ notices: ["Clear the check"], texts: [] });
});

// A card form or a Touch ID prompt may leave the address as it was: on
// 09-29 two GEICO handoffs ran out at 110 s on the page where they began.
test("with until, the user is done once the page shows that text, at the same address", async () => {
  const page: Page = { url: "https://shop.example/billing", text: "Add a card" };
  mac(77, page);
  const t = taken(waits("Save the card"));
  let result: unknown;
  const handed = HANDOFF_TOOLS.handoff.run({ tab: 77, why: "Save the card", ms: 10000, until: "Card saved" }).then((r) => (result = r));
  await t;
  await tick();
  expect(result).toBeUndefined();
  page.text = "Card saved";
  // the look already under way saw the page before; the next one sees it
  await tick();
  await tick();
  expect(await handed).toMatchObject({ done: true, url: "https://shop.example/billing" });
});

test("until text the page shows already is refused, with no tab raised and no notice", async () => {
  const m = mac(78, { url: "https://shop.example/billing", text: "Card saved" });
  const handed = HANDOFF_TOOLS.handoff.run({ tab: 78, why: "Save the card", ms: 10000, until: "Card saved" }).then(() => "handed off", (e: Error) => e.message);
  await settled();
  await tick(10000);
  expect(await handed).toContain("already shows");
  expect(m).toMatchObject({ activated: [], notices: [] });
});

test("a user away from the Mac gets one alert with a picture of the page, however many calls wait on the handoff", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(76, page);
  // Two calls wait at once; the first runs out of time, as one does at the
  // tool call limit, and the agent calls again.
  let t = taken((a) => a.alerted !== undefined);
  const first = handoff(76, "Clear the check", 1000);
  const second = handoff(76, "Clear the check");
  await t;
  await tick();
  expect(await first).toMatchObject({ done: false, alerted: "sent" });
  t = taken(waits("Clear the check"));
  const again = handoff(76, "Clear the check");
  await t;
  page.check = undefined;
  await tick();
  expect(await second).toMatchObject({ done: true, joined: true });
  expect(await again).toMatchObject({ done: true, joined: true });
  expect(m.texts).toEqual([{ line: expect.stringContaining("shop.example"), picture: true }]);
});

test("a user who clears the check while the alert to their phone is on its way ends the handoff: the call that sent it returns done, with no second notice", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(77, page);
  const sending = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  spyOn(telegram, "sendTelegram").mockImplementation(() => {
    sending.resolve();
    return sent.promise;
  });
  const handed = handoff(77, "Clear the check");
  await sending.promise;
  page.check = undefined;
  await tick();
  const t = taken((a) => a.alerted !== undefined);
  sent.resolve();
  await t;
  // were it to wait again, its 10 seconds run out
  await tick(10000);
  expect(await handed).toMatchObject({ done: true, alerted: "sent" });
  expect(m.notices).toEqual(["Clear the check"]);
});

// On 10-05 a handoff on AWS's captcha page had not answered after 130 s,
// when omp gave up on the call: the agent never called again, and the
// captcha ran out. A call answers within its ms of its start, whatever is
// still under way then.
test("a call answers within its ms of its start, though finding the user's front tab and looking whether they are away take most of it", async () => {
  const page: Page = { url: "https://shop.example/login", check: "box" };
  mac(79, page);
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => {
    if (tool === "tabs") await Bun.sleep(6000);
    return callTool(tool, args);
  });
  // as long as the probe may take
  spyOn(phone, "isAway").mockImplementation(async () => {
    await Bun.sleep(5000);
    return false;
  });
  const start = Date.now();
  let result: { value: unknown; elapsed: number } | undefined;
  void HANDOFF_TOOLS.handoff.run({ tab: "front", why: "Clear the check", ms: 10000 }).then((value) => (result = { value, elapsed: Date.now() - start }));
  await settled();
  await ticks(10);
  expect(result).toMatchObject({ elapsed: 10000, value: { done: false, hint: "call handoff again on the same tab" } });
  // the user clears it, so no later test joins the handoff of their tab
  page.check = undefined;
  await tick();
});

test("a call whose phone alert is still sending answers at its deadline without claiming delivery", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  mac(80, page);
  const sending = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  spyOn(telegram, "sendTelegram").mockImplementation(() => {
    sending.resolve();
    return sent.promise;
  });
  let result: unknown;
  void handoff(80, "Clear the check").then((r) => (result = r));
  await sending.promise;
  await ticks(10);
  expect(result).toMatchObject({ done: false, waitedMs: 10000, alerted: "sending; outcome not confirmed", hint: "call handoff again on the same tab" });
  sent.resolve();
  page.check = undefined;
  await tick();
});

test.each([60000, 110000])("a front-tab lookup still pending at %i ms returns without starting a handoff when it eventually answers", async (bound) => {
  const m = mac(81, { url: "https://shop.example/login", check: "box" });
  const lookup = Promise.withResolvers<unknown>();
  spyOn(daemonRpc, "rpc").mockImplementation((tool, args = {}) => tool === "tabs" ? lookup.promise : callTool(tool, args));
  let result: unknown;
  void HANDOFF_TOOLS.handoff.run({ tab: "front", why: "Clear the check", ...(bound === 60000 ? {} : { ms: 200000 }) }).then((r) => (result = r));
  await ticks(bound / 1000);
  expect(result).toMatchObject({ done: false, waitedMs: bound, alerted: "not sent yet", hint: "call handoff again on the same tab" });
  lookup.resolve(await callTool("tabs"));
  await settled();
  expect(m.notices).toEqual([]);
});

test("a slow daemon slice cannot hold the call past its deadline", async () => {
  const page: Page = { url: "https://shop.example/login", check: "box" };
  mac(82, page);
  const waiting = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => {
    const result = callTool(tool, args);
    if (tool === "handoff_wait" && Number(args.ms) > 0) {
      waiting.resolve();
      await reply.promise;
    }
    return result;
  });
  let result: unknown;
  void handoff(82, "Clear the check").then((r) => (result = r));
  await waiting.promise;
  await ticks(10);
  expect(result).toMatchObject({ done: false, waitedMs: 10000, hint: "call handoff again on the same tab" });
  reply.resolve();
  page.check = undefined;
  await tick();
});

test("a picture that arrives after the call ends does not start a phone alert", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(83, page);
  const capturing = Promise.withResolvers<void>();
  const picture = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<void>();
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool, args = {}) => {
    if (tool === "shot") {
      capturing.resolve();
      await picture.promise;
      const result = await callTool(tool, args);
      captured.resolve();
      return result;
    }
    return callTool(tool, args);
  });
  let result: unknown;
  void handoff(83, "Clear the check").then((r) => (result = r));
  await capturing.promise;
  await ticks(10);
  expect(result).toMatchObject({ done: false });
  picture.resolve();
  await captured.promise;
  await settled();
  page.check = undefined;
  await tick();
  expect(m.texts).toEqual([]);
});

// Cloudflare's wall often lets Safari through by itself (challenge.ts): the
// user hears only of one still up PASS_MS after the handoff began.
test("a Cloudflare wall that lets Safari through while the handoff waits ends it with no tab raised, notice, or alert", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/", check: "wall" };
  const m = mac(84, page);
  let result: unknown;
  void handoff(84, "Clear the check", 60000).then((r) => (result = r));
  await ticks(20);
  page.check = undefined;
  await ticks(2);
  expect(result).toMatchObject({ done: true, byItself: true });
  expect(m).toMatchObject({ activated: [], notices: [], texts: [] });
});

test("a Cloudflare wall still up once the handoff has waited on it goes to the user", async () => {
  const page: Page = { url: "https://shop.example/", check: "wall" };
  const m = mac(85, page);
  void handoff(85, "Clear the check", 60000);
  await ticks(40);
  expect(m).toMatchObject({ activated: [85], notices: ["Clear the check"] });
  page.check = undefined;
  await tick();
});

type Background = { done: boolean; id: number; hint?: string; joined?: true; alerted?: string };
const background = (tab: number, id?: number) => HANDOFF_TOOLS.handoff.run({ tab, why: "Clear the check", background: true, ...(id === undefined ? {} : { id }) }) as Promise<Background>;

test("a background handoff returns at once with the notice up, and its check minutes later finds the user done, with no second notice", async () => {
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(86, page);
  let started: Background | undefined;
  void background(86).then((r) => (started = r));
  await tick();
  // toMatchObject writes its matchers into what it checks, so read id first
  const id = started?.id;
  expect(typeof id).toBe("number");
  expect(started).toMatchObject({ done: false, hint: expect.stringContaining("background") });
  expect(m.notices).toEqual(["Clear the check"]);
  // past the 5 minutes a handoff nobody waits on is watched
  await tick(6 * 60_000);
  page.check = undefined;
  await tick();
  let checked: Background | undefined;
  void background(86, id).then((r) => (checked = r));
  await tick();
  expect(checked).toMatchObject({ done: true, joined: true });
  expect(m.notices).toEqual(["Clear the check"]);
});

test("a background handoff alerts a user away from the Mac once before it returns", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(87, page);
  const t = taken((a) => a.alerted !== undefined);
  let result: Background | undefined;
  void background(87).then((r) => (result = r));
  await t;
  expect(result).toMatchObject({ done: false, alerted: "sent" });
  expect(m.texts).toEqual([{ line: expect.stringContaining("shop.example"), picture: true }]);
  page.check = undefined;
  await tick();
});
