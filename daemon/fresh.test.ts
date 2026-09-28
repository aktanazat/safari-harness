import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeHash } from "./codehash.ts";
import { RESTART } from "./fresh.ts";

// An MCP server lives as long as its agent's session, across deploys
// (fresh.ts). Here it runs as its client runs it, over stdio, against a
// fake daemon: /health reports a release, and /rpc records each call and
// answers with one tab. The new release's MCP server is a stand-in that
// lists one tool.

const REPO = realpathSync(join(import.meta.dir, ".."));
const scratch = mkdtempSync(join(tmpdir(), "fresh-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const NEW_TOOLS = [{ name: "tabs", description: "[Safari] the new release's tabs", inputSchema: { type: "object", properties: {} } }];
const release = join(scratch, "release");
mkdirSync(join(release, "daemon"), { recursive: true });
writeFileSync(join(release, "daemon", "mcp.ts"), `await Bun.stdin.text();\nconsole.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: ${JSON.stringify(NEW_TOOLS)} } }));\n`);

function daemon(code: string) {
  const calls: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return Response.json({ ok: true, code, root: release, tools: ["tabs", "open"] });
      if (pathname !== "/rpc") return new Response("not found", { status: 404 });
      calls.push(await req.json());
      return Response.json({ ok: true, value: [{ id: 3, url: "https://example.com/", title: "Example" }] });
    },
  });
  return { calls, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

type Message = {
  id?: number;
  method?: string;
  result?: { capabilities?: unknown; content?: { type: string; text: string }[]; isError?: boolean; tools?: { name: string }[] };
};

// The client's side of a session: request writes a message and gives its
// reply; seen is every message the server wrote, notifications too.
function session(daemonUrl: string) {
  const server = Bun.spawn([process.execPath, join(import.meta.dir, "mcp.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, SAFARI_HARNESS_HTTP: daemonUrl, HOME: scratch },
  });
  const seen: Message[] = [];
  const replies = new Map<number, PromiseWithResolvers<Message>>();
  const reply = (id: number) => {
    const known = replies.get(id);
    if (known) return known;
    const made = Promise.withResolvers<Message>();
    replies.set(id, made);
    return made;
  };
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of server.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const msg: Message = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        seen.push(msg);
        if (msg.id !== undefined) reply(msg.id).resolve(msg);
      }
    }
  })();
  let last = 0;
  return {
    seen,
    request(method: string, params: Record<string, unknown> = {}): Promise<Message> {
      const id = ++last;
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      server.stdin.flush();
      return reply(id).promise;
    },
    async end() {
      server.stdin.end();
      await Promise.all([server.exited, reading]);
    },
  };
}

const listChanged = (seen: Message[]) => seen.filter((m) => m.method === "notifications/tools/list_changed");

test("after a deploy, the server says so once, lists the new release's tools, and runs only what the daemon runs", async () => {
  const fake = daemon("0000000000000000");
  const mcp = session(fake.url);
  expect((await mcp.request("initialize")).result?.capabilities).toEqual({ tools: { listChanged: true } });
  // contacts runs in the server's own process, on the old release's code.
  expect((await mcp.request("tools/call", { name: "contacts", arguments: { name: "Ann" } })).result).toEqual({ content: [{ type: "text", text: `error: ${RESTART}` }], isError: true });
  // The daemon runs tabs on the new release, and the answer says to restart.
  const tabs = (await mcp.request("tools/call", { name: "tabs", arguments: {} })).result;
  expect(tabs?.isError).toBeUndefined();
  expect(tabs?.content?.[0]?.text).toContain("https://example.com/");
  expect(tabs?.content?.[0]?.text).toEndWith(`note: ${RESTART}`);
  // The new release has no info tool.
  expect((await mcp.request("tools/call", { name: "info", arguments: { tab: 3 } })).result).toEqual({ content: [{ type: "text", text: `error: ${RESTART}` }], isError: true });
  expect((await mcp.request("tools/list")).result?.tools).toEqual(NEW_TOOLS);
  await mcp.end();
  fake.stop();
  expect(fake.calls).toEqual([{ tool: "tabs", args: {}, caller: expect.any(Number), model: true }]);
  expect(listChanged(mcp.seen)).toHaveLength(1);
});

test("a server on the daemon's release lists its own tools and adds nothing to answers", async () => {
  const fake = daemon(codeHash(REPO));
  const mcp = session(fake.url);
  await mcp.request("initialize");
  const text = (await mcp.request("tools/call", { name: "tabs", arguments: {} })).result?.content?.[0]?.text;
  expect(text).toContain("https://example.com/");
  expect(text).not.toContain("note:");
  expect((await mcp.request("tools/list")).result?.tools?.map((t) => t.name)).toContain("click");
  await mcp.end();
  fake.stop();
  expect(listChanged(mcp.seen)).toEqual([]);
});
