// safari doctor: whether each part the harness needs works on this Mac,
// with the one step that fixes each that does not. It only looks: it
// changes no setting and starts no Safari, and it closes the one tab it
// opens, hidden in a window of its own, for its round trip. It runs in the
// calling process, because the Accessibility and Full Disk Access that the
// input helper and Messages need belong to the caller (caller.ts).

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { input } from "../daemon/front.ts";
import { files, groupsOff } from "../daemon/groups.ts";
import { openChatDb } from "../daemon/imessage.ts";
import { daemonHttp, rpc } from "../daemon/rpc.ts";
import type { TabInfo } from "../daemon/tools.ts";
import { daemonLoaded } from "./launchd.ts";

const execFileAsync = promisify(execFile);
const DATA = join(homedir(), ".local", "share", "safari-harness");
const HEADROOM = join(homedir(), "memory", "bin", "host-headroom");
// Where Safari keeps "Allow remote automation" (AllowRemoteAutomation), in
// a plist its WebDriver framework writes when the user turns it on.
const WEBDRIVER = join(homedir(), "Library", "WebDriver");
const LOW_DISK_BYTES = 2 * 1024 ** 3;
const HIGH_SWAP_MB = 2048;
const EXTENSIONS = "in Safari > Settings > Extensions, turn Safari Harness Bridge off and on";
const TERMINAL = "turn on the terminal you run safari from";

export type Status = "ok" | "warn" | "fail" | "off" | "skip";
export type Check = { name: string; status: Status; detail: string; fix?: string };
// What the doctor reads of the daemon's /health (main.ts).
export type Health = { pid?: number; stopping?: string; extension: { connectedAt?: number } | null };
export type Pairing = { unlocked: boolean; reason?: string; sessions?: number };

// One fact each. The ones that can fail throw with the reason; the rest
// always answer.
export type Probes = {
  safariRunning: () => Promise<boolean>;
  health: () => Promise<Health | null>;
  launchd: () => Promise<boolean>;
  extensionKeys: () => Promise<{ deployed?: string; installed?: string }>;
  roundTrip: () => Promise<number>;
  accessibility: () => Promise<void>;
  messages: () => Promise<void>;
  passwords: () => Promise<Pairing>;
  safaridriverMcp: () => Promise<boolean>;
  remoteAutomation: () => Promise<boolean>;
  freeBytes: () => Promise<number>;
  swapMb: () => Promise<number | undefined>;
  groupsOff: () => string | undefined;
};

type Outcome<T> = { value: T } | { error: string };

async function outcome<T>(probe: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await probe() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// A one-line record scripts/dev-install.sh keeps, or undefined without one.
function record(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const LIVE: Probes = {
  safariRunning: async () => (await Bun.spawn(["pgrep", "-x", "Safari"], { stdout: "ignore", stderr: "ignore" }).exited) === 0,
  health: async () => {
    try {
      const res = await fetch(`${daemonHttp()}/health`, { signal: AbortSignal.timeout(3000) });
      // the daemon's own answer (main.ts)
      const health = (await res.json()) as Health;
      return health;
    } catch {
      return null;
    }
  },
  launchd: async () => daemonLoaded(),
  extensionKeys: async () => ({ deployed: record(join(DATA, "current", ".extension")), installed: record(join(DATA, "installed-extension")) }),
  // Through the page's own script and back: the doctor's /space page runs
  // the content script, as every http page does.
  roundTrip: async () => {
    const started = performance.now();
    // open answers with the tab it made (tools.ts)
    const tab = (await rpc("open", { url: `${daemonHttp()}/space?name=safari%20doctor`, background: true, group: "safari doctor" })) as TabInfo;
    try {
      await rpc("info", { tab: tab.id });
    } finally {
      await rpc("close", { tab: tab.id });
    }
    return Math.round(performance.now() - started);
  },
  // The helper checks its permission before anything else, and reads only
  // where Safari's page area is.
  accessibility: async () => {
    await input(["webarea"]);
  },
  messages: async () => {
    const db = openChatDb();
    try {
      db.query("SELECT count(*) FROM sqlite_master").get();
    } finally {
      db.close();
    }
  },
  passwords: async () => {
    // status asks nothing of Apple's helper and starts no Helium (passwords.ts)
    const pairing = (await rpc("passwords", { do: "status" })) as Pairing;
    return pairing;
  },
  safaridriverMcp: async () => {
    const help = spawnSync("/usr/bin/safaridriver", ["--help"], { encoding: "utf8", timeout: 10000 });
    return `${help.stdout ?? ""}${help.stderr ?? ""}`.includes("--mcp");
  },
  remoteAutomation: async () => {
    const plists = existsSync(WEBDRIVER) ? readdirSync(WEBDRIVER).filter((f) => f.endsWith(".plist")) : [];
    return plists.some((f) => ["true", "1"].includes(spawnSync("plutil", ["-extract", "AllowRemoteAutomation", "raw", "-o", "-", join(WEBDRIVER, f)], { encoding: "utf8" }).stdout.trim()));
  },
  freeBytes: async () => {
    const fs = statfsSync(existsSync(DATA) ? DATA : homedir());
    return fs.bavail * fs.bsize;
  },
  swapMb: async () => {
    if (!existsSync(HEADROOM)) return undefined;
    const { stdout } = await execFileAsync(HEADROOM, ["--json"], { timeout: 30000 });
    const reading: unknown = JSON.parse(stdout);
    if (reading && typeof reading === "object" && "host" in reading && reading.host && typeof reading.host === "object" && "swap_used_mb" in reading.host && typeof reading.host.swap_used_mb === "number") return reading.host.swap_used_mb;
    throw new Error("its answer has no host.swap_used_mb");
  },
  groupsOff,
};

function daemonCheck(health: Health | null, loaded: boolean): Check {
  if (health === null) {
    const fix = loaded ? "launchd starts it, but it keeps stopping: read ~/Library/Logs/safari-harness/daemon.log" : "safari daemon install";
    return { name: "daemon", status: "fail", detail: `not answering at ${daemonHttp()}`, fix };
  }
  if (health.stopping) return { name: "daemon", status: "warn", detail: `restarting (${health.stopping})`, fix: "run safari doctor again in a minute" };
  return { name: "daemon", status: "ok", detail: `answering, pid ${health.pid}` };
}

function launchdCheck(loaded: boolean, answering: boolean): Check {
  if (loaded) return { name: "launchd", status: "ok", detail: "the daemon's job is loaded, so it runs from login on" };
  if (answering) return { name: "launchd", status: "warn", detail: "no job: this daemon stops when the terminal that started it closes", fix: "safari daemon install" };
  return { name: "launchd", status: "fail", detail: "the daemon's job is not loaded", fix: "safari daemon install" };
}

function versionCheck(keys: { deployed?: string; installed?: string }): Check {
  const name = "extension version";
  if (keys.deployed === undefined) return { name, status: "skip", detail: "the deployed release does not record its extension" };
  const fix = "run scripts/dev-install.sh in the checkout; it installs the app when the extension changed";
  if (keys.installed === undefined) return { name, status: "fail", detail: "no install of the extension is recorded", fix };
  if (keys.installed !== keys.deployed) return { name, status: "fail", detail: "Safari has the extension of another release", fix };
  return { name, status: "ok", detail: "Safari has the deployed release's extension" };
}

function accessibilityCheck(got: Outcome<void>): Check {
  const name = "accessibility";
  // The helper finds no Safari window, or no page in its front one (a window
  // Safari just opened shows its start page), only after its permission
  // check passed.
  if ("value" in got || /Safari is not running|Safari has no open window|no web page is showing/.test(got.error)) {
    return { name, status: "ok", detail: "real clicks and keys (real_input) and the passwords pairing may use the mouse and keyboard" };
  }
  if (got.error.includes("Accessibility permission")) {
    return { name, status: "fail", detail: "the app running safari may not use the mouse and keyboard", fix: `System Settings > Privacy & Security > Accessibility: ${TERMINAL}` };
  }
  return { name, status: "fail", detail: got.error, fix: "rebuild the helpers: bun run helpers, in ~/.local/share/safari-harness/current" };
}

function passwordsCheck(got: Outcome<Pairing> | undefined): Check {
  const name = "passwords";
  if (got === undefined) return { name, status: "skip", detail: "needs the daemon" };
  if ("error" in got) return { name, status: "warn", detail: got.error };
  if (got.value.unlocked) return { name, status: "ok", detail: `paired with Apple Passwords; ${got.value.sessions ?? 0} session(s) hold it` };
  return { name, status: "ok", detail: `not paired now (${got.value.reason ?? "no reason given"}); the next passwords call asks for Touch ID, then pairs` };
}

// Group work turns off for good once Safari's menu stays open or it comes
// to the front (groups.ts), until someone who has looked removes the flag:
// agents only see it as a plain window, so the owner reads it here.
function groupsCheck(off: string | undefined): Check {
  if (off === undefined) return { name: "tab groups", status: "ok", detail: "each agent window becomes a tab group once the user leaves the keys alone" };
  return { name: "tab groups", status: "warn", detail: off, fix: `look over Safari's tab groups, then: rm ${files.off}` };
}

function swapCheck(got: Outcome<number | undefined>): Check {
  if ("error" in got) return { name: "swap", status: "skip", detail: `host-headroom failed: ${got.error}` };
  if (got.value === undefined) return { name: "swap", status: "skip", detail: "host-headroom is not on this Mac" };
  if (got.value >= HIGH_SWAP_MB) return { name: "swap", status: "warn", detail: `${(got.value / 1024).toFixed(1)} GB of swap in use: Safari and its pages run slower`, fix: "quit apps you are not using" };
  return { name: "swap", status: "ok", detail: `${Math.round(got.value)} MB of swap in use` };
}

function laneCheck(mcp: boolean, remote: boolean): Check {
  const name = "safaridriver";
  if (!mcp) return { name, status: "off", detail: "this Mac's safaridriver has no --mcp, so Apple's own automation lane is not available" };
  if (!remote) {
    return {
      name,
      status: "off",
      detail: "Allow remote automation is off, so Apple's safaridriver --mcp lane is not available",
      fix: "Safari > Settings > Developer > Allow remote automation and external agents (the Developer tab shows once Settings > Advanced > Show features for web developers is on)",
    };
  }
  return { name, status: "ok", detail: "Apple's safaridriver --mcp may drive Safari for public pages (safari guide reference, \"Two lanes\")" };
}

export async function doctor(probe: Probes = LIVE): Promise<Check[]> {
  const [safari, health, loaded, keys, access, messages, mcp, remote, free, swap] = await Promise.all([
    probe.safariRunning(),
    probe.health(),
    probe.launchd(),
    probe.extensionKeys(),
    outcome(probe.accessibility),
    outcome(probe.messages),
    probe.safaridriverMcp(),
    probe.remoteAutomation(),
    probe.freeBytes(),
    outcome(probe.swapMb),
  ]);
  const up = health !== null && !health.stopping;
  const connected = up && safari && health.extension !== null;
  // Nothing that asks the daemon runs while it is down (a call waits 15 s
  // for it), and no tab opens while Safari is not running: opening one
  // would start it.
  const [trip, pairing] = await Promise.all([connected ? outcome(probe.roundTrip) : undefined, up ? outcome(probe.passwords) : undefined]);
  const missing = !up ? "needs the daemon" : !safari ? "needs Safari running" : "needs the extension";
  const since = health?.extension?.connectedAt;
  return [
    safari
      ? { name: "safari", status: "ok", detail: "running" }
      : { name: "safari", status: "warn", detail: "not running, so the checks that need it did not run", fix: "open Safari, then run safari doctor again" },
    daemonCheck(health, loaded),
    launchdCheck(loaded, health !== null),
    !up || !safari
      ? { name: "extension", status: "skip", detail: missing }
      : health.extension === null
        ? { name: "extension", status: "fail", detail: "Safari Harness Bridge is not connected", fix: EXTENSIONS }
        : { name: "extension", status: "ok", detail: `connected${since ? ` since ${new Date(since).toLocaleString("sv").slice(5, 16)}` : ""}` },
    versionCheck(keys),
    trip === undefined
      ? { name: "round trip", status: "skip", detail: missing }
      : "error" in trip
        ? { name: "round trip", status: "fail", detail: trip.error, fix: `${EXTENSIONS}, then run safari doctor again` }
        : { name: "round trip", status: "ok", detail: `a hidden tab opened, answered, and closed in ${trip.value} ms` },
    accessibilityCheck(access),
    "error" in messages
      ? { name: "messages", status: "fail", detail: "cannot read the Messages database, so codes sent by text are not found", fix: `System Settings > Privacy & Security > Full Disk Access: ${TERMINAL}` }
      : { name: "messages", status: "ok", detail: "the Messages database is readable, so codes sent by text are found" },
    passwordsCheck(pairing),
    free < LOW_DISK_BYTES
      ? { name: "disk", status: "fail", detail: `${(free / 1024 ** 3).toFixed(1)} GB free`, fix: "free up space: downloads, saved PDFs, and deploys need it" }
      : { name: "disk", status: "ok", detail: `${(free / 1024 ** 3).toFixed(1)} GB free` },
    swapCheck(swap),
    groupsCheck(probe.groupsOff()),
    laneCheck(mcp, remote),
  ];
}

// Plain text: one check a line, and under each problem the step for it.
export function report(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.flatMap((c) => {
    const line = `${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`;
    return c.fix ? [line, `${" ".repeat(width + 8)}${c.status === "off" ? "to turn on" : "fix"}: ${c.fix}`] : [line];
  });
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  lines.push("", failed ? `${failed} of ${checks.length} checks failed` : warned ? `no check failed; ${warned} to look at` : "no check failed");
  return lines.join("\n");
}
