import { expect, test } from "bun:test";
import { classify, type Facts } from "./challenge.ts";

// A tab's frames as challengeFacts in content.js reports them, top page
// first. The addresses and titles are the ones these checks showed.
const tab = (url: string, title: string, top: Partial<Facts> = {}, ...frames: Partial<Facts>[]): Facts[] => [
  { url, title, markers: [], answered: [], frames: [], ...top },
  ...frames.map((f) => ({ url: "", title: "", markers: [], answered: [], frames: [], ...f })),
];

const ANCHOR = "https://www.google.com/recaptcha/api2/anchor?ar=1&k=demo-key&co=x&hl=en&size=normal&cb=x";
const HCAPTCHA = "https://newassets.hcaptcha.com/captcha/v1/b1c589a/static/hcaptcha.html#frame=checkbox&id=0nmb6kw8d4g&host=accounts.hcaptcha.com";

test("a wall in front of the site is reported as the page", () => {
  expect(classify(tab("https://www.cars.com/vehicledetail/1/", "Just a moment..."))).toEqual({ kind: "cloudflare", where: "page" });
  expect(classify(tab("https://dl.acm.org/doi/10.1145/3544548?__cf_chl_rt_tk=Qm9", "dl.acm.org"))).toEqual({ kind: "cloudflare", where: "page" });
  expect(classify(tab("https://www.cvs.com/account-login/look-up", "Processing your request", { frames: ["https://www.cvs.com/_sec/cp_challenge/ak-challenge-4-5.htm"] })))
    .toEqual({ kind: "akamai", where: "page" });
  expect(classify(tab("https://discussions.apple.com/verify-human/verify.html?next=/thread/253008319", "Security Verification"))).toEqual({ kind: "apple", where: "page" });
  expect(classify(tab("https://www.zillow.com/homes/", "Access to this page has been denied", { markers: ["#px-captcha"] }))).toEqual({ kind: "perimeterx", where: "page" });
  expect(classify(tab("https://www.footlocker.com/", "footlocker.com", { frames: ["https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqA"] })))
    .toEqual({ kind: "datadome", where: "page" });
});

test("a check box in the page, or in one of its frames, counts until its token is in", () => {
  expect(classify(tab("https://www.google.com/recaptcha/api2/demo", "ReCAPTCHA demo", { frames: [ANCHOR] }))).toEqual({ kind: "recaptcha", where: "box" });
  expect(classify(tab("https://www.google.com/recaptcha/api2/demo", "ReCAPTCHA demo", { frames: [ANCHOR], answered: ["[name='g-recaptcha-response']"] }))).toBeUndefined();
  expect(classify(tab("https://shop.example.com/", "Sign in", {}, { url: "https://login.example.com/", frames: [HCAPTCHA] }))).toEqual({ kind: "hcaptcha", where: "box" });
});

test("an invisible check and a page about CAPTCHAs are not reported", () => {
  expect(classify(tab("https://shop.example.com/", "Shop", { frames: [ANCHOR.replace("size=normal", "size=invisible")] }))).toBeUndefined();
  expect(classify(tab("https://shop.example.com/", "Sign in", { frames: [HCAPTCHA.replace("frame=checkbox", "frame=checkbox-invisible")] }))).toBeUndefined();
  expect(classify(tab("https://en.wikipedia.org/wiki/CAPTCHA", "CAPTCHA - Wikipedia"))).toBeUndefined();
  // a wall inside an embedded frame (an ad's) leaves the page itself readable
  expect(classify(tab("https://shop.example.com/", "Shop", {}, { url: "https://ads.example.net/x?__cf_chl_rt_tk=1", title: "Just a moment..." }))).toBeUndefined();
});
