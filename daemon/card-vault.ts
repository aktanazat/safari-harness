// Payment cards kept on this Mac only, so a fill asks the user nothing: no
// Touch ID, no Face ID on his phone, no window. A mem-secret store of their
// own (sops and age), sealed to this Mac's age key alone and never synced,
// as his logins are (vault.ts): the owner's order of 11-13, after the
// keychain helper that kept them asked Touch ID for fills.
// scripts/import-cards.ts moved that helper's cards here once.
//
// mem-secret never prints a value: run hands the wanted variables to env,
// whose output only this process reads, and batch takes new values on
// stdin. A list reads only what names each card; a fill reads its one
// card's digits, which go back to the fill alone (cards.ts). Nothing here
// logs a value. The store opens to anything running as the user on this
// Mac, as his logins' does: what keeps digits from agents is that the tools
// never answer with one, not a lock on the store.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// What names a saved card: all an agent sees of one.
export type Listed = { id: string; label: string; brand: string; last4: string; exp: string; name: string };
// What fills one in, held only by the fill it was read for.
export type Card = { number: string; month: number; year: number; csc: string; name: string; zip: string };
// A card checked to keep (cardOf).
export type Checked = Card & { label: string; brand: string };

export type CardVault = {
  list(): Promise<Listed[]>;
  read(id: string): Promise<Card>;
  // Keeps each card, replacing one saved under the same label in any case,
  // as cards.ts names a card by its label in any case.
  keep(cards: Checked[]): Promise<Listed[]>;
  remove(id: string): Promise<void>;
};

const MEM_SECRET = join(homedir(), "memory", "bin", "mem-secret");
export const CARDS_DIR = join(homedir(), ".config", "engram-cards");
// With the key file named, sops never reads the key from the Keychain, which
// could ask the user to allow it. A key the daemon's environment names wins.
const AGE_KEY = join(homedir(), ".config", "sops", "age", "keys.txt");
// A vault call still running then waits on something nobody answers.
const VAULT_MS = 15000;

// CARD_<ID>_<PART>, with ID random: the names sit in the clear beside the
// sealed values, so none says anything of the card. The expiry is kept as
// MM/YYYY.
const ID = /^CARD_([0-9A-F]{12})_LABEL$/;
const NAMING = ["LABEL", "BRAND", "LAST4", "EXP", "NAME"];
const FILLING = ["NUMBER", "CSC", "EXP", "NAME", "ZIP"];
const PARTS = [...NAMING, "NUMBER", "CSC", "ZIP"];

const part = (id: string, p: string) => `CARD_${id}_${p}`;
const mm = (month: number) => String(month).padStart(2, "0");
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// The checksum every card number carries, which catches a mistyped digit.
function luhn(number: string): boolean {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    const d = Number(number[number.length - 1 - i]) * (i % 2 ? 2 : 1);
    sum += d > 9 ? d - 9 : d;
  }
  return sum % 10 === 0;
}

function brandOf(n: string): string {
  const within = (k: number, lo: number, hi: number) => Number(n.slice(0, k)) >= lo && Number(n.slice(0, k)) <= hi;
  if (n.startsWith("4")) return "Visa";
  if (within(2, 51, 55) || within(4, 2221, 2720)) return "Mastercard";
  if (n.startsWith("34") || n.startsWith("37")) return "Amex";
  if (n.startsWith("6011") || n.startsWith("65") || within(3, 644, 649)) return "Discover";
  if (within(4, 3528, 3589)) return "JCB";
  if (within(3, 300, 305) || n.startsWith("36") || n.startsWith("38")) return "Diners";
  if (n.startsWith("62")) return "UnionPay";
  return "Card";
}

// "07/29", "7/2029", "07 / 29", "0729", or "072029": the month and the
// four-digit year. A card past its month is refused.
function expiry(raw: string): { month: number; year: number } {
  const runs = raw.split(/\D+/).filter(Boolean);
  const [m, y] = runs.length === 2 ? runs : runs.length === 1 && (runs[0].length === 4 || runs[0].length === 6) ? [runs[0].slice(0, 2), runs[0].slice(2)] : [];
  const month = Number(m);
  if (!y || !(month >= 1 && month <= 12) || (y.length !== 2 && y.length !== 4)) throw new Error("the expiry must read MM/YY");
  const year = Number(y) + (y.length === 2 ? 2000 : 0);
  const now = new Date();
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) throw new Error(`that card expired at the end of ${mm(month)}/${String(year % 100).padStart(2, "0")}`);
  return { month, year };
}

// The card the user gave, checked as the keychain helper checked it: the
// number's checksum, an expiry not past, a 3 or 4 digit code. With no label
// it is named by its brand and last 4.
export function cardOf(input: { number?: unknown; exp?: unknown; csc?: unknown; name?: unknown; zip?: unknown; label?: unknown }): Checked {
  const number = text(input.number).replace(/[ -]/g, "");
  if (!/^\d{12,19}$/.test(number)) throw new Error("the card number must be 12 to 19 digits");
  if (!luhn(number)) throw new Error("that card number fails the check every card number passes; look for a mistyped digit");
  const { month, year } = expiry(text(input.exp));
  const csc = text(input.csc);
  if (!/^\d{3,4}$/.test(csc)) throw new Error("the security code must be 3 or 4 digits");
  const [label, name, zip] = [text(input.label), text(input.name), text(input.zip)];
  if (/[\p{Cc}\\]/u.test(label + name + zip)) throw new Error("the vault keeps no label, name, or zip with a line break or other control character, or a backslash");
  const brand = brandOf(number);
  return { number, month, year, csc, name, zip, brand, label: label ? [...label].slice(0, 40).join("") : `${brand} ${number.slice(-4)}` };
}

export function memSecretCards(dir = CARDS_DIR): CardVault {
  async function memSecret(args: string[], stdin?: string): Promise<string> {
    const proc = Bun.spawn([MEM_SECRET, ...args], {
      env: { ...(existsSync(AGE_KEY) ? { SOPS_AGE_KEY_FILE: AGE_KEY } : {}), ...process.env, ENGRAM_SECRETS_DIR: dir },
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: VAULT_MS,
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (proc.signalCode) throw new Error(`the card vault did not answer within ${VAULT_MS / 1000} s`);
    if (code !== 0) throw new Error(`the card vault refused: ${err.trim().split("\n").pop() || `mem-secret exited ${code}`}`);
    return out;
  }

  async function values(vars: string[]): Promise<(name: string) => string> {
    const out = await memSecret(["run", ...vars, "--", "/usr/bin/env"]);
    const wanted = new Set(vars);
    const env = new Map<string, string>();
    for (const line of out.split("\n")) {
      const name = line.slice(0, line.indexOf("="));
      if (wanted.has(name)) env.set(name, line.slice(name.length + 1));
    }
    return (name) => env.get(name) ?? "";
  }

  // The store opens with the key mem-secret uses on this Mac: the one the
  // environment names, the key file, else the Keychain's.
  async function seal(): Promise<void> {
    if (existsSync(join(dir, "recipients.txt"))) return;
    const keyFile = process.env.SOPS_AGE_KEY_FILE ?? (existsSync(AGE_KEY) ? AGE_KEY : undefined);
    const proc = Bun.spawn(keyFile ? ["age-keygen", "-y", keyFile] : ["sh", "-c", `"$0" | age-keygen -y`, join(homedir(), "memory", "bin", "_age-key-cmd")], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: VAULT_MS });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const recipient = out.trim();
    if (code !== 0 || !recipient.startsWith("age1")) throw new Error("this Mac's age key could not be read");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "recipients.txt"), `${recipient}  # this Mac only\n`, { mode: 0o600 });
  }

  async function list(): Promise<Listed[]> {
    const ids = (await memSecret(["list"])).split("\n").flatMap((n) => ID.exec(n)?.[1] ?? []);
    if (!ids.length) return [];
    const get = await values(ids.flatMap((id) => NAMING.map((p) => part(id, p))));
    return ids
      .map((id) => {
        const [month = "", year = ""] = get(part(id, "EXP")).split("/");
        return { id, label: get(part(id, "LABEL")), brand: get(part(id, "BRAND")), last4: get(part(id, "LAST4")), exp: `${month}/${year.slice(-2)}`, name: get(part(id, "NAME")) };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  return {
    list,

    async read(id) {
      const get = await values(FILLING.map((p) => part(id, p)));
      const [month, year] = get(part(id, "EXP")).split("/").map(Number);
      const card = { number: get(part(id, "NUMBER")), month, year, csc: get(part(id, "CSC")), name: get(part(id, "NAME")), zip: get(part(id, "ZIP")) };
      if (!card.number || !card.csc || !month || !year) throw new Error("the card vault holds no such card; call cards for the saved ones");
      return card;
    },

    async keep(cards) {
      if (!cards.length) return [];
      await seal();
      const saved = await list();
      const set: Record<string, string> = {};
      const remove = new Set<string>();
      const kept: Listed[] = [];
      for (const c of new Map(cards.map((c) => [c.label.toLowerCase(), c])).values()) {
        for (const old of saved.filter((s) => s.label.toLowerCase() === c.label.toLowerCase())) for (const p of PARTS) remove.add(part(old.id, p));
        const id = randomBytes(6).toString("hex").toUpperCase();
        const last4 = c.number.slice(-4);
        Object.assign(set, {
          [part(id, "LABEL")]: c.label,
          [part(id, "BRAND")]: c.brand,
          [part(id, "LAST4")]: last4,
          [part(id, "EXP")]: `${mm(c.month)}/${c.year}`,
          [part(id, "NUMBER")]: c.number,
          [part(id, "CSC")]: c.csc,
          ...(c.name ? { [part(id, "NAME")]: c.name } : {}),
          ...(c.zip ? { [part(id, "ZIP")]: c.zip } : {}),
        });
        kept.push({ id, label: c.label, brand: c.brand, last4, exp: `${mm(c.month)}/${String(c.year).slice(-2)}`, name: c.name });
      }
      await memSecret(["batch"], JSON.stringify({ version: 1, set, remove: [...remove] }));
      return kept;
    },

    async remove(id) {
      await memSecret(["batch"], JSON.stringify({ version: 1, set: {}, remove: PARTS.map((p) => part(id, p)) }));
    },
  };
}
