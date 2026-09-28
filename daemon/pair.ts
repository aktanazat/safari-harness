// Pairing Apple Passwords without the chat. A call that finds it locked
// asks the user to approve with Touch ID, the daemon pairs, and the code the
// Mac then shows is read off the helper's window (scripts/pairing, with the
// terminal's Accessibility access). Where it cannot be read, a prompt on
// the Mac asks him to type the code, the answer hidden as he types, and the
// digits go straight to the daemon: the agent learns only whether it
// paired. He once took 7 minutes to send the code through the chat. The
// code shows only on the Mac, so while he is away the call says he must
// come to it. Runs in the caller, as fill.ts does.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { frontApp, input } from "./front.ts";
import { isAway } from "./phone.ts";
import { rpc } from "./rpc.ts";

const execFileAsync = promisify(execFile);
const PAIRING = join(import.meta.dir, "..", "scripts", "pairing");
// How long the prompt waits for him.
const PROMPT_S = 180;

export type Paired = { paired: true } | { paired: false; why: string };

// Runs scripts/pairing and parses its one JSON line; failures carry its stderr.
async function pairing(args: string[], timeout: number): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync(PAIRING, args, { timeout });
    return JSON.parse(stdout);
  } catch (e) {
    const stderr = typeof e === "object" && e !== null && "stderr" in e ? String(e.stderr).trim() : "";
    throw new Error(`pairing ${args[0]} failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  }
}

// Touch ID, or his login password where there is no sensor: {approved},
// and {why} when he declines; undefined when no prompt could be shown.
export async function approve(reason: string): Promise<Record<string, unknown> | undefined> {
  return pairing(["approve", reason], 120000).catch(() => undefined);
}

// The code the helper's window shows; undefined when it cannot be read.
export async function readCode(helper: number): Promise<string | undefined> {
  const read = await pairing(["code", "--pid", String(helper)], 10000).catch(() => undefined);
  return typeof read?.code === "string" ? read.code : undefined;
}

// The prompt's text goes in as an argument, so none of it is read as
// script. It comes to the front, since he types into it.
const PROMPT = [
  "on run argv",
  "activate",
  `set r to display dialog (item 1 of argv) with title "Safari Harness" default answer "" with hidden answer buttons {"Cancel", "Pair"} default button "Pair" cancel button "Cancel" giving up after ${PROMPT_S}`,
  'if gave up of r then return "gave up"',
  'return "code " & text returned of r',
  "end run",
];

// Asks him for the code on the Mac, then gives him back the app he had in
// front. Neither the answer nor an error carries what he typed.
export async function askCode(): Promise<{ code: string } | { why: string }> {
  const back = await frontApp().catch(() => undefined);
  try {
    const { stdout } = await execFileAsync("osascript", [...PROMPT.flatMap((line) => ["-e", line]), "Type the 6-digit code your Mac shows, to let an agent use your saved passwords."], { timeout: (PROMPT_S + 10) * 1000 });
    const out = stdout.trim();
    if (out === "gave up") return { why: `the user did not type the code within ${PROMPT_S / 60} minutes` };
    const code = out.slice("code ".length).replace(/\s/g, "");
    return /^\d{6}$/.test(code) ? { code } : { why: "the user typed something other than the 6 digits" };
  } catch (e) {
    // Cancel ends the script with error -128.
    return { why: String(e instanceof Error ? e.message : e).includes("(-128)") ? "the user cancelled the prompt" : "the prompt could not be shown on the Mac" };
  } finally {
    if (back) await input(["activate", back]).catch(() => {});
  }
}

// Pairs for a call that found Apple Passwords locked; site ends the reason
// the Touch ID prompt gives. Throws when he declines Touch ID.
export async function pairPasswords(site: string): Promise<Paired> {
  if (await isAway().catch(() => false)) return { paired: false, why: "the user is away from the Mac, and the pairing code shows only there: he must come to the Mac" };
  const approval = await approve(`let Safari Harness use your saved passwords${site}`);
  if (approval && approval.approved !== true) throw new Error(`the user did not approve Apple Passwords (${String(approval.why)}); ask them before trying again`);
  const shown = await rpc("passwords", { do: "pair" });
  if (!shown || typeof shown !== "object" || !("codeShown" in shown)) return { paired: true };
  const helper = "helper" in shown && typeof shown.helper === "number" ? shown.helper : undefined;
  const read = approval && helper !== undefined ? await readCode(helper) : undefined;
  const typed = read === undefined ? await askCode() : { code: read };
  if ("why" in typed) return { paired: false, why: typed.why };
  try {
    await rpc("passwords", { do: "unlock", code: typed.code });
  } catch (e) {
    return { paired: false, why: e instanceof Error ? e.message : String(e) };
  }
  return { paired: true };
}
