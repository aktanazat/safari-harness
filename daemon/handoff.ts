// handoff, the caller's half: gives the user the tab for a step only they
// can take (a bot check, a passkey, Touch ID). The daemon holds the handoff
// (handoffWait in tools.ts): it brings the tab to the front with a
// notification, watches the page, and gives back the tab and app the user
// had in front once they are done. This half alerts their phone when they
// are away from the Mac, once per handoff, with a picture of the page. They
// cannot answer the alert; the handoff ends when the page clears, or shows
// the text until names.

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Challenge } from "./challenge.ts";
import { alert, isAway } from "./phone.ts";
import { rpc } from "./rpc.ts";
import { resolveTab, TAB, type TabInfo, type Tool } from "./tools.ts";

// A tool call may take about 2 minutes. Within one, the daemon is asked in
// slices, so a user who walks away midway is alerted within a slice.
const LIMIT_MS = 110000;
const SLICE_MS = 15000;

// alert: true tells this call to send the alert; alerted is how it went.
type Handed = { done: boolean; waitedMs: number; url?: string; title?: string; challenge?: Challenge; joined?: true; alerted?: string; alert?: true; id?: number };

// A picture of the page (in front by now), with one plain line under it.
async function alertUser(tab: number, h: Handed): Promise<string> {
  const site = h.url && URL.canParse(h.url) ? new URL(h.url).hostname.replace(/^www\./, "") : "a site";
  const [what, until] = h.challenge ? ["a check", "clear it"] : ["you", "are done"];
  const line = `${process.env.SAFARI_HARNESS_AWAY === "1" ? "test of the bot-check alert: " : ""}${site} is waiting on ${what} in safari on your mac. the agent carries on by itself once you ${until}.`;
  const picture = join(tmpdir(), `safari-harness-${tab}-${Date.now()}.png`);
  try {
    const shot = await rpc("shot", { tab, out: picture }).then(() => undefined, (e: Error) => e.message);
    await alert(line, shot ? undefined : picture);
    return shot ? `sent, without the picture: ${shot}` : "sent";
  } finally {
    await rm(picture, { force: true });
  }
}

async function handoff(tab: number, why: string, ms = 60000, until?: string): Promise<Handed> {
  const end = Date.now() + Math.min(ms, LIMIT_MS);
  const wait = async (o: { ms: number; away?: boolean; alerted?: string; id?: number; until?: string }) => (await rpc("handoff_wait", { tab, why, ...o })) as Handed;
  // until goes with the call that starts the handoff; the later ones join it
  const first = await wait({ ms: 0, ...(until === undefined ? {} : { until }) });
  let h = first;
  while (!h.done) {
    const alerted = h.alert ? await alertUser(tab, h).catch((e: Error) => `not sent: ${e.message}`) : undefined;
    const left = end - Date.now();
    if (left <= 0 && alerted === undefined) break;
    // A probe that fails reads as at the Mac: the notification is up either way.
    const away = alerted === undefined && h.alerted === undefined && (await isAway().catch(() => false));
    h = await wait({ ms: Math.max(0, Math.min(SLICE_MS, left)), away, id: first.id, ...(alerted === undefined ? {} : { alerted }) });
  }
  return answer(h, first);
}

// joined is this call's own (its later slices join its handoff too); id is
// only how they name it. alerted is always there: on 09-29 two handoffs
// that ran out said nothing of the user's phone, so the agent could not
// tell a user at the Mac from an alert that never went.
function answer(h: Handed, first: Handed): Handed {
  const out: Handed = { ...h, alerted: h.alerted ?? "not sent: at the Mac" };
  delete out.id;
  if (!first.joined) delete out.joined;
  return out;
}

export const HANDOFF_TOOLS: Record<string, Tool> = {
  handoff: {
    desc: "For a step only the user can do: a bot check (challenge in a result), a passkey, Touch ID. Shows them the tab and why, and alerts their phone if they are away; returns when done; done: false: call again.",
    params: { tab: TAB, why: { type: "string", description: "what to do, for the notice" }, ms: { type: "number", description: "default 60000, max 110000" }, until: { type: "string", description: "text shown once done" } },
    required: ["tab", "why"],
    run: async (a) => {
      if (typeof a.why !== "string") throw new Error("why must be a string");
      if (a.until !== undefined && typeof a.until !== "string") throw new Error("until must be text the page shows once the user is done");
      const ms = a.ms === undefined ? undefined : Number(a.ms);
      if (ms !== undefined && !Number.isFinite(ms)) throw new Error("ms must be a number");
      return handoff(await resolveTab(a.tab, async () => (await rpc("tabs")) as TabInfo[]), a.why, ms, a.until);
    },
  },
};
