import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findFiles, type Hit } from "./finder.ts";

const base = realpathSync(mkdtempSync("/private/var/tmp/safari-finder-"));
afterAll(() => rmSync(base, { recursive: true }));

// A file written with its modification time `age` minutes back.
function file(path: string, age = 0): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const when = new Date(Date.UTC(2026, 8, 1) - age * 60_000);
  utimesSync(path, when, when);
  return path;
}

// Spotlight as a stand-in: it answers these paths whatever the query, and
// records the query it was asked.
function spotlight(paths: string[], asked: string[] = []) {
  return async (_roots: string[], query: string): Promise<Hit[]> => {
    asked.push(query);
    return paths.map((path) => ({ path, kind: "PDF document" }));
  };
}

test("find never returns a path outside its folders, through .., a symlink, or a look-alike folder name", async () => {
  const docs = join(base, "one", "Documents");
  const desk = join(base, "one", "Desktop");
  const card = file(join(docs, "card.pdf"));
  const outside = file(join(base, "one", "private", "card.pdf"));
  const lookalike = file(join(base, "one", "Documents-old", "card.pdf"));
  mkdirSync(desk, { recursive: true });
  symlinkSync(outside, join(desk, "card-link.pdf"));
  // join would fold the .. away; Spotlight's answer is taken as it comes
  const search = spotlight([outside, lookalike, `${docs}/../private/card.pdf`, join(desk, "card-link.pdf"), card]);
  const { found } = await findFiles("card", { roots: [docs, desk], search });
  expect(found.map((f) => f.path)).toEqual([card]);
});

test("find returns at most eight files, named for more of the words first, then newest, and no folders", async () => {
  const root = join(base, "two");
  const both = [file(join(root, "Insurance Card back.jpg"), 30), file(join(root, "insurance card front.jpg"), 10)];
  const one = [file(join(root, "old card.png"), 500), file(join(root, "card scan.pdf"), 5)];
  const other = Array.from({ length: 8 }, (_, i) => file(join(root, `scan ${i}.pdf`), i * 60));
  mkdirSync(join(root, "insurance card photos"));
  const asked: string[] = [];
  const search = spotlight([join(root, "insurance card photos"), ...other, ...one, ...both], asked);
  const { found } = await findFiles("--insurance card", { roots: [root], search });
  expect(found.map((f) => f.name)).toEqual([
    "insurance card front.jpg", "Insurance Card back.jpg",
    "card scan.pdf", "old card.png",
    "scan 0.pdf", "scan 1.pdf", "scan 2.pdf", "scan 3.pdf",
  ]);
  // a leading dash would reach mdfind as an option
  expect(asked).toEqual(["insurance card"]);
});
