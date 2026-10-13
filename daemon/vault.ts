// Logins kept in engram's vault (mem-secret: sops and age, the key in a
// file only this user reads), so a fill needs no Touch ID. Apple Passwords
// asks for Touch ID on every password it hands out; on 10-13 the user chose
// fewer prompts over that, and the vault is where agents already read
// secrets without one. A fill tries the vault first (passwords.ts); a login
// Apple Passwords fills, or a password a change saves, is kept here too.
//
// mem-secret never prints a value: run hands the wanted variables to env,
// whose output only this process reads, and batch takes new values on
// stdin. Nothing here logs or returns a password to a caller.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { site as siteOf } from "./receipt.ts";

export type Login = { username: string; password: string; host: string };

export type Vault = {
  // The login kept for host, else for the nearest of its parent hosts
  // within its site; undefined when none is kept.
  login(host: string): Promise<Login | undefined>;
  // Keeps username and password for host, less a leading www., replacing
  // the login kept for it.
  keep(host: string, username: string, password: string): Promise<void>;
};

const MEM_SECRET = join(homedir(), "memory", "bin", "mem-secret");
// With the key file named, sops never reads the key from the Keychain, which
// could ask the user to allow it. A key the daemon's environment names wins.
const AGE_KEY = join(homedir(), ".config", "sops", "age", "keys.txt");
// A vault call still running then waits on something nobody answers; the
// fill goes on through Apple Passwords instead.
const VAULT_MS = 15000;

// LOGIN_<HOST>_USERNAME and _PASSWORD, the host upper-cased with "." as "_"
// and "-" as "__". No DNS label starts or ends with "-", so no two hosts
// share a name: shop-goodwill.com and shop.goodwill.com stay apart.
function names(host: string): { username: string; password: string } {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) throw new Error(`the vault keeps no logins for ${host}`);
  const key = `LOGIN_${host.toUpperCase().replaceAll("-", "__").replaceAll(".", "_")}`;
  return { username: `${key}_USERNAME`, password: `${key}_PASSWORD` };
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

async function memSecret(args: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn([MEM_SECRET, ...args], {
    env: { ...(existsSync(AGE_KEY) ? { SOPS_AGE_KEY_FILE: AGE_KEY } : {}), ...process.env },
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

export const memSecretVault: Vault = {
  async login(host) {
    const hosts = hostsOf(host);
    const vars = hosts.map(names);
    const out = await memSecret(["run", ...vars.flatMap((v) => [v.username, v.password]), "--", "/usr/bin/env"]);
    const wanted = new Set(vars.flatMap((v) => [v.username, v.password]));
    const env = new Map<string, string>();
    for (const line of out.split("\n")) {
      const name = line.slice(0, line.indexOf("="));
      if (wanted.has(name)) env.set(name, line.slice(name.length + 1));
    }
    for (const [i, v] of vars.entries()) {
      const username = env.get(v.username);
      const password = env.get(v.password);
      if (username && password) return { username, password, host: hosts[i] };
    }
    return undefined;
  },

  async keep(host, username, password) {
    const v = names(host.replace(/^www\./, ""));
    if (!username || !password) throw new Error("the vault keeps no empty username or password");
    if (/[\n\\]/.test(username + password)) throw new Error("the vault keeps no value with a line break or backslash");
    await memSecret(["batch"], JSON.stringify({ version: 1, set: { [v.username]: username, [v.password]: password }, remove: [] }));
  },
};
