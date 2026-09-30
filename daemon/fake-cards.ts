#!/usr/bin/env bun
// A stand-in for Safari Harness Cards, the keychain helper app (cards.ts),
// for cards.test.ts: the same commands and answers, with the cards kept in
// a file under FAKE_CARDS_DIR instead of the keychain, and a line added to
// its approvals file for each Touch ID the helper would have asked: one
// per serve process, at its first read.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Saved = { id: string; label: string; number: string; exp: string; csc: string; name: string; zip: string };

const dir = process.env.FAKE_CARDS_DIR ?? ".";
const store = join(dir, "cards.json");
const saved = (): Saved[] => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : []);
const listed = (c: Saved) => ({ id: c.id, label: c.label, brand: "Visa", last4: c.number.slice(-4), exp: c.exp, name: c.name });
const [cmd, arg] = process.argv.slice(2);

if (cmd === "list") {
  console.log(JSON.stringify({ cards: saved().map(listed) }));
} else if (cmd === "save") {
  const c = JSON.parse(await Bun.stdin.text());
  const card: Saved = { id: `card-${saved().length + 1}`, label: c.label ?? "Visa", number: c.number, exp: c.exp, csc: c.csc, name: c.name ?? "", zip: c.zip ?? "" };
  writeFileSync(store, JSON.stringify([...saved().filter((s) => s.label !== card.label), card]));
  console.log(JSON.stringify({ saved: listed(card) }));
} else if (cmd === "rm") {
  const card = saved().find((c) => c.id === arg);
  if (!card) {
    console.error(`no saved card has id ${arg}`);
    process.exit(1);
  }
  writeFileSync(store, JSON.stringify(saved().filter((c) => c.id !== arg)));
  console.log(JSON.stringify({ removed: listed(card) }));
} else if (cmd === "serve") {
  let approved = false;
  for await (const line of createInterface({ input: process.stdin })) {
    const { read } = JSON.parse(line);
    const card = saved().find((c) => c.id === read);
    if (!card) {
      console.log(JSON.stringify({ error: `no saved card has id ${read}` }));
      continue;
    }
    if (!approved) appendFileSync(join(dir, "approvals"), "approved\n");
    approved = true;
    const [month, year] = card.exp.split("/").map(Number);
    console.log(JSON.stringify({ card: { number: card.number, month, year: 2000 + year, csc: card.csc, name: card.name, zip: card.zip } }));
  }
} else {
  console.error("usage: fake-cards list | save | rm ID | serve");
  process.exit(2);
}
