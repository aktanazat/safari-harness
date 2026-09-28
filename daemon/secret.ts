// Codes typed without the agent seeing them. A type whose text has {{code}}
// (or with secret: "sms") waits for the code the site texted the user and
// types it there; secret: "passwords" types the code his Apple Passwords
// keeps for the site. The answer says only how many characters went in, so
// the code stays out of the transcript, the journal, and the logs: on
// 01a0e50b an agent typed an emailed code by hand and type echoed it back.
// Runs in the caller (call.ts), where Messages can be read (imessage.ts).
// Email has no code route in the harness, so it has no source here.

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
  if (source !== "sms") throw new Error('secret must be "sms" or "passwords"');
  const text = typeof a.text === "string" ? a.text : "";
  if (!text.includes(CODE)) throw new Error(`put ${CODE} in text where the texted code goes`);
  const got = await waitCode();
  const code = got.status === "received" ? got.code : undefined;
  if (code === undefined) throw new Error("no code came by text in 30 s; have the site send it again, then call type again");
  const answer = await rpc("type", { ...a, secret: true, text: text.replaceAll(CODE, code) }, model);
  return answer && typeof answer === "object" && "ok" in answer ? { ...answer, typed: `code, ${code.length} chars` } : answer;
}
