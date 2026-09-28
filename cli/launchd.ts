// launchd plumbing: keep the daemon always on, and run saved prompts
// ("routines") on a schedule through headless omp, which reaches Safari
// through the safari MCP tools. A watch is a routine with no model: each
// run reads one value off a page and texts the user when it changes
// (daemon/watch.ts).

import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_PORT } from "../daemon/bridge.ts";
import { heliumProfile, quitHelium } from "../daemon/passwords.ts";
import { lastValue, parseWatch, runWatch, stateFile, type How, type Watch } from "../daemon/watch.ts";

const HOME = homedir();
// The deployed release (scripts/dev-install.sh points it at the newest), so
// jobs run what was deployed, never a checkout being edited.
const CURRENT = join(HOME, ".local", "share", "safari-harness", "current");
const AGENTS = join(HOME, "Library", "LaunchAgents");
const LOGS = join(HOME, "Library", "Logs", "safari-harness");
const ROUTINES = join(HOME, ".local", "share", "safari-harness", "routines");
const DAEMON_LABEL = "at.aktan.safari-harness.daemon";
const ROUTINE_PREFIX = "at.aktan.safari-harness.routine.";
const OMP = join(HOME, ".bun", "bin", "omp");
const PATH = [join(HOME, ".bun", "bin"), join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

// Preamble written into every routine prompt file, so the file on disk is
// exactly what omp receives.
const PREAMBLE = `This is a scheduled Safari routine running unattended.
Use the safari tools (read skill://safari first). Open your own tab for the
work and close it when done; never navigate or close tabs you did not open.
Do not send, post, buy, or delete anything unless the task below says to.
End with a short plain-language summary of what you found or did.

Task:
`;

type Schedule = { at: { hour: number; minute: number } } | { everyMinutes: number };

function uid(): number {
  return process.getuid?.() ?? 501;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plist(label: string, args: string[], schedule: string, logBase: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(PATH)}</string><key>HOME</key><string>${xml(HOME)}</string></dict>
${schedule}
  <key>StandardOutPath</key><string>${xml(logBase)}.log</string>
  <key>StandardErrorPath</key><string>${xml(logBase)}.log</string>
</dict>
</plist>
`;
}

function launchctl(...args: string[]): { code: number; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}`.trim() };
}

// bootout returns while the old job's process may still be finishing its
// calls in flight (main.ts drains for up to 60 s on SIGTERM); a bootstrap
// of the label before launchd lets go of it fails with "5: Input/output
// error", so wait for the label to go first.
async function bootout(label: string): Promise<void> {
  const target = `gui/${uid()}/${label}`;
  launchctl("bootout", target);
  for (let i = 0; i < 140 && launchctl("print", target).code === 0; i++) await Bun.sleep(500);
}

async function load(label: string, body: string): Promise<void> {
  await mkdir(AGENTS, { recursive: true });
  await mkdir(LOGS, { recursive: true });
  const path = join(AGENTS, `${label}.plist`);
  await bootout(label);
  await writeFile(path, body);
  const r = launchctl("bootstrap", `gui/${uid()}`, path);
  if (r.code !== 0) throw new Error(`launchctl bootstrap ${label} failed: ${r.out}`);
}

async function unload(label: string): Promise<boolean> {
  const path = join(AGENTS, `${label}.plist`);
  await bootout(label);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}

// ---------- daemon ----------

export async function daemonInstall(): Promise<string> {
  const main = join(CURRENT, "daemon", "main.ts");
  if (!existsSync(main)) throw new Error("no release is deployed; run scripts/dev-install.sh in the checkout");
  const body = plist(
    DAEMON_LABEL,
    [process.execPath, main],
    "  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>",
    join(LOGS, "daemon"),
  );
  await load(DAEMON_LABEL, body);
  return `daemon installed; logs: ${join(LOGS, "daemon.log")}`;
}

// The hidden Helium for Apple Passwords outlives a daemon restart on
// purpose (passwords.ts); with the daemon gone for good, it goes too, and
// the pairing with it.
export async function daemonUninstall(): Promise<string> {
  const had = await unload(DAEMON_LABEL);
  await quitHelium(heliumProfile(DEFAULT_PORT));
  return had ? "daemon uninstalled" : "daemon was not installed";
}

// ---------- routines ----------

function checkName(name: string | undefined): string {
  if (!name || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
    throw new Error("routine name must be lowercase letters, digits, and dashes");
  }
  return name;
}

export function parseSchedule(at: string | undefined, every: string | undefined): Schedule {
  if ((at === undefined) === (every === undefined)) throw new Error("give exactly one of --at HH:MM or --every <minutes>");
  if (at !== undefined) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at);
    if (!m) throw new Error("--at must be HH:MM (24-hour)");
    return { at: { hour: Number(m[1]), minute: Number(m[2]) } };
  }
  const n = Number(every);
  if (!Number.isInteger(n) || n < 5) throw new Error("--every must be a whole number of minutes, at least 5");
  return { everyMinutes: n };
}

function scheduleXml(s: Schedule): string {
  return "at" in s
    ? `  <key>StartCalendarInterval</key>\n  <dict><key>Hour</key><integer>${s.at.hour}</integer><key>Minute</key><integer>${s.at.minute}</integer></dict>`
    : `  <key>StartInterval</key><integer>${s.everyMinutes * 60}</integer>`;
}

function describe(s: Schedule): string {
  return "at" in s
    ? `daily at ${String(s.at.hour).padStart(2, "0")}:${String(s.at.minute).padStart(2, "0")}`
    : `every ${s.everyMinutes} min`;
}

type RoutineMeta = { name: string; schedule: Schedule; model?: string; created: string; watch?: Watch };

// launchd runs `safari routine run <name>` from the deployed release.
async function scheduleRoutine(n: string, schedule: Schedule): Promise<void> {
  const body = plist(
    ROUTINE_PREFIX + n,
    [process.execPath, join(CURRENT, "cli", "safari.ts"), "routine", "run", n],
    scheduleXml(schedule),
    join(LOGS, "routines", `${n}.launchd`),
  );
  await mkdir(join(LOGS, "routines"), { recursive: true });
  await load(ROUTINE_PREFIX + n, body);
}

export async function routineAdd(name: string | undefined, prompt: string, schedule: Schedule, model?: string): Promise<string> {
  const n = checkName(name);
  if (!prompt.trim()) throw new Error("routine needs a task prompt");
  await mkdir(ROUTINES, { recursive: true });
  await writeFile(join(ROUTINES, `${n}.md`), PREAMBLE + prompt.trim() + "\n");
  const meta: RoutineMeta = { name: n, schedule, model, created: new Date().toISOString() };
  await writeFile(join(ROUTINES, `${n}.json`), JSON.stringify(meta, null, 2) + "\n");
  await scheduleRoutine(n, schedule);
  return `routine ${n} scheduled ${describe(schedule)}; prompt: ${join(ROUTINES, `${n}.md`)}`;
}

// A watch starts over when added again: its first run records the value
// and texts nothing, so a changed selector never reads as news.
export async function routineAddWatch(name: string | undefined, url: string, reads: Partial<Record<How, string>>, schedule: Schedule): Promise<string> {
  const n = checkName(name);
  if (existsSync(join(ROUTINES, `${n}.md`))) throw new Error(`routine ${n} runs a model; remove it first, or give the watch another name`);
  const watch = await parseWatch(url, reads);
  await mkdir(ROUTINES, { recursive: true });
  const meta: RoutineMeta = { name: n, schedule, created: new Date().toISOString(), watch };
  await writeFile(join(ROUTINES, `${n}.json`), JSON.stringify(meta, null, 2) + "\n");
  await rm(stateFile(n), { force: true });
  await scheduleRoutine(n, schedule);
  return `watch ${n} scheduled ${describe(schedule)}: ${watch.how} ${watch.what} on ${url}`;
}

export async function routineList(): Promise<Array<{ name: string; schedule: string; loaded: boolean; watch?: string; lastValue?: string; lastRun?: string }>> {
  if (!existsSync(ROUTINES)) return [];
  const files = (await readdir(ROUTINES)).filter((f) => f.endsWith(".json"));
  const rows = [];
  for (const f of files) {
    const meta = JSON.parse(await readFile(join(ROUTINES, f), "utf8")) as RoutineMeta;
    const loaded = launchctl("print", `gui/${uid()}/${ROUTINE_PREFIX}${meta.name}`).code === 0;
    const last = join(LOGS, "routines", `${meta.name}.last`);
    rows.push({
      name: meta.name,
      schedule: describe(meta.schedule),
      loaded,
      ...(meta.watch ? { watch: `${meta.watch.how} ${meta.watch.what} on ${meta.watch.url}`, lastValue: lastValue(meta.name) } : {}),
      lastRun: existsSync(last) ? (await readFile(last, "utf8")).trim() : undefined,
    });
  }
  return rows;
}

export async function routineRemove(name: string | undefined): Promise<string> {
  const n = checkName(name);
  const had = await unload(ROUTINE_PREFIX + n);
  const metaPath = join(ROUTINES, `${n}.json`);
  const meta = existsSync(metaPath) ? (JSON.parse(await readFile(metaPath, "utf8")) as RoutineMeta) : undefined;
  // a watch's state is its own; a model routine's is the model's to keep
  if (meta?.watch) await rm(stateFile(n), { force: true });
  for (const ext of ["md", "json"]) {
    const p = join(ROUTINES, `${n}.${ext}`);
    if (existsSync(p)) await unlink(p);
  }
  return had ? `routine ${n} removed` : `routine ${n} had no schedule; files cleared`;
}

// Runs one routine now, in the foreground: headless omp with the saved
// prompt, or a watch's read. Output goes to a timestamped log;
// `<name>.last` records the latest outcome.
export async function routineRun(name: string | undefined): Promise<{ code: number; log: string; note?: string }> {
  const n = checkName(name);
  const promptPath = join(ROUTINES, `${n}.md`);
  const metaPath = join(ROUTINES, `${n}.json`);
  if (!existsSync(metaPath)) throw new Error(`no routine named ${n}`);
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as RoutineMeta;
  if (!meta.watch && !existsSync(promptPath)) throw new Error(`no routine named ${n}`);
  const dir = join(LOGS, "routines");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = join(dir, `${n}-${stamp}.log`);
  if (meta.watch) {
    const { code, note } = await runWatch(n, meta.watch).catch((e: Error) => ({ code: 1, note: e.message }));
    await writeFile(log, `${note}\n`);
    await writeFile(join(dir, `${n}.last`), `${new Date().toISOString()} exit ${code} ${log}\n`);
    return { code, log, note };
  }
  const args = ["-p", "--mode", "text", "--auto-approve", "--no-session", "--max-time", "30m"];
  if (meta.model) args.push("--model", meta.model);
  args.push(`@${promptPath}`);
  const r = spawnSync(OMP, args, {
    cwd: HOME,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH, HOME },
    maxBuffer: 64 * 1024 * 1024,
  });
  const code = r.status ?? 1;
  await writeFile(log, `${r.stdout ?? ""}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""}`);
  await writeFile(join(dir, `${n}.last`), `${new Date().toISOString()} exit ${code} ${log}\n`);
  return { code, log };
}
