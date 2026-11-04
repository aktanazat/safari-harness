import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { memSecretVault } from "./vault.ts";

// The vault as the daemon reaches it: the real mem-secret, on scratch
// stores sealed to a scratch age key, so the user's own vault is never read
// or written.
const ready = existsSync(join(homedir(), "memory", "bin", "mem-secret")) && Bun.which("sops") !== null && Bun.which("age-keygen") !== null;
const NAMES = ["ENGRAM_ROOT", "SOPS_AGE_KEY_FILE"] as const;
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
