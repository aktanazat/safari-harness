// Secrets that ride in addresses: a sign-in's one-time code, an OAuth state
// or token, a signed link's signature. Every answer an agent gets has their
// values cut to "..." (callTool in tools.ts, and browsing_history, which runs
// in the caller): a tab list once carried an OAuth state token into a
// subagent, and a history search returned sign-in code= addresses. A
// parameter is cut only when its whole name is one of these, in any case,
// so an order number or a zipcode stays readable. A form sent by Enter puts
// its fields in the address: Garmin's sign-in went to ?securityCode=<the
// emailed code> (09-30), so a code named for what it secures is cut too.

const NAMES = ["code", "state", "token", "access_token", "id_token", "refresh_token", "sig", "signature", "session", "auth", "password", "otp", "(?:security|verification|verify|otp|mfa|auth|authorization|one_?time|pass)[_-]?code"];

// A parameter starts after ?, &, or # (a sign-in's tokens often ride in the
// fragment), or their escaped forms: a sign-in page's redirectTo carries a
// whole address with its state after %26 (CodeSignal, 09-30). In a line of
// page text its value ends where the address does: at a space, a quote, an
// angle bracket, or the } that closes a field's state.
const PARAM = new RegExp(`((?:[?&#]|%3F|%26|%23)(?:${NAMES.join("|")})(?:=|%3D))(?:(?!%26|%23)[^&#\\s"'<>}])+`, "gi");

// A reset link's token can be a path segment rather than a parameter:
// CodeSignal's is /auth/reset-password/<token> (09-30). A long opaque
// segment right after a reset, verify, or invite segment is cut.
const PATH_TOKEN = /(\/(?:reset[-_]?password|password[-_]?reset|reset|verify|verification|confirm|confirmation|activate|activation|magic[-_]?link|invite|invitation)\/)[\w-]{16,}/gi;

// text with the value of each secret parameter and path token in it cut;
// an address, or a snapshot's lines, whose link addresses are in them.
export function redactUrl(text: string): string {
  return text.replace(PARAM, "$1...").replace(PATH_TOKEN, "$1...");
}

// A mail tab is titled with the open email's subject, and a code email's
// subject often is the code: Gmail showed "255551 is your password reset
// code" as the Times' email tab's title (09-30). In a title that speaks of a
// code, a run of 4 to 8 digits standing alone is cut.
const SPEAKS_OF_CODE = /\b(?:code|passcode|verification|otp|pin)\b/i;
const STANDALONE_DIGITS = /(?<![\w.,:/-])\d{4,8}(?![\w.,:/-])/g;

function redactTitle(title: string): string {
  const cut = redactUrl(title);
  return SPEAKS_OF_CODE.test(cut) ? cut.replace(STANDALONE_DIGITS, "...") : cut;
}

// value with every url, title, and snapshot text in it cut, however deep: a
// tab, a page, a request in net, where an action navigated, the page it
// returned, each step of run and page of map. A page with no title of its
// own is titled with its address (GEDmatch's sign-in, 09-30). Only plain
// objects and arrays are walked; any other value is returned as it is.
export function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted);
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v !== "string" ? redacted(v) : k === "title" ? redactTitle(v) : k === "snapshot" ? redactSnapshot(v) : k === "url" ? redactUrl(v) : v]));
}

// A snapshot opens with "# <title> — <address>", then its lines.
function redactSnapshot(text: string): string {
  const end = text.indexOf("\n");
  return end < 0 ? redactTitle(text) : redactTitle(text.slice(0, end)) + redactUrl(text.slice(end));
}

// Secrets the harness typed into a tab: a code it filled in for {{code}}
// (secret.ts), a password or code from Apple Passwords (passwords.ts), a
// login from Bitwarden (login_fill), a card. A page can show one again
// where no field mask reaches: USCIS names its code field by a label that
// repeats the code, and a snapshot printed it past the field's {filled}
// (USCIS, 09-30). Every answer from the tab has them cut to "..."
// (bridge.ts): its request log, console, and page-world script answer
// there too, which content.js's own cut never sees. They are kept in
// memory only, until the harness closes the tab (tools.ts) or the daemon
// stops. A text under 3 characters is not kept: a cut of every "4" would
// garble the page and hide next to nothing.
export const tabSecrets = new Map<number, Set<string>>();

export function keepSecret(tab: number, ...texts: unknown[]): void {
  const kept = tabSecrets.get(tab) ?? new Set<string>();
  for (const t of texts) if (typeof t === "string" && t.length >= 3) kept.add(t);
  if (kept.size > 0) tabSecrets.set(tab, kept);
}

// A text of digits is cut only where it stands as a number of its own: a
// card's security code of 234 leaves a total of $1,234.56 whole.
function secretPattern(t: string): string {
  return /^\d+$/.test(t) ? `(?<!\\d|\\d[.,])${t}(?![.,]?\\d)` : t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// value with each secret typed into tab cut from its strings, however
// deep, the longest first, so a code inside a longer secret cannot split
// it; but for a file's bytes (a top-level data, in base64), which a cut
// would break.
export function unsecret(tab: number, value: unknown): unknown {
  const kept = tabSecrets.get(tab);
  if (!kept) return value;
  const secrets = new RegExp([...kept].sort((a, b) => b.length - a.length).map(secretPattern).join("|"), "g");
  const cut = (v: unknown, top: boolean): unknown => {
    if (typeof v === "string") return v.replace(secrets, "...");
    if (Array.isArray(v)) return v.map((x) => cut(x, false));
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, top && k === "data" && typeof x === "string" ? x : cut(x, false)]));
  };
  return cut(value, true);
}

// Credentials people paste into the pages agents read: Slack messages and
// Notion pages carried OpenAI, Anthropic, Supabase service_role, AWS,
// GitHub, Telnyx and other keys, and a password, into transcripts and so to
// the model provider (audit 11-06, I-1). Each value of one of these shapes
// is cut to [REDACTED:<kind>] in every answer a model gets: a model's own
// tool call (callTool in tools.ts), a REPL run's output and error (repl.ts),
// and a long answer saved to a file (save.ts). A site's own calls inside a
// REPL script see the page as it is, and what an approved send sends is
// never touched. The shapes carry a prefix no ordinary text has, so a
// link, an id, a uuid or a hash stays whole. A shape that asks more of a
// run than its prefix and length (a digit in it, a JWT's other two parts)
// takes the whole run its prefix starts, and holds says whether that is a
// secret: a pattern that looks ahead from each prefix reads the rest of
// the run once per prefix, and on 160,000 characters of "sk-sk-sk-..."
// takes 3.3 s, the time growing as the square of the length (11-11).
const SHAPES: [kind: string, shape: RegExp, holds?: (match: string) => boolean][] = [
  // the first part's run alone, when the other two do not follow it
  ["jwt", /\beyJ[\w-]{8,}(?:\.eyJ[\w-]{8,}\.[\w-]{8,})?/g, (match) => match.includes(".")],
  ["anthropic", /\bsk-ant-[\w-]{20,}/g],
  // OpenAI's, and the many providers that copied its sk- (Braintrust,
  // DeepSeek): a digit among 20 or more characters, so a CSS class such as
  // sk-spinner-double-bounce stays.
  ["openai", /\bsk-[\w-]*/g, (match) => match.length >= 23 && /\d/.test(match)],
  ["slack", /\bx(?:ox[abposre]|app)-[\w-]*/g, (match) => match.length >= 15 && /\d/.test(match)],
  ["aws", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/g],
  ["supabase", /\bsb_secret_[\w-]{20,}/g],
  ["telnyx", /\bKEY[0-9A-Z]{20,}_[A-Za-z0-9]{20,}\b/g],
  ["tavily", /\btvly-(?:dev-|prod-)?[A-Za-z0-9]{20,}/g],
  ["perplexity", /\bpplx-[A-Za-z0-9]{40,}/g],
];

// A private key's block runs from its BEGIN line to the first END line
// after it. With no END after one BEGIN there is none after a later one,
// so the search stops there; a pattern searches on to the text's end from
// every BEGIN in it (160,000 characters of BEGIN lines, 0.23 s, 11-11).
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

function cutKeys(text: string, cut: (kind: string) => string): string {
  let out = "";
  let from = 0;
  KEY_BEGIN.lastIndex = 0;
  for (let begin = KEY_BEGIN.exec(text); begin; begin = KEY_BEGIN.exec(text)) {
    KEY_END.lastIndex = KEY_BEGIN.lastIndex;
    if (!KEY_END.exec(text)) break;
    out += text.slice(from, begin.index) + cut("private_key");
    from = KEY_BEGIN.lastIndex = KEY_END.lastIndex;
  }
  return out + text.slice(from);
}

// A value after a name that says it is a credential: OPENAI_API_KEY=...,
// "X-API-Key": "...", password: ... Its name stays, so the reader knows
// what was there. A name of a page or a cursor (nextPageToken, sync_token)
// is paging, not a secret, and stays whole. The name ends with the
// credential's word and starts where its run of letters, digits, _, - and
// dots does or just after a dot in it: at the first such place that is a
// letter, or at the word itself when the word starts at one (2fa_token has
// no name). The word is found first and the name read back from it: a
// pattern that tries the place after each dot in turn reads the run once
// from each, and on 160,000 characters of "a.a.a..." takes 20 s, the time
// growing as the square of the length (11-11).
const CREDENTIAL = /(?:api[_-]?key|apikey|secret(?:[_-]?key)?|token|passw(?:or)?d|pwd|access[_-]?key(?:[_-]?id)?|private[_-]?key|client[_-]?secret|credentials?|[_-]key)(?=["']?\s*[:=])/gi;
const LABEL_VALUE = /(["']?\s*[:=]\s*["']?)([^\s"'`<>,;(){}[\]\\]+)/y;
const PAGING = /page|next|cursor|continuation|sync/i;
const PASSWORD = /passw(?:or)?d|pwd|credential/i;
const PLACEHOLDER = /^(?:\*+|•+|x{3,}|\.{3,}|null|none|nil|undefined|true|false|required|optional|redacted|changeme|example|your[\w-]*|\$\w+)$/i;

// A labeled value that holds a secret: for a password, six or more
// characters with a digit or a sign (a word alone is a form's label:
// "Password: Required"); for a key or token, twelve or more with a letter
// and a digit, as no plain word or setting has.
function secretValue(name: string, value: string): boolean {
  if (PLACEHOLDER.test(value)) return false;
  if (PASSWORD.test(name)) return value.length >= 6 && /[^A-Za-z]/.test(value);
  return value.length >= 12 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function cutLabeled(text: string, cut: (kind: string) => string): string {
  let out = "";
  let from = 0;
  CREDENTIAL.lastIndex = 0;
  for (let word = CREDENTIAL.exec(text); word; word = CREDENTIAL.exec(text)) {
    const end = CREDENTIAL.lastIndex;
    let start = word.index;
    while (start > 0 && /[\w.-]/.test(text[start - 1])) start--;
    while (start < word.index && !/[A-Za-z]/.test(text[start])) {
      start++;
      while (start < word.index && text[start - 1] !== ".") start++;
    }
    if (start === word.index && start > 0 && /[\w-]/.test(text[start - 1])) continue;
    LABEL_VALUE.lastIndex = end;
    const label = LABEL_VALUE.exec(text);
    if (!label) continue;
    CREDENTIAL.lastIndex = LABEL_VALUE.lastIndex;
    const name = text.slice(start, end);
    if (PAGING.test(name) || !secretValue(name, label[2])) continue;
    out += text.slice(from, start) + name + label[1] + cut(PASSWORD.test(name) ? "password" : "secret");
    from = CREDENTIAL.lastIndex;
  }
  return out + text.slice(from);
}

export type Redacted = Record<string, number>;

// text with each secret-shaped value cut to [REDACTED:<kind>], counting each
// kind cut into counts.
export function redactSecretText(text: string, counts: Redacted = {}): string {
  const cut = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return `[REDACTED:${kind}]`;
  };
  let out = cutKeys(text, cut);
  for (const [kind, shape, holds] of SHAPES) out = out.replace(shape, (match) => (holds && !holds(match) ? match : cut(kind)));
  return cutLabeled(out, cut);
}

// value with every string in it, however deep, so cut, and the count of
// each kind cut; but for a file's bytes (a top-level data, in base64),
// which a cut would break. Only plain objects and arrays are walked.
export function redactSecrets<T>(value: T): { value: T; redacted: Redacted } {
  const counts: Redacted = {};
  const walk = (v: unknown, top: boolean): unknown => {
    if (typeof v === "string") return redactSecretText(v, counts);
    if (Array.isArray(v)) return v.map((x) => walk(x, false));
    if (v === null || typeof v !== "object") return v;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, top && k === "data" && typeof x === "string" ? x : walk(x, false)]));
  };
  return { value: walk(value, true) as T, redacted: counts };
}

// The line an answer's text carries for what was cut: "redacted: openai 1,
// jwt 2 ...". The values are gone from the answer; the page still has them.
export function redactedLine(counts: Redacted): string {
  return `redacted: ${Object.entries(counts).map(([kind, n]) => `${kind} ${n}`).join(", ")} (secret-shaped values cut to [REDACTED:kind]; the page itself is unchanged)`;
}
