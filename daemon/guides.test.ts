import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guide, noGuide } from "./guides.ts";
import { listTools } from "./mcp-tools.ts";
import { runAs } from "./owner.ts";
import { callTool } from "./tools.ts";

// safari guide finds a site's guide and learned notes by its name, host,
// or address (guides.ts). Each test gets its own notes directory.
const before = process.env.SAFARI_HARNESS_NOTES;
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "site-guides-"));
  process.env.SAFARI_HARNESS_NOTES = dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => {
  if (before === undefined) delete process.env.SAFARI_HARNESS_NOTES;
  else process.env.SAFARI_HARNESS_NOTES = before;
});

const learn = (site: string, fact: string) => runAs(process.pid, () => callTool("learn", { site, fact }));
// Bundled guides come and go (docs/sites), so these read only the notes.
const learned = (text: string | null) => (text ?? "").split("\n").filter((l) => l.startsWith("## Learned notes for "));

// 16 of 95 lookups from 09-28 to 09-30 gave a bare name (geico, discover)
// and got "no guide for geico" though notes were saved for geico.com.
test("a bare name finds the notes learned on each site with that name among its labels", async () => {
  await learn("geico.com", "The quote asks for the garaging address twice");
  await learn("card.discover.com", "Statements are under Manage > Statements");
  await learn("discover.com", "Sign-in asks for a texted code");
  await learn("discovery.com", "not a Discover fact");
  expect(learned(await guide("geico"))).toEqual(["## Learned notes for geico.com"]);
  expect(learned(await guide("discover"))).toEqual(["## Learned notes for card.discover.com", "## Learned notes for discover.com"]);
});


// apply.knight-hennessy.stanford.edu and smapply were each told their
// nearest noted site was apply.coveredca.com, on the word apply (09-30).
test("the nearest noted site shares a name with the one asked for, not a word like apply", async () => {
  await learn("apply.coveredca.com", "The plan list loads after the income page");
  await learn("apple.com", "not a Stanford fact");
  expect(noGuide("apply.knight-hennessy.stanford.edu")).not.toMatch(/nearest/);
  expect(noGuide("smapply")).not.toMatch(/nearest/);
  await learn("applygrad.stanford.edu", "Continue saves the section");
  expect(noGuide("apply.knight-hennessy.stanford.edu")).toMatch(/nearest with notes: applygrad\.stanford\.edu;/);
});

// safari guide uscis.gov found nothing though notes were saved for
// my.uscis.gov and egov.uscis.gov (09-30).
test("a host finds the notes learned on its subdomains", async () => {
  await learn("my.uscis.gov", "The case status page needs a fresh sign-in");
  await learn("egov.uscis.gov", "Case status takes the receipt number only");
  await learn("notuscis.gov", "not a USCIS fact");
  expect(learned(await guide("uscis.gov"))).toEqual(["## Learned notes for egov.uscis.gov", "## Learned notes for my.uscis.gov"]);
});

// On 10-16 agents printed all 113 KB of the reference to find one tool, or
// paged it with sed and grep: safari guide <tool> prints that tool's section.
const headings = (text: string | null) => (text ?? "").split("\n").filter((l) => /^#{1,2} /.test(l));

test("safari guide <tool> prints that tool's reference section and no other, for every tool the MCP server lists", async () => {
  // repl's name prints the script API (docs/REPL.md); its section is reference repl
  const names = (listTools() as { name: string }[]).map((t) => t.name).filter((n) => n !== "repl");
  const printed = await Promise.all(names.map(async (n) => headings(await guide(n))));
  expect(printed).toEqual(names.map((n) => [`## ${n}`]));
  expect(headings(await guide("reference repl"))).toEqual(["## repl"]);
});

// A bare name also finds every noted site with that label (geico above),
// so a site with notes must not take a tool's name: data.gov and data.
test("a tool's name prints its section even when a noted site carries that name", async () => {
  await learn("data.gov", "Downloads are under each dataset's Access button");
  expect(headings(await guide("data"))).toEqual(["## data"]);
  expect(learned(await guide("data.gov"))).toEqual(["## Learned notes for data.gov"]);
});

test("a tool named with a hyphen, as the CLI spells it, finds its section", async () => {
  expect(headings(await guide("real-input"))).toEqual(["## real_input"]);
});

test("safari guide reference lists the sections instead of printing the reference", async () => {
  const index = await guide("reference");
  expect(headings(index)).toEqual([]);
  expect(index).toContain("real_input");
  expect(headings(await guide("reference two lanes"))).toEqual(["## Two lanes: this harness or Apple's safaridriver"]);
  expect(await guide("reference no such section")).toBeNull();
});

