// Pairing Apple Passwords without the chat. A call that finds it locked
// asks the user to approve with Touch ID, the daemon pairs, and the code the
// Mac then shows is read off the helper's window (scripts/pairing, with the
// terminal's Accessibility access). Where it cannot be read, a prompt on
// the Mac asks him to type the code, the answer hidden as he types, and the
// digits go straight to the daemon: the agent learns only whether it
// paired. He once took 7 minutes to send the code through the chat. The
// code shows only on the Mac, so while he is away the call says he must
// come to it. It runs in a process of its own (startPairing), started
// from the caller's, as fill.ts runs in the caller.

import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { frontApp, input } from "./front.ts";
import { alive } from "./owner.ts";
import { ANSWER_MS, localTime, within } from "./passwords.ts";
import { dataFile, isAway } from "./phone.ts";
import { agentOf, ownCalls, rpc } from "./rpc.ts";

const execFileAsync = promisify(execFile);
const PAIRING = join(import.meta.dir, "..", "scripts", "pairing");
// How long the prompt waits for him.
const PROMPT_S = 180;
// How long a save waits for the helper's window asking to update it.
const SAVE_WINDOW_MS = 20000;

export type Paired = { paired: true } | { paired: false; why: string };

// Runs file and resolves to its stdout. A prompt still up when the
// pairing's process exits could pair nothing, so it goes down then.
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

// Presses Update Password, or Save Password for a new login, in the
// helper's window that asks to save one for site, the only sign a changed
// password saved (passwords.ts change), waiting up to SAVE_WINDOW_MS for it.
export async function confirmSave(helper: number, site: string, newLogin: boolean): Promise<{ pressed: string } | { why: string }> {
  try {
    const done = await pairing(["confirm", "--pid", String(helper), "--site", site, ...(newLogin ? ["--new"] : []), "--wait", String(SAVE_WINDOW_MS)], SAVE_WINDOW_MS + 5000);
    return { pressed: String(done.pressed) };
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
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

// ---------- the pairing's own process ----------

// The pairing runs in a process of its own, started detached from the
// caller's as the tab group keeper is (keeper.ts), so it keeps the
// terminal's Accessibility permission that reading the code needs, and
// outlives the call that started it. A CLI call used to run it itself and
// wait it out, since its prompt went down with the call's answer: on
// 10-04 nobody was at the Mac, the agent's 150 s limit ended the call
// silently, and the code prompt stayed up with no one waiting on it.
// Now every call, from the CLI or MCP, waits ANSWER_MS, then says what
// the Mac waits on, and the next call from any process on the Mac waits
// on the same pairing: no second prompt. The state file says which
// process pairs, what the Mac waits on, and, once it is over, how it ended.
type Ended = Paired | { error: string };
type State = { pid: number; waiting: string; ended?: Ended };
// How often a waiting call reads the state file.
const POLL_MS = 250;

const stateFile = () => dataFile("pairing.json");

function readState(): State | undefined {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as State;
  } catch {
    return undefined;
  }
}

function writeState(s: State): void {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.${process.pid}`, JSON.stringify(s));
  renameSync(`${file}.${process.pid}`, file);
}

const waitText = (what: string, then: string) => `${what} (since ${localTime()}); ${then}`;

// What the Mac waits on, as the pairing's process last noted it.
let waiting = "";

function waitOn(what: string, then: string): void {
  waiting = waitText(what, then);
  writeState({ pid: process.pid, waiting });
}

// Starts the pairing's process for the agent this call works for, and
// notes it at once, so a call that comes before the process writes waits
// on it rather than starting another.
export async function startPairing(site: string): Promise<number> {
  const agent = await agentOf();
  const child = spawn(process.execPath, [import.meta.path, site, ...(agent === undefined ? [] : [String(agent)])], { detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid === undefined) throw new Error("the pairing's process did not start");
  writeState({ pid: child.pid, waiting: waitText("Apple Passwords is pairing", "call again") });
  return child.pid;
}

// Waits up to ANSWER_MS on the pairing pid runs: how it ended, or what
// the Mac waits on while it goes on. The process notes how it ended
// before it exits, so one found gone has said so, or never will.
async function answer(pid: number): Promise<Paired> {
  const over = Promise.withResolvers<Ended>();
  const look = () => {
    const running = alive(pid);
    const s = readState();
    if (s?.pid === pid && s.ended) over.resolve(s.ended);
    else if (!running) over.resolve({ paired: false, why: "the pairing stopped before it ended; call again" });
  };
  look();
  const poll = setInterval(look, POLL_MS);
  try {
    if (!(await within(over.promise, ANSWER_MS))) return { paired: false, why: readState()?.waiting ?? waitText("Apple Passwords is pairing", "call again") };
  } finally {
    clearInterval(poll);
  }
  const ended = await over.promise;
  if ("error" in ended) throw new Error(ended.error);
  return ended;
}

// Pairs for a call that found Apple Passwords locked; site ends the reason
// the Touch ID prompt gives. Throws when he declines Touch ID. On 09-29 a
// first call waited 44 s for his Touch ID and 13 s more for the code, and
// answered at 58 s, where an agent's call through MCP ends at 60. So a
// call waits ANSWER_MS, as the daemon's calls do on Touch ID, then says
// what the Mac waits on while the pairing goes on.
export async function pairPasswords(site: string): Promise<Paired> {
  if (await isAway().catch(() => false)) return { paired: false, why: "the user is away from the Mac, and the pairing code shows only there: he must come to the Mac" };
  const s = readState();
  return answer(s && !s.ended && alive(s.pid) ? s.pid : await startPairing(site));
}

// The body of the pairing's process: the pairing, then how it ended.
export async function runPairing(site: string): Promise<void> {
  const ended: Ended = await steps(site).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  writeState({ pid: process.pid, waiting, ended });
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

// The pairing's process: argv is the site the reason names, then the
// agent it pairs for, whose calls hold the pairing (rpc.ts ownCalls).
if (import.meta.main) {
  const [site = "", agent] = process.argv.slice(2);
  if (agent !== undefined) ownCalls(Number(agent));
  await runPairing(site);
}
