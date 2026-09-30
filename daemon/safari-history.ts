// Safari browsing history: search ~/Library/Safari/History.db (read-only) by
// title or address. The file sits under Full Disk Access, so this tool runs in
// the caller (terminal, MCP server) rather than in the launchd daemon, which
// macOS denies. Safari keeps the database open in WAL mode; a read-only open
// still sees the newest visits, which live in the -wal file until checkpoint.
// The visits agents made are left out, and counted (loads.ts).

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool } from "./tools.ts";
import { addressKey, loadsFile, readLoads, type Load } from "./loads.ts";
import { redactUrl } from "./redact.ts";
import { daemonHttp } from "./rpc.ts";

const HOME = homedir();
const HISTORY_DB = join(HOME, "Library", "Safari", "History.db");

// visit_time is seconds since 2001-01-01 UTC.
const APPLE_EPOCH_S = Date.UTC(2001, 0, 1) / 1000;

// A visit is a load's when the load went through its address within SLACK_MS
// of the visit: Safari may write the visit just before or after its tab
// update reaches the extension.
const SLACK_MS = 10_000;

type Visit = { id: number; time: number; url: string; next: number | null };
type Found = { url: string; title: string | null; last: number | null; visits: number; agents: number };

// Every visit since ?1, and the visit its redirect led to.
const VISITS = `
  SELECT v.id id, v.visit_time time, i.url url, v.redirect_destination next
  FROM history_visits v JOIN history_items i ON i.id = v.history_item
  WHERE v.visit_time > ?1`;

// One row per address, the user's newest visit first, with how many of its
// visits were his and how many agents' (the ids in ?3, a JSON list).
// Redirect hops are left out; the title is the latest non-empty one the
// address had.
const SEARCH = `
  SELECT i.url url, SUM(NOT v.agent) visits, SUM(v.agent) agents, MAX(CASE WHEN NOT v.agent THEN v.visit_time END) last,
    (SELECT t.title FROM history_visits t WHERE t.history_item = i.id AND t.title <> '' ORDER BY t.visit_time DESC LIMIT 1) title
  FROM (SELECT history_item, visit_time, id IN (SELECT value FROM json_each(?3)) agent FROM history_visits
    WHERE visit_time > ?1 AND redirect_destination IS NULL) v
  JOIN history_items i ON i.id = v.history_item
  GROUP BY i.id
  HAVING ?2 = '' OR instr(lower(i.url), ?2) > 0 OR instr(lower(COALESCE(title, '')), ?2) > 0
  ORDER BY last DESC`;

// The visits agents made: each one an agent's load went through, the rest
// of the redirect chain it started (a load has the address asked for and
// the one the tab ended on, not the hops between), and every visit to the
// daemon's own pages, one of which each agent window opens on.
function agentVisits(visits: Visit[], loads: Load[]): number[] {
  const own = `${new URL(daemonHttp()).origin}/`;
  const byUrl = new Map<string, Load[]>();
  for (const load of loads) {
    for (const url of load.urls) {
      const same = byUrl.get(url);
      if (same) same.push(load);
      else byUrl.set(url, [load]);
    }
  }
  const next = new Map(visits.map((v) => [v.id, v.next]));
  const agents = new Set<number>();
  for (const v of visits) {
    const ms = (APPLE_EPOCH_S + v.time) * 1000;
    if (!v.url.startsWith(own) && !byUrl.get(addressKey(v.url))?.some((l) => ms >= l.from - SLACK_MS && ms <= l.to + SLACK_MS)) continue;
    for (let id: number | null | undefined = v.id; typeof id === "number" && !agents.has(id); id = next.get(id)) agents.add(id);
  }
  return [...agents];
}

function query(path: string, since: number, text: string, loads: Load[]): Found[] {
  const db = new Database(path, { readonly: true });
  try {
    const agents = agentVisits(db.query(VISITS).all(since) as Visit[], loads);
    return db.query(SEARCH).all(since, text, JSON.stringify(agents)) as Found[];
  } finally {
    db.close();
  }
}

// Reads a private copy of the database and its WAL, for when Safari holds a
// lock that blocks even readers. The copy goes to the Trash afterwards.
function queryCopy(path: string, since: number, text: string, loads: Load[]): Found[] {
  const dir = mkdtempSync(join("/private/var/tmp", "safari-history-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, join(dir, "History.db" + suffix));
    }
    return query(join(dir, "History.db"), since, text, loads);
  } finally {
    renameSync(dir, join(HOME, ".Trash", dir.split("/").pop() ?? "safari-history"));
  }
}

// files: Safari's history, and the loads the daemon noted (loads.ts); a
// test passes its own.
export function browsingHistory(opts: { text?: string; days?: number; limit?: number }, files = { history: HISTORY_DB, loads: loadsFile(new URL(daemonHttp()).port) }) {
  const days = Math.max(1, opts.days ?? 30);
  const limit = Math.min(Math.max(1, opts.limit ?? 30), 200);
  const text = (opts.text ?? "").trim().toLowerCase();
  const sinceMs = Date.now() - days * 86_400_000;
  const since = sinceMs / 1000 - APPLE_EPOCH_S;
  const loads = readLoads(files.loads, sinceMs - SLACK_MS);
  let found: Found[];
  try {
    try {
      found = query(files.history, since, text, loads);
    } catch (e) {
      if (!/locked|busy/i.test(e instanceof Error ? e.message : String(e))) throw e;
      found = queryCopy(files.history, since, text, loads);
    }
  } catch (e) {
    throw new Error(`cannot read Safari history (${String(e instanceof Error ? e.message : e)}); the app running this needs Full Disk Access in System Settings > Privacy & Security`);
  }
  const his = found.filter((r): r is Found & { last: number } => r.last !== null);
  // history, not pages: the text an agent reads (formatResult) prints a
  // pages list as map's, and each visit would read as a page that failed.
  return {
    history: his.slice(0, limit).map((r) => ({
      title: r.title ?? "",
      url: redactUrl(r.url),
      lastVisit: new Date((APPLE_EPOCH_S + r.last) * 1000).toISOString(),
      visits: r.visits,
    })),
    agentVisitsLeftOut: found.reduce((n, r) => n + r.agents, 0),
  };
}

export const HISTORY_TOOLS: Record<string, Tool> = {
  browsing_history: {
    desc: "Search the user's Safari browsing history by title or address, newest first.",
    params: {
      text: { type: "string", description: "words in the title or address, case-insensitive; omit for all" },
      days: { type: "number", description: "how far back, default 30" },
      limit: { type: "number", description: "default 30, max 200" },
    },
    run: async (a) => browsingHistory(a as { text?: string; days?: number; limit?: number }),
  },
};
