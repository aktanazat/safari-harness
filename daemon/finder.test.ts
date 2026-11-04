import { expect, test } from "bun:test";
import { findFiles, type Hit } from "./finder.ts";

// No path here exists on this disk: find answers from Spotlight's record
// alone, as it must for a file in iCloud Drive (opening one waits on a
// macOS prompt).
const DOCS = "/Users/someone/Documents";

// Spotlight as a stand-in: it answers these hits whatever the query, and
// records the query it was asked.
function spotlight(hits: Hit[], asked: string[] = []) {
  return async (_roots: string[], query: string): Promise<Hit[]> => {
    asked.push(query);
    return hits;
  };
}

// A file Spotlight dates `age` minutes before Sep 1, 2026; size null is
// how it records a folder.
function hit(path: string, age = 0, size: number | null = 1): Hit {
  return { path, kind: "PDF document", size, modified: Date.UTC(2026, 8, 1) - age * 60_000 };
}

test("find never returns a path outside its folders, through .., or a look-alike folder name", async () => {
  const card = `${DOCS}/card.pdf`;
  const search = spotlight([hit("/Users/someone/private/card.pdf"), hit("/Users/someone/Documents-old/card.pdf"), hit(`${DOCS}/../private/card.pdf`), hit(card)]);
  const { found } = await findFiles("card", { roots: [DOCS, "/Users/someone/Desktop"], search });
  expect(found.map((f) => f.path)).toEqual([card]);
});

test("find returns at most eight files, named for more of the words first, then newest, and no folders", async () => {
  const both = [hit(`${DOCS}/Insurance Card back.jpg`, 30), hit(`${DOCS}/insurance card front.jpg`, 10)];
  const one = [hit(`${DOCS}/old card.png`, 500), hit(`${DOCS}/card scan.pdf`, 5)];
  const other = Array.from({ length: 8 }, (_, i) => hit(`${DOCS}/scan ${i}.pdf`, i * 60));
  const asked: string[] = [];
  const search = spotlight([hit(`${DOCS}/insurance card photos`, 0, null), ...other, ...one, ...both], asked);
  const { found } = await findFiles("--insurance card", { roots: [DOCS], search });
  expect(found.map((f) => f.name)).toEqual([
    "insurance card front.jpg", "Insurance Card back.jpg",
    "card scan.pdf", "old card.png",
    "scan 0.pdf", "scan 1.pdf", "scan 2.pdf", "scan 3.pdf",
  ]);
  // a leading dash would reach mdfind as an option
  expect(asked).toEqual(["insurance card"]);
});

test("find reports the size Spotlight keeps for a file this disk does not hold", async () => {
  const { found } = await findFiles("lease", { roots: [DOCS], search: spotlight([hit(`${DOCS}/lease.pdf`, 0, 48_213)]) });
  expect(found.map((f) => [f.path, f.size])).toEqual([[`${DOCS}/lease.pdf`, 48_213]]);
});
