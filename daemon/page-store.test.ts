import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageStore } from "./page-store.ts";

const dir = mkdtempSync(join(tmpdir(), "page-store-"));
const store = new PageStore(dir);
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A search is answered from pages agents read only when a page has every
// word of it, and a site: search only from pages at that site; on 11-08
// a query's site: was dropped and any site's page answered it.
test("a find returns pages with every word of the query, at the site: it names", () => {
  store.put({ url: "https://openrouter.ai/docs/api-reference/errors?utm_source=x#429", title: "Errors", text: "A 429 status means you hit the rate limit for the model.", source: "read" });
  store.put({ url: "https://news.example.com/openrouter-rate", title: "OpenRouter rate limits", text: "Users report 429 rate limit errors on OpenRouter.", source: "read" });
  store.put({ url: "https://openrouter.ai/docs/quickstart", title: "Quickstart", text: "Send your first request.", source: "read" });
  expect(store.find("site:openrouter.ai/docs 429 rate").map((p) => p.url)).toEqual(["https://openrouter.ai/docs/api-reference/errors"]);
  expect(store.find("429 rate limit").map((p) => p.url).sort()).toEqual(["https://news.example.com/openrouter-rate", "https://openrouter.ai/docs/api-reference/errors"]);
  expect(store.find("site:github.com 429 rate")).toEqual([]);
});

// Every omp session on the Mac sees what the store holds, so a page from
// this Mac's network or a link carrying a credential never goes in.
test("pages on private addresses or with a credential in the link are refused", () => {
  const text = "zebracrossing private page text";
  for (const url of ["http://100.101.102.103:8080/", "http://aktans-ipad:8000/logs", "http://[fd7a:115c:a1e0::1]:8080/", "http://app.localhost:3000/", "http://router.lan/", "https://bucket.s3.amazonaws.com/i.pdf?X-Amz-Signature=abc", "https://maps.googleapis.com/maps/api/geocode/json?address=Davis&key=AIza"]) {
    expect(store.put({ url, title: "Private", text, source: "read" })).toBe(false);
  }
  expect(store.find("zebracrossing")).toEqual([]);
});
