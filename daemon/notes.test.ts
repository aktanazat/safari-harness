import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
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

// The CLI passes --forget 2 as text, as it passes a reader's name.
test("forget given as digits in text removes that note, not a reader", async () => {
  for (const fact of ["price history loads 3 s late", "the chart is an image"]) await learn({ site: "camelcamelcamel.com", fact });
  expect(await learn({ site: "camelcamelcamel.com", forget: "1" })).toBe('forgot note 1 for camelcamelcamel.com: "price history loads 3 s late"; 1 left');
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
  expect(await learn({ site: "slack.com" })).toBe("no notes or readers for slack.com");
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
// for, titled as a page not found at an address ending /missing, a
// snapshot and info read that address, and eval runs its code the way
// content.js does, noting which world ran it.
const urls = new Map<number, string>();
let nextTab = 0;
let world = "";
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    let value: unknown = { ok: true };
    if (op === "windows.open") value = { windowId: 1, tabId: 900 };
    else if (op === "tabs.list" || op === "probe") value = [];
    else if (op === "tabs.open") {
      urls.set(++nextTab, String(args[0]));
      value = { id: nextTab, url: args[0], title: String(args[0]).endsWith("/missing") ? "Page not found | Robinhood" : "Page", windowId: args[2] };
    } else if (op === "relay" && args[1] === "snapshot") value = { url: urls.get(Number(args[0])), title: "Page", nodes: 1, truncated: false, snapshot: '[1] button "Go"' };
    else if (op === "relay" && args[1] === "tabInfo") value = { url: urls.get(Number(args[0])), title: "Page" };
    else if ((op === "relay" && args[1] === "eval") || op === "evalPage") {
      world = op === "evalPage" ? "page" : "content";
      const code = op === "evalPage" ? String(args[1]) : (args[2] as string[])[0];
      value = Promise.resolve().then(() => new Function(`return (${code})`)()).then((result) => ({ ok: true, result }));
    }
    void Promise.resolve(value).then((v) => bridge.handleMessage(JSON.stringify({ id, value: v })));
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

// Every site noted by 09-29 had one note of 124 to 289 characters, so a
// limit of 120 each sent every agent to guide for one sentence.
test("a site's notes come inline while they run to 900 characters in all", async () => {
  const facts = ["a", "b", "c"].map((c) => `${c} `.repeat(150).trim().padEnd(300, c));
  for (const fact of facts) await learn({ site: "gusto.com", fact });
  const tab = await agent()("open", { url: "https://gusto.com/payroll" });
  expect(tab.notes).toBe(`site notes for gusto.com: ${facts.map((f, i) => `(${i + 1}) ${f}`).join(" ")}`);
});

test("past 900 characters, a site's notes come as their count and where to read them", async () => {
  for (const c of ["a", "b", "c"]) await learn({ site: "gusto.com", fact: `${c} `.repeat(150).trim().padEnd(300, c) });
  await learn({ site: "gusto.com", fact: "d" });
  const tab = await agent()("open", { url: "https://gusto.com/payroll" });
  expect(tab.notes).toBe('site notes for gusto.com: 4; read them with learn {site: "gusto.com"}');
});

// GEICO's quote ran on ecams.geico.com and edgecustomer.geico.com, and
// its note on geico.com reached neither.
test("a site's notes come with the first page on any of its subdomains, once", async () => {
  await learn({ site: "geico.com", fact: "The quote asks for the garaging address twice" });
  const call = agent();
  const tab = await call("open", { url: "https://ecams.geico.com/quote" });
  expect(tab.notes).toBe("site notes for geico.com: (1) The quote asks for the garaging address twice");
  expect(await call("open", { url: "https://edgecustomer.geico.com/start" })).not.toHaveProperty("notes");
});

// On 09-29 an agent was told Robinhood's notes on its first open, then met
// three pages not found there, and none said them again.
test("a page not found on a site brings its notes again", async () => {
  await learn({ site: "robinhood.com", fact: "The Gold Card is managed in the app only" });
  const call = agent();
  expect((await call("open", { url: "https://robinhood.com/account" })).notes).toBe("site notes for robinhood.com: (1) The Gold Card is managed in the app only");
  expect(await call("open", { url: "https://robinhood.com/account/gold" })).not.toHaveProperty("notes");
  expect((await call("open", { url: "https://robinhood.com/missing" })).notes).toBe("site notes for robinhood.com: (1) The Gold Card is managed in the app only");
});

// Read through head -c 400 on 09-29, an open lost its notes behind the
// long details of its window.
test("an open's notes come before the details of its window", async () => {
  await learn({ site: "robinhood.com", fact: "The Gold Card is managed in the app only" });
  const keys = Object.keys(await agent()("open", { url: "https://robinhood.com/account" }));
  expect(keys.indexOf("notes")).toBeGreaterThan(-1);
  expect(keys.indexOf("notes")).toBeLessThan(keys.indexOf("space"));
});

test("a reader saved for a site runs by name on its subdomains' pages, in the world it was saved for", async () => {
  await learn({ site: "carfax.com", reader: "listings", expression: "const rows = [{ vin: 'A1' }, { vin: 'B2' }];\nrows.map((r) => r.vin)", page: true });
  const call = agent();
  const tab = await call("open", { url: "https://helix.carfax.com/results" });
  expect(tab.notes).toBe('readers saved for carfax.com: listings; run one with eval {tab, reader: "<name>"}');
  expect(await call("eval", { tab: tab.id, reader: "listings" })).toEqual({ ok: true, result: ["A1", "B2"] });
  expect(world).toBe("page");
});

test("a reader that holds a token is refused and not kept", async () => {
  await expect(learn({ site: "carfax.com", reader: "api", expression: "fetch('/api', { headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456' } })" })).rejects.toThrow("not saved: this looks like a token");
  expect(await learn({ site: "carfax.com" })).toBe("no notes or readers for carfax.com");
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
