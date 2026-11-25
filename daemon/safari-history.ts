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
import { BROWSER } from "./front.ts";

const HOME = homedir();
// Ladybird Harness (ladybird/install-app.sh) keeps its history in its
// profile's data: under LADYBIRD_PROFILE_PATH, the --profile-path the
// browser and bridge run with, else in its default profile, "developer" in
// a build of the fork.
const LADYBIRD = BROWSER.startsWith("org.ladybird.");
const HISTORY_DB = LADYBIRD
  ? (process.env.LADYBIRD_PROFILE_PATH ? join(process.env.LADYBIRD_PROFILE_PATH, "data", "History.db") : join(HOME, "Library", "Application Support", "Ladybird", "Profiles", "developer", "History.db"))
  : join(HOME, "Library", "Safari", "History.db");

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
// visits were his and how many agents' (the ids in ?3, a JSON list), whose
// title or address holds one of the texts in ?2 (a JSON list; none, every
// address). Redirect hops are left out; the title is the latest non-empty
// one the address had.
const SEARCH = `
  SELECT i.url url, SUM(NOT v.agent) visits, SUM(v.agent) agents, MAX(CASE WHEN NOT v.agent THEN v.visit_time END) last,
    (SELECT t.title FROM history_visits t WHERE t.history_item = i.id AND t.title <> '' ORDER BY t.visit_time DESC LIMIT 1) title
  FROM (SELECT history_item, visit_time, id IN (SELECT value FROM json_each(?3)) agent FROM history_visits
    WHERE visit_time > ?1 AND redirect_destination IS NULL) v
  JOIN history_items i ON i.id = v.history_item
  GROUP BY i.id
  HAVING json_array_length(?2) = 0 OR EXISTS (SELECT 1 FROM json_each(?2) w WHERE instr(lower(i.url), w.value) > 0 OR instr(lower(COALESCE(title, '')), w.value) > 0)
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

// Ladybird keeps one row per address: its title, how often it was visited
// and when last (ms since 1970), not each visit, so its count mixes the
// user's visits with agents'. An address an agent's load visited last, or
// one of the daemon's own pages, is left out as the agents'; no count of
// visits is given, and those left out count as one each.
type LadybirdRow = { url: string; title: string; last: number };
function ladybirdFound(db: Database, sinceMs: number, loads: Load[]): Found[] {
  const own = `${new URL(daemonHttp()).origin}/`;
  const rows = db.query("SELECT url, title, last_visited_time last FROM History WHERE last_visited_time > ?1 ORDER BY last_visited_time DESC").all(sinceMs) as LadybirdRow[];
  return rows.map((r) => {
    const agent = r.url.startsWith(own) || loads.some((l) => l.urls.includes(addressKey(r.url)) && r.last >= l.from - SLACK_MS && r.last <= l.to + SLACK_MS);
    return { url: r.url, title: r.title || null, last: agent ? null : r.last / 1000 - APPLE_EPOCH_S, visits: agent ? 0 : 1, agents: agent ? 1 : 0 };
  });
}

function opened<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

// Reads the database, or a private copy of it and its WAL when Safari holds
// a lock that blocks even readers; the copy goes to the Trash afterwards.
function readHistory<T>(path: string, read: (db: Database) => T): T {
  try {
    try {
      return opened(path, read);
    } catch (e) {
      if (!/locked|busy/i.test(e instanceof Error ? e.message : String(e))) throw e;
      const dir = mkdtempSync(join("/private/var/tmp", "safari-history-"));
      try {
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(path + suffix)) copyFileSync(path + suffix, join(dir, "History.db" + suffix));
        }
        return opened(join(dir, "History.db"), read);
      } finally {
        renameSync(dir, join(HOME, ".Trash", dir.split("/").pop() ?? "safari-history"));
      }
    }
  } catch (e) {
    throw new Error(`cannot read Safari history (${String(e instanceof Error ? e.message : e)}); the app running this needs Full Disk Access in System Settings > Privacy & Security`);
  }
}

// The hosts the user visited himself, in all the history Safari keeps: an
// agent's visit older than the loads the daemon keeps (loads.ts) counts as
// his, so a site agents and he both used is always his.
export function userHosts(files = { history: HISTORY_DB, loads: loadsFile(new URL(daemonHttp()).port) }): Set<string> {
  const loads = readLoads(files.loads, 0);
  const urls = LADYBIRD
    ? readHistory(files.history, (db) => ladybirdFound(db, 0, loads)).flatMap((r) => (r.last === null ? [] : [r.url]))
    : readHistory(files.history, (db) => {
      const visits = db.query(VISITS).all(-Infinity) as Visit[];
      const agents = new Set(agentVisits(visits, loads));
      return visits.flatMap((v) => (agents.has(v.id) ? [] : [v.url]));
    });
  return new Set(urls.flatMap((url) => {
    const host = URL.parse(url)?.hostname;
    return host ? [host.toLowerCase()] : [];
  }));
}

// files: Safari's history, and the loads the daemon noted (loads.ts); a
// test passes its own. any: several texts in one call, each address with
// the one it holds and up to limit for each, and those none held: on 10-22
// an agent looked up eight drug names one call at a time.
export function browsingHistory(opts: { text?: string; any?: string[]; days?: number; limit?: number }, files = { history: HISTORY_DB, loads: loadsFile(new URL(daemonHttp()).port) }) {
  const days = Math.max(1, opts.days ?? 30);
  const limit = Math.min(Math.max(1, opts.limit ?? 30), 200);
  const texts = [...new Set([opts.text ?? "", ...[opts.any ?? []].flat().map(String)].map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const sinceMs = Date.now() - days * 86_400_000;
  const since = sinceMs / 1000 - APPLE_EPOCH_S;
  const loads = readLoads(files.loads, sinceMs - SLACK_MS);
  const found = readHistory(files.history, (db) => {
    if (LADYBIRD) {
      const rows = ladybirdFound(db, sinceMs, loads);
      return texts.length === 0 ? rows : rows.filter((r) => texts.some((t) => r.url.toLowerCase().includes(t) || (r.title ?? "").toLowerCase().includes(t)));
    }
    const agents = agentVisits(db.query(VISITS).all(since) as Visit[], loads);
    return db.query(SEARCH).all(since, JSON.stringify(texts), JSON.stringify(agents)) as Found[];
  });
  const his = found.filter((r): r is Found & { last: number } => r.last !== null);
  const row = (r: Found & { last: number }) => ({
    title: r.title ?? "",
    url: redactUrl(r.url),
    lastVisit: new Date((APPLE_EPOCH_S + r.last) * 1000).toISOString(),
    ...(LADYBIRD ? {} : { visits: r.visits }),
  });
  const agentVisitsLeftOut = found.reduce((n, r) => n + r.agents, 0);
  // history, not pages: the text an agent reads (formatResult) prints a
  // pages list as map's, and each visit would read as a page that failed.
  if (opts.any === undefined) return { history: his.slice(0, limit).map(row), agentVisitsLeftOut };
  const each = new Map<string, number>();
  const history = his.flatMap((r) => {
    const term = texts.find((t) => r.url.toLowerCase().includes(t) || (r.title ?? "").toLowerCase().includes(t)) ?? "";
    const n = (each.get(term) ?? 0) + 1;
    each.set(term, n);
    return n > limit ? [] : [{ ...row(r), term }];
  });
  const noMatch = texts.filter((t) => !each.has(t));
  return { history, ...(noMatch.length ? { noMatch } : {}), agentVisitsLeftOut };
}

export const HISTORY_TOOLS: Record<string, Tool> = {
  browsing_history: {
    desc: `Search the user's ${LADYBIRD ? "Ladybird" : "Safari"} browsing history by title or address, newest first.`,
    params: {
      text: { type: "string", description: "words in the title or address, case-insensitive; omit for all" },
      any: { type: "array", items: { type: "string" }, description: "several texts" },
      days: { type: "number", description: "how far back, default 30" },
      limit: { type: "number", description: "default 30, max 200" },
    },
    run: async (a) => browsingHistory(a as { text?: string; any?: string[]; days?: number; limit?: number }),
  },
};
