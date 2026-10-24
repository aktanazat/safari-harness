// The user's Telegram, the harness's way to reach his phone. A message goes
// through the command that already carries his routines' news there,
// ~/.local/bin/tell-aktan: the line on its stdin, and a picture's path, when
// there is one, as its argument. It reaches the Hermes bot over ssh, so it
// works from launchd too, with none of the terminal's permissions. His
// replies go to that bot, never back to the harness.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TELL = join(homedir(), ".local", "bin", "tell-aktan");
export const TELL_SHOWN = "~/.local/bin/tell-aktan";
// ssh gives up on connecting after 12 s; this bounds a VPS that answers and
// then hangs.
const SEND_MS = 60_000;

// Why no alert can go, when the command is not there to run. On 10-23 it
// was gone after the Mac moved, and handoff, ask, and passwords still told
// agents his phone was alerted (HD-5, SONA-03).
export function alertsOff(): string | undefined {
  try {
    accessSync(TELL, constants.X_OK);
    return undefined;
  } catch (e) {
    return `the phone alert is off: ${TELL_SHOWN} ${e instanceof Error && "code" in e && e.code === "ENOENT" ? "is missing" : "is not executable"}`;
  }
}

export async function sendTelegram(line: string, picture?: string): Promise<void> {
  const off = alertsOff();
  if (off !== undefined) throw new Error(off);
  const run = execFileAsync(TELL, picture === undefined ? [] : [picture], { timeout: SEND_MS });
  run.child.stdin?.end(`${line}\n`);
  try {
    await run;
  } catch (e) {
    const stderr = typeof e === "object" && e !== null && "stderr" in e ? String(e.stderr).trim() : "";
    throw new Error(`the phone alert failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  }
}
