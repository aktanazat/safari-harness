import { expect, test } from "bun:test";
import { CALLER_TOOLS } from "./caller.ts";
import { checkCall } from "./guard.ts";
import { TOOLS } from "./tools.ts";

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
// one open for the user. The learn tool (445) brought it to 18,475: an
// agent keeps what it found out about a site (CVS's insurance-card flow, a
// button that loads late) past compaction and for the next agent, instead
// of spending the same turns finding it again. Saving a read to a file (544:
// save on extract, snapshot, eval, and fetch) brought it to 19,019: a long
// page costs the model its path and first 500 characters instead of its
// whole text. Reading tables as rows (105: extract's as) brought it to
// 19,124: a table or product list comes back as rows to use, not text to
// parse. The map tool (870) brought it to 19,994: one call reads 20 pages
// that took 20 runs or 60 calls. The ask tool (539) and handoff naming the
// replies skip and stop (70) brought it to 20,603: an agent whose user is
// away gets his answer or his skip from his phone instead of stalling until
// he is back. Letting upload find the user's file (135) brought it to
// 20,738: an agent asked him for an insurance card photo that was already
// in his iCloud Drive. The data tool (440) brought it to 21,178: a shop,
// recipe, or article page's own JSON (price, stock, author) comes back in
// one call, where a snapshot and a guessed eval took several. Naming eval's
// sh helpers (70) brought it to 21,248: code reaches into shadow roots and
// reads JSON-LD without walking the page by hand. Saying that refs outlast
// redraws (4) brought it to 21,252: a ref whose element the page drew anew
// still works, so an agent acts on it without another snapshot. Private
// tabs, texted codes typed unseen, and pairing on the Mac (289) brought it
// to 21,541: an agent gets its own tabs and a count of his, where it once
// listed his whole Safari six times over, and never sees a code. Action
// receipts and settle-aware waits (403) brought it to 21,944: a click the
// page ignored says so in its own answer, and a wait ends on the first of
// several texts, text gone, an address, or a quiet page, not a sleep. The
// replay and recordings tools (733) brought it to 22,677: a task the user
// showed once with the toolbar button runs again by name in a background
// tab, with no model working out each step. Saying that real_input's single
// click stays in the background (53) brought it to 22,730: an agent clicks
// a site that ignores scripted clicks without taking the user's screen.
// Alerts moving to Telegram, where the user cannot answer (-169), brought
// it to 22,561: ask lost its choices and its wait for a reply. The keep
// tool, with close saying tabs close as the turn ends (300), brought it to
// 22,861: tabs an agent left open as it replied piled up in his Safari
// until it exited, while a form waiting on his answer has to stay. A wait
// on map, and a wait with only ms that ends on a quiet page (135), brought
// it to 22,996: agents read pages a script draws late in one map call,
// where they slept inside each page's eval or went page by page. Readers
// (339), scripts saved with learn that eval and map run by name, brought
// it to 23,335: the script one agent worked out to read a site's listings
// is the next agent's one call, where each wrote its own again. Files on
// imessage_send (190) brought it to 23,525: agents sent a photo through
// Messages' AppleScript, and it arrived as an empty message marked
// delivered. Saying eval's page must answer within 30 s, and that wait with
// only ms is no sleep (87), brought it to 23,612: an agent's 30 s scroll
// loop failed whole on SoFi, and agents read wait {ms} as a sleep. change
// on passwords (134) brought it to 23,746: an agent securing leaked
// passwords had no way to set a new one without seeing it, and Safari
// suggests a strong password only to a person at the page (09-29).
// setup-code (109) brought it to 23,855: 40 sites offered an authenticator
// app and the agent had no way to save one without reading its key. type's
// secret "page" (161) brought it to 24,016: PayPal and mail.ru send their
// codes by email, and the agent could only type them by reading them.
// passwords site (94) brought it to 24,110: a reset page on another host
// than the sign-in page left the saved login holding the old password.
// Saying a site's stated password rules go in passwordrules (76) brought
// it to 24,186: Costco refused the made password for want of a symbol.
// Cards share passwords' actions and add no top-level tool. Tightening
// that tool's own description and parameters pays for its card actions
// and selector; the byte limit stays unchanged. net's url and eval's
// sh.scripts (80, net's description tightened) brought it to 24,243: on
// 10-04 an agent filtered net's list through python twelve times, and
// fetched and searched the page's scripts by hand in twelve calls.
// open's new, the way to a second tab on a site now that open loads in
// the agent's tab there (10-05: one tire search held tirerack.com in two
// of its 17 tabs), is paid for by open's own description and parameters.
// real_input's send and reply, and Return on a final line break (147),
// brought it to 24,390: on 10-07 each reply in a Philips support chat took
// four or five calls (type, find Send, click it, check, wait).
const TOOL_LIST_MAX_BYTES = 24_390;

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

// On 09-30 (01a0f145) omp refused real_input {action: "click"} for want of
// do, checking the listed required parameters before the call left it; the
// daemon, which takes action as do, never saw it.
test("a call that names do as action passes the listed required parameters, and the daemon takes it as do", async () => {
  const listed = (await toolList()) as { name: string; inputSchema: { required?: string[] } }[];
  const missing = (name: string, args: Record<string, unknown>) => (listed.find((t) => t.name === name)?.inputSchema.required ?? []).filter((k) => !(k in args));
  const real = { tab: 451444, action: "click", ref: "17" };
  const back = { tab: 7, action: "back" };
  expect([missing("real_input", real), missing("history", back)]).toEqual([[], []]);
  expect(checkCall(CALLER_TOOLS, "real_input", real, true).args).toEqual({ tab: 451444, do: "click", ref: "17" });
  expect(checkCall(TOOLS, "history", back, true).args).toEqual({ tab: 7, do: "back" });
});
