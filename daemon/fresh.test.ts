import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeHash } from "./codehash.ts";

// An MCP server lives as long as its agent's session, across deploys
// (fresh.ts). Here it runs as its client runs it, over stdio, against a
// fake daemon: /health reports a release, and /rpc answers every call with
// one tab. The new release's mcp-tools.ts is a stand-in that
// lists one tool and says which release ran each call.

const REPO = realpathSync(join(import.meta.dir, ".."));
const scratch = mkdtempSync(join(tmpdir(), "fresh-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const NEW_TOOLS = [{ name: "tabs", description: "[Safari] the new release's tabs", inputSchema: { type: "object", properties: {} } }];
const release = join(scratch, "release");
mkdirSync(join(release, "daemon"), { recursive: true });
writeFileSync(join(release, "daemon", "mcp-tools.ts"), `export const listTools = () => ${JSON.stringify(NEW_TOOLS)};
export async function callTool(name: string, args: Record<string, unknown>) { return \`the new release ran \${name} \${JSON.stringify(args)}\`; }
export async function closeSession() {}
`);

function daemon(code: string) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health") return Response.json({ ok: true, code, root: release });
      if (pathname !== "/rpc") return new Response("not found", { status: 404 });
      return Response.json({ ok: true, value: [{ id: 3, url: "https://example.com/", title: "Example" }] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
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

test("after a deploy, the server runs every call with the new release's code, and says so to its client once", async () => {
  const fake = daemon("0000000000000000");
  const mcp = session(fake.url);
  expect((await mcp.request("initialize")).result?.capabilities).toEqual({ tools: { listChanged: true } });
  // contacts runs in the server's own process: a text or a login must not
  // wait for the agent to restart a server it cannot restart.
  expect((await mcp.request("tools/call", { name: "contacts", arguments: { name: "Ann" } })).result).toEqual({ content: [{ type: "text", text: 'the new release ran contacts {"name":"Ann"}' }] });
  expect((await mcp.request("tools/call", { name: "tabs", arguments: {} })).result).toEqual({ content: [{ type: "text", text: "the new release ran tabs {}" }] });
  expect((await mcp.request("tools/list")).result?.tools).toEqual(NEW_TOOLS);
  await mcp.end();
  fake.stop();
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
