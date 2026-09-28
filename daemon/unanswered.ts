// Safari says only "Load failed" for a request that got no answer at all:
// its host may not exist, or the page's rules (CORS, its security policy)
// refused it, or the server dropped the connection. On 09-28 an agent read
// it as this Mac's network failing, when the address it built from a
// dealer page's settings named a host that exists nowhere. Where the
// address is known, the error says whether its host exists.

import { lookup } from "node:dns/promises";

const LOAD_FAILED = /^(?:TypeError: )?Load failed$/;
const NET = "net shows the addresses the page itself calls";

// false only when DNS says the name does not exist; undefined when it could
// not say (no network).
export async function hostResolves(host: string): Promise<boolean | undefined> {
  try {
    await lookup(host);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "ENOTFOUND" ? false : undefined;
  }
}

// e, explained when it is Safari's "Load failed"; url is the request's.
export async function unanswered(e: unknown, url?: string): Promise<unknown> {
  if (!(e instanceof Error) || !LOAD_FAILED.test(e.message)) return e;
  const host = url !== undefined && URL.canParse(url) ? new URL(url).hostname : undefined;
  if (host === undefined) return new Error(`Load failed: a request got no answer. Its host may not exist, or the page's rules (CORS, its security policy) refused it; ${NET}`);
  const resolves = await hostResolves(host);
  if (resolves === false) return new Error(`Load failed: no such host as ${host}, so the address is wrong or out of date; ${NET}`);
  return new Error(`Load failed: ${host} ${resolves ? "exists, so" : "may exist;"} the page's rules (CORS, its security policy) refused the request, or the server dropped it; ${NET}`);
}
