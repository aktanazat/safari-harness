import { expect, test } from "bun:test";

// MCP clients put the whole tool list in front of the model on every turn, so
// each byte here is paid on every step of every browsing task. The list was
// 13,569 bytes before it was trimmed to 10,573; run then added 651, and pays
// for itself by saving whole turns. Targets by selector or text (90) and an
// extract query (96) save the look-first turn; Apple Passwords (700) brought
// it to 12,111. Telling close that background tabs close with the session
// (114) saves the turn agents spent on close. Telling eval that a selector
// remembered from training may be gone (73) saves the retry after one misses.
// Closing the gaps with Aside's Chrome tools (3,930) brought it to 16,228:
// fetch, download, dialog, pdf, window, browsing_history, and real_input,
// plus snapshot diff and frames, page-world eval, cookie set, and element
// and full-page shots. Each is a task an agent could not finish before.
// The repl tool (665) brought it to 16,893: one call runs a whole script, a
// loop over pages or a download or a signed-in site's own API, that would
// otherwise cost a turn per step; the address and Bitwarden fill tools stay
// off the list, reached through repl and the CLI. Holding a tab on screen
// during wait (76) brought it to 16,979: a routine can finish a sign-in
// page that stalls in a hidden tab without Accessibility permission.
// Trading passwords lock for status (14) brought it to 16,993: one agent's
// lock had locked the shared pairing for every other agent, and status says
// why it is locked. The handoff tool (496, with activate saying it raises
// Safari) brought it to 17,489: a bot check or a passkey prompt now goes to
// the user in one call instead of a stalled wait and a chat round trip.
// Requiring tab on the page tools (259: tab joins their required lists, and
// open says what tab "front" means) brought it to 17,748: a call without
// tab now fails instead of reading the user's front tab, as one did his
// medical records page. Saying that net records from the start of the page
// load, in every frame, with the start of each response body (74) brought it
// to 17,822: an agent reads a failed request at once instead of starting
// capture and reloading, as one could not on CVS's insurance form. The
// group param on open (88) brought it to 17,910: each task's tabs go in a
// window of its own, never in the user's windows. Passwords'
// done and one-touch pairing (62) brought it to 17,972: a locked call pairs
// after the user's Touch ID, and a session lets go of the pairing when done.
// Letting open keep a tab (58) brought it to 18,030: the daemon closes an
// agent's background tabs once it exits or leaves them idle, and keep leaves
// one open for the user. The data tool (440) brought it to 18,470: a shop,
// recipe, or article page's own JSON (price, stock, author) comes back in
// one call, where a snapshot and a guessed eval took several. Naming eval's
// sh helpers (70) brought it to 18,540: code reaches into shadow roots and
// reads JSON-LD without walking the page by hand.
const TOOL_LIST_MAX_BYTES = 18_540;

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
