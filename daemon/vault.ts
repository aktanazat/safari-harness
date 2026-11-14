// Logins and their verification-code keys kept on this Mac only, the one
// source of every fill and code, so none needs Touch ID: a mem-secret store
// of their own (sops and age), sealed to this Mac's age key alone and never
// synced, so no other host can open them. A password a change saves to
// Apple Passwords is copied here, and the whole store can be dropped and
// rebuilt from its export (scripts/import-apple-passwords.ts). On 10-13 the
// user chose fewer prompts over Apple Passwords asking on every fill; on
// 10-23, that no website login sit where the VPS can read it; on 11-13, that
// Apple Passwords never be asked for a password or a code.
//
// mem-secret never prints a value: run hands the wanted variables to env,
// whose output only this process reads, and batch takes new values on
// stdin. Nothing here logs or returns a password to a caller.

import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { site as siteOf } from "./receipt.ts";

// otpauth: the login's verification-code key, an otpauth://totp/ URI.
export type Login = { username: string; password: string; host: string; otpauth?: string };

export type Vault = {
  // The logins kept for host, else for the nearest of its parent hosts
  // within its site that keeps any; none when none is kept.
  logins(host: string): Promise<Login[]>;
  // Keeps each login for its host, less a leading www., replacing the
  // password kept for the same username there.
  keep(logins: Login[]): Promise<void>;
};

const MEM_SECRET = join(homedir(), "memory", "bin", "mem-secret");
export const LOGINS_DIR = join(homedir(), ".config", "engram-logins");
// With the key file named, sops never reads the key from the Keychain, which
// could ask the user to allow it. A key the daemon's environment names wins.
const AGE_KEY = join(homedir(), ".config", "sops", "age", "keys.txt");
// A vault call still running then waits on something nobody answers; the
// fill fails rather than hang.
const VAULT_MS = 15000;

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
  async function memSecret(args: string[], stdin?: string): Promise<string> {
    const proc = Bun.spawn([MEM_SECRET, ...args], {
      env: { ...(existsSync(AGE_KEY) ? { SOPS_AGE_KEY_FILE: AGE_KEY } : {}), ...process.env, ENGRAM_SECRETS_DIR: dir },
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: VAULT_MS,
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (proc.signalCode) throw new Error(`the vault did not answer within ${VAULT_MS / 1000} s`);
    if (code !== 0) throw new Error(`the vault refused: ${err.trim().split("\n").pop() || `mem-secret exited ${code}`}`);
    return out;
  }

  const listed = async (): Promise<string[]> => (await memSecret(["list"])).split("\n").filter(Boolean);

  async function write(logins: Login[], remove: string[]): Promise<void> {
    const set: Record<string, string> = {};
    for (const login of logins) {
      const why = refusal(login);
      if (why) throw new Error(why);
      const v = names(login.host.replace(/^www\./, ""), login.username);
      set[v.username] = login.username;
      set[v.password] = login.password;
      if (login.otpauth !== undefined) set[v.otpauth] = login.otpauth;
    }
    await memSecret(["batch"], JSON.stringify({ version: 1, set, remove: remove.filter((n) => !(n in set)) }));
  }

  return {
    async logins(host) {
      const all = await listed();
      for (const h of hostsOf(host)) {
        const p = prefix(h);
        const vars = all.filter((n) => n.startsWith(p));
        if (!vars.length) continue;
        const out = await memSecret(["run", ...vars, "--", "/usr/bin/env"]);
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

    keep: (logins) => write(logins, []),

    // Replaces every login kept with logins.
    rebuild: async (logins) => write(logins, (await listed()).filter((n) => n.startsWith("LOGIN_"))),
  };
}
