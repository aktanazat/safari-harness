import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Invoke } from "../call.ts";
import { PACE_TOOL } from "../pace.ts";
import { SiteKit } from "./kit.ts";
import { x } from "./x.ts";

const dir = mkdtempSync("/private/var/tmp/x-test-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// x.com as the x global sees it: its one tab answers every request with
// body, status, and headers, and asked notes when each request reached X.
// Every session's kit takes its turns from the daemon's one pacer.
function site(body: object, reply: { status?: number; headers?: Record<string, string> } = {}, asked: number[] = []) {
  const send: Invoke = async (tool, args) => {
    if (tool === "open") return { id: 1 };
    if (tool === "pace") return PACE_TOOL.run(args);
    if (tool === "eval") {
      asked.push(Date.now());
      return { result: { status: reply.status ?? 200, headers: reply.headers ?? {}, body } };
    }
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

// Each agent's x global is its own session's, and X counts them as one
// account: two sessions' requests still go a turn apart.
test("two sessions reading X at once reach it a turn apart", async () => {
  const asked: number[] = [];
  await Promise.all([site(answer(post), {}, asked).getTimeline(), site(answer(post), {}, asked).getTimeline()]);
  expect(asked).toHaveLength(2);
  expect(asked[1] - asked[0]).toBeGreaterThanOrEqual(900);
});

// On 10-29 X answered a search with x-rate-limit-limit 50 and its reset in
// epoch seconds, 15 minutes out; mem-xposts had matched "429" in the text.
test("a search X answers with 429 fails with rate_limited at the reset X named, and another session's search waits for it without asking X", async () => {
  const reset = Math.floor(Date.now() / 1000) + 900;
  const asked: number[] = [];
  const limited = { status: 429, headers: { "x-rate-limit-remaining": "0", "x-rate-limit-reset": String(reset) } };
  const named = { code: "rate_limited", detail: { host: "x.com", resetAt: reset * 1000 } };
  await expect(site({ errors: [{ message: "Rate limit exceeded", code: 88 }] }, limited, asked).search("osha")).rejects.toMatchObject(named);
  await expect(site(answer(post), {}, asked).search("osha")).rejects.toMatchObject(named);
  expect(asked).toHaveLength(1);
});
