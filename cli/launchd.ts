// launchd plumbing: keep the daemon always on, and run saved prompts
// ("routines") on a schedule through headless omp, which reaches Safari
// through the safari MCP tools. A watch is a routine with no model: each
// run reads one value off a page and alerts the user when it changes
// (daemon/watch.ts). A script routine runs no model either: it runs a saved
// `safari repl` script and texts the user what it printed.

import { appendFile, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
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
import { isRunning, loadSession, runSession, type SessionRecord } from "../daemon/sessions.ts";

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

type SavedTarget = Pick<SessionRecord, "id" | "created" | "host" | "model" | "baseUrl">;
type RoutineMeta = {
  name: string;
  schedule: Schedule;
  model?: string;
  created: string;
  watch?: Watch;
  awake?: number;
  generation?: string;
  paused?: boolean;
  pauseReason?: string;
  session?: SavedTarget;
};
type RunResult = { code: number; log: string; note?: string };
type PreparedRun = { result: RunResult; missedDate?: boolean } | { log: string; run: Promise<{ code: number; note?: string }> };

async function readMeta(n: string): Promise<RoutineMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(ROUTINES, `${n}.json`), "utf8")) as RoutineMeta;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  }
}

async function writeMeta(meta: RoutineMeta): Promise<void> {
  await mkdir(ROUTINES, { recursive: true, mode: 0o700 });
  const path = join(ROUTINES, `${meta.name}.json`);
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

let kernelLock: Promise<(fd: number, operation: number) => number> | undefined;
// bun:ffi is platform-specific; load libSystem only when running macOS jobs.

async function acquireLock(n: string, kind: "run" | "state"): Promise<FileHandle | undefined> {
  kernelLock ??= import("bun:ffi").then(({ dlopen, FFIType }) => dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols.flock);
  const flock = await kernelLock;
  const dir = join(ROUTINES, ".locks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = await open(join(dir, `${n}.${kind}`), "a", 0o600);
  // Never unlink a lock file: all contenders must lock the same inode.
  // The kernel releases it on the last close, including after a crash.
  if (flock(file.fd, 6) === 0) return file;
  await file.close();
  return undefined;
}

async function withState<T>(n: string, action: () => Promise<T>): Promise<T> {
  let lock = await acquireLock(n, "state");
  for (let tries = 0; !lock && tries < 250; tries++) {
    await Bun.sleep(20);
    lock = await acquireLock(n, "state");
  }
  if (!lock) throw new Error(`routine ${n} is being changed; try again`);
  try { return await action(); } finally { await lock.close(); }
}

// Ends the recorded caffeinate only while its executable still matches.
function stopAwake(meta: RoutineMeta | undefined): void {
  if (meta?.awake === undefined) return;
  const comm = spawnSync("ps", ["-p", String(meta.awake), "-o", "comm="], { encoding: "utf8" }).stdout.trim();
  if (comm.endsWith("caffeinate")) {
    try { process.kill(meta.awake); } catch { /* already ended */ }
  }
}

async function installRoutine(meta: RoutineMeta): Promise<void> {
  const n = meta.name;
  if (!meta.generation) throw new Error(`routine ${n} has no schedule identity`);
  const args = [process.execPath, join(CURRENT, "cli", "safari.ts"), "routine", "run", n, "--scheduled", "--generation", meta.generation];
  await mkdir(join(LOGS, "routines"), { recursive: true });
  await load(ROUTINE_PREFIX + n, plist(ROUTINE_PREFIX + n, args, scheduleXml(meta.schedule), join(LOGS, "routines", `${n}.launchd`)));
}

async function saveRoutine(meta: RoutineMeta): Promise<void> {
  stopAwake(await readMeta(meta.name));
  meta.generation = crypto.randomUUID();
  meta.paused = false;
  delete meta.pauseReason;
  delete meta.awake;
  await writeMeta(meta);
  try {
    await installRoutine(meta);
    const s = meta.schedule;
    if ("at" in s && s.on) {
      const runs = new Date(s.on.year, s.on.month - 1, s.on.day, s.at.hour, s.at.minute).getTime();
      const child = spawn("caffeinate", ["-i", "-s", "-t", String(Math.max(1, Math.ceil((runs - Date.now()) / 1000) + 3600))], { detached: true, stdio: "ignore" });
      child.unref();
      meta.awake = child.pid;
      await writeMeta(meta);
    }
  } catch (e) {
    await writeMeta({ ...meta, paused: true, pauseReason: "schedule could not be installed" });
    throw e;
  }
}

async function selectedSession(target: SavedTarget): Promise<SessionRecord> {
  const rec = await loadSession(target.id);
  if (rec.created !== target.created || rec.host !== target.host || rec.model !== target.model || rec.baseUrl !== target.baseUrl) {
    throw new Error(`saved session ${target.id} changed identity or execution settings; add the routine again to select it`);
  }
  if (isRunning(rec)) throw new Error(`saved session ${rec.id} is already running`);
  return rec;
}

async function replaceRoutine(n: string, action: () => Promise<string>): Promise<string> {
  return withState(n, async () => {
    const lock = await acquireLock(n, "run");
    if (!lock) throw new Error(`routine ${n} is running; pause it and wait for it to finish before replacing it`);
    try { return await action(); } finally { await lock.close(); }
  });
}

export async function routineAdd(name: string | undefined, prompt: string, schedule: Schedule, model?: string, session?: string): Promise<string> {
  const n = checkName(name);
  if (!prompt.trim()) throw new Error("routine needs a task prompt");
  if (session && model) throw new Error("--session keeps the saved session's model; do not give --model too");
  let target: SavedTarget | undefined;
  if (session !== undefined) {
    const rec = await loadSession(session);
    if (isRunning(rec)) throw new Error(`saved session ${rec.id} is already running`);
    const { id, created, host, model: savedModel, baseUrl } = rec;
    target = { id, created, host, model: savedModel, baseUrl };
  }
  return replaceRoutine(n, async () => {
    await mkdir(ROUTINES, { recursive: true, mode: 0o700 });
    await rm(join(ROUTINES, `${n}.js`), { force: true });
    await writeFile(join(ROUTINES, `${n}.md`), PREAMBLE + prompt.trim() + "\n", { mode: 0o600 });
    await saveRoutine({ name: n, schedule, model, session: target, created: new Date().toISOString() });
    return `routine ${n} scheduled ${describe(schedule)}${target ? `; continues saved session ${target.id}` : ""}; prompt: ${join(ROUTINES, `${n}.md`)}`;
  });
}

export async function routineAddScript(name: string | undefined, file: string, schedule: Schedule): Promise<string> {
  const n = checkName(name);
  const code = await readFile(file, "utf8");
  if (!code.trim()) throw new Error(`${file} is empty`);
  return replaceRoutine(n, async () => {
    await mkdir(ROUTINES, { recursive: true, mode: 0o700 });
    await rm(join(ROUTINES, `${n}.md`), { force: true });
    await writeFile(join(ROUTINES, `${n}.js`), code, { mode: 0o600 });
    await saveRoutine({ name: n, schedule, created: new Date().toISOString() });
    return `script routine ${n} scheduled ${describe(schedule)}; practice run: safari routine run ${n} --dry`;
  });
}

export async function routineAddWatch(name: string | undefined, url: string, reads: Partial<Record<How, string>>, schedule: Schedule): Promise<string> {
  const n = checkName(name);
  const watch = await parseWatch(url, reads);
  return replaceRoutine(n, async () => {
    if (existsSync(join(ROUTINES, `${n}.md`)) || existsSync(join(ROUTINES, `${n}.js`))) throw new Error(`routine ${n} runs a model or a script; remove it first, or give the watch another name`);
    await rm(stateFile(n), { force: true });
    await saveRoutine({ name: n, schedule, created: new Date().toISOString(), watch });
    return `watch ${n} scheduled ${describe(schedule)}: ${watch.how} ${watch.what} on ${url}`;
  });
}

export async function routineList(): Promise<Array<{ name: string; schedule: string; loaded: boolean; paused: boolean; pauseReason?: string; session?: string; watch?: string; lastValue?: string; lastRun?: string }>> {
  if (!existsSync(ROUTINES)) return [];
  const files = (await readdir(ROUTINES)).filter((f) => f.endsWith(".json"));
  const rows = [];
  for (const f of files) {
    const meta = await readMeta(f.slice(0, -5));
    if (!meta) continue;
    const loaded = launchctl("print", `gui/${uid()}/${ROUTINE_PREFIX}${meta.name}`).code === 0;
    const last = join(LOGS, "routines", `${meta.name}.last`);
    rows.push({
      name: meta.name, schedule: describe(meta.schedule), loaded, paused: meta.paused === true,
      ...(meta.pauseReason ? { pauseReason: meta.pauseReason } : {}),
      ...(meta.session ? { session: meta.session.id } : {}),
      ...(meta.watch ? { watch: `${meta.watch.how} ${meta.watch.what} on ${meta.watch.url}`, lastValue: lastValue(meta.name) } : {}),
      lastRun: existsSync(last) ? (await readFile(last, "utf8")).trim() : undefined,
    });
  }
  return rows;
}

export async function routinePause(name: string | undefined): Promise<string> {
  const n = checkName(name);
  return withState(n, async () => {
    const meta = await readMeta(n);
    if (!meta) throw new Error(`no routine named ${n}`);
    await writeMeta({ ...meta, paused: true, pauseReason: "paused by user", generation: crypto.randomUUID(), awake: undefined });
    stopAwake(meta);
    // The durable pause and new generation reject future/queued invocations.
    // Booting out the job would also terminate the run already in progress.
    return `routine ${n} paused; no new runs will start`;
  });
}

export async function routineResume(name: string | undefined): Promise<string> {
  const n = checkName(name);
  return replaceRoutine(n, async () => {
    const meta = await readMeta(n);
    if (!meta) throw new Error(`no routine named ${n}`);
    if (meta.session) await selectedSession(meta.session);
    const s = meta.schedule;
    if ("at" in s && s.on && new Date(s.on.year, s.on.month - 1, s.on.day, s.at.hour, s.at.minute).getTime() <= Date.now()) {
      throw new Error(`routine ${n}'s one-off time has passed; add it again with a future time`);
    }
    await saveRoutine(meta);
    return `routine ${n} resumed ${describe(meta.schedule)}`;
  });
}

export async function routineRemove(name: string | undefined): Promise<string> {
  const n = checkName(name);
  return withState(n, async () => {
    const meta = await readMeta(n);
    // Remove authority first, before launchd can finish a queued launch.
    await rm(join(ROUTINES, `${n}.json`), { force: true });
    stopAwake(meta);
    const had = await unload(ROUTINE_PREFIX + n);
    if (meta?.watch) await rm(stateFile(n), { force: true });
    for (const ext of ["md", "js"]) await rm(join(ROUTINES, `${n}.${ext}`), { force: true });
    return had || meta ? `routine ${n} removed` : `routine ${n} had no schedule; files cleared`;
  });
}

async function recordRun(n: string, ran: RunResult, dry = false): Promise<RunResult> {
  const dir = join(LOGS, "routines");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${n}.last`), `${new Date().toISOString()} exit ${ran.code}${dry ? " (dry)" : ""} ${ran.log}${ran.note ? ` ${ran.note.split("\n")[0]}` : ""}\n`);
  return ran;
}

async function runModel(meta: RoutineMeta, promptPath: string, log: string, lock: FileHandle, consumed: boolean): Promise<{ code: number; note?: string }> {
  const allowed = async () => {
    const current = await readMeta(meta.name);
    return current !== undefined && current.generation === meta.generation
      && (!current.paused || (consumed && current.pauseReason === "one-off schedule consumed"));
  };
  if (meta.session) {
    try {
      const rec = await selectedSession(meta.session);
      await connectHost(rec.host);
      let events = Promise.resolve();
      let continuationStarted = false;
      const done = await runSession(rec, {
        apiKey: process.env.SAFARI_MODEL_KEY, maxSteps: 30, prompt: await readFile(promptPath, "utf8"),
        shouldStop: async () => {
          if (!continuationStarted) {
            continuationStarted = await allowed();
            return !continuationStarted;
          }
          // Pause only prevents new work; removal still stops this run.
          // The run lease prevents replacement until this continuation ends.
          return (await readMeta(meta.name)) === undefined;
        },
        maxTimeMs: SCRIPT_MS,
        onEvent: (ev) => {
          if (ev.type === "tool") events = events.then(() => appendFile(log, `${new Date().toISOString()} ${ev.name} ${ev.ok ? "ok" : "error"}\n`));
          else if (ev.type === "error") events = events.then(() => appendFile(log, `error: ${ev.text}\n`));
        },
      });
      await events;
      await appendFile(log, `${done.answer ?? ""}\n`);
      return { code: done.status === "done" ? 0 : 1, note: `saved session ${done.id} ${done.status}` };
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      await withState(meta.name, async () => {
        const current = await readMeta(meta.name);
        if (current && current.generation === meta.generation) await writeMeta({ ...current, paused: true, pauseReason: note, generation: crypto.randomUUID() });
      });
      await appendFile(log, note + "\n");
      return { code: 1, note: `routine ${meta.name} paused: ${note}` };
    }
  }
  const args = ["-p", "--mode", "text", "--auto-approve", "--no-session", "--max-time", "30m"];
  if (meta.model) args.push("--model", meta.model);
  args.push(`@${promptPath}`);
  const output = await open(log, "a", 0o600);
  try {
    const started = await withState(meta.name, async () => {
      if (!(await allowed())) return { completion: Promise.resolve({ code: 1, note: `routine ${meta.name} changed or paused before starting; did not run` }) };
      const { promise, resolve } = Promise.withResolvers<{ code: number; note?: string }>();
      // fd 3 keeps the lease held if this CLI crashes while omp is alive.
      const child = spawn(OMP, args, {
        cwd: HOME, stdio: ["ignore", output.fd, output.fd, lock.fd],
        env: { ...process.env, PATH, HOME, SAFARI_ROUTINE_LOG: log },
      });
      child.once("error", (e) => resolve({ code: 1, note: e.message }));
      child.once("exit", (code, signal) => resolve({ code: code ?? 1, ...(signal ? { note: `model exited on ${signal}` } : {}) }));
      return { completion: promise };
    });
    const result = await started.completion;
    if (result.code !== 0 && result.note) await appendFile(log, result.note + "\n");
    return result;
  } finally { await output.close(); }
}

export async function routineRun(name: string | undefined, opts: { dry?: boolean; scheduled?: boolean; generation?: string } = {}): Promise<RunResult> {
  const n = checkName(name);
  const lock = await acquireLock(n, "run");
  if (!lock) return { code: 1, log: "", note: `routine ${n} is already running; this invocation did not run` };
  try {
    const work = await withState<PreparedRun>(n, async () => {
      const meta = await readMeta(n);
      if (!meta) return { result: { code: 1, log: "", note: `no routine named ${n}; this invocation did not run` } };
      if (meta.paused) return { result: { code: 1, log: "", note: `routine ${n} is paused; this invocation did not run` } };
      if (opts.scheduled && opts.generation !== meta.generation) return { result: { code: 1, log: "", note: `routine ${n} schedule changed; this queued invocation did not run` } };
      const promptPath = join(ROUTINES, `${n}.md`);
      const scriptPath = join(ROUTINES, `${n}.js`);
      const script = existsSync(scriptPath);
      if (!meta.watch && !script && !existsSync(promptPath)) throw new Error(`no routine named ${n}`);
      if (opts.dry && !script) throw new Error("--dry is for script routines");
      const once = "at" in meta.schedule ? meta.schedule.on : undefined;
      const now = new Date();
      if (opts.scheduled && once) {
        await rm(join(AGENTS, `${ROUTINE_PREFIX}${n}.plist`), { force: true });
        // Consuming the generation prevents a duplicate queued one-off.
        const next = { ...meta, paused: true, pauseReason: "one-off schedule consumed", generation: crypto.randomUUID() };
        await writeMeta(next);
        if (once.year !== now.getFullYear() || once.month !== now.getMonth() + 1 || once.day !== now.getDate()) {
          const note = `${n} did not run: it was set to run ${describe(meta.schedule)}, and the mac was asleep then`;
          const told = await alert(note).then(() => "", (e: Error) => `; the phone was not told: ${e.message}`);
          return { result: { code: 1, log: "", note: note + told }, missedDate: true };
        }
        // The one invocation that consumed the date may continue.
        meta.generation = next.generation;
      }
      const dir = join(LOGS, "routines");
      await mkdir(dir, { recursive: true });
      const log = join(dir, `${n}-${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.log`);
      await writeFile(log, "", { mode: 0o600 });
      const run = meta.watch
        ? runWatch(n, meta.watch).then(async (ran) => { await appendFile(log, `${ran.note}\n`); return ran; })
        : script ? runScript(n, await readFile(scriptPath, "utf8"), log, opts.dry === true)
        : runModel(meta, promptPath, log, lock, opts.scheduled === true && once !== undefined);
      return { log, run };
    });
    if ("result" in work) {
      // A missed date retains the existing no-last-run behavior.
      if (work.missedDate) return work.result;
      return await recordRun(n, work.result, opts.dry);
    }
    let ran: { code: number; note?: string };
    try { ran = await work.run; } catch (e) {
      ran = { code: 1, note: e instanceof Error ? e.message : String(e) };
      await appendFile(work.log, ran.note + "\n");
    }
    return await recordRun(n, { ...ran, log: work.log }, opts.dry);
  } finally { await lock.close(); }
}

// One run of a saved script in a session of its own, as `safari repl` runs
// one. What it printed, or why it failed, goes to the log and to the phone.
async function runScript(n: string, code: string, log: string, dry: boolean): Promise<{ code: number; note: string }> {
  await connectHost();
  const session = new ReplSession(`routine-${n}`, { cwd: join(LOGS, "routines", n), quiet: true });
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
