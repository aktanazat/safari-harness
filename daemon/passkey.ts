// The page the user's iPhone opens to approve a card fill with Face ID
// while he is away from the Mac, and the checks of what it sends back. It
// listens on 127.0.0.1:SAFARI_HARNESS_PHONE_PORT (default 37335), and
// tailscale serve gives it an HTTPS address on his tailnet only, which a
// passkey needs; a Funnel, which would open it to the internet, is refused.
//
// cards.ts asks for an approval with card_phone. The daemon makes a request
// with a single-use challenge and answers a link for his phone and a token
// only the asker holds. The page asks Face ID for the card's passkey
// (userVerification required) with its PRF extension, and posts what the
// phone signed. The daemon checks it against the passkey's public key: the
// challenge, the page's origin and rpId, that Face ID verified him (UV),
// and the ES256 signature. Only then can the asker, by its token, take the
// PRF output, once: the key to the card's sealed copy comes from it
// (phone-cards.ts). Setting a card up (enroll) makes its passkey, so that
// page asks Face ID twice: once to make it, once to sign with it.
//
// A request lasts LIVE_MS; an answer waits as long for its asker, then is
// wiped. A model's own call is refused: no agent holds a phone's answer.

import { execFile } from "node:child_process";
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { promisify } from "node:util";
import { fromModel } from "./guard.ts";
import { within } from "./passwords.ts";
import type { Tool } from "./tools.ts";

const execFileAsync = promisify(execFile);

const LIVE_MS = 10 * 60_000;
// The longest one wait holds its call: an MCP call answers within 25 s
// (ANSWER_MS in passwords.ts).
const WAIT_MS = 30_000;

type Credential = { id: string; key: string };
type Answer = { approved: { prf: Buffer; credential: Credential } } | { declined: true } | { expired: true };
type Approval = {
  id: string;
  token: Buffer;
  origin: string;
  rpId: string;
  card: string;
  salt: string;
  challenge: string;
  answer?: Answer;
  answered: PromiseWithResolvers<void>;
  timer: Timer;
} & ({ kind: "enroll"; create: string; user: string } | { kind: "approve"; credential: Credential; site: string; amount?: string });

const approvals = new Map<string, Approval>();

// What the page shows the phone when a request is over.
const ENDED = "This link has ended.";

// A check of the phone's answer that failed: the page shows why.
class Refused extends Error {}

const b64 = (b: Buffer) => b.toString("base64url");
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
}

function text(v: unknown, what: string, most: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > most || /\p{Cc}/u.test(v)) throw new Error(`${what} must be one line of at most ${most} characters`);
  return v.trim();
}

function port(): number {
  const given = process.env.SAFARI_HARNESS_PHONE_PORT ?? "37335";
  const p = Number(given);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`SAFARI_HARNESS_PHONE_PORT is ${given}, not a port`);
  return p;
}

// The page's address on his tailnet: the HTTPS address tailscale serve
// passes to this port, or SAFARI_HARNESS_PHONE_ORIGIN.
async function pageOrigin(): Promise<string> {
  const given = process.env.SAFARI_HARNESS_PHONE_ORIGIN;
  if (given) return new URL(given).origin;
  const at = port();
  let status: Record<string, unknown>;
  try {
    const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], { timeout: 5000 });
    status = record(JSON.parse(stdout));
  } catch (e) {
    throw new Error(`tailscale did not say where the approval page is (${e instanceof Error ? e.message : String(e)}); his phone reaches it over Tailscale`);
  }
  const funnel = record(status.AllowFunnel);
  for (const [hostPort, web] of Object.entries(record(status.Web))) {
    const proxy = record(record(record(web).Handlers)["/"]).Proxy;
    if (proxy !== `http://127.0.0.1:${at}` && proxy !== `http://localhost:${at}`) continue;
    const cut = hostPort.lastIndexOf(":");
    const [host, https] = [hostPort.slice(0, cut), hostPort.slice(cut + 1)];
    if (funnel[hostPort] === true) throw new Error(`a Funnel opens ${hostPort} to the internet, and the approval page stays on the tailnet: run tailscale funnel --https=${https} off`);
    return https === "443" ? `https://${host}` : `https://${host}:${https}`;
  }
  throw new Error(`tailscale serves no address for the approval page: run tailscale serve --bg --https=8447 http://127.0.0.1:${at} on the Mac once`);
}

let listening = false;

function listen(): void {
  if (listening) return;
  const at = port();
  try {
    // development: false, so a failure shows the phone no source
    Bun.serve({ hostname: "127.0.0.1", port: at, development: false, fetch: route, error: () => json(500, { error: "The Mac could not answer." }) });
  } catch (e) {
    throw new Error(`the approval page could not listen on 127.0.0.1:${at}: ${e instanceof Error ? e.message : String(e)}`);
  }
  listening = true;
}

function settle(a: Approval, answer: Answer): void {
  a.answer = answer;
  clearTimeout(a.timer);
  a.timer = setTimeout(() => forget(a), LIVE_MS);
  a.timer.unref();
  a.answered.resolve();
}

function forget(a: Approval): void {
  clearTimeout(a.timer);
  if (a.answer && "approved" in a.answer) a.answer.approved.prf.fill(0);
  approvals.delete(a.id);
}

// ask: a new request, its link, and the token that alone waits on it.
async function ask(a: Record<string, unknown>): Promise<{ request: string; token: string; link: string }> {
  if (a.kind !== "enroll" && a.kind !== "approve") throw new Error("kind must be enroll or approve");
  const card = text(a.card, "card", 80);
  const origin = await pageOrigin();
  const rpId = new URL(origin).hostname;
  let made: { kind: "enroll"; salt: string; create: string; user: string } | { kind: "approve"; salt: string; credential: Credential; site: string; amount?: string };
  if (a.kind === "enroll") {
    // One passkey for each card: setting the card up again replaces it.
    const user = b64(sha256(`safari-harness card ${text(a.user, "user", 200)}`).subarray(0, 16));
    made = { kind: "enroll", salt: b64(randomBytes(32)), create: b64(randomBytes(32)), user };
  } else {
    if (a.rpId !== rpId) throw new Error(`the approval page is now on ${rpId}, and this card's passkey is for ${String(a.rpId)}: set Face ID up again with card-phone, at the Mac`);
    const c = record(a.credential);
    if (typeof c.id !== "string" || typeof c.key !== "string" || typeof a.salt !== "string") throw new Error("approve needs the card's credential and salt");
    made = { kind: "approve", salt: a.salt, credential: { id: c.id, key: c.key }, site: text(a.site, "site", 253), ...(a.amount === undefined ? {} : { amount: text(a.amount, "amount", 40) }) };
  }
  listen();
  const id = b64(randomBytes(16));
  const token = randomBytes(32);
  const approval: Approval = { id, token, origin, rpId, card, challenge: b64(randomBytes(32)), answered: Promise.withResolvers<void>(), timer: setTimeout(() => settle(approval, { expired: true }), LIVE_MS), ...made };
  approval.timer.unref();
  approvals.set(id, approval);
  return { request: id, token: b64(token), link: `${origin}/c/${id}` };
}

// The request a wait or drop names, if its token is the one ask gave.
function held(a: Record<string, unknown>): Approval | undefined {
  const approval = typeof a.request === "string" ? approvals.get(a.request) : undefined;
  const token = typeof a.token === "string" ? Buffer.from(a.token, "base64url") : Buffer.alloc(0);
  return approval && token.length === approval.token.length && timingSafeEqual(token, approval.token) ? approval : undefined;
}

// wait: the phone's answer, once it came within ms; an approval's PRF
// output is handed over once, then wiped here. gone: the request ended,
// another wait took its answer, or the daemon restarted.
async function wait(a: Record<string, unknown>): Promise<unknown> {
  let approval = held(a);
  if (approval && !approval.answer) {
    await within(approval.answered.promise, Math.min(Math.max(Number(a.ms) || 0, 0), WAIT_MS));
    approval = held(a);
  }
  if (!approval) return { gone: true };
  const answer = approval.answer;
  if (!answer) return { pending: true };
  if (!("approved" in answer)) {
    forget(approval);
    return answer;
  }
  const out = { approved: true, prf: b64(answer.approved.prf), ...(approval.kind === "enroll" ? { credential: answer.approved.credential, salt: approval.salt, rpId: approval.rpId } : {}) };
  forget(approval);
  return out;
}

export const CARD_PHONE: Tool = {
  desc: "The harness's own card approvals on the user's phone: ask makes one and its link, wait takes its answer, drop ends it.",
  params: {
    do: { type: "string", enum: ["ask", "wait", "drop"], description: "step" },
    kind: { type: "string", enum: ["enroll", "approve"], description: "ask: a card's setup, or a fill's approval" },
    card: { type: "string", description: "ask: the card as the page names it" },
    user: { type: "string", description: "ask enroll: the card's id" },
    site: { type: "string", description: "ask approve: the checkout's host" },
    amount: { type: "string", description: "ask approve: the total the agent gave" },
    rpId: { type: "string", description: "ask approve: the host of the card's passkey" },
    credential: { type: "object", description: "ask approve: the passkey's id and public key" },
    salt: { type: "string", description: "ask approve: the card's PRF input" },
    request: { type: "string", description: "wait, drop: ask's request" },
    token: { type: "string", description: "wait, drop: ask's token" },
    ms: { type: "number", description: "wait: at most this long" },
  },
  required: ["do"],
  hidden: true,
  run: async (a) => {
    if (fromModel()) throw new Error("card_phone is the harness's own: fill a card with passwords card-fill");
    if (a.do === "ask") return ask(a);
    if (a.do === "wait") return wait(a);
    if (a.do === "drop") {
      const approval = held(a);
      if (approval) forget(approval);
      return { dropped: true };
    }
    throw new Error("do must be ask, wait, or drop");
  },
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

const PATH = /^\/c\/([A-Za-z0-9_-]{22})(\/options)?\/?$/;

async function route(r: Request): Promise<Response> {
  const m = PATH.exec(new URL(r.url).pathname);
  if (!m) return json(404, { error: "Not found." });
  const approval = approvals.get(m[1]);
  if (m[2]) return r.method === "GET" ? options(approval) : json(405, { error: "Not allowed." });
  if (r.method === "GET") return new Response(PAGE, { headers: HEADERS });
  if (r.method === "POST") return answered(approval, r);
  return json(405, { error: "Not allowed." });
}

// What the page needs to ask Face ID, and to show what he approves.
function options(a: Approval | undefined): Response {
  if (!a || a.answer) return json(410, { error: ENDED });
  const shown = a.kind === "enroll" ? { create: a.create, user: a.user } : { credential: a.credential.id, site: a.site, ...(a.amount === undefined ? {} : { amount: a.amount }) };
  return json(200, { kind: a.kind, rpId: a.rpId, card: a.card, challenge: a.challenge, salt: a.salt, ...shown });
}

async function answered(a: Approval | undefined, r: Request): Promise<Response> {
  if (!a || a.answer) return json(410, { error: ENDED });
  const from = r.headers.get("origin");
  if (from !== null && from !== a.origin) return json(403, { error: "This answer came from another page." });
  if (!(r.headers.get("content-type") ?? "").startsWith("application/json")) return json(415, { error: "The answer was not JSON." });
  let body: Record<string, unknown>;
  try {
    body = record(await r.json());
  } catch {
    return json(400, { error: "The answer was not readable." });
  }
  if (body.decline === true) {
    settle(a, { declined: true });
    return json(200, { ok: true });
  }
  try {
    const credential = a.kind === "enroll" ? registered(a, a.create, body.registration) : a.credential;
    asserted(a, credential, body.assertion);
    const prf = bytes(body.prf, "PRF output");
    if (prf.length !== 32) throw new Refused("The passkey gave no PRF output, which opens the card. Update iOS, then ask for a new link.");
    settle(a, { approved: { prf, credential } });
    return json(200, { ok: true });
  } catch (e) {
    return json(403, { error: e instanceof Refused ? e.message : "The answer did not check out." });
  }
}

function bytes(v: unknown, what: string): Buffer {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw new Refused(`The answer has no ${what}.`);
  return Buffer.from(v, "base64url");
}

// clientDataJSON: what the phone's browser says it signed for.
function client(raw: Buffer, type: string, challenge: string, origin: string): void {
  let c: Record<string, unknown>;
  try {
    c = record(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new Refused("The answer was not readable.");
  }
  if (c.type !== type) throw new Refused("The phone answered another kind of request.");
  if (c.challenge !== challenge) throw new Refused("The phone answered another request.");
  if (c.origin !== origin || c.crossOrigin === true) throw new Refused("This answer was signed for another page.");
}

// authenticatorData: the passkey's site, and that Face ID verified him.
function authenticator(auth: Buffer, rpId: string, made: boolean): void {
  if (auth.length < 37) throw new Refused("The answer was not readable.");
  if (!auth.subarray(0, 32).equals(sha256(rpId))) throw new Refused("The passkey belongs to another site.");
  const flags = auth[32];
  if ((flags & 0x01) === 0) throw new Refused("The phone did not ask for you.");
  if ((flags & 0x04) === 0) throw new Refused("Face ID did not verify you.");
  if (made && (flags & 0x40) === 0) throw new Refused("The phone made no passkey.");
}

// A new passkey's registration: it must be ES256, for this page.
function registered(a: Approval, challenge: string, v: unknown): Credential {
  const reg = record(v);
  const id = bytes(reg.id, "passkey");
  client(bytes(reg.clientDataJSON, "client data"), "webauthn.create", challenge, a.origin);
  const auth = bytes(reg.authenticatorData, "authenticator data");
  authenticator(auth, a.rpId, true);
  const length = auth.length >= 55 ? auth.readUInt16BE(53) : -1;
  if (length < 0 || !auth.subarray(55, 55 + length).equals(id)) throw new Refused("The passkey's id does not match it.");
  const key = bytes(reg.publicKey, "public key");
  let curve: string | undefined;
  try {
    const k = createPublicKey({ key, format: "der", type: "spki" });
    curve = k.asymmetricKeyType === "ec" ? k.asymmetricKeyDetails?.namedCurve : undefined;
  } catch {
    curve = undefined;
  }
  if (reg.publicKeyAlgorithm !== -7 || curve !== "prime256v1") throw new Refused("The passkey does not sign with ES256.");
  return { id: b64(id), key: b64(key) };
}

// An assertion: this request's challenge, signed by the card's passkey.
function asserted(a: Approval, credential: Credential, v: unknown): void {
  const got = record(v);
  if (!bytes(got.id, "passkey").equals(Buffer.from(credential.id, "base64url"))) throw new Refused("Another passkey answered.");
  const data = bytes(got.clientDataJSON, "client data");
  client(data, "webauthn.get", a.challenge, a.origin);
  const auth = bytes(got.authenticatorData, "authenticator data");
  authenticator(auth, a.rpId, false);
  let good: boolean;
  try {
    const key = createPublicKey({ key: Buffer.from(credential.key, "base64url"), format: "der", type: "spki" });
    good = verify("sha256", Buffer.concat([auth, sha256(data)]), { key, dsaEncoding: "der" }, bytes(got.signature, "signature"));
  } catch {
    good = false;
  }
  if (!good) throw new Refused("The passkey's signature does not check out.");
}

const STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: oklch(98.5% 0.004 90);
  --text: oklch(23% 0.01 90);
  --muted: oklch(45% 0.012 90);
  --line: oklch(89% 0.008 90);
  --hover: oklch(95% 0.006 90);
  --hold: oklch(45% 0.11 240);
  --go: oklch(45% 0.1 150);
  --stop: oklch(50% 0.17 27);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(19% 0.006 90);
    --text: oklch(94% 0.006 90);
    --muted: oklch(73% 0.01 90);
    --line: oklch(31% 0.008 90);
    --hover: oklch(25% 0.008 90);
    --hold: oklch(79% 0.09 240);
    --go: oklch(79% 0.11 150);
    --stop: oklch(73% 0.15 27);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; -webkit-text-size-adjust: 100%; }
main { max-width: 28rem; margin: 0 auto; padding: max(3rem, env(safe-area-inset-top)) 1.25rem max(2rem, env(safe-area-inset-bottom)); }
p { margin: 0; }
.kicker { color: var(--muted); font-size: 0.9rem; }
h1 { margin: 0.15rem 0 0; font-size: 1.9rem; font-weight: 700; line-height: 1.15; letter-spacing: -0.015em; overflow-wrap: anywhere; text-wrap: balance; }
.card { margin-top: 0.6rem; font-size: 1.1rem; text-wrap: pretty; }
.amount { margin-top: 0.25rem; font-size: 1.6rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.controls { display: grid; gap: 0.6rem; margin-top: 2rem; }
button { min-height: 50px; padding: 0.6rem 1rem; border: 1px solid var(--line); border-radius: 12px; background: transparent; color: var(--text); font: inherit; font-weight: 600; cursor: pointer; transition: background-color 0.15s ease-out, border-color 0.15s ease-out; }
button:active { background: var(--hover); }
button:focus-visible { outline: 2px solid var(--hold); outline-offset: 2px; }
button:disabled { opacity: 0.55; cursor: default; }
button.primary { background: var(--text); border-color: var(--text); color: var(--bg); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
.note { min-height: 1.5em; margin-top: 1.25rem; color: var(--muted); text-wrap: pretty; }
.note.done { color: var(--go); }
.note.failed { color: var(--stop); }
[hidden] { display: none !important; }
`;

// Static, so the CSP names it by hash; what it shows comes from the
// options route and goes in as text, never as markup. Safari lets a page
// ask Face ID only from a tap, so each tap asks it before anything else.
const SCRIPT = String.raw`
"use strict";
{
  const [kicker, title, card, amount, go, no, note] = ["kicker", "title", "card", "amount", "go", "no", "note"].map((id) => document.getElementById(id));
  const base = location.pathname.replace(/\/+$/, "");
  const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const raw = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const NO_ANSWER = "The Mac did not answer. Check that it is awake, then try again.";
  let o;
  let made;

  const say = (text, tone) => {
    note.textContent = text;
    note.className = tone ? "note " + tone : "note";
  };
  const busy = (on) => {
    go.disabled = on;
    no.disabled = on;
  };
  const end = (text, tone) => {
    go.hidden = true;
    no.hidden = true;
    say(text, tone);
  };
  const NO_PRF = new Error("no PRF");

  function failed(e) {
    busy(false);
    if (e.name === "NotAllowedError") return say("Face ID was cancelled, or this browser cannot use it. Try again, or open the link in Safari.", "failed");
    if (e === NO_PRF) return end("This iPhone cannot keep the card's key. Update iOS, then ask for a new link.", "failed");
    if (e.status === 410) return end("This link has ended.", "failed");
    say(e.status ? e.message : NO_ANSWER, "failed");
  }

  async function post(body) {
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return;
    const answer = await r.json().catch(() => ({}));
    throw Object.assign(new Error(answer.error || "The Mac refused the answer."), { status: r.status });
  }

  // Face ID, then the passkey's signature on this request and its PRF output.
  async function sign(id) {
    const got = await navigator.credentials.get({ publicKey: {
      challenge: raw(o.challenge), rpId: o.rpId, userVerification: "required", timeout: 120000,
      allowCredentials: [{ type: "public-key", id: raw(id) }],
      extensions: { prf: { eval: { first: raw(o.salt) } } },
    } });
    const prf = got.getClientExtensionResults().prf;
    if (!prf || !prf.results || !prf.results.first) throw NO_PRF;
    const r = got.response;
    return { assertion: { id: b64(got.rawId), clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) }, prf: b64(prf.results.first) };
  }

  async function approve() {
    busy(true);
    say("Waiting for Face ID.");
    try {
      const signed = await sign(o.credential);
      say("Checking.");
      await post(signed);
      end("Approved. You can close this page.", "done");
    } catch (e) {
      failed(e);
    }
  }

  async function setUp() {
    busy(true);
    say("Waiting for Face ID.");
    try {
      if (!made) {
        const c = await navigator.credentials.create({ publicKey: {
          challenge: raw(o.create), rp: { id: o.rpId, name: "Safari Harness" },
          user: { id: raw(o.user), name: o.card, displayName: o.card },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
          attestation: "none", timeout: 120000,
          extensions: { prf: { eval: { first: raw(o.salt) } } },
        } });
        const prf = c.getClientExtensionResults().prf;
        if (!prf || prf.enabled === false) throw NO_PRF;
        const r = c.response;
        made = { id: b64(c.rawId), clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.getAuthenticatorData()), publicKey: b64(r.getPublicKey()), publicKeyAlgorithm: r.getPublicKeyAlgorithm() };
        go.textContent = "Confirm with Face ID";
        busy(false);
        say("Passkey made. Confirm with Face ID to finish.");
        return;
      }
      const signed = await sign(made.id);
      say("Checking.");
      await post({ registration: made, ...signed });
      end("Set up. While you are away from the Mac, card fills ask this iPhone.", "done");
    } catch (e) {
      failed(e);
    }
  }

  async function decline() {
    busy(true);
    try {
      await post({ decline: true });
      end(o.kind === "enroll" ? "Cancelled. Nothing was set up." : "Declined. Nothing was filled.");
    } catch (e) {
      failed(e);
    }
  }

  async function load() {
    if (!window.PublicKeyCredential) return end("This browser cannot use Face ID. Open the link in Safari.", "failed");
    try {
      const r = await fetch(base + "/options", { cache: "no-store" });
      if (r.status === 404 || r.status === 410) return end("This link has ended.", "failed");
      if (!r.ok) return end(NO_ANSWER, "failed");
      o = await r.json();
    } catch {
      return end(NO_ANSWER, "failed");
    }
    if (o.kind === "enroll") {
      kicker.textContent = "Face ID for card fills";
      title.textContent = o.card;
      card.textContent = "Approve card fills from this iPhone while you are away from the Mac.";
      go.textContent = "Set up with Face ID";
      no.textContent = "Cancel";
      go.addEventListener("click", setUp);
    } else {
      kicker.textContent = "Card fill on";
      title.textContent = o.site;
      card.textContent = o.card;
      amount.textContent = o.amount || "";
      amount.hidden = !o.amount;
      go.textContent = "Approve with Face ID";
      no.textContent = "Decline";
      go.addEventListener("click", approve);
    }
    no.addEventListener("click", decline);
    go.hidden = false;
    no.hidden = false;
    say("");
  }

  load();
}
`;

const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; script-src ${hash(SCRIPT)}; style-src ${hash(STYLE)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>Card approval</title><style>${STYLE}</style></head><body><main><p class="kicker" id="kicker"></p><h1 id="title">Card approval</h1><p class="card" id="card"></p><p class="amount" id="amount" hidden></p><div class="controls"><button type="button" class="primary" id="go" hidden></button><button type="button" id="no" hidden></button></div><p class="note" id="note" role="status" aria-live="polite">Loading.</p></main><script>${SCRIPT}</script></body></html>`;
