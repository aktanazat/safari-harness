import { afterAll, expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { redacted, redactUrl } from "./redact.ts";
import { callTool } from "./tools.ts";

// A stand-in extension. The user's window, 7000, holds three tabs, the front
// one on GitHub. Each window open makes starts with its page. A type answers
// as an extension from before type stopped sending the field's value.
type Row = { id: number; windowId: number; url: string; title?: string; active?: boolean; front?: boolean };
const tabs = new Map<number, Row>([
  [7001, { id: 7001, windowId: 7000, url: "https://github.com/me/repo?tab=settings#readme", title: "Repo", active: true, front: true }],
  [7002, { id: 7002, windowId: 7000, url: "https://mail.google.com/mail/u/0/?state=s3cret#inbox", title: "Mail" }],
  [7003, { id: 7003, windowId: 7000, url: "https://gist.github.com/me/1", title: "Gist" }],
]);
const typed: unknown[] = [];
let nextTab = 8000;
let nextWindow = 5000;
function answer(op: string, args: unknown[]): unknown {
  if (op === "windows.open") {
    const windowId = ++nextWindow;
    tabs.set(9000 + windowId, { id: 9000 + windowId, windowId, url: String(args[0]) });
    return { windowId, tabId: 9000 + windowId };
  }
  if (op === "tabs.open") {
    const t = { id: ++nextTab, windowId: Number(args[2]), url: String(args[0]) };
    tabs.set(t.id, t);
    return t;
  }
  if (op === "tabs.list") return [...tabs.values()];
  if (op === "probe") return [];
  if (op === "relay" && args[1] === "type") {
    const [, text] = args[2] as unknown[];
    typed.push(args[2]);
    return { ok: true, kept: true, value: text };
  }
  return { ok: true };
}
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value: answer(op, args) })));
  },
  close() {},
});

const agent = Bun.spawn(["sleep", "60"]);
// The tab and its agent go, so no other test file finds them.
afterAll(async () => {
  await as("close", { tab: mine.id });
  agent.kill();
});
const as = (tool: string, args: Record<string, unknown>) => runAs(agent.pid, () => callTool(tool, args));
let mine: Row;

// A research agent listed his whole Safari six times in one errand
// (01a0da2f), and a tab list carried an OAuth state token into a subagent.
test("an agent sees its own tabs, his front tab, and a count of his others; host and all show his, cut at the path", async () => {
  mine = (await as("open", { url: "https://example.com/done?code=x&order=7", background: true })) as Row;
  expect(mine.url).toBe("https://example.com/done?code=...&order=7");
  expect(await as("tabs", {})).toEqual([
    { id: mine.id, windowId: mine.windowId, url: "https://example.com/done?code=...&order=7" },
    { id: 7001, windowId: 7000, active: true, front: true },
    'the user has 3 other tabs; pass host: "github.com" to see those on a site, or all: true',
  ]);
  expect(await as("tabs", { host: "github.com" })).toEqual([
    { id: 7001, windowId: 7000, url: "https://github.com/me/repo", title: "Repo", active: true, front: true },
    { id: 7003, windowId: 7000, url: "https://gist.github.com/me/1", title: "Gist" },
  ]);
  const all = (await as("tabs", { all: true })) as Row[];
  expect(all.map((t) => t.url)).toEqual([
    "https://github.com/me/repo",
    "https://mail.google.com/mail/u/0/",
    "https://gist.github.com/me/1",
    expect.stringContaining("/space?id="),
    "https://example.com/done?code=...&order=7",
  ]);
});

test("a caller with no agent behind it gets every tab, secrets in addresses still cut", async () => {
  const every = (await callTool("tabs", {})) as Row[];
  expect(every.map((t) => t.id)).toEqual([...tabs.keys()]);
  expect(every.find((t) => t.id === 7002)?.url).toBe("https://mail.google.com/mail/u/0/?state=...#inbox");
  expect(every.find((t) => t.id === 7001)?.url).toBe("https://github.com/me/repo?tab=settings#readme");
});

// 01a0e50b: type echoed an emailed one-time code back into the transcript.
test("type answers how much it typed and whether the field kept it, never the text", async () => {
  expect(await as("type", { tab: mine.id, ref: "1", text: "hunter2" })).toEqual({ ok: true, kept: true, typed: "7 chars" });
  // Only the caller fills a code in; over the port it would be typed as is.
  await expect(as("type", { tab: mine.id, ref: "1", text: "{{code}}" })).rejects.toThrow("safari CLI or MCP");
  expect(typed).toEqual([["1", "hunter2", { append: false, secret: false }]]);
});

test("addresses keep an order id and lose a code, a state, and a token, whatever their case", () => {
  expect(redactUrl("https://example.com/cb?code=x&order=7&State=y#access_token=t&expires=3600")).toBe("https://example.com/cb?code=...&order=7&State=...#access_token=...&expires=3600");
  expect(redactUrl("https://shop.example/?zipcode=95616&encode=1&codes=2")).toBe("https://shop.example/?zipcode=95616&encode=1&codes=2");
  expect(redacted({ url: "https://a.example/?sig=abc", snapshot: '[3] link "Back" /cb?code=abc&order=7\n[4] link "Next" /p?page=2', steps: [{ value: { url: "https://b.example/?token=t" } }] })).toEqual({
    url: "https://a.example/?sig=...",
    snapshot: '[3] link "Back" /cb?code=...&order=7\n[4] link "Next" /p?page=2',
    steps: [{ value: { url: "https://b.example/?token=..." } }],
  });
});
