// Bot checks: CAPTCHAs, press-and-hold buttons, and the walls Cloudflare,
// Akamai, DataDome, and others put in front of a page. They are the user's
// to pass; the harness never solves one. It notices one, so open, goto,
// snapshot, and a missed wait can say so, and handoff can tell when the
// user is done with it.

import { bridge } from "./bridge.ts";

// where is "page" when the check stands in for the whole page, "box" when
// it is a box inside a page that otherwise reads normally (often on a form),
// and "block" when the site turns the browser away with no check to pass:
// the user cannot clear that either, so it is reported, never handed off.
export type Challenge = { kind: string; where: "page" | "box" | "block" };

// What one frame of the tab shows (challengeFacts in content.js), top page
// first: its address and title, its text when that is at most TEXT_MAX
// characters (a wall says what it is in a few lines; a longer page reads as
// ""), which MARKERS it shows (a script or an iframe counts by being there),
// which ANSWERS hold a token, and the addresses of the frames it shows on
// the page.
export type Facts = { url: string; title: string; text: string; markers: string[]; answered: string[]; frames: string[] };

// url, title, text, and topMarkers are the top page's; markers and frames
// are looked for in every frame. The first rule the tab shows names its
// check, so a vendor's block comes before its check, and wording no vendor
// claims comes last. A check with an answer field counts until that field
// holds its token.
type Rule = Challenge & { url?: RegExp; title?: RegExp; text?: RegExp; topMarkers?: string[]; markers?: string[]; frames?: RegExp; answer?: string };

const RULES: Rule[] = [
  // Blocks: the site refuses the browser outright.
  {
    kind: "cloudflare",
    where: "block",
    title: /^(attention required! \| cloudflare|access denied \| .+ used cloudflare to restrict access)$/i,
    text: /\bsorry, you have been blocked\b/i,
  },
  { kind: "akamai", where: "block", text: /\byou don.t have permission to access .+ on this server\. reference #\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+\b/i },
  // DataDome's frame says t=bv when it has banned the address, t=fe when it asks for a slider.
  { kind: "datadome", where: "block", frames: /^https:\/\/([\w-]+\.)*captcha-delivery\.com\/captcha\/\?([^#]*&)?t=bv(&|#|$)/ },
  { kind: "imperva", where: "block", text: /\bthis request was blocked by our security service\b/i },
  // Walls: the site shows only the check until it is passed.
  {
    kind: "cloudflare",
    where: "page",
    url: /[?&]__cf_chl_\w*tk=/,
    title: /^(just a moment|un instant|einen moment|un momento|um momento|even geduld)\s*(\.\.\.|…)/i,
    markers: ["#challenge-stage", "#challenge-running", "#cf-challenge-running", "script[src*='/challenge-platform/'][src*='chl_page']"],
  },
  { kind: "akamai", where: "page", markers: ["iframe#sec-cpt-if", "#sec-if-cpt-container", "iframe[title='Challenge Content']"], frames: /\/_sec\/cp_challenge\// },
  { kind: "datadome", where: "page", frames: /^https:\/\/([\w-]+\.)*captcha-delivery\.com\// },
  {
    kind: "perimeterx",
    where: "page",
    title: /^access to this page has been denied\.?$/i,
    text: /\b(press|activate) (&|and) hold\b/i,
    markers: ["#px-captcha"],
  },
  // AWS WAF's CAPTCHA wall runs captcha.js from its captcha host, and its
  // silent wall runs challenge.js from its token host as the whole page. A
  // page that only uses AWS's SDK loads challenge.js from sdk.awswaf.com.
  { kind: "aws-waf", where: "page", markers: ["script[src*='.captcha.awswaf.com/']"], topMarkers: ["script[src*='.token.awswaf.com/'][src*='/challenge.js']"] },
  // Kasada answers a first visit with a blank page that runs ips.js from
  // this fixed path. Every page it guards loads the same page again in a
  // hidden frame, so only the top page running it is the wall.
  { kind: "kasada", where: "page", topMarkers: ["script[src*='/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js']"] },
  // Imperva (Incapsula) fills the page with one frame, CWUDNSAI, that holds
  // a CAPTCHA or an incident notice, and the top page cannot tell which.
  // Its bot defense, once Distil's, says it took the browser for a bot.
  {
    kind: "imperva",
    where: "page",
    text: /\bsomething about your browser made us think you were a bot\b/i,
    frames: /\/_Incapsula_Resource\?([^#]*&)?CWUDNSAI=/,
  },
  { kind: "apple", where: "page", url: /^https:\/\/([\w-]+\.)*apple\.com\/verify-human\// },
  { kind: "recaptcha", where: "page", url: /^https:\/\/(www\.)?google\.[a-z.]+\/sorry\// },
  // Boxes in a page. An invisible reCAPTCHA (the corner badge) or hCaptcha
  // asks the user nothing unless it opens its puzzle, which is a frame of its own.
  {
    kind: "recaptcha",
    where: "box",
    frames: /^https:\/\/(www\.)?(google\.com|recaptcha\.net)\/recaptcha\/(api2|enterprise)\/(anchor|bframe)\?(?![^#]*size=invisible)/,
    answer: "[name='g-recaptcha-response']",
  },
  { kind: "hcaptcha", where: "box", frames: /^https:\/\/([\w-]+\.)*hcaptcha\.com\/captcha\/[^#]*#frame=(checkbox|challenge)(&|$)/, answer: "[name='h-captcha-response']" },
  // An explicitly rendered Turnstile has no .cf-turnstile class and draws its
  // frame in a closed shadow root, so its box is the parent of its answer field.
  {
    kind: "cloudflare",
    where: "box",
    markers: [".cf-turnstile", ":has(> [name='cf-turnstile-response'])"],
    frames: /^https:\/\/challenges\.cloudflare\.com\//,
    answer: "[name='cf-turnstile-response']",
  },
  { kind: "arkose", where: "box", frames: /^https:\/\/([\w-]+\.)*(arkoselabs\.com|funcaptcha\.com)\// },
  { kind: "geetest", where: "box", markers: [".geetest_box", ".geetest_panel_box"] },
  // A short page asking the reader to prove they are a person, from a vendor
  // no rule above knows.
  {
    kind: "other",
    where: "page",
    text: /\b(verify|verifying|confirm) (that )?you(['’]re| are) (a )?human\b|\bare you (a )?(human|robot)\b|\brobot or human\b|\bnot a (ro)?bot\b|\bchecking (if the site connection is secure|your browser)\b/i,
  },
];

export const TEXT_MAX = 2000;
// What challengeFacts is asked for, in every frame.
export const PROBE = {
  markers: [...new Set(RULES.flatMap((r) => [...(r.topMarkers ?? []), ...(r.markers ?? [])]))],
  answers: RULES.flatMap((r) => (r.answer ? [r.answer] : [])),
  textMax: TEXT_MAX,
};

// The first rule the tab shows names its check. A box that holds its token
// is passed, and so is the page around it, whose words may still ask for it.
export function classify(frames: Facts[]): Challenge | undefined {
  const top = frames[0];
  if (!top) return undefined;
  for (const rule of RULES) {
    const seen = rule.url?.test(top.url) || rule.title?.test(top.title) || rule.text?.test(top.text) || top.markers.some((m) => rule.topMarkers?.includes(m))
      || frames.some((f) => f.markers.some((m) => rule.markers?.includes(m)) || f.frames.some((u) => rule.frames?.test(u)));
    if (!seen) continue;
    const answer = rule.answer;
    return answer && frames.some((f) => f.answered.includes(answer)) ? undefined : { kind: rule.kind, where: rule.where };
  }
  return undefined;
}

function isFacts(f: unknown): f is Facts {
  return !!f && typeof f === "object" && "url" in f && typeof f.url === "string" && "title" in f && typeof f.title === "string"
    && "text" in f && typeof f.text === "string" && "markers" in f && Array.isArray(f.markers) && "answered" in f && Array.isArray(f.answered)
    && "frames" in f && Array.isArray(f.frames);
}

// The check the tab shows, if any, or null when the top page did not answer
// within 2 s (the tab is busy, loading, or gone). A note on another tool's
// result reads null as none rather than failing that tool; handoff waits on.
export async function challengeOf(tab: number): Promise<Challenge | null | undefined> {
  const frames = await bridge.request("probe", [tab, "challenge", PROBE], 2000).catch(() => []);
  const facts = Array.isArray(frames) ? frames.filter(isFacts) : [];
  // the extension lists the top page, frame 0, first
  return facts[0] && "frame" in facts[0] && facts[0].frame === 0 ? classify(facts) : null;
}
