// Codes typed without the agent seeing them. A type whose text has {{code}}
// waits up to 30 s for the code the site sent and types it there: one
// texted to him (Messages) from the start, and one mailed to his Gmail
// (sites/google.ts) once 10 s pass with none by text. secret: "sms" waits
// for a text alone and "mail" for mail alone, from the start; sender takes
// a code only from that number, address, or domain, and account picks the
// Gmail account (0 by default). secret: "page" types the one code shown in
// tab from (an opened email), within from_selector when given; secret:
// "env" types the value of variable env in the caller's environment;
// secret: "passwords" types the code his Apple Passwords keeps for the
// site. real_input's type takes the same, for a field that ignores
// scripted typing. The answer says only how many characters went in, and
// where a sent code came from, so the code stays out of the transcript, the
// journal, and the logs: on 01a0e50b an agent typed an emailed code by hand
// and type echoed it back. Runs in the caller (call.ts), where Messages can
// be read (imessage.ts).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FILL_TOOLS } from "./fill.ts";
import { nameIn } from "./guard.ts";
import { CODE_POLL_MS, codeTexts, handleKey, type CodeText, type CodeTexts } from "./imessage.ts";
import { site } from "./receipt.ts";
import { rpc } from "./rpc.ts";
import type { GmailThreadSummary } from "./sites/google.ts";

const CODE = "{{code}}";

// A type or real_input call that needs a code filled in. real_input's text
// may come as type (guard.ts).
export function secretType(tool: string, args: Record<string, unknown>): boolean {
  const coded = [args.text, args.type].some((t) => typeof t === "string" && t.includes(CODE));
  return nameIn(["type", "real_input"], tool) !== undefined && (args.secret !== undefined || coded);
}

// Types the code a's source gives with put, which types text as its tool
// does. model: the call is one a model wrote, which the daemon watches
// (guard.ts). caller: the environment secret "env" reads (heldValue).
export async function typeSecret(a: Record<string, unknown>, model: boolean, put: (text: string) => Promise<unknown>, caller?: CallerEnv): Promise<unknown> {
  const source = a.secret;
  if (source === "passwords") {
    // Apple Passwords finds the page's code field and types into it itself.
    const r = await FILL_TOOLS.passwords.run({ do: "code", tab: a.tab });
    return r && typeof r === "object" && !("paired" in r) ? { ...r, typed: "code" } : r;
  }
  if (source !== undefined && source !== "sms" && source !== "mail" && source !== "page" && source !== "env") throw new Error('secret must be "sms", "mail", "page", "env", or "passwords"');
  const text = typeof a.text === "string" ? a.text : "";
  if (!text.includes(CODE)) throw new Error(`put ${CODE} in text where the code goes`);
  const sent = source === "page" || source === "env" ? undefined : await sentCode(a, source);
  const code = sent?.code ?? (source === "page" ? await shownCode(a.from, a.from_selector, model) : heldValue(a.env, caller));
  // however the page shows it again, the tab's answers have it cut from
  // here on (redact.ts)
  await rpc("keep_secret", { tab: a.tab, texts: [code] });
  const answer = await put(text.replaceAll(CODE, code));
  if (!answer || typeof answer !== "object" || !("ok" in answer)) return answer;
  if (sent && answer.ok !== false) markTyped(sent.key);
  return { ...answer, typed: `code, ${code.length} chars`, ...(sent ? { source: sent.source } : {}) };
}

// The environment of whoever ran the safari CLI, which hands it to its
// tool call (cli/safari.ts), as a vault's runner sets it: mem-secret run
// VAR -- safari ... An MCP server's or a safari do session's own
// environment is no caller's, and holds keys of its own (SAFARI_MODEL_KEY)
// that a page's text could ask a model to type into the page.
export type CallerEnv = Record<string, string | undefined>;

// The value of variable name in the caller's environment. On 10-05 a new
// password, a sign-in code, and a reset link each went through a file on
// disk to reach their fields, since type took none of them from there.
function heldValue(name: unknown, caller: CallerEnv | undefined): string {
  if (typeof name !== "string" || !name) throw new Error('secret "env" needs env: the name of the variable that holds the value');
  const run = `mem-secret run ${name} -- safari type <ref> '{{code}}' --tab N --secret env --env ${name}`;
  if (!caller) throw new Error(`secret "env" reads only the environment of a safari CLI call, as in: ${run}`);
  const value = caller[name];
  if (!value) throw new Error(`environment variable ${name} is empty or not set; set it in the environment of the safari CLI call, as in: ${run}`);
  return value;
}

// The codes text shows: a run of 4 to 8 digits standing alone, or of 6 to
// 8 capital letters and digits with both (GEICO's, 09-30) on a line that
// says code, or just under one, since such a run elsewhere is an order or
// policy number; those 6 long when there are several lengths. A run
// touching a letter is part of a word, as the "recentdata" Gmail puts after
// Delta's footer (09-29), and one after © is a year: Gmail's page for a
// thread it could not find typed its footer's 2026 into TikTok's code field
// (10-02). A period may end the sentence a code ends, as mailed codes do
// ("Your code is 482915."): on 11-11 such a mail's ZIP code was the only
// code it was taken to show.
function codesIn(shown: string): string[] {
  const mixed = [...shown.matchAll(/(?<![\w.,:/-])(?=[A-Z\d]*\d)(?=[A-Z\d]*[A-Z])[A-Z\d]{6,8}(?![\w,:/-]|\.\w)/g)].filter((m) => {
    const lines = shown.slice(0, m.index).split("\n");
    const own = lines.pop() ?? "";
    return /\b(?:code|passcode|otp|pin)\b/i.test(own.trim() ? own : lines.findLast((l) => l.trim()) ?? "");
  });
  const all = [...new Set([...(shown.match(/(?<![\w.,:/-]|©\s?)\d{4,8}(?![\w,:/-]|\.\w)/g) ?? []), ...mixed.map((m) => m[0])])];
  const six = all.filter((c) => c.length === 6);
  return six.length ? six : all;
}

// The one code tab from shows. Any other count is an error that says only
// how many, never which.
async function shownCode(from: unknown, selector: unknown, model: boolean): Promise<string> {
  if (typeof from !== "number") throw new Error('secret "page" needs from: the tab that shows the code, such as the opened email');
  if (selector !== undefined && (typeof selector !== "string" || !selector.trim())) throw new Error("from_selector must be a nonempty CSS selector for one email or message");
  const page = await rpc("extract", { tab: from, save: false, ...(selector === undefined ? {} : { selector, strict_selector: true }) }, model);
  const codes = codesIn(page && typeof page === "object" && "text" in page && typeof page.text === "string" ? page.text : "");
  if (codes.length !== 1) throw new Error(`tab ${from} shows ${codes.length} codes, not one; open the email with the code in that tab, or use from_selector to select one email or message in the thread, then call type again`);
  return codes[0];
}

// ---------- codes the site sent ----------

// How long a sent code may take to come.
const WAIT_MS = 30_000;
// Gmail waits 10 s on a text, as a code texted at once needs no Gmail tab,
// which takes 10 s to open (the median of the week to 11-11).
const MAIL_AFTER_MS = 10_000;
// A code often lands before the call, sent for before the field was found.
const BEFORE_MS = 60_000;
// Gmail is searched every 2 s, as waitForMail does: about 0.6 s a search.
const LOOK_MS = 2_000;

// A code the site may have sent. key names the message it came in, never
// the code.
type Sent = { code: string; at: number; key: string; source: string };

// The page's host and site (shop.example), and the name before the site's
// domain ("shop") when that is 3 letters or more, a word a text can name it
// by. A form, site, or script anyone can make on Google's domain is a site
// of its own: in the 11-11 review a form on docs.google.com that asked for
// "the code we sent" got his Google code.
type Site = { host?: string; domain?: string; name?: string };
const GOOGLE_USER_HOSTS = /^(?:docs|sites|script)\.google\.com$/;

async function siteOf(tab: unknown): Promise<Site> {
  const page = await rpc("info", { tab });
  const url = page && typeof page === "object" && "url" in page && typeof page.url === "string" ? URL.parse(page.url) : null;
  if (!url || !/^https?:$/.test(url.protocol) || !url.hostname) return {};
  const host = url.hostname.toLowerCase();
  if (GOOGLE_USER_HOSTS.test(host)) return { host, domain: host };
  const domain = site(host);
  const name = domain.split(".")[0];
  return { host, domain, ...(name.length >= 3 && /[a-z]/.test(name) ? { name } : {}) };
}

// Whether text names the site: its domain, or its name as one to three
// words ("Wells Fargo" for wellsfargo.com).
function names(text: string, s: Site): boolean {
  if (s.domain === undefined) return false;
  if (new RegExp(`(?<![\\w-])${s.domain.replaceAll(".", "\\.")}(?![\\w-]|\\.\\w)`, "i").test(text)) return true;
  const name = s.name?.replaceAll("-", "");
  const words = text.toLowerCase().split(/[^a-z\d]+/);
  return name !== undefined && words.some((_, i) => [1, 2, 3].some((n) => words.slice(i, i + n).join("") === name));
}

// sender as a call gives it: the number or short code a code is texted
// from, or the address or domain it is mailed from.
function senderOf(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const s = (typeof v === "number" ? String(v) : typeof v === "string" ? v : "").trim().toLowerCase();
  if (/^\+?[\d\s().-]+$/.test(s) && s.replace(/\D/g, "").length >= 3) return s;
  if (/^(?:[\w.+-]+@)?[a-z\d-]+(?:\.[a-z\d-]+)+$/.test(s)) return s;
  throw new Error("sender must be the number or short code the code is texted from, or the address or domain it is mailed from");
}

const byPhone = (sender: string) => !/[a-z@]/.test(sender);

// Whether from, a text's handle or a mail's address, is sender's.
function fromSender(from: string, sender: string): boolean {
  const f = from.toLowerCase();
  if (byPhone(sender)) return handleKey(f) === handleKey(sender);
  return sender.includes("@") ? f === sender : f.endsWith(`@${sender}`) || f.endsWith(`.${sender}`);
}

// What texts offer, sender's alone when given: codes in texts bound to the
// page's host or one above it (WebOTP), or else naming its site, as most
// name their brand ("Shop Example: 482915 is your code"); from sender, any
// unbound text. skipped notes the rest. Until the 11-11 review a text that
// named no site was taken too, so a code another site texted in the same
// minute went into the page that asked.
function fromTexts(texts: CodeText[], s: Site, sender: string | undefined, typed: Set<string>, skipped: Set<string>): Sent[] {
  return texts.flatMap((t) => {
    const key = `text:${t.rowid}`;
    const source = `text from ${t.from}`;
    if (sender !== undefined && !fromSender(t.handle, sender)) return [];
    if (typed.has(key)) {
      skipped.add(`a code typed before (${source})`);
      return [];
    }
    if (t.bound !== undefined && t.bound !== s.host && !s.host?.endsWith(`.${t.bound}`)) {
      skipped.add(`a code for ${t.bound} (${source})`);
      return [];
    }
    if (t.bound === undefined && sender === undefined && !names(t.text, s)) {
      skipped.add(`a code that does not name ${s.domain ?? "the page's site"} (${source})`);
      return [];
    }
    return [{ code: t.code, at: t.at, key, source }];
  });
}

type MailWatch = { looked(): boolean; failed(): string | undefined; stop(): Promise<void> };

// Looks in Gmail every 2 s for mail from the page's domain, or from sender
// when given, that came after since, and adds the code of each to found;
// mail that shows other than one code is skipped. Until the 11-11 review
// mail that named the domain counted from any sender, a lookalike's too.
// stop ends it, its Gmail tab closed. Gmail's kit loads only for a mailed
// code: every CLI call and MCP server loads this file, and a static import
// put sites/google.ts and sites/kit.ts in each (startup.test.ts).
async function watchMail(s: Site, sender: string | undefined, account: unknown, since: number, typed: Set<string>, skipped: Set<string>, found: Sent[]): Promise<MailWatch> {
  const { gmail } = await import("./sites/google.ts");
  const { SiteKit } = await import("./sites/kit.ts");
  const kit = new SiteKit((tool, args) => rpc(tool, args));
  const mail = gmail(kit);
  const box = typeof account === "number" || typeof account === "string" ? account : 0;
  const query = `from:${sender ?? s.domain}`;
  let looks = 0;
  let stopped = false;
  let failed: string | undefined;
  let wake = () => {};

  async function read(t: GmailThreadSummary): Promise<void> {
    const key = `mail:${box}:${t.threadId}:${t.date}`;
    const thread = await mail.getThread(box, t.id);
    const m = thread.messages.at(-1);
    if (!m) return;
    const source = `mail from ${m.from.email}`;
    if (typed.has(key)) {
      skipped.add(`a code typed before (${source})`);
      return;
    }
    const domain = m.from.email.split("@")[1]?.toLowerCase() ?? "";
    if (sender === undefined ? site(domain) !== s.domain : !fromSender(m.from.email, sender)) {
      skipped.add(`${source}, not from ${sender ?? s.domain}`);
      return;
    }
    const codes = codesIn(`${thread.subject}\n${m.body}`);
    if (codes.length !== 1) {
      skipped.add(`${source}, which shows ${codes.length} codes, not one`);
      return;
    }
    found.push({ code: codes[0], at: Date.parse(t.date) || Date.now(), key, source });
  }

  const run = (async () => {
    let after = since;
    while (!stopped) {
      const got = await mail.waitForMail(box, query, { since: after, ms: 0 });
      looks++;
      if (got.status === "received") {
        after = got.since;
        for (const t of got.results) if (!stopped) await read(t);
      }
      if (stopped) break;
      const nap = Promise.withResolvers<void>();
      const timer = setTimeout(nap.resolve, LOOK_MS);
      wake = () => {
        clearTimeout(timer);
        nap.resolve();
      };
      await nap.promise;
    }
  })().catch((e: unknown) => {
    failed = e instanceof Error ? e.message : String(e);
  });

  return {
    looked: () => looks > 0,
    failed: () => failed,
    // A look still out finishes first: a call in a tab closed under it
    // would open another (kit.ts). The first look opens Gmail, which may
    // take 45 s (google.ts), so the answer waits only for a later one: in
    // the 11-11 review a code texted 11 s in waited until 35.7 s for a
    // Gmail that took 25 s to open. A caller that exits first leaves that
    // tab to the daemon, which closes it as the caller's turn ends.
    stop() {
      stopped = true;
      wake();
      const closed = run.then(() => kit.close()).then(() => {});
      return looks > 0 || failed !== undefined ? closed : Promise.resolve();
    },
  };
}

// The code the page's site sent for a, by text unless source is "mail",
// and by mail unless it is "sms" or sender is a number: the newest.
async function sentCode(a: Record<string, unknown>, source: "sms" | "mail" | undefined): Promise<Sent> {
  const sender = senderOf(a.sender);
  const s = await siteOf(a.tab);
  const start = Date.now();
  const typed = typedKeys();
  const skipped = new Set<string>();
  const problems: string[] = [];
  const found: Sent[] = [];
  let texts: CodeTexts | undefined;
  const byMail = source === "mail" || (source === undefined && !(sender !== undefined && byPhone(sender)));
  if (source === "mail" && s.domain === undefined && sender === undefined) throw new Error(`tab ${String(a.tab)} has no web address to match mail to; call type again with sender: the address or domain the code is mailed from`);
  const mailable = byMail && (s.domain !== undefined || sender !== undefined);
  if (source !== "mail") {
    try {
      texts = codeTexts({ since: start - BEFORE_MS });
    } catch (e) {
      if (!mailable) throw e;
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  const mailFrom = !texts || source === "mail" || (sender !== undefined && !byPhone(sender)) ? start : start + MAIL_AFTER_MS;
  let mail: MailWatch | undefined;
  try {
    for (;;) {
      if (texts) found.push(...fromTexts(texts.read(), s, sender, typed, skipped));
      found.sort((x, y) => x.at - y.at);
      const best = found.at(-1);
      if (best) return best;
      if (mailable && !mail && Date.now() >= mailFrom) mail = await watchMail(s, sender, a.account, start - BEFORE_MS, typed, skipped, found);
      const failed = mail?.failed();
      if (failed !== undefined && !texts) throw new Error(`Gmail could not be read: ${failed}${problems.length ? `; ${problems.join("; ")}` : ""}`);
      if (Date.now() >= start + WAIT_MS) throw new Error(missed(s, sender, texts !== undefined, mail, skipped, problems));
      await Bun.sleep(CODE_POLL_MS);
    }
  } finally {
    texts?.close();
    await mail?.stop();
  }
}

// What a wait that found no code says: where it looked, what it passed
// over and why, and what to do, never a code.
function missed(s: Site, sender: string | undefined, byText: boolean, mail: MailWatch | undefined, skipped: Set<string>, problems: string[]): string {
  const where = [...(byText ? ["by text"] : []), ...(mail ? ["in Gmail"] : [])].join(" or ");
  const unnamed = [...(byText ? ["texts without its name"] : []), ...(mail ? ["mails from another domain"] : [])].join(" or ");
  const failed = mail?.failed();
  return [
    `no code ${s.domain ? `for ${s.domain} ` : ""}came ${where} in ${WAIT_MS / 1000} s`,
    ...(skipped.size ? [`passed over ${[...skipped].join("; ")}`] : []),
    ...(failed !== undefined ? [`Gmail could not be read: ${failed}`] : mail && !mail.looked() ? ['Gmail had not loaded by then; secret "mail" opens it at once'] : []),
    ...problems,
    "have the site send it again, then call type again",
    ...(sender === undefined && unnamed ? [`a site that ${unnamed} needs sender: the number or domain its guide or page gives`] : []),
  ].join("; ");
}

// The messages whose codes were typed, so each is typed once: a site takes
// a code once, and a resend's new code comes in beside the old one. A line
// is the time in ms and the message's key, never the code; an hour is kept.
const TYPED = join(homedir(), ".local/share/safari-harness/codes-typed");
const TYPED_MS = 3_600_000;

function typedLines(): string[] {
  try {
    return readFileSync(TYPED, "utf8").split("\n").filter(Boolean);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
    throw e;
  }
}

const fresh = (line: string) => Number(line.slice(0, line.indexOf(" "))) > Date.now() - TYPED_MS;

function typedKeys(): Set<string> {
  return new Set(typedLines().filter(fresh).map((line) => line.slice(line.indexOf(" ") + 1)));
}

function markTyped(key: string): void {
  const line = `${Date.now()} ${key}\n`;
  mkdirSync(dirname(TYPED), { recursive: true });
  const lines = typedLines();
  if (lines.length < 200) appendFileSync(TYPED, line);
  else writeFileSync(TYPED, [...lines.filter(fresh), ""].join("\n") + line);
}
