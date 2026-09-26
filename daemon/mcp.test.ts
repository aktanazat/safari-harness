import { expect, test } from "bun:test";

// MCP clients put the whole tool list in front of the model on every turn, so
// each byte here is paid on every step of every browsing task. The list was
// 13,569 bytes before it was trimmed to 10,573; run then added 651, and pays
// for itself by saving whole turns. Targets by selector or text (90) and an
// extract query (96) save the look-first turn; Apple Passwords (700) brought
// it to 12,111.
const TOOL_LIST_MAX_BYTES = 12_300;

async function toolList(): Promise<unknown> {
  const server = Bun.spawn(["bun", `${import.meta.dir}/mcp.ts`], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  server.stdin.end();
  const out = await new Response(server.stdout).text();
  const reply: unknown = JSON.parse(out.split("\n")[0]);
  if (reply && typeof reply === "object" && "result" in reply && reply.result && typeof reply.result === "object" && "tools" in reply.result) return reply.result.tools;
  throw new Error(`no tool list in: ${out.slice(0, 200)}`);
}

test("the MCP tool list stays small", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(await toolList())).length;
  expect(bytes).toBeLessThanOrEqual(TOOL_LIST_MAX_BYTES);
});
