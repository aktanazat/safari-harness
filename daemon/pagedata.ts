// The page's own data, as the data tool returns it: what its markup
// declares for machines (JSON-LD, microdata, meta tags, JSON in script tags
// and data- attributes, read by content.js) and the state its framework
// left in page globals (Next.js, Nuxt, Remix, Apollo, a Redux store, read in
// the page's world by background.js). A product's price and stock, or a
// feed's items, come back as the page's own JSON instead of text to parse.
// Up to max bytes it comes back whole; the sources that do not fit give
// their size and top-level keys, and pick, a path such as
// next.props.pageProps.items[0].name, returns the part wanted.

import { bridge } from "./bridge.ts";

// Everything here arrived as JSON, from the page through the extension.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export type DomData = {
  url: string;
  title: string;
  jsonld?: Json[];
  microdata?: Json[];
  meta?: JsonObject;
  next?: Json;
  // Nuxt 3's payload from its script tag, in devalue's flat form
  nuxt?: Json;
  scripts?: Json[];
  attrs?: Json[];
  // what the page holds but was too big to send, by size
  tooBig?: Record<string, number>;
};

export type PageGlobals = { values?: JsonObject; tooBig?: Record<string, number> };

// A source without data was too big to send; only its size is known.
type Source = { name: string; bytes: number; data?: Json };

type Step = string | number;

// The order sources are listed in: what the page declares first, then its
// framework state, then the loose JSON of its script tags and attributes.
const SOURCES = ["jsonld", "microdata", "meta", "next", "nuxt", "remix", "apollo", "state", "scripts", "attrs"];

// Keys whose values are credentials a page keeps in its markup or state
// (a meta csrf-token, a CSRF field in __NEXT_DATA__): they stay in the page.
const SECRET = /csrf|xsrf|token|nonce|secret|passw/i;

const MAX_KEYS = 50;

function isEmpty(v: Json | undefined): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "object" && Object.keys(v).length === 0;
}

function hideSecrets(v: Json): Json {
  if (Array.isArray(v)) return v.map(hideSecrets);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? "[hidden]" : hideSecrets(x)]));
}

// The sources the page has, in SOURCES order, with values under
// secret-looking keys hidden; an empty one is left out.
function mergeSources(dom: DomData, page: PageGlobals): Source[] {
  const globals = page.values ?? {};
  const found: Record<string, Json | undefined> = {
    jsonld: dom.jsonld,
    microdata: dom.microdata,
    meta: dom.meta,
    // Next.js reads its own script tag; the global stands in only where a
    // page has removed the tag after starting.
    next: dom.next ?? globals.next,
    // Nuxt 3 keeps its payload in a script tag and only its config in
    // __NUXT__; Nuxt 2 keeps it all in __NUXT__.
    nuxt: dom.nuxt === undefined ? globals.nuxt : unflatten(dom.nuxt),
    remix: globals.remix,
    apollo: globals.apollo,
    state: globals.state,
    scripts: dom.scripts,
    attrs: dom.attrs,
  };
  const tooBig: Record<string, number> = { ...page.tooBig, ...dom.tooBig };
  const sources: Source[] = [];
  for (const name of SOURCES) {
    const raw = found[name];
    const data = raw === undefined ? undefined : hideSecrets(raw);
    if (!isEmpty(data)) sources.push({ name, bytes: Buffer.byteLength(JSON.stringify(data)), data });
    else if (tooBig[name] !== undefined) sources.push({ name, bytes: tooBig[name] });
  }
  return sources;
}

// Nuxt 3's payload is devalue's flat form: a list whose first entry is the
// root, and whose objects and lists hold the indexes of their members. A
// negative index is a value JSON lacks (undefined, a hole, NaN, -0), and a
// list that starts with a name is a typed value: dates, sets, and maps
// come out as JSON, and Nuxt's own wrappers (Ref, Reactive, NuxtError) as
// the value they wrap. A member that holds its own ancestor comes out as
// "[circular]"; an index past the end, as null.
function unflatten(flat: Json): Json | undefined {
  if (!Array.isArray(flat) || flat.length === 0) return undefined;
  const done = new Map<number, Json>();
  const open = new Set<number>();
  const at = (i: Json): Json => {
    if (typeof i !== "number" || !Number.isInteger(i) || i >= flat.length) return null;
    if (i < 0) return i === -6 ? 0 : null;
    const seen = done.get(i);
    if (seen !== undefined) return seen;
    if (open.has(i)) return "[circular]";
    open.add(i);
    const v = expand(flat[i]);
    open.delete(i);
    done.set(i, v);
    return v;
  };
  // [name, a1, b1, a2, b2, ...] as [[a1, b1], [a2, b2], ...]
  const pairs = (list: Json[]): [Json, Json][] => {
    const out: [Json, Json][] = [];
    for (let j = 1; j + 1 < list.length; j += 2) out.push([list[j], list[j + 1]]);
    return out;
  };
  const expand = (v: Json): Json => {
    if (v === null || typeof v !== "object") return v;
    // an undefined member (-1) is one JSON leaves out
    if (!Array.isArray(v)) return Object.fromEntries(Object.entries(v).filter(([, i]) => i !== -1).map(([k, i]) => [k, at(i)]));
    if (typeof v[0] !== "string") return v.map(at);
    switch (v[0]) {
      case "Date":
      case "BigInt":
      case "Object":
        return v[1] ?? null;
      case "RegExp":
        return `/${String(v[1])}/${typeof v[2] === "string" ? v[2] : ""}`;
      case "Set":
        return v.slice(1).map(at);
      case "Map": {
        const entries = pairs(v).map(([k, x]): [Json, Json] => [at(k), at(x)]);
        return entries.every(([k]) => typeof k === "string") ? Object.fromEntries(entries.map(([k, x]) => [String(k), x])) : entries;
      }
      case "null":
        return Object.fromEntries(pairs(v).map(([k, x]) => [String(k), at(x)]));
      default:
        return at(v[1] ?? null);
    }
  };
  return at(0);
}

// A pick path as steps: dotted keys, [n] for a list's item, and ["key"] for
// a key with a dot, bracket, or quote in it.
const STEP = /^(?:([^.[\]"]+)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\])/;

function parsePick(path: string): Step[] {
  const bad = (why: string) => new Error(`pick "${path}": ${why}; a path looks like next.props.items[0].name`);
  const steps: Step[] = [];
  let rest = path;
  for (;;) {
    // a dot comes between two steps, except before a bracket
    if (steps.length && !rest.startsWith("[")) {
      if (!rest.startsWith(".")) throw bad(`cannot read "${rest}"`);
      rest = rest.slice(1);
    }
    const m = STEP.exec(rest);
    if (!m) throw bad(rest ? `cannot read "${rest}"` : steps.length ? "it ends in a dot" : "it is empty");
    steps.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : (JSON.parse(m[3]) as string)));
    rest = rest.slice(m[0].length);
    if (!rest) return steps;
  }
}

const PLAIN = /^[^.[\]"]+$/;

function pathText(steps: Step[]): string {
  return steps.map((s, i) => (typeof s === "number" ? `[${s}]` : PLAIN.test(s) ? `${i ? "." : ""}${s}` : `[${JSON.stringify(s)}]`)).join("");
}

// The member a step names: a list's item by index (as a number or digits),
// an object's key; undefined when there is none.
function member(v: Json, step: Step): { value: Json } | undefined {
  if (Array.isArray(v)) {
    const i = typeof step === "number" ? step : /^\d+$/.test(step) ? Number(step) : -1;
    return i >= 0 && i < v.length ? { value: v[i] } : undefined;
  }
  if (v === null || typeof v !== "object") return undefined;
  const key = String(step);
  return Object.hasOwn(v, key) ? { value: v[key] } : undefined;
}

// What a value holds, for an error that says where a path went wrong.
function contents(v: Json): string {
  if (Array.isArray(v)) return `it is a list of ${v.length}`;
  if (v === null || typeof v !== "object") return `it is ${v === null ? "null" : `a ${typeof v}`}`;
  const keys = Object.keys(v);
  return `its keys: ${keys.slice(0, MAX_KEYS).join(", ")}${keys.length > MAX_KEYS ? `, and ${keys.length - MAX_KEYS} more` : ""}`;
}

// What a value too big to return holds: an object's keys, or a list's length.
function outline(v: Json): { keys?: string[]; length?: number } {
  if (Array.isArray(v)) return { length: v.length };
  if (v === null || typeof v !== "object") return {};
  const keys = Object.keys(v);
  return { keys: keys.length > MAX_KEYS ? [...keys.slice(0, MAX_KEYS), `…${keys.length - MAX_KEYS} more`] : keys };
}

// A path one step below, for a hint: the value's first key, or its first item.
function deeper(steps: Step[], v: Json): string {
  const first = Array.isArray(v) ? (v.length ? 0 : undefined) : v !== null && typeof v === "object" ? Object.keys(v)[0] : undefined;
  return pathText(first === undefined ? steps : [...steps, first]);
}

const TOO_BIG = "was too big to read here; eval with page: true reads part of it";

// The sources as the tool returns them: the smallest first, as many whole
// as fit in max bytes, and the rest by size and top-level keys, with a
// hint to pick. With pick, the part at that path, under the same limit.
function shapeData(sources: Source[], o: { pick?: string; max: number }): Record<string, unknown> {
  if (o.pick !== undefined) return picked(sources, o.pick, o.max);
  if (!sources.length) return { sources: [], note: "the page declares no data of its own; read it with extract or snapshot" };
  let room = o.max;
  const whole = new Set<string>();
  for (const s of [...sources].sort((a, b) => a.bytes - b.bytes)) {
    if (s.data === undefined || s.bytes > room) continue;
    whole.add(s.name);
    room -= s.bytes;
  }
  const left = sources.filter((s) => !whole.has(s.name));
  const hints = left.map((s) => (s.data === undefined ? `${s.name} (${s.bytes} bytes) ${TOO_BIG}` : `${s.name} (${s.bytes} bytes)`));
  const sample = left.find((s) => s.data !== undefined);
  const example = sample?.data === undefined ? "" : `; call again with pick, a path into it such as ${deeper([sample.name], sample.data)}`;
  return {
    sources: sources.map((s) => (whole.has(s.name) ? { name: s.name, bytes: s.bytes } : { name: s.name, bytes: s.bytes, ...(s.data === undefined ? { unread: true } : outline(s.data)) })),
    data: Object.fromEntries(sources.filter((s) => whole.has(s.name)).map((s) => [s.name, s.data])),
    ...(left.length ? { more: `over max ${o.max}: ${hints.join(", ")}${example}` } : {}),
  };
}

function picked(sources: Source[], pick: string, max: number): Record<string, unknown> {
  const [name, ...rest] = parsePick(pick);
  const source = sources.find((s) => s.name === name);
  if (!source) throw new Error(`pick: this page has no ${String(name)} data; it has ${sources.map((s) => s.name).join(", ") || "none"}`);
  if (source.data === undefined) throw new Error(`pick: ${source.name} (${source.bytes} bytes) ${TOO_BIG}`);
  let value = source.data;
  const trail: Step[] = [source.name];
  for (const step of rest) {
    const next = member(value, step);
    if (!next) throw new Error(`pick: ${pathText(trail)} has no ${typeof step === "number" ? `[${step}]` : JSON.stringify(step)}; ${contents(value)}`);
    value = next.value;
    trail.push(step);
  }
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= max) return { pick, bytes, value };
  return { pick, bytes, ...outline(value), more: `over max ${max}: pick deeper, such as ${deeper(trail, value)}` };
}

// The data tool: the page's markup, read by content.js, and its globals,
// read in the page's own world by background.js, both at once.
export async function pageData(tab: number, o: { pick?: string; max?: number }): Promise<Record<string, unknown>> {
  const [dom, globals] = await Promise.all([bridge.tab(tab, "data") as Promise<DomData>, bridge.request("pageData", [tab]) as Promise<PageGlobals>]);
  return { url: dom.url, title: dom.title, ...shapeData(mergeSources(dom, globals), { pick: o.pick, max: o.max ?? 20000 }) };
}
