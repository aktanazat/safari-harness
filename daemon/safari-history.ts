// Safari browsing history: search ~/Library/Safari/History.db (read-only) by
// title or address. The file sits under Full Disk Access, so this tool runs in
// the caller (terminal, MCP server) rather than in the launchd daemon, which
// macOS denies. Safari keeps the database open in WAL mode; a read-only open
// still sees the newest visits, which live in the -wal file until checkpoint.

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool } from "./tools.ts";
import { redactUrl } from "./redact.ts";

const HOME = homedir();
const HISTORY_DB = join(HOME, "Library", "Safari", "History.db");

// visit_time is seconds since 2001-01-01 UTC.
const APPLE_EPOCH_S = Date.UTC(2001, 0, 1) / 1000;

type Row = { url: string; title: string | null; last: number; visits: number };

// One row per address, newest visit first. Redirect hops are left out; the
// title is the latest non-empty one the address had.
const SEARCH = `
  SELECT i.url url, COUNT(*) visits, MAX(v.visit_time) last,
    (SELECT t.title FROM history_visits t WHERE t.history_item = i.id AND t.title <> '' ORDER BY t.visit_time DESC LIMIT 1) title
  FROM history_visits v JOIN history_items i ON i.id = v.history_item
  WHERE v.visit_time > ?1 AND v.redirect_destination IS NULL
  GROUP BY i.id
  HAVING ?2 = '' OR instr(lower(i.url), ?2) > 0 OR instr(lower(COALESCE(title, '')), ?2) > 0
  ORDER BY last DESC
  LIMIT ?3`;

function query(path: string, since: number, text: string, limit: number): Row[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(SEARCH).all(since, text, limit) as Row[];
  } finally {
    db.close();
  }
}

// Reads a private copy of the database and its WAL, for when Safari holds a
// lock that blocks even readers. The copy goes to the Trash afterwards.
function queryCopy(since: number, text: string, limit: number): Row[] {
  const dir = mkdtempSync(join("/private/var/tmp", "safari-history-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(HISTORY_DB + suffix)) copyFileSync(HISTORY_DB + suffix, join(dir, "History.db" + suffix));
    }
    return query(join(dir, "History.db"), since, text, limit);
  } finally {
    renameSync(dir, join(HOME, ".Trash", dir.split("/").pop() ?? "safari-history"));
  }
}

export function browsingHistory(opts: { text?: string; days?: number; limit?: number }) {
  const days = Math.max(1, opts.days ?? 30);
  const limit = Math.min(Math.max(1, opts.limit ?? 30), 200);
  const text = (opts.text ?? "").trim().toLowerCase();
  const since = Date.now() / 1000 - APPLE_EPOCH_S - days * 86400;
  let rows: Row[];
  try {
    try {
      rows = query(HISTORY_DB, since, text, limit);
    } catch (e) {
      if (!/locked|busy/i.test(e instanceof Error ? e.message : String(e))) throw e;
      rows = queryCopy(since, text, limit);
    }
  } catch (e) {
    throw new Error(`cannot read Safari history (${String(e instanceof Error ? e.message : e)}); the app running this needs Full Disk Access in System Settings > Privacy & Security`);
  }
  return rows.map((r) => ({
    title: r.title ?? "",
    url: redactUrl(r.url),
    lastVisit: new Date((APPLE_EPOCH_S + r.last) * 1000).toISOString(),
    visits: r.visits,
  }));
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
