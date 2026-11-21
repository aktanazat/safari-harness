import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { memSecretVault, totp } from "./vault.ts";

// The vault as the daemon reaches it: the real mem-secret, on scratch
// stores sealed to a scratch age key, so the user's own vault is never read
// or written.
const memSecret = Bun.which("mem-secret");
const ready = memSecret !== null && Bun.which("sops") !== null && Bun.which("age-keygen") !== null;
const NAMES = ["ENGRAM_ROOT", "SOPS_AGE_KEY_FILE", "SOPS_AGE_KEY_CMD", "PATH"] as const;
const before = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
let dir = "";
let recipient = "";

beforeAll(() => {
  if (!ready) return;
  dir = mkdtempSync("/private/var/tmp/vault-test-");
  const key = join(dir, "key.txt");
  Bun.spawnSync(["age-keygen", "-o", key], { stderr: "ignore" });
  recipient = /# public key: (\S+)/.exec(readFileSync(key, "utf8"))?.[1] ?? "";
  Object.assign(process.env, { ENGRAM_ROOT: dir, SOPS_AGE_KEY_FILE: key });
  delete process.env.SOPS_AGE_KEY_CMD;
});

afterAll(() => {
  for (const n of NAMES) {
    if (before[n] === undefined) delete process.env[n];
    else process.env[n] = before[n];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function scratchVault() {
  const store = mkdtempSync(join(dir, "logins-"));
  writeFileSync(join(store, "recipients.txt"), `${recipient}\n`);
  return memSecretVault(store);
}

// The work Mac (11-20): mem-secret on PATH through a symlink, nothing in
// ~/memory/bin, no key file, the age key in the Keychain, read by the
// _age-key-cmd installed beside mem-secret; and no login store yet. Here a
// copy of mem-secret sits beside a key command that prints the scratch key.
function workMac() {
  const root = mkdtempSync(join(dir, "work-mac-"));
  const install = join(root, "install", "bin");
  mkdirSync(install, { recursive: true });
  copyFileSync(realpathSync(memSecret ?? ""), join(install, "mem-secret"));
  writeFileSync(join(install, "_age-key-cmd"), `#!/bin/sh\nexec cat ${join(dir, "key.txt")}\n`);
  chmodSync(join(install, "_age-key-cmd"), 0o755);
  mkdirSync(join(root, "bin"));
  symlinkSync(join(install, "mem-secret"), join(root, "bin", "mem-secret"));
  const tools = [...new Set(["sops", "age", "age-keygen", "python3"].map((t) => dirname(Bun.which(t) ?? "/usr/bin")))];
  process.env.PATH = [join(root, "bin"), ...tools, "/usr/bin", "/bin"].join(":");
  delete process.env.SOPS_AGE_KEY_FILE;
  const store = join(root, "engram-logins");
  return { vault: memSecretVault(store), store };
}

const keyFile = existsSync(join(homedir(), ".config", "sops", "age", "keys.txt"));

test.skipIf(!ready || keyFile)("on a Mac with mem-secret only on PATH and the key in the Keychain, the first keep makes the store, sealed to that key, and the login reads back", async () => {
  const { vault, store } = workMac();
  try {
    await vault.keep([{ host: "huggingface.co", username: "me@example.com", password: "first" }]);
    expect(await vault.logins("huggingface.co")).toEqual([{ username: "me@example.com", password: "first", host: "huggingface.co" }]);
    expect(readFileSync(join(store, "recipients.txt"), "utf8")).toBe(`${recipient}  # this Mac only\n`);
    const health = await vault.health();
    expect(health).toEqual({ ok: true, detail: expect.stringContaining(`${store} opens and keeps 1 logins`) });
    expect(health.detail).toContain("key from the Keychain, through");
    expect(health.detail).not.toContain(join(homedir(), "memory", "bin"));
  } finally {
    process.env.PATH = before.PATH;
    process.env.SOPS_AGE_KEY_FILE = join(dir, "key.txt");
  }
}, 30_000);

test.skipIf(!ready)("health of a store not made yet says the first changed password makes it", async () => {
  const store = join(dir, "not-made");
  expect(await memSecretVault(store).health()).toEqual({ ok: true, detail: expect.stringContaining(`${store} is not made yet: the first changed password makes it`) });
  expect(existsSync(store)).toBe(false);
}, 30_000);

// A store sealed to another Mac's key takes a write this Mac then cannot
// read back, so it is refused before a change makes a password.
test.skipIf(!ready)("a store sealed to another key is not ready, and health says so", async () => {
  const store = mkdtempSync(join(dir, "logins-"));
  writeFileSync(join(store, "recipients.txt"), "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq  # another Mac\n");
  const vault = memSecretVault(store);
  await expect(vault.ready()).rejects.toThrow(`the vault at ${store} is sealed to another age key than this Mac's`);
  expect(await vault.health()).toMatchObject({ ok: false });
}, 30_000);

test.skipIf(!ready)("with mem-secret on no PATH directory, the vault is not ready and health names the PATH", async () => {
  const vault = memSecretVault(mkdtempSync(join(dir, "logins-")));
  process.env.PATH = "/usr/bin:/bin";
  try {
    await expect(vault.ready()).rejects.toThrow("mem-secret is not on this process's PATH (/usr/bin:/bin)");
    expect(await vault.health()).toEqual({ ok: false, detail: expect.stringContaining("not on this process's PATH") });
  } finally {
    process.env.PATH = before.PATH;
  }
});

// A store that opens but takes no write passed the old check, and the
// change then failed only after Apple Passwords held the new password.
test.skipIf(!ready)("a store whose folder takes no write is not ready, though it still reads", async () => {
  const store = mkdtempSync(join(dir, "logins-"));
  const vault = memSecretVault(store);
  await vault.keep([{ host: "example.org", username: "me@example.org", password: "kept" }]);
  await vault.ready();
  chmodSync(store, 0o500);
  try {
    await expect(vault.ready()).rejects.toThrow("the vault refused");
    expect(await vault.logins("example.org")).toEqual([{ username: "me@example.org", password: "kept", host: "example.org" }]);
  } finally {
    chmodSync(store, 0o700);
  }
  await vault.ready();
  expect((await vault.health()).detail).toEndWith("opens and keeps 1 logins");
}, 30_000);

// mem-secret checks for sops before anything, so health of a store not
// made yet must run it: on 11-20 health said ok where change refused.
test.skipIf(!ready)("health of a store not made yet fails when mem-secret cannot run sops", async () => {
  const bin = mkdtempSync(join(dir, "no-sops-"));
  for (const tool of ["mem-secret", "age", "age-keygen"]) symlinkSync(Bun.which(tool) ?? "", join(bin, tool));
  process.env.PATH = [bin, "/usr/bin", "/bin"].join(":");
  try {
    expect(await memSecretVault(join(dir, "never-made")).health()).toEqual({ ok: false, detail: expect.stringContaining("sops not installed") });
  } finally {
    process.env.PATH = before.PATH;
  }
}, 30_000);

// A login kept for one host must never be typed on another that only looks
// like it: shop.goodwill.com is not shop-goodwill.com.
test.skipIf(!ready)("a login kept for a site is found at its www and other hosts, and never at a host that only looks like it", async () => {
  const vault = scratchVault();
  await vault.keep([{ host: "www.shop-goodwill.com", username: "me@example.com", password: "pass=word one" }]);
  expect(await vault.logins("shop-goodwill.com")).toEqual([{ username: "me@example.com", password: "pass=word one", host: "shop-goodwill.com" }]);
  expect(await vault.logins("buyer.shop-goodwill.com")).toMatchObject([{ host: "shop-goodwill.com" }]);
  expect(await vault.logins("shop.goodwill.com")).toEqual([]);
  expect(await vault.logins("goodwill.com")).toEqual([]);
}, 30_000);

// Apple Passwords keeps ten Google accounts for accounts.google.com (10-23).
test.skipIf(!ready)("logins kept for several usernames on one host are all found, and keeping one again replaces only its password", async () => {
  const vault = scratchVault();
  const host = "accounts.example.org";
  await vault.keep([{ host, username: "b@example.org", password: "second" }, { host, username: "a@example.org", password: "first" }]);
  await vault.keep([{ host, username: "a@example.org", password: "third" }]);
  expect(await vault.logins(host)).toEqual([{ username: "a@example.org", password: "third", host }, { username: "b@example.org", password: "second", host }]);
}, 30_000);

// The import from Apple Passwords' export replaces the copy, so a login
// deleted there is not filled from here.
test.skipIf(!ready)("rebuild keeps exactly the logins it is given", async () => {
  const vault = scratchVault();
  await vault.keep([{ host: "old.example.org", username: "gone@example.org", password: "stale" }, { host: "new.example.org", username: "me@example.org", password: "old" }]);
  await vault.rebuild([{ host: "new.example.org", username: "me@example.org", password: "fresh" }]);
  expect(await vault.logins("old.example.org")).toEqual([]);
  expect(await vault.logins("new.example.org")).toEqual([{ username: "me@example.org", password: "fresh", host: "new.example.org" }]);
}, 30_000);

// A code key kept with a login must outlive a password change, or the
// next code after a reset has nothing to type.
test.skipIf(!ready)("a login's verification-code key is kept and found with it, and keeping a new password leaves the key", async () => {
  const vault = scratchVault();
  const host = "accounts.example.org";
  const otpauth = "otpauth://totp/Example:me@example.org?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example";
  await vault.keep([{ host, username: "me@example.org", password: "old", otpauth }]);
  await vault.keep([{ host, username: "me@example.org", password: "new" }]);
  expect(await vault.logins(host)).toEqual([{ username: "me@example.org", password: "new", host, otpauth }]);
}, 30_000);

// RFC 6238 appendix B: its SHA-1, SHA-256, and SHA-512 keys are the ASCII
// digits 1234567890 repeated to 20, 32, and 64 bytes, with 8-digit codes.
const KEYS = {
  SHA1: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  SHA256: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====",
  SHA512: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA=",
};
test.each([
  ["SHA1", 59, "94287082"],
  ["SHA1", 1111111109, "07081804"],
  ["SHA1", 20000000000, "65353130"],
  ["SHA256", 59, "46119246"],
  ["SHA256", 1111111109, "68084774"],
  ["SHA512", 59, "90693936"],
  ["SHA512", 1111111109, "25091201"],
] as const)("the code of RFC 6238's %s key at %i s is %s", (algorithm, seconds, code) => {
  expect(totp(`otpauth://totp/RFC?secret=${KEYS[algorithm]}&algorithm=${algorithm}&digits=8`, seconds * 1000)).toBe(code);
});

test("a key with no digits or period gives the 6-digit code of a 30-second step, as authenticator apps do", () => {
  expect(totp(`otpauth://totp/RFC?secret=${KEYS.SHA1}`, 59_000)).toBe("287082");
});
