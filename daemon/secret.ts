// Codes typed without the agent seeing them. A type whose text has {{code}}
// (or with secret: "sms") waits for the code the site texted the user and
// types it there; secret: "page" types the one code shown in tab from (an
// opened email), within from_selector when given; secret: "env" types the
// value of variable env in the caller's environment; secret: "passwords"
// types the code his Apple Passwords keeps for the site. real_input's type
// takes the same, for a field that ignores scripted typing. The answer says
// only how many characters went in, so the code stays out of the transcript,
// the journal, and the logs: on 01a0e50b an agent typed an emailed code by hand
// and type echoed it back. Runs in the caller (call.ts), where Messages can
// be read (imessage.ts).

import { FILL_TOOLS } from "./fill.ts";
import { nameIn } from "./guard.ts";
import { waitCode } from "./imessage.ts";
import { rpc } from "./rpc.ts";

const CODE = "{{code}}";

// A type or real_input call that needs a code filled in. real_input's text
// may come as type (guard.ts).
export function secretType(tool: string, args: Record<string, unknown>): boolean {
  const coded = [args.text, args.type].some((t) => typeof t === "string" && t.includes(CODE));
  return nameIn(["type", "real_input"], tool) !== undefined && (args.secret !== undefined || coded);
}

// Types the code a's source gives with put, which types text as its tool
// does. model: the call is one a model wrote, which the daemon watches
// (guard.ts). caller: the environment secret "env" reads (heldValue).
export async function typeSecret(a: Record<string, unknown>, model: boolean, put: (text: string) => Promise<unknown>, caller?: CallerEnv): Promise<unknown> {
  const source = a.secret ?? "sms";
  if (source === "passwords") {
    // Apple Passwords finds the page's code field and types into it itself.
    const r = await FILL_TOOLS.passwords.run({ do: "code", tab: a.tab });
    return r && typeof r === "object" && !("paired" in r) ? { ...r, typed: "code" } : r;
  }
  if (source !== "sms" && source !== "page" && source !== "env") throw new Error('secret must be "sms", "page", "env", or "passwords"');
  const text = typeof a.text === "string" ? a.text : "";
  if (!text.includes(CODE)) throw new Error(`put ${CODE} in text where the code goes`);
  const code = source === "sms" ? await textedCode() : source === "page" ? await shownCode(a.from, a.from_selector, model) : heldValue(a.env, caller);
  // however the page shows it again, the tab's answers have it cut from
  // here on (redact.ts)
  await rpc("keep_secret", { tab: a.tab, texts: [code] });
  const answer = await put(text.replaceAll(CODE, code));
  return answer && typeof answer === "object" && "ok" in answer ? { ...answer, typed: `code, ${code.length} chars` } : answer;
}

async function textedCode(): Promise<string> {
  const got = await waitCode();
  if (got.status !== "received") throw new Error("no code came by text in 30 s; have the site send it again, then call type again");
  return got.code;
}

// The environment of whoever ran the safari CLI, which hands it to its
// tool call (cli/safari.ts), as a vault's runner sets it: mem-secret run
// VAR -- safari ... An MCP server's or a safari do session's own
// environment is no caller's, and holds keys of its own (SAFARI_MODEL_KEY)
// that a page's text could ask a model to type into the page.
export type CallerEnv = Record<string, string | undefined>;

// The value of variable name in the caller's environment. On 10-05 a new
// password, a sign-in code, and a reset link each went through a file on
// disk to reach their fields, since type took none of them from there.
function heldValue(name: unknown, caller: CallerEnv | undefined): string {
  if (typeof name !== "string" || !name) throw new Error('secret "env" needs env: the name of the variable that holds the value');
  const run = `mem-secret run ${name} -- safari type <ref> '{{code}}' --tab N --secret env --env ${name}`;
  if (!caller) throw new Error(`secret "env" reads only the environment of a safari CLI call, as in: ${run}`);
  const value = caller[name];
  if (!value) throw new Error(`environment variable ${name} is empty or not set; set it in the environment of the safari CLI call, as in: ${run}`);
  return value;
}

// The one code tab from shows: a run of 4 to 8 digits standing alone, or
// of 6 to 8 capital letters and digits with both (GEICO's, 09-30) on a
// line that says code, or just under one, since such a run elsewhere is an
// order or policy number; 6 long when there are several lengths. A run
// touching a letter is part of a word, as the "recentdata" Gmail puts after
// Delta's footer (09-29), and one after © is a year: Gmail's page for a
// thread it could not find typed its footer's 2026 into TikTok's code field
// (10-02). Any other count is an error that says only how many, never which.
async function shownCode(from: unknown, selector: unknown, model: boolean): Promise<string> {
  if (typeof from !== "number") throw new Error('secret "page" needs from: the tab that shows the code, such as the opened email');
  if (selector !== undefined && (typeof selector !== "string" || !selector.trim())) throw new Error("from_selector must be a nonempty CSS selector for one email or message");
  const page = await rpc("extract", { tab: from, ...(selector === undefined ? {} : { selector, strict_selector: true }) }, model);
  const shown = page && typeof page === "object" && "text" in page && typeof page.text === "string" ? page.text : "";
  const mixed = [...shown.matchAll(/(?<![\w.,:/-])(?=[A-Z\d]*\d)(?=[A-Z\d]*[A-Z])[A-Z\d]{6,8}(?![\w.,:/-])/g)].filter((m) => {
    const lines = shown.slice(0, m.index).split("\n");
    const own = lines.pop() ?? "";
    return /\b(?:code|passcode|otp|pin)\b/i.test(own.trim() ? own : lines.findLast((l) => l.trim()) ?? "");
  });
  const all = [...new Set([...(shown.match(/(?<![\w.,:/-]|©\s?)\d{4,8}(?![\w.,:/-])/g) ?? []), ...mixed.map((m) => m[0])])];
  const six = all.filter((c) => c.length === 6);
  const codes = six.length ? six : all;
  if (codes.length !== 1) throw new Error(`tab ${from} shows ${codes.length} codes, not one; open the email with the code in that tab, or use from_selector to select one email or message in the thread, then call type again`);
  return codes[0];
}
