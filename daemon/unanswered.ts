// Safari says only "Load failed" for a request that got no answer at all:
// its host may not exist, or the page's rules (CORS, its security policy)
// refused it, or the server dropped the connection. On 09-28 an agent read
// it as this Mac's network failing, when the address it built from a
// dealer page's settings named a host that exists nowhere. Where the
// address is known, the error says whether its host exists.
//
// Its error page says only that a site did not answer. On 10-04 an agent
// spent three minutes finding that the network's DNS block list answered
// 0.0.0.0 for chat.z.ai (01a10612), and in late September three opens went
// to hosts no DNS server knows.

import { redactUrl } from "./redact.ts";
import { BROWSER_NAME } from "./front.ts";

// node:dns and node:net load on the first failed request they explain:
// every process that imports tools.ts imports this file, and the two cost
// 2 ms of each start (11-23).

// eval's own fetch names the latest request that got no answer, and how
// many more did ("Load failed for <url> and 2 more"; eval in content.js).
const LOAD_FAILED = /^(?:TypeError: )?Load failed(?: for (\S+)(?: and (\d+) more)?)?$/;
const UNOPENED = /^Safari could not open (\S+): the site did not answer$/;
const NET = "net shows the addresses the page itself calls";

// What DNS says of a host, asked as Safari asks it, through the system's
// resolver: an address; only 0.0.0.0 or ::, which a DNS block list answers
// for a name it stops; no such name (as for every name offline); or
// undefined when it could not say.
export type HostAnswer = "found" | "blocked" | "missing";
export async function hostAnswer(host: string): Promise<HostAnswer | undefined> {
  const { promises: dns } = await import("node:dns");
  try {
    const found = await dns.lookup(host, { all: true });
    return found.every((a) => a.address === "0.0.0.0" || a.address === "::") ? "blocked" : "found";
  } catch (e) {
    return e && typeof e === "object" && "code" in e && e.code === "ENOTFOUND" ? "missing" : undefined;
  }
}

// e, explained when it is Safari's "Load failed"; url is the request's,
// when the caller knows it, else the one the error names.
export async function unanswered(e: unknown, url?: string): Promise<unknown> {
  const failed = e instanceof Error ? LOAD_FAILED.exec(e.message) : null;
  if (!failed) return e;
  const [, named, more] = failed;
  url ??= named;
  const which = named === undefined ? "Load failed" : `Load failed for ${redactUrl(named)}${more === undefined ? "" : ` and ${more} more requests`}`;
  const host = url !== undefined && URL.canParse(url) ? new URL(url).hostname || undefined : undefined;
  if (host === undefined) return new Error(`${which}: ${named === undefined ? "a request" : "it"} got no answer. Its host may not exist, or the page's rules (CORS, its security policy) refused it; ${NET}`);
  const answer = await hostAnswer(host);
  if (answer === "missing") return new Error(`${which}: no such host as ${host}, so the address is wrong or out of date; ${NET}`);
  if (answer === "blocked") return new Error(`${which}: a DNS block list on this network answers 0.0.0.0 for ${host}, so the request never left this Mac; ${NET}`);
  return new Error(`${which}: ${host} ${answer === "found" ? "exists, so" : "may exist;"} the page's rules (CORS, its security policy) refused the request, or the server dropped it; ${NET}`);
}

// On 10-05 Safari could not open omp's sign-in server at localhost:54545,
// which answered curl there, yet loaded the same port by its loopback
// address: a URL filter on the Mac refused the name (01a10ea8). The
// address the server listens on is named instead, found by a connection
// alone, so a sign-in callback's one-time code is not spent asking.
async function loopback(url: URL): Promise<string | undefined> {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  for (const ip of ["127.0.0.1", "::1"]) {
    const socket = await Bun.connect({ hostname: ip, port, socket: { data() {} } }).catch(() => undefined);
    if (!socket) continue;
    socket.end();
    const at = new URL(url);
    at.hostname = ip.includes(":") ? `[${ip}]` : ip;
    return at.href;
  }
  return undefined;
}

// e, explained when Safari could not open a page whose host DNS stops or
// does not know, or a localhost page whose server listens.
export async function unopened(e: unknown): Promise<unknown> {
  const url = e instanceof Error ? UNOPENED.exec(e.message)?.[1] : undefined;
  const parsed = url === undefined ? null : URL.parse(url);
  const host = parsed?.hostname;
  if (!parsed || !host || (await import("node:net")).isIP(host)) return e;
  if (host === "localhost") {
    const at = await loopback(parsed);
    return at ? new Error(`${BROWSER_NAME} could not open ${url}, though a server listens there: something on this Mac refused the name localhost. Open ${at} instead; a page that sends the tab back to localhost fails the same way, so goto its address with ${new URL(at).host} in place of ${parsed.host}`) : e;
  }
  const answer = await hostAnswer(host);
  const why = answer === "blocked" ? `a DNS block list on this network answers 0.0.0.0 for ${host}, so Safari never reached the site` : answer === "missing" ? `${host} does not resolve to any address: the address is wrong, the site is gone, or this Mac is offline` : undefined;
  return why ? new Error(`${BROWSER_NAME} could not open ${url}: ${why}; opening it again will not help`) : e;
}
