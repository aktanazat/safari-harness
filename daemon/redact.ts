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
// fragment). In a line of page text its value ends where the address does:
// at a space, a quote, an angle bracket, or the } that closes a field's state.
const PARAM = new RegExp(`([?&#](?:${NAMES.join("|")})=)[^&#\\s"'<>}]+`, "gi");

// text with the value of each secret parameter in it cut; an address, or a
// snapshot's lines, whose link addresses are in them.
export function redactUrl(text: string): string {
  return text.replace(PARAM, "$1...");
}

// value with every url field and snapshot text in it cut, however deep: a
// tab, a page, a request in net, where an action navigated, the page it
// returned, each step of run and page of map. Only plain objects and arrays
// are walked; any other value is returned as it is.
export function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted);
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, (k === "url" || k === "snapshot") && typeof v === "string" ? redactUrl(v) : redacted(v)]));
}
