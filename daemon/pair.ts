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
import { ANSWER_MS, localTime, within } from "./passwords.ts";
import { isAway } from "./phone.ts";
import { rpc } from "./rpc.ts";

const execFileAsync = promisify(execFile);
const PAIRING = join(import.meta.dir, "..", "scripts", "pairing");
// How long the prompt waits for him.
const PROMPT_S = 180;

export type Paired = { paired: true } | { paired: false; why: string };

// Runs file and resolves to its stdout. A pairing can outlive the call that
// started it (the MCP server answers at ANSWER_MS and goes on), and a
// prompt still up when this process exits could pair nothing, so it goes
// down then.
async function run(file: string, args: string[], timeout: number): Promise<string> {
  const running = execFileAsync(file, args, { timeout });
  const kill = () => running.child.kill();
  process.once("exit", kill);
  try {
    return (await running).stdout;
  } finally {
    process.off("exit", kill);
  }
}

// Runs scripts/pairing and parses its one JSON line; failures carry its stderr.
async function pairing(args: string[], timeout: number): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await run(PAIRING, args, timeout));
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
    const out = (await run("osascript", [...PROMPT.flatMap((line) => ["-e", line]), "Type the 6-digit code your Mac shows, to let an agent use your saved passwords."], (PROMPT_S + 10) * 1000)).trim();
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

// The pairing under way in this process, and what a call that stops
// waiting on it says the Mac waits on.
let current: Promise<Paired> | undefined;
let waiting = "";
// Whether a call waits the pairing out rather than ANSWER_MS.
let waitOut = false;

function waitOn(what: string, then: string): void {
  waiting = `${what} (since ${localTime()}); ${then}`;
}

// The CLI's process ends with its answer, and a prompt still up with it,
// so a CLI call waits the pairing out, each step to its own limit. The MCP
// server outlives each answer and keeps the ANSWER_MS bound.
export function waitPairingOut(on = true): void {
  waitOut = on;
}

// Pairs for a call that found Apple Passwords locked; site ends the reason
// the Touch ID prompt gives. Throws when he declines Touch ID. On 09-29 a
// first call waited 44 s for his Touch ID and 13 s more for the code, and
// answered at 58 s, where an agent's call through MCP ends at 60. So a
// call waits ANSWER_MS, as the daemon's calls do on Touch ID, then says
// what the Mac waits on while the pairing goes on, and the next call
// waits on the same pairing: no second prompt. From the CLI it waits the
// pairing out (waitPairingOut).
export async function pairPasswords(site: string): Promise<Paired> {
  if (await isAway().catch(() => false)) return { paired: false, why: "the user is away from the Mac, and the pairing code shows only there: he must come to the Mac" };
  const pending = (current ??= steps(site).finally(() => {
    current = undefined;
  }));
  return (waitOut || (await within(pending, ANSWER_MS))) ? pending : { paired: false, why: waiting };
}

// The pairing itself, noting at each wait what the Mac waits on.
async function steps(site: string): Promise<Paired> {
  waitOn("the Mac is asking the user to approve Apple Passwords with Touch ID", "ask him to approve, then call again");
  const approval = await approve(`let Safari Harness use your saved passwords${site}`);
  if (approval && approval.approved !== true) throw new Error(`the user did not approve Apple Passwords (${String(approval.why)}); ask them before trying again`);
  waitOn("Apple Passwords is pairing", "call again");
  const shown = await rpc("passwords", { do: "pair" });
  if (!shown || typeof shown !== "object" || !("codeShown" in shown)) return { paired: true };
  const helper = "helper" in shown && typeof shown.helper === "number" ? shown.helper : undefined;
  let code = approval && helper !== undefined ? await readCode(helper) : undefined;
  if (code === undefined) {
    waitOn("the Mac is asking the user to type the code it shows into a prompt there", "ask him to type it there, never in the chat, then call again");
    const typed = await askCode();
    if ("why" in typed) return { paired: false, why: typed.why };
    code = typed.code;
    waitOn("Apple Passwords is pairing", "call again");
  }
  try {
    await rpc("passwords", { do: "unlock", code });
  } catch (e) {
    return { paired: false, why: e instanceof Error ? e.message : String(e) };
  }
  return { paired: true };
}
