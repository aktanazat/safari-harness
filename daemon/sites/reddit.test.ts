import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Invoke } from "../call.ts";
import { PACE_TOOL } from "../pace.ts";
import { SiteKit } from "./kit.ts";
import { reddit } from "./reddit.ts";

const dir = mkdtempSync("/private/var/tmp/reddit-test-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Job = { kind: string; url?: string; cursor?: string };

// reddit.com as the reddit global sees it: its one tab answers each job
// (the page it holds, or a fragment it fetched) with answer's reply, and
// asked keeps every job it was given.
function site(answer: (job: Job) => object, asked: Job[] = []) {
  const send: Invoke = async (tool, args) => {
    if (tool === "open" || tool === "goto") return { id: 1 };
    if (tool === "pace") return PACE_TOOL.run(args);
    if (tool === "eval") {
      const job = JSON.parse(String(args.expression).match(/return run\((.*)\);\}\)\(\)$/s)![1]) as Job;
      asked.push(job);
      return { result: { status: 200, ...answer(job) } };
    }
    throw new Error(`no ${tool} in this Safari`);
  };
  return reddit(new SiteKit(send, undefined, dir));
}

const post = (id: string) => ({ id, url: `https://www.reddit.com/r/t/comments/${id}/`, subreddit: "t", title: "a post", author: "op", createdAt: "", score: 1, upvoteRatio: 1, comments: 9, type: "text", link: "", text: "" });
const comment = (id: string, depth = 0) => ({ id, depth, author: "a", createdAt: "", score: 1, url: "", text: id });

// Reddit folds replies behind "more replies" and pages top-level comments
// behind a separate fragment; a read with a small limit should spend its
// requests on more of the thread's own answers before folded replies.
test("getThread with a limit reads the next top-level comments before folded replies, stops at the limit, and says more remain", async () => {
  const asked: Job[] = [];
  const thread = await site((job) => {
    if (job.kind === "page") return { post: post("abc12"), comments: [comment("c1")], more: [{ src: "/folded", cursor: "f", top: false }, { src: "/top", cursor: "t", top: true }] };
    if (job.url === "/top") return { comments: [comment("c2"), comment("c3")], more: [] };
    return { comments: [comment("r1", 1)], more: [] };
  }, asked).getThread("https://www.reddit.com/r/t/comments/abc12/a_post/", { limit: 3 });
  expect(thread.comments.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  expect(thread.more).toBe(true);
  expect(asked.map((j) => j.url ?? j.kind)).toEqual(["page", "/top"]);
});

// A fragment can draw the very pager it was asked with; asking it again
// would post to Reddit from the owner's tab once a second, forever.
test("getThread asks each more-comments pager once, even when a fragment draws it again", async () => {
  const asked: Job[] = [];
  const again = { src: "/folded", cursor: "f", top: false };
  const thread = await site((job) => (job.kind === "page" ? { post: post("abc12"), comments: [comment("c1")], more: [again] } : { comments: [], more: [again] }), asked).getThread("abc12");
  expect(thread.comments.map((c) => c.id)).toEqual(["c1"]);
  expect(asked.map((j) => j.url ?? j.kind)).toEqual(["page", "/folded"]);
});

// A removed post can redirect to another; its comments must not come back
// as the asked post's.
test("getThread fails when the page shows a different post than the one asked for", async () => {
  await expect(site(() => ({ post: post("zzz99"), comments: [], more: [] })).getThread("abc12")).rejects.toThrow("Reddit showed post zzz99 for abc12");
});

// Past its last page Reddit can answer the same results with a cursor
// again, and a loop that reads until limit would ask forever.
test("search stops paging when a page brings no new posts and gives no cursor", async () => {
  const asked: Job[] = [];
  const hit = { id: "p1", url: "", subreddit: "t", title: "", author: "", createdAt: "", score: 1, comments: 1 };
  const found = await site(() => ({ results: [hit], next: "/svc/shreddit/search/?cursor=again" }), asked).search("claude", { limit: 25 });
  expect(found.results.map((r) => r.id)).toEqual(["p1"]);
  expect(found.nextCursor).toBeUndefined();
  expect(asked).toHaveLength(2);
});

// The cursor is fetched from the owner's signed-in tab.
test("search refuses a cursor that is not a Reddit search fragment, asking Reddit nothing", async () => {
  const asked: Job[] = [];
  await expect(site(() => ({}), asked).search("claude", { cursor: "https://evil.example/steal" })).rejects.toThrow("not a cursor from reddit.search");
  expect(asked).toHaveLength(0);
});
