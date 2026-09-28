import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { guide } from "./guides.ts";
import { runAs } from "./owner.ts";
import { callTool } from "./tools.ts";

// Site notes keep what agents learn about a site past the session that
// learned it (notes.ts). Each test gets its own notes directory.
const before = process.env.SAFARI_HARNESS_NOTES;
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "site-notes-"));
  process.env.SAFARI_HARNESS_NOTES = dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => {
  if (before === undefined) delete process.env.SAFARI_HARNESS_NOTES;
  else process.env.SAFARI_HARNESS_NOTES = before;
});

const learn = (args: Record<string, unknown>) => runAs(process.pid, () => callTool("learn", args)) as Promise<string>;
const listed = async (site: string) => (await learn({ site })).split("\n").filter((l) => /^\d+\. /.test(l));

test("a fact learned twice, however it is spaced or cased, is kept once", async () => {
  await learn({ site: "https://www.cvs.com/pharmacy", fact: "The insurance card upload is under Pharmacy > Insurance, not Account." });
  expect(await learn({ site: "cvs.com", fact: "the insurance card upload is under  Pharmacy > Insurance, not account." })).toBe("already noted for cvs.com, as note 1");
  expect(await listed("cvs.com")).toEqual([expect.stringMatching(/^1\. The insurance card upload is under Pharmacy > Insurance, not Account\. \(\d{4}-\d{2}-\d{2}, bun\)$/)]);
});

test("forget removes the note it names, and the later ones move up", async () => {
  for (const fact of ["price history loads 3 s late", "wait for the text Price history", "the chart is an image"]) await learn({ site: "camelcamelcamel.com", fact });
  await learn({ site: "camelcamelcamel.com", forget: 2 });
  expect((await listed("camelcamelcamel.com")).map((l) => l.replace(/ \(.*\)$/, ""))).toEqual(["1. price history loads 3 s late", "2. the chart is an image"]);
});

test("a site keeps 50 notes: the 51st pushes out the oldest", async () => {
  for (let i = 1; i <= 51; i++) await learn({ site: "example.com", fact: `fact number ${i} about the site` });
  const notes = await listed("example.com");
  expect(notes).toHaveLength(50);
  expect(notes[0]).toStartWith("1. fact number 2 about the site");
  expect(notes[49]).toStartWith("50. fact number 51 about the site");
});

// Made-up values in the shapes the check refuses.
test.each([
  ["password", "slack login password: Hunter2!x"],
  ["verification code", "the sign-in code is 482913"],
  ["card number", "use card 4111 1111 1111 1111 at checkout"],
  ["token", "api key = abcd1234efgh5678"],
  ["token", "session is 8f3aK29xLq7Bz04mNc5Rt1Wy"],
])("a fact that looks like a %s is refused and not kept: %s", async (kind, fact) => {
  await expect(learn({ site: "slack.com", fact })).rejects.toThrow(`this looks like a ${kind}`);
  expect(await learn({ site: "slack.com" })).toBe("no notes for slack.com");
});

// The facts the audits named are what the notes are for; a check that
// refused them would make the tool useless.
test.each([
  "The insurance card flow asks for a verification code by text; wait for it with imessage_wait_code",
  "The price-history button draws about 3 s after the page loads; wait for the text Price history",
  "The aktan@work identity owns the Acme workspace; the gmail one owns Personal (zip code 94103 on file)",
  "The password is saved in Apple Passwords under the work account",
  "Call document.getElementsByClassName('priceHistory2024') only after the chart loads",
])("an ordinary fact is kept: %s", async (fact) => {
  expect(await learn({ site: "cvs.com", fact })).toBe("saved for cvs.com as note 1");
});

// A stand-in Safari: open hands out tabs 1, 2, 3... at the address asked
// for, and a snapshot reads that address.
const urls = new Map<number, string>();
let nextTab = 0;
bridge.attach({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    let value: unknown = { ok: true };
    if (op === "windows.open") value = { windowId: 1, tabId: 900 };
    else if (op === "tabs.list" || op === "probe") value = [];
    else if (op === "tabs.open") {
      urls.set(++nextTab, String(args[0]));
      value = { id: nextTab, url: args[0], windowId: args[2] };
    } else if (op === "relay" && args[1] === "snapshot") value = { url: urls.get(Number(args[0])), title: "Page", nodes: 1, truncated: false, snapshot: '[1] button "Go"' };
    bridge.handleMessage(JSON.stringify({ id, value }));
  },
  close() {},
});

const agents: Bun.Subprocess[] = [];
afterAll(() => agents.forEach((a) => a.kill()));
function agent() {
  const proc = Bun.spawn(["sleep", "60"]);
  agents.push(proc);
  return (tool: string, args: Record<string, unknown>) => runAs(proc.pid, () => callTool(tool, args)) as Promise<{ id: number; notes?: string }>;
}

test("an agent's first open of a site carries its notes, its later calls there do not, and another agent gets them too", async () => {
  await learn({ site: "cvs.com", fact: "Insurance card: Pharmacy > Insurance > Add card" });
  const [first, second] = [agent(), agent()];
  const tab = await first("open", { url: "https://www.cvs.com/pharmacy" });
  expect(tab.notes).toBe("site notes for cvs.com: (1) Insurance card: Pharmacy > Insurance > Add card");
  expect(await first("snapshot", { tab: tab.id })).not.toHaveProperty("notes");
  expect(await first("goto", { tab: tab.id, url: "https://cvs.com/account" })).not.toHaveProperty("notes");
  expect((await second("snapshot", { tab: tab.id })).notes).toBe("site notes for cvs.com: (1) Insurance card: Pharmacy > Insurance > Add card");
});

test("a site with more than 3 notes gives their count and where to read them", async () => {
  for (let i = 1; i <= 4; i++) await learn({ site: "gusto.com", fact: `payroll fact ${i}` });
  const tab = await agent()("open", { url: "https://gusto.com/payroll" });
  expect(tab.notes).toBe("site notes for gusto.com: 4; read them with guide gusto.com");
});

test("a site's guide by address shows its bundled guide and then the notes learned there", async () => {
  const bundled = await guide("cvs");
  await learn({ site: "cvs.com", fact: "Insurance card: Pharmacy > Insurance > Add card" });
  const text = await guide("https://www.cvs.com/pharmacy");
  expect(text?.replace(/\(\d{4}-\d{2}-\d{2}, bun\)$/, "(today, bun)")).toBe(`${bundled?.trimEnd()}\n\n## Learned notes for cvs.com\n\n1. Insurance card: Pharmacy > Insurance > Add card (today, bun)`);
});

test("a site's guide by name shows the notes learned on each of its hosts and their subdomains", async () => {
  await learn({ site: "acme.slack.com", fact: "The aktan@work identity owns the Acme workspace" });
  await learn({ site: "github.com", fact: "not a Slack fact" });
  const text = await guide("slack");
  expect(text).toContain("## Learned notes for acme.slack.com\n\n1. The aktan@work identity owns the Acme workspace");
  expect(text).not.toContain("not a Slack fact");
});
