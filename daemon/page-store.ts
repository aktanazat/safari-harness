// A local, searchable store of public pages agents have read and of the
// result lists their web searches got, so a search can answer from pages
// already read, with no browser, and still answer when every engine fails.
// Only public text goes in: pages an agent fetched anonymously (omp's read
// of a URL) and search result lists. Signed-in Safari reads stay in
// browser memory (browser-memory.ts), which has its own consent and expiry.

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool } from "./tools.ts";

// A page's text kept, at most; past it the page is cut.
const TEXT_MAX = 200_000;
// Pages kept, newest read first; older ones are dropped on the next put.
// Replaying 2,628 searches of 11-01..08 against the pages read before each:
// 20,000 pages (337 MB) gave 13.4% of them a page already read, 10,000
// (177 MB) 12.8%, 5,000 (97 MB) 10.5%.
const PAGES_MAX = 10_000;
// Result lists kept, newest first.
const SEARCHES_MAX = 5_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, readAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pages_read ON pages(readAt);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, text, content='pages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN INSERT INTO pages_fts(rowid, title, text) VALUES (new.id, new.title, new.text); END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text); END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text); INSERT INTO pages_fts(rowid, title, text) VALUES (new.id, new.title, new.text); END;
CREATE TABLE IF NOT EXISTS searches (query TEXT PRIMARY KEY, engine TEXT NOT NULL, results TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS searches_at ON searches(at);
`;

export type StoredResult = { title: string; url: string; snippet: string };
export type PageHit = { url: string; title: string; readAt: number; excerpt: string };

// Hosts whose pages are this Mac's or its network's, never public: an
// address as numbers, a name with no dot (a MagicDNS or LAN machine), and
// the private endings.
const PRIVATE_HOST = /^(?:\[.*\]|\d+\.\d+\.\d+\.\d+|[^.]+)$|\.(?:localhost|local|lan|home\.arpa|internal|ts\.net)$/i;
// Query keys that carry a credential: a link with one is someone's access.
const SECRET_KEY = /^(?:.*token|.*key|sig|signature|x-amz-.*|x-goog-.*|code|auth|session|password|secret)$/i;

// The address a public page is kept under: no fragment, no tracking
// parameters. Undefined for a page that is not public, so nothing private
// reaches the store whoever calls it.
export function canonicalUrl(raw: string): string | undefined {
  const url = URL.parse(raw);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || PRIVATE_HOST.test(url.hostname)) return undefined;
  url.hash = "";
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => SECRET_KEY.test(key))) return undefined;
  for (const key of keys) if (/^(utm_\w+|fbclid|gclid|srsltid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}

// A query as searches are kept under: lower case, spacing collapsed.
export function searchKey(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

// A web query's words as an FTS5 match: every word, quoted, so operators
// and punctuation are text; search operators (site:, after:) are dropped.
export function matchOf(query: string): string | undefined {
  const words = query
    .split(/\s+/)
    .filter((w) => !/^-|^\w+:/.test(w))
    .flatMap((w) => w.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length > 1 && !/^(or|and|the|a|an|of|to|in|for|on|with|is|how|what)$/i.test(w));
  return words.length ? [...new Set(words.map((w) => w.toLowerCase()))].map((w) => `"${w}"`).join(" ") : undefined;
}

export class PageStore {
  private readonly db: Database;

  constructor(directory = join(homedir(), ".local/share/safari-harness/page-store")) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const folder = lstatSync(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("the page store needs a private regular directory");
    chmodSync(directory, 0o700);
    const path = join(directory, "pages.sqlite");
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA);
  }

  put(page: { url: string; title: string; text: string; source: string; readAt?: number }): boolean {
    const url = canonicalUrl(page.url);
    const text = page.text.slice(0, TEXT_MAX);
    if (!url || !text.trim()) return false;
    this.db.query("INSERT INTO pages(url,title,text,source,readAt) VALUES(?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title, text=excluded.text, source=excluded.source, readAt=excluded.readAt WHERE excluded.readAt >= pages.readAt")
      .run(url, page.title.slice(0, 500), text, page.source, page.readAt ?? Date.now());
    this.db.query("DELETE FROM pages WHERE id IN (SELECT id FROM pages ORDER BY readAt DESC LIMIT -1 OFFSET ?)").run(PAGES_MAX);
    return true;
  }

  // Pages whose title or text has every word of query, best first, each
  // with the part of its text around the words; with site:, only pages at
  // that site.
  find(query: string, limit = 3): PageHit[] {
    const match = matchOf(query);
    if (!match) return [];
    const site = /(?:^|\s)site:(\S+)/i.exec(query)?.[1]?.toLowerCase().replace(/^https?:\/\//, "") ?? null;
    return this.db.query<PageHit, [string, string | null, string | null, string | null, number]>(
      "SELECT p.url, p.title, p.readAt, snippet(pages_fts, 1, '', '', ' … ', 32) AS excerpt FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid WHERE pages_fts MATCH ? AND (? IS NULL OR p.url LIKE '%://' || ? || '%' OR p.url LIKE '%.' || ? || '%') ORDER BY bm25(pages_fts, 4.0, 1.0) LIMIT ?",
    ).all(match, site, site, site, limit);
  }

  get(url: string): { url: string; title: string; text: string; readAt: number } | undefined {
    const key = canonicalUrl(url);
    if (!key) return undefined;
    return this.db.query<{ url: string; title: string; text: string; readAt: number }, [string]>("SELECT url, title, text, readAt FROM pages WHERE url = ?").get(key) ?? undefined;
  }

  // The results a search for query got, if no older than maxAge ms.
  searched(query: string, maxAge: number): { engine: string; results: StoredResult[]; at: number } | undefined {
    const row = this.db.query<{ engine: string; results: string; at: number }, [string, number]>("SELECT engine, results, at FROM searches WHERE query = ? AND at >= ?").get(searchKey(query), Date.now() - maxAge);
    return row ? { engine: row.engine, results: JSON.parse(row.results) as StoredResult[], at: row.at } : undefined;
  }

  saveSearch(query: string, engine: string, results: StoredResult[]): void {
    if (!results.length) return;
    this.db.query("INSERT INTO searches(query,engine,results,at) VALUES(?,?,?,?) ON CONFLICT(query) DO UPDATE SET engine=excluded.engine, results=excluded.results, at=excluded.at")
      .run(searchKey(query), engine, JSON.stringify(results), Date.now());
    this.db.query("DELETE FROM searches WHERE query IN (SELECT query FROM searches ORDER BY at DESC LIMIT -1 OFFSET ?)").run(SEARCHES_MAX);
  }

  close(): void {
    this.db.close();
  }
}

let store: PageStore | undefined;
const opened = () => (store ??= new PageStore());

const str = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value) throw new Error(`pages needs ${name}`);
  return value;
};

export const PAGES_TOOL: Tool = {
  desc: "The local store of public pages agents read and of web search result lists (page-store.ts): put, find, get, searched, save_search.",
  params: {
    do: { type: "string", enum: ["put", "find", "get", "searched", "save_search"] },
    url: { type: "string" },
    title: { type: "string" },
    text: { type: "string" },
    source: { type: "string", description: "put: where the text came from" },
    readAt: { type: "number", description: "put: epoch ms the page was read" },
    query: { type: "string" },
    limit: { type: "number" },
    maxAge: { type: "number", description: "searched: ms" },
    engine: { type: "string" },
    results: { type: "array", items: { type: "object" } },
  },
  required: ["do"],
  hidden: true,
  run: async (a) => {
    const pages = opened();
    switch (a.do) {
      case "put":
        return { stored: pages.put({ url: str(a.url, "url"), title: typeof a.title === "string" ? a.title : "", text: str(a.text, "text"), source: str(a.source, "source"), ...(typeof a.readAt === "number" ? { readAt: a.readAt } : {}) }) };
      case "find":
        return { pages: pages.find(str(a.query, "query"), typeof a.limit === "number" ? a.limit : 3) };
      case "get":
        return pages.get(str(a.url, "url")) ?? null;
      case "searched":
        return pages.searched(str(a.query, "query"), typeof a.maxAge === "number" ? a.maxAge : 3_600_000) ?? null;
      case "save_search": {
        const results = Array.isArray(a.results) ? a.results.filter((r): r is StoredResult => !!r && typeof r === "object" && typeof r.title === "string" && typeof r.url === "string" && typeof r.snippet === "string") : [];
        pages.saveSearch(str(a.query, "query"), str(a.engine, "engine"), results);
        return { ok: true };
      }
      default:
        throw new Error("pages do must be put, find, get, searched, or save_search");
    }
  },
};
