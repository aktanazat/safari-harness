import { memoryUsage } from "bun:jsc";
import { expect, test } from "bun:test";
import { lineDiff } from "./tools.ts";

const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `[${i + 1}] link "${prefix} ${i}" /${prefix}/${i}`);
// Enough shared lines that a table of every pair would pass 2 MiB.
const page = lines("story", 1100);

// A table of every pair of lines took 128 MB here (audit, 11-09).
test("two 8,000-line snapshots with one line changed compare in a few megabytes", () => {
  const before = lines("story", 8000);
  const after = ['[1] link "changed" /changed', ...before.slice(1)];
  Bun.gc(true);
  const peak = memoryUsage().peak;
  expect(lineDiff(before, after)).toBe(`- ${before[0]}\n+ ${after[0]}`);
  expect(memoryUsage().peak - peak).toBeLessThan(64 * 1024 * 1024);
});

test("a long page pairs lines as the table did: a repeated line at its first place", () => {
  expect(lineDiff([...page, "text: ·"], [...page, '[1] link "One" /1', "text: ·", '[2] link "Two" /2', "text: ·"]))
    .toBe('+ [1] link "One" /1\n+ [2] link "Two" /2\n+ text: ·');
});

test("a long page pairs lines as the table did: a removed line before an added one", () => {
  expect(lineDiff([...page, "X", "Y"], [...page, "Y", "X"])).toBe("- X\n+ X");
});

test("a page with thousands of lines changed still shows only the changed ones", () => {
  const shared = lines("shared", 10);
  const before = [...lines("a", 600), ...shared, ...lines("b", 600)];
  const after = [...lines("c", 600), ...shared, ...lines("d", 600)];
  const expected = [...lines("a", 600).map((l) => `- ${l}`), ...lines("c", 600).map((l) => `+ ${l}`), ...lines("b", 600).map((l) => `- ${l}`), ...lines("d", 600).map((l) => `+ ${l}`)];
  expect(lineDiff(before, after)).toBe(expected.join("\n"));
});
