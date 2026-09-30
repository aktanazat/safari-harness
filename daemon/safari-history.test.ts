import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./bridge.ts";
import { openLoads, readLoads } from "./loads.ts";
import { daemonHttp } from "./rpc.ts";
import { browsingHistory } from "./safari-history.ts";
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
