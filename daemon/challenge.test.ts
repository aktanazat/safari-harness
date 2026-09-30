import { expect, test } from "bun:test";
import { classify, PROBE, type Challenge, type Facts } from "./challenge.ts";

// Saved walls and live pages as challengeFacts reported them in Safari
// (top frame; long tokens and the user's own details cut), and walls built
// from their vendor's documented markup, each with the check it shows or
// null. scripts/record-challenges.ts records the live ones again when the
// probe changes.
type Corpus = { asked: typeof PROBE; pages: { name: string; source: { url: string; saved?: string; built?: string }; expect: Challenge | null; frames: Facts[] }[] };
const corpus = (await Bun.file(new URL("./challenge-corpus.json", import.meta.url)).json()) as Corpus;

test.each(corpus.pages.map((p) => [p.name, p] as const))("%s is classified as recorded", (_name, page) => {
  expect(classify(page.frames) ?? null).toEqual(page.expect);
});

test("the corpus's live pages were asked everything the probe asks, so a new marker is tried on the normal pages", () => {
  expect(PROBE.markers.filter((m) => !corpus.asked.markers.includes(m))).toEqual([]);
  expect(PROBE.answers.filter((a) => !corpus.asked.answers.includes(a))).toEqual([]);
  expect(corpus.asked.textMax).toBe(PROBE.textMax);
});

// A tab's frames as challengeFacts in content.js reports them, top page
// first, for checks the corpus has no saved page of. The addresses and
// titles are the ones these checks showed.
const tab = (url: string, title: string, top: Partial<Facts> = {}, ...frames: Partial<Facts>[]): Facts[] => [
  { url, title, text: "", markers: [], answered: [], frames: [], ...top },
  ...frames.map((f) => ({ url: "", title: "", text: "", markers: [], answered: [], frames: [], ...f })),
];

const ANCHOR = "https://www.google.com/recaptcha/api2/anchor?ar=1&k=demo-key&co=x&hl=en&size=normal&cb=x";
const HCAPTCHA = "https://newassets.hcaptcha.com/captcha/v1/b1c589a/static/hcaptcha.html#frame=checkbox&id=0nmb6kw8d4g&host=accounts.hcaptcha.com";

test("a wall in front of the site is reported as the page", () => {
  // the title alone, or the address alone, before the rest of the wall has loaded
  expect(classify(tab("https://www.cars.com/vehicledetail/1/", "Just a moment..."))).toEqual({ kind: "cloudflare", where: "page" });
  expect(classify(tab("https://dl.acm.org/doi/10.1145/3544548?__cf_chl_rt_tk=Qm9", "dl.acm.org"))).toEqual({ kind: "cloudflare", where: "page" });
  expect(classify(tab("https://www.cvs.com/account-login/look-up", "Processing your request", { frames: ["https://www.cvs.com/_sec/cp_challenge/ak-challenge-4-5.htm"] })))
    .toEqual({ kind: "akamai", where: "page" });
  expect(classify(tab("https://discussions.apple.com/verify-human/verify.html?next=/thread/253008319", "Security Verification"))).toEqual({ kind: "apple", where: "page" });
});

test("DataDome's frame for a banned address is a block, not a check", () => {
  const frame = (t: string) => `https://geo.captcha-delivery.com/captcha/?initialCid=x&hash=x&cid=x&t=${t}&referer=x&s=1&e=x&dm=cd`;
  expect(classify(tab("https://www.tripadvisor.com/", "tripadvisor.com", { frames: [frame("bv")] }))).toEqual({ kind: "datadome", where: "block" });
  expect(classify(tab("https://www.tripadvisor.com/", "tripadvisor.com", { frames: [frame("fe")] }))).toEqual({ kind: "datadome", where: "page" });
});

test("a short page asking the reader to prove they are human is a check even from an unknown vendor", () => {
  const words = "Please verify you are a human to continue. Reference 8f2a";
  expect(classify(tab("https://shop.example.com/", "One moment", { text: words }))).toEqual({ kind: "other", where: "page" });
  // the same words inside an embedded frame leave the page itself readable
  expect(classify(tab("https://shop.example.com/", "Shop", {}, { url: "https://ads.example.net/", text: words }))).toBeUndefined();
});

test("a box counts until its token is in, and then the page around it is passed too", () => {
  const form = { text: "Sign up. Please verify you are human.", frames: [ANCHOR] };
  expect(classify(tab("https://shop.example.com/signup", "Sign up", form))).toEqual({ kind: "recaptcha", where: "box" });
  expect(classify(tab("https://shop.example.com/signup", "Sign up", { ...form, answered: ["[name='g-recaptcha-response']"] }))).toBeUndefined();
  expect(classify(tab("https://shop.example.com/", "Sign in", {}, { url: "https://login.example.com/", frames: [HCAPTCHA] }))).toEqual({ kind: "hcaptcha", where: "box" });
});

test("an invisible check and a wall inside an embedded frame are not reported", () => {
  expect(classify(tab("https://shop.example.com/", "Sign in", { frames: [HCAPTCHA.replace("frame=checkbox", "frame=checkbox-invisible")] }))).toBeUndefined();
  expect(classify(tab("https://shop.example.com/", "Shop", {}, { url: "https://ads.example.net/x?__cf_chl_rt_tk=1", title: "Just a moment..." }))).toBeUndefined();
});

// USCIS's signed-in pages load AWS's token script and show no check (09-30).
// AWS's check is its puzzle once drawn: where its CAPTCHA draws it, in
// place of the page, or in the box its CAPTCHA API draws on a page that
// otherwise reads.
test("AWS's puzzle is a check once drawn, in place of the page or in a box on it", () => {
  expect(classify(tab("https://shop.example.com/", "", { markers: ["#captcha-container .amzn-captcha-modal", ".amzn-captcha-modal"] }))).toEqual({ kind: "aws-waf", where: "page" });
  expect(classify(tab("https://my.example.gov/account", "Account", { markers: [".amzn-captcha-modal"] }))).toEqual({ kind: "aws-waf", where: "box" });
});
