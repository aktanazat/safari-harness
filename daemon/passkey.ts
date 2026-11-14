// The server the user's iPhone opens to approve an agent's step with Face
// ID while he is away from the Mac (phone-approvals.ts, under /a/), and the
// checks of what the page sends back. It listens on
// 127.0.0.1:SAFARI_HARNESS_PHONE_PORT (default 37335), and tailscale serve
// gives it an HTTPS address on his tailnet only, which a passkey needs; a
// Funnel, which would open it to the internet, is refused. An answer counts
// only once the passkey's public key checks it: the request's single-use
// challenge, the page's origin and rpId, that Face ID verified him (UV),
// and the ES256 signature.

import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Credential = { id: string; key: string };

// A check of the phone's answer that failed: the page shows why.
export class Refused extends Error {}

export const b64 = (b: Buffer) => b.toString("base64url");
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

export function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
}

function port(): number {
  const given = process.env.SAFARI_HARNESS_PHONE_PORT ?? "37335";
  const p = Number(given);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`SAFARI_HARNESS_PHONE_PORT is ${given}, not a port`);
  return p;
}

// The page's address on his tailnet: the HTTPS address tailscale serve
// passes to this port, or SAFARI_HARNESS_PHONE_ORIGIN.
export async function pageOrigin(): Promise<string> {
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

// A page the server shows: the request its link names by id, and whether
// the page asks for that request's options.
export type Page = (r: Request, id: string, asked: boolean) => Promise<Response> | Response;

// The pages by the first part of a link's path: a, an agent's step
// (phone-approvals.ts).
const pages = new Map<string, Page>();
let listening = false;

// Shows page under /<prefix>/, and starts the server the first time.
export function listen(prefix: string, page: Page): void {
  pages.set(prefix, page);
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

export function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

const PATH = /^\/([a-z])\/([A-Za-z0-9_-]{22})(\/options)?\/?$/;

async function route(r: Request): Promise<Response> {
  const m = PATH.exec(new URL(r.url).pathname);
  const page = m ? pages.get(m[1]) : undefined;
  if (!m || !page) return json(404, { error: "Not found." });
  return page(r, m[2], m[3] !== undefined);
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
export function registered(a: { origin: string; rpId: string }, challenge: string, v: unknown): Credential {
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

// An assertion: this request's challenge, signed by its passkey.
export function asserted(a: { origin: string; rpId: string; challenge: string }, credential: Credential, v: unknown): void {
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

// The page's headers: its CSP names its script and style by hash.
export function pageHeaders(script: string, style: string): Record<string, string> {
  const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}
