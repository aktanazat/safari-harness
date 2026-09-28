import { afterAll, afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import * as front from "./front.ts";
import { HANDOFF_TOOLS } from "./handoff.ts";
import * as imessage from "./imessage.ts";
import * as phone from "./phone.ts";
import * as daemonRpc from "./rpc.ts";
import { callTool } from "./tools.ts";

// handoff gives the user the tab for a step only they can take. The daemon's
// half raises the tab with a notice, looks at the page once a second, and
// gives back what the user had in front; the caller's half texts their
// phone when they are away, and reads their replies. Both run here, the
// caller's RPC calls going straight to the daemon's tools. Safari, the
// screen, notices, Messages, and the clock are fakes: a test moves the
// clock on once every call it made has been taken up.

type Page = { url: string; check?: "box" | "block" };
// The user's thread with his own number, as Messages records it.
type Row = { me: boolean; text: string; at: number };
type Mac = { app: string; activated: number[]; notices: string[]; texts: { line: string; picture: boolean }[]; thread: Row[]; reply(line: string): void; use(tab: number): void };
const OWN = "+15550100000";
const MAIL = "com.apple.mail";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Mail is in front. Safari's window shows the user's tab 3; the agent's tab
// sits alone in an agent window behind it, which never holds the front tab,
// on a page with a Cloudflare box, or a Cloudflare block, while page.check
// says so. Safari shows the window of the tab activated last. The Mac
// records the tabs the harness activates, the app in front, the notices,
// and the texts. A line texted to his own number shows in his thread as
// sent and again as received, the harness's and his replies alike.
function mac(tab: number, page: Page): Mac {
  const tabs = [{ id: 3, windowId: 1, url: "https://mail.example/", active: true }, { id: tab, windowId: 2, url: page.url, active: true }];
  let shown = 1;
  const both = (line: string): Row[] => [{ me: true, text: line, at: Date.now() }, { me: false, text: line, at: Date.now() }];
  const m: Mac = { app: MAIL, activated: [], notices: [], texts: [], thread: [], reply: (line) => void m.thread.push(...both(line)), use: (id) => { shown = tabs.find((t) => t.id === id)!.windowId; } };
  bridge.attach({
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
        return answer({ value: [{ frame: 0, url: page.url, title: "Sign in", text: page.check === "block" ? "Sorry, you have been blocked" : "Sign in", markers: [], answered: [], frames }] });
      }
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
  spyOn(imessage, "textOwner").mockImplementation(async (line, picture) => {
    m.texts.push({ line, picture: picture !== undefined && existsSync(picture) });
    const after = m.thread.length;
    m.thread.push(...both(line));
    return { status: "received", to: OWN, after };
  });
  spyOn(imessage, "textOwnNumber").mockImplementation(async (_to, line) => void m.thread.push(...both(line)));
  spyOn(imessage, "ownThread").mockImplementation((to, after) => (to === OWN ? m.thread.slice(after) : []));
  return m;
}

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => new Promise<void>((r) => setImmediate(r));
const tick = async (ms = 1000) => {
  jest.advanceTimersByTime(ms);
  await settled();
};
// what a call has returned by now, with no more time going by
const now = <T>(p: Promise<T>) => Promise.race([p, settled().then(() => "still waiting")]);

type Args = Record<string, unknown>;
// Settles once the daemon has taken up the caller's next handoff call that
// matches, and all it set going that needs no clock has run.
let next: { is(a: Args): boolean; taken(): void } | undefined;
function taken(is: (a: Args) => boolean): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  next = { is, taken: resolve };
  return promise.then(settled);
}
// a call with this why that waits, rather than starting the handoff or asking to text
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

test("a user at the Mac gets the notice and no text", async () => {
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(75, page);
  const t = taken(waits("Clear the check"));
  const handed = handoff(75, "Clear the check");
  await t;
  page.check = undefined;
  await tick();
  expect(await handed).toMatchObject({ done: true });
  expect(m).toMatchObject({ notices: ["Clear the check"], texts: [] });
});

test("a user away from the Mac gets one text with a picture of the page, however many calls wait on the handoff", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(76, page);
  // Two calls wait at once; the first runs out of time, as one does at the
  // tool call limit, and the agent calls again.
  let t = taken((a) => a.texted !== undefined);
  const first = handoff(76, "Clear the check", 1000);
  const second = handoff(76, "Clear the check");
  await t;
  await tick();
  expect(await first).toMatchObject({ done: false, texted: "received" });
  t = taken(waits("Clear the check"));
  const again = handoff(76, "Clear the check");
  await t;
  page.check = undefined;
  await tick();
  expect(await second).toMatchObject({ done: true, joined: true });
  expect(await again).toMatchObject({ done: true, joined: true });
  expect(m.texts).toEqual([{ line: expect.stringContaining("shop.example"), picture: true }]);
});

test("a user who clears the check while the text to their phone is on its way ends the handoff: the call that sent it returns done, with no second notice", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(77, page);
  const texting = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<{ status: "received"; to: string; after: number }>();
  spyOn(imessage, "textOwner").mockImplementation(() => {
    texting.resolve();
    return sent.promise;
  });
  const handed = handoff(77, "Clear the check");
  await texting.promise;
  page.check = undefined;
  await tick();
  const t = taken((a) => a.texted !== undefined);
  sent.resolve({ status: "received", to: OWN, after: 0 });
  await t;
  // were it to wait again, its 10 seconds run out
  await tick(10000);
  expect(await handed).toMatchObject({ done: true, texted: "received" });
  expect(m.notices).toEqual(["Clear the check"]);
});

test("a user away who clears the check and replies done ends the handoff at once, before the page's next look of its own", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(78, page);
  const t = taken((a) => a.texted !== undefined);
  const handed = handoff(78, "Clear the check");
  await t;
  page.check = undefined;
  m.reply("Done!");
  // half the second the daemon waits between looks of its own
  await tick(phone.POLL_MS);
  expect(await now(handed)).toMatchObject({ done: true, texted: "received" });
});

test.each([["skip", 79], ["stop", 81]] as const)("a user away who replies %s ends the wait with the check still up, and the agent hears which", async (word, tab) => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const m = mac(tab, { url: "https://shop.example/login", check: "box" });
  const t = taken((a) => a.texted !== undefined);
  const handed = handoff(tab, "Clear the check");
  await t;
  m.reply(`${word[0].toUpperCase()}${word.slice(1)}, thanks`);
  await tick(phone.POLL_MS);
  const r = await now(handed);
  expect(r).toMatchObject({ done: false, user: word });
  // where his replies are stays between the harness and Messages
  expect(JSON.stringify(r)).not.toContain(OWN);
});

test("a reply from before the text, or another text of the harness's own, never ends the wait", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(80, page);
  m.reply("skip");
  const t = taken((a) => a.texted !== undefined);
  const handed = handoff(80, "Clear the check");
  await t;
  // a watch's news, whose first word is one a handoff takes
  await phone.text("stop-sale: 3 left -> 2 left (https://shop.example/)", "note", { to: OWN });
  await tick(phone.POLL_MS);
  expect(await now(handed)).toBe("still waiting");
  page.check = undefined;
  await tick();
  expect(await handed).toEqual(expect.objectContaining({ done: true }));
  expect(await handed).not.toHaveProperty("user");
});

test("after a skip, the next handoff on that tab is a new one: it texts him again and waits on a new reply", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const page: Page = { url: "https://shop.example/login", check: "box" };
  const m = mac(82, page);
  let t = taken((a) => a.texted !== undefined);
  const skipped = handoff(82, "Clear the check");
  await t;
  m.reply("skip");
  await tick(phone.POLL_MS);
  expect(await now(skipped)).toMatchObject({ done: false, user: "skip" });
  t = taken((a) => a.texted !== undefined);
  const again = handoff(82, "Clear the check");
  await t;
  await tick(phone.POLL_MS);
  expect(await now(again)).toBe("still waiting");
  expect(m.texts).toHaveLength(2);
  page.check = undefined;
  await tick();
  expect(await again).toMatchObject({ done: true });
});
