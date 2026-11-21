// Logins and their verification-code keys kept on this Mac only, the one
// source of every fill and code, so none needs Touch ID: a mem-secret store
// of their own (sops and age), sealed to this Mac's age key alone and never
// synced, so no other host can open them. A password a change saves to
// Apple Passwords is copied here, and the whole store can be dropped and
// rebuilt from its export (scripts/import-apple-passwords.ts). On 10-13 the
// user chose fewer prompts over Apple Passwords asking on every fill; on
// 10-23, that no website login sit where the VPS can read it; on 11-13, that
// Apple Passwords never be asked for a password or a code.
// 11-20: a change made on a Mac whose store did not exist yet saved the new
// password to Apple Passwords alone, and every fill after it failed; the
// first keep now makes the store, and change proves it can keep one before
// it makes any (passwords.ts).

import { createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { memSecretStore } from "./mem-secret.ts";
import { site as siteOf } from "./receipt.ts";

// otpauth: the login's verification-code key, an otpauth://totp/ URI.
export type Login = { username: string; password: string; host: string; otpauth?: string };

export type Vault = {
  // The logins kept for host, else for the nearest of its parent hosts
  // within its site that keeps any; none when none is kept.
  logins(host: string): Promise<Login[]>;
  // Keeps each login for its host, less a leading www., replacing the
  // password kept for the same username there. The first keep makes the
  // store.
  keep(logins: Login[]): Promise<void>;
  // Makes the store if need be and proves a write to it lands, or throws
  // why it cannot keep a login.
  ready(): Promise<void>;
  // Where mem-secret is, the key's source, and the store's state, in plain
  // words, for status and doctor; never throws.
  health(): Promise<{ ok: boolean; detail: string }>;
};

const LOGINS_DIR = join(homedir(), ".config", "engram-logins");

// How a login missing from the copy gets there, as an error's next step.
export const REBUILD = `rebuild the copy from Apple Passwords: in the Passwords app, File > Export All Passwords to File, then bun ${join(import.meta.dir, "..", "scripts", "import-apple-passwords.ts")} <that file>`;

// What ready writes to prove a write lands: the time of the last proof,
// no secret, and no login (logins are LOGIN_ names).
const PROBE = "HARNESS_VAULT_PROBE";

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

// LOGIN_<HOST>___<ID>_USERNAME, _PASSWORD and _OTPAUTH: the host upper-cased with "."
// as "_" and "-" as "__", and ID from the username. No DNS label starts or
// ends with "-", so a host makes runs of one "_" or an even number, never
// three: no two hosts share a prefix (shop-goodwill.com and
// shop.goodwill.com stay apart), and "___" ends the host.
function prefix(host: string): string {
  if (!HOST.test(host)) throw new Error(`the vault keeps no logins for ${host}`);
  return `LOGIN_${host.toUpperCase().replaceAll("-", "__").replaceAll(".", "_")}___`;
}

function names(host: string, username: string): { username: string; password: string; otpauth: string } {
  const key = `${prefix(host)}${new Bun.CryptoHasher("sha256").update(username).digest("hex").slice(0, 12).toUpperCase()}`;
  return { username: `${key}_USERNAME`, password: `${key}_PASSWORD`, otpauth: `${key}_OTPAUTH` };
}

// Why the vault cannot keep login, or undefined when it can.
export function refusal(login: Login): string | undefined {
  if (!HOST.test(login.host.replace(/^www\./, ""))) return `the vault keeps no logins for ${login.host}`;
  if (!login.username || !login.password) return "the vault keeps no empty username or password";
  if (/[\n\\]/.test(login.username + login.password)) return "the vault keeps no value with a line break or backslash";
  return undefined;
}

// host, then each parent of it down to its site: www.shopgoodwill.com, then
// shopgoodwill.com.
function hostsOf(host: string): string[] {
  const site = siteOf(host);
  const hosts = [host];
  for (let h = host; h !== site && h.includes("."); ) {
    h = h.slice(h.indexOf(".") + 1);
    hosts.push(h);
  }
  return hosts;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// The current code of an otpauth://totp/ key (RFC 6238), as an
// authenticator app shows it.
export function totp(uri: string, now = Date.now()): string {
  const q = new URL(uri).searchParams;
  const digits = Number(q.get("digits") ?? 6);
  const period = Number(q.get("period") ?? 30);
  const bits = [...(q.get("secret") ?? "").toUpperCase().replace(/[=\s-]/g, "")].map((c) => {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new Error("the vault's verification-code key is not base32");
    return v.toString(2).padStart(5, "0");
  }).join("");
  const secret = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const mac = createHmac((q.get("algorithm") ?? "SHA1").toLowerCase(), secret).update(counter).digest();
  const n = mac.readUInt32BE(mac[mac.length - 1] & 0xf) & 0x7fffffff;
  return String(n % 10 ** digits).padStart(digits, "0");
}

export function memSecretVault(dir = LOGINS_DIR): Vault & { rebuild(logins: Login[]): Promise<void> } {
  const store = memSecretStore(dir, "vault");

  // Removes the names stale picks from those the store keeps.
  async function write(logins: Login[], stale: (kept: string[]) => string[]): Promise<void> {
    const set: Record<string, string> = {};
    for (const login of logins) {
      const why = refusal(login);
      if (why) throw new Error(why);
      const v = names(login.host.replace(/^www\./, ""), login.username);
      set[v.username] = login.username;
      set[v.password] = login.password;
      if (login.otpauth !== undefined) set[v.otpauth] = login.otpauth;
    }
    const { names: kept = [] } = await store.open(true);
    await store.call(["batch"], JSON.stringify({ version: 1, set, remove: stale(kept).filter((n) => !(n in set)) }));
  }

  return {
    async logins(host) {
      const all = (await store.call(["list"])).split("\n").filter(Boolean);
      for (const h of hostsOf(host)) {
        const p = prefix(h);
        const vars = all.filter((n) => n.startsWith(p));
        if (!vars.length) continue;
        const out = await store.call(["run", ...vars, "--", "/usr/bin/env"]);
        const wanted = new Set(vars);
        const env = new Map<string, string>();
        for (const line of out.split("\n")) {
          const name = line.slice(0, line.indexOf("="));
          if (wanted.has(name)) env.set(name, line.slice(name.length + 1));
        }
        const logins = vars.flatMap((n) => {
          if (!n.endsWith("_USERNAME")) return [];
          const key = n.slice(0, -"_USERNAME".length);
          const username = env.get(n);
          const password = env.get(`${key}_PASSWORD`);
          const otpauth = env.get(`${key}_OTPAUTH`);
          return username && password ? [{ username, password, host: h, ...(otpauth ? { otpauth } : {}) }] : [];
        });
        if (logins.length) return logins.sort((a, b) => a.username.localeCompare(b.username));
      }
      return [];
    },

    keep: (logins) => write(logins, () => []),

    // A store that only reads (its folder not writable, say) fails here,
    // through the same mem-secret batch a keep runs.
    ready: async () => {
      await store.open(true);
      await store.call(["batch"], JSON.stringify({ version: 1, set: { [PROBE]: new Date().toISOString() }, remove: [] }));
    },

    health: () =>
      store.open(false).then(
        ({ memSecret, key, names }) => ({
          ok: true,
          detail: `mem-secret ${memSecret}, key from ${key}; ${names === undefined ? `${dir} is not made yet: the first changed password makes it` : `${dir} opens and keeps ${names.filter((n) => n.endsWith("_USERNAME")).length} logins`}`,
        }),
        (e: Error) => ({ ok: false, detail: e.message }),
      ),

    // Replaces every login kept with logins.
    rebuild: (logins) => write(logins, (kept) => kept.filter((n) => n.startsWith("LOGIN_"))),
  };
}
