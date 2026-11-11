import { chmodSync, closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { dataFile, readJson, writeJson } from "./phone.ts";
import { gateOfStep, playbookUrl, publicLabel } from "./recordings.ts";
import { rpc } from "./rpc.ts";
import type { Tool } from "./tools.ts";

type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
type FieldType = "array" | "object" | "string" | "number" | "boolean";
type Check = { field: string; type: FieldType };
type Shape = { format: "json"; root: "array" | "object"; fieldType: FieldType; nonempty: true };
type Context = { tab: number; url: string; ready: "complete"; timeOrigin: number };
type Observation = { source: "net"; kind: "fetch" | "xhr"; tab: number; at: number; status: number };
type Entry = { name: string; origin: string; path: string; method: "GET"; observation: Observation; check: Check; shape: Shape; verifiedAt: number; status: number; contentType: string };
type Catalog = { version: 1; entries: Entry[] };
type CheckedJson = { shape: Shape; value: unknown };
const MAX_ENTRIES = 50;
const MAX_BYTES = 128_000;
const MAX_RESPONSE = 90_000;
const TYPES: readonly FieldType[] = ["array", "object", "string", "number", "boolean"];
const fields = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const CATALOG_PATH = dataFile("request-catalog/catalog.json");

function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nameOf(value: unknown): string {
  const name = publicLabel(value);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error("name must be a short public lowercase name, using letters, numbers, and hyphens");
  return name;
}

function checkOf(value: unknown): Check {
  const check = fields(value);
  if (!only(check, ["field", "type"]) || typeof check.type !== "string" || !TYPES.includes(check.type as FieldType)) throw new Error("check needs a field and type: array, object, string, number, or boolean");
  const field = publicLabel(check.field);
  const parts = field.split(".");
  if (parts.length > 8 || !parts.every((part) => /^(?:[a-zA-Z_][\w-]{0,63}|0|[1-9]\d{0,5})$/.test(part))
    || /^(?:ok|status|success|message|error|errors|code|loading)$/i.test(field)
    || parts.some((part) => /^(?:authorization|cookies?|tokens?|passwords?|secrets?|credentials?)$/i.test(part))) throw new Error("field must name meaningful public JSON structure, not a generic status, a credential, or a value");
  return { field, type: check.type as FieldType };
}

export function endpointOf(value: unknown): string {
  const url = playbookUrl(value);
  if (value !== url || url.length > 500) throw new Error("the observed endpoint must be an exact public path without a query, fragment, credentials, or a shortened URL");
  const gate = gateOfStep({ kind: "navigate", url });
  if ((gate !== undefined && gate !== "account settings") || /\/(?:log[-_]?out|sign[-_]?out)(?:\/|$)/i.test(new URL(url).pathname)) throw new Error("this endpoint may sign in or change the account; use the normal authorized browser flow instead");
  return url;
}

function statusOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 200 || value > 299) throw new Error("the response needs a verified successful HTTP status");
  return value;
}

function atOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > Date.now()) throw new Error("the observation needs its original bounded timestamp");
  return value;
}

function contentTypeOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("the live response did not identify its content type");
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  if (type.length > 128 || !/^(?:application\/(?:[a-z0-9!#$&^_.+-]+\+)?json|text\/json)$/.test(type)) throw new Error("the live response is not JSON; a sign-in, challenge, or JavaScript shell is not a catalog result");
  return type;
}

function checkedJson(text: unknown, check: Check): CheckedJson {
  if (typeof text !== "string" || !text || text.length > MAX_RESPONSE) throw new Error("the response needs a complete, bounded JSON body");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("the response is not complete JSON"); }
  if (parsed === null || typeof parsed !== "object") throw new Error("the response must be a JSON object or array");
  const root = Array.isArray(parsed) ? "array" : "object";
  const envelope = fields(parsed);
  if (envelope.ok === false || envelope.success === false || envelope.authenticated === false || envelope.authorized === false
    || envelope.requiresLogin === true || envelope.loading === true || (envelope.error !== undefined && envelope.error !== null && envelope.error !== false && envelope.error !== "")
    || (Array.isArray(envelope.errors) && envelope.errors.length > 0)) throw new Error("the JSON response reports an error, sign-in requirement, or loading state");
  let value: unknown = parsed;
  for (const part of check.field.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)
      || (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(part))) throw new Error("the original response field is missing");
    value = (value as Record<string, unknown>)[part];
  }
  const type = Array.isArray(value) ? "array" : value !== null && typeof value === "object" ? "object" : typeof value;
  if (value === null || type !== check.type) throw new Error("the original response field changed type");
  if ((typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0)
    || (type === "object" && Object.keys(fields(value)).length === 0) || (typeof value === "number" && !Number.isFinite(value))
    || value === false) throw new Error("the original response field is empty or false");
  return { shape: { format: "json", root, fieldType: check.type, nonempty: true }, value };
}

async function contextOf(tab: unknown, call: Call): Promise<Context> {
  if (!Number.isSafeInteger(tab) || Number(tab) <= 0 || process.env.SAFARI_HARNESS_REMOTE) throw new Error("request catalog reads need one local numeric tab owned by this agent, never front");
  const context = fields(await call("request_catalog_context", { tab }));
  if (!Number.isSafeInteger(context.tab) || Number(context.tab) <= 0
    || typeof context.url !== "string" || !URL.canParse(context.url)
    || context.ready !== "complete" || typeof context.timeOrigin !== "number" || !Number.isFinite(context.timeOrigin)
    || context.timeOrigin <= 0 || context.timeOrigin > Date.now()) throw new Error("the owned tab did not provide a complete, identifiable document");
  const url = new URL(context.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("the owned tab needs an ordinary site page without URL credentials");
  return { tab: Number(context.tab), url: context.url, ready: "complete", timeOrigin: context.timeOrigin };
}

async function unchanged(context: Context, call: Call): Promise<void> {
  const now = await contextOf(context.tab, call);
  if (now.url !== context.url || now.timeOrigin !== context.timeOrigin || now.ready !== context.ready) throw new Error("the owned tab changed document during the check; no catalog result was accepted");
}

function readCatalog(): Catalog {
  const path = CATALOG_PATH;
  try { if (statSync(path).size > MAX_BYTES) throw new Error("the private request catalog exceeds its size limit"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, entries: [] }; throw error; }
  const catalog = fields(readJson(path));
  if (!only(catalog, ["version", "entries"]) || catalog.version !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length > MAX_ENTRIES) throw new Error("the private request catalog is invalid");
  const names = new Set<string>();
  const endpoints = new Set<string>();
  const entries = catalog.entries.map((value: unknown): Entry => {
    const entry = fields(value);
    const observation = fields(entry.observation);
    const shape = fields(entry.shape);
    if (!only(entry, ["name", "origin", "path", "method", "observation", "check", "shape", "verifiedAt", "status", "contentType"])
      || !only(observation, ["source", "kind", "tab", "at", "status"])
      || !only(shape, ["format", "root", "fieldType", "nonempty"]) || entry.method !== "GET"
      || typeof entry.origin !== "string" || typeof entry.path !== "string"
      || observation.source !== "net" || (observation.kind !== "fetch" && observation.kind !== "xhr")
      || !Number.isSafeInteger(observation.tab) || Number(observation.tab) <= 0
      || shape.format !== "json" || (shape.root !== "array" && shape.root !== "object") || shape.nonempty !== true) throw new Error("the private request catalog contains an unchecked record");
    const name = nameOf(entry.name);
    const url = endpointOf(entry.origin + entry.path);
    const parsed = new URL(url);
    const check = checkOf(entry.check);
    const at = atOf(observation.at);
    const verifiedAt = atOf(entry.verifiedAt);
    const status = statusOf(entry.status);
    const contentType = contentTypeOf(entry.contentType);
    if (names.has(name) || endpoints.has(url) || parsed.origin !== entry.origin || parsed.pathname !== entry.path || statusOf(observation.status) !== status
      || verifiedAt < at || shape.fieldType !== check.type || contentType !== entry.contentType) throw new Error("the private request catalog contains an ambiguous or changed record");
    names.add(name);
    endpoints.add(url);
    return { name, origin: parsed.origin, path: parsed.pathname, method: "GET", observation: { source: "net", kind: observation.kind, tab: Number(observation.tab), at, status }, check,
      shape: { format: "json", root: shape.root, fieldType: check.type, nonempty: true }, verifiedAt, status, contentType };
  });
  return { version: 1, entries };
}

function changeCatalog<T>(run: (catalog: Catalog) => T): T {
  const path = CATALOG_PATH;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  let lock: number;
  try { lock = openSync(`${path}.lock`, "wx", 0o600); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("another request catalog change is active; finish it before trying again"); throw error; }
  try {
    const catalog = readCatalog();
    const result = run(catalog);
    if (catalog.entries.length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(catalog), "utf8") > MAX_BYTES) throw new Error("the private request catalog is full; forget an old entry before saving another");
    writeJson(path, catalog, 0o600);
    return result;
  } finally {
    closeSync(lock);
    unlinkSync(`${path}.lock`);
  }
}

async function live(entry: Pick<Entry, "origin" | "path" | "status" | "contentType" | "check" | "shape">, context: Context, call: Call) {
  const requestedUrl = entry.origin + entry.path;
  if (new URL(context.url).origin !== entry.origin) throw new Error("run only in an owned tab on this record's exact origin");
  await unchanged(context, call);
  const response = fields(await call("authenticated_read", { tab: context.tab, url: requestedUrl, format: "json", maxBytes: MAX_RESPONSE }));
  await unchanged(context, call);
  const summary = {
    requestedUrl,
    ...(typeof response.url === "string" ? { url: response.url } : {}),
    ...(typeof response.source === "string" ? { source: response.source } : {}),
    ...(typeof response.status === "number" ? { status: response.status } : {}),
    ...(typeof response.type === "string" ? { type: response.type } : {}),
    statusValidated: false,
    check: { ...entry.check, passed: false },
  };
  try {
    if (response.ok !== true || response.source !== "page" || response.tab !== context.tab || response.format !== "json"
      || response.requestedUrl !== requestedUrl || response.url !== requestedUrl || response.truncated !== false) throw new Error("the live read failed, was truncated, changed endpoint, or did not come from this owned page");
    const status = statusOf(response.status);
    if (status !== entry.status) throw new Error("the original successful HTTP status changed");
    const contentType = contentTypeOf(response.type);
    if (entry.contentType !== "" && entry.contentType !== contentType) throw new Error("the original JSON content type changed");
    const checked = checkedJson(response.content, entry.check);
    if (checked.shape.root !== entry.shape.root) throw new Error("the original JSON root shape changed");
    return { ok: true as const, ...summary, source: "page" as const, status, contentType, statusValidated: true, shape: checked.shape, check: { ...entry.check, passed: true }, value: checked.value, verifiedAt: Date.now() };
  } catch (error) {
    return { ok: false as const, ...summary, reason: error instanceof Error ? error.message : "the original response check failed" };
  }
}

// Folded the same way on both sides of a comparison: lower case, each run of
// white space one space.
const folded = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

// A JSON string as a text a page shows and few pages share by chance: 8 to
// 300 characters, or from 4 with a space, digit, dot, dash, or underscore
// in it, and not an address. Numbers are left out: counts and times match
// any page.
function textOf(value: string): string | undefined {
  const text = folded(value).trim();
  return text.length <= 300 && (text.length >= 8 || (text.length >= 4 && /[\s\d._-]/.test(text)))
    && !/^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/.test(text) ? text : undefined;
}

function textsOf(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const text = textOf(value);
    if (text !== undefined) into.add(text);
  } else if (value !== null && typeof value === "object") for (const child of Object.values(value)) textsOf(child, into);
  return into;
}

// Where each word of a folded text starts, so a text is looked for only
// where its rarest word is: on 11-11 matching 12 bodies of 89 KB (63,012
// strings) against a 300,000-character page by reading the page for each
// string took 544 ms of the daemon's one thread.
function wordsAt(page: string): Map<string, number[]> {
  const at = new Map<string, number[]>();
  for (const { 0: word, index } of page.matchAll(/[\p{L}\p{N}]+/gu)) {
    const starts = at.get(word);
    if (starts) starts.push(index);
    else at.set(word, [index]);
  }
  return at;
}

// Whether the page has text as words of its own: text there with no letter
// or digit on either side, so each of text's words is a word of the page.
function onPage(page: string, words: Map<string, number[]>, text: string): boolean {
  let rarest: { starts: number[]; offset: number } | undefined;
  for (const { 0: word, index } of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const starts = words.get(word);
    if (!starts) return false;
    if (!rarest || starts.length < rarest.starts.length) rarest = { starts, offset: index };
  }
  if (!rarest) return false;
  for (const start of rarest.starts) {
    const at = start - rarest.offset;
    if (at >= 0 && page.startsWith(text, at) && !/[\p{L}\p{N}]/u.test(page[at - 1] ?? " ") && !/[\p{L}\p{N}]/u.test(page[at + text.length] ?? " ")) return true;
  }
  return false;
}

export type ShownFields = (body: string) => { field: string; type: "array" | "object"; shown: number; chars: number }[];

// The fields of a page's own JSON response that hold what the page shows:
// each object and array below the root that save would accept as a field
// (no index in its path, no key with a dot, which a path cannot name), with
// how many of its texts the page's text has as words of its own and its
// length as JSON, most texts first, and of two that hold as many the deeper.
// A root array has no field that holds every row, so it gives none. The
// page is read once for all the bodies looked at against it.
export function fieldsShownOn(page: string): ShownFields {
  const text = folded(page);
  const words = wordsAt(text);
  const shows = new Map<string, boolean>();
  return (body) => {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return []; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const found: { field: string; type: "array" | "object"; shown: number; chars: number; depth: number }[] = [];
    const walk = (value: unknown, path: string[]): Set<string> => {
      if (typeof value === "string") {
        const t = textOf(value);
        if (t === undefined) return new Set();
        let shown = shows.get(t);
        if (shown === undefined) shows.set(t, (shown = onPage(text, words, t)));
        return shown ? new Set([t]) : new Set();
      }
      if (value === null || typeof value !== "object") return new Set();
      const shown = new Set<string>();
      for (const [key, child] of Object.entries(value)) for (const t of walk(child, [...path, key])) shown.add(t);
      if (shown.size > 0 && path.length > 0 && !path.some((part) => /^\d+$/.test(part) || part.includes("."))) {
        const type = Array.isArray(value) ? "array" : "object";
        try { found.push({ ...checkOf({ field: path.join("."), type }), type, shown: shown.size, chars: JSON.stringify(value).length, depth: path.length }); } catch { /* not a field save accepts */ }
      }
      return shown;
    };
    walk(parsed, []);
    return found.sort((a, b) => b.shown - a.shown || b.depth - a.depth).map(({ field, type, shown, chars }) => ({ field, type, shown, chars }));
  };
}

// The name of the saved request to url's exact endpoint, if one is saved.
export function savedAs(url: string): string | undefined {
  const { origin, pathname } = new URL(url);
  return readCatalog().entries.find((entry) => entry.origin === origin && entry.path === pathname)?.name;
}

// A name for a request to path that no saved one has: the last words of its
// path, 24 characters at most, without the ids (a word with a digit).
// /octo/repo/pull/7/page_data/status_checks gives page-data-status-checks.
function nameFor(path: string, entries: Entry[]): string {
  let base = "";
  for (const word of path.toLowerCase().replace(/\.json$/, "").split(/[^a-z0-9]+/).filter((w) => /^[a-z]+$/.test(w)).reverse()) {
    const longer = base ? `${word}-${base}` : word;
    if (longer.length > 24) break;
    base = longer;
  }
  base ||= "page-data";
  let name = base;
  for (let n = 2; entries.some((entry) => entry.name === name); n++) name = `${base}-${n}`;
  return name;
}

function observedArgs(args: Record<string, unknown>): { check: Check; request: number; at: number } {
  const check = checkOf({ field: args.field, type: args.type });
  if (!Number.isSafeInteger(args.request) || Number(args.request) < 0) throw new Error("request must be the exact nonnegative index from net read");
  return { check, request: Number(args.request), at: atOf(args.observedAt) };
}

// The observation save and try start from: the owned page's own top-document
// GET at that index and time, whole, and its field under check.
async function observed(request: number, at: number, check: Check, context: Context, call: Call) {
  if (at < context.timeOrigin) throw new Error("the selected observation predates this document");
  const captured = fields(await call("net", { tab: context.tab, do: "read" }));
  if (!Array.isArray(captured.entries)) throw new Error("the owned page did not return its observed requests");
  const seen = fields(captured.entries[request]);
  if (seen.t !== at || seen.method !== "GET" || (seen.kind !== "fetch" && seen.kind !== "xhr")
    || (seen.frame !== undefined && seen.frame !== 0) || seen.error !== undefined) throw new Error("the exact successful top-document GET observation is missing or changed");
  const requestedUrl = endpointOf(seen.url);
  const url = new URL(requestedUrl);
  if (url.origin !== new URL(context.url).origin) throw new Error("the observed request is not on this owned tab's exact origin");
  const status = statusOf(seen.status);
  const matches = captured.entries.filter((candidate: unknown) => {
    const entry = fields(candidate);
    return entry.url === seen.url && entry.t === at && (entry.frame ?? 0) === 0;
  });
  if (matches.length !== 1) throw new Error("this observation is ambiguous; capture a new uniquely identified response");
  const body = fields(await call("net", { tab: context.tab, do: "read", body: request }));
  if (body.url !== requestedUrl || body.t !== at || body.method !== "GET" || body.kind !== seen.kind
    || body.status !== status || (body.frame !== undefined && body.frame !== 0) || body.note !== undefined || body.error !== undefined) throw new Error("the observed body is missing, incomplete, ambiguous, or belongs to a different request");
  return { url, status, kind: seen.kind, original: checkedJson(body.text, check) };
}

// try runs an observed request once as save would, and saves nothing: its
// answer is the live value, whether it has every text the page got, and the
// one call that saves it (or runs the saved one).
async function tried(args: Record<string, unknown>, call: Call) {
  const { check, request, at } = observedArgs(args);
  const context = await contextOf(args.tab, call);
  const { url, status, original } = await observed(request, at, check, context, call);
  const result = await live({ origin: url.origin, path: url.pathname, status, contentType: "", check, shape: original.shape }, context, call);
  if (!result.ok) return result;
  const before = textsOf(original.value);
  const after = textsOf(result.value);
  const kept = [...before].filter((text) => after.has(text)).length;
  const same = before.size > 0 ? kept === before.size : JSON.stringify(result.value) === JSON.stringify(original.value);
  const { entries } = readCatalog();
  const saved = entries.find((entry) => entry.origin === url.origin && entry.path === url.pathname);
  const step = (to: Record<string, unknown>) => `run ${JSON.stringify({ steps: [{ tool: "request_catalog", args: to }] })}`;
  const next = saved ? `already saved as ${saved.name}; ${step({ do: "run", tab: context.tab, name: saved.name })} reads it again`
    : `${same ? "the live read has the data the page got" : `the live read kept ${kept} of the ${before.size} texts the page got (data that changes between loads differs)`}; one call saves it: ${step({ do: "save", tab: context.tab, name: nameFor(url.pathname, entries), request, observedAt: at, field: check.field, type: check.type })}`;
  return { ...result, same, next };
}

export async function requestCatalogTool(args: Record<string, unknown>, call: Call = rpc): Promise<unknown> {
  const action = args.do ?? "list";
  const observing = ["do", "tab", "request", "observedAt", "field", "type"];
  const allowed = action === "save" ? [...observing, "name"] : action === "try" ? observing
    : action === "run" ? ["do", "name", "tab"] : action === "forget" ? ["do", "name"] : ["do"];
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("this catalog operation cannot accept a new URL, method, credentials, script, or response check");
  if (action === "list") return { entries: readCatalog().entries, limit: MAX_ENTRIES, private: true };
  if (action === "forget") {
    const name = nameOf(args.name);
    return changeCatalog((catalog) => {
      const index = catalog.entries.findIndex((entry) => entry.name === name);
      if (index < 0) throw new Error("no checked request has this exact name");
      catalog.entries.splice(index, 1);
      return { ok: true, forgotten: name };
    });
  }
  if (action === "run") {
    const name = nameOf(args.name);
    const entry = readCatalog().entries.find((candidate) => candidate.name === name);
    if (!entry) throw new Error("no checked request has this exact name; save it from a real observation first");
    const context = await contextOf(args.tab, call);
    return { name, observation: entry.observation, ...await live(entry, context, call) };
  }
  if (action === "try") return tried(args, call);
  if (action !== "save") throw new Error("do must be save, try, list, run, or forget");
  const name = nameOf(args.name);
  const { check, request, at } = observedArgs(args);
  const context = await contextOf(args.tab, call);
  const { url, status, kind, original } = await observed(request, at, check, context, call);
  const result = await live({ origin: url.origin, path: url.pathname, status, contentType: "", check, shape: original.shape }, context, call);
  if (!result.ok) return { name, saved: false, ...result };
  await unchanged(context, call);
  const entry: Entry = { name, origin: url.origin, path: url.pathname, method: "GET", observation: { source: "net", kind, tab: context.tab, at, status }, check,
    shape: result.shape, verifiedAt: result.verifiedAt, status: result.status, contentType: result.contentType };
  changeCatalog((catalog) => {
    if (catalog.entries.some((candidate) => candidate.name === name)) throw new Error("this name is already checked; forget it explicitly before replacing it");
    if (catalog.entries.some((candidate) => candidate.origin === entry.origin && candidate.path === entry.path)) throw new Error("this exact endpoint is already checked under another name");
    catalog.entries.push(entry);
  });
  return { name, saved: true, observation: entry.observation, ...result };
}

export const REQUEST_CATALOG_TOOLS: Record<string, Tool> = {
  request_catalog: {
    desc: "Save and rerun a private checked JSON GET from your owned tab's observed traffic. Never grants permission for an account action. Save needs an exact net index/timestamp and a meaningful nonempty field/type check; try checks the same once without saving and answers the save call; run needs its exact name and an owned same-origin tab.",
    params: {
      do: { type: "string", enum: ["save", "try", "list", "run", "forget"], description: "default list" },
      tab: { type: "number", description: "local owned numeric tab; required for save, try and run" },
      name: { type: "string", description: "exact short public lowercase name; required for save, run and forget" },
      request: { type: "number", description: "save, try: exact nonnegative index in the unfiltered net read entries" },
      observedAt: { type: "number", description: "save, try: t from that exact observed request" },
      field: { type: "string", description: "save, try: public JSON field path, e.g. data.orders; array indices allowed" },
      type: { type: "string", enum: [...TYPES], description: "save, try: field type; containers/strings must be nonempty and booleans true" },
    },
    hidden: true,
    run: (args) => requestCatalogTool(args),
  },
};
