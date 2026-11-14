// Moves the payment cards Safari Harness Cards kept in this Mac's keychain
// into the card vault (daemon/card-vault.ts), from which a fill asks the
// user nothing. Reading them takes his Touch ID once, at the first card
// (the prompt names the site as engram), and never again. Each card is kept
// under its label, so a second run replaces rather than doubles. The
// keychain's copies stay, unread: removing them would ask Touch ID once a
// card. Prints labels and last 4s, never a card's digits.
//
//   bun scripts/import-cards.ts [the helper's executable]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { type Card, type Checked, cardOf, type Listed, memSecretCards } from "../daemon/card-vault.ts";

const helper = process.argv[2] ?? "/Applications/Safari Harness.app/Contents/Helpers/Safari Harness Cards.app/Contents/MacOS/Safari Harness Cards";
if (!existsSync(helper)) {
  console.error(`no card helper at ${helper}; give the path to its executable`);
  process.exit(2);
}
const listing = Bun.spawnSync([helper, "list"], { stderr: "pipe" });
if (!listing.success) {
  console.error(`the card helper did not list the cards: ${listing.stderr.toString().trim()}`);
  process.exit(1);
}
const saved: Listed[] = JSON.parse(listing.stdout.toString()).cards;
const named = (c: Listed) => `${c.label} (ending ${c.last4})`;
if (!saved.length) {
  console.log("the keychain holds no card to move");
  process.exit(0);
}

// One serve process answers every read, so the Touch ID its first read asks
// covers the rest. A read that fails ends the reading, so a declined Touch
// ID is not asked again for each card after it. The vault keeps one card a
// label, in any case; a second card the keychain holds under a label is
// named rather than dropped unseen.
const serve = spawn(helper, ["serve"], { stdio: ["pipe", "pipe", "inherit"] });
const answers = createInterface({ input: serve.stdout })[Symbol.asyncIterator]();
const moving = new Map<string, Checked>();
for (const c of saved) {
  serve.stdin.write(`${JSON.stringify({ read: c.id, site: "engram" })}\n`);
  const next = await answers.next();
  const answer: { card?: Card; error?: string } = next.done ? { error: "the card helper stopped" } : JSON.parse(next.value);
  if (!answer.card) {
    console.log(`stopped at ${named(c)}: ${answer.error}; it and the cards after it were not moved`);
    break;
  }
  const { number, month, year, csc, name, zip } = answer.card;
  try {
    const card = cardOf({ number, exp: `${month}/${year}`, csc, name, zip, label: c.label });
    if (moving.has(card.label.toLowerCase())) throw new Error("another card here has the same label");
    moving.set(card.label.toLowerCase(), card);
  } catch (e) {
    console.log(`not moved: ${named(c)}: ${e instanceof Error ? e.message : e}`);
  }
}
serve.stdin.end();
for (const c of await memSecretCards().keep([...moving.values()])) console.log(`moved: ${named(c)}`);
if (moving.size < saved.length) process.exit(1);
