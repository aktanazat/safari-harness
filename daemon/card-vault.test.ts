import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cardOf, memSecretCards } from "./card-vault.ts";

// The card vault as cards.ts reaches it: the real mem-secret, on scratch
// stores under a scratch age key, so the user's own cards are never read or
// written. Each store starts unsealed, as the first save on a Mac finds it.
const ready = existsSync(join(homedir(), "memory", "bin", "mem-secret")) && Bun.which("sops") !== null && Bun.which("age-keygen") !== null;
const NAMES = ["ENGRAM_ROOT", "SOPS_AGE_KEY_FILE"] as const;
const before = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
let dir = "";
let recipient = "";

const AMEX = { number: "3782 8224 6310 005", exp: "09/39", csc: "7373", name: "Ada Lovelace", zip: "94107", label: "Work" };

beforeAll(() => {
  if (!ready) return;
  dir = mkdtempSync("/private/var/tmp/card-vault-test-");
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

test.skipIf(!ready)("a kept card lists by what names it, reads back whole, and is gone once removed", async () => {
  const vault = memSecretCards(mkdtempSync(join(dir, "cards-")));
  const [kept] = await vault.keep([cardOf(AMEX)]);
  expect(await vault.list()).toEqual([{ id: kept.id, label: "Work", brand: "Amex", last4: "0005", exp: "09/39", name: "Ada Lovelace" }]);
  expect(await vault.read(kept.id)).toEqual({ number: "378282246310005", month: 9, year: 2039, csc: "7373", name: "Ada Lovelace", zip: "94107" });
  await vault.remove(kept.id);
  expect(await vault.list()).toEqual([]);
  await expect(vault.read(kept.id)).rejects.toThrow("the card vault holds no such card");
}, 30_000);

// scripts/import-cards.ts keeps every card under its label, so running it
// again leaves one copy of each; and cards.ts names a card by its label in
// any case, so two labels that differ only in case could not be told apart.
test.skipIf(!ready)("keeping a card under a label already kept, in any case, replaces that card", async () => {
  const vault = memSecretCards(mkdtempSync(join(dir, "cards-")));
  await vault.keep([cardOf(AMEX), cardOf({ number: "4242424242424242", exp: "07/39", csc: "737" })]);
  const [again] = await vault.keep([cardOf({ ...AMEX, label: "work", number: "5555555555554444", csc: "123" })]);
  expect((await vault.list()).map((c) => `${c.label} ${c.last4}`)).toEqual(["Visa 4242 4242", "work 4444"]);
  expect(await vault.read(again.id)).toMatchObject({ number: "5555555555554444", csc: "123" });
}, 30_000);

// No other host may open the cards: the shared vault's recipients include
// the VPS.
test.skipIf(!ready)("the first save seals the store to this Mac's key alone, and the file on disk shows no card number", async () => {
  const store = join(dir, "fresh");
  await memSecretCards(store).keep([cardOf(AMEX)]);
  expect(readFileSync(join(store, "recipients.txt"), "utf8")).toBe(`${recipient}  # this Mac only\n`);
  expect(statSync(join(store, "recipients.txt")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(store, "secrets.env"), "utf8")).not.toContain("378282246310005");
}, 30_000);
