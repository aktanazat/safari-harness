import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guide, noGuide } from "./guides.ts";
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

test("a bare name finds the bundled guide whose host carries it", async () => {
  expect(await guide("kp")).toBe(await guide("kaiser"));
});

test("a name nothing answers names the noted sites nearest it", async () => {
  await learn("geico.com", "The quote asks for the garaging address twice");
  await learn("github.com", "not near");
  expect(await guide("gieco")).toBeNull();
  expect(noGuide("gieco")).toBe("no guide or notes for gieco; nearest with notes: geico.com; every site with a guide or notes: safari guide sites");
  expect(noGuide("$s")).toStartWith("no guide for $s: the shell passed the variable as written");
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
