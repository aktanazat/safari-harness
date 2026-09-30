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

// value with every url, title, and snapshot text in it cut, however deep: a
// tab, a page, a request in net, where an action navigated, the page it
// returned, each step of run and page of map. A page with no title of its
// own is titled with its address (GEDmatch's sign-in, 09-30). Only plain
// objects and arrays are walked; any other value is returned as it is.
const CUT_FIELDS = new Set(["url", "title", "snapshot"]);
export function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted);
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, CUT_FIELDS.has(k) && typeof v === "string" ? redactUrl(v) : redacted(v)]));
}
