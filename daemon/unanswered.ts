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

import { isIP } from "node:net";
import { promises as dns } from "node:dns";

const LOAD_FAILED = /^(?:TypeError: )?Load failed$/;
const UNOPENED = /^Safari could not open (\S+): the site did not answer$/;
const NET = "net shows the addresses the page itself calls";

// What DNS says of a host, asked as Safari asks it, through the system's
// resolver: an address; only 0.0.0.0 or ::, which a DNS block list answers
// for a name it stops; no such name (as for every name offline); or
// undefined when it could not say.
export type HostAnswer = "found" | "blocked" | "missing";
export async function hostAnswer(host: string): Promise<HostAnswer | undefined> {
  try {
    const found = await dns.lookup(host, { all: true });
    return found.every((a) => a.address === "0.0.0.0" || a.address === "::") ? "blocked" : "found";
  } catch (e) {
    return e && typeof e === "object" && "code" in e && e.code === "ENOTFOUND" ? "missing" : undefined;
  }
}

// e, explained when it is Safari's "Load failed"; url is the request's.
export async function unanswered(e: unknown, url?: string): Promise<unknown> {
  if (!(e instanceof Error) || !LOAD_FAILED.test(e.message)) return e;
  const host = url !== undefined && URL.canParse(url) ? new URL(url).hostname : undefined;
  if (host === undefined) return new Error(`Load failed: a request got no answer. Its host may not exist, or the page's rules (CORS, its security policy) refused it; ${NET}`);
  const answer = await hostAnswer(host);
  if (answer === "missing") return new Error(`Load failed: no such host as ${host}, so the address is wrong or out of date; ${NET}`);
  if (answer === "blocked") return new Error(`Load failed: a DNS block list on this network answers 0.0.0.0 for ${host}, so the request never left this Mac; ${NET}`);
  return new Error(`Load failed: ${host} ${answer === "found" ? "exists, so" : "may exist;"} the page's rules (CORS, its security policy) refused the request, or the server dropped it; ${NET}`);
}

// e, explained when Safari could not open a page whose host DNS stops or
// does not know.
export async function unopened(e: unknown): Promise<unknown> {
  const url = e instanceof Error ? UNOPENED.exec(e.message)?.[1] : undefined;
  const host = url === undefined ? undefined : URL.parse(url)?.hostname;
  if (!host || isIP(host)) return e;
  const answer = await hostAnswer(host);
  const why = answer === "blocked" ? `a DNS block list on this network answers 0.0.0.0 for ${host}, so Safari never reached the site` : answer === "missing" ? `${host} does not resolve to any address: the address is wrong, the site is gone, or this Mac is offline` : undefined;
  return why ? new Error(`Safari could not open ${url}: ${why}; opening it again will not help`) : e;
}
