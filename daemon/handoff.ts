// handoff, the caller's half: gives the user the tab for a step only they
// can take (a bot check, a passkey, Touch ID). The daemon holds the handoff
// (handoffWait in tools.ts): it brings the tab to the front with a
// notification, watches the page, and gives back the tab and app the user
// had in front once they are done. This half texts their phone when they
// are away from the Mac, once per handoff, with a picture of the page:
// sending needs the caller's permission to control Messages, which the
// launchd daemon lacks.

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Challenge } from "./challenge.ts";
import { textOwner } from "./imessage.ts";
import { rpc } from "./rpc.ts";
import { resolveTab, TAB, type TabInfo, type Tool } from "./tools.ts";

const execFileAsync = promisify(execFile);

// A tool call may take about 2 minutes. Within one, the daemon is asked in
// slices, so a user who walks away midway is texted within a slice.
const LIMIT_MS = 110000;
const SLICE_MS = 15000;

// Away: the screen is locked or asleep, the Mac is on another user, or
// nothing was typed or clicked for IDLE_S. None of it needs a permission.
const IDLE_S = 180;
const AWAY = `ObjC.import("CoreGraphics");
const s = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary());
const locked = s.objectForKey("CGSSessionScreenIsLocked");
JSON.stringify({ idle: $.CGEventSourceSecondsSinceLastEventType(0, 0xffffffff), locked: !locked.isNil() && locked.boolValue, console: ObjC.unwrap(s.objectForKey("kCGSSessionOnConsoleKey")) === true, asleep: $.CGDisplayIsAsleep($.CGMainDisplayID()) !== 0 })`;

// Messages sends a picture only from a few places; this is one.
const STAGE = "/private/var/tmp/com.apple.messages";

type Handed = { done: boolean; waitedMs: number; url?: string; title?: string; challenge?: Challenge; joined?: true; texted?: string; text?: true; id?: number };

// SAFARI_HARNESS_AWAY=1 says away (a test: the text says it is one), 0 says
// at the Mac.
async function isAway(): Promise<boolean> {
  const forced = process.env.SAFARI_HARNESS_AWAY;
  if (forced === "1" || forced === "0") return forced === "1";
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", AWAY], { timeout: 5000 });
  const s: unknown = JSON.parse(stdout);
  if (!s || typeof s !== "object" || !("idle" in s) || !("locked" in s) || !("console" in s) || !("asleep" in s)) throw new Error(`away probe said ${stdout}`);
  return s.locked === true || s.asleep === true || s.console !== true || (typeof s.idle === "number" && s.idle >= IDLE_S);
}

// A picture of the page (in front by now), then one plain line.
async function textUser(tab: number, h: Handed): Promise<string> {
  const site = h.url && URL.canParse(h.url) ? new URL(h.url).hostname.replace(/^www\./, "") : "a site";
  const [what, until] = h.challenge ? ["a check", "clear it"] : ["you", "are done"];
  const line = `${process.env.SAFARI_HARNESS_AWAY === "1" ? "test of the bot-check alert: " : ""}${site} is waiting on ${what} in safari. the agent carries on by itself once you ${until}.`;
  await mkdir(STAGE, { recursive: true });
  const picture = join(STAGE, `safari-harness-${tab}-${Date.now()}.png`);
  try {
    const shot = await rpc("shot", { tab, out: picture }).then(() => undefined, (e: Error) => e.message);
    const r = await textOwner(line, shot ? undefined : picture);
    const missing = shot ?? r.picture;
    return missing ? `${r.status}, without the picture: ${missing}` : r.status;
  } finally {
    await rm(picture, { force: true });
  }
}

async function handoff(tab: number, why: string, ms = 60000): Promise<Handed> {
  const end = Date.now() + Math.min(ms, LIMIT_MS);
  const wait = async (o: { ms: number; away?: boolean; texted?: string; id?: number }) => (await rpc("handoff_wait", { tab, why, ...o })) as Handed;
  const first = await wait({ ms: 0 });
  let h = first;
  while (!h.done) {
    const texted = h.text ? await textUser(tab, h).catch((e: Error) => `not sent: ${e.message}`) : undefined;
    const left = end - Date.now();
    if (left <= 0 && texted === undefined) break;
    // A probe that fails reads as at the Mac: the notification is up either way.
    const away = texted === undefined && h.texted === undefined && (await isAway().catch(() => false));
    h = await wait({ ms: Math.max(0, Math.min(SLICE_MS, left)), away, texted, id: first.id });
  }
  // joined is this call's own (its later slices join its handoff too), and
  // id is only how they name it
  const out = { ...h };
  delete out.id;
  if (!first.joined) delete out.joined;
  return out;
}

export const HANDOFF_TOOLS: Record<string, Tool> = {
  handoff: {
    desc: "For a step only the user can do: a bot check (challenge in a result), a passkey, Touch ID. Shows them the tab and why (texts them if away); returns when done; done: false: call again.",
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
