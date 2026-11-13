// An agent's step the user approves on his iPhone with Face ID while he is
// away from the Mac. omp's approval gate (omp/approvals.ts) shows its
// popup on the Mac and, while he is away, opens the same request here
// (approval_phone_open): one alert takes his phone a link to the approval
// page (passkey.ts's server, on his tailnet only), which shows the request
// as the popup does. Approve asks Face ID for the approvals passkey
// (userVerification required) over the request's single-use challenge;
// the request reads approved only once passkey.ts's checks pass: that
// challenge, the page's origin and rpId, Face ID's verification (UV), and
// the passkey's ES256 signature. Deny needs no Face ID. The gate reads the
// answer (approval_phone_state) and closes the request once it has one
// (approval_phone_close): answered on the Mac first, the page says so.
//
// The link names a request by a token of its own: the id the gate holds
// shows in the agents page's call list. The approvals passkey is made once,
// at the Mac (safari passwords approvals-phone, by approval_phone_setup):
// this Mac keeps its public key and id alone (phone-approvals.json, 0600).
// A request lasts LIVE_MS, and its answer can be read for as long again.
// A model's own call is refused.

import { createHash, randomBytes } from "node:crypto";
import { HarnessError } from "./failures.ts";
import { fromModel } from "./guard.ts";
import { asserted, b64, type Credential, json, listen, pageHeaders, pageOrigin, Refused, record, registered } from "./passkey.ts";
import { alert, dataFile, readJson, writeJson } from "./phone.ts";
import type { Tool } from "./tools.ts";

const LIVE_MS = 10 * 60_000;
const FILE = "phone-approvals.json";
const SETUP = "safari passwords approvals-phone";
const NEXT = `the popup on the Mac still asks; the user sets his iPhone up once, at the Mac, with ${SETUP}`;
// Who asks, as the popup on the Mac names it.
const ASKER = "omp";
const ROWS = 8;
// The approvals passkey's user handle on his phone, the same each time:
// setting it up again replaces the passkey there.
const USER = b64(createHash("sha256").update("safari-harness approvals").digest().subarray(0, 16));
const ENDED = "This link has ended";

type Row = { lead: string; value: string; mono?: true };
// What the page shows: the approval surface's title, its one line (mono:
// a command), its rows, and its buttons' words.
type View = { title: string; line?: string; mono?: true; rows: Row[]; approve: string; deny: string };
type State = "pending" | "approved" | "denied" | "expired";
type Asked = {
  id: string;
  token: string;
  origin: string;
  rpId: string;
  challenge: string;
  until: number;
  answer?: "approved" | "denied";
  closed?: true;
} & ({ kind: "setup" } | { kind: "approve"; credential: Credential; view: View });
type Opened = { id: string; link: string; alerted: boolean; why?: string };

const SETUP_VIEW: View = { title: "Approvals on this iPhone", line: "While you are away from the Mac, an agent's request comes here", rows: [], approve: "Set up", deny: "Cancel" };

const requests = new Map<string, Asked>();

// One line of a request as the page shows it: control and direction
// characters become spaces, and past most it is cut.
function clean(v: unknown, what: string, most: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HarnessError("invalid_argument", `${what} must be text`);
  const chars = Array.from(v.replace(/[\p{Cc}\p{Bidi_Control}\s]+/gu, " ").trim());
  if (chars.length === 0) return undefined;
  return chars.length > most ? `${chars.slice(0, most - 1).join("")}…` : chars.join("");
}

function needed(v: unknown, what: string, most: number): string {
  const s = clean(v, what, most);
  if (s === undefined) throw new HarnessError("invalid_argument", `${what} is required`);
  return s;
}

function rowsOf(v: unknown): Row[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > ROWS) throw new HarnessError("invalid_argument", `request.rows must be a list of at most ${ROWS} rows`);
  return v.map((x, i) => {
    const row = record(x);
    return { lead: needed(row.lead, `request.rows[${i}].lead`, 40), value: needed(row.value, `request.rows[${i}].value`, 500), ...(row.mono === true ? { mono: true as const } : {}) };
  });
}

// The request's title, line, and rows, or, for a request without them,
// the same parts made of its item, detail, place, and the agent's purpose.
function viewOf(r: Record<string, unknown>, verb: string): View {
  const item = record(r.item);
  const title = clean(r.title, "request.title", 200) ?? needed(item.name, "request.item.name", 200);
  const line = clean(r.line, "request.line", 300) ?? clean(r.detail, "request.detail", 500);
  const sub = clean(item.sub, "request.item.sub", 200);
  const where = clean(r.where, "request.where", 253);
  const purpose = clean(r.purpose, "request.purpose", 500);
  const rows = rowsOf(r.rows) ?? [
    { lead: "Asks to", value: verb },
    ...(sub === undefined ? [] : [{ lead: "Detail", value: sub }]),
    ...(where === undefined || where === title ? [] : [{ lead: "On", value: where }]),
    ...(purpose === undefined ? [] : [{ lead: "For", value: purpose }]),
  ];
  const approve = clean(r.approve, "request.approve", 30) ?? "Approve";
  const deny = clean(r.deny, "request.deny", 30) ?? "Deny";
  return { title, ...(line === undefined ? {} : { line }), ...(r.mono === true && line !== undefined ? { mono: true as const } : {}), rows, approve, deny };
}

function enrolled(): { rpId: string; credential: Credential } | undefined {
  const e = record(readJson(dataFile(FILE)));
  const c = record(e.credential);
  return typeof e.rpId === "string" && typeof c.id === "string" && typeof c.key === "string" ? { rpId: e.rpId, credential: { id: c.id, key: c.key } } : undefined;
}

function stateOf(q: Asked | undefined, now: number): State {
  if (q?.answer) return q.answer;
  return !q || q.closed || now >= q.until ? "expired" : "pending";
}

// Why the page can no longer answer q, if it cannot.
function over(q: Asked | undefined, now: number): string | undefined {
  if (q?.answer === "approved") return q.kind === "setup" ? "Set up already" : "Approved already";
  if (q?.answer === "denied") return q.kind === "setup" ? "Cancelled already" : "Denied already";
  if (q?.closed) return "Answered on the Mac";
  return !q || now >= q.until ? ENDED : undefined;
}

// Forgets the requests whose answer no one may read anymore.
function sweep(now: number): void {
  for (const [id, q] of requests) if (now >= q.until + LIVE_MS) requests.delete(id);
}

function made(kind: { kind: "setup" } | { kind: "approve"; credential: Credential; view: View }, origin: string): Asked {
  listen("a", approvalPage);
  const q: Asked = { id: b64(randomBytes(16)), token: b64(randomBytes(16)), origin, rpId: new URL(origin).hostname, challenge: b64(randomBytes(32)), until: Date.now() + LIVE_MS, ...kind };
  requests.set(q.id, q);
  return q;
}

// Sends his phone the request's link after text. An alert that fails
// leaves the request open, and says why.
async function sent(q: Asked, text: string): Promise<Opened> {
  const link = `${q.origin}/a/${q.token}`;
  try {
    await alert(`${text}\n${link}`);
  } catch (e) {
    return { id: q.id, link, alerted: false, why: e instanceof Error ? e.message : String(e) };
  }
  return { id: q.id, link, alerted: true };
}

async function open(a: Record<string, unknown>): Promise<Opened> {
  const r = record(a.request);
  const verb = needed(r.verb, "request.verb", 80);
  const view = viewOf(r, verb);
  const e = enrolled();
  if (!e) throw new HarnessError("unavailable", `Face ID approvals on the user's iPhone are not set up: at the Mac, run ${SETUP}`, { effect: "none", retryable: false, next: NEXT });
  const origin = await pageOrigin();
  const rpId = new URL(origin).hostname;
  if (e.rpId !== rpId) throw new HarnessError("unavailable", `the approval page is now on ${rpId}, and the approvals passkey is for ${e.rpId}: at the Mac, run ${SETUP} again`, { effect: "none", retryable: false, next: NEXT });
  const q = made({ kind: "approve", credential: e.credential, view }, origin);
  const test = process.env.SAFARI_HARNESS_AWAY === "1" ? "test of the approval alert: " : "";
  return sent(q, `${test}${ASKER} wants to ${verb}. approve with face id, or deny. open this link in safari:`);
}

function approvalPage(r: Request, token: string, asked: boolean): Promise<Response> | Response {
  const now = Date.now();
  sweep(now);
  const q = [...requests.values()].find((x) => x.token === token);
  if (asked) return r.method === "GET" ? options(q, now) : json(405, { error: "Not allowed." });
  if (r.method === "GET") return new Response(PAGE, { headers: HEADERS });
  if (r.method === "POST") return answered(q, r);
  return json(405, { error: "Not allowed." });
}

// What the page needs to ask Face ID, and to show the request.
function options(q: Asked | undefined, now: number): Response {
  const ended = over(q, now);
  if (ended !== undefined || !q) return json(410, { error: ended ?? ENDED });
  if (q.kind === "setup") return json(200, { kind: "setup", rpId: q.rpId, challenge: q.challenge, user: USER, asker: "Your Mac", ...SETUP_VIEW });
  return json(200, { kind: "approve", rpId: q.rpId, challenge: q.challenge, credential: q.credential.id, asker: ASKER, ...q.view });
}

async function answered(q: Asked | undefined, r: Request): Promise<Response> {
  const ended = over(q, Date.now());
  if (ended !== undefined || !q) return json(410, { error: ended ?? ENDED });
  if (r.headers.get("origin") !== q.origin) return json(403, { error: "This answer came from another page." });
  if (!(r.headers.get("content-type") ?? "").startsWith("application/json")) return json(415, { error: "The answer was not JSON." });
  let body: Record<string, unknown>;
  try {
    body = record(await r.json());
  } catch {
    return json(400, { error: "The answer was not readable." });
  }
  // The Mac's answer, or the request's end, may have come meanwhile.
  const since = over(q, Date.now());
  if (since !== undefined) return json(410, { error: since });
  if (body.deny === true) {
    q.answer = "denied";
    return json(200, { ok: true });
  }
  let credential: Credential | undefined;
  try {
    if (q.kind === "setup") credential = registered(q, q.challenge, body.registration);
    else asserted(q, q.credential, body.assertion);
  } catch (e) {
    return json(403, { error: e instanceof Refused ? e.message : "The answer did not check out." });
  }
  if (credential) writeJson(dataFile(FILE), { rpId: q.rpId, credential, at: new Date().toISOString() }, 0o600);
  q.answer = "approved";
  return json(200, { ok: true });
}

// Refuses a model's call: only the user answers an approval.
function own(tool: string): void {
  if (fromModel()) throw new Error(`${tool} is the harness's own: an agent's step waits on the user's own answer`);
}

export const APPROVAL_PHONE = {
  open: {
    desc: "The harness's own: the approval gate's request on the user's phone, for Face ID; his phone gets its link.",
    params: { request: { type: "object", description: "verb, kind, item {name, sub}, purpose, detail, where, title, line, rows [{lead, value, mono}], approve, deny" } },
    required: ["request"],
    hidden: true,
    run: async (a) => {
      own("approval_phone_open");
      sweep(Date.now());
      return open(a);
    },
  },
  state: {
    desc: "The harness's own: a phone request's state: pending, approved, denied, or expired.",
    params: { id: { type: "string", description: "approval_phone_open's id" } },
    required: ["id"],
    hidden: true,
    run: async (a) => {
      own("approval_phone_state");
      const now = Date.now();
      sweep(now);
      return { state: stateOf(typeof a.id === "string" ? requests.get(a.id) : undefined, now) };
    },
  },
  close: {
    desc: "The harness's own: ends a phone request answered on the Mac; its page says so.",
    params: { id: { type: "string", description: "approval_phone_open's id" } },
    required: ["id"],
    hidden: true,
    run: async (a) => {
      own("approval_phone_close");
      const q = typeof a.id === "string" ? requests.get(a.id) : undefined;
      if (q && !q.answer) q.closed = true;
      return { closed: true };
    },
  },
  setup: {
    desc: "The harness's own: the approvals passkey's setup on the user's phone (safari passwords approvals-phone); his phone gets its link.",
    params: {},
    hidden: true,
    run: async () => {
      own("approval_phone_setup");
      sweep(Date.now());
      const q = made({ kind: "setup" }, await pageOrigin());
      return sent(q, "set up face id for agent approvals. open this link in safari on your iphone:");
    },
  },
} satisfies Record<string, Tool>;

const STYLE = String.raw`
:root {
  color-scheme: light dark;
  --canvas: #f7f7f5;
  --card: #ffffff;
  --raised: #f1f1ee;
  --edge: rgb(20 20 19 / 0.1);
  --ink: #141413;
  --muted: rgb(20 20 19 / 0.66);
  --faint: rgb(20 20 19 / 0.52);
  --clay: #b5532f;
  --good: #1a7f37;
  --bad: #c42b1c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0a0a0a;
    --card: #141414;
    --raised: #1c1c1c;
    --edge: rgb(255 255 255 / 0.08);
    --ink: #f5f5f4;
    --muted: rgb(245 245 244 / 0.66);
    --faint: rgb(245 245 244 / 0.46);
    --clay: #d97757;
    --good: #4ade80;
    --bad: #f87171;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--canvas);
  color: var(--ink);
  font: 400 15px/23px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 34rem; margin: 0 auto; padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); }
h1, p, dl, dd { margin: 0; }
.card { padding: 32px; border: 1px solid var(--edge); border-radius: 16px; background: var(--card); }
@media (max-width: 600px) { .card { padding: 24px; } }
.head { display: flex; align-items: center; gap: 12px; font-size: 13px; line-height: 18px; }
.state { display: inline-flex; align-items: center; gap: 8px; }
.state.needs { color: var(--muted); }
.state.good { color: var(--good); }
.state.bad { color: var(--bad); }
.state.quiet { color: var(--muted); }
.glyph { display: none; flex: none; width: 14px; height: 14px; }
.glyph path { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.state.needs .glyph.needs, .state.good .glyph.good, .state.bad .glyph.bad { display: block; }
.glyph.needs circle { fill: var(--clay); }
.glyph.needs path { stroke: var(--card); }
.glyph.needs .dot { fill: var(--card); }
h1 { margin-top: 20px; font-size: 28px; line-height: 34px; font-weight: 500; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.line { margin-top: 8px; color: var(--muted); overflow-wrap: anywhere; }
.line.mono { line-height: 20px; }
hr { margin: 20px 0; border: 0; border-top: 1px solid var(--edge); }
.rows { display: grid; gap: 8px; }
.row { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: 12px; }
.row dt { color: var(--faint); }
.row dd { overflow-wrap: anywhere; unicode-bidi: plaintext; }
.mono { font-family: "Berkeley Mono", "SF Mono", ui-monospace, monospace; font-size: 13px; }
.controls { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 28px; }
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 10px 16px;
  border: 1px solid var(--edge);
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
}
button.approve { border-color: var(--ink); background: var(--ink); color: var(--card); font-weight: 500; }
@media (hover: hover) {
  button:hover { background: var(--raised); }
  button.approve:hover { border-color: var(--muted); background: var(--muted); }
}
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
button:disabled { opacity: 0.5; cursor: default; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
.note { margin-top: 16px; color: var(--muted); font-size: 13px; line-height: 18px; }
.note.bad { color: var(--bad); }
.note:empty { display: none; }
[hidden] { display: none !important; }
`;

// Static, so the CSP names it by hash; what it shows comes from the
// options route and goes in as text, never as markup. Safari lets a page
// ask Face ID only from a tap, so each tap asks it before anything else.
const SCRIPT = String.raw`
"use strict";
{
  const [state, word, shown, title, line, rule, rows, act, go, goText, no, noText, note] = ["state", "word", "shown", "title", "line", "rule", "rows", "act", "go", "goText", "no", "noText", "note"].map((id) => document.getElementById(id));
  const base = location.pathname.replace(/\/+$/, "");
  const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const raw = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const NO_ANSWER = "The Mac did not answer. Check that it is awake, then try again";
  let o;
  let busy = false;
  let over = false;
  let poll;

  const say = (text, bad) => {
    note.textContent = text;
    note.className = bad ? "note bad" : "note";
  };
  const hold = (on) => {
    busy = on;
    go.disabled = on;
    no.disabled = on;
  };
  // tone: good or bad, with its glyph; quiet, the word alone
  const end = (text, tone, after) => {
    over = true;
    clearInterval(poll);
    act.hidden = true;
    state.className = "state " + tone;
    word.textContent = text;
    say(after || "");
  };

  function failed(e) {
    hold(false);
    if (e.name === "NotAllowedError") return say("Face ID was cancelled, or this browser cannot use it. Try again, or open the link in Safari", true);
    if (e.status === 410) return end(e.message, "quiet");
    say(e.status ? e.message : NO_ANSWER, true);
  }

  async function post(body) {
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return;
    const answer = await r.json().catch(() => ({}));
    throw Object.assign(new Error(answer.error || "The Mac refused the answer"), { status: r.status });
  }

  async function approve() {
    if (busy || over) return;
    hold(true);
    say("Waiting for Face ID");
    try {
      const got = await navigator.credentials.get({ publicKey: {
        challenge: raw(o.challenge),
        rpId: o.rpId,
        userVerification: "required",
        timeout: 120000,
        allowCredentials: [{ type: "public-key", id: raw(o.credential) }],
      } });
      const r = got.response;
      say("Checking");
      await post({ assertion: { id: b64(got.rawId), clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) } });
      end("Approved", "good", "You can close this page");
    } catch (e) {
      failed(e);
    }
  }

  async function setUp() {
    if (busy || over) return;
    hold(true);
    say("Waiting for Face ID");
    try {
      const made = await navigator.credentials.create({ publicKey: {
        challenge: raw(o.challenge),
        rp: { id: o.rpId, name: "Safari Harness" },
        user: { id: raw(o.user), name: "Agent approvals", displayName: "Agent approvals" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
        timeout: 120000,
      } });
      const r = made.response;
      say("Checking");
      await post({ registration: { id: b64(made.rawId), clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.getAuthenticatorData()), publicKey: b64(r.getPublicKey()), publicKeyAlgorithm: r.getPublicKeyAlgorithm() } });
      end("Set up", "good", "While you are away from the Mac, agents' requests come to this iPhone");
    } catch (e) {
      failed(e);
    }
  }

  async function deny() {
    if (busy || over) return;
    hold(true);
    try {
      await post({ deny: true });
      if (o.kind === "setup") end("Cancelled", "quiet", "Nothing was set up");
      else end("Denied", "bad");
    } catch (e) {
      failed(e);
    }
  }

  // The popup on the Mac may be answered first, or the request end: the
  // page says so without a tap.
  async function check() {
    if (busy || over) return;
    try {
      const r = await fetch(base + "/options", { cache: "no-store" });
      if (r.status !== 404 && r.status !== 410) return;
      const answer = await r.json().catch(() => ({}));
      if (!busy && !over) end(answer.error || "This link has ended", "quiet");
    } catch {
      // the next check asks again
    }
  }

  function row(x) {
    const div = document.createElement("div");
    const lead = document.createElement("dt");
    const value = document.createElement("dd");
    div.className = "row";
    lead.textContent = x.lead;
    value.textContent = x.value;
    if (x.mono) value.className = "mono";
    div.append(lead, value);
    return div;
  }

  async function load() {
    if (!window.PublicKeyCredential) return end("Open this link in Safari", "quiet", "This browser cannot use Face ID");
    try {
      const r = await fetch(base + "/options", { cache: "no-store" });
      if (r.status === 404 || r.status === 410) {
        const answer = await r.json().catch(() => ({}));
        return end(answer.error || "This link has ended", "quiet");
      }
      if (!r.ok) return end("No answer from the Mac", "bad", NO_ANSWER);
      o = await r.json();
    } catch {
      return end("No answer from the Mac", "bad", NO_ANSWER);
    }
    const yes = o.kind === "setup" ? setUp : approve;
    word.textContent = o.asker;
    title.textContent = o.title;
    line.textContent = o.line || "";
    line.className = o.mono ? "line mono" : "line";
    line.hidden = !o.line;
    rows.replaceChildren(...o.rows.map(row));
    rows.hidden = o.rows.length === 0;
    rule.hidden = o.rows.length === 0;
    goText.textContent = o.approve;
    noText.textContent = o.deny;
    go.addEventListener("click", yes);
    no.addEventListener("click", deny);
    document.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Escape") deny();
      // Enter on a button presses that button.
      else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) yes();
    });
    shown.hidden = false;
    say("");
    poll = setInterval(check, 5000);
  }

  load();
}
`;

const HEADERS = pageHeaders(SCRIPT, STYLE);

const GLYPHS = `<svg class="glyph needs" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7"/><path d="M7 3.75v4"/><circle class="dot" cx="7" cy="10.25" r="0.85"/></svg><svg class="glyph good" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.25 7.25l2.5 2.5 5-5.5"/></svg><svg class="glyph bad" viewBox="0 0 14 14" aria-hidden="true"><path d="M4.25 4.25l5.5 5.5m0-5.5l-5.5 5.5"/></svg>`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>Approval</title><style>${STYLE}</style></head><body><main><section class="card"><header class="head"><span class="state needs" id="state">${GLYPHS}<span id="word"></span></span></header><div id="shown" hidden><h1 id="title"></h1><p class="line" id="line" hidden></p><hr id="rule" hidden><dl class="rows" id="rows" hidden></dl><div id="act" class="controls"><button type="button" id="no"><span id="noText">Deny</span></button><button type="button" class="approve" id="go"><span id="goText">Approve</span></button></div></div><p class="note" id="note" role="status" aria-live="polite">Loading</p></section></main><script>${SCRIPT}</script></body></html>`;
