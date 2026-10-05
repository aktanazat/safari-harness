// Google through the owner's Safari session: the accounts signed in, Gmail,
// Google Docs, and Google Sheets. Gmail's list is read off Gmail's own page
// in a background tab (Gmail has no plain JSON API for the browser session);
// a thread comes from the print view, which does not mark it read. Docs and
// Sheets come from their export endpoints. Composing opens a prefilled
// window for the owner and never presses Send.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftOrSend, NotSignedIn, type SiteKit } from "./kit.ts";

const OGS = "https://ogs.google.com";
const MAIL = "https://mail.google.com";
const DOCS = "https://docs.google.com";

// ---------- HTML to text ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? m;
    const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

// Characters that show as nothing, which mail templates put between words
// and pad the preview line with: zero-width spaces and joiners, word
// joiners, byte order marks, combining grapheme joiners, soft hyphens.
// Figure spaces pad it too. Agents stripped them by hand in about 50
// scripts.
const FILLER = /[\u200b-\u200d\u2060\ufeff\u00ad]|\u034f/g;

// Text as it reads: no filler, figure and no-break spaces as spaces, no
// line that padding alone made, lines trimmed, and runs of blank lines
// shrunk to one.
function tidy(text: string): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const kept = line.replace(FILLER, "").replace(/\u2007/g, " ");
      return kept !== line && kept.trim() === "" ? [] : [kept];
    })
    .join("\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Plain text from a mail body or a document: blocks and <br> break lines,
// list items get a dash, cells get a tab, runs of blank lines shrink to one.
function htmlToText(html: string): string {
  const text = html
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<\/?(p|div|tr|li|h[1-6]|blockquote|pre|table|ul|ol|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(text));
}

// A JavaScript string literal's contents ("\x3d", "\u00e9", "\/") as text.
function unescapeJs(s: string): string {
  return s.replace(/\\(x[0-9a-f]{2}|u[0-9a-f]{4}|.)/gi, (_, code: string) => {
    if (/^[xu]/i.test(code)) return String.fromCharCode(parseInt(code.slice(1), 16));
    return { n: "\n", t: "\t", r: "\r" }[code] ?? code;
  });
}

// ---------- accounts ----------

export type GoogleAccount = { index: number; email: string; name: string };
export type GoogleAccounts = { list(): Promise<GoogleAccount[]> };

// The signed-in accounts, from the account menu Google apps show (the
// "widget" the avatar opens): the menu for index 0 names the account it is
// for and lists the others with their authuser index.
export function googleAccounts(kit: SiteKit): GoogleAccounts {
  let accounts: Promise<GoogleAccount[]> | undefined;

  async function load(): Promise<GoogleAccount[]> {
    const widget = `${OGS}/u/0/widget/account?hl=en`;
    await kit.tab(OGS, widget);
    const where = await kit.eval<string>(OGS, "location.href");
    if (!where.startsWith(OGS)) throw new NotSignedIn("Google");
    const res = await kit.fetch(OGS, widget, { maxBytes: 2_000_000 });
    if (res.status === 401 || res.status === 403 || !res.url.startsWith(OGS)) throw new NotSignedIn("Google", `HTTP ${res.status}`);
    const html = res.text;
    const others = [...html.matchAll(/<a\b[^>]*\bdata-au="(\d+)"[^>]*\bdata-email="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => {
      const lines = m[3].replace(/<[^>]+>/g, "\n").split("\n").map((l) => decodeEntities(l).trim()).filter(Boolean);
      return { index: Number(m[1]), email: decodeEntities(m[2]), name: lines[0] ?? "" };
    });
    const shown = [...html.matchAll(/>\s*([^<>\s"]+@[^<>\s"]+)\s*</g)].map((m) => decodeEntities(m[1]));
    const email = shown.find((e) => !others.some((o) => o.email === e));
    if (!email) throw new NotSignedIn("Google", "the account menu names no account");
    // The menu's data lists every account as ["Name","email", ...]; the
    // greeting ("Hi, Aktan!") is the fallback, with the first name only.
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = new RegExp(`"([^"\\\\]{1,200})","${escaped}"`).exec(html)?.[1] ?? /Hi, ([^!<]{1,100})!/.exec(html)?.[1] ?? "";
    return [{ index: 0, email, name: unescapeJs(name) }, ...others].sort((a, b) => a.index - b.index);
  }

  return {
    // Each account with its email, name, and index: the /u/<n>/ (authuser)
    // number the other Google globals take as account.
    list(): Promise<GoogleAccount[]> {
      accounts ??= load().catch((e: unknown) => {
        accounts = undefined;
        throw e;
      });
      return accounts;
    },
  };
}

// The /u/<n>/ index for an account given as that index or as its email.
async function accountIndex(accounts: GoogleAccounts, account: number | string | undefined): Promise<number> {
  if (account === undefined) return 0;
  if (typeof account === "number") return account;
  const text = account.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const list = await accounts.list();
  const found = list.find((a) => a.email.toLowerCase() === text.toLowerCase());
  if (!found) throw new NotSignedIn("Google", `${text} is not one of the signed-in accounts (${list.map((a) => a.email).join(", ")})`);
  return found.index;
}

// ---------- Gmail ----------

export type GmailSender = { name: string; email: string };
export type GmailThreadSummary = { id: string; threadId: string; from: string; fromEmail: string; senders: GmailSender[]; subject: string; snippet: string; date: string; unread: boolean };
export type GmailSearch = { results: GmailThreadSummary[]; hasMore: boolean; total: number | null; nextOffset: number };
export type GmailWait = { status: "received"; results: GmailThreadSummary[]; since: number } | { status: "timeout"; since: number; note: string };
export type GmailAttachment = { name: string; id: string; size: string; url: string };
export type GmailMessage = { from: GmailSender; to: GmailSender[]; cc: GmailSender[]; replyTo?: GmailSender[]; date: string; body: string; quotedOnly?: true; bodyHtml?: string; attachments: GmailAttachment[] };
export type GmailThread = { id: string; threadId: string; subject: string; messages: GmailMessage[]; attachments: (GmailAttachment & { message: number })[] };
// A new message: its headers, plain-text body, and absolute file paths.
type Compose = { to?: string; cc?: string; bcc?: string; subject?: string; body?: string; files?: string[] };

// A list row as the page reads it: its date as the row shows it, and last,
// the id of its thread's newest message (matchedAt).
type ListRow = GmailThreadSummary & { last: string };
type ListPage = { counter: string | null; empty: boolean; rows: ListRow[] };

// The thread list Gmail shows, once the view for the current hash is in.
// Gmail keeps a div[role=main] per view it has rendered, hidden when
// another is up, and brings one back for a hash it has seen; the view up
// when a navigation starts is marked with that navigation's token, so a
// list still carrying the token is the old one and an unmarked or older
// one is the view that arrived.
function readListExpression(token: string): string {
  return `(() => {
  const main = [...document.querySelectorAll('div[role="main"]')].find((m) => m.offsetParent !== null);
  if (!main || main.dataset.shMark === ${JSON.stringify(token)}) return null;
  const shown = (e) => e.offsetParent !== null;
  const rows = [...main.querySelectorAll('tr.zA')].filter(shown);
  const counter = [...main.querySelectorAll('.Dj')].find(shown)?.textContent ?? null;
  const empty = [...main.querySelectorAll('.TC')].some(shown);
  if (!rows.length && !empty && !counter) return null;
  return { counter, empty, rows: rows.map((r) => {
    const idEl = r.querySelector('[data-legacy-thread-id]');
    const senders = [...r.querySelectorAll('.yW span[email]')];
    return {
      id: idEl?.getAttribute('data-legacy-thread-id') ?? '',
      threadId: (idEl?.getAttribute('data-thread-id') ?? '').replace(/^#/, ''),
      from: senders.map((s) => s.textContent.trim()).join(', '),
      fromEmail: senders.map((s) => s.getAttribute('email') ?? '').join(', '),
      senders: senders.map((s) => ({ name: s.getAttribute('name') ?? '', email: s.getAttribute('email') ?? '' })),
      subject: r.querySelector('.bog')?.textContent.trim() ?? '',
      snippet: (r.querySelector('.y2')?.textContent ?? '').replace(/^\\s*-\\s*/, '').trim(),
      date: r.querySelector('td.xW span[title]')?.getAttribute('title') ?? r.querySelector('td.xW span')?.textContent ?? '',
      unread: r.classList.contains('zE'),
      last: idEl?.getAttribute('data-legacy-last-non-draft-message-id') ?? '',
    };
  }) };
})()`;
}

// The print view of one thread, fetched and parsed inside the tab so the
// HTML never crosses the bridge whole: subject, and per message the header
// cells, the recipient lines, the body's HTML, and the attachment links.
function readThreadExpression(url: string): string {
  return `(async () => {
  const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
  if (res.status !== 200) return { status: res.status, url: res.url };
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
  const messages = [...doc.querySelectorAll('table.message')].map((t) => {
    const cells = [...(t.querySelector('tr')?.children ?? [])];
    const attachments = [...t.querySelectorAll('table.att a[href*="view=att"]')].map((a) => {
      const row = a.closest('tr');
      const name = text(row?.querySelector('b'));
      return { url: a.getAttribute('href') ?? '', name, size: text(row).replace(name, '').trim() };
    });
    return {
      from: text(cells[0]),
      date: text(cells[1]),
      lines: [...t.querySelectorAll('font.recipient > div')].map(text),
      body: t.querySelector('div[style*="overflow"]')?.innerHTML ?? '',
      attachments,
    };
  });
  return { status: 200, url: res.url, subject: text(doc.querySelector('.maincontent font[size="+1"]')), messages };
})()`;
}

type RawThread = { status: number; url: string; subject?: string; messages?: { from: string; date: string; lines: string[]; body: string; attachments: { url: string; name: string; size: string }[] }[] };

// "Name <email>, Other <email>" or bare addresses, as sender records; a
// name that only repeats the address is left empty.
function parseAddresses(s: string): GmailSender[] {
  const out: GmailSender[] = [];
  for (const m of s.matchAll(/([^<>,]*?)\s*<([^<>]+)>|([^\s<>,]+@[^\s<>,]+)/g)) {
    const email = (m[2] ?? m[3]).trim();
    const name = (m[1] ?? "").trim();
    out.push({ name: name.toLowerCase() === email.toLowerCase() ? "" : name, email });
  }
  return out;
}

// Gmail's own dates ("Sat, Sep 26, 2026 at 12:51 AM") as ISO, when they parse.
function isoDate(s: string): string {
  const t = Date.parse(s.replace(" at ", " "));
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

// When a row's newest match came, as the earliest and the latest it can
// be. The row shows that message's date to the minute, and carries the id
// of its thread's newest message, whose time in ms sits above the id's low
// 20 bits: a search for someone's mail shows their message's date though
// the owner replied since (2026-09-30). An id time in the shown minute or
// the one before is taken for the match's own, as the newest message never
// comes before the newest match and Gmail dated one of 50 messages in the
// minute after its id's time, 158 ms later (2026-09-30); a reply in the
// match's own minute passes for a match.
function matchedAt(row: ListRow): [number, number] {
  const shown = Date.parse(row.date.replace(" at ", " "));
  const last = /^[0-9a-f]{12,20}$/i.test(row.last) ? Number(BigInt(`0x${row.last}`) >> 20n) : NaN;
  return last >= shown - 60_000 && last < shown + 60_000 ? [last, last] : [shown, shown + 59_999];
}

// A list row as the methods return it: the snippet tidied, and dated at
// its newest match, to the ms where the id tells it.
function summary(row: ListRow): GmailThreadSummary {
  const { last: _, ...rest } = row;
  const [at] = matchedAt(row);
  return { ...rest, snippet: tidy(row.snippet), date: Number.isNaN(at) ? row.date : new Date(at).toISOString() };
}

// The hex id Gmail's URLs take, from that id, "thread-f:<decimal>", the
// decimal alone, or a URL carrying th=<hex>.
function legacyThreadId(id: string): string {
  const s = id.trim().replace(/^#/, "");
  if (/^[0-9a-f]{12,20}$/i.test(s)) return s.toLowerCase();
  const decimal = /^(?:thread-[a-z]:)?(\d{15,25})$/.exec(s)?.[1];
  if (decimal) return BigInt(decimal).toString(16);
  const inUrl = /[?&]th=([0-9a-f]{12,20})/i.exec(s)?.[1];
  if (inUrl) return inUrl.toLowerCase();
  throw new Error(`${id} is not a Gmail thread id; use the id or threadId from search results`);
}

function pageCounter(counter: string | null): { first: number; last: number; total: number | null } | null {
  const m = counter && /([\d,]+)\s*[–-]\s*([\d,]+)\s+of\s+([\d,]+|many)/.exec(counter);
  if (!m) return null;
  const num = (s: string) => Number(s.replace(/,/g, ""));
  return { first: num(m[1]), last: num(m[2]), total: m[3] === "many" ? null : num(m[3]) };
}

// A look for new mail is one Gmail search, about 0.6 s (2026-09-30), so a
// 25 s wait with looks two seconds apart searches about ten times.
const LOOK_MS = 2_000;

export function gmail(kit: SiteKit) {
  const accounts = googleAccounts(kit);
  // The tab Gmail last settled in and the account it landed on there, and
  // Gmail's list page size once seen. A tab that takes the place of a gone
  // one (kit.ts) has settled on nothing yet.
  let shown: { tab: number; account: number } | undefined;
  let pageSize = 50;
  // Looks for new mail so far (waitForMail).
  let looks = 0;

  // The tab as the browser lists it; undefined once it is gone.
  async function listed(tab: number): Promise<{ id: number; url?: string; title?: string } | undefined> {
    const tabs = (await kit.invoke("tabs", {})) as { id: number; url?: string; title?: string }[];
    return tabs.find((t) => t.id === tab);
  }

  // Where the tab is once Gmail has loaded. A Gmail load can bounce through
  // accounts.google.com (a session refresh) before it lands, and the page
  // answers nothing while it does, so the tab list, which the browser
  // answers, is what to watch. A tab that rests off Gmail is signed out.
  async function settled(tab: number): Promise<string> {
    let url = "";
    let changed = Date.now();
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const t = await listed(tab);
      if (!t) throw new Error("the Gmail tab was closed");
      if (t.url !== url) {
        url = t.url ?? "";
        changed = Date.now();
      }
      const resting = Date.now() - changed > 4_000;
      if (url.startsWith(MAIL) && (resting || (t.title ?? "").startsWith("Inbox"))) return url;
      if (!url.startsWith(MAIL) && resting) throw new NotSignedIn("Gmail", `Safari shows ${new URL(url).hostname} instead`);
      await Bun.sleep(500);
    }
    throw new Error("Gmail did not finish loading in time");
  }

  // The Gmail tab, on account. The tab of an earlier call can be gone
  // since (closed, or 20 minutes unused): a new one takes its place at the
  // account's inbox, and like any new tab it settles before it is read.
  async function mailTab(account: number): Promise<number> {
    const home = `${MAIL}/mail/u/${account}/#inbox`;
    let tab = await kit.tab(MAIL, home);
    if (!(await listed(tab))) tab = await kit.reopen(MAIL, tab);
    if (shown?.tab === tab && shown.account === account) return tab;
    if (shown?.tab === tab) await kit.invoke("goto", { tab, url: home });
    const at = /\/mail\/u\/(\d+)\//.exec(await settled(tab))?.[1];
    // Gmail lands on another account when this one is not signed in.
    shown = { tab, account: Number(at) };
    if (at !== String(account)) throw new Error(`no Google account at index ${account} in Safari (Gmail opened /u/${at ?? "?"}/ instead)`);
    return tab;
  }

  // Shows a list view (a hash) in the Gmail tab and returns its rows.
  async function showList(account: number, hash: string): Promise<ListPage> {
    await mailTab(account);
    const token = String(Date.now());
    await kit.eval(MAIL, `(() => {
      if (location.hash === ${JSON.stringify(hash)}) return false;
      for (const main of document.querySelectorAll('div[role="main"]')) {
        if (main.offsetParent !== null) main.dataset.shMark = ${JSON.stringify(token)};
      }
      location.hash = ${JSON.stringify(hash)};
      return true;
    })()`);
    const read = readListExpression(token);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const page = await kit.eval<ListPage | null>(MAIL, read);
      if (page) return page;
      await Bun.sleep(250);
    }
    throw new Error("Gmail did not show the list in time");
  }

  // Rows from offset on, across list pages (the view's hash with /p<n>).
  // Gmail's counter reads "1–50 of 11,926" (exact) or "of many" (a search
  // it has not counted to the end); a full page not at the end shows the
  // page size, which the owner may have set to 25, 50, or 100.
  async function listFrom(account: number, view: string, offset: number, limit: number): Promise<GmailSearch> {
    const results: GmailThreadSummary[] = [];
    let at = offset;
    let hasMore = true;
    let total: number | null = null;
    let retried = false;
    while (results.length < limit && hasMore) {
      const page = Math.floor(at / pageSize) + 1;
      const list = await showList(account, page > 1 ? `${view}/p${page}` : view);
      const counter = pageCounter(list.counter);
      const start = counter ? counter.first - 1 : 0;
      const end = start + list.rows.length;
      if (counter && counter.last < (counter.total ?? Infinity)) pageSize = counter.last - counter.first + 1;
      if (list.rows.length === 0) {
        total = counter?.total ?? (list.empty ? 0 : null);
        hasMore = false;
        break;
      }
      if (at < start || at >= end) {
        // The page size guessed wrong: once more with the size just seen;
        // past that, the offset is beyond the end.
        if (retried) {
          hasMore = false;
          break;
        }
        retried = true;
        continue;
      }
      total = counter?.total ?? null;
      const rows = list.rows.slice(at - start, at - start + (limit - results.length));
      results.push(...rows.map(summary));
      at += rows.length;
      hasMore = at < end || (counter !== null && (counter.total === null ? list.rows.length >= pageSize : counter.total > at));
    }
    return { results, hasMore, total, nextOffset: at };
  }

  async function thread(account: number, id: string, wantHtml: boolean): Promise<GmailThread> {
    await mailTab(account);
    const raw = await kit.eval<RawThread>(MAIL, readThreadExpression(`${MAIL}/mail/u/${account}/?view=pt&search=all&th=${id}`));
    if (raw.status === 401 || raw.status === 403 || !raw.url.startsWith(MAIL)) throw new NotSignedIn("Gmail", `HTTP ${raw.status}`);
    if (raw.status !== 200 || !raw.messages) throw new Error(`Gmail answered HTTP ${raw.status} for thread ${id} in account ${account}`);
    const messages = raw.messages.map((m): GmailMessage => {
      const [from] = parseAddresses(m.from);
      const line = (label: string) => m.lines.find((l) => l.toLowerCase().startsWith(`${label}:`))?.slice(label.length + 1) ?? "";
      const replyTo = parseAddresses(line("reply-to"));
      const body = htmlToText(m.body);
      return {
        from: from ?? { name: m.from, email: "" },
        to: parseAddresses(line("to")),
        cc: parseAddresses(line("cc")),
        ...(replyTo.length ? { replyTo } : {}),
        date: isoDate(m.date),
        body,
        // The print view shows text quoted from earlier messages as this
        // line; a message that is only the line brings no words of its own.
        ...(body === "[Quoted text hidden]" ? { quotedOnly: true as const } : {}),
        ...(wantHtml ? { bodyHtml: m.body } : {}),
        attachments: m.attachments.map((a) => {
          // The print view's links carry the account's ik key; the
          // download works without it, so it stays out of what we return.
          const u = new URL(a.url, `${MAIL}/mail/u/${account}/`);
          for (const p of ["ik", "ui"]) u.searchParams.delete(p);
          return { name: a.name, id: u.searchParams.get("attid") ?? "", size: a.size, url: u.href };
        }),
      };
    });
    return {
      id,
      threadId: `thread-f:${BigInt(`0x${id}`)}`,
      subject: raw.subject ?? "",
      messages,
      // Every message's attachments in one list, each naming its message by
      // index: an agent that looked only here once found no contract.
      attachments: messages.flatMap((m, message) => m.attachments.map((a) => ({ ...a, message }))),
    };
  }

  // The files a draft attaches, by name, as a line after its body.
  const attached = (files: string[] = []) => (files.length ? `\n\nAttached: ${files.map((f) => f.split("/").pop()).join(", ")}` : "");

  function composeText(o: Compose): string {
    return [`To: ${o.to ?? ""}`, o.cc ? `Cc: ${o.cc}` : "", o.bcc ? `Bcc: ${o.bcc}` : "", `Subject: ${o.subject ?? ""}`, "", o.body ?? ""].filter((l, i) => l !== "" || i === 4).join("\n") + attached(o.files);
  }

  // Gmail's Send button, in a compose window or a reply box; its tooltip
  // names the shortcut after the word.
  const SEND = 'div[role="button"][data-tooltip^="Send"]';

  // A compose window prefilled in a new tab, ready once its Send button
  // shows: 5 s on 10-04, where waiting for quiet took 13 to 16 s.
  async function composeTab(n: number, o: Compose): Promise<{ tab: number; url: string }> {
    const params = new URLSearchParams({ view: "cm", fs: "1" });
    for (const [key, value] of [["to", o.to], ["cc", o.cc], ["bcc", o.bcc], ["su", o.subject], ["body", o.body]] as const) {
      if (value) params.set(key, value);
    }
    const url = `${MAIL}/mail/u/${n}/?${params}`;
    const t = (await kit.invoke("open", { url })) as { id: number };
    const { found } = (await kit.invoke("wait", { tab: t.id, selector: SEND, ms: 25000 })) as { found: boolean };
    if (!found) throw new Error("Gmail did not open the compose window; its tab is open for the owner");
    await attach(t.id, o.files ?? []);
    return { tab: t.id, url };
  }

  // The thread in a new tab with its reply box open and the body typed. A
  // thread address loaded straight never settles (Gmail rewrites the id
  // and reloads), so the inbox opens first and the thread comes in by
  // hash. The bottom "Reply" link is the first .ams.
  async function replyTab(n: number, id: string, o: { body?: string; files?: string[] }): Promise<{ tab: number; url: string }> {
    const box = 'div[role="textbox"][aria-label="Message Body"]';
    const t = (await kit.invoke("open", { url: `${MAIL}/mail/u/${n}/#inbox` })) as { id: number };
    await kit.invoke("wait", { tab: t.id, selector: "tr.zA, .TC", ms: 25000 });
    await kit.invoke("eval", { tab: t.id, expression: `location.hash = ${JSON.stringify(`#all/${id}`)}` });
    const reply = (await kit.invoke("wait", { tab: t.id, selector: ".ams", ms: 25000 })) as { found: boolean };
    if (!reply.found) throw new Error("Gmail did not open the thread; its tab is open for the owner");
    await kit.invoke("click", { tab: t.id, ref: ".ams" });
    const { found } = (await kit.invoke("wait", { tab: t.id, selector: box, ms: 15000 })) as { found: boolean };
    if (!found) throw new Error("Gmail did not open the reply box; the thread is open in the new tab");
    if (o.body) await kit.invoke("type", { tab: t.id, ref: box, text: o.body });
    await attach(t.id, o.files ?? []);
    const url = (await kit.invoke("eval", { tab: t.id, expression: "location.href" })) as { result?: string };
    return { tab: t.id, url: url.result ?? "" };
  }

  // Files attached in the compose window open in tab, each waited on until
  // Gmail labels it "Attachment: <name>" in place of "Uploading attachment".
  async function attach(tab: number, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const { files: names } = (await kit.invoke("upload", { tab, ref: 'input[type="file"][name="Filedata"]', paths: files })) as { files: string[] };
    for (const name of names) {
      const { found } = (await kit.invoke("wait", { tab, selector: `div[aria-label^=${JSON.stringify(`Attachment: ${name}`)}]`, ms: 30000 })) as { found: boolean };
      if (!found) throw new Error(`Gmail is still attaching ${name}; nothing was sent, and the tab is open for the owner`);
    }
  }

  // Send pressed in tab, then Gmail's "Message sent" awaited. The tab stays
  // open, as Gmail may still hold the message for its Undo window. A send
  // it does not see confirmed is never pressed again: it may be in Sent.
  async function pressSend(tab: number): Promise<{ sent: true; tab: number }> {
    await kit.invoke("click", { tab, ref: SEND });
    const { found } = (await kit.invoke("wait", { tab, text: "Message sent", ms: 20000 })) as { found: boolean };
    if (!found) throw new Error('Gmail did not show "Message sent"; look in Sent before sending again (the tab is open)');
    return { sent: true, tab };
  }

  return {
    // Newest inbox threads: id, from, fromEmail, subject, snippet, date, unread.
    async getInbox(account: number | string = 0, opts: { offset?: number; limit?: number } = {}): Promise<GmailSearch> {
      return listFrom(await accountIndex(accounts, account), "#inbox", opts.offset ?? 0, opts.limit ?? 50);
    },

    // Threads matching a Gmail search (from:, subject:, has:attachment,
    // is:unread, newer_than:7d, ...), newest first, paged by offset.
    async search(account: number | string, query: string, opts: { offset?: number; limit?: number } = {}): Promise<GmailSearch> {
      const q = query.trim();
      if (!q) throw new Error("search needs a query");
      return listFrom(await accountIndex(accounts, account), `#search/${encodeURIComponent(q).replace(/%20/g, "+")}`, opts.offset ?? 0, opts.limit ?? 50);
    },

    // Waits for new mail matching a Gmail search (from:apple.com), for an
    // agent waiting on a code, a link, or a reply: the threads with a
    // matching message after since (ms since 1970 or an ISO date; without
    // it, the minute before the call, as a code often lands first), in the
    // shape search returns, and the since to pass to the next wait. After
    // ms (default 25 s, at most 30 s) with nothing new it times out with the
    // since it had, so mail that lands between waits still counts. Agents
    // polled Gmail by hand with guessed sleeps until then (2026-09-30).
    async waitForMail(account: number | string, query: string, opts: { since?: number | string; ms?: number } = {}): Promise<GmailWait> {
      const q = query.trim();
      if (!q) throw new Error("waitForMail needs a query, such as from:apple.com");
      const n = await accountIndex(accounts, account);
      const since = opts.since === undefined ? Date.now() - 60_000 : new Date(opts.since).getTime();
      if (Number.isNaN(since)) throw new Error(`since is ms since 1970 or an ISO date, not ${JSON.stringify(opts.since)}`);
      const end = Date.now() + Math.min(Math.max(Number(opts.ms ?? 25_000), 0), 30_000);
      for (;;) {
        // Gmail's after: cut falls up to a minute from the times its rows
        // show (2026-09-30), so the search reaches five minutes back and the
        // rows' own times decide. Gmail searches again only for a hash it
        // does not show, so each look starts a second before the last.
        const after = Math.floor(since / 1000) - 300 - (looks++ % 60);
        const { rows } = await showList(n, `#search/${encodeURIComponent(`(${q}) after:${after}`).replace(/%20/g, "+")}`);
        const fresh = rows.filter((r) => matchedAt(r)[0] > since);
        if (fresh.length) return { status: "received", results: fresh.map(summary), since: Math.max(...fresh.map((r) => matchedAt(r)[1])) };
        if (Date.now() + LOOK_MS > end) return { status: "timeout", since, note: "no new mail yet; call waitForMail again with this since, and mail that lands in between still counts" };
        await Bun.sleep(LOOK_MS);
      }
    },

    // Every message of a thread, with the body as plain text (bodyHtml too
    // with html: true) and its attachments, which the thread also lists all
    // together. Read from Gmail's print view, which leaves the thread's
    // unread state alone.
    async getThread(account: number | string, threadId: string, opts: { html?: boolean } = {}): Promise<GmailThread> {
      return thread(await accountIndex(accounts, account), legacyThreadId(threadId), !!opts.html);
    },

    // Saves an attachment (its url from getThread, an inline image's src
    // from bodyHtml, or {threadId, attachmentId}) into ~/Downloads under its
    // own name, or at out; returns the saved file.
    async downloadAttachment(account: number | string, attachment: string | { threadId: string; attachmentId: string }, opts: { out?: string } = {}) {
      const n = await accountIndex(accounts, account);
      const tab = await mailTab(n);
      const base = `${MAIL}/mail/u/${n}/`;
      // A src copied out of bodyHtml has its & written as &amp;.
      const url = typeof attachment === "string"
        ? new URL(decodeEntities(attachment), base)
        : new URL(`?view=att&th=${legacyThreadId(attachment.threadId)}&attid=${encodeURIComponent(attachment.attachmentId)}&disp=attd&safe=1&zw`, base);
      if (url.origin !== MAIL) throw new Error("attachment must be a Gmail attachment url");
      for (const p of ["ik", "ui"]) url.searchParams.delete(p);
      return (await kit.invoke("download", { tab, url: url.href, ...(opts.out ? { out: opts.out } : {}) })) as { path: string; name: string; size: number; type: string };
    },

    // A draft of a new message; approved, it opens Gmail's compose window
    // prefilled with it, files attached, in a new tab for the owner, who
    // alone presses Send.
    async openComposer(opts: Compose & { account?: number | string; approved?: boolean }) {
      const n = await accountIndex(accounts, opts.account);
      return draftOrSend({
        site: "Gmail",
        action: "open a prefilled compose window (nothing is sent until the owner presses Send)",
        to: opts.to,
        text: composeText(opts),
        approved: opts.approved,
        send: () => composeTab(n, opts),
      });
    },

    // A draft of a new message; approved, it sends it from Gmail's compose
    // window, files attached, and returns once Gmail shows "Message sent".
    async send(opts: Compose & { account?: number | string; to: string; approved?: boolean }) {
      const n = await accountIndex(accounts, opts.account);
      return draftOrSend({
        site: "Gmail",
        action: "send this message",
        to: opts.to,
        text: composeText(opts),
        approved: opts.approved,
        send: async () => pressSend((await composeTab(n, opts)).tab),
      });
    },

    // A draft reply on a thread; approved, it opens the thread in a new tab
    // for the owner, presses Reply there, types the body into the reply
    // box, and attaches the files. Nothing is sent. Opening the thread in
    // Gmail marks it read.
    async openReplyComposer(account: number | string, threadId: string, opts: { body?: string; files?: string[]; approved?: boolean } = {}) {
      const n = await accountIndex(accounts, account);
      const id = legacyThreadId(threadId);
      return draftOrSend({
        site: "Gmail",
        action: `open a reply on thread ${id} (nothing is sent until the owner presses Send)`,
        text: `${opts.body ?? ""}${attached(opts.files)}`,
        approved: opts.approved,
        send: () => replyTab(n, id, opts),
      });
    },

    // A draft reply on a thread, Gmail's Reply: to the sender of its last
    // message. Approved, it sends it from the thread's reply box and
    // returns once Gmail shows "Message sent". Opening the thread marks it
    // read.
    async reply(account: number | string, threadId: string, opts: { body: string; files?: string[]; approved?: boolean }) {
      const n = await accountIndex(accounts, account);
      const id = legacyThreadId(threadId);
      return draftOrSend({
        site: "Gmail",
        action: `send a reply on thread ${id}`,
        text: `${opts.body}${attached(opts.files)}`,
        approved: opts.approved,
        send: async () => pressSend((await replyTab(n, id, opts)).tab),
      });
    },
  };
}

// ---------- Docs and Sheets ----------

export type GoogleFileKind = "document" | "spreadsheet" | "presentation" | "form" | "file";
export type GoogleFileRef = { id: string; kind: GoogleFileKind; account?: number };

const KINDS: Record<string, GoogleFileKind> = { document: "document", spreadsheets: "spreadsheet", presentation: "presentation", forms: "form", file: "file" };

// The file id and kind in a Docs, Sheets, Slides, Forms, or Drive link, with
// the /u/<n>/ account when the link carries one. A bare id passes through.
export function parseGoogleUrl(url: string, fallback: GoogleFileKind = "file"): GoogleFileRef {
  const s = url.trim();
  if (/^[\w-]{20,}$/.test(s)) return { id: s, kind: fallback };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${url} is neither a Google file id nor a link`);
  }
  if (!/(^|\.)google\.com$/.test(u.hostname)) throw new Error(`${url} is not a Google link`);
  const account = /\/u\/(\d+)\//.exec(u.pathname)?.[1];
  const path = /\/(document|spreadsheets|presentation|forms|file)\/(?:u\/\d+\/)?d\/([\w-]+)/.exec(u.pathname);
  const id = path?.[2] ?? u.searchParams.get("id") ?? undefined;
  if (!id) throw new Error(`${url} carries no file id`);
  return { id, kind: path ? KINDS[path[1]] : fallback, ...(account ? { account: Number(account) } : {}) };
}

// A file at url saved through the extension's own request (the export
// endpoints redirect to googleusercontent.com, which a page may not read)
// and returned as text.
async function fetchExport(kit: SiteKit, url: string, name: string, site: string): Promise<string> {
  const tab = await kit.tab(DOCS, `${DOCS}/document/u/0/`);
  const where = await kit.eval<string>(DOCS, "location.href");
  if (!where.startsWith(DOCS)) throw new NotSignedIn(site);
  const dir = await mkdtemp(join(tmpdir(), "safari-gdoc-"));
  try {
    const out = join(dir, name);
    try {
      await kit.invoke("download", { tab, url, out });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP 40[13]/.test(msg)) throw new NotSignedIn(site, msg);
      throw new Error(`${site} did not give the file: ${msg}`);
    }
    const text = (await readFile(out, "utf8")).replace(/^\ufeff/, "");
    // A sign-in page comes back as HTML with status 200.
    if (/accounts\.google\.com\/(v3\/signin|ServiceLogin)|<title>Sign in - Google Accounts/.test(text.slice(0, 20_000))) throw new NotSignedIn(site);
    return text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function docsPath(ref: GoogleFileRef, kind: "document" | "spreadsheets"): string {
  return `${DOCS}/${kind}/${ref.account === undefined ? "" : `u/${ref.account}/`}d/${ref.id}`;
}

export function googleDocs(kit: SiteKit) {
  function docRef(idOrUrl: string, account: number | string | undefined): GoogleFileRef {
    const ref = parseGoogleUrl(idOrUrl, "document");
    return account === undefined ? ref : { ...ref, account: Number(account) };
  }

  return {
    // {id, kind, account?} from a Docs, Sheets, Slides, Forms, or Drive link.
    parseUrl(url: string): GoogleFileRef {
      return parseGoogleUrl(url);
    },

    // The document's text (its plain-text export), by id or link.
    async getDocumentText(idOrUrl: string, opts: { account?: number | string } = {}): Promise<string> {
      const ref = docRef(idOrUrl, opts.account);
      return (await fetchExport(kit, `${docsPath(ref, "document")}/export?format=txt`, "doc.txt", "Google Docs")).replace(/\r\n/g, "\n");
    },

    // The document as HTML (its HTML export), by id or link.
    async getDocumentHTML(idOrUrl: string, opts: { account?: number | string } = {}): Promise<string> {
      const ref = docRef(idOrUrl, opts.account);
      return fetchExport(kit, `${docsPath(ref, "document")}/export?format=html`, "doc.html", "Google Docs");
    },
  };
}

export type SheetInfo = { name: string; gid: string };
export type SpreadsheetInfo = { id: string; title: string; sheets: SheetInfo[] };

// A CSV document as rows of strings (RFC 4180 quoting, CRLF or LF).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Sheets exports every column and row up to the grid's size: empty cells
// at the end of a row and empty rows at the end go.
function trimGrid(rows: string[][]): string[][] {
  const trimmed = rows.map((r) => {
    let n = r.length;
    while (n > 0 && r[n - 1] === "") n--;
    return r.slice(0, n);
  });
  let last = trimmed.length;
  while (last > 0 && trimmed[last - 1].length === 0) last--;
  return trimmed.slice(0, last);
}

export function googleSheets(kit: SiteKit) {
  async function sheetRef(idOrUrl: string, account: number | string | undefined): Promise<GoogleFileRef> {
    const ref = parseGoogleUrl(idOrUrl, "spreadsheet");
    return account === undefined ? ref : { ...ref, account: Number(account) };
  }

  // A request on docs.google.com with the session's cookies; the sheet
  // endpoints answer from the same origin, so the page's own fetch does.
  async function fetchSheet(url: string): Promise<string> {
    await kit.tab(DOCS, `${DOCS}/document/u/0/`);
    const where = await kit.eval<string>(DOCS, "location.href");
    if (!where.startsWith(DOCS)) throw new NotSignedIn("Google Sheets");
    const res = await kit.fetch(DOCS, url, { maxBytes: 50_000_000 });
    if (res.status === 401 || res.status === 403 || !res.url.startsWith(DOCS)) throw new NotSignedIn("Google Sheets", `HTTP ${res.status}`);
    if (res.status !== 200) throw new Error(`Google Sheets answered HTTP ${res.status} for ${url}; the spreadsheet may not be shared with this account`);
    if (res.truncated) throw new Error("the sheet is larger than 50 MB; read a range instead");
    return res.text;
  }

  async function info(ref: GoogleFileRef): Promise<SpreadsheetInfo> {
    const html = await fetchSheet(`${docsPath(ref, "spreadsheets")}/htmlview`);
    const title = decodeEntities(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "").replace(/ - Google (Drive|Sheets)$/, "").trim();
    const sheets = [...html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)"[^}]*?gid: "(\d+)"/g)].map((m) => ({ name: unescapeJs(m[1]), gid: m[2] }));
    if (!sheets.length) throw new Error(`Google Sheets showed no sheets for ${ref.id}; the spreadsheet may not be shared with this account`);
    return { id: ref.id, title, sheets };
  }

  async function rows(ref: GoogleFileRef, opts: { sheet?: string; gid?: string | number; range?: string }): Promise<string[][]> {
    const params = new URLSearchParams({ tqx: "out:csv", headers: "0" });
    if (opts.gid !== undefined) params.set("gid", String(opts.gid));
    else if (opts.sheet !== undefined) params.set("sheet", opts.sheet);
    if (opts.range) params.set("range", opts.range);
    return trimGrid(parseCsv(await fetchSheet(`${docsPath(ref, "spreadsheets")}/gviz/tq?${params}`)));
  }

  return {
    // The spreadsheet's title and its sheets (name and gid), by id or link.
    async getSpreadsheetInfo(idOrUrl: string, opts: { account?: number | string } = {}): Promise<SpreadsheetInfo> {
      return info(await sheetRef(idOrUrl, opts.account));
    },

    // One sheet's cells as rows of strings, as shown (formatted values), the
    // first sheet unless sheet (name) or gid says which; range narrows it
    // ("A1:C20"). Trailing empty cells and rows are dropped.
    async readSheet(idOrUrl: string, opts: { sheet?: string; gid?: string | number; range?: string; account?: number | string } = {}): Promise<string[][]> {
      return rows(await sheetRef(idOrUrl, opts.account), opts);
    },

    // Every sheet: {name, gid, rows}.
    async readAllSheets(idOrUrl: string, opts: { account?: number | string } = {}): Promise<(SheetInfo & { rows: string[][] })[]> {
      const ref = await sheetRef(idOrUrl, opts.account);
      const sheets = (await info(ref)).sheets;
      const out = [];
      for (const s of sheets) out.push({ ...s, rows: await rows(ref, { gid: s.gid }) });
      return out;
    },
  };
}
