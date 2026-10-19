import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Invoke } from "../call.ts";
import { SiteKit } from "./kit.ts";
import { x } from "./x.ts";

const dir = mkdtempSync("/private/var/tmp/x-test-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// x.com as the x global sees it: its one tab answers every request with body.
function site(body: object) {
  const send: Invoke = async (tool) => {
    if (tool === "open") return { id: 1 };
    if (tool === "eval") return { result: { status: 200, body } };
    throw new Error(`no ${tool} in this Safari`);
  };
  return x(new SiteKit(send, undefined, dir));
}

// A bookmarks page as X's Bookmarks operation answers it.
const bottom = (value: string) => ({ content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value } });
const post = { content: { entryType: "TimelineTimelineItem", itemContent: { tweet_results: { result: { rest_id: "1", legacy: { full_text: "saved" } } } } } };
const answer = (...entries: object[]) => ({ data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } });

// On 10-19 the page past the last bookmark came back with no posts and the
// cursor it was asked with, so a loop paging until there was no cursor
// would have asked for that page forever.
test.each([
  ["the page past the last one, which X answers with the cursor it was asked with", answer(bottom("C1")), undefined],
  ["a page of posts", answer(post, bottom("C2")), "C2"],
])("getBookmarks gives the next page's cursor only while there is one: %s", async (_, body, next) => {
  expect((await site(body).getBookmarks({ cursor: "C1" })).nextCursor).toBe(next);
});
