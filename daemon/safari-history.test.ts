import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./bridge.ts";
import { openLoads, readLoads } from "./loads.ts";
import { daemonHttp } from "./rpc.ts";
import { browsingHistory, userHosts } from "./safari-history.ts";
import { formatResult } from "./tools.ts";

// History.db counts time in seconds since 2001-01-01 UTC.
const apple = (ms: number) => ms / 1000 - 978_307_200;

// A History.db with the columns browsing_history reads, as Safari names
// them. A visit's id is its place in the list, from 1; next is the id of the
// visit its redirect led to.
function historyWith(dir: string, visits: { url: string; at: number; title?: string; next?: number }[]): string {
  const path = join(dir, "History.db");
  const db = new Database(path);
  db.run("CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE)");
  db.run("CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL, visit_time REAL NOT NULL, title TEXT, redirect_destination INTEGER)");
  visits.forEach((v, i) => {
    db.run("INSERT OR IGNORE INTO history_items (url) VALUES (?)", [v.url]);
    db.run("INSERT INTO history_visits VALUES (?, (SELECT id FROM history_items WHERE url = ?), ?, ?, ?)", [i + 1, v.url, apple(v.at), v.title ?? null, v.next ?? null]);
  });
  db.close();
  return path;
}

// On 09-30 the live checks' pages were reported as the user's visits.
// Here an owned page went through /go to /page with no tool call running.
// Safari's tab update was for /go; the user followed the same link an hour
// later. The extension's event must survive a daemon restart and still leave
// out only its own visit, not the user's.
test("a load reported by the extension and its redirect stay out of history after restart, while the user's later visit stays", () => {
  const dir = mkdtempSync(join(tmpdir(), "safari-history-"));
  const heard = Math.floor(Date.now() / 1000) * 1000 - 2 * 3_600_000;
  const his = heard + 3_600_000;
  const db = historyWith(dir, [
    { url: "https://example.com/go", at: heard + 300, next: 2 },
    { url: "https://example.com/page", at: heard + 500, title: "Page" },
    { url: "https://example.com/go", at: his - 200, next: 4 },
    { url: "https://example.com/page", at: his, title: "Page" },
  ]);
  const loads = join(dir, "loads.jsonl");
  openLoads(loads);
  const bridge = new Bridge();
  bridge.attach({ send() {}, close() {} });
  bridge.handleMessage(JSON.stringify({ op: "load", url: "https://example.com/go", from: heard, to: heard }));
  openLoads(loads);
  expect(readLoads(loads, 0)).toEqual([{ from: heard, to: heard, urls: ["https://example.com/go"] }]);
  const answer = browsingHistory({}, { history: db, loads });
  expect(answer).toEqual({
    history: [{ title: "Page", url: "https://example.com/page", lastVisit: new Date(his).toISOString(), visits: 1 }],
    agentVisitsLeftOut: 1,
  });
  // An agent reads it as text (formatResult), and reads all of it.
  expect(JSON.parse(formatResult(answer))).toEqual(answer);
});

// Each agent window opens on one of the daemon's own pages: 338 more visits
// on 09-30.
test("visits to the daemon's own pages are left out of browsing_history and counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "safari-history-"));
  const db = historyWith(dir, [{ url: `${daemonHttp()}/space?id=1&name=agent%201`, at: Date.now() - 60_000, title: "agent 1" }]);
  expect(browsingHistory({}, { history: db, loads: join(dir, "loads.jsonl") })).toEqual({ history: [], agentVisitsLeftOut: 1 });
});

// On 10-22 an agent looked up eight drug names in his history, one call each.
test("any finds the visits holding any of several texts, each with the one it holds, and names those none held", () => {
  const dir = mkdtempSync(join(tmpdir(), "safari-history-"));
  const now = Math.floor(Date.now() / 1000) * 1000;
  const db = historyWith(dir, [
    { url: "https://pharmacy.example/mildronate", at: now - 3_000, title: "Buy" },
    { url: "https://news.example/a", at: now - 2_000, title: "Mexidol review" },
    { url: "https://news.example/b", at: now - 1_000, title: "Weather" },
  ]);
  const answer = browsingHistory({ any: ["Mexidol", "mildronate", "phenibut"] }, { history: db, loads: join(dir, "loads.jsonl") });
  expect(answer).toEqual({
    history: [
      { title: "Mexidol review", url: "https://news.example/a", lastVisit: new Date(now - 2_000).toISOString(), visits: 1, term: "mexidol" },
      { title: "Buy", url: "https://pharmacy.example/mildronate", lastVisit: new Date(now - 3_000).toISOString(), visits: 1, term: "mildronate" },
    ],
    noMatch: ["phenibut"],
    agentVisitsLeftOut: 0,
  });
});

// The storage sweep (storage-sweep.ts) deletes the LocalStorage of sites
// only agents visited, so a site he visited even once must count as his.
test("the user's hosts are those of his own visits; a host only agents' loads went through is not one", () => {
  const dir = mkdtempSync(join(tmpdir(), "safari-history-"));
  const at = Date.now() - 3_600_000;
  const db = historyWith(dir, [
    { url: "https://research.example/a", at },
    { url: "https://Mail.His.example/inbox", at: at + 60_000 },
    { url: "https://both.example/", at: at + 120_000 },
    { url: "https://both.example/", at: at + 30 * 60_000 },
  ]);
  const loads = join(dir, "loads.jsonl");
  writeFileSync(loads, [`https://research.example/a`, `https://both.example/`].map((url, i) => JSON.stringify({ from: at + i * 120_000, to: at + i * 120_000, urls: [url] })).join("\n") + "\n");
  expect([...userHosts({ history: db, loads })].sort()).toEqual(["both.example", "mail.his.example"]);
});

// The sweep takes an origin left a week and runs weekly: its loads must
// reach back two weeks even when agents load more than MAX pages in them.
test("the loads file keeps every load of the last 14 days past the latest 10,000, and drops older ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "safari-history-"));
  const loads = join(dir, "loads.jsonl");
  const day = 86_400_000;
  const line = (at: number, i: number) => JSON.stringify({ from: at, to: at, urls: [`https://site${i}.example/`] });
  const old = Array.from({ length: 1_000 }, (_, i) => line(Date.now() - 20 * day, i));
  const recent = Array.from({ length: 11_000 }, (_, i) => line(Date.now() - 13 * day + i, i));
  writeFileSync(loads, [...old, ...recent].join("\n") + "\n");
  openLoads(loads);
  const kept = readLoads(loads, 0);
  expect([kept.length, kept[0].urls[0]]).toEqual([11_000, "https://site0.example/"]);
});
