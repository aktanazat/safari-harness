// launchd plumbing: keep the daemon always on, and run saved prompts
// ("routines") on a schedule through headless omp, which reaches Safari
// through the safari MCP tools. A watch is a routine with no model: each
// run reads one value off a page and alerts the user when it changes
// (daemon/watch.ts). A script routine runs no model either: it runs a saved
// `safari repl` script and texts the user what it printed.

import { appendFile, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DEFAULT_PORT } from "../daemon/bridge.ts";
import { connectHost } from "../daemon/host.ts";
import { heliumProfile, quitHelium } from "../daemon/passwords.ts";
import { alert } from "../daemon/phone.ts";
import { ReplSession } from "../daemon/repl.ts";
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
// A script routine's run ends here, as a model routine's does at omp's --max-time.
const SCRIPT_MS = 30 * 60_000;
// A script's words are cut to this in the text to the phone; the log keeps all.
const SAID_MAX = 1500;

// Preamble written into every routine prompt file, so the file on disk is
// exactly what omp receives.
const PREAMBLE = `This is a scheduled Safari routine running unattended.
Use the safari tools (read skill://safari first). Open your own tab for the
work and close it when done; never navigate or close tabs you did not open.
Do not send, post, buy, or delete anything unless the task below says to.
End with a short plain-language summary of what you found or did.

Task:
`;

type Day = { year: number; month: number; day: number };
// `on` makes a routine run once, on that day.
type Schedule = { at: { hour: number; minute: number }; on?: Day } | { everyMinutes: number };

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

// Whether launchd has the daemon's job, for safari doctor.
export function daemonLoaded(): boolean {
  return launchctl("print", `gui/${uid()}/${DAEMON_LABEL}`).code === 0;
}

// ---------- routines ----------

function checkName(name: string | undefined): string {
  if (!name || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
    throw new Error("routine name must be lowercase letters, digits, and dashes");
  }
  return name;
}

export function parseSchedule(at: string | undefined, every: string | undefined, on?: string): Schedule {
  if ((at === undefined) === (every === undefined)) throw new Error("give exactly one of --at HH:MM or --every <minutes>");
  if (at !== undefined) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at);
    if (!m) throw new Error("--at must be HH:MM (24-hour)");
    const time = { hour: Number(m[1]), minute: Number(m[2]) };
    if (on === undefined) return { at: time };
    const d = /^(\d{4})-(\d\d)-(\d\d)$/.exec(on);
    const when = d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), time.hour, time.minute) : undefined;
    if (!d || !when || when.getMonth() !== Number(d[2]) - 1 || when.getDate() !== Number(d[3])) throw new Error("--on must be a date, YYYY-MM-DD");
    if (when.getTime() <= Date.now()) throw new Error(`--on ${on} --at ${at} is already past`);
    return { at: time, on: { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) } };
  }
  if (on !== undefined) throw new Error("--on runs once at a time of day: give --at with it, not --every");
  const n = Number(every);
  if (!Number.isInteger(n) || n < 5) throw new Error("--every must be a whole number of minutes, at least 5");
  return { everyMinutes: n };
}

function scheduleXml(s: Schedule): string {
  if (!("at" in s)) return `  <key>StartInterval</key><integer>${s.everyMinutes * 60}</integer>`;
  const day = s.on ? `<key>Month</key><integer>${s.on.month}</integer><key>Day</key><integer>${s.on.day}</integer>` : "";
  return `  <key>StartCalendarInterval</key>\n  <dict>${day}<key>Hour</key><integer>${s.at.hour}</integer><key>Minute</key><integer>${s.at.minute}</integer></dict>`;
}

const two = (n: number) => String(n).padStart(2, "0");

function describe(s: Schedule): string {
  if (!("at" in s)) return `every ${s.everyMinutes} min`;
  const time = `${two(s.at.hour)}:${two(s.at.minute)}`;
  return s.on ? `once on ${s.on.year}-${two(s.on.month)}-${two(s.on.day)} at ${time}` : `daily at ${time}`;
}

// `awake` is the caffeinate a routine that runs once started.
type RoutineMeta = { name: string; schedule: Schedule; model?: string; created: string; watch?: Watch; awake?: number };

async function readMeta(n: string): Promise<RoutineMeta | undefined> {
  const p = join(ROUTINES, `${n}.json`);
  return existsSync(p) ? (JSON.parse(await readFile(p, "utf8")) as RoutineMeta) : undefined;
}

// Ends a routine's caffeinate, unless it ended on its own and its pid went
// to another process.
function stopAwake(meta: RoutineMeta | undefined): void {
  if (meta?.awake === undefined) return;
  const comm = spawnSync("ps", ["-p", String(meta.awake), "-o", "comm="], { encoding: "utf8" }).stdout.trim();
  if (comm.endsWith("caffeinate")) process.kill(meta.awake);
}

// Writes the routine's record and has launchd run `safari routine run
// <name> --scheduled` from the deployed release. A routine that runs once
// keeps the Mac from sleeping until an hour past its time (on mains power;
// a closed lid still sleeps it), since launchd starts a job missed in sleep
// only once the Mac wakes.
async function saveRoutine(meta: RoutineMeta): Promise<void> {
  const n = meta.name;
  const args = [process.execPath, join(CURRENT, "cli", "safari.ts"), "routine", "run", n, "--scheduled"];
  await mkdir(join(LOGS, "routines"), { recursive: true });
  await load(ROUTINE_PREFIX + n, plist(ROUTINE_PREFIX + n, args, scheduleXml(meta.schedule), join(LOGS, "routines", `${n}.launchd`)));
  stopAwake(await readMeta(n));
  const s = meta.schedule;
  let awake: number | undefined;
  if ("at" in s && s.on) {
    const runs = new Date(s.on.year, s.on.month - 1, s.on.day, s.at.hour, s.at.minute).getTime();
    const child = spawn("caffeinate", ["-i", "-s", "-t", String(Math.ceil((runs - Date.now()) / 1000) + 3600)], { detached: true, stdio: "ignore" });
    child.unref();
    awake = child.pid;
  }
  await mkdir(ROUTINES, { recursive: true });
  await writeFile(join(ROUTINES, `${n}.json`), JSON.stringify({ ...meta, awake }, null, 2) + "\n");
}

export async function routineAdd(name: string | undefined, prompt: string, schedule: Schedule, model?: string): Promise<string> {
  const n = checkName(name);
  if (!prompt.trim()) throw new Error("routine needs a task prompt");
  await mkdir(ROUTINES, { recursive: true });
  await rm(join(ROUTINES, `${n}.js`), { force: true });
  await writeFile(join(ROUTINES, `${n}.md`), PREAMBLE + prompt.trim() + "\n");
  await saveRoutine({ name: n, schedule, model, created: new Date().toISOString() });
  return `routine ${n} scheduled ${describe(schedule)}; prompt: ${join(ROUTINES, `${n}.md`)}`;
}

// A script routine keeps its own copy of the script, so editing or deleting
// the file it came from changes nothing until it is added again.
export async function routineAddScript(name: string | undefined, file: string, schedule: Schedule): Promise<string> {
  const n = checkName(name);
  const code = await readFile(file, "utf8");
  if (!code.trim()) throw new Error(`${file} is empty`);
  await mkdir(ROUTINES, { recursive: true });
  await rm(join(ROUTINES, `${n}.md`), { force: true });
  await writeFile(join(ROUTINES, `${n}.js`), code);
  await saveRoutine({ name: n, schedule, created: new Date().toISOString() });
  return `script routine ${n} scheduled ${describe(schedule)}; practice run: safari routine run ${n} --dry`;
}

// A watch starts over when added again: its first run records the value
// and sends nothing, so a changed selector never reads as news.
export async function routineAddWatch(name: string | undefined, url: string, reads: Partial<Record<How, string>>, schedule: Schedule): Promise<string> {
  const n = checkName(name);
  if (existsSync(join(ROUTINES, `${n}.md`)) || existsSync(join(ROUTINES, `${n}.js`))) throw new Error(`routine ${n} runs a model or a script; remove it first, or give the watch another name`);
  const watch = await parseWatch(url, reads);
  await rm(stateFile(n), { force: true });
  await saveRoutine({ name: n, schedule, created: new Date().toISOString(), watch });
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
  const meta = await readMeta(n);
  stopAwake(meta);
  // a watch's state is its own; a model routine's is the model's to keep
  if (meta?.watch) await rm(stateFile(n), { force: true });
  for (const ext of ["md", "js", "json"]) {
    const p = join(ROUTINES, `${n}.${ext}`);
    if (existsSync(p)) await unlink(p);
  }
  return had ? `routine ${n} removed` : `routine ${n} had no schedule; files cleared`;
}

// Runs one routine now, in the foreground: headless omp with the saved
// prompt, a saved script, or a watch's read. Output goes to a timestamped
// log: the safari MCP server omp starts writes a line there for each tool
// call (daemon/mcp.ts), and omp's own output follows. `<name>.last` records
// the latest outcome. `scheduled` is launchd's run: a routine that runs once
// lets go of its schedule, and on any day but its own (launchd starts a job
// missed in sleep when the Mac wakes, maybe days later) runs nothing and
// tells the user so. `dry` gives a script DRY = true and texts no one.
export async function routineRun(name: string | undefined, opts: { dry?: boolean; scheduled?: boolean } = {}): Promise<{ code: number; log: string; note?: string }> {
  const n = checkName(name);
  const promptPath = join(ROUTINES, `${n}.md`);
  const scriptPath = join(ROUTINES, `${n}.js`);
  const meta = await readMeta(n);
  const script = existsSync(scriptPath);
  if (!meta || (!meta.watch && !script && !existsSync(promptPath))) throw new Error(`no routine named ${n}`);
  if (opts.dry && !script) throw new Error("--dry is for script routines");
  const once = "at" in meta.schedule ? meta.schedule.on : undefined;
  const now = new Date();
  if (opts.scheduled && once) {
    // Its job stays loaded until the next login, and its one day is today or gone.
    await rm(join(AGENTS, `${ROUTINE_PREFIX}${n}.plist`), { force: true });
    if (once.year !== now.getFullYear() || once.month !== now.getMonth() + 1 || once.day !== now.getDate()) {
      const note = `${n} did not run: it was set to run ${describe(meta.schedule)}, and the mac was asleep then`;
      const told = await alert(note).then(
        () => "",
        (e: Error) => `; the phone was not told: ${e.message}`,
      );
      return { code: 1, log: "", note: note + told };
    }
  }
  const dir = join(LOGS, "routines");
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const log = join(dir, `${n}-${stamp}.log`);
  let ran: { code: number; note?: string };
  if (meta.watch) {
    ran = await runWatch(n, meta.watch).catch((e: Error) => ({ code: 1, note: e.message }));
    await writeFile(log, `${ran.note}\n`);
  } else if (script) {
    ran = await runScript(n, await readFile(scriptPath, "utf8"), log, opts.dry === true);
  } else {
    const args = ["-p", "--mode", "text", "--auto-approve", "--no-session", "--max-time", "30m"];
    if (meta.model) args.push("--model", meta.model);
    args.push(`@${promptPath}`);
    const r = spawnSync(OMP, args, {
      cwd: HOME,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH, HOME, SAFARI_ROUTINE_LOG: log },
      maxBuffer: 64 * 1024 * 1024,
    });
    ran = { code: r.status ?? 1 };
    await appendFile(log, `${r.stdout ?? ""}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""}`);
  }
  await writeFile(join(dir, `${n}.last`), `${new Date().toISOString()} exit ${ran.code}${opts.dry ? " (dry)" : ""} ${log}\n`);
  return { code: ran.code, log, note: ran.note };
}

// One run of a saved script in a session of its own, as `safari repl` runs
// one. What it printed, or why it failed, goes to the log and to the phone.
async function runScript(n: string, code: string, log: string, dry: boolean): Promise<{ code: number; note: string }> {
  await connectHost();
  const session = new ReplSession(`routine-${n}`, { cwd: join(LOGS, "routines", n) });
  let r: { output: string; error?: string };
  try {
    r = await session.run(`const DRY = ${dry};\n${code}`, SCRIPT_MS);
  } finally {
    await session.close();
  }
  const said = r.error === undefined ? r.output || "(the script printed nothing)" : `failed: ${r.error}${r.output ? `\n${r.output}` : ""}`;
  await writeFile(log, `${said}\n`);
  if (!dry) {
    const text = said.length > SAID_MAX ? `${said.slice(0, SAID_MAX - 1)}…` : said;
    await alert(`${n}: ${text}`).catch((e: Error) => appendFile(log, `--- the phone was not told: ${e.message}\n`));
  }
  return { code: r.error === undefined ? 0 : 1, note: said };
}
