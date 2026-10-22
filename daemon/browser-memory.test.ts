import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserMemory, type BrowserMemoryOptions, type MemoryPage } from "./browser-memory.ts";
import { keepSecret, tabSecrets } from "./redact.ts";

const stores: BrowserMemory[] = [];
const directories: string[] = [];
const NOW = new Date(2026, 9, 22, 12).getTime();
const DAY = 86_400_000;
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "browser-memory-"));
  directories.push(path);
  return path;
}
function store(options: BrowserMemoryOptions = {}): BrowserMemory {
  const memory = new BrowserMemory({ directory: folder(), now: () => NOW, ...options });
  stores.push(memory);
  return memory;
}
function required(page: MemoryPage | null): MemoryPage {
  if (!page) throw new Error("expected an eligible captured page");
  return page;
}
function bytes(directory: string): Buffer {
  return Buffer.concat(readdirSync(directory).map((file) => readFileSync(join(directory, file))));
}
afterEach(() => {
  for (const memory of stores.splice(0)) memory.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  tabSecrets.delete(987654);
});

const input = { url: "https://example.com/research", title: "Research", body: "Lithium battery recycling costs fell in the reported study." };

test("new memory refuses collection and provider use until an exact host is explicitly enabled", async () => {
  let providerRequests = 0;
  const memory = store({ summarize: async () => { providerRequests++; return "unexpected summary"; } });
  expect(memory.status().config).toEqual({ enabled: false, sites: [], excludedSites: [], retentionDays: 30, summarize: false });
  expect(await memory.capture(input)).toBeNull();
  memory.configure({ enabled: true });
  expect(await memory.capture(input)).toBeNull();
  memory.configure({ sites: ["example.com"] });
  const page = required(await memory.capture(input));
  expect(memory.eligible("https://sub.example.com/research")).toBe(false);
  expect(memory.eligible("https://example.com.evil.test/research")).toBe(false);
  expect({ summary: page.summary, source: page.summarySource, observation: page.observation, state: page.state }).toEqual({ summary: "", source: "none", observation: "viewed", state: "ready" });
  expect(providerRequests).toBe(0);
});

test("configuration and captured text survive reopening with private file permissions", async () => {
  const directory = folder();
  const first = store({ directory });
  first.configure({ enabled: true, sites: ["EXAMPLE.COM."], excludedSites: ["private.example.com"], retentionDays: 90 });
  const page = required(await first.capture(input));
  first.close();
  const second = store({ directory });
  expect(second.status().config).toEqual({ enabled: true, sites: ["example.com"], excludedSites: ["private.example.com"], retentionDays: 90, summarize: false });
  expect(second.detail(page.id)?.body).toBe(input.body);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(directory, "observations.sqlite")).mode & 0o777).toBe(0o600);
});

test("body search returns related observations rather than the newest unrelated page", async () => {
  const memory = store();
  memory.configure({ enabled: true, sites: ["example.com"] });
  const relevant = required(await memory.capture({ ...input, title: "Annual report", visitedAt: NOW - DAY }));
  await memory.capture({ ...input, url: "https://example.com/newer", title: "Travel", body: "Airline seats are available for the summer holiday.", visitedAt: NOW });
  expect(memory.list({ query: "what did i read about lithium recycling" }).pages.map((page) => page.id)).toEqual([relevant.id]);
  expect(memory.list({ query: "mortgage refinancing" })).toEqual({ pages: [], total: 0 });
  expect(memory.list({ query: "ai" })).toEqual({ pages: [], total: 0 });
  expect(memory.list({ query: "lithium" }).pages[0].excerpt).toContain("Lithium battery recycling");
});

test.each(["\" OR 1=1 --", "lithium OR refinancing", "*", "lithium NEAR(recycling)", "' UNION SELECT body FROM pages --"])("search treats hostile syntax as literal words: %s", async (query) => {
  const memory = store();
  memory.configure({ enabled: true, sites: ["example.com"] });
  await memory.capture(input);
  expect(memory.list({ query })).toEqual({ pages: [], total: 0 });
  expect(memory.status().total).toBe(1);
});

test("yesterday restricts observations to the prior local calendar day", async () => {
  const memory = store();
  memory.configure({ enabled: true, sites: ["example.com"] });
  const yesterday = required(await memory.capture({ ...input, visitedAt: NOW - DAY }));
  await memory.capture({ ...input, url: "https://example.com/today", visitedAt: NOW });
  expect(memory.list({ query: "lithium yesterday" }).pages.map((page) => page.id)).toEqual([yesterday.id]);
});

test("pagination retains all-match totals and stable ordering for equal visit times", async () => {
  const memory = store();
  memory.configure({ enabled: true, sites: ["example.com"] });
  const first = required(await memory.capture(input));
  const second = required(await memory.capture({ ...input, url: "https://example.com/second" }));
  const ordered = [first.id, second.id].sort();
  expect(memory.list({ query: "lithium", limit: 1, offset: 0 })).toMatchObject({ total: 2, pages: [{ id: ordered[0] }] });
  expect(memory.list({ query: "lithium", limit: 1, offset: 1 })).toMatchObject({ total: 2, pages: [{ id: ordered[1] }] });
});

test("unchanged normalized content refreshes visits without another provider request", async () => {
  let now = NOW;
  let providerRequests = 0;
  const result = Promise.withResolvers<string>();
  const memory = store({ now: () => now, summarize: () => { providerRequests++; return result.promise; } });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const page = required(await memory.capture({ ...input, url: "https://EXAMPLE.COM/research?utm_source=mail#section" }));
  result.resolve("The study reports lower lithium battery recycling costs.");
  await result.promise;
  now += 500;
  const again = required(await memory.capture(input));
  expect(again).toMatchObject({ id: page.id, url: input.url, visitedAt: now, state: "ready", summarySource: "provider", summary: "The study reports lower lithium battery recycling costs." });
  expect(providerRequests).toBe(1);
  expect(memory.status().total).toBe(1);
});

test("a user correction cancels a pending summary and records provenance without confirming an action", async () => {
  const result = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const memory = store({ summarize: (_page, abort) => { signal = abort; return result.promise; } });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const page = required(await memory.capture(input));
  expect(memory.edit(page.id, { summary: "Costs apply only to the reported study.", note: "Check the study assumptions." })).toMatchObject({
    summary: "Costs apply only to the reported study.", summarySource: "user", summaryEditedAt: NOW, note: "Check the study assumptions.", noteEditedAt: NOW, observation: "viewed", state: "ready",
  });
  expect(signal?.aborted).toBe(true);
  result.resolve("late unwanted summary");
  await result.promise;
  expect(memory.detail(page.id)?.summary).toBe("Costs apply only to the reported study.");
  expect(memory.list({ query: "assumptions" }).pages.map((found) => found.id)).toEqual([page.id]);
});

test("changed content replaces its old summary but keeps a separately attributed user note", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  let requests = 0;
  const memory = store({ summarize: () => (++requests === 1 ? first.promise : second.promise) });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const page = required(await memory.capture(input));
  memory.edit(page.id, { note: "Check assumptions." });
  await memory.capture({ ...input, body: "The updated study describes sodium batteries." });
  first.resolve("obsolete lithium summary");
  await first.promise;
  second.resolve("The updated study describes sodium batteries.");
  await second.promise;
  expect(memory.detail(page.id)).toMatchObject({ summary: "The updated study describes sodium batteries.", summarySource: "provider", note: "Check assumptions.", noteEditedAt: NOW });
  expect(memory.list({ query: "lithium" }).total).toBe(0);
});

test.each(["status", "list", "detail"] as const)("retention securely removes expired text when read through %s", async (surface) => {
  const directory = folder();
  let now = NOW;
  const memory = store({ directory, now: () => now });
  memory.configure({ enabled: true, sites: ["example.com"], retentionDays: 7 });
  const marker = "expired-raw-body-opaque-marker-779944";
  const page = required(await memory.capture({ ...input, body: marker }));
  memory.edit(page.id, { summary: "expired-summary-opaque-marker-229955", note: "expired-note-opaque-marker-447766" });
  now += 7 * DAY;
  const retained = surface === "status" ? memory.status().total : surface === "list" ? memory.list().total : Number(memory.detail(page.id) !== null);
  expect(retained).toBe(0);
  const stored = bytes(directory).toString("utf8");
  expect(stored).not.toContain(marker);
  expect(stored).not.toContain("expired-summary-opaque-marker-229955");
  expect(stored).not.toContain("expired-note-opaque-marker-447766");
});

test("an excluded exact host wins over its allow entry while other hosts remain eligible", async () => {
  const memory = store();
  memory.configure({ enabled: true, sites: ["example.com", "other.example.com"], excludedSites: ["example.com"] });
  expect(memory.eligible(input.url)).toBe(false);
  expect(await memory.capture(input)).toBeNull();
  expect(memory.eligible("https://other.example.com/path")).toBe(true);
  expect(memory.eligible("http://localhost:37334/memory")).toBe(false);
  expect(memory.status().total).toBe(0);
});

test.each(["remove", "exclude"] as const)("host policy %s erases stored text and preserves other exact hosts", async (change) => {
  const directory = folder();
  const body = "removedbodymarker223344";
  const summary = "removedsummarymarker225599";
  const note = "removednotemarker447766";
  const memory = store({ directory, summarize: async (page) => page.url === input.url ? summary : "Control summary remains available." });
  memory.configure({ enabled: true, sites: ["example.com", "sub.example.com", "other.example.com"], summarize: true });
  const page = required(await memory.capture({ ...input, body }));
  expect(memory.detail(page.id)?.summary).toBe(summary);
  memory.edit(page.id, { note });
  const sub = required(await memory.capture({ ...input, url: "https://sub.example.com/research", body: "Subdomain body remains available." }));
  memory.edit(sub.id, { note: "Subdomain note remains available." });
  const other = required(await memory.capture({ ...input, url: "https://other.example.com/research", body: "Other host body remains available." }));
  expect(memory.list({ query: body }).pages.map((found) => found.id)).toEqual([page.id]);
  const settings = change === "remove" ? { sites: ["sub.example.com", "other.example.com"] } : { excludedSites: ["example.com"] };
  expect(memory.configure(settings).total).toBe(2);
  expect(memory.detail(page.id)).toBeNull();
  expect(memory.list({ query: body })).toEqual({ pages: [], total: 0 });
  expect(memory.detail(sub.id)).toMatchObject({ body: "Subdomain body remains available.", summary: "Control summary remains available.", note: "Subdomain note remains available." });
  expect(memory.detail(other.id)).toMatchObject({ body: "Other host body remains available.", summary: "Control summary remains available." });
  const stored = bytes(directory).toString("utf8");
  expect(stored).not.toContain(body);
  expect(stored).not.toContain(summary);
  expect(stored).not.toContain(note);
  memory.close();
  const reopened = store({ directory });
  expect(reopened.status().total).toBe(2);
  expect(reopened.detail(page.id)).toBeNull();
  expect(reopened.detail(sub.id)?.body).toBe("Subdomain body remains available.");
  expect(reopened.detail(other.id)?.body).toBe("Other host body remains available.");
});

test.each([{ summarize: false }, { enabled: false }])("pausing collection or summaries preserves completed text and notes: %j", async (settings) => {
  const memory = store({ summarize: async () => "Completed summary remains available." });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const page = required(await memory.capture(input));
  expect(memory.detail(page.id)?.summary).toBe("Completed summary remains available.");
  memory.edit(page.id, { note: "Saved note remains available." });
  expect(memory.configure(settings).total).toBe(1);
  expect(memory.detail(page.id)).toMatchObject({ body: input.body, summary: "Completed summary remains available.", summarySource: "provider", note: "Saved note remains available." });
  expect(memory.list({ query: "lithium" }).pages.map((found) => found.id)).toEqual([page.id]);
});

test.each([{ summarize: false }, { enabled: false }])("settings changes abort provider work, preserve captured text and cannot publish a late result: %j", async (settings) => {
  const result = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const memory = store({ summarize: (_page, abort) => { signal = abort; return result.promise; } });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const page = required(await memory.capture(input));
  memory.configure(settings);
  expect(signal?.aborted).toBe(true);
  result.resolve("late result must not be saved");
  await result.promise;
  expect(memory.detail(page.id)).toMatchObject({ body: input.body, summary: "" });
  expect(memory.list({ query: "lithium" }).pages.map((found) => found.id)).toEqual([page.id]);
  expect(memory.status().pending).toBe(0);
});

test.each([{ sites: [] }, { excludedSites: ["example.com"] }])("host policy changes erase pending text and reject late summaries: %j", async (settings) => {
  const directory = folder();
  const result = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  let providerRequests = 0;
  const memory = store({ directory, summarize: (_page, abort) => {
    providerRequests++;
    signal = abort;
    return result.promise;
  } });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const body = "removedpendingbodymarker223344";
  const note = "removedpendingnotemarker667788";
  const summary = "removedlatesummarymarker552211";
  const page = required(await memory.capture({ ...input, body }));
  memory.edit(page.id, { note });
  const queued = required(await memory.capture({ ...input, url: "https://example.com/queued", body: "removedqueuedbodymarker998877" }));
  expect(memory.configure(settings)).toMatchObject({ total: 0, pending: 0 });
  expect(signal?.aborted).toBe(true);
  result.resolve(summary);
  await result.promise;
  expect(memory.detail(page.id)).toBeNull();
  expect(memory.detail(queued.id)).toBeNull();
  expect(memory.list({ query: body })).toEqual({ pages: [], total: 0 });
  expect(providerRequests).toBe(1);
  const stored = bytes(directory).toString("utf8");
  expect(stored).not.toContain(body);
  expect(stored).not.toContain(note);
  expect(stored).not.toContain(summary);
  expect(stored).not.toContain("removedqueuedbodymarker998877");
});

test.each(["id", "site", "all"] as const)("forget by %s cancels work and late completion cannot resurrect deleted text", async (scope) => {
  const directory = folder();
  const result = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const memory = store({ directory, summarize: (captured, abort) => {
    if (captured.url.includes("/control")) return Promise.resolve("control page summary");
    signal = abort;
    return result.promise;
  } });
  memory.configure({ enabled: true, sites: ["example.com", "other.example.com"], summarize: true });
  const marker = "forgotten-raw-body-marker-223344";
  const page = required(await memory.capture({ ...input, body: marker }));
  const control = required(await memory.capture({ ...input, url: "https://other.example.com/control", body: "Control page text remains separate." }));
  const selection = scope === "id" ? { id: page.id } : scope === "site" ? { site: "example.com" } : { all: true };
  expect(memory.forget(selection).total).toBe(scope === "all" ? 0 : 1);
  expect(signal?.aborted).toBe(true);
  result.resolve("forgotten-provider-summary-marker-552211");
  await result.promise;
  expect(memory.detail(page.id)).toBeNull();
  expect(memory.detail(control.id)?.body ?? null).toBe(scope === "all" ? null : "Control page text remains separate.");
  expect(memory.list({ query: "forgotten" })).toEqual({ pages: [], total: 0 });
  const stored = bytes(directory).toString("utf8");
  expect(stored).not.toContain(marker);
  expect(stored).not.toContain("forgotten-provider-summary-marker-552211");
});

test("expiry aborts a pending summary and its late result cannot recreate an expired observation", async () => {
  const result = Promise.withResolvers<string>();
  let now = NOW;
  let signal: AbortSignal | undefined;
  const memory = store({ now: () => now, summarize: (_page, abort) => { signal = abort; return result.promise; } });
  memory.configure({ enabled: true, sites: ["example.com"], retentionDays: 7, summarize: true });
  const page = required(await memory.capture(input));
  now += 7 * DAY;
  expect(memory.status().total).toBe(0);
  expect(signal?.aborted).toBe(true);
  result.resolve("late expired summary");
  await result.promise;
  expect(memory.detail(page.id)).toBeNull();
  expect(memory.list({ query: "lithium" }).total).toBe(0);
});

test("provider failures remain visible without exposing error text or discarding captured content", async () => {
  const memory = store({ summarize: async () => { throw new Error("private provider response and body must never appear here"); } });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const page = required(await memory.capture(input));
  expect(memory.detail(page.id)).toMatchObject({ body: input.body, summary: "", summarySource: "none", state: "failed", error: "summary provider failed; page text is still available" });
  expect(memory.status().error).toBe("summary provider failed; page text is still available");
  expect(JSON.stringify(memory.status())).not.toContain("private provider response");
});

test("summary requests stay serial and excess pending work is visibly refused", async () => {
  const result = Promise.withResolvers<string>();
  let providerRequests = 0;
  const memory = store({ summarize: () => { providerRequests++; return result.promise; } });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  for (let index = 0; index < 17; index++) await memory.capture({ ...input, url: `https://example.com/page-${index}` });
  expect(providerRequests).toBe(1);
  expect(memory.status()).toMatchObject({ total: 17, pending: 16, error: "summary queue is full; page text is still available" });
  memory.forget({ all: true });
  result.resolve("cancelled");
  await result.promise;
  expect(providerRequests).toBe(1);
  expect(memory.status().total).toBe(0);
});

test("closing aborts work and late completion cannot write into a reopened store", async () => {
  const directory = folder();
  const result = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const first = store({ directory, summarize: (_page, abort) => { signal = abort; return result.promise; } });
  first.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const page = required(await first.capture(input));
  first.close();
  expect(signal?.aborted).toBe(true);
  const second = store({ directory });
  result.resolve("late closed-store summary");
  await result.promise;
  expect(second.detail(page.id)).toMatchObject({ state: "failed", summary: "", body: input.body });
});

test("forget removes completed summaries, edited text and journal bytes without creating backups", async () => {
  const directory = folder();
  const memory = store({ directory, summarize: async () => "completed-summary-marker-112233" });
  memory.configure({ enabled: true, sites: ["example.com"], summarize: true });
  const page = required(await memory.capture({ ...input, body: "completed-body-marker-445566" }));
  expect(memory.detail(page.id)?.summary).toBe("completed-summary-marker-112233");
  memory.edit(page.id, { note: "completed-note-marker-778899" });
  memory.forget({ all: true });
  const stored = bytes(directory).toString("utf8");
  expect(stored).not.toContain("completed-body-marker-445566");
  expect(stored).not.toContain("completed-summary-marker-112233");
  expect(stored).not.toContain("completed-note-marker-778899");
  expect(readdirSync(directory).every((file) => ["observations.sqlite", "observations.sqlite-journal"].includes(file))).toBe(true);
  expect(memory.status().total).toBe(0);
});

test("raw configuration input is validated instead of enabling collection from truthy values", () => {
  const memory = store();
  const invalid: Record<string, unknown> = { enabled: "yes", sites: ["example.com"] };
  expect(() => memory.configure(invalid)).toThrow("memory switches must be true or false");
  expect(memory.status().config.enabled).toBe(false);
  expect(() => memory.configure({ sites: ["*.example.com"] })).toThrow("sites must be exact website hosts");
});

test("stored page text is bounded and known secrets and URL credentials are removed", async () => {
  const memory = store();
  memory.configure({ enabled: true, sites: ["example.com"] });
  keepSecret(987654, "known-secret-marker-13579");
  const address = new URL(input.url);
  address.username = "fixture-user";
  address.password = "fixture-password";
  address.searchParams.set("token", "private-url-token");
  address.hash = "draft";
  const page = required(await memory.capture({ ...input, url: address.href, body: `known-secret-marker-13579 ${"x".repeat(60_000)}` }));
  const detail = memory.detail(page.id);
  expect(detail?.body.length).toBeLessThanOrEqual(48_000);
  expect(detail?.body).not.toContain("known-secret-marker-13579");
  expect(page.url).not.toContain("private-url-token");
  expect(page.url).not.toContain("fixture-password");
  expect(page.url).not.toContain("draft");
});
