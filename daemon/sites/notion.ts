// Notion, through the owner's Safari session. The web app, now served from
// app.notion.com, talks to /api/v3 with JSON posts and its session cookie,
// which is HttpOnly and travels with every request the tab sends; with
// several accounts signed in, x-notion-active-user-header picks one.
// Everything here reads: records through syncRecordValues, pages by walking
// their block tree, search through the app's own search.

import { NotSignedIn, type SiteKit } from "./kit.ts";

const SITE = "Notion";
const ORIGIN = "https://app.notion.com";
// The login page is the lightest page of the origin; signed in, Notion sends
// it on to the workspace, heavier but still one background tab.
const TAB_URL = `${ORIGIN}/login`;
const API = `${ORIGIN}/api/v3`;
const PACE_MS = 150;
const BATCH = 100;

type Rec = Record<string, unknown>;
type RecordMap = Record<string, Record<string, unknown>>;
type Pointer = { table: string; id: string };
export type Account = { userId: string; name: string; email: string; spaces: { id: string; name: string; domain: string }[] };

async function post<T>(kit: SiteKit, endpoint: string, body: unknown, userId?: string): Promise<T> {
  await kit.tab(ORIGIN, TAB_URL);
  await kit.pace("notion", PACE_MS);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (userId) headers["x-notion-active-user-header"] = userId;
  return kit.json<T>(ORIGIN, `${API}/${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) }, SITE);
}

// A record of a record map: { role, value: {...} }, or in the newer shape
// { value: { role, value: {...} } }.
function record(map: RecordMap | undefined, table: string, id: string): Rec | null {
  const wrapper = map?.[table]?.[id];
  if (!wrapper || typeof wrapper !== "object") return null;
  const v = (wrapper as Rec).value;
  if (!v || typeof v !== "object") return null;
  const inner = (v as Rec).value;
  return inner && typeof inner === "object" && !("id" in (v as Rec)) ? (inner as Rec) : (v as Rec);
}

async function records(kit: SiteKit, userId: string, pointers: Pointer[]): Promise<RecordMap> {
  const r = await post<{ recordMap?: RecordMap }>(kit, "syncRecordValues", { requests: pointers.map((pointer) => ({ pointer, version: -1 })) }, userId);
  return r.recordMap ?? {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function iso(v: unknown): string {
  return typeof v === "number" ? new Date(v).toISOString() : "";
}

// A page or block id from a share link, a 32-character id, or a uuid.
export function uuid(input: string): string {
  let raw = input.trim();
  if (/^https?:\/\//.test(raw)) {
    const u = new URL(raw);
    raw = u.searchParams.get("p") ?? u.pathname.match(/[0-9a-f]{32}/gi)?.pop() ?? u.pathname;
  }
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`"${input}" is not a Notion page or block id`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pageUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

// ---------- rich text ----------
// Notion text is a list of [text, [decorations]] segments; a decoration is
// [kind, argument]: b, i, s, c for style, a for a link, e an equation, p a
// page mention, u a user mention, d a date.

function dateText(d: Rec): string {
  const start = `${str(d.start_date)}${d.start_time ? ` ${str(d.start_time)}` : ""}`;
  return d.end_date ? `${start} → ${str(d.end_date)}${d.end_time ? ` ${str(d.end_time)}` : ""}` : start;
}

function richText(v: unknown, markdown: boolean): string {
  if (!Array.isArray(v)) return "";
  return v.map((seg) => {
    if (!Array.isArray(seg)) return "";
    let text = str(seg[0]);
    const decorations: unknown[] = Array.isArray(seg[1]) ? seg[1] : [];
    for (const d of decorations) {
      if (!Array.isArray(d)) continue;
      const [kind, arg] = d as [unknown, unknown];
      if (kind === "p" && typeof arg === "string") text = markdown ? `[page](${pageUrl(arg)})` : pageUrl(arg);
      else if (kind === "u" && typeof arg === "string") text = `@${arg}`;
      else if (kind === "d" && arg && typeof arg === "object") text = dateText(arg as Rec);
      else if (kind === "e" && typeof arg === "string") text = markdown ? `$${arg}$` : arg;
      else if (!markdown) continue;
      else if (kind === "b") text = `**${text}**`;
      else if (kind === "i") text = `*${text}*`;
      else if (kind === "s") text = `~~${text}~~`;
      else if (kind === "c") text = `\`${text}\``;
      else if (kind === "a" && typeof arg === "string") text = `[${text}](${arg})`;
    }
    return text;
  }).join("");
}

function props(b: Rec): Rec {
  return b.properties && typeof b.properties === "object" ? (b.properties as Rec) : {};
}

function format(b: Rec): Rec {
  return b.format && typeof b.format === "object" ? (b.format as Rec) : {};
}

// A page's properties by name: database rows key them by the ids of the
// parent collection's schema.
function propertiesOf(b: Rec, schema: Rec | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props(b))) {
    if (key === "title") continue;
    const column = schema?.[key];
    const name = column && typeof column === "object" ? str((column as Rec).name) || key : key;
    out[name] = richText(value, false);
  }
  return out;
}

function summary(b: Rec) {
  const id = str(b.id);
  const f = format(b);
  return {
    id,
    type: str(b.type),
    title: richText(props(b).title, false),
    ...(b.type === "to_do" ? { checked: richText(props(b).checked, false) === "Yes" } : {}),
    ...(b.type === "code" ? { language: richText(props(b).language, false) } : {}),
    ...(f.page_icon ? { icon: str(f.page_icon) } : {}),
    parent: { table: str(b.parent_table), id: str(b.parent_id) },
    spaceId: str(b.space_id),
    childIds: ids(b.content),
    createdTime: iso(b.created_time),
    lastEditedTime: iso(b.last_edited_time),
    url: pageUrl(id),
  };
}

// ---------- block tree to Markdown ----------

type Tree = { blocks: Map<string, Rec>; collections: Map<string, string>; truncated: boolean };

// The block and its descendants, a level per request, up to max blocks;
// database blocks also get their collection's name.
async function loadTree(kit: SiteKit, userId: string, rootId: string, max: number): Promise<Tree> {
  const blocks = new Map<string, Rec>();
  let wanted = [rootId];
  while (wanted.length && blocks.size < max) {
    const batch = wanted.slice(0, Math.min(BATCH, max - blocks.size));
    wanted = wanted.slice(batch.length);
    const map = await records(kit, userId, batch.map((id) => ({ table: "block", id })));
    for (const id of batch) {
      const b = record(map, "block", id);
      if (!b) continue;
      blocks.set(id, b);
      for (const child of ids(b.content)) if (!blocks.has(child)) wanted.push(child);
    }
  }
  const collectionIds = [...new Set([...blocks.values()].map((b) => str(b.collection_id)).filter(Boolean))];
  const collections = new Map<string, string>();
  if (collectionIds.length) {
    const map = await records(kit, userId, collectionIds.map((id) => ({ table: "collection", id })));
    for (const id of collectionIds) collections.set(id, richText(record(map, "collection", id)?.name, false));
  }
  return { blocks, collections, truncated: wanted.length > 0 };
}

const HEADINGS: Record<string, string> = { header: "# ", sub_header: "## ", sub_sub_header: "### " };
// Blocks that only hold other blocks.
const CONTAINERS: Record<string, true> = { column_list: true, column: true, synced_block: true, transclusion_container: true, table_of_contents: true, breadcrumb: true };

function tableLines(b: Rec, tree: Tree): string[] {
  const f = format(b);
  const columns = ids(f.table_block_column_order);
  const rows = ids(b.content).map((id) => tree.blocks.get(id)).filter((r): r is Rec => !!r);
  const cells = rows.map((r) => columns.map((c) => richText(props(r)[c], true).replace(/\|/g, "\\|")));
  if (!cells.length) return [];
  const header = f.table_block_column_header ? cells.shift() ?? [] : columns.map(() => "");
  return [`| ${header.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...cells.map((row) => `| ${row.join(" | ")} |`)];
}

function blockLines(id: string, tree: Tree, depth: number, root: boolean, number: number): string[] {
  const b = tree.blocks.get(id);
  // Past the block limit, children are simply missing; otherwise a missing
  // block is one this account cannot read.
  if (!b) return tree.truncated ? [] : [`(block ${id} is not readable)`];
  const type = str(b.type);
  const p = props(b);
  const f = format(b);
  const title = richText(p.title, true);
  const indent = "  ".repeat(depth);
  const children = ids(b.content);
  const list = type === "bulleted_list" || type === "numbered_list" || type === "to_do" || type === "toggle";
  let own: string[] = [];
  if (type === "page" || type === "collection_view_page") {
    if (!root) return [`${indent}[${title || tree.collections.get(str(b.collection_id)) || "untitled"}](${pageUrl(id)})`];
    own = [`# ${title || tree.collections.get(str(b.collection_id)) || "Untitled"}`, ""];
  } else if (type === "collection_view") return [`${indent}(database: ${tree.collections.get(str(b.collection_id)) || id})`];
  else if (type === "alias") {
    const target = f.alias_pointer && typeof f.alias_pointer === "object" ? str((f.alias_pointer as Rec).id) : "";
    return [`${indent}[page](${pageUrl(target || id)})`];
  } else if (CONTAINERS[type]) own = [];
  else if (type === "table") own = tableLines(b, tree).map((l) => indent + l);
  else if (HEADINGS[type]) own = [`${indent}${HEADINGS[type]}${title}`];
  else if (type === "bulleted_list" || type === "toggle") own = [`${indent}- ${title}`];
  else if (type === "numbered_list") own = [`${indent}${number}. ${title}`];
  else if (type === "to_do") own = [`${indent}- [${richText(p.checked, false) === "Yes" ? "x" : " "}] ${title}`];
  else if (type === "quote") own = [`${indent}> ${title}`];
  else if (type === "callout") own = [`${indent}> ${f.page_icon ? `${str(f.page_icon)} ` : ""}${title}`];
  else if (type === "code") own = [`${indent}\`\`\`${richText(p.language, false).toLowerCase()}`, ...richText(p.title, false).split("\n").map((l) => indent + l), `${indent}\`\`\``];
  else if (type === "divider") own = [`${indent}---`];
  else if (type === "equation") own = [`${indent}$$${richText(p.title, false)}$$`];
  else if (type === "image") own = [`${indent}![${richText(p.caption, false)}](${str(f.display_source) || richText(p.source, false)})`];
  else if (type === "bookmark" || type === "embed" || type === "video" || type === "audio" || type === "file" || type === "pdf") {
    const link = richText(p.link, false) || richText(p.source, false) || str(f.display_source);
    own = [`${indent}[${title || richText(p.caption, false) || type}](${link})`];
  } else if (type === "table_row") return [];
  else own = title ? [`${indent}${title}`] : [];
  if (type === "table") return own;
  let n = 0;
  const nested = children.flatMap((child) => {
    n = tree.blocks.get(child)?.type === "numbered_list" ? n + 1 : 0;
    return blockLines(child, tree, list ? depth + 1 : depth, false, n);
  });
  return [...own, ...nested];
}

function render(tree: Tree, rootId: string): string {
  const lines = blockLines(rootId, tree, 0, true, 0);
  if (tree.truncated) lines.push("", `(stopped: more blocks than the limit)`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- search ----------

type SearchHit = { id: string; highlight?: { text?: string; pathText?: string } };

const SEARCH_FILTERS = { isDeletedOnly: false, excludeTemplates: false, navigableBlockContentOnly: true, requireEditPermissions: false, ancestors: [], createdBy: [], editedBy: [], lastEditedTime: {}, createdTime: {}, inTeams: [] };

// ---------- client ----------

function client(kit: SiteKit, account: Account) {
  const userId = account.userId;
  return {
    account,

    // Pages and databases matching query in the account's spaces, or in one.
    async search(query: string, opts: { limit?: number; spaceId?: string } = {}) {
      const spaces = opts.spaceId ? account.spaces.filter((s) => s.id === opts.spaceId) : account.spaces;
      if (!spaces.length) throw new Error(`no space "${opts.spaceId}" in this account; listAccounts() names them`);
      const limit = Math.min(Math.max(Number(opts.limit ?? 20), 1), 100);
      const results = [];
      for (const space of spaces) {
        const r = await post<{ results?: SearchHit[]; recordMap?: RecordMap; total?: number }>(kit, "search", { type: "BlocksInSpace", query, spaceId: space.id, limit, filters: SEARCH_FILTERS, sort: { field: "relevance" }, source: "quick_find" }, userId);
        for (const hit of r.results ?? []) {
          const b = record(r.recordMap, "block", hit.id);
          results.push({
            id: hit.id,
            title: b ? richText(props(b).title, false) : "",
            type: str(b?.type),
            space: space.name,
            spaceId: space.id,
            ...(hit.highlight?.pathText ? { path: hit.highlight.pathText } : {}),
            ...(hit.highlight?.text ? { snippet: hit.highlight.text.replace(/<\/?[a-zA-Z]+>/g, "") } : {}),
            lastEditedTime: iso(b?.last_edited_time),
            url: pageUrl(hit.id),
          });
        }
      }
      return results;
    },

    // A page's title, properties, and child block ids.
    async getPage(pageId: string) {
      const id = uuid(pageId);
      const b = record(await records(kit, userId, [{ table: "block", id }]), "block", id);
      if (!b) throw new Error(`Notion has no page ${id} that this account can read`);
      let schema: Rec | null = null;
      if (b.parent_table === "collection" && typeof b.parent_id === "string") {
        const collection = record(await records(kit, userId, [{ table: "collection", id: b.parent_id }]), "collection", b.parent_id);
        schema = collection?.schema && typeof collection.schema === "object" ? (collection.schema as Rec) : null;
      }
      return { ...summary(b), properties: propertiesOf(b, schema) };
    },

    async getBlock(blockId: string) {
      const id = uuid(blockId);
      const b = record(await records(kit, userId, [{ table: "block", id }]), "block", id);
      if (!b) throw new Error(`Notion has no block ${id} that this account can read`);
      return summary(b);
    },

    // The block and everything under it as Markdown, up to maxBlocks blocks.
    async blockToMarkdown(blockId: string, opts: { maxBlocks?: number } = {}) {
      const id = uuid(blockId);
      const max = Math.min(Math.max(Number(opts.maxBlocks ?? 500), 1), 5000);
      const tree = await loadTree(kit, userId, id, max);
      if (!tree.blocks.has(id)) throw new Error(`Notion has no block ${id} that this account can read`);
      return render(tree, id);
    },
  };
}

// The accounts signed in, each with its spaces: getSpaces answers per user.
async function accounts(kit: SiteKit): Promise<Account[]> {
  const spaces = await post<Record<string, RecordMap>>(kit, "getSpaces", {});
  const out: Account[] = [];
  for (const [userId, map] of Object.entries(spaces)) {
    const u = record(map, "notion_user", userId);
    out.push({
      userId,
      name: str(u?.name) || [str(u?.given_name), str(u?.family_name)].filter(Boolean).join(" "),
      email: str(u?.email),
      spaces: Object.keys(map.space ?? {}).map((id) => {
        const s = record(map, "space", id);
        return { id, name: str(s?.name), domain: str(s?.domain) };
      }),
    });
  }
  if (!out.length) throw new NotSignedIn(SITE, "no account");
  return out;
}

export function notion(kit: SiteKit) {
  return {
    listAccounts: () => accounts(kit),

    // userId may also be the account's email; without it, the first account.
    async getClient(userId?: string) {
      const all = await accounts(kit);
      const account = userId ? all.find((a) => a.userId === userId || a.email === userId) : all[0];
      if (!account) throw new Error(`no Notion account "${userId}" in Safari; listAccounts() has ${all.map((a) => `${a.email} (${a.userId})`).join(", ")}`);
      return client(kit, account);
    },
  };
}
