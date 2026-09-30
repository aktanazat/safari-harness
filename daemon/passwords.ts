// Apple Passwords: logins from the user's iCloud Keychain, filled into a
// Safari tab without the password ever reaching the agent.
//
// macOS starts Apple's password helper only under an approved browser, and
// the helper answers only Apple's own Chrome extension id. So a hidden Helium
// (an approved Chromium) runs passwords-bridge/, an extension that carries
// Apple's public key and relays helper messages to this daemon over
// ws /passwords. The daemon does the pairing and all encryption; the bridge
// sees only ciphertext.
//
// Pairing is SRP-6a (RFC 5054, 3072-bit group, SHA-256) with the 6-digit code
// macOS shows as the password; the session key then encrypts every query with
// AES-GCM. The pairing lives as long as the helper process. Helium runs in a
// session of its own, so a daemon restart or deploy leaves it and the helper
// running: the bridge dials the new daemon and hands back the session the
// last one left in its keeping, sealed with a key kept in a file only this
// user can read, and the new daemon proves the session with a query before
// it reports unlocked.
//
// Each agent session that uses the pairing holds it until it calls done or
// exits; five minutes after the last one lets go, the pairing ends and Helium
// quits. Each time the pairing ends, the reason is kept for status and for
// the error a locked call gets.
//
// Protocol follows open-passwords (Apache-2.0), itself derived from
// au2001/icloud-passwords-firefox.

import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridge, DEFAULT_PORT } from "./bridge.ts";
import { currentOwner, watchOwner } from "./owner.ts";
import { filledOf, type Navigated } from "./navigated.ts";

export const BRIDGE_ORIGIN = "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj";
export const HELIUM = "/Applications/Helium.app/Contents/MacOS/Helium";
const HELPER = "/System/Cryptexes/App/System/Library/CoreServices/PasswordManagerBrowserExtensionHelper.app/Contents/MacOS/PasswordManagerBrowserExtensionHelper";
const BRIDGE_SRC = join(import.meta.dir, "..", "passwords-bridge");
const PAIRING = join(import.meta.dir, "..", "scripts", "pairing");
// Opens the session the bridge keeps; lives in the Helium profile.
const KEY_FILE = "harness-session.key";
// How long the pairing outlasts the last session holding it.
const GRACE_MIN = 5;
// The Helium the last daemon left running redials within a second of this
// one starting; a new Helium's bridge says hello within a second or two.
const ADOPT_MS = 3000;
const LINK_MS = 20000;
// macOS asks the user for Touch ID before the helper hands out a password
// or a code, and the helper answers nothing else until he acts: on 09-28 a
// fill outlasted the agent's 60 s call, and every call for four minutes
// after read "did not answer". So a call answers within ANSWER_MS, the
// request goes on, and its answer waits for the call that asks again.
// A first call that pairs keeps the same bound (pair.ts).
export const ANSWER_MS = 40000;
// A password kept for that call lasts while the agent asks him and he
// answers; a code changes every 30 s.
const KEEP_PASSWORD_MS = 5 * 60_000;
const KEEP_CODE_MS = 20000;
// How long a changed password waits for its save to be confirmed.
const CHANGE_MS = 60_000;
// A handed-back session is proved by any query the helper answers under it.
const PROOF_HOST = "example.com";

// The daemon on the harness's own port keeps the profile it always had; a
// scratch daemon on another port gets its own, and never touches that one.
export function heliumProfile(port: number): string {
  return join(homedir(), "Library", "Application Support", "Safari Harness", port === DEFAULT_PORT ? "passwords-helium" : `passwords-helium-${port}`);
}

// ---------- SRP ----------

const N = BigInt(
  "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const N_BYTES = 384;
const G = 5n;

function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = ((base % m) + m) % m;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
  }
  return result;
}

// Minimal big-endian, as A, B, and S go on the wire and into hashes.
function toBytes(n: bigint): Buffer {
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
}

function fromBytes(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt(`0x${Buffer.from(b).toString("hex")}`);
}

function pad(b: Uint8Array, len: number): Buffer {
  const out = Buffer.alloc(len);
  Buffer.from(b).copy(out, len - b.length);
  return out;
}

function sha(...parts: (Uint8Array | string)[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

// k = H(N, PAD(g)) and H(N) xor H(PAD(g)), fixed by the group.
const K_MULT = fromBytes(sha(toBytes(N), pad(toBytes(G), N_BYTES)));
const H_NG = Buffer.from(sha(toBytes(N)).map((v, i) => v ^ sha(pad(toBytes(G), N_BYTES))[i]));

// Binary fields travel as base64; older helpers used hex and are not spoken.
type Challenge = { user: string; a: bigint; A: Buffer; B: Buffer; salt: Buffer };
type Session = { user: string; key: Buffer };

type State =
  | { kind: "idle" }
  | { kind: "challenged"; challenge: Challenge }
  | { kind: "unlocked"; session: Session };

// "Sep 28, 8:40 PM": when a pairing ended, in the Mac's own time zone.
export function localTime(at = new Date()): string {
  return at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// M goes to the helper; the helper must answer with HAMK; K is the shared key.
function prove(c: Challenge, code: string): { M: Buffer; HAMK: Buffer; K: Buffer } {
  const u = fromBytes(sha(pad(c.A, N_BYTES), pad(c.B, N_BYTES)));
  const x = fromBytes(sha(c.salt, sha(`${c.user}:${code}`)));
  const base = (((fromBytes(c.B) - ((K_MULT * modpow(G, x, N)) % N)) % N) + N) % N;
  const K = sha(toBytes(modpow(base, c.a + u * x, N)));
  const M = sha(H_NG, sha(c.user), c.salt, c.A, c.B, K);
  return { M, HAMK: sha(c.A, M, K), K };
}

// Outbound is ciphertext+tag then the 16-byte iv; inbound is iv first.
function seal(key: Buffer, obj: unknown): Buffer {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-gcm", key.subarray(0, 16), iv);
  return Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag(), iv]);
}

function open(key: Buffer, data: Buffer): unknown {
  const d = createDecipheriv("aes-128-gcm", key.subarray(0, 16), data.subarray(0, 16));
  d.setAuthTag(data.subarray(data.length - 16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(16, data.length - 16)), d.final()]).toString("utf8"));
}

// ---------- helper link ----------

const Cmd = { HANDSHAKE: 2, LOGIN_NAMES: 4, PASSWORD: 5, SAVE: 6, DISABLED: 9, RELOGIN: 10, SET_UP_CODE: 13, CAPABILITIES: 14, ONE_TIME_CODE: 17 } as const;
const STATUS_OK = 0;
const STATUS_NONE = 3;

export type HelperLink = { send(data: string): void; close(): void };
type HelperMsg = Record<string, unknown> & { cmd?: number };
type Waiter = { cmd: number; resolve: (m: HelperMsg) => void; reject: (e: Error) => void };
// What the bridge says as it connects: whether its helper, and so any
// pairing, still runs, and the sealed session it keeps.
type Hello = { helper?: unknown; stash?: unknown };
type Status = { unlocked: boolean; reason?: string; sessions?: number; ends?: string; waiting?: string; helper?: number };
// A request the Mac holds until the user approves it with Touch ID: what it
// is for, the call that gets its answer, and how long an answer that lands
// after that call gave up is kept for the next.
type Ask = { key: string; what: string; again: string; keepMs: number };
type Approval = Ask & { since: number; reply: Promise<Record<string, unknown>>; landed: boolean; gaveUp: boolean; drop?: () => void };

// A pairing message from the helper: base64 JSON under payload.PAKE.
function pakeOf(reply: HelperMsg): Record<string, unknown> {
  const p = reply.payload;
  const pake = p && typeof p === "object" && "PAKE" in p ? p.PAKE : undefined;
  if (typeof pake !== "string") throw new Error("the helper sent no pairing data");
  return JSON.parse(Buffer.from(pake, "base64").toString("utf8"));
}

// Whether p resolves within ms; its rejection throws.
export async function within(p: Promise<unknown>, ms: number, timers = REAL_TIMERS): Promise<boolean> {
  let cancel = () => {};
  const late = new Promise<boolean>((resolve) => {
    cancel = timers.after(ms, () => resolve(false));
  });
  try {
    return await Promise.race([p.then(() => true), late]);
  } finally {
    cancel();
  }
}

// The grace period's timer, and the clock that says when it runs out.
export type Timers = { after(ms: number, fn: () => void): () => void; now(): number };

const REAL_TIMERS: Timers = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  },
  now: () => Date.now(),
};

// ---------- the session the bridge keeps ----------

// What the next daemon needs to go on: the session, and the agent sessions
// holding it.
type Kept = Session & { holders: number[] };

// AES-256-GCM, iv first. The sealed session lives only in the bridge, and
// the key that opens it only in a file this user alone can read.
function sealKept(key: Buffer, kept: Kept): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const text = JSON.stringify({ user: kept.user, key: kept.key.toString("base64"), holders: kept.holders });
  return Buffer.concat([iv, c.update(text, "utf8"), c.final(), c.getAuthTag()]).toString("base64");
}

function openKept(key: Buffer, sealed: string): Kept {
  const data = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  d.setAuthTag(data.subarray(data.length - 16));
  const k = JSON.parse(Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]).toString("utf8")) as { user: string; key: string; holders: number[] };
  return { user: k.user, key: Buffer.from(k.key, "base64"), holders: k.holders };
}

// ---------- strong passwords ----------

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
// The fewest characters a made password has; a form that allows fewer is
// refused rather than given a weak one.
const MIN_MADE = 8;

// Safari's strong-password shape: 18 lowercase letters, one of them made an
// uppercase letter and another a digit, in three groups of six joined by
// hyphens (xxxxxx-xxxxxx-xxxxxx), 20 characters. A form whose new-password
// fields allow fewer gets as many as they allow, without hyphens. Each draw
// is uniform (randomInt), so no character is likelier than another.
function strongPassword(maxLength?: number): string {
  const grouped = maxLength === undefined || maxLength >= 20;
  const n = grouped ? 18 : maxLength;
  if (n < MIN_MADE) throw new Error(`the new-password field takes at most ${n} characters, too few for a strong password`);
  const chars = Array.from({ length: n }, () => LOWER[randomInt(LOWER.length)]);
  const upper = randomInt(n);
  const digit = (upper + 1 + randomInt(n - 1)) % n;
  chars[upper] = UPPER[randomInt(UPPER.length)];
  chars[digit] = DIGITS[randomInt(DIGITS.length)];
  return grouped ? [0, 6, 12].map((i) => chars.slice(i, i + 6).join("")).join("-") : chars.join("");
}

export class ApplePasswords {
  private readonly port: number;
  private readonly profile: string;
  private readonly keyFile: string;
  private readonly timers: Timers;
  private link: HelperLink | null = null;
  // A link carries calls once its bridge has said hello and any session it
  // handed back has been proved.
  private greeted = false;
  private linked: PromiseWithResolvers<void> | null = null;
  private quitting: Promise<void> | null = null;
  private state: State = { kind: "idle" };
  // Why there is no pairing, in plain words.
  private why = `it has not been paired since the harness started at ${localTime()}`;
  private helperSeen = false;
  private waiter: Waiter | null = null;
  // The request waiting on Touch ID, or its answer kept for the next call.
  private approval: Approval | null = null;
  // Changed passwords saved but not yet typed, by tab, until typeChange or
  // CHANGE_MS: agents changing several sites at once each keep their own.
  private pendingChanges = new Map<number, { frame: number; fresh: number; host: string; site: string; login: string; current: string | null; secret: string; drop: () => void }>();
  // Replies carry no request id, so one request at a time.
  private queue: Promise<unknown> = Promise.resolve();
  // Agent sessions holding the pairing, by pid, each with its exit watch.
  private holders = new Map<number, () => void>();
  // Counts down while no session holds the pairing.
  private grace: { ends: number; cancel: () => void } | null = null;
  // Seals the session the bridge keeps; the key file holds the same key.
  private stashKey: Buffer | null = null;

  constructor({ port = Number(process.env.SAFARI_HARNESS_WS ?? DEFAULT_PORT), profile = heliumProfile(port), timers = REAL_TIMERS }: { port?: number; profile?: string; timers?: Timers } = {}) {
    this.port = port;
    this.profile = profile;
    this.keyFile = join(profile, KEY_FILE);
    this.timers = timers;
  }

  // A bridge dialed in: a new Helium's, or that of the Helium the last
  // daemon left running. Calls wait for its hello.
  attach(link: HelperLink) {
    if (this.link && this.link !== link) {
      this.link.close();
      this.fail(new Error("the Helium password bridge reconnected"));
    }
    this.link = link;
    this.greeted = false;
  }

  // The key file stays: a bridge that dials back with its helper still
  // running hands the pairing back.
  detach(link: HelperLink) {
    if (this.link !== link) return;
    this.link = null;
    this.greeted = false;
    this.state = { kind: "idle" };
    this.why = `the hidden Helium disconnected at ${localTime()}`;
    this.fail(new Error("the Helium password bridge disconnected"));
  }

  handleMessage(raw: string) {
    let msg: { hello?: Hello; helper?: HelperMsg; closed?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.hello) {
      this.greet(msg.hello).catch((e) => console.error("[safari-harness] the password bridge's hello failed:", e));
      return;
    }
    if (msg.closed !== undefined) {
      this.reset(`Apple's password helper stopped at ${localTime()} (${msg.closed})`);
      this.fail(new Error(`Apple's password helper closed: ${msg.closed}`));
      return;
    }
    const m = msg.helper;
    if (!m) return;
    if (m.cmd === Cmd.DISABLED) this.reset(`Apple Passwords was turned off on this Mac at ${localTime()}`);
    if (m.cmd === Cmd.RELOGIN) this.reset(`Apple Passwords asked to sign in again at ${localTime()}`);
    if (this.waiter && m.cmd === this.waiter.cmd) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(m);
    }
  }

  // A bridge without its helper brings a new helper, which knows no
  // pairing. One whose helper still runs keeps this daemon's pairing, or
  // hands back the session it kept for the daemon before.
  private async greet(hello: Hello) {
    const link = this.link;
    if (!link) return;
    if (hello.helper !== true) {
      this.reset(this.helperSeen ? `Apple's password helper restarted at ${localTime()}` : `it has not been paired since Apple's password helper started at ${localTime()}`);
    } else if (this.state.kind === "idle" && typeof hello.stash === "string") {
      await this.takeOver(link, hello.stash);
    }
    if (this.link !== link) return;
    this.helperSeen = true;
    if (this.holders.size === 0 && !this.grace) this.startGrace();
    this.greeted = true;
    this.linked?.resolve();
    this.linked = null;
  }

  // The session the bridge kept for the daemon before: opened with the key
  // file, and taken over once a query under it comes back.
  private async takeOver(link: HelperLink, stash: string) {
    let key: Buffer;
    let kept: Kept;
    try {
      key = readFileSync(this.keyFile);
      kept = openKept(key, stash);
    } catch {
      this.reset(`the harness restarted at ${localTime()} and could not open the pairing it kept`);
      return;
    }
    const session = { user: kept.user, key: kept.key };
    try {
      await this.query(link, session, Cmd.LOGIN_NAMES, "CmdGetLoginNames4URL", PROOF_HOST, { ACT: 5, URL: PROOF_HOST }, 10000);
    } catch {
      if (this.link === link) this.reset(`the pairing did not survive the harness restart at ${localTime()}`);
      return;
    }
    if (this.link !== link) return;
    this.state = { kind: "unlocked", session };
    this.stashKey = key;
    for (const pid of kept.holders) this.hold(pid);
  }

  // The pairing is over: the bridge forgets the session it kept, and the
  // key that opens it goes too.
  private reset(why: string) {
    this.state = { kind: "idle" };
    this.why = why;
    this.stashKey = null;
    this.approval = null;
    rmSync(this.keyFile, { force: true });
    this.link?.send(JSON.stringify({ stash: null }));
  }

  // Seals the session, and who holds it, into the bridge's keeping for the
  // next daemon. Each pairing gets a key of its own, written whole and
  // readable by this user alone.
  private sendStash() {
    if (this.state.kind !== "unlocked" || !this.link) return;
    if (!this.stashKey) {
      const key = randomBytes(32);
      const next = `${this.keyFile}.next`;
      mkdirSync(this.profile, { recursive: true });
      rmSync(next, { force: true });
      writeFileSync(next, key, { mode: 0o600 });
      renameSync(next, this.keyFile);
      this.stashKey = key;
    }
    this.link.send(JSON.stringify({ stash: sealKept(this.stashKey, { ...this.state.session, holders: [...this.holders.keys()] }) }));
  }

  async status(): Promise<Status> {
    await this.settle().catch(() => false);
    if (this.state.kind !== "unlocked") return { unlocked: false, reason: this.why };
    const a = this.approval;
    const helper = runningHelper(this.profile);
    return {
      unlocked: true,
      sessions: this.holders.size,
      ends: this.grace ? `at ${localTime(new Date(this.grace.ends))}` : `${GRACE_MIN} minutes after the last session holding it is done`,
      ...(a && !a.landed ? { waiting: `${a.what}, since ${localTime(new Date(a.since))}` } : {}),
      ...(helper ? { helper } : {}),
    };
  }

  private fail(e: Error) {
    const w = this.waiter;
    this.waiter = null;
    w?.reject(e);
  }

  // Replies carry no request id, so one request at a time, and none while
  // the helper waits on Touch ID.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const go = () => {
      const a = this.approval;
      if (a && !a.landed) throw new Error(`Apple's password helper is waiting for the user to approve ${a.what} with Touch ID (since ${localTime(new Date(a.since))}) and answers nothing else until he does; ask him to approve, then call ${a.again} again`);
      return fn();
    };
    const run = this.queue.then(go, go);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---------- who holds the pairing ----------

  // The calling agent session holds the pairing until it calls done or
  // exits. A call with no session behind it (a script's own rpc) keeps the
  // pairing for the grace period only.
  private hold(pid = currentOwner()) {
    if (pid === undefined) {
      if (this.holders.size === 0) this.startGrace();
      return;
    }
    if (this.holders.has(pid)) return;
    this.holders.set(pid, watchOwner(pid, () => this.release(pid)));
    this.grace?.cancel();
    this.grace = null;
    this.sendStash();
  }

  private release(pid: number): boolean {
    const unwatch = this.holders.get(pid);
    if (!unwatch) return false;
    unwatch();
    this.holders.delete(pid);
    if (this.holders.size === 0) this.startGrace();
    this.sendStash();
    return true;
  }

  private startGrace() {
    this.grace?.cancel();
    const ms = GRACE_MIN * 60_000;
    this.grace = { ends: this.timers.now() + ms, cancel: this.timers.after(ms, () => this.end()) };
  }

  // No session has held the pairing for the grace period: it ends, and
  // Helium quits.
  private end() {
    this.grace = null;
    if (this.state.kind !== "idle") this.reset(`every session using it was done, so it ended at ${localTime()}`);
    this.quitting = this.quit().finally(() => {
      this.quitting = null;
    });
  }

  private async quit() {
    const link = this.link;
    this.link = null;
    this.greeted = false;
    this.fail(new Error("the pairing ended"));
    link?.close();
    await quitHelium(this.profile);
  }

  // Lets go of the calling session's hold. Other sessions' holds stay, and
  // the pairing with them.
  async done(): Promise<{ released: boolean } & Status> {
    const pid = currentOwner();
    const released = pid !== undefined && this.release(pid);
    return { released, ...(await this.status()) };
  }

  // ---------- reaching the helper ----------

  // Waits for a bridge on its way: one that dialed in and is still saying
  // hello, or that of a Helium already running (the last daemon's redials
  // within a second), so a call just after a restart sees the pairing this
  // daemon takes over. True once a greeted link is up.
  private async settle(): Promise<boolean> {
    await this.quitting;
    if (this.link && this.greeted) return true;
    const linked = this.linked ?? this.expectLink();
    if (!this.link) {
      const running = runningHelium(this.profile);
      if (!running) return false;
      if (running.ppid !== 1 && running.ppid !== process.pid) throw new Error(`another program's Helium (pid ${running.pid}) is using ${this.profile}`);
      if (!(await within(linked.promise, ADOPT_MS)) && !this.link) return false;
    }
    return within(linked.promise, LINK_MS);
  }

  private expectLink(): PromiseWithResolvers<void> {
    const linked = Promise.withResolvers<void>();
    // Rejected when a new Helium quits first; a waiter that already gave up
    // must not make that an unhandled rejection.
    linked.promise.catch(() => {});
    this.linked = linked;
    return linked;
  }

  // The link to Apple's helper, starting Helium when no bridge can be
  // reached. A running Helium whose bridge never dialed in holds no pairing
  // (a pairing keeps its bridge running), so it makes way for a new one.
  private async ensureLink(): Promise<HelperLink> {
    if (!(await this.settle())) {
      await quitHelium(this.profile);
      const linked = this.linked ?? this.expectLink();
      const child = launchHelium(this.profile, this.port);
      // A Helium that dies before its bridge dials in fails the wait at once.
      const failed = (why: string) => {
        if (this.linked === linked) this.linked = null;
        linked.reject(new Error(why));
      };
      child.once("error", (e) => failed(`the hidden Helium did not start: ${e.message}`));
      child.once("exit", () => failed("the hidden Helium quit before its bridge connected"));
      if (!(await within(linked.promise, LINK_MS))) throw new Error("the hidden Helium did not connect within 20s");
    }
    if (!this.link) throw new Error("the Helium password bridge disconnected");
    return this.link;
  }

  // One request to the helper, and its reply; with no timeoutMs, however
  // long it takes.
  private async exchange(link: HelperLink, cmd: number, body: Record<string, unknown>, timeoutMs?: number): Promise<HelperMsg> {
    const { promise, resolve, reject } = Promise.withResolvers<HelperMsg>();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      if (this.waiter?.cmd === cmd) this.waiter = null;
      reject(new Error("Apple's password helper did not answer"));
    }, timeoutMs);
    this.waiter = { cmd, resolve, reject };
    link.send(JSON.stringify({ helper: { cmd, ...body } }));
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ask(cmd: number, body: Record<string, unknown>, timeoutMs: number): Promise<HelperMsg> {
    return this.exchange(await this.ensureLink(), cmd, body, timeoutMs);
  }

  // Shows a fresh 6-digit code on the Mac, and names Apple's helper process,
  // whose window shows it. A new pair invalidates the last code; with a
  // pairing up, there is nothing to show.
  pair(): Promise<{ unlocked: true } | { codeShown: true; helper?: number }> {
    this.hold();
    return this.serial(async () => {
      await this.settle();
      if (this.state.kind === "unlocked") return { unlocked: true };
      const caps = (await this.ask(Cmd.CAPABILITIES, {}, 5000)).capabilities;
      if (!caps || typeof caps !== "object" || !("shouldUseBase64" in caps) || caps.shouldUseBase64 !== true) {
        throw new Error("this Mac's password helper speaks an older protocol than the harness does");
      }
      const a = fromBytes(randomBytes(32));
      const A = toBytes(modpow(G, a, N));
      const user = randomBytes(16).toString("base64");
      const hello = { TID: user, MSG: 0, A: A.toString("base64"), VER: "1.0", PROTO: [1] };
      const pake = pakeOf(await this.ask(Cmd.HANDSHAKE, {
        msg: { QID: "m0", PAKE: Buffer.from(JSON.stringify(hello)).toString("base64"), HSTBRSR: "Chrome" },
      }, 10000));
      if (pake.TID !== user) throw new Error("the helper answered another pairing");
      if (pake.ErrCode !== undefined) throw new Error(`the helper refused to pair (error ${String(pake.ErrCode)})`);
      if (String(pake.MSG) !== "1" || pake.PROTO !== 1) throw new Error("the helper spoke an unknown pairing version");
      const B = Buffer.from(String(pake.B), "base64");
      if (fromBytes(B) % N === 0n) throw new Error("the helper sent an invalid pairing key");
      this.state = { kind: "challenged", challenge: { user, a, A, B, salt: Buffer.from(String(pake.s), "base64") } };
      this.why = `a pairing began at ${localTime()} and its code has not been entered`;
      const helper = runningHelper(this.profile);
      return helper ? { codeShown: true, helper } : { codeShown: true };
    });
  }

  unlock(code: string): Promise<{ unlocked: true }> {
    this.hold();
    return this.serial(async () => {
      if (!/^\d{6}$/.test(code)) throw new Error("code must be the 6 digits the Mac shows");
      if (this.state.kind !== "challenged") throw new Error('no code is waiting: call passwords {do: "pair"} first');
      const c = this.state.challenge;
      // A failed try burns the code on the helper's side, so drop it here too.
      this.reset(`the pairing code entered at ${localTime()} was not accepted`);
      const { M, HAMK, K } = prove(c, code);
      const verify = { TID: c.user, MSG: 2, M: M.toString("base64") };
      const pake = pakeOf(await this.ask(Cmd.HANDSHAKE, {
        msg: { QID: "m2", PAKE: Buffer.from(JSON.stringify(verify)).toString("base64") },
      }, 10000));
      if (pake.ErrCode === 1) throw new Error('wrong code; call passwords {do: "pair"} for a new one');
      if (pake.ErrCode !== undefined && pake.ErrCode !== 0) throw new Error(`the helper refused the code (error ${String(pake.ErrCode)})`);
      if (!HAMK.equals(Buffer.from(String(pake.HAMK), "base64"))) throw new Error("the helper failed to prove the pairing");
      this.state = { kind: "unlocked", session: { user: c.user, key: K } };
      this.sendStash();
      return { unlocked: true };
    });
  }

  // The pairing's session, once any bridge on its way is in, held for the
  // calling agent session. Without one: why, then the one way on.
  private async session(): Promise<Session> {
    await this.settle();
    if (this.state.kind !== "unlocked") {
      throw new Error(`Apple Passwords is locked: ${this.why}. Pair now: call passwords {do: "pair"} with the tab. The user types the code his Mac shows into a prompt there, never into the chat. Do not route around the lock.`);
    }
    this.hold();
    return this.state.session;
  }

  // A helper request carrying body sealed under session s.
  private sealed(s: Session, qid: string, host: string, body: Record<string, unknown>): Record<string, unknown> {
    return { tabId: 0, frameId: 0, url: host, payload: { QID: qid, SMSG: JSON.stringify({ TID: s.user, SDATA: seal(s.key, body).toString("base64") }) } };
  }

  // An encrypted query under session s. An answer that is not under s means
  // the helper has lost the pairing, which then ends here too.
  private async query(link: HelperLink, s: Session, cmd: number, qid: string, host: string, body: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const reply = await this.exchange(link, cmd, this.sealed(s, qid, host, body), timeoutMs);
    const payload = reply.payload;
    const raw = payload && typeof payload === "object" && "SMSG" in payload ? payload.SMSG : undefined;
    const smsg: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!smsg || typeof smsg !== "object" || !("SDATA" in smsg) || !("TID" in smsg) || smsg.TID !== s.user) {
      if (this.state.kind === "unlocked" && this.state.session === s) this.reset(`Apple's password helper stopped answering for the pairing at ${localTime()}`);
      throw new Error("the helper answered for another session");
    }
    const out = open(s.key, Buffer.from(String(smsg.SDATA), "base64"));
    if (!out || typeof out !== "object") throw new Error("the helper sent an unreadable answer");
    return { ...out };
  }

  // Usernames saved for a site. Never includes passwords.
  private logins(host: string): Promise<string[]> {
    return this.serial(async () => {
      const s = await this.session();
      const res = await this.query(await this.ensureLink(), s, Cmd.LOGIN_NAMES, "CmdGetLoginNames4URL", host, { ACT: 5, URL: host }, 10000);
      if (res.STATUS === STATUS_NONE) return [];
      if (res.STATUS !== STATUS_OK) throw new Error(`Apple Passwords query failed (status ${String(res.STATUS)})`);
      const entries: unknown[] = Array.isArray(res.Entries) ? res.Entries : [];
      return entries.flatMap((e) => (e && typeof e === "object" && "USR" in e && typeof e.USR === "string" ? [e.USR] : []));
    });
  }

  // A request the Mac may hold for Touch ID. The call answers within
  // ANSWER_MS; one that gives up leaves the request waiting, and the next
  // call that asks the same gets the answer once it lands.
  private async approved(ask: Ask, request: (link: HelperLink, s: Session) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const a = await this.serial(async () => {
      const kept = this.approval;
      if (kept?.key === ask.key) return kept;
      const s = await this.session();
      const next: Approval = { ...ask, since: this.timers.now(), reply: request(await this.ensureLink(), s), landed: false, gaveUp: false };
      this.approval = next;
      next.reply.then(() => {
        next.landed = true;
        if (!next.gaveUp || this.approval !== next) return;
        next.drop = this.timers.after(next.keepMs, () => {
          if (this.approval === next) this.approval = null;
        });
      }, () => {
        if (this.approval === next) this.approval = null;
      });
      return next;
    });
    if (!(await within(a.reply, ANSWER_MS, this.timers))) {
      a.gaveUp = true;
      throw new Error(`the Mac is asking the user to approve ${a.what} with Touch ID (since ${localTime(new Date(a.since))}); ask him to approve, then call ${a.again} again`);
    }
    a.drop?.();
    if (this.approval === a) this.approval = null;
    return a.reply;
  }

  private async password(host: string, username: string, again = "fill"): Promise<string> {
    const res = await this.approved({ key: `password ${host} ${username}`, what: `a sign-in for ${host}`, again, keepMs: KEEP_PASSWORD_MS }, (link, s) =>
      this.query(link, s, Cmd.PASSWORD, "CmdGetPassword4LoginName", host, { ACT: 2, URL: host, USR: username }));
    const entries: unknown[] = res.STATUS === STATUS_OK && Array.isArray(res.Entries) ? res.Entries : [];
    const entry = entries[0];
    if (!entry || typeof entry !== "object" || !("PWD" in entry) || typeof entry.PWD !== "string") {
      throw new Error(`no saved password for ${username} on ${host}`);
    }
    return entry.PWD;
  }

  // Asks Apple Passwords to save secret as username's password for host:
  // the entry Safari makes when a form takes a password it suggested
  // (MAYBE_ADD, 4). The helper then asks in its own window whether to
  // update or save it, and answers the request neither way (Apple's own
  // extension ignores cmd 6 replies; on 09-29 a save it made waited 20 s
  // for none), so only the window's button says whether it saved.
  private async save(host: string, username: string, secret: string): Promise<void> {
    await this.serial(async () => {
      const s = await this.session();
      (await this.ensureLink()).send(JSON.stringify({ helper: { cmd: Cmd.SAVE, ...this.sealed(s, "CmdSetPassword4LoginName_URL", host, { ACT: 4, URL: "", USR: "", PWD: "", NURL: host, NUSR: username, NPWD: secret }) } }));
    });
  }

  // The current code from a verification-code setup saved for the site, for
  // username when given.
  private async oneTimeCode(host: string, username?: string): Promise<{ code: string; username: string }> {
    const res = await this.approved({ key: `code ${host}`, what: `a verification code for ${host}`, again: "code", keepMs: KEEP_CODE_MS }, (link, s) =>
      this.query(link, s, Cmd.ONE_TIME_CODE, "CmdDidFillOneTimeCode", host, { ACT: 2, TYPE: "oneTimeCodes", frameURLs: [`https://${host}`] }));
    if (res.STATUS === STATUS_NONE) throw new Error(`no verification code saved for ${host}`);
    if (res.STATUS !== STATUS_OK) throw new Error(`Apple Passwords query failed (status ${String(res.STATUS)})`);
    // Entries come as a list, or as Entry_0, Entry_1, ... keys.
    const listed: unknown[] = Array.isArray(res.Entries) ? res.Entries : Object.keys(res).filter((k) => k.startsWith("Entry_")).map((k) => res[k]);
    const codes = listed.flatMap((e) => e && typeof e === "object" && "code" in e && typeof e.code === "string"
      ? [{ code: e.code, username: "username" in e && typeof e.username === "string" ? e.username : "" }] : []);
    const pick = username === undefined ? codes[0] : codes.find((c) => c.username === username);
    if (!pick) throw new Error(codes.length ? `no verification code for ${username} on ${host}; saved for: ${codes.map((c) => c.username).join(", ")}` : `no verification code saved for ${host}`);
    return pick;
  }

  // ---------- a Safari tab's sign-in form ----------

  async loginsFor(tab: number): Promise<{ site: string; usernames: string[] }> {
    await this.session();
    const { site } = await loginForm(tab);
    return { site, usernames: await this.logins(site) };
  }

  // The login a call means: the one named, else the only one saved.
  private async chosenLogin(site: string, username?: string): Promise<{ login: string; saved: string[] }> {
    const saved = await this.logins(site);
    const login = username ?? (saved.length === 1 ? saved[0] : undefined);
    if (login === undefined) {
      throw new Error(saved.length === 0 ? `no saved login for ${site}` : `several saved logins for ${site}; pass username: ${saved.join(", ")}`);
    }
    return { login, saved };
  }

  // Fills the saved login into the tab's sign-in form. The result names the
  // fields filled, never the password, and where the page went when the
  // form submitted itself.
  async fill(tab: number, username?: string): Promise<{ filled: string[]; navigated?: Navigated; username: string; site: string }> {
    await this.session();
    const form = await loginForm(tab);
    if (!form.password && !form.username) throw new Error("no sign-in form on this page");
    const { site } = form;
    const { login, saved } = await this.chosenLogin(site, username);
    if (!saved.includes(login)) throw new Error(`no saved login ${login} for ${site}; saved: ${saved.join(", ") || "none"}`);
    const secret = form.password ? await this.password(site, login) : null;
    const res = await bridge.tab(tab, "fillLogin", [site, login, secret], 30000, form.frame);
    const sent = [...(form.username && login ? ["username"] : []), ...(secret ? ["password"] : [])];
    return { ...filledOf(res, sent, "login"), username: login, site };
  }

  // Types the site's current verification code into the tab's code field,
  // in whichever frame holds it. The result never carries the code.
  async fillCode(tab: number, username?: string): Promise<{ filled: string[]; navigated?: Navigated; username: string; site: string }> {
    await this.session();
    const frames = await probe(tab, "code");
    const field = frames.find((f) => f.found);
    if (!field) throw new Error("no verification code field on this page");
    const site = httpsHost(field.origin);
    const { code, username: login } = await this.oneTimeCode(site, username);
    const res = await bridge.tab(tab, "fillCode", [site, code], 30000, field.frame);
    return { ...filledOf(res, ["code"], "code"), username: login, site };
  }

  // Hands the authenticator key in the QR code png shows to Apple
  // Passwords, as Safari's Set Up Verification Code menu does (cmd 13,
  // which the helper does not answer): the Passwords app opens a sheet to
  // pick the login it goes with. The key never leaves the daemon; the
  // result names only the issuer and account, which the code shows as text.
  async setUpCode(site: string, png: Buffer): Promise<{ sent: true; site: string; issuer: string; account: string }> {
    await this.session();
    const read = Bun.spawnSync([PAIRING, "qr"], { stdin: png });
    if (!read.success) throw new Error(`reading the page's QR codes failed: ${read.stderr.toString().trim()}`);
    const { found } = JSON.parse(read.stdout.toString()) as { found: string[] };
    const uri = found.find((m) => m.toLowerCase().startsWith("otpauth://totp/"));
    if (!uri) throw new Error("no authenticator QR code in view on this page; open the site's authenticator-app step and scroll the code into view, then call again");
    const parsed = new URL(uri);
    const [labelIssuer = "", account = ""] = decodeURIComponent(parsed.pathname.slice(1)).split(/:(.*)/);
    await this.serial(async () => {
      await this.session();
      (await this.ensureLink()).send(JSON.stringify({ helper: { cmd: Cmd.SET_UP_CODE, setUpTOTPPageURL: site, setUpTOTPURI: uri } }));
    });
    return { sent: true, site, issuer: parsed.searchParams.get("issuer") ?? labelIssuer, account: account || labelIssuer };
  }

  // Changing a password, first half: makes a strong password, asks Apple
  // Passwords to save it as the login's password for the form's site, or
  // for entry, the site the login is saved for when the reset page is on
  // another (FHDA's campus login reset on its own host left the old entry
  // stale), and keeps it for typeChange. The caller (fill.ts) presses
  // Update Password in the helper's window, the only sign the save took,
  // then calls typeChange. It is saved before it is typed, as Safari saves
  // the one it suggests, so no password the site takes lives only in the
  // page; the current password is read first, while the saved one is
  // still it, and only for the form's own site.
  async change(tab: number, username?: string, entry?: string): Promise<{ username: string; site: string; helper?: number }> {
    await this.session();
    const form = (await probe(tab, "change")).find((f) => (f.fresh ?? 0) > 0);
    if (!form) throw new Error("no new-password field on this page; if its one unmarked password field takes the new password, set autocomplete=\"new-password\" on it with eval, then call change again");
    const own = httpsHost(form.origin);
    const site = entry === undefined ? own : httpsHost(`https://${entry}`);
    if (site !== own && form.current === "empty") throw new Error(`the form asks for the current password, which is filled only on the site it is saved for; call change without site`);
    const { login, saved } = await this.chosenLogin(site, username);
    let current: string | null = null;
    if (form.current === "empty") {
      if (!saved.includes(login)) throw new Error(`the form asks for the current password, and no login ${login} is saved for ${site}; type it in first`);
      current = await this.password(site, login, "change");
    }
    const secret = strongPassword(form.maxLength);
    this.dropChange(tab);
    await this.save(site, login, secret);
    const drop = this.timers.after(CHANGE_MS, () => this.dropChange(tab));
    this.pendingChanges.set(tab, { frame: form.frame, fresh: form.fresh ?? 1, host: own, site, login, current, secret, drop });
    const helper = runningHelper(this.profile);
    return { username: login, site, ...(helper ? { helper } : {}) };
  }

  // Changing a password, second half, once its save was confirmed: types
  // the new password into the tab's new-password fields, and the saved
  // current one into an empty current-password field. The result never
  // carries either password.
  async typeChange(tab: number): Promise<{ filled: string[]; navigated?: Navigated; username: string; site: string; saved: true }> {
    const c = this.pendingChanges.get(tab);
    if (!c) throw new Error("no password change waiting to be typed into this tab; call change again");
    this.dropChange(tab);
    const res = await bridge.tab(tab, "fillNewPassword", [c.host, c.current, c.secret], 30000, c.frame);
    const sent = [...(c.current ? ["current password"] : []), "new password", ...(c.fresh === 1 ? [] : ["confirm password"])];
    return { ...filledOf(res, sent, "new password"), username: c.login, site: c.site, saved: true };
  }

  dropChange(tab: number): void {
    this.pendingChanges.get(tab)?.drop();
    this.pendingChanges.delete(tab);
  }

  // The daemon is exiting. Helium, its helper, and the pairing stay up for
  // the next daemon, which takes over the session the bridge keeps.
  shutdown() {
    this.fail(new Error("the harness stopped"));
    this.grace?.cancel();
    for (const unwatch of this.holders.values()) unwatch();
    const link = this.link;
    this.link = null;
    link?.close();
  }
}

// Hidden Helium with its own profile, never the user's: the native host
// manifest in the profile points it at Apple's helper, and the bridge dials
// port. It runs in a session of its own, so the daemon's stop (launchd
// signals the daemon's whole process group) leaves it and its helper
// running. One browser process with the network and GPU work inside it, and
// no page or spare renderer: 4 processes and about 200 MB, where Helium's
// defaults ran 8 and about 320 MB. About 90 MB of the rest is uBlock Origin,
// which Helium builds in and will not turn off.
//
// The profile keeps the service worker the bridge last ran, and Helium
// starts that copy over the files in bridge/, even for a new version: the
// bridge before this one dialed in, never said hello, and every sign-in
// timed out. Nothing runs on the profile here (a launch follows a quit), so
// dropping the cached worker makes Helium register this release's bridge.
export function launchHelium(profile: string, port: number): ChildProcess {
  if (!existsSync(HELIUM)) throw new Error("Apple Passwords needs Helium in /Applications (macOS lets only approved browsers reach the password helper)");
  const ext = join(profile, "bridge");
  rmSync(join(profile, "Default", "Service Worker"), { recursive: true, force: true });
  mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
  cpSync(BRIDGE_SRC, ext, { recursive: true });
  writeFileSync(join(ext, "port.json"), JSON.stringify({ port }));
  writeFileSync(join(profile, "NativeMessagingHosts", "com.apple.passwordmanager.json"), JSON.stringify({
    name: "com.apple.passwordmanager",
    description: "PasswordManagerBrowserExtensionHelper",
    path: HELPER,
    type: "stdio",
    allowed_origins: [`${BRIDGE_ORIGIN}/`],
  }));
  const child = spawn(HELIUM, [
    `--user-data-dir=${profile}`,
    "--headless=new",
    `--load-extension=${ext}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--disable-gpu",
    "--in-process-gpu",
    "--enable-features=NetworkServiceInProcess2",
    // One flag for both: a second --disable-features replaces the first.
    "--disable-features=DisableLoadExtensionCommandLineSwitch,SpareRendererForSitePerProcess",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

// Our Helium's browser process, if one runs. Its helper processes carry the
// same --user-data-dir, and start from another path.
export function runningHelium(profile: string): { pid: number; ppid: number } | undefined {
  const flag = `--user-data-dir=${profile} `;
  for (const line of Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,ppid=,command="]).stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m && m[3].startsWith(`${HELIUM} `) && m[3].includes(flag)) return { pid: Number(m[1]), ppid: Number(m[2]) };
  }
  return undefined;
}

// Apple's helper, run by our Helium; its window shows the pairing code.
export function runningHelper(profile: string): number | undefined {
  const helium = runningHelium(profile);
  const pid = helium ? Number(Bun.spawnSync(["pgrep", "-P", String(helium.pid), "-f", HELPER]).stdout.toString().split("\n")[0]) : 0;
  return pid > 1 ? pid : undefined;
}

// Quits our Helium, and with it the helper, any pairing, and the session its
// bridge kept. SIGTERM lets Helium close its profile cleanly; one still
// running 3 s later gets SIGKILL.
export async function quitHelium(profile: string) {
  const running = runningHelium(profile);
  if (!running) return;
  const gone = Promise.withResolvers<void>();
  const unwatch = watchOwner(running.pid, gone.resolve);
  try {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      process.kill(running.pid, signal);
      if (await within(gone.promise, 3000)) return;
    }
  } catch {
    // already gone
  } finally {
    unwatch();
  }
}

export const passwords = new ApplePasswords();

// ---------- a Safari tab's sign-in form ----------

// What a frame of the tab says it holds (probeFrames in background.js).
type Probe = { frame: number; origin: string; username?: boolean; password?: boolean; found?: boolean; fresh?: number; maxLength?: number; current?: "empty" | "filled" };

function isProbe(p: unknown): p is Probe {
  return !!p && typeof p === "object" && "frame" in p && typeof p.frame === "number" && "origin" in p && typeof p.origin === "string";
}

// Each frame of the tab that answered, top page first.
async function probe(tab: number, what: "login" | "code" | "change"): Promise<Probe[]> {
  const frames = await bridge.request("probe", [tab, what]);
  return Array.isArray(frames) ? frames.filter(isProbe) : [];
}

// The site a login may be used on comes from the page itself, never from
// the caller, so a saved login can only reach the site it was saved for.
function httpsHost(origin: string): string {
  const url = URL.parse(origin);
  if (!url || url.protocol !== "https:") throw new Error("logins are filled only on https pages");
  return url.hostname;
}

// Where a login for this tab goes: the frame holding its sign-in form, top
// page first, and that frame's own site (Apple's sign-in form on
// appstoreconnect.apple.com is a frame from idmsa.apple.com). With no form,
// the top page.
export async function loginForm(tab: number): Promise<{ site: string; frame: number; username: boolean; password: boolean }> {
  const frames = await probe(tab, "login");
  const form = frames.find((f) => f.username || f.password) ?? frames[0];
  if (!form) throw new Error("the page did not answer; reload it with goto and try again");
  return { site: httpsHost(form.origin), frame: form.frame, username: form.username === true, password: form.password === true };
}
