import { afterAll, afterEach, expect, jest, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { FILL_TOOLS } from "./fill.ts";
import { runAs } from "./owner.ts";
import * as pair from "./pair.ts";
import { ApplePasswords, HELIUM, launchHelium, quitHelium, type Timers } from "./passwords.ts";
import * as daemonRpc from "./rpc.ts";

// The passwords tool promises: only the code the Mac shows unlocks it, a
// wrong code cannot be retried, a fill puts the password into the page
// without handing it to the caller, the pairing lasts while some agent
// session holds it and ends after the last lets go, and a daemon restart
// hands it to the next daemon, which proves it before it says unlocked.
// The fake helper below plays Apple's side of the pairing (the SRP server,
// whose math differs from the client's), so a client that computes the key
// wrong fails to pair here. Each test runs its own pairing on a scratch
// profile: the shared one would write the running daemon's key file.

const N = BigInt(
  "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const G = 5n;
const CODE = "482913";
const SECRET = "correct horse battery staple";
const OTP = "731904";
const SITE = "login.example.com";
const USER = "aktan@example.com";
// Two agent sessions that stay up for the whole run.
const AGENT = process.pid;
const OTHER = process.ppid;

const H = (...parts: (Buffer | string)[]) => parts.reduce((h, p) => h.update(p), createHash("sha256")).digest();
const big = (b: Buffer) => BigInt(`0x${b.toString("hex") || "0"}`);
const buf = (n: bigint, len = 0) => {
  const hex = n.toString(16);
  return Buffer.from(hex.padStart(Math.max(len * 2, hex.length + (hex.length % 2)), "0"), "hex");
};
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  for (let x = b % N; e > 0n; e >>= 1n, x = (x * x) % N) if (e & 1n) r = (r * x) % N;
  return r;
}

type Sent = Record<string, unknown> & { cmd: number };
type Helper = { queries: string[]; answer: (m: Sent) => Record<string, unknown> };

// Apple's helper process: shows CODE, verifies the client's proof, and
// answers encrypted queries for one saved login under the session it paired.
// A save (command 6) replaces that login's password and, as the helper
// does, gets no answer.
function appleHelper(): Helper {
  const queries: string[] = [];
  let srp: { user: string; A: Buffer; B: Buffer; b: bigint; v: bigint; salt: Buffer } | null = null;
  let key: Buffer | null = null;
  let saved = SECRET;

  const answer = (m: Sent): Record<string, unknown> | undefined => {
    const msg = m.msg && typeof m.msg === "object" && "PAKE" in m.msg ? m.msg : null;
    if (m.cmd === 14) return { cmd: 14, capabilities: { shouldUseBase64: true } };
    if (m.cmd === 2 && msg) {
      const pake = JSON.parse(Buffer.from(String(msg.PAKE), "base64").toString());
      const reply = (o: unknown) => ({ cmd: 2, payload: { PAKE: Buffer.from(JSON.stringify(o)).toString("base64") } });
      if (pake.MSG === 0) {
        const salt = randomBytes(16);
        const v = pow(G, big(H(salt, H(`${pake.TID}:${CODE}`))));
        const b = big(randomBytes(32));
        const k = big(H(buf(N), buf(G, 384)));
        const B = buf((k * v + pow(G, b)) % N);
        srp = { user: pake.TID, A: Buffer.from(pake.A, "base64"), B, b, v, salt };
        return reply({ TID: pake.TID, MSG: 1, B: B.toString("base64"), s: salt.toString("base64"), PROTO: 1 });
      }
      if (!srp) return reply({ TID: pake.TID, MSG: 3, ErrCode: 2 });
      const s = srp;
      srp = null;
      const u = big(H(buf(big(s.A), 384), buf(big(s.B), 384)));
      const K = H(buf(pow((big(s.A) * pow(s.v, u)) % N, s.b)));
      const hng = Buffer.from(H(buf(N)).map((x, i) => x ^ H(buf(G, 384))[i]));
      const M = H(hng, H(s.user), s.salt, s.A, s.B, K);
      if (!M.equals(Buffer.from(pake.M, "base64"))) return reply({ TID: pake.TID, MSG: 3, ErrCode: 1 });
      key = K.subarray(0, 16);
      return reply({ TID: pake.TID, MSG: 3, HAMK: H(s.A, M, K).toString("base64"), ErrCode: 0 });
    }
    const payload = m.payload && typeof m.payload === "object" && "SMSG" in m.payload ? m.payload : null;
    if (payload && key) {
      const smsg = JSON.parse(String(payload.SMSG));
      const data = Buffer.from(smsg.SDATA, "base64");
      const d = createDecipheriv("aes-128-gcm", key, data.subarray(data.length - 16));
      d.setAuthTag(data.subarray(data.length - 32, data.length - 16));
      const q = JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 32)), d.final()]).toString());
      queries.push(`${m.cmd} ${q.URL ?? new URL(q.frameURLs[0]).hostname}`);
      if (m.cmd === 6) {
        if (q.NUSR === USER) saved = q.NPWD;
        return undefined;
      }
      // A code query answers with Entry_N keys, as the helper does for codes.
      const out = m.cmd === 4 ? { STATUS: 0, Entries: [{ USR: USER, sites: [SITE] }] }
        : m.cmd === 17 ? { STATUS: 0, Entry_0: { code: OTP, username: USER, domain: SITE } }
        : { STATUS: 0, Entries: [{ USR: q.USR, PWD: saved }] };
      const iv = randomBytes(16);
      const c = createCipheriv("aes-128-gcm", key, iv);
      const sealed = Buffer.concat([iv, c.update(JSON.stringify(out)), c.final(), c.getAuthTag()]);
      return { cmd: m.cmd, payload: { SMSG: JSON.stringify({ TID: smsg.TID, SDATA: sealed.toString("base64") }) } };
    }
    return { cmd: m.cmd };
  };
  return { queries, answer };
}

// The bridge in Helium, dialing daemon p: it says hello (whether its helper
// already runs, and the session it keeps), relays to the helper, and keeps
// whatever session p hands it for the next daemon. With hold, the helper's
// answers to one command wait for hold's approve.
function bridgeTo(p: ApplePasswords, helper: Helper, { running = false, stash = null as string | null, hold = undefined as TouchId | undefined } = {}) {
  const kept = { stash, closed: false };
  p.attach({
    send(data: string) {
      const msg = JSON.parse(data);
      if ("stash" in msg) kept.stash = msg.stash;
      if (msg.helper) {
        const reply = helper.answer(msg.helper);
        if (!reply) return;
        const deliver = () => p.handleMessage(JSON.stringify({ helper: reply }));
        if (msg.helper.cmd === hold?.cmd) hold.ask(deliver);
        else queueMicrotask(deliver);
      }
    },
    close() {
      kept.closed = true;
    },
  });
  p.handleMessage(JSON.stringify({ hello: { helper: running, stash } }));
  return kept;
}

// The helper answers a password (command 5) only once the user approves
// with Touch ID: approve is his approval. asked settles when such a
// request comes.
type TouchId = { cmd: number; asked: Promise<void>; ask: (deliver: () => void) => void; approve: () => void };
function touchId(): TouchId {
  const asked = Promise.withResolvers<void>();
  const held: (() => void)[] = [];
  return {
    cmd: 5,
    asked: asked.promise,
    ask(deliver) {
      held.push(deliver);
      asked.resolve();
    },
    approve: () => held.shift()?.(),
  };
}

// The grace period's clock, run by hand.
function handClock() {
  const set: { fn: () => void; live: boolean }[] = [];
  let armed = Promise.withResolvers<void>();
  const timers: Timers = {
    after(_ms, fn) {
      const t = { fn, live: true };
      set.push(t);
      armed.resolve();
      armed = Promise.withResolvers<void>();
      return () => {
        t.live = false;
      };
    },
    now: () => 0,
  };
  return {
    timers,
    live: () => set.filter((t) => t.live).length,
    // Resolves when a timer is next set.
    armed: () => armed.promise,
    runOut() {
      for (const t of set.filter((t) => t.live)) {
        t.live = false;
        t.fn();
      }
    },
  };
}

const profiles: string[] = [];
afterAll(() => {
  for (const dir of profiles) rmSync(dir, { recursive: true, force: true });
});

function scratch(profile = mkdtempSync("/private/var/tmp/passwords-test-")) {
  profiles.push(profile);
  const clock = handClock();
  return { p: new ApplePasswords({ profile, timers: clock.timers }), profile, clock };
}

async function paired(p: ApplePasswords, helper = appleHelper()) {
  const kept = bridgeTo(p, helper);
  await p.pair();
  await p.unlock(CODE);
  return { helper, kept };
}

// The Safari tab: a page whose sign-in form (in the top page, or in an
// embedded frame from another site, as Apple's is) records what was typed.
// Its change-password form has an empty current-password field and two
// new-password fields, which allow form.maxLength characters when given.
// As in the content script, a fill lands only when sent to the frame that
// holds the form, for the site that frame is on. A form that submits itself
// once filled takes the page away before it can answer, so the extension
// answers where the page went instead (act in background.js).
function fakeTab(url: string, form: { frame: number; url: string; maxLength?: number } = { frame: 0, url }, navigated?: { url: string; title: string }) {
  const page: { username?: string; password?: string; code?: string; current?: string; fresh?: string } = {};
  connect({
    send(data: string) {
      const { id, op: outer, args } = JSON.parse(data);
      const answer = (reply: { value: unknown } | { error: string }) => queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
      if (outer === "probe") {
        const holds = args[1] === "login" ? { username: true, password: true }
          : args[1] === "change" ? { fresh: 2, current: "empty", ...(form.maxLength ? { maxLength: form.maxLength } : {}) }
          : { found: true };
        const frames = [{ frame: 0, origin: new URL(url).origin }, { frame: form.frame, origin: new URL(form.url).origin, ...holds }];
        return answer({ value: form.frame ? frames : [frames[1]] });
      }
      const [, op, opArgs, , frame] = args;
      if (frame !== form.frame || opArgs[0] !== new URL(form.url).hostname) return answer({ error: "nothing was filled" });
      if (op === "fillLogin") Object.assign(page, { username: opArgs[1], password: opArgs[2] });
      if (op === "fillCode") Object.assign(page, { code: opArgs[1] });
      if (op === "fillNewPassword") Object.assign(page, { current: opArgs[1], fresh: opArgs[2] });
      const filled = op === "fillCode" ? ["code"] : op === "fillNewPassword" ? ["current password", "new password", "confirm password"] : ["username", "password"];
      answer({ value: navigated ? { ok: true, navigated } : { ok: true, filled } });
    },
    close() {},
  });
  return page;
}

const locked = (call: Promise<unknown>) => call.then(() => "no error", (e: Error) => e.message);

test("the code on the Mac unlocks, and fill types the password into the page but never returns it", async () => {
  const { p } = scratch();
  const page = fakeTab(`https://${SITE}/signin`);
  bridgeTo(p, appleHelper());
  await p.pair();
  expect(await p.unlock(CODE)).toEqual({ unlocked: true });
  const result = await p.fill(7);
  expect(page).toEqual({ username: USER, password: SECRET });
  expect(result).toEqual({ filled: ["username", "password"], username: USER, site: SITE });
  expect(JSON.stringify(await p.loginsFor(7))).not.toContain(SECRET);
});

// On 09-28 a fill waited on Touch ID past the agent's 60 s call, so the
// agent never read why, and every call after it read "did not answer".
test("a fill waiting on Touch ID answers before the agent's call ends, and the same call once he approves returns the filled form", async () => {
  const { p, clock } = scratch();
  const page = fakeTab(`https://${SITE}/signin`);
  const hold = touchId();
  bridgeTo(p, appleHelper(), { hold });
  await runAs(AGENT, async () => {
    await p.pair();
    await p.unlock(CODE);
  });
  const answering = clock.armed();
  const first = runAs(AGENT, () => p.fill(7));
  await answering;
  clock.runOut();
  expect(await locked(first)).toStartWith(`the Mac is asking the user to approve a sign-in for ${SITE} with Touch ID`);
  expect(page).toEqual({});
  hold.approve();
  expect(await runAs(AGENT, () => p.fill(7))).toEqual({ filled: ["username", "password"], username: USER, site: SITE });
  expect(page).toEqual({ username: USER, password: SECRET });
});

test("while the Mac waits on Touch ID, status and every other password call say what it waits on, at once", async () => {
  const { p } = scratch();
  fakeTab(`https://${SITE}/signin`);
  const hold = touchId();
  bridgeTo(p, appleHelper(), { hold });
  await runAs(AGENT, async () => {
    await p.pair();
    await p.unlock(CODE);
  });
  void locked(runAs(AGENT, () => p.fill(7)));
  await hold.asked;
  const { waiting = "nothing" } = (await runAs(AGENT, () => p.status())) as { waiting?: string };
  expect(waiting).toStartWith(`a sign-in for ${SITE}, since `);
  const waits = `Apple's password helper is waiting for the user to approve a sign-in for ${SITE} with Touch ID`;
  expect(await locked(runAs(AGENT, () => p.loginsFor(7)))).toStartWith(waits);
  expect(await locked(runAs(AGENT, () => p.fillCode(7)))).toStartWith(waits);
  expect(await locked(runAs(AGENT, () => p.pair()))).toStartWith(waits);
});

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => new Promise<void>((r) => setImmediate(r));

// A first call on the locked vault, as the caller runs it (pair.ts): the
// daemon stays locked until unlock gets the code the Mac showed, the code
// is read off the Mac's window, and the Touch ID prompt waits until the
// test approves. The clock is the test's.
function lockedVault() {
  process.env.SAFARI_HARNESS_AWAY = "0";
  jest.useFakeTimers();
  let unlocked = false;
  spyOn(daemonRpc, "rpc").mockImplementation(async (_tool: string, args: Record<string, unknown> = {}) => {
    if (args.do === "status") return { unlocked };
    if (args.do === "pair") return { codeShown: true, helper: 4242 };
    if (args.do === "unlock") {
      unlocked = args.code === CODE;
      return { unlocked };
    }
    if (!unlocked) throw new Error("Apple Passwords is locked: never paired since the hidden helper started");
    return { site: SITE, usernames: [USER] };
  });
  spyOn(pair, "readCode").mockResolvedValue(CODE);
  const touch = Promise.withResolvers<Record<string, unknown> | undefined>();
  return { prompts: spyOn(pair, "approve").mockReturnValue(touch.promise), approve: () => touch.resolve({ approved: true }) };
}

// After every test: the spies, the clock, the CLI switch, and the away flag go back.
const away = process.env.SAFARI_HARNESS_AWAY;
afterEach(() => {
  mock.restore();
  jest.useRealTimers();
  pair.waitPairingOut(false);
  if (away === undefined) delete process.env.SAFARI_HARNESS_AWAY;
  else process.env.SAFARI_HARNESS_AWAY = away;
});

// On 09-29 a first call that found the vault locked waited 44 s for Touch
// ID and 13 s more for the code, and answered at 58 s: through MCP, 2 s
// more and the agent's call would have ended with no answer.
test("through MCP, a first call on the locked vault answers at 40 s with what the Mac waits on, and the next call gets the pairing he then approves, with no second prompt", async () => {
  const vault = lockedVault();
  let first: unknown;
  void FILL_TOOLS.passwords.run({ do: "logins" }).then((answer) => {
    first = answer;
  });
  await settled();
  jest.advanceTimersByTime(40_000);
  await settled();
  expect(first).toEqual({ paired: false, why: expect.stringContaining("Touch ID") });
  const second = FILL_TOOLS.passwords.run({ do: "logins" });
  await settled();
  vault.approve();
  expect(await second).toEqual({ site: SITE, usernames: [USER] });
  expect(vault.prompts).toHaveBeenCalledTimes(1);
});

// The CLI's process ends with its answer, and the prompt with it: an answer
// at 40 s there took down the prompt he was about to approve.
test("from the CLI, a first call on the locked vault waits the pairing out: he approves at 45 s and it returns the logins", async () => {
  pair.waitPairingOut();
  const vault = lockedVault();
  const call = FILL_TOOLS.passwords.run({ do: "logins" });
  await settled();
  jest.advanceTimersByTime(45_000);
  await settled();
  vault.approve();
  expect(await call).toEqual({ site: SITE, usernames: [USER] });
});

test("code types the site's verification code into the page but never returns it", async () => {
  const { p } = scratch();
  const page = fakeTab(`https://${SITE}/verify`);
  await paired(p);
  const result = await p.fillCode(7);
  expect(page).toEqual({ code: OTP });
  expect(result).toEqual({ filled: ["code"], username: USER, site: SITE });
});

// The new password must be the one Apple Passwords keeps: a page given one
// password while another is saved locks the user out of his account. So
// nothing is typed until the caller has confirmed the save.
test("change saves a new password and types nothing; typeChange then types the saved one into the current field and the new one into the others, and fill types the new one", async () => {
  const { p } = scratch();
  const page = fakeTab(`https://${SITE}/account/password`);
  await paired(p);
  expect(await p.change(7)).toMatchObject({ username: USER, site: SITE });
  expect(page.fresh).toBeUndefined();
  expect(await p.typeChange(7)).toEqual({ filled: ["current password", "new password", "confirm password"], username: USER, site: SITE, saved: true });
  expect(page.current).toBe(SECRET);
  expect(page.fresh).not.toBe(SECRET);
  await p.fill(7);
  expect(page.password).toBe(page.fresh);
});

// One uppercase letter and one digit, the rest lowercase: Safari's shape,
// which sites that ask for mixed characters take.
test.each([
  ["no length limit, three hyphenated groups of six", undefined, /^(?=[^A-Z]*[A-Z][^A-Z]*$)(?=\D*\d\D*$)[a-zA-Z\d]{6}-[a-zA-Z\d]{6}-[a-zA-Z\d]{6}$/],
  ["a 16-character limit, 16 characters", 16, /^(?=[^A-Z]*[A-Z][^A-Z]*$)(?=\D*\d\D*$)[a-zA-Z\d]{16}$/],
])("change on a form with %s makes a password of that shape", async (_, maxLength, shape) => {
  const { p } = scratch();
  const url = `https://${SITE}/account/password`;
  const page = fakeTab(url, { frame: 0, url, maxLength });
  await paired(p);
  await p.change(7);
  await p.typeChange(7);
  expect(page.fresh).toMatch(shape);
});

const HOME = { url: `https://${SITE}/home`, title: "Home" };

test("a login form that submits itself as it is filled reports the fields filled and where the page went", async () => {
  const { p } = scratch();
  const page = fakeTab(`https://${SITE}/signin`, undefined, HOME);
  await paired(p);
  expect(await p.fill(7)).toEqual({ filled: ["username", "password"], navigated: HOME, username: USER, site: SITE });
  expect(page).toEqual({ username: USER, password: SECRET });
});

test("a code field that submits itself as it is filled reports the code filled and where the page went", async () => {
  const { p } = scratch();
  const page = fakeTab(`https://${SITE}/verify`, undefined, HOME);
  await paired(p);
  expect(await p.fillCode(7)).toEqual({ filled: ["code"], navigated: HOME, username: USER, site: SITE });
  expect(page).toEqual({ code: OTP });
});

test("a wrong code is refused and cannot be retried with the right one", async () => {
  const { p } = scratch();
  fakeTab(`https://${SITE}/signin`);
  bridgeTo(p, appleHelper());
  await p.pair();
  await expect(p.unlock("000000")).rejects.toThrow("wrong code");
  await expect(p.unlock(CODE)).rejects.toThrow("no code is waiting");
  await expect(p.fill(7)).rejects.toThrow("locked");
});

test("fill on a page that is not https asks the helper for nothing", async () => {
  const { p } = scratch();
  const page = fakeTab(`http://${SITE}/signin`);
  const { helper } = await paired(p);
  await expect(p.fill(7)).rejects.toThrow("https");
  expect(helper.queries).toEqual([]);
  expect(page).toEqual({});
});

// Apple's sign-in form on appstoreconnect.apple.com is a frame from
// idmsa.apple.com: what is saved for the frame's site goes into that frame.
test("a sign-in form in an embedded frame gets the login and code saved for the frame's own site", async () => {
  const { p } = scratch();
  const page = fakeTab("https://appstoreconnect.apple.com/login", { frame: 5031, url: "https://idmsa.apple.com/appleauth/auth/signin" });
  const { helper } = await paired(p);
  expect(await p.fill(7)).toEqual({ filled: ["username", "password"], username: USER, site: "idmsa.apple.com" });
  expect(await p.fillCode(7)).toEqual({ filled: ["code"], username: USER, site: "idmsa.apple.com" });
  expect(page).toEqual({ username: USER, password: SECRET, code: OTP });
  expect(helper.queries.map((q) => q.split(" ")[1])).toEqual(["idmsa.apple.com", "idmsa.apple.com", "idmsa.apple.com"]);
});

test("a helper restart ends the pairing, and the locked call says why and to pair now", async () => {
  const { p } = scratch();
  fakeTab(`https://${SITE}/signin`);
  await paired(p);
  bridgeTo(p, appleHelper()); // Helium relaunched: its helper is a new process
  const { unlocked, reason = "no reason" } = await p.status();
  expect(unlocked).toBe(false);
  expect(reason).toContain("restarted at");
  const error = await locked(p.fill(7));
  expect(error).toContain(reason);
  expect(error).toContain('{do: "pair"}');
});

test("another session's done never ends my access", async () => {
  const { p, clock } = scratch();
  fakeTab(`https://${SITE}/signin`);
  await runAs(AGENT, () => paired(p));
  await runAs(OTHER, () => p.loginsFor(7));
  expect(await runAs(OTHER, () => p.done())).toMatchObject({ released: true, unlocked: true, sessions: 1 });
  expect(await runAs(OTHER, () => p.done())).toMatchObject({ released: false, unlocked: true, sessions: 1 });
  expect(clock.live()).toBe(0);
  expect(await runAs(AGENT, () => p.loginsFor(7))).toEqual({ site: SITE, usernames: [USER] });
});

test("after the last session is done, the pairing ends when the grace runs out, and Helium's bridge is let go", async () => {
  const { p, profile, clock } = scratch();
  fakeTab(`https://${SITE}/signin`);
  const { kept } = await runAs(AGENT, () => paired(p));
  expect(existsSync(join(profile, "harness-session.key"))).toBe(true);
  const done = await runAs(AGENT, () => p.done());
  expect(done).toMatchObject({ released: true, unlocked: true, sessions: 0, ends: expect.stringMatching(/^at /) });
  clock.runOut();
  const { unlocked, reason = "no reason" } = await p.status();
  expect(unlocked).toBe(false);
  expect(reason).toContain("every session using it was done");
  expect(kept).toEqual({ stash: null, closed: true });
  expect(existsSync(join(profile, "harness-session.key"))).toBe(false);
  expect(await locked(runAs(AGENT, () => p.loginsFor(7)))).toContain(reason);
});

test("a session that comes back within the grace keeps the pairing", async () => {
  const { p, clock } = scratch();
  fakeTab(`https://${SITE}/signin`);
  await runAs(AGENT, () => paired(p));
  await runAs(AGENT, () => p.done());
  await runAs(OTHER, () => p.loginsFor(7));
  clock.runOut();
  expect(await p.status()).toMatchObject({ unlocked: true, sessions: 1 });
});

test("a call from no agent session holds nothing, so the grace still runs out", async () => {
  const { p, clock } = scratch();
  fakeTab(`https://${SITE}/signin`);
  await paired(p);
  await p.loginsFor(7);
  expect(await p.status()).toMatchObject({ unlocked: true, sessions: 0 });
  clock.runOut();
  expect((await p.status()).unlocked).toBe(false);
});

test("a session that exits lets go of the pairing", async () => {
  const { p, clock } = scratch();
  fakeTab(`https://${SITE}/signin`);
  const agent = spawn("sleep", ["60"]);
  const pid = agent.pid ?? 0;
  await runAs(pid, () => paired(p));
  expect(await p.status()).toMatchObject({ unlocked: true, sessions: 1 });
  const released = clock.armed();
  agent.kill();
  await released;
  expect(await p.status()).toMatchObject({ unlocked: true, sessions: 0, ends: expect.stringMatching(/^at /) });
});

test("a restart hands the pairing and its sessions to the next daemon, which proves it before it says unlocked", async () => {
  const first = scratch();
  const page = fakeTab(`https://${SITE}/signin`);
  const helper = appleHelper();
  const { kept } = await runAs(AGENT, () => paired(first.p, helper));
  first.p.shutdown();
  const next = scratch(first.profile);
  bridgeTo(next.p, helper, { running: true, stash: kept.stash });
  expect(await next.p.status()).toMatchObject({ unlocked: true, sessions: 1 });
  expect(helper.queries).toEqual(["4 example.com"]);
  expect(await runAs(OTHER, () => next.p.fill(7))).toMatchObject({ username: USER, site: SITE });
  expect(page).toEqual({ username: USER, password: SECRET });
  expect(await runAs(AGENT, () => next.p.done())).toMatchObject({ released: true, sessions: 1 });
});

test("a handed-back session the helper no longer answers, or with no key to open it, stays locked", async () => {
  const first = scratch();
  fakeTab(`https://${SITE}/signin`);
  const { kept } = await paired(first.p);
  first.p.shutdown();
  const forgot = scratch(first.profile);
  bridgeTo(forgot.p, appleHelper(), { running: true, stash: kept.stash });
  expect(await forgot.p.status()).toMatchObject({ unlocked: false, reason: expect.stringContaining("did not survive") });

  const again = scratch();
  const { kept: kept2 } = await paired(again.p);
  again.p.shutdown();
  rmSync(join(again.profile, "harness-session.key"));
  const keyless = scratch(again.profile);
  bridgeTo(keyless.p, appleHelper(), { running: true, stash: kept2.stash });
  expect(await keyless.p.status()).toMatchObject({ unlocked: false, reason: expect.stringContaining("could not open") });
});

test("Apple Passwords turning off or asking to sign in again ends the pairing, and the locked call says which", async () => {
  for (const [cmd, why] of [[9, "turned off"], [10, "sign in again"]] as const) {
    const { p } = scratch();
    fakeTab(`https://${SITE}/signin`);
    await paired(p);
    p.handleMessage(JSON.stringify({ helper: { cmd } }));
    expect(await locked(p.loginsFor(7))).toContain(why);
  }
});

test("the helper's first start reads as never paired, not as a restart", async () => {
  const { p } = scratch();
  bridgeTo(p, appleHelper());
  expect(await p.status()).toEqual({ unlocked: false, reason: expect.stringContaining("not been paired since") });
});

// Helium's defaults ran 8 processes (about 320 MB) for the hidden bridge.
// The bridge dials in once Helium is up, and the count holds from then on.
test.skipIf(!existsSync(HELIUM))("the hidden Helium runs in at most 4 processes", async () => {
  const profile = mkdtempSync("/private/var/tmp/passwords-helium-");
  profiles.push(profile);
  const dialed = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("", { status: 400 })),
    websocket: { open: () => dialed.resolve(), message() {} },
  });
  try {
    launchHelium(profile, Number(server.url.port));
    await dialed.promise;
    const processes = Bun.spawnSync(["ps", "-A", "-ww", "-o", "command="]).stdout.toString().split("\n").filter((l) => l.includes(profile));
    expect(processes.length).toBeLessThanOrEqual(4);
  } finally {
    await quitHelium(profile);
    server.stop(true);
  }
}, 30000);

// A profile keeps the service worker of the bridge it last ran, and Helium
// starts that cached copy over the files in the profile. After the bridge
// changed, the old one dialed in and never said hello, so every sign-in
// waited out the link and failed. A new Helium must run this release's
// bridge, whatever an earlier one left in its profile. The old copy never
// says hello, so the test's own timeout is the failure.
test.skipIf(!existsSync(HELIUM))("a new Helium runs this release's bridge, not the one its profile ran before", async () => {
  const profile = mkdtempSync("/private/var/tmp/passwords-helium-");
  profiles.push(profile);
  const dialed = Promise.withResolvers<void>();
  const hello = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("", { status: 400 })),
    websocket: {
      open: () => dialed.resolve(),
      message: (_ws, m) => {
        if ("hello" in JSON.parse(String(m))) hello.resolve();
      },
    },
  });
  const port = Number(server.url.port);
  try {
    // An earlier release's bridge, under the same extension id: it dials in
    // and says nothing.
    const old = join(profile, "bridge");
    mkdirSync(old, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "passwords-bridge", "manifest.json"), "utf8"));
    writeFileSync(join(old, "manifest.json"), JSON.stringify({ ...manifest, version: "0.9.0" }));
    writeFileSync(join(old, "port.json"), JSON.stringify({ port }));
    writeFileSync(join(old, "bridge.js"), `fetch(chrome.runtime.getURL("port.json")).then((r) => r.json()).then(({ port }) => { self.ws = new WebSocket("ws://127.0.0.1:" + port + "/passwords"); });`);
    spawn(HELIUM, [`--user-data-dir=${profile}`, "--headless=new", `--load-extension=${old}`, "--no-first-run", "--disable-features=DisableLoadExtensionCommandLineSwitch"], { stdio: "ignore" });
    await dialed.promise;
    await quitHelium(profile);

    launchHelium(profile, port);
    await hello.promise;
  } finally {
    await quitHelium(profile);
    server.stop(true);
  }
}, 30000);

// The one-touch pairing reads the code off the helper's window; this
// stands in a window like it (off screen, invisible, never in front).
const PAIRING = join(import.meta.dir, "..", "scripts", "pairing");
const trusted = existsSync(PAIRING) && dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", { AXIsProcessTrusted: { returns: FFIType.bool } }).symbols.AXIsProcessTrusted();
const STAND_IN = `ObjC.import("Cocoa");
function run(argv) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  const w = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(-4000, -4000, 480, 238), $.NSWindowStyleMaskTitled, $.NSBackingStoreBuffered, false);
  w.title = "Verification Code";
  w.alphaValue = 0;
  argv.forEach((text, i) => {
    const label = $.NSTextField.labelWithString(text);
    label.frame = $.NSMakeRect(20, 180 - 50 * i, 440, 40);
    w.contentView.addSubview(label);
  });
  w.orderFrontRegardless;
  console.log("ready");
  app.run;
}`;

// Shows the texts in a stand-in window and reads it as the pairing does.
async function readCode(...shown: string[]): Promise<{ code?: string; error?: string }> {
  const window = Bun.spawn(["osascript", "-l", "JavaScript", "-e", STAND_IN, ...shown], { stderr: "pipe" });
  try {
    const said = window.stderr.getReader();
    for (let seen = ""; !seen.includes("ready"); ) {
      const { value, done } = await said.read();
      if (done) throw new Error(`the stand-in window did not open: ${seen}`);
      seen += new TextDecoder().decode(value);
    }
    const reader = Bun.spawn([PAIRING, "code", "--pid", String(window.pid), "--wait", "2000"], { stdout: "pipe", stderr: "pipe" });
    const [out, err, status] = await Promise.all([new Response(reader.stdout).text(), new Response(reader.stderr).text(), reader.exited]);
    return status === 0 ? JSON.parse(out) : { error: err.trim() };
  } finally {
    window.kill();
  }
}

test.skipIf(!trusted)("the pairing code is read off the helper's window, spaced as the Mac shows it", async () => {
  expect(await readCode("Enter this code in your browser to use Passwords.", "4 8 2   9 1 3")).toEqual({ code: "482913" });
}, 10000);

// Digits in a sentence, or too few, are not the code.
test.skipIf(!trusted)("a window without a six-digit code gives no code", async () => {
  expect(await readCode("Too many tries. Try again in 300000 seconds.", "4 8 2   9 1")).toEqual({ error: expect.stringContaining("no pairing code showed") });
}, 10000);
