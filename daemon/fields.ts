import { markLines } from "./injection.ts";

// extract's fields: rows as objects with the keys the agent named, each
// from the column that fits it best. A source is a table or card list as
// extract reads it ({headers, rows}, with the hints cardFields gives), or
// plain objects (a JSON feed's rows). A field's column is the one asked
// for, else the one whose name says it (a header, a JSON key, a CSS key),
// else the one whose hint says it (itemprop, data-testid, aria-label,
// title, a "Label:" before it), else the one whose values look like it
// (currency for a price). Two that fit: the named one, else the one filled
// in more rows; the other is the runner-up.

export type RowsSource = { headers: string[]; rows: string[][]; hints?: string[]; kind?: string; caption?: string } | Record<string, unknown>[];

type By = "asked" | "name" | "hint" | "value";
export type FieldReport = { column: string; by: By; samples: string[]; runnerUp?: { column: string; samples: string[] } };
export type Fielded = {
  rows: Record<string, string>[];
  fields: Record<string, FieldReport>;
  missing?: string[];
  unused?: { column: string; sample: string }[];
  source?: number;
  sources?: number;
  addressedToAI?: number;
};

type Column = { name: string; own: Set<string>; all: Set<string>; hint: Set<string>; link: boolean; values: string[]; filled: number };
type Candidate = { col: Column; by: By; rank: number; spot: number; fit: number };

const USAGE = 'fields must be names, as ["price", "date"] or "price,date", or an object naming each one\'s column, as {"price": "span.price"}';

// Names a field goes by besides its own, kept to ones sites use.
const SYNONYMS: Record<string, string[]> = {
  price: ["cost", "amount"],
  date: ["time", "posted", "published", "created", "age"],
  rating: ["stars"],
  seller: ["vendor", "merchant", "shop", "store", "sold by"],
  author: ["by", "user", "poster"],
  title: ["name", "heading", "h2", "h3"],
  url: ["link", "href"],
  link: ["url", "href"],
  points: ["score"],
  comments: ["replies"],
};

const CURRENCY = /(?:[$€£¥₹]\s?\d|\b(?:USD|EUR|GBP|CAD|AUD|JPY|INR)\s?\d|\d\s?(?:[$€£¥₹]|USD|EUR|GBP)(?!\w))/i;
const NUMBER = /^[-+]?\d[\d,]*(?:\.\d+)?$/;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+${MONTH}(?:\\s|$)|\\b\\d+\\s*(?:s|sec|second|m|min|minute|h|hr|hour|d|day|w|week|mo|month|y|yr|year)s?\\s+ago\\b|^(?:today|yesterday)\\b`, "i");
const RATING = /\b\d(?:\.\d)?\s*(?:\/\s*5|out of 5|stars?)\b|[★⭐]/i;
const URL_LIKE = /^https?:\/\/\S+$/;
const COUNT = /^\(?[\d,.]+[kKmM]?\)?(?:\s+[a-z]+)?$/;

// What a field's values look like: strict picks a column by its values
// alone; loose rules out a named column that cannot be it (a "Price:"
// label beside the price).
type Look = { strict: RegExp; loose: (v: string) => boolean };
const LOOKS: [string[], Look][] = [
  [["price", "cost", "amount"], { strict: CURRENCY, loose: (v) => CURRENCY.test(v) || NUMBER.test(v) }],
  [["date", "time", "posted", "published", "created", "updated"], { strict: DATE, loose: (v) => DATE.test(v) || /\d/.test(v) }],
  [["rating", "stars"], { strict: RATING, loose: (v) => RATING.test(v) || NUMBER.test(v) }],
  [["url", "link", "href"], { strict: URL_LIKE, loose: (v) => URL_LIKE.test(v) || v.startsWith("/") }],
  [["count", "comments", "reviews", "points", "votes", "replies", "quantity"], { strict: COUNT, loose: (v) => /\d/.test(v) }],
];
// Words that mark a value as a past one (a price before a sale): eBay's
// STRIKETHROUGH, Amazon's a-text-strike, Shopify's compare-at-price.
const PAST = new Set(["old", "was", "orig", "original", "compare", "strike", "strikethrough", "struck", "previous", "before", "regular"].map(stem));

function stem(word: string): string {
  const cut = word.replace(/(?:ings?|ed|es|s)$/, "");
  const base = cut.length >= 3 ? cut : word;
  return base.length > 3 ? base.replace(/e$/, "") : base;
}

function words(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}

// The fields asked for, and the column asked for each one named so.
function askedOf(asked: unknown): { names: string[]; columns: Record<string, string> } {
  let given = asked;
  if (typeof given === "string") {
    const text = given.trim();
    given = text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text.split(",");
  }
  const columns: Record<string, string> = {};
  let names: string[];
  if (Array.isArray(given) && given.every((n) => typeof n === "string")) names = given;
  else if (given && typeof given === "object" && !Array.isArray(given) && Object.values(given).every((c) => typeof c === "string")) {
    names = Object.keys(given);
    for (const [name, column] of Object.entries(given as Record<string, string>)) if (column.trim()) columns[name.trim()] = column.trim();
  } else throw new Error(USAGE);
  names = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!names.length) throw new Error(USAGE);
  return { names, columns };
}

function cellOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object")) return value.join(", ");
  return undefined;
}

// A plain object's cells by key; a nested object's by "key.inner", one
// level down (a feed's {"price": {"amount": 9}}).
function flatten(row: Record<string, unknown>): Map<string, string> {
  const cells = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    const cell = cellOf(value);
    if (cell !== undefined) cells.set(key, cell);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, v] of Object.entries(value)) {
        const c = cellOf(v);
        if (c !== undefined) cells.set(`${key}.${inner}`, c);
      }
    }
  }
  return cells;
}

function column(name: string, hint: string, values: string[]): Column {
  const own = name.split(" > ").at(-1) ?? name;
  return { name, own: new Set(words(own)), all: new Set(words(name)), hint: new Set(words(hint)), link: / href$/.test(name), values, filled: values.filter((v) => v.trim()).length };
}

function columnsOf(source: RowsSource): { columns: Column[]; count: number } {
  if (!Array.isArray(source)) {
    const columns = source.headers.map((h, i) => column(h || `column ${i + 1}`, source.hints?.[i] ?? "", source.rows.map((r) => r[i] ?? "")));
    return { columns, count: source.rows.length };
  }
  const rows = source.filter((r) => r && typeof r === "object" && !Array.isArray(r)).map(flatten);
  const keys = [...new Set(rows.flatMap((r) => [...r.keys()]))];
  return { columns: keys.map((k) => column(k, "", rows.map((r) => r.get(k) ?? ""))), count: rows.length };
}

// Every column that could be field, best first.
function candidates(field: string, columns: Column[]): Candidate[] {
  const own = words(field);
  const alternates = [own, ...(Object.entries(SYNONYMS).find(([name]) => stem(name) === own.join(" "))?.[1] ?? []).map(words)];
  const look = LOOKS.find(([names]) => alternates.some((alt) => alt.length === 1 && names.map(stem).includes(alt[0])))?.[1];
  const wantsLink = alternates.some((alt) => alt.some((w) => w === "url" || w === "link" || w === "href"));
  const has = (set: Set<string>) => alternates.some((alt) => alt.every((w) => set.has(w)));
  const out: Candidate[] = [];
  for (const col of columns) {
    if (!col.filled || (col.link && !wantsLink)) continue;
    const filled = col.values.filter((v) => v.trim());
    const fit = look ? filled.filter((v) => (look.loose(v.trim()))).length / filled.length : 1;
    const strict = look ? filled.filter((v) => v.length <= 60 && look.strict.test(v.trim())).length / filled.length : 0;
    const named = has(col.all);
    const hinted = has(col.hint);
    const past = [...col.all, ...col.hint].some((w) => PAST.has(w) && !own.includes(w)) ? 2 : 0;
    if ((named || hinted) && fit > 0) {
      const exact = words(col.name).join(" ") === own.join(" ");
      const direct = own.every((w) => col.all.has(w) || col.hint.has(w)) ? 0.5 : 0;
      out.push({ col, by: named ? "name" : "hint", rank: (named ? 3 : 2) + (named && hinted ? 1 : 0) + direct - past, spot: exact ? 3 : has(col.own) ? 2 : 1, fit });
    } else if (look && strict >= 0.6) out.push({ col, by: "value", rank: 1 - past, spot: 0, fit: strict });
  }
  return out.sort((a, b) => b.rank - a.rank || b.spot - a.spot || b.col.filled - a.col.filled || b.fit - a.fit);
}

const samplesOf = (col: Column, n: number) => col.values.filter((v) => v.trim()).slice(0, n);

type Pick = { found: Map<string, { col: Column; by: By; runnerUp?: Column }>; count: number; columns: Column[] };

function pickIn(source: RowsSource, names: string[], asked: Record<string, string>): Pick {
  const { columns, count } = columnsOf(source);
  const found: Pick["found"] = new Map();
  const used = new Set<Column>();
  for (const name of names) {
    const want = asked[name];
    if (want === undefined) continue;
    const col = columns.find((c) => c.name === want) ?? columns.find((c) => c.name.endsWith(` > ${want}`));
    if (col) {
      found.set(name, { col, by: "asked" });
      used.add(col);
    }
  }
  for (const name of names) {
    if (asked[name] !== undefined) continue;
    const [best, next] = candidates(name, columns).filter((c) => !used.has(c.col));
    if (!best) continue;
    found.set(name, { col: best.col, by: best.by, ...(next ? { runnerUp: next.col } : {}) });
    used.add(best.col);
  }
  return { found, count, columns };
}

// The rows of the source that fits the fields best (the most of them
// found, then the most rows), each an object with exactly the fields'
// keys, a field not found reading "". Page strings are marked as
// injection.ts marks extract's text.
export function pickFields(sources: RowsSource[], fields: unknown): Fielded {
  const { names, columns: asked } = askedOf(fields);
  let places = 0;
  const mark = (text: string) => {
    const marked = markLines(text, false);
    places += marked.places;
    return marked.text;
  };
  const picks = sources.map((s) => pickIn(s, names, asked));
  const best = picks.reduce<number>((at, p, i) => (at < 0 || p.found.size > picks[at].found.size || (p.found.size === picks[at].found.size && p.count > picks[at].count) ? i : at), -1);
  const pick: Pick = best < 0 ? { found: new Map(), count: 0, columns: [] } : picks[best];
  const rows = Array.from({ length: pick.count }, (_, r) => Object.fromEntries(names.map((name) => [name, mark(pick.found.get(name)?.col.values[r] ?? "")])));
  const report: Record<string, FieldReport> = {};
  for (const [name, { col, by, runnerUp }] of pick.found) {
    report[name] = { column: mark(col.name), by, samples: samplesOf(col, 3).map(mark), ...(runnerUp ? { runnerUp: { column: mark(runnerUp.name), samples: samplesOf(runnerUp, 2).map(mark) } } : {}) };
  }
  const missing = names.filter((n) => !pick.found.has(n));
  const taken = new Set([...pick.found.values()].map((f) => f.col));
  const unused = missing.length ? pick.columns.filter((c) => c.filled && !taken.has(c)).slice(0, 12).map((c) => ({ column: mark(c.name), sample: mark(samplesOf(c, 1)[0].slice(0, 80)) })) : [];
  return {
    rows,
    fields: report,
    ...(missing.length ? { missing } : {}),
    ...(unused.length ? { unused } : {}),
    ...(sources.length > 1 ? { source: best, sources: sources.length } : {}),
    ...(places ? { addressedToAI: places } : {}),
  };
}
