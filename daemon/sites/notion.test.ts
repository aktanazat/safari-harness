import { expect, test } from "bun:test";
import type { Invoke } from "../call.ts";
import { PACE_TOOL } from "../pace.ts";
import { SiteKit } from "./kit.ts";
import { notion } from "./notion.ts";

// Safari as the notion global sees it: app.notion.com's /api/v3 answers
// each endpoint from answers, given the body the page would post. Records
// come in the shape Notion sends them, { spaceId, value: { value, role } }.
type Rec = Record<string, unknown>;

const USER = "00000000-0000-4000-8000-000000000001";
const SPACE = "00000000-0000-4000-8000-0000000000a1";
const rec = (value: Rec) => ({ spaceId: SPACE, value: { value, role: "reader" } });
const SPACES = { [USER]: { notion_user: { [USER]: rec({ id: USER, name: "Owner" }) }, space: { [SPACE]: rec({ id: SPACE, name: "Example" }) } } };

function safari(answers: Record<string, (body: Rec) => object>) {
  const send: Invoke = async (tool, args) => {
    if (tool === "open") return { id: 1 };
    if (tool === "pace") return PACE_TOOL.run(args);
    if (tool !== "fetch") throw new Error(`no ${tool} in this Safari`);
    const endpoint = String(args.url).split("/api/v3/")[1] ?? "";
    const answer = endpoint === "getSpaces" ? SPACES : answers[endpoint]?.(JSON.parse(String(args.body)) as Rec);
    if (!answer) throw new Error(`no ${endpoint} in this Notion`);
    return { status: 200, url: String(args.url), type: "application/json", text: JSON.stringify(answer), truncated: false };
  };
  return notion(new SiteKit(send)).getClient();
}

type Page = Rec & { id: string; last_edited_time: number };
const page = (n: number, edited: string): Page => ({ id: `00000000-0000-4000-8000-00000000000${n}`, type: "page", alive: true, properties: { title: [[`Page ${n}`]] }, last_edited_time: Date.parse(edited) });

// Notion's search sorted by last edit: the newest pages, at most limit.
const edits = (pages: Page[]) => (body: Rec) => {
  const newest = pages.toSorted((a, b) => b.last_edited_time - a.last_edited_time).slice(0, Number(body.limit));
  return { results: newest.map((p) => ({ id: p.id })), recordMap: { block: Object.fromEntries(newest.map((p) => [p.id, rec(p)])) } };
};

// Notion filters edits by the day only: pages edited earlier on since's
// day, or the day before, come back too, and must not be listed.
test("recent lists only the pages edited after since, newest first", async () => {
  const n = await safari({ search: edits([page(1, "2026-03-02T09:00:00Z"), page(2, "2026-03-02T11:30:00Z"), page(3, "2026-03-01T23:00:00Z"), page(4, "2026-03-02T10:15:00Z"), page(5, "2026-03-02T07:59:00Z")]) });
  const { pages, hasMore } = await n.recent({ since: "2026-03-02T08:00:00Z" });
  expect(pages.map((p) => [p.title, p.lastEditedTime])).toEqual([
    ["Page 2", "2026-03-02T11:30:00.000Z"],
    ["Page 4", "2026-03-02T10:15:00.000Z"],
    ["Page 1", "2026-03-02T09:00:00.000Z"],
  ]);
  expect(hasMore).toBe(false);
});

// A list cut short by limit must not read as every edit since.
test("recent says hasMore when more pages were edited after since than limit", async () => {
  const n = await safari({ search: edits([page(1, "2026-03-02T09:00:00Z"), page(2, "2026-03-02T11:30:00Z"), page(3, "2026-03-02T10:15:00Z")]) });
  const { pages, hasMore } = await n.recent({ since: "2026-03-02T08:00:00Z", limit: 2 });
  expect(pages.map((p) => p.title)).toEqual(["Page 2", "Page 3"]);
  expect(hasMore).toBe(true);
});

// A database page read through getPage has no rows and no properties; its
// rows key their columns by schema ids, and people by user id.
test("queryDatabase gives each row's properties by column name, people by name", async () => {
  const db = "00000000-0000-4000-8000-0000000000d1";
  const collection = "00000000-0000-4000-8000-0000000000c1";
  const assignee = "00000000-0000-4000-8000-000000000002";
  const row = {
    id: "00000000-0000-4000-8000-0000000000e1",
    type: "page",
    alive: true,
    parent_table: "collection",
    parent_id: collection,
    last_edited_time: Date.parse("2026-03-02T10:00:00Z"),
    last_edited_by_id: USER,
    properties: { title: [["Write the launch post"]], "a!b": [["In progress"]], "c?d": [["‣", [["u", assignee]]]], "e%f": [["‣", [["d", { type: "date", start_date: "2026-03-09" }]]]] },
  };
  const schema = { title: { name: "Task", type: "title" }, "a!b": { name: "Status", type: "status" }, "c?d": { name: "Assignee", type: "person" }, "e%f": { name: "Due", type: "date" }, "g&h": { name: "Edited by", type: "last_edited_by" } };
  const n = await safari({
    syncRecordValues: (body) => {
      const pointers = (body.requests as { pointer: { table: string; id: string } }[]).map((r) => r.pointer);
      if (pointers[0]?.table === "block") return { recordMap: { block: { [db]: rec({ id: db, type: "collection_view_page", collection_id: collection, view_ids: ["00000000-0000-4000-8000-0000000000f1"], space_id: SPACE }) } } };
      const people: Record<string, Rec> = { [USER]: { id: USER, name: "Owner" }, [assignee]: { id: assignee, given_name: "Ada", family_name: "Lovelace" } };
      return { recordMap: { notion_user: Object.fromEntries(pointers.map((p) => [p.id, rec(people[p.id] ?? {})])) } };
    },
    queryCollection: () => ({
      result: { type: "reducer", reducerResults: { results: { type: "results", blockIds: [row.id], hasMore: false } } },
      recordMap: { block: { [row.id]: rec(row) }, collection: { [collection]: rec({ id: collection, name: [["Tasks"]], schema }) } },
    }),
  });
  const { name, rows } = await n.queryDatabase(db);
  expect(name).toBe("Tasks");
  expect(rows.map((r) => [r.title, r.properties])).toEqual([["Write the launch post", { Status: "In progress", Assignee: "Ada Lovelace", Due: "2026-03-09", "Edited by": "Owner" }]]);
});
