// handoff, the caller's half: gives the user the tab for a step only they
// can take (a bot check, a passkey, Touch ID). The daemon holds the handoff
// (handoffWait in tools.ts): it brings the tab to the front with a
// notification, watches the page, and gives back the tab and app the user
// had in front once they are done. This half alerts their phone when they
// are away from the Mac, once per handoff, with a picture of the page, and
// puts the handoff in Akyl's phone app beside the alert, where they can clear
// it with the window live. They cannot answer the alert; the handoff ends
// when the page clears, or shows the text until names. A background call
// starts or checks on the handoff, sends the alert if one is due, and returns
// at once: its agent goes on with other steps and checks back with the id
// the first one returned.

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Challenge } from "./challenge.ts";
import { akyl, alert, dataFile, isAway, readJson } from "./phone.ts";
import { rpc } from "./rpc.ts";
import { resolveTab, TAB, type Tool } from "./tools.ts";
import { rowsOf } from "./tabs-view.ts";

// An MCP client set up as README.md says gives up on a tool call at 130 s,
// and its agent hears nothing: on 10-05 a handoff on AWS's captcha page had
// not answered by then, so the agent never called again and the captcha ran
// out. So a call answers within its ms, at most LIMIT_MS, of its start,
// whatever finding the tab, the away probe, the alert, or the daemon still
// have under way; the 20 s left are for the MCP server's own steps around
// the call. Within a call, the daemon is asked in slices, so a user who
// walks away midway is alerted within a slice.
const LIMIT_MS = 110000;
const SLICE_MS = 15000;

// alert: true tells this call to send the alert; alerted is how it went.
type Handed = { done: boolean; waitedMs: number; url?: string; title?: string; challenge?: Challenge; byItself?: true; joined?: true; alerted?: string; alert?: true; id?: number; hint?: string };

// Who checks the page, by the kind challenge.ts names, for the card's title.
const VENDOR: Record<string, string> = { cloudflare: "Cloudflare", akamai: "Akamai", datadome: "DataDome", imperva: "Imperva", perimeterx: "HUMAN", "aws-waf": "AWS", kasada: "Kasada", apple: "Apple", recaptcha: "reCAPTCHA", hcaptcha: "hCaptcha", arkose: "Arkose", geetest: "GeeTest" };

// The handoff as Akyl's app shows it (akyl in phone.ts). Sent again while
// calls wait on it, it stays up as long as the daemon would watch it with no
// call waiting: 5 minutes, or 30 for one a background call started.
function card(tab: number, why: string, h: Handed, background: boolean): Record<string, unknown> {
  const site = h.url && URL.canParse(h.url) ? new URL(h.url).hostname.replace(/^www\./, "") : "a site";
  const reason = h.challenge ? "botCheck" : /passkey/i.test(why) ? "passkey" : /touch id|face id|fingerprint/i.test(why) ? "biometric" : /sign.?in|log.?in|password|code/i.test(why) ? "login" : "other";
  return {
    key: `safari-${tab}-${h.id}`,
    reason,
    title: h.challenge ? `${VENDOR[h.challenge.kind] ?? "Bot"} check on ${site}` : `${site} needs you`,
    task: why,
    app: "Safari",
    ...(h.title ? { window: h.title } : {}),
    from: "Safari helper",
    minutes: background ? 30 : 5,
  };
}

// A picture of the page (in front by now), with one plain line under it.
async function alertUser(tab: number, h: Handed, end: number, shown: Record<string, unknown>): Promise<string> {
  const site = h.url && URL.canParse(h.url) ? new URL(h.url).hostname.replace(/^www\./, "") : "a site";
  const [what, until] = h.challenge ? ["a check", "clear it"] : ["you", "are done"];
  const viewer = readJson(dataFile("screen-viewer.json"));
  const link = typeof viewer === "string" ? `\n\nopen your mac:\n${viewer}` : "";
  const line = `${process.env.SAFARI_HARNESS_AWAY === "1" ? "test of the bot-check alert: " : ""}${site} is waiting on ${what} in safari on your mac. the agent carries on by itself once you ${until}.${link}`;
  const picture = join(tmpdir(), `safari-harness-${tab}-${Date.now()}.png`);
  try {
    const shot = await rpc("shot", { tab, out: picture }).then(() => undefined, (e: Error) => e.message);
    // The call may have ended while the picture was being taken. Remove
    // that late picture, but do not start a phone send after the deadline.
    if (Date.now() >= end) return "not sent: the call ended before the picture arrived";
    await alert(line, shot ? undefined : picture, () => akyl("/handoff", shown));
    return shot ? `sent, without the picture: ${shot}` : "sent";
  } finally {
    await rm(picture, { force: true });
  }
}

// Each await shares one deadline, including finding the tab. When it wins,
// this call stops; only the daemon keeps watching the handoff. An alert
// already sending cannot be recalled, and its late outcome is not reported
// by a continuation: a CLI caller exits as soon as it prints the answer.
async function handoff(given: unknown, why: string, ms = 60000, until?: string, background = false, id?: number): Promise<Handed> {
  const start = Date.now();
  const end = start + Math.min(ms, LIMIT_MS);
  const expired = Symbol("handoff deadline");
  let timer: Timer | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired), Math.max(0, end - Date.now())); });
  const beforeEnd = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
  let first: Handed | undefined;
  let h: Handed = { done: false, waitedMs: 0 };
  let heardAt = start;
  let lastAway: boolean | undefined;
  try {
    const tab = await beforeEnd(resolveTab(given, async () => rowsOf(await rpc("tabs"))));
    if (Date.now() < end) {
      // Once the alert went, Akyl's card follows each answer: kept up while
      // the user has the step, ended with the handoff.
      const wait = async (o: { ms: number; away?: boolean; alerted?: string; id?: number; until?: string; background?: true }) => {
        try {
          h = (await beforeEnd(rpc("handoff_wait", { tab, why, ...o }))) as Handed;
        } catch (e) {
          // the tab closed, or the site blocked the browser: nobody can do the step now
          if (e !== expired && h.alerted?.startsWith("sent")) await akyl("/handoff/end", { key: `safari-${tab}-${h.id}`, state: "cancelled" }).catch(() => undefined);
          throw e;
        }
        heardAt = Date.now();
        if (h.alerted?.startsWith("sent")) {
          if (h.done) await beforeEnd(akyl("/handoff/end", { key: `safari-${tab}-${h.id}`, state: "done" }).catch(() => undefined));
          else void akyl("/handoff", card(tab, why, h, background)).catch(() => undefined);
        }
        return h;
      };
      // until and background go with the call that starts the handoff; the
      // later ones join it, and a background check names it by id
      first = await wait({ ms: 0, ...(until === undefined ? {} : { until }), ...(background ? { background: true } : {}), ...(id === undefined ? {} : { id }) });
      while (!h.done && Date.now() < end) {
        const alerted = h.alert ? await beforeEnd(alertUser(tab, h, end, card(tab, why, h, background)).catch((e: Error) => `not sent: ${e.message}`)) : undefined;
        if (alerted !== undefined) h = { ...h, alerted };
        // A probe that fails reads as at the Mac: the notification is up either way.
        const away = alerted === undefined && h.alerted === undefined && (await beforeEnd(isAway().catch(() => false)));
        if (alerted === undefined && h.alerted === undefined) lastAway = away;
        const left = end - Date.now();
        if (left <= 0) break;
        await wait({ ms: background ? 0 : Math.min(SLICE_MS, left), away, id: first.id, ...(alerted === undefined ? {} : { alerted }) });
        // a background call stays only to send the alert it was asked to
        if (background && !h.alert) break;
      }
    }
  } catch (e) {
    if (e !== expired) throw e;
  } finally {
    clearTimeout(timer);
  }
  return answer({ ...h, waitedMs: h.waitedMs + (h.done ? 0 : Date.now() - heardAt), alerted: h.alerted ?? (lastAway === false ? "not sent: at the Mac" : "not sent yet") }, first, background);
}

// joined is this call's own (its later slices join its handoff too); alert
// passes only between it and the daemon, and so does id, but for a
// background call, whose agent checks back with it. alerted is always
// there: on 09-29 two handoffs that ran out said nothing of the user's
// phone, so the agent could not tell a user at the Mac from an alert that
// never went.
function answer(h: Handed, first: Handed | undefined, background: boolean): Handed {
  const out: Handed = { ...h, alerted: h.alerted ?? "not sent: at the Mac" };
  if (!background) delete out.id;
  delete out.alert;
  if (out.alerted === "sending") out.alerted = "sending; outcome not confirmed";
  if (!out.done) {
    out.hint = !background ? "call handoff again on the same tab"
      : h.id === undefined ? "call handoff with background again on the same tab"
      : `the user has the tab: go on with other steps, then call handoff with background and id ${h.id} on this tab to see whether he is done`;
  }
  if (!first?.joined) delete out.joined;
  return out;
}

export const HANDOFF_TOOLS: Record<string, Tool> = {
  handoff: {
    desc: "For a step only the user can do: a bot check (challenge in a result), passkey, Touch ID. Shows him the tab and why, alerts his phone if he is away; returns when done; done: false: call again. background: returns at once; check with its id.",
    params: {
      tab: TAB,
      why: { type: "string", description: "what to do, for the notice" },
      ms: { type: "number", description: "default 60000, max 110000" },
      until: { type: "string", description: "text shown once done" },
      background: { type: "boolean", description: "return at once" },
      id: { type: "number", description: "a background handoff's" },
    },
    required: ["tab", "why"],
    run: async (a) => {
      if (typeof a.why !== "string") throw new Error("why must be a string");
      if (a.until !== undefined && typeof a.until !== "string") throw new Error("until must be text the page shows once the user is done");
      const ms = a.ms === undefined ? undefined : Number(a.ms);
      if (ms !== undefined && !Number.isFinite(ms)) throw new Error("ms must be a number");
      const id = a.id === undefined ? undefined : Number(a.id);
      if (id !== undefined && !Number.isInteger(id)) throw new Error("id must be the number a background handoff returned");
      return handoff(a.tab, a.why, ms, a.until, a.background === true, id);
    },
  },
};
