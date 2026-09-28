// Bot checks: CAPTCHAs, press-and-hold buttons, and the walls Cloudflare,
// Akamai, DataDome, and others put in front of a page. They are the user's
// to pass; the harness never solves one. It notices one, so open, goto,
// snapshot, and a missed wait can say so, and handoff can tell when the
// user is done with it.

import { bridge } from "./bridge.ts";

// where is "page" when the check stands in for the whole page, "box" when
// it is a box inside a page that otherwise reads normally (often on a form).
export type Challenge = { kind: string; where: "page" | "box" };

// What one frame of the tab shows (challengeFacts in content.js), top page
// first: its address and title, which MARKERS it shows (a script or an
// iframe counts by being there), which ANSWERS hold a token, and the
// addresses of the frames it shows on the page.
export type Facts = { url: string; title: string; markers: string[]; answered: string[]; frames: string[] };

// url and title are the top page's; markers and frames are looked for in
// every frame. A check with an answer field counts until that field holds
// its token.
type Rule = Challenge & { url?: RegExp; title?: RegExp; markers?: string[]; frames?: RegExp; answer?: string };

const RULES: Rule[] = [
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
  { kind: "perimeterx", where: "page", markers: ["#px-captcha"] },
  { kind: "aws-waf", where: "page", markers: ["script[src*='.captcha.awswaf.com/']"] },
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
  { kind: "cloudflare", where: "box", markers: [".cf-turnstile"], frames: /^https:\/\/challenges\.cloudflare\.com\//, answer: "[name='cf-turnstile-response']" },
  { kind: "arkose", where: "box", frames: /^https:\/\/([\w-]+\.)*(arkoselabs\.com|funcaptcha\.com)\// },
  { kind: "geetest", where: "box", markers: [".geetest_box", ".geetest_panel_box"] },
];

export const MARKERS = [...new Set(RULES.flatMap((r) => r.markers ?? []))];
export const ANSWERS = RULES.flatMap((r) => (r.answer ? [r.answer] : []));

function shows(rule: Rule, frames: Facts[]): boolean {
  const top = frames[0];
  if (rule.url?.test(top.url) || rule.title?.test(top.title)) return true;
  const seen = frames.some((f) => f.markers.some((m) => rule.markers?.includes(m)) || f.frames.some((u) => rule.frames?.test(u)));
  const answer = rule.answer;
  return seen && !(answer && frames.some((f) => f.answered.includes(answer)));
}

export function classify(frames: Facts[]): Challenge | undefined {
  if (!frames.length) return undefined;
  const rule = RULES.find((r) => shows(r, frames));
  return rule && { kind: rule.kind, where: rule.where };
}

function isFacts(f: unknown): f is Facts {
  return !!f && typeof f === "object" && "url" in f && typeof f.url === "string" && "title" in f && typeof f.title === "string"
    && "markers" in f && Array.isArray(f.markers) && "answered" in f && Array.isArray(f.answered) && "frames" in f && Array.isArray(f.frames);
}

// The check the tab shows, if any. It adds a note to another tool's result,
// so a tab that cannot answer within 2 s (busy, or gone) reads as showing none
// rather than failing that tool.
export async function challengeOf(tab: number): Promise<Challenge | undefined> {
  const frames = await bridge.request("probe", [tab, "challenge", { markers: MARKERS, answers: ANSWERS }], 2000).catch(() => []);
  return classify(Array.isArray(frames) ? frames.filter(isFacts) : []);
}
