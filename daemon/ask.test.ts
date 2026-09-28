import { afterAll, afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_TOOLS } from "./ask.ts";
import * as imessage from "./imessage.ts";
import * as phone from "./phone.ts";

// ask texts the user's phone an agent's question when he is away from the
// Mac, and returns his reply. Messages and the clock are fakes: a line
// texted to his own number shows in his thread as sent and as received,
// his replies alike, and a test moves the clock on for the wait to read his
// thread again.

const OWN = "+15550100000";
type Row = { me: boolean; text: string; at: number };
let dir = "";
let thread: Row[] = [];
let texts: string[] = [];
let texted = Promise.withResolvers<void>();
const lands = (line: string) => void thread.push({ me: true, text: line, at: Date.now() }, { me: false, text: line, at: Date.now() });

const ask = (a: Record<string, unknown>) => ASK_TOOLS.ask.run(a);
// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};
const tick = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  await settled();
};
// what a call has returned by now, with no more time going by
const now = <T>(p: Promise<T>) => Promise.race([p, settled().then(() => "still waiting")]);
// Settles once the question has gone out and the wait for his reply is on.
const out = () => texted.promise.then(settled);

const away = process.env.SAFARI_HARNESS_AWAY;
beforeEach(() => {
  jest.useFakeTimers();
  process.env.SAFARI_HARNESS_AWAY = "1";
  dir = mkdtempSync(join(tmpdir(), "safari-ask-"));
  thread = [];
  texts = [];
  texted = Promise.withResolvers();
  spyOn(phone, "dataFile").mockImplementation((name) => join(dir, name));
  spyOn(imessage, "textOwner").mockImplementation(async (line) => {
    const after = thread.length;
    texts.push(line);
    lands(line);
    texted.resolve();
    return { status: "received", to: OWN, after };
  });
  spyOn(imessage, "textOwnNumber").mockImplementation(async (_to, line) => {
    texts.push(line);
    lands(line);
  });
  spyOn(imessage, "ownThread").mockImplementation((to, after) => (to === OWN ? thread.slice(after) : []));
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

test("at the Mac, ask texts nothing and tells the agent to ask in its own chat", async () => {
  process.env.SAFARI_HARNESS_AWAY = "0";
  expect(await ask({ question: "which color?", choices: ["red", "blue"] })).toMatchObject({ atMac: true });
  expect(texts).toEqual([]);
});

test.each([
  ["by the number the text gave it", (line: string) => line.match(/(\d+) for blue/)?.[1] ?? "no number for blue"],
  ["in words", () => "Blue!"],
])("away, the question goes to his phone with its choices numbered, and a reply %s names the choice", async (_how, replyTo) => {
  const asked = ask({ question: "which color?", choices: ["red", "blue"] });
  await out();
  const said = replyTo(texts[0]);
  lands(said);
  await tick(phone.POLL_MS);
  expect(await now(asked)).toEqual({ answer: said, choice: "blue" });
});

test("a watch's text that lands while a question waits is no answer to it", async () => {
  const asked = ask({ question: "which color?", choices: ["red", "blue"] });
  await out();
  await phone.text("stock: 3 left -> 2 left (https://shop.example/)", "note", { to: OWN });
  await tick(phone.POLL_MS);
  expect(await now(asked)).toBe("still waiting");
  lands("red");
  await tick(phone.POLL_MS);
  expect(await now(asked)).toEqual({ answer: "red", choice: "red" });
});

test("an agent has one question out at a time: a wait longer than one call goes on with no second text, and another question waits for the answer", async () => {
  const first = ask({ question: "which color?" });
  await out();
  // one call waits about 2 minutes of the 10 he has
  await tick(110_000);
  expect(await now(first)).toEqual({ answered: false, waiting: true });
  await expect(ask({ question: "which size?" })).rejects.toThrow('already asked the user "which color?"');
  lands("green");
  expect(await ask({ question: "which color?" })).toEqual({ answer: "green" });
  expect(texts).toHaveLength(1);
  // answered, it makes way for the next
  texted = Promise.withResolvers();
  const next = ask({ question: "which size?" });
  await out();
  lands("small");
  await tick(phone.POLL_MS);
  expect(await now(next)).toEqual({ answer: "small" });
  expect(texts).toHaveLength(2);
});

test("with no reply in ms, the question ends unanswered, and the agent may ask another", async () => {
  const asked = ask({ question: "which color?", ms: 60_000 });
  await out();
  await tick(60_000);
  expect(await now(asked)).toEqual({ answered: false });
  texted = Promise.withResolvers();
  const next = ask({ question: "which size?" });
  await out();
  lands("small");
  await tick(phone.POLL_MS);
  expect(await now(next)).toEqual({ answer: "small" });
  expect(texts).toHaveLength(2);
});
