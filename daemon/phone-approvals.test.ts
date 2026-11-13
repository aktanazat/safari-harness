import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePhone, phonePage } from "./fake-phone.ts";
import { watched } from "./mission.ts";
import * as phone from "./phone.ts";
import * as telegram from "./telegram.ts";
import { callTool } from "./tools.ts";

// An agent's step on the user's iPhone while he is away from the Mac: the
// approval gate calls the hidden tools as its rpc reaches them, his iPhone
// is fake-phone.ts answering the links that reach his Telegram, and each
// test keeps the harness's state files apart.
const previousEnv = {
  SAFARI_HARNESS_PHONE_PORT: process.env.SAFARI_HARNESS_PHONE_PORT,
  SAFARI_HARNESS_PHONE_ORIGIN: process.env.SAFARI_HARNESS_PHONE_ORIGIN,
};
phonePage();

const STEP = { verb: "fill a saved password", kind: "login", item: { name: "github.com", sub: "ada" }, purpose: "open the pull request", where: "github.com" };
type Opened = { id: string; link: string; alerted: boolean; why?: string };

let home = "";
let lines: string[] = [];
const call = (tool: string, args: Record<string, unknown> = {}, model = false) => watched(process.pid, tool, args, () => callTool(tool, args, model));
const stateOf = (id: string) => call("approval_phone_state", { id });

// A request approval_phone_open or approval_phone_setup made, checked.
// (toMatchObject with expect.any() leaves its matchers in the object.)
function made(v: unknown): Opened {
  const o = v as Opened;
  expect([typeof o.id, typeof o.link, typeof o.alerted]).toEqual(["string", "string", "boolean"]);
  return o;
}

const opened = async (request: Record<string, unknown> = STEP) => made(await call("approval_phone_open", { request }));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "phone-approvals-home-"));
  lines = [];
  spyOn(phone, "dataFile").mockImplementation((name) => join(home, name));
  spyOn(telegram, "sendTelegram").mockImplementation(async (text) => {
    lines.push(text);
  });
});

// The approvals passkey, set up as the user does it once at the Mac: the
// link reaches his phone, and Face ID there makes it.
async function setUp(iphone: FakePhone): Promise<Opened> {
  const setup = made(await call("approval_phone_setup"));
  const answered = await iphone.approve(setup.link);
  if (!answered.ok) throw new Error(`the page refused the setup: ${await answered.text()}`);
  return setup;
}

afterEach(() => {
  mock.restore();
  setSystemTime();
  rmSync(home, { recursive: true, force: true });
});
afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("setting up keeps only the approvals passkey's public key and id, readable by the user alone", async () => {
  const setup = await setUp(new FakePhone());
  expect(setup.alerted).toBe(true);
  expect(lines[0]).toContain(setup.link);
  expect(await stateOf(setup.id)).toEqual({ state: "approved" });
  const file = join(home, "phone-approvals.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(Object.keys(saved).sort()).toEqual(["at", "credential", "rpId"]);
  expect(Object.keys(saved.credential).sort()).toEqual(["id", "key"]);
});

test("only Face ID's answer from the approvals passkey, over this request's challenge, on this page, approves it, once", async () => {
  const iphone = new FakePhone();
  await setUp(iphone);
  const earlier = await opened();
  const step = await opened();
  expect(step.alerted).toBe(true);
  expect(lines.at(-1)).toContain(step.link);
  const forged = [
    await iphone.answer(step.link, { signedFor: "https://evil.example" }),
    await iphone.answer(step.link, { otherKey: true }),
    await iphone.answer(step.link, { uv: false }),
    await new FakePhone().answer(step.link),
    await iphone.answer(earlier.link),
  ];
  for (const answer of forged) expect((await iphone.post(step.link, answer)).status).toBe(403);
  expect(await stateOf(step.id)).toEqual({ state: "pending" });
  const real = await iphone.answer(step.link);
  expect((await iphone.post(step.link, real)).status).toBe(200);
  expect(await stateOf(step.id)).toEqual({ state: "approved" });
  expect((await iphone.post(step.link, real)).status).toBe(410);
  expect(await stateOf(step.id)).toEqual({ state: "approved" });
  expect(await stateOf(earlier.id)).toEqual({ state: "pending" });
});

test("a request no one answered in 10 minutes ends, and his answer after that approves nothing", async () => {
  const iphone = new FakePhone();
  await setUp(iphone);
  const start = Date.now();
  setSystemTime(start);
  const step = await opened();
  const answer = await iphone.answer(step.link);
  setSystemTime(start + 10 * 60_000 - 1);
  expect(await stateOf(step.id)).toEqual({ state: "pending" });
  setSystemTime(start + 10 * 60_000);
  expect(await stateOf(step.id)).toEqual({ state: "expired" });
  expect((await iphone.post(step.link, answer)).status).toBe(410);
  expect(await stateOf(step.id)).toEqual({ state: "expired" });
});

test("deny needs no Face ID but only the request's own page, and a denied request stays denied", async () => {
  const iphone = new FakePhone();
  await setUp(iphone);
  const step = await opened();
  const elsewhere = await fetch(step.link, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ deny: true }) });
  expect(elsewhere.status).toBe(403);
  expect(await stateOf(step.id)).toEqual({ state: "pending" });
  expect((await iphone.post(step.link, { deny: true })).status).toBe(200);
  expect(await stateOf(step.id)).toEqual({ state: "denied" });
  expect((await iphone.approve(step.link)).status).toBe(410);
  expect(await stateOf(step.id)).toEqual({ state: "denied" });
});

test("answered on the Mac first, the request's page says so and takes no answer", async () => {
  const iphone = new FakePhone();
  await setUp(iphone);
  const step = await opened();
  const answer = await iphone.answer(step.link);
  expect(await call("approval_phone_close", { id: step.id })).toEqual({ closed: true });
  const page = await fetch(`${step.link}/options`);
  expect(page.status).toBe(410);
  expect(await page.json()).toEqual({ error: "Answered on the Mac" });
  expect((await iphone.post(step.link, answer)).status).toBe(410);
  expect(await stateOf(step.id)).toEqual({ state: "expired" });
});

test("his phone shows the gate's title, line, rows, and buttons, or the request's own parts, with no control or direction characters", async () => {
  await setUp(new FakePhone());
  const shown = async (request: Record<string, unknown>) => (await fetch(`${(await opened(request)).link}/options`)).json();
  const rows = [{ lead: "Says", value: "on my way" }, { lead: "For", value: "tell Ada" }, { lead: "Files", value: "map.png", mono: true }];
  expect(await shown({ ...STEP, title: "Text to Ada", line: "omp sends exactly this from your Messages.", rows, approve: "Send" })).toMatchObject({
    kind: "approve", asker: "omp", title: "Text to Ada", line: "omp sends exactly this from your Messages.", rows, approve: "Send", deny: "Deny",
  });
  expect(await shown({ ...STEP, where: "tab 7", detail: "Fills it\u202e without\nshowing it" })).toMatchObject({
    title: "github.com",
    line: "Fills it without showing it",
    rows: [{ lead: "Asks to", value: "fill a saved password" }, { lead: "Detail", value: "ada" }, { lead: "On", value: "tab 7" }, { lead: "For", value: "open the pull request" }],
    approve: "Approve",
    deny: "Deny",
  });
});

test("a model can neither open, read, end, nor set up a phone approval, and none opens before the passkey is set up", async () => {
  const given: Record<string, Record<string, unknown>> = { approval_phone_open: { request: STEP }, approval_phone_state: { id: "x" }, approval_phone_close: { id: "x" }, approval_phone_setup: {} };
  for (const [tool, args] of Object.entries(given)) await expect(call(tool, args, true)).rejects.toThrow("harness's own");
  await expect(opened()).rejects.toThrow("safari passwords approvals-phone");
  expect(lines).toEqual([]);
});
