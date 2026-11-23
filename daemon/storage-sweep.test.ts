import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepAgentStorage, topHost } from "./storage-sweep.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23);

// A WebKit string: 32-bit length, 1 for Latin-1, the characters.
const text = (s: string) => Buffer.concat([Buffer.from(Uint32Array.of(s.length).buffer), Buffer.of(1), Buffer.from(s, "latin1")]);
// The ClientOrigin WebKit writes: top origin, then client origin, each with
// no port.
const origin = (top: string, client = top) => Buffer.concat([text("https"), text(top), Buffer.of(0), text("https"), text(client), Buffer.of(0)]);

// An origin folder as Safari keeps one, its LocalStorage last written
// daysAgo before NOW; extra adds the other stores a folder may hold.
function folder(data: string, bucket: string, name: string, top: string, daysAgo: number, extra: string[] = [], client = top): string {
  const dir = join(data, bucket, name);
  mkdirSync(join(dir, "LocalStorage"), { recursive: true });
  for (const store of extra) mkdirSync(join(dir, store));
  writeFileSync(join(dir, "origin"), origin(top, client));
  const db = join(dir, "LocalStorage", "localstorage.sqlite3");
  writeFileSync(db, "");
  const at = (NOW - daysAgo * DAY) / 1000;
  utimesSync(db, at, at);
  utimesSync(join(dir, "LocalStorage"), at, at);
  return dir;
}

test("an origin folder's top host is read from the file WebKit writes, a third-party frame's under the site that embedded it", () => {
  expect([topHost(origin("platform.experientiallabs.ai")), topHost(origin("news.example", "ads.tracker.example")), topHost(Buffer.of(5, 0, 0))]).toEqual(["platform.experientiallabs.ai", "news.example", undefined]);
});

// 11-23: 4,850 origins, nearly all from agents' browsing, made each
// navigation to a site with no cookies wait 650-1,300 ms.
test("the sweep removes LocalStorage only agents' sites wrote and left a day, and keeps his sites, recent writes, and other stores", () => {
  const data = mkdtempSync(join(tmpdir(), "storage-sweep-"));
  try {
    const agents = folder(data, "a", "1", "research.example", 3);
    const agentsFrame = folder(data, "a", "2", "research.example", 3, [], "cdn.example");
    const his = folder(data, "b", "1", "mail.his.example", 30);
    const hisOtherHost = folder(data, "b", "2", "www.his.example", 30);
    const recent = folder(data, "c", "1", "fresh.example", 0.5);
    const indexed = folder(data, "d", "1", "app.example", 30, ["IndexedDB"]);
    const result = sweepAgentStorage({ now: NOW, data, hosts: new Set(["his.example"]) });
    expect({
      result,
      gone: [agents, agentsFrame].map(existsSync),
      kept: [his, hisOtherHost, recent, indexed].map(existsSync),
      buckets: readdirSync(data).sort(),
    }).toEqual({ result: { removed: 2, kept: 4 }, gone: [false, false], kept: [true, true, true, true], buckets: ["b", "c", "d"] });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("a dry run counts what the sweep would remove and removes nothing", () => {
  const data = mkdtempSync(join(tmpdir(), "storage-sweep-"));
  try {
    const agents = folder(data, "a", "1", "research.example", 3);
    expect([sweepAgentStorage({ now: NOW, data, hosts: new Set(), dryRun: true }), existsSync(agents)]).toEqual([{ removed: 1, kept: 0 }, true]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
