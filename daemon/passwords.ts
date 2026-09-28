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
// AES-GCM. The pairing lives as long as the helper process, so a daemon or
// Helium restart needs a new code. Every agent shares the one pairing, so no
// tool ends it; each time it ends, the reason is kept for status and for the
// error a locked call gets.
//
// Protocol follows open-passwords (Apache-2.0), itself derived from
// au2001/icloud-passwords-firefox.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { bridge } from "./bridge.ts";

export const BRIDGE_ORIGIN = "chrome-extension://pejdijmoenmkgeppbflobdenhhabjlaj";
const HELIUM = "/Applications/Helium.app/Contents/MacOS/Helium";
const HELPER = "/System/Cryptexes/App/System/Library/CoreServices/PasswordManagerBrowserExtensionHelper.app/Contents/MacOS/PasswordManagerBrowserExtensionHelper";
const PROFILE = join(homedir(), "Library", "Application Support", "Safari Harness", "passwords-helium");
const BRIDGE_SRC = join(import.meta.dir, "..", "passwords-bridge");

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
  | { kind: "challenged"; challenge: Challenge; at: string }
  | { kind: "unlocked"; session: Session };

// "Sep 28, 8:40 PM": when a pairing ended, in the Mac's own time zone.
function localTime(at = new Date()): string {
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

const Cmd = { HANDSHAKE: 2, LOGIN_NAMES: 4, PASSWORD: 5, DISABLED: 9, RELOGIN: 10, CAPABILITIES: 14, ONE_TIME_CODE: 17 } as const;
const STATUS_OK = 0;
const STATUS_NONE = 3;

export type HelperLink = { send(data: string): void; close(): void };
type HelperMsg = Record<string, unknown> & { cmd?: number };
type Waiter = { cmd: number; resolve: (m: HelperMsg) => void; reject: (e: Error) => void };

// A pairing message from the helper: base64 JSON under payload.PAKE.
function pakeOf(reply: HelperMsg): Record<string, unknown> {
  const p = reply.payload;
  const pake = p && typeof p === "object" && "PAKE" in p ? p.PAKE : undefined;
  if (typeof pake !== "string") throw new Error("the helper sent no pairing data");
  return JSON.parse(Buffer.from(pake, "base64").toString("utf8"));
}

export class ApplePasswords {
  private link: HelperLink | null = null;
  private linked: PromiseWithResolvers<void> | null = null;
  private helium: Subprocess | null = null;
  private state: State = { kind: "idle" };
  // Why the state is idle, in plain words.
  private why = `it has not been paired since the harness started at ${localTime()}`;
  private helperSeen = false;
  private waiter: Waiter | null = null;
  // Replies carry no request id, so one request at a time.
  private queue: Promise<unknown> = Promise.resolve();

  // A new bridge means a new helper process, which knows no pairing.
  attach(link: HelperLink) {
    if (this.link && this.link !== link) this.link.close();
    this.link = link;
    this.reset(this.helperSeen ? `Apple's password helper restarted at ${localTime()}` : `it has not been paired since Apple's password helper started at ${localTime()}`);
    this.helperSeen = true;
    this.linked?.resolve();
  }

  detach(link: HelperLink) {
    if (this.link !== link) return;
    this.link = null;
    this.reset(`Apple's password helper stopped at ${localTime()}`);
    this.fail(new Error("the Helium password bridge disconnected"));
  }

  handleMessage(raw: string) {
    let msg: { helper?: HelperMsg; closed?: string };
    try { msg = JSON.parse(raw); } catch { return; }
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

  get unlocked(): boolean {
    return this.state.kind === "unlocked";
  }

  private reset(why: string) {
    this.state = { kind: "idle" };
    this.why = why;
  }

  status(): { unlocked: boolean; reason?: string } {
    if (this.state.kind === "unlocked") return { unlocked: true };
    return { unlocked: false, reason: this.state.kind === "challenged" ? `a pairing began at ${this.state.at} and its code has not been entered` : this.why };
  }

  // What a call that needs the pairing gets without one: why, then the one
  // way on.
  lockedError(): Error {
    return new Error(`Apple Passwords is locked: ${this.status().reason}. Pair now: call passwords {do: "pair"}, and in the same message ask the user for the 6-digit code their Mac shows; then call passwords {do: "unlock", code}. Do not route around the lock.`);
  }

  private fail(e: Error) {
    const w = this.waiter;
    this.waiter = null;
    w?.reject(e);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Starts the hidden Helium on first use; its bridge dials back within a
  // second or two.
  private async ensureLink(): Promise<HelperLink> {
    if (this.link) return this.link;
    const linked = Promise.withResolvers<void>();
    this.linked = linked;
    const timer = setTimeout(() => linked.reject(new Error("the hidden Helium did not connect within 20s")), 20000);
    try {
      if (!this.helium || this.helium.exitCode !== null) this.helium = launchHelium();
      await linked.promise;
    } finally {
      clearTimeout(timer);
      this.linked = null;
    }
    if (!this.link) throw new Error("the Helium password bridge disconnected");
    return this.link;
  }

  private async ask(cmd: number, body: Record<string, unknown>, timeoutMs: number, silence = "Apple's password helper did not answer"): Promise<HelperMsg> {
    const link = await this.ensureLink();
    const { promise, resolve, reject } = Promise.withResolvers<HelperMsg>();
    const timer = setTimeout(() => {
      if (this.waiter?.cmd === cmd) this.waiter = null;
      reject(new Error(silence));
    }, timeoutMs);
    this.waiter = { cmd, resolve, reject };
    link.send(JSON.stringify({ helper: { cmd, ...body } }));
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  // Shows a fresh 6-digit code on the Mac. A new pair invalidates the last code.
  pair(): Promise<{ codeShown: true }> {
    return this.serial(async () => {
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
      this.state = { kind: "challenged", challenge: { user, a, A, B, salt: Buffer.from(String(pake.s), "base64") }, at: localTime() };
      return { codeShown: true };
    });
  }

  unlock(code: string): Promise<{ unlocked: true }> {
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
      return { unlocked: true };
    });
  }

  private async query(cmd: number, qid: string, host: string, body: Record<string, unknown>, timeoutMs: number, silence?: string): Promise<Record<string, unknown>> {
    if (this.state.kind !== "unlocked") throw this.lockedError();
    const s = this.state.session;
    const reply = await this.ask(cmd, {
      tabId: 0,
      frameId: 0,
      url: host,
      payload: { QID: qid, SMSG: JSON.stringify({ TID: s.user, SDATA: seal(s.key, body).toString("base64") }) },
    }, timeoutMs, silence);
    const payload = reply.payload;
    const raw = payload && typeof payload === "object" && "SMSG" in payload ? payload.SMSG : undefined;
    const smsg: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!smsg || typeof smsg !== "object" || !("SDATA" in smsg) || !("TID" in smsg) || smsg.TID !== s.user) {
      throw new Error("the helper answered for another session");
    }
    const out = open(s.key, Buffer.from(String(smsg.SDATA), "base64"));
    if (!out || typeof out !== "object") throw new Error("the helper sent an unreadable answer");
    return { ...out };
  }

  // Usernames saved for a site. Never includes passwords.
  logins(host: string): Promise<string[]> {
    return this.serial(async () => {
      const res = await this.query(Cmd.LOGIN_NAMES, "CmdGetLoginNames4URL", host, { ACT: 5, URL: host }, 10000);
      if (res.STATUS === STATUS_NONE) return [];
      if (res.STATUS !== STATUS_OK) throw new Error(`Apple Passwords query failed (status ${String(res.STATUS)})`);
      const entries: unknown[] = Array.isArray(res.Entries) ? res.Entries : [];
      return entries.flatMap((e) => (e && typeof e === "object" && "USR" in e && typeof e.USR === "string" ? [e.USR] : []));
    });
  }

  // macOS asks for Touch ID or the login password before the helper hands out
  // a password, so allow the user two minutes to approve.
  password(host: string, username: string): Promise<string> {
    return this.serial(async () => {
      const res = await this.query(Cmd.PASSWORD, "CmdGetPassword4LoginName", host, { ACT: 2, URL: host, USR: username }, 120000,
        "the Mac asked the user to approve with Touch ID and nobody did within 2 minutes; ask the user to approve, then fill again");
      const entries: unknown[] = res.STATUS === STATUS_OK && Array.isArray(res.Entries) ? res.Entries : [];
      const entry = entries[0];
      if (!entry || typeof entry !== "object" || !("PWD" in entry) || typeof entry.PWD !== "string") {
        throw new Error(`no saved password for ${username} on ${host}`);
      }
      return entry.PWD;
    });
  }

  // The current code from a verification-code setup saved for the site, for
  // username when given. The helper may ask for Touch ID first.
  oneTimeCode(host: string, username?: string): Promise<{ code: string; username: string }> {
    return this.serial(async () => {
      const res = await this.query(Cmd.ONE_TIME_CODE, "CmdDidFillOneTimeCode", host, { ACT: 2, TYPE: "oneTimeCodes", frameURLs: [`https://${host}`] }, 120000,
        "the Mac asked the user to approve with Touch ID and nobody did within 2 minutes; ask the user to approve, then try again");
      if (res.STATUS === STATUS_NONE) throw new Error(`no verification code saved for ${host}`);
      if (res.STATUS !== STATUS_OK) throw new Error(`Apple Passwords query failed (status ${String(res.STATUS)})`);
      // Entries come as a list, or as Entry_0, Entry_1, ... keys.
      const listed: unknown[] = Array.isArray(res.Entries) ? res.Entries : Object.keys(res).filter((k) => k.startsWith("Entry_")).map((k) => res[k]);
      const codes = listed.flatMap((e) => e && typeof e === "object" && "code" in e && typeof e.code === "string"
        ? [{ code: e.code, username: "username" in e && typeof e.username === "string" ? e.username : "" }] : []);
      const pick = username === undefined ? codes[0] : codes.find((c) => c.username === username);
      if (!pick) throw new Error(codes.length ? `no verification code for ${username} on ${host}; saved for: ${codes.map((c) => c.username).join(", ")}` : `no verification code saved for ${host}`);
      return pick;
    });
  }

  // Forget the pairing and quit the hidden Helium (it holds about 330 MB),
  // as the daemon exits.
  shutdown() {
    this.reset("the harness stopped");
    this.fail(new Error("the harness stopped"));
    const link = this.link;
    this.link = null;
    link?.close();
    this.helium?.kill();
    this.helium = null;
    // A Helium left by an earlier daemon reconnects to this one; stop it too.
    Bun.spawnSync(["pkill", "-f", `user-data-dir=${PROFILE}`]);
  }
}

// Hidden Helium with its own profile, never the user's. The native host
// manifest in the profile points Helium at Apple's helper.
function launchHelium(): Subprocess {
  if (!existsSync(HELIUM)) throw new Error("Apple Passwords needs Helium in /Applications (macOS lets only approved browsers reach the password helper)");
  const ext = join(PROFILE, "bridge");
  mkdirSync(join(PROFILE, "NativeMessagingHosts"), { recursive: true });
  cpSync(BRIDGE_SRC, ext, { recursive: true });
  writeFileSync(join(ext, "port.json"), JSON.stringify({ port: Number(process.env.SAFARI_HARNESS_WS ?? 37333) }));
  writeFileSync(join(PROFILE, "NativeMessagingHosts", "com.apple.passwordmanager.json"), JSON.stringify({
    name: "com.apple.passwordmanager",
    description: "PasswordManagerBrowserExtensionHelper",
    path: HELPER,
    type: "stdio",
    allowed_origins: [`${BRIDGE_ORIGIN}/`],
  }));
  return Bun.spawn([
    HELIUM,
    "--headless=new",
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${ext}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });
}

export const passwords = new ApplePasswords();

// ---------- a Safari tab's sign-in form ----------

// What a frame of the tab says it holds (probeFrames in background.js).
type Probe = { frame: number; origin: string; username?: boolean; password?: boolean; found?: boolean };

function isProbe(p: unknown): p is Probe {
  return !!p && typeof p === "object" && "frame" in p && typeof p.frame === "number" && "origin" in p && typeof p.origin === "string";
}

// Each frame of the tab that answered, top page first.
async function probe(tab: number, what: "login" | "code"): Promise<Probe[]> {
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

export async function loginsFor(tab: number): Promise<{ site: string; usernames: string[] }> {
  if (!passwords.unlocked) throw passwords.lockedError();
  const { site } = await loginForm(tab);
  return { site, usernames: await passwords.logins(site) };
}

// Fills the saved login into the tab's sign-in form. The result names the
// fields filled, never the password.
export async function fill(tab: number, username?: string): Promise<{ filled: string[]; username: string; site: string }> {
  if (!passwords.unlocked) throw passwords.lockedError();
  const form = await loginForm(tab);
  if (!form.password && !form.username) throw new Error("no sign-in form on this page");
  const { site } = form;
  const saved = await passwords.logins(site);
  const login = username ?? (saved.length === 1 ? saved[0] : undefined);
  if (login === undefined) {
    throw new Error(saved.length === 0 ? `no saved login for ${site}` : `several saved logins for ${site}; pass username: ${saved.join(", ")}`);
  }
  if (!saved.includes(login)) throw new Error(`no saved login ${login} for ${site}; saved: ${saved.join(", ") || "none"}`);
  const secret = form.password ? await passwords.password(site, login) : null;
  const res = await bridge.tab(tab, "fillLogin", [site, login, secret], 30000, form.frame);
  const filled = res && typeof res === "object" && "filled" in res && Array.isArray(res.filled) ? res.filled.map(String) : [];
  if (filled.length === 0) throw new Error("the page changed before the login was filled");
  return { filled, username: login, site };
}

// Types the site's current verification code into the tab's code field,
// in whichever frame holds it. The result never carries the code.
export async function fillCode(tab: number, username?: string): Promise<{ filled: string[]; username: string; site: string }> {
  if (!passwords.unlocked) throw passwords.lockedError();
  const frames = await probe(tab, "code");
  const field = frames.find((f) => f.found);
  if (!field) throw new Error("no verification code field on this page");
  const site = httpsHost(field.origin);
  const { code, username: login } = await passwords.oneTimeCode(site, username);
  const res = await bridge.tab(tab, "fillCode", [site, code], 30000, field.frame);
  const filled = res && typeof res === "object" && "filled" in res && Array.isArray(res.filled) ? res.filled.map(String) : [];
  if (filled.length === 0) throw new Error("the page changed before the code was filled");
  return { filled, username: login, site };
}
