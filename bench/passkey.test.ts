import { expect } from "bun:test";
import { benchRows, type Step } from "./bench.ts";

// On 11-19 an agent's click on Google's passkey Continue sent the sign-in to
// its error page: Safari refuses a passkey to a scripted click and to a press
// behind his windows, and the site counts each refused try.
const counted = (key: string, result: string): Step => ({ op: "eval", args: [`document.body.dataset.${key}`], answer: { value: { ok: true, result } } });
const refused = { error: expect.stringContaining("passkey"), failure: { code: "stale_view", effect: "none", retryable: false, next: expect.stringContaining("handoff") } };

benchRows("passkey controls in WebKit", [
  {
    name: "a passkey's Continue is refused to a scripted click and a background press before the page hears of it, while the real mouse in front and Try another way still reach their controls",
    page: "passkey.html",
    steps: [
      { op: "click", args: ["#continue"], answer: refused },
      { op: "pressMark", args: ["#continue"], answer: refused },
      { op: "locate", args: ["#continue", { act: true }], answer: { value: { width: expect.any(Number) } } },
      counted("continued", "0"),
      { op: "click", args: ["#another"], answer: { value: { ok: true } } },
      counted("other", "1"),
    ],
  },
]);
