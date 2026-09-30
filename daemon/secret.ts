// Codes typed without the agent seeing them. A type whose text has {{code}}
// (or with secret: "sms") waits for the code the site texted the user and
// types it there; secret: "page" types the one code shown in tab from (an
// opened email); secret: "passwords" types the code his Apple Passwords
// keeps for the site. The answer says only how many characters went in, so
// the code stays out of the transcript, the journal, and the logs: on
// 01a0e50b an agent typed an emailed code by hand and type echoed it back.
// Runs in the caller (call.ts), where Messages can be read (imessage.ts).

import { FILL_TOOLS } from "./fill.ts";
import { nameIn } from "./guard.ts";
import { waitCode } from "./imessage.ts";
import { rpc } from "./rpc.ts";

const CODE = "{{code}}";

// A type call that needs a code filled in.
export function secretType(tool: string, args: Record<string, unknown>): boolean {
  return nameIn(["type"], tool) !== undefined && (args.secret !== undefined || (typeof args.text === "string" && args.text.includes(CODE)));
}

// model: the call is one a model wrote, which the daemon watches (guard.ts).
export async function typeSecret(a: Record<string, unknown>, model: boolean): Promise<unknown> {
  const source = a.secret ?? "sms";
  if (source === "passwords") {
    // Apple Passwords finds the page's code field and types into it itself.
    const r = await FILL_TOOLS.passwords.run({ do: "code", tab: a.tab });
    return r && typeof r === "object" && !("paired" in r) ? { ...r, typed: "code" } : r;
  }
  if (source !== "sms" && source !== "page") throw new Error('secret must be "sms", "page", or "passwords"');
  const text = typeof a.text === "string" ? a.text : "";
  if (!text.includes(CODE)) throw new Error(`put ${CODE} in text where the code goes`);
  const code = source === "sms" ? await textedCode() : await shownCode(a.from, model);
  const answer = await rpc("type", { ...a, secret: true, text: text.replaceAll(CODE, code) }, model);
  return answer && typeof answer === "object" && "ok" in answer ? { ...answer, typed: `code, ${code.length} chars` } : answer;
}

async function textedCode(): Promise<string> {
  const got = await waitCode();
  if (got.status !== "received") throw new Error("no code came by text in 30 s; have the site send it again, then call type again");
  return got.code;
}

// The one code tab from shows: a run of 4 to 8 digits standing alone,
// 6 long when there are several lengths. A run touching a letter is part
// of a word, as the "recentdata" Gmail puts after Delta's footer (09-29).
// Any other count is an error that says only how many, never which.
async function shownCode(from: unknown, model: boolean): Promise<string> {
  if (typeof from !== "number") throw new Error('secret "page" needs from: the tab that shows the code, such as the opened email');
  const page = await rpc("extract", { tab: from }, model);
  const shown = page && typeof page === "object" && "text" in page && typeof page.text === "string" ? page.text : "";
  const all = [...new Set(shown.match(/(?<![\w.,:/-])\d{4,8}(?![\w.,:/-])/g) ?? [])];
  const six = all.filter((c) => c.length === 6);
  const codes = six.length ? six : all;
  if (codes.length !== 1) throw new Error(`tab ${from} shows ${codes.length} codes, not one; open the email with the code in that tab (in a thread of several code emails, remove the older messages from the page with eval), then call type again`);
  return codes[0];
}
