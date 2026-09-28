// handoff, the caller's half: gives the user the tab for a step only they
// can take (a bot check, a passkey, Touch ID). The daemon holds the handoff
// (handoffWait in tools.ts): it brings the tab to the front with a
// notification, watches the page, and gives back the tab and app the user
// had in front once they are done. This half texts their phone when they
// are away from the Mac, once per handoff, with a picture of the page:
// sending needs the caller's permission to control Messages, which the
// launchd daemon lacks. The text asks for a reply, read here: done has the
// daemon look at the page at once, while skip and stop end the handoff, for
// the agent to go on without the page or to stop its task.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Challenge } from "./challenge.ts";
import { firstWord, isAway, POLL_MS, replies, text, type Thread } from "./phone.ts";
import { rpc } from "./rpc.ts";
import { resolveTab, TAB, type TabInfo, type Tool } from "./tools.ts";

// A tool call may take about 2 minutes. Within one, the daemon is asked in
// slices, so a user who walks away midway is texted within a slice.
const LIMIT_MS = 110000;
const SLICE_MS = 15000;

// Messages sends a picture only from a few places; this is one.
const STAGE = "/private/var/tmp/com.apple.messages";

// thread is where the user's replies to the text are; the daemon keeps it
// for the handoff's later calls. user is his reply when it ends the wait.
type Handed = { done: boolean; waitedMs: number; url?: string; title?: string; challenge?: Challenge; joined?: true; texted?: string; text?: true; id?: number; thread?: Thread; user?: "skip" | "stop" };

// A picture of the page (in front by now), then one plain line.
async function textUser(tab: number, h: Handed): Promise<{ texted: string; thread: Thread }> {
  const site = h.url && URL.canParse(h.url) ? new URL(h.url).hostname.replace(/^www\./, "") : "a site";
  const [what, until] = h.challenge ? ["a check", "clear it"] : ["you", "are done"];
  const line = `${process.env.SAFARI_HARNESS_AWAY === "1" ? "test of the bot-check alert: " : ""}${site} is waiting on ${what} in safari. the agent carries on by itself once you ${until}. reply done, skip or stop`;
  await mkdir(STAGE, { recursive: true });
  const picture = join(STAGE, `safari-harness-${tab}-${Date.now()}.png`);
  try {
    const shot = await rpc("shot", { tab, out: picture }).then(() => undefined, (e: Error) => e.message);
    const r = await text(line, "handoff", shot ? {} : { picture });
    const missing = shot ?? r.picture;
    return { texted: missing ? `${r.status}, without the picture: ${missing}` : r.status, thread: r.thread };
  } finally {
    await rm(picture, { force: true });
  }
}

async function handoff(tab: number, why: string, ms = 60000): Promise<Handed> {
  const end = Date.now() + Math.min(ms, LIMIT_MS);
  const wait = async (o: { ms: number; away?: boolean; texted?: string; thread?: Thread; look?: true; user?: "skip" | "stop"; id?: number }) => (await rpc("handoff_wait", { tab, why, ...o })) as Handed;
  const first = await wait({ ms: 0 });
  let h = first;
  // his replies acted on already, and whether the last said done
  let heard = 0;
  let look = false;
  // user: his skip or stop, which another call may have heard first
  while (!h.done && h.user === undefined) {
    const sent = h.text ? await textUser(tab, h).catch((e: Error) => ({ texted: `not sent: ${e.message}`, thread: undefined })) : undefined;
    const left = end - Date.now();
    if (left <= 0 && sent === undefined) break;
    // A probe that fails reads as at the Mac: the notification is up either way.
    const away = sent === undefined && h.texted === undefined && (await isAway().catch(() => false));
    // With a text out, a slice is short, so his reply is read within one.
    const slice = sent?.thread ?? h.thread ? POLL_MS : SLICE_MS;
    h = await wait({ ms: Math.max(0, Math.min(slice, left)), away, id: first.id, ...(sent ? { texted: sent.texted } : {}), ...(sent?.thread ? { thread: sent.thread } : {}), ...(look ? { look } : {}) });
    look = false;
    const said = h.thread && !h.done ? replies(h.thread).slice(heard) : [];
    heard += said.length;
    for (const reply of said) {
      const word = firstWord(reply);
      if (word === "skip" || word === "stop") return answer(await wait({ ms: 0, id: first.id, user: word }), first);
      if (word === "done") look = true;
    }
  }
  return answer(h, first);
}

// joined is this call's own (its later slices join its handoff too); id
// and thread are only how they name it and hear the user.
function answer(h: Handed, first: Handed): Handed {
  const out: Handed = { ...h };
  delete out.id;
  delete out.thread;
  if (!first.joined) delete out.joined;
  return out;
}

export const HANDOFF_TOOLS: Record<string, Tool> = {
  handoff: {
    desc: "For a step only the user can do: a bot check (challenge in a result), a passkey, Touch ID. Shows them the tab and why (texts them if away); returns when done; done: false: call again, unless user: skip (go on without the page) or stop (stop and report).",
    params: { tab: TAB, why: { type: "string", description: "what to do, for the notice" }, ms: { type: "number", description: "default 60000, max 110000" } },
    required: ["tab", "why"],
    run: async (a) => {
      if (typeof a.why !== "string") throw new Error("why must be a string");
      const ms = a.ms === undefined ? undefined : Number(a.ms);
      if (ms !== undefined && !Number.isFinite(ms)) throw new Error("ms must be a number");
      return handoff(await resolveTab(a.tab, async () => (await rpc("tabs")) as TabInfo[]), a.why, ms);
    },
  },
};
