import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { memSecretVault } from "./vault.ts";

// The vault as the daemon reaches it: the real mem-secret, on a scratch
// store sealed to a scratch age key, so the user's own vault is never read
// or written.
const ready = existsSync(join(homedir(), "memory", "bin", "mem-secret")) && Bun.which("sops") !== null && Bun.which("age-keygen") !== null;
const NAMES = ["ENGRAM_ROOT", "ENGRAM_SECRETS_DIR", "SOPS_AGE_KEY_FILE"] as const;
const before = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
let dir = "";

beforeAll(() => {
  if (!ready) return;
  dir = mkdtempSync("/private/var/tmp/vault-test-");
  const secrets = join(dir, "secrets");
  mkdirSync(secrets);
  const key = join(dir, "key.txt");
  Bun.spawnSync(["age-keygen", "-o", key], { stderr: "ignore" });
  writeFileSync(join(secrets, "recipients.txt"), `${/# public key: (\S+)/.exec(readFileSync(key, "utf8"))?.[1]}\n`);
  Object.assign(process.env, { ENGRAM_ROOT: dir, ENGRAM_SECRETS_DIR: secrets, SOPS_AGE_KEY_FILE: key });
});

afterAll(() => {
  for (const n of NAMES) {
    if (before[n] === undefined) delete process.env[n];
    else process.env[n] = before[n];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// A login kept for one host must never be typed on another that only looks
// like it: shop.goodwill.com is not shop-goodwill.com.
test.skipIf(!ready)("a login kept for a site is found at its www and other hosts, and never at a host that only looks like it", async () => {
  await memSecretVault.keep("www.shop-goodwill.com", "me@example.com", "pass=word one");
  expect(await memSecretVault.login("shop-goodwill.com")).toEqual({ username: "me@example.com", password: "pass=word one", host: "shop-goodwill.com" });
  expect(await memSecretVault.login("buyer.shop-goodwill.com")).toMatchObject({ host: "shop-goodwill.com" });
  expect(await memSecretVault.login("shop.goodwill.com")).toBeUndefined();
  expect(await memSecretVault.login("goodwill.com")).toBeUndefined();
}, 30_000);
