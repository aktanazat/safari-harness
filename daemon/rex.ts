// The Rex tab an agent runs in, from the REX_SESSION and REX_BLOCK its
// process inherited from that tab's terminal, so its window can name the
// tab and bring it up. On 11-08 the user went through each of 41 windows
// titled "agent 14158" and the like to learn which task had opened it.
import { homedir } from "node:os";

export type RexTab = { session: string; block: string };

// The rex CLI from the Rex install, never from a path an agent's
// environment names: any local process can name its own pid as a caller.
const REX = `${homedir()}/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`;

const SESSION = /^session:[0-9a-f-]{36}$/;
const BLOCK = /^block:[0-9a-f-]{36}$/;

export async function rexTabOf(pid: number): Promise<RexTab | undefined> {
  const ps = Bun.spawn(["/bin/ps", "-E", "-ww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const line = await new Response(ps.stdout).text();
  const session = / REX_SESSION=(\S+)/.exec(line)?.[1];
  const block = / REX_BLOCK=(\S+)/.exec(line)?.[1];
  return session && block && SESSION.test(session) && BLOCK.test(block) ? { session, block } : undefined;
}

// A Rex the user quit stays quit: --autostart would start its server again.
async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn([REX, "--autostart=false", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err.trim() || `rex exited ${code}`);
  return out;
}

// The tab's title while pid runs in it, without what its program draws
// before the task: omp's π, a spinner, a ">" prompt, and icon glyphs. A tab
// another program took over since is that program's.
export async function rexTitle(tab: RexTab, pid: number): Promise<string | undefined> {
  const answer = JSON.parse(await run(["block", "call", "-s", tab.session, "-b", tab.block, "title"])) as { title?: unknown; owner?: { pid?: unknown } };
  if (typeof answer.title !== "string" || answer.owner?.pid !== pid) return undefined;
  const title = answer.title.replace(/^(?:π(?=\s)|[>❯]|[\u2800-\u28FF]|\p{Co}|\s)+/u, "").trim();
  return title || undefined;
}

// Shows the tab in the Rex app and brings the app to the front.
export async function showRexTab(tab: RexTab): Promise<void> {
  await run(["do", "session.select", `session_id=${tab.session}`]);
  await run(["focus", "-s", tab.session, tab.block]);
  const app = Bun.spawn(["/usr/bin/open", "-b", "com.superlogical.rex"], { stdout: "ignore", stderr: "ignore" });
  await app.exited;
}
