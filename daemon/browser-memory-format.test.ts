import { expect, test } from "bun:test";
import { formatResult } from "./tools.ts";
import { BROWSER_MEMORY_TRUST } from "./browser-memory-runtime.ts";

const page = {
  id: "saved-aurora-observation", url: "https://example.com/aurora", site: "example.com",
  title: "Aurora survey", visitedAt: 1792699200000, observation: "viewed",
  summary: "Oxygen emissions were measured at 557.7 nanometers.", excerpt: "The observatory used a spectrometer.",
  note: "Check calibration.", state: "ready", summarySource: "provider",
};

test("browser search text preserves readable observations and source provenance rather than map errors", () => {
  const result = JSON.parse(formatResult({ pages: [page], total: 1, trust: BROWSER_MEMORY_TRUST }));
  expect(result.pages[0]).toMatchObject({ id: page.id, url: page.url, visitedAt: page.visitedAt, summary: page.summary, excerpt: page.excerpt, observation: "viewed" });
  expect(result.trust).toBe(BROWSER_MEMORY_TRUST);
  expect(result.total).toBe(1);
});

test("empty browser status still exposes collection settings and a service error", () => {
  const result = JSON.parse(formatResult({ status: { config: { enabled: false, sites: [] }, error: "Safari is disconnected" }, pages: [], total: 0, trust: BROWSER_MEMORY_TRUST }));
  expect(result.status.config).toEqual({ enabled: false, sites: [] });
  expect(result.status.error).toBe("Safari is disconnected");
  expect(result.pages).toEqual([]);
  expect(result.total).toBe(0);
});
