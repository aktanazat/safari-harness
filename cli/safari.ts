#!/usr/bin/env bun
// safari — drive Safari from the terminal, aside-cli style.
//
//   safari tabs
//   safari open https://example.com --bg      # prints the tab's id, say 7
//   safari snapshot --tab 7
//   safari click 12 --tab 7
//   safari type 14 "hello" --tab 7
//   safari eval "document.title" --tab 7
//   safari extract --tab 7
//   safari shot --tab 7
//   safari repl "const p = await openTab('https://example.com'); console.log(await p.title())"
//   safari do "find the price of X on example.com"
//   safari serve            # start the daemon (the extension connects to it)
//
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { TOOLS, formatResult, resolveTab, type TabInfo, type Tool } from "../daemon/tools.ts";
import { CALLER_TOOLS } from "../daemon/caller.ts";
import { invoke } from "../daemon/call.ts";
import { nameIn } from "../daemon/guard.ts";
import { daemonHttp } from "../daemon/rpc.ts";
import { connectHost, hostHealth, listHosts, readHostConfig, setDefaultHost } from "../daemon/host.ts";
import type { AgentEvent } from "../daemon/agent.ts";
import type { SessionRecord } from "../daemon/sessions.ts";
import type { JournalEvent } from "../daemon/journal.ts";
import type { Overview } from "../daemon/mission.ts";

// Commands beyond the tools (guide, repl, session, do, daemon, routine, doctor)
// import their own modules when they run: imported here, those modules
// would add 5 ms to the start of every command.

const USAGE = `safari — drive Safari from the terminal

  safari guide                               the short card of rules for browsing
  safari guide reference                     every tool in full
  safari serve [--ws 37333] [--http 37334]   start the daemon in the foreground
  safari daemon install|uninstall            keep the daemon always on (launchd)
  safari status                              daemon + extension health
  safari agents                              agents using Safari now, and the page
                                             that pauses or stops them
  safari doctor                              check every part the harness needs on this
                                             Mac, with the fix for each that fails
  safari tabs [--site host] [--all]          your tabs, his front one, a count of his;
                                             --site lists his on one site, --all every tab
  safari open <url> [--bg] [--keep]          open a tab; prints its id
  safari goto <url> --tab N                  navigate
  safari back|forward|reload --tab N         history
  safari close <tab>                         close a tab
  safari focus <tab>                         activate a tab
  safari snapshot --tab N [--query text] [--root sel] [--diff]
                                             page outline with [ref]s
  safari click <ref> --tab N                 click by snapshot ref
  safari clickat <x> <y> --tab N             click by coordinates
  safari type <ref> <text> --tab N           type by ref; '{{code}}' in text types the
                                             code texted to him (--secret passwords: his saved one)
  safari press <key> [--ref R] --tab N       press a key
  safari select <ref> <option> --tab N       choose a dropdown option
  safari hover <ref> --tab N                 hover an element
  safari upload <file>... [--ref R] --tab N
                                             attach files to a file input
  safari upload --find <words> --tab N       list the user's files that match, to pick
                                             one (iCloud Drive, Documents, Desktop,
                                             Downloads); attaches nothing
  safari scroll <dy> --tab N                 scroll

  Page commands need --tab N, the id open printed, or --tab front for the
  tab the user has in front. Background tabs a command opens (--bg) close
  once the program that ran safari exits, or after 20 minutes unused;
  --keep leaves them open.

  Actions (open goto back forward reload click clickat type press select
  hover upload) take --snapshot to print the resulting page too.

  Reads (snapshot eval extract fetch) take --save to write the whole output
  to a new file in ~/.local/share/safari-harness/saved, or --save=<file>,
  and print only its path, size, and first 500 characters.

  safari eval <js> --tab N [--page]          run JS, print the last value as JSON
  safari extract --tab N [--selector s]      readable text
  safari extract --as table --tab N          tables and card lists as JSON rows
  safari data --tab N [--pick path] [--max bytes]
                                             the page's own data as JSON (JSON-LD, Next.js, ...)
  safari info --tab N                        url/title/scroll
  safari wait <ms> --tab N                   sleep in the page
  safari wait [--selector s] [--text t] [--ms timeout] --tab N [--front]
                                             wait until it is on the page; --front
                                             holds the tab on screen meanwhile
  safari net read|start|stop --tab N         fetch/XHR since the page loaded
  safari console start|read --tab N          console capture
  safari cookies --tab N                     cookies for the page
  safari shot --tab N [--out file.png] [--ref R] [--annotate] [--full]
                                             screenshot what the tab shows
  safari download <ref|url> [--out file] --tab N
                                             save a file into ~/Downloads
  safari dialog [read|accept|dismiss] [text] --tab N
                                             how the tab answers alerts and confirms
  safari fetch <url> --tab N                 request a URL with the page's cookies
  safari map <url>... [--what extract|snapshot|eval|fetch] [--save[=dir]]
                                             read up to 20 pages at once, each in a
                                             background tab that closes after
                                             (--expression js, --as table, --concurrency 4)
  safari pdf [save|read] [file.pdf] [--out file.pdf] [--tab N]
                                             print the page to PDF, or read a PDF
                                             (a file.pdf needs no tab)
  safari window <width> <height> --tab N     give a tab its own window at that size
  safari history-search [text]               search Safari browsing history
  safari fill address [--label home] --tab N
                                             your address, name, email, phone from your Contacts card
  safari fill login [--bitwarden] [--user name] --tab N
                                             a saved login (Apple Passwords, or Bitwarden); you never see it
  safari call <tool> '<json args>'           any tool by name, as MCP calls it
  safari <tool> [--<param> value ...]        the same, with each parameter as a flag
                                             (safari passwords logins --tab N: a first word is do)

  safari repl [--session name] [code]        Playwright-style JavaScript with site globals
                                             (code from stdin when omitted, or --file path); see: safari guide repl
  safari repl --list | --close <name>        named sessions still running; end one

  safari do "<task>" [--tab N] [--steps 30] [--model m]
                                             run the agent loop (local model); prints its session
  safari session list | show <id>            agent sessions, newest first; one's transcript
  safari session resume <id> ["<prompt>"]    go on with a session
  safari session steer <id> "<text>"         tell a running session now (cuts in)
  safari session queue <id> "<text>"         give a running session its next task
  safari session stop|delete <id>

  safari host [list] | use <ssh-host|local> | status [host]
                                             drive another Mac's Safari through ssh
  safari mcp                                 run the MCP stdio server (thin client)
  safari routine add <name> --at HH:MM|--every MIN [--model m] "<task>"
  safari routine list | run <name> | remove <name>
                                             scheduled tasks run through omp
  safari routine add <name> --at HH:MM|--every MIN --watch <url>
                      --selector CSS | --text REGEX | --eval JS | --replay <recording>
                                             a watch: no model; texts your phone when the
                                             value it reads off the page changes

  safari guide sites                         sites with a usage guide
  safari guide <site|host>                   one site's guide and learned notes (e.g. slack, x.com)
  safari guide repl                          the REPL's API and recipes
  safari learn <site> "<fact>"               save a fact about a site for later agents
                                             (at most 300 characters; never a secret)
  safari learn <site> [--forget <n>]         list a site's notes; remove note n

  safari imessage chats [--limit N]          recent conversations
  safari imessage history <chat> [--limit N] [--since rowid]
                                             one conversation (id, phone, email, or name)
  safari imessage search [text] [--from who] [--days 90]
                                             search messages
  safari imessage code [--seconds 30] [--since rowid]
                                             wait for a sign-in code by text
  safari imessage send <to> <text> [--approved]
                                             draft a text; sends only with --approved
  safari contacts <name>                     phones and emails for a contact
  safari ask "<question>" [--choices a,b,c] [--ms N]
                                             away from the Mac, text your phone the question
                                             and wait for the answer; at the Mac, send nothing

  Every command takes --host <ssh-host> to use another Mac's Safari, and
  --json to print JSON. Messages, Contacts, history, ask, and fill commands
  run in this terminal (they need its Full Disk Access), not in the daemon.
  A command's parameters also work as flags (click --ref 3 is click 3), and
  safari <command> --help lists them.
`;

const json = process.argv.includes("--json");

function print(value: unknown) {
  console.log(json ? JSON.stringify(value) : formatResult(value));
}

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

function flag(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

function hasFlag(name: string, argv: string[]): boolean {
  return argv.includes(`--${name}`);
}

function tabArg(argv: string[]): Record<string, unknown> {
  const t = flag("tab", argv);
  if (t === undefined) return {};
  return { tab: t === "front" ? t : Number(t) };
}

// --save writes a read's whole output to a new file in the saved folder;
// --save=<path> names the file. A relative path is the terminal's, not the
// daemon's.
function saveArg(argv: string[]): Record<string, unknown> {
  if (hasFlag("save", argv)) return { save: true };
  const path = flag("save", argv);
  return path === undefined ? {} : { save: resolve(path) };
}

// The tool a command runs, where its name differs.
const ALIAS: Record<string, string> = { focus: "activate", back: "history", forward: "history", reload: "history", clickat: "click", "history-search": "browsing_history", "browsing-history": "browsing_history" };

const toolDef = (cmd: string): Tool | undefined => TOOLS[ALIAS[cmd] ?? cmd] ?? CALLER_TOOLS[ALIAS[cmd] ?? cmd];

// A tool's parameters given as --name value; a boolean one needs only --name.
function flagArgs(tool: Tool, argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(tool.params)) {
    if (p.type === "boolean") {
      if (hasFlag(name, argv)) args[name] = true;
      continue;
    }
    const v = flag(name, argv);
    if (v === undefined) continue;
    args[name] = p.type === "number" ? Number(v) : p.type === "array" ? (v.startsWith("[") ? JSON.parse(v) : [v]) : v;
  }
  return args;
}

// The command's lines from USAGE, then its tool's parameters.
function commandHelp(cmd: string): string | null {
  const lines = USAGE.split("\n");
  const usage: string[] = [];
  lines.forEach((line, i) => {
    if (!new RegExp(`^  safari ${cmd.replace(/[^\w-]/g, "")}\\b`).test(line)) return;
    usage.push(line);
    for (let j = i + 1; j < lines.length && /^ {20,}\S/.test(lines[j]); j++) usage.push(lines[j]);
  });
  const def = toolDef(cmd);
  if (!def) return usage.length ? usage.join("\n") : null;
  const params = Object.entries(def.params).map(([name, p]) =>
    `  --${name}${p.type === "boolean" ? "" : ` <${p.enum?.join("|") ?? p.type ?? "string"}>`}${def.required?.includes(name) ? " (required)" : ""}\n      ${p.description}`);
  return [...usage, ...(usage.length ? [""] : []), def.desc, "", ...params].join("\n");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return Bun.stdin.text();
}

function showEvent(ev: AgentEvent) {
  if (ev.type === "plan") console.error(`\x1b[2m▸ ${ev.text}\x1b[0m`);
  else if (ev.type === "tool") {
    const arg = JSON.stringify(ev.args).slice(0, 90);
    console.error(ev.ok ? `\x1b[36m● ${ev.name} ${arg}\x1b[0m` : `\x1b[31m✗ ${ev.name} ${arg} — ${ev.error}\x1b[0m`);
  } else if (ev.type === "user") console.error(`\x1b[33m${ev.kind === "steer" ? "↳ steer" : "+ queued"}: ${ev.text}\x1b[0m`);
  else if (ev.type === "answer") console.error(`\x1b[2m■ answered\x1b[0m`);
  else if (ev.type === "error") console.error(`\x1b[31m! ${ev.text}\x1b[0m`);
}

async function runAndReport(rec: SessionRecord, argv: string[]) {
  const { runSession } = await import("../daemon/sessions.ts");
  const done = await runSession(rec, { apiKey: process.env.SAFARI_MODEL_KEY, maxSteps: Number(flag("steps", argv) ?? 30), onEvent: showEvent });
  if (done.status !== "done") console.error(`session ${done.id} ${done.status}; go on with: safari session resume ${done.id} "<prompt>"`);
  console.log(done.answer ?? "");
}

async function sessionCommand(argv: string[]) {
  const { deleteSession, isRunning, listSessionRecords, loadSession, sendControl, statusOf, transcript } = await import("../daemon/sessions.ts");
  const [sub, id, ...words] = argv.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, argv));
  const text = words.join(" ");
  switch (sub) {
    case undefined:
    case "list": {
      const recs = await listSessionRecords();
      if (json) return print(recs.map(({ messages, ...r }) => ({ ...r, status: statusOf({ ...r, messages }), steps: messages.filter((m) => m.role === "assistant").length })));
      if (!recs.length) return console.log("no sessions yet; start one with: safari do \"<task>\"");
      for (const r of recs) console.log(`${r.id}  ${statusOf(r).padEnd(12)} ${r.updated.slice(0, 16).replace("T", " ")}  ${r.task.replace(/\s+/g, " ").slice(0, 70)}`);
      return;
    }
    case "show":
      return console.log(json ? JSON.stringify(await loadSession(id ?? "")) : transcript(await loadSession(id ?? "")));
    case "resume": {
      const rec = await loadSession(id ?? "");
      if (isRunning(rec)) fail(`session ${rec.id} is running; talk to it with: safari session steer ${rec.id} "<text>"`);
      const last = rec.messages.at(-1);
      if (text) rec.messages.push({ role: "user", content: text });
      else if (last?.role === "assistant" && !last.tool_calls?.length) fail(`session ${rec.id} has answered; give it a prompt: safari session resume ${rec.id} "<prompt>"`, 2);
      await connectHost(flag("host", argv) ?? (rec.host === "local" ? undefined : rec.host));
      if (process.env.SAFARI_MODEL) rec.model = process.env.SAFARI_MODEL;
      if (process.env.SAFARI_MODEL_BASE) rec.baseUrl = process.env.SAFARI_MODEL_BASE;
      return runAndReport(rec, argv);
    }
    case "steer":
    case "queue":
      if (!text) fail(`usage: safari session ${sub} <id> "<text>"`, 2);
      await sendControl(id ?? "", { kind: sub, text });
      return console.log(sub === "steer" ? `sent; session ${id} takes it before its next step` : `queued; session ${id} starts on it once it answers`);
    case "stop": {
      await sendControl(id ?? "", { kind: "stop" });
      for (let i = 0; i < 60; i++) {
        await Bun.sleep(500);
        const rec = await loadSession(id ?? "");
        if (!isRunning(rec)) return console.log(`session ${id} ${statusOf(rec)}`);
      }
      return console.log(`asked session ${id} to stop; it stops after the step it is on`);
    }
    case "delete":
      await deleteSession(id ?? "");
      return console.log(`deleted session ${id}`);
    default:
      fail("usage: safari session list|show|resume|steer|queue|stop|delete", 2);
  }
}

async function hostCommand(argv: string[]) {
  const [sub, name] = argv.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, argv));
  if (!sub || sub === "list") {
    const hosts = await listHosts();
    if (json) return print(hosts);
    for (const h of hosts) console.log(`${h.default ? "*" : " "} ${h.name}`);
    return;
  }
  if (sub === "use") {
    if (!name) fail("usage: safari host use <ssh-host|local>", 2);
    return print(await setDefaultHost(name));
  }
  if (sub === "status") return print(await hostHealth(name ?? (await readHostConfig()).default ?? "local"));
  fail("usage: safari host [list] | use <ssh-host|local> | status [host]", 2);
}

async function replCommand(argv: string[]) {
  const { closeSession, listSessions, runInSession } = await import("../daemon/repl-host.ts");
  const { ReplSession } = await import("../daemon/repl.ts");
  const session = flag("session", argv);
  if (hasFlag("list", argv)) {
    const running = await listSessions();
    if (json) return print(running);
    if (!running.length) return console.log("no named sessions running");
    for (const s of running) console.log(`${s.id}  on ${s.host}  last used ${s.lastUsed.slice(0, 16).replace("T", " ")}  ${s.tabs.length} tab(s)  ${s.pwd}`);
    return;
  }
  const closing = flag("close", argv);
  if (closing) return console.log(await closeSession(closing));
  // --file runs a script saved to disk: agents reached for it (01a0e50b).
  const file = flag("file", argv);
  const code = file !== undefined ? await Bun.file(resolve(file)).text() : argv.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, argv)).join(" ") || (await readStdin());
  if (!code.trim()) fail('usage: safari repl [--session name] "<code>" | --file path (or pipe the code in)', 2);
  let result: { output: string; error?: string };
  if (session) {
    const r = await runInSession(session, code, { host: flag("host", argv) });
    if (r.started) console.error(`\x1b[2m(session ${session} started; it ends after 30 min unused, or: safari repl --close ${session})\x1b[0m`);
    result = r;
  } else {
    // One call, one session: its bindings and tabs end with it.
    await connectHost(flag("host", argv));
    const one = new ReplSession("once");
    try {
      result = await one.run(code);
    } finally {
      await one.close();
    }
  }
  if (json) return print(result);
  if (result.output) console.log(result.output);
  if (result.error) fail(result.error);
}

async function fillCommand(argv: string[]) {
  const what = argv.find((a, i) => !a.startsWith("--") && !isFlagValue(i, argv));
  await connectHost(flag("host", argv));
  const { tab } = tabArg(argv);
  if (what === "address") return print(await invoke("fill_address", { tab, label: flag("label", argv), root: flag("root", argv) }));
  if (what === "login") {
    const username = flag("user", argv);
    return print(hasFlag("bitwarden", argv) ? await invoke("bitwarden", { do: "fill", tab, username }) : await invoke("passwords", { do: "fill", tab, username }));
  }
  fail("usage: safari fill address [--label home] | login [--bitwarden] [--user name]", 2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); process.exit(cmd ? 0 : 1); }
  if (rest.includes("--help")) {
    const text = commandHelp(cmd);
    if (text === null) fail(`unknown command: ${cmd}\n\n${USAGE}`, 2);
    console.log(text);
    return;
  }

  if (cmd === "serve") {
    const ws = flag("ws", rest);
    const http = flag("http", rest);
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (ws) env.SAFARI_HARNESS_WS = ws;
    if (http) env.SAFARI_HARNESS_HTTP_PORT = http;
    const child = spawn(process.execPath, [new URL("../daemon/main.ts", import.meta.url).pathname], {
      stdio: "inherit",
      env,
    });
    process.on("SIGINT", () => child.kill("SIGINT"));
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  if (cmd === "guide") {
    const which = rest.find((a) => !a.startsWith("--"));
    const { guide } = await import("../daemon/guides.ts");
    const text = await guide(which);
    if (text === null) fail(`no guide for ${which}; see: safari guide sites`);
    console.log(text);
    return;
  }

  if (cmd === "daemon") {
    const sub = rest[0];
    const { daemonInstall, daemonUninstall } = await import("./launchd.ts");
    if (sub === "install") console.log(await daemonInstall());
    else if (sub === "uninstall") console.log(await daemonUninstall());
    else { console.error("usage: safari daemon install|uninstall"); process.exit(2); }
    return;
  }

  if (cmd === "routine") {
    const [sub, ...r] = rest;
    const { parseSchedule, routineAdd, routineAddWatch, routineList, routineRemove, routineRun } = await import("./launchd.ts");
    const pos = r.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, r));
    if (sub === "add") {
      const schedule = parseSchedule(flag("at", r), flag("every", r));
      const url = flag("watch", r);
      if (url === undefined) console.log(await routineAdd(pos[0], pos.slice(1).join(" "), schedule, flag("model", r)));
      else if (pos.length > 1) fail("a watch runs no model, so it takes no task");
      else console.log(await routineAddWatch(pos[0], url, { selector: flag("selector", r), text: flag("text", r), eval: flag("eval", r), replay: flag("replay", r) }, schedule));
    } else if (sub === "list") {
      print(await routineList());
    } else if (sub === "run") {
      const { code, log, note } = await routineRun(pos[0]);
      if (note !== undefined) console.log(note);
      console.log(`exit ${code}; log: ${log}`);
      process.exit(code);
    } else if (sub === "remove") {
      console.log(await routineRemove(pos[0]));
    } else {
      console.error("usage: safari routine add|list|run|remove");
      process.exit(2);
    }
    return;
  }

  if (cmd === "host") return hostCommand(rest);
  if (cmd === "repl") return replCommand(rest);
  if (cmd === "session") return sessionCommand(rest);
  if (cmd === "fill") return fillCommand(rest);

  if (cmd === "mcp") {
    const host = flag("host", rest);
    const child = spawn(process.execPath, [new URL("../daemon/mcp.ts", import.meta.url).pathname], {
      stdio: "inherit",
      env: { ...process.env as Record<string, string>, ...(host ? { SAFARI_HARNESS_HOST: host } : {}) },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // doctor: this Mac's harness only, whatever host is the default; it exits
  // 1 when a check fails (--json: the checks as data).
  if (cmd === "doctor") {
    const { doctor, report } = await import("./doctor.ts");
    const checks = await doctor();
    const failed = checks.some((c) => c.status === "fail");
    console.log(json ? JSON.stringify({ ok: !failed, checks }) : report(checks));
    process.exit(failed ? 1 : 0);
  }

  // Everything below talks to a daemon: this Mac's, or --host's.
  const host = await connectHost(flag("host", rest));

  // status: the daemon, its extension, and what happened to them lately,
  // one event a line (--json: the whole health answer).
  if (cmd === "status") {
    type Health = { pid?: number; code?: string; root?: string; inFlight?: number; stopping?: string; extension: { connectedAt?: number } | null; journal?: JournalEvent[] };
    const h = await fetch(`${daemonHttp()}/health`).then((r) => r.json() as Promise<Health>, () => fail(`daemon not reachable at ${daemonHttp()} — run: safari daemon install`));
    if (json) return print(h);
    const at = (t: string | number) => new Date(t).toLocaleString("sv").slice(5);
    console.log(`daemon ${h.pid ?? "running"}${h.stopping ? `, stopping: ${h.stopping}` : ""}, ${h.inFlight ?? 0} call(s) in flight${h.root ? `, running ${h.root} (code ${h.code})` : ""}`);
    console.log(h.extension ? `extension connected${h.extension.connectedAt ? ` since ${at(h.extension.connectedAt)}` : ""}` : "extension not connected: Safari is closed, or Safari Harness is off in Safari Settings > Extensions");
    for (const { t, kind, ...rest } of h.journal ?? []) console.log(`${at(t)}  ${kind}${Object.keys(rest).length ? `  ${JSON.stringify(rest)}` : ""}`);
    return;
  }

  // agents: every agent that used Safari in the last hour, its last call,
  // and the pages that show it and let the user pause or stop it (--json:
  // the whole answer).
  if (cmd === "agents") {
    const o = await fetch(`${daemonHttp()}/agents.json`).then((r) => r.json() as Promise<Overview>, () => fail(`daemon not reachable at ${daemonHttp()} — run: safari daemon install`));
    if (json) return print(o);
    for (const a of o.agents) {
      const tabs = a.tabs === null ? "" : `, ${a.tabs} tab${a.tabs === 1 ? "" : "s"}`;
      console.log(`${a.owner === null ? "no agent" : `agent ${a.owner}${a.process ? ` (${a.process})` : ""}`}: ${a.status}${tabs}`);
      for (const t of a.tasks) console.log(`  ${t.name}  ${daemonHttp()}/space?id=${t.id}&name=${encodeURIComponent(t.name)}`);
      const c = a.last;
      if (c) console.log(`  last: ${new Date(c.t).toLocaleTimeString("sv")} ${c.tool} ${c.args}  ${c.error ?? c.outcome ?? (c.held ? "held" : "running")}`);
    }
    if (o.agents.length === 0) console.log("no agent has used Safari in the last hour");
    console.log(`watch, pause, or stop them: ${daemonHttp()}/agents`);
    return;
  }

  if (cmd === "do") {
    const task = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest)).join(" ");
    if (!task) fail("usage: safari do \"<task>\" [--tab N] [--steps N] [--model m]", 2);
    const { newSession } = await import("../daemon/sessions.ts");
    const tab = flag("tab", rest);
    const rec = await newSession(task, {
      tab: tab === undefined ? undefined : await resolveTab(tab, async () => (await invoke("tabs", {})) as TabInfo[]),
      host,
      model: flag("model", rest) ?? process.env.SAFARI_MODEL ?? "gemma4:12b-mlx",
      baseUrl: process.env.SAFARI_MODEL_BASE ?? "http://127.0.0.1:11434/v1",
    });
    console.error(`\x1b[2msession ${rec.id} · steer it: safari session steer ${rec.id} "<text>"\x1b[0m`);
    return runAndReport(rec, rest);
  }

  if (cmd === "imessage" || cmd === "contacts") {
    const pos = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest));
    const numFlag = (name: string) => (flag(name, rest) === undefined ? undefined : Number(flag(name, rest)));
    const sub = cmd === "contacts" ? "contacts" : pos.shift();
    const calls: Record<string, [string, Record<string, unknown>]> = {
      contacts: ["contacts", { name: pos.join(" ") }],
      chats: ["imessage_chats", { limit: numFlag("limit") }],
      history: ["imessage_history", { chat: pos.join(" "), limit: numFlag("limit"), since: numFlag("since") }],
      search: ["imessage_search", { text: pos.join(" ") || undefined, from: flag("from", rest), days: numFlag("days"), limit: numFlag("limit") }],
      code: ["imessage_wait_code", { seconds: numFlag("seconds"), since: numFlag("since") }],
      send: ["imessage_send", { to: pos[0], text: pos.slice(1).join(" "), approved: hasFlag("approved", rest) }],
    };
    const call = sub ? calls[sub] : undefined;
    if (!call) fail("usage: safari imessage chats|history|search|code|send …, or safari contacts <name>", 2);
    print(await invoke(...call, true));
    return;
  }

  // One tool call waits about 2 minutes for the answer; the command waits
  // out all of ms.
  if (cmd === "ask") {
    const choices = flag("choices", rest)?.split(",").map((c) => c.trim()).filter(Boolean);
    const ms = flag("ms", rest);
    const args = { question: rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest)).join(" "), ...(choices ? { choices } : {}), ...(ms === undefined ? {} : { ms: Number(ms) }) };
    for (;;) {
      const r = await invoke("ask", args);
      if (!(r && typeof r === "object" && "waiting" in r)) return print(r);
    }
  }

  const positional = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest));
  let tool = ALIAS[cmd] ?? cmd;
  let args: Record<string, unknown> = { ...tabArg(rest), ...saveArg(rest), ...(hasFlag("snapshot", rest) ? { snapshot: true } : {}) };

  switch (cmd) {
    // --site, since --host names another Mac
    case "tabs": args.host = flag("site", rest) ?? null; break;
    case "open": args.url = positional[0]; args.background = hasFlag("bg", rest); break;
    case "goto": args.url = positional[0]; break;
    case "back": case "forward": case "reload": args.do = cmd; break;
    case "close": case "focus": if (positional[0] !== undefined) args.tab = Number(positional[0]); break;
    case "snapshot": {
      const root = flag("root", rest);
      if (root) args.root = root;
      const query = flag("query", rest);
      if (query) args.query = query;
      const max = flag("max", rest);
      if (max) args.maxNodes = Number(max);
      if (hasFlag("diff", rest)) args.diff = true;
      break;
    }
    case "click": args.ref = positional[0]; break;
    case "clickat": args.x = Number(positional[0]); args.y = Number(positional[1]); break;
    case "type": args.ref = positional[0]; args.text = positional.slice(1).join(" ").replace(/^"|"$/g, ""); args.append = hasFlag("append", rest); break;
    case "press": {
      args.key = positional[0];
      const ref = flag("ref", rest);
      if (ref) args.ref = ref;
      break;
    }
    case "select": args.ref = positional[0]; args.option = positional.slice(1).join(" "); break;
    case "hover": args.ref = positional[0]; break;
    case "upload": {
      if (positional.length) args.paths = positional.map((p) => resolve(p));
      const ref = flag("ref", rest);
      if (ref) args.ref = ref;
      break;
    }
    case "scroll": args.dy = Number(positional[0] ?? 600); break;
    case "eval": args.expression = positional.join(" "); args.page = hasFlag("page", rest); break;
    case "extract": {
      const sel = flag("selector", rest);
      if (sel) args.selector = sel;
      break;
    }
    case "info": break;
    case "wait": {
      const ms = positional[0] ?? flag("ms", rest);
      if (ms !== undefined) args.ms = Number(ms);
      const sel = flag("selector", rest);
      if (sel) args.selector = sel;
      const text = flag("text", rest);
      if (text) args.text = text;
      if (hasFlag("front", rest)) args.front = true;
      break;
    }
    case "net": case "console":
      if (positional[0]) args.do = positional[0];
      break;
    case "cookies": {
      const u = flag("url", rest);
      if (u) args.url = u;
      break;
    }
    case "shot": {
      const out = flag("out", rest);
      if (out) args.out = out;
      const ref = flag("ref", rest);
      if (ref) args.ref = ref;
      args.annotate = hasFlag("annotate", rest);
      args.fullPage = hasFlag("full", rest);
      break;
    }
    case "download": {
      const target = positional[0] ?? "";
      if (/^https?:/.test(target)) args.url = target;
      else args.ref = target;
      const out = flag("out", rest);
      if (out) args.out = resolve(out);
      break;
    }
    case "dialog":
      if (positional[0]) args.do = positional[0];
      if (positional[1] !== undefined) args.text = positional.slice(1).join(" ");
      break;
    case "fetch": args.url = positional[0]; break;
    case "map": args.urls = positional; break;
    case "pdf": {
      args.do = positional[0] ?? "save";
      if (positional[1]) args.path = resolve(positional[1]);
      const out = flag("out", rest);
      if (out) args.out = resolve(out);
      break;
    }
    case "window": args.width = Number(positional[0]); args.height = Number(positional[1]); break;
    case "history-search": case "browsing-history": args = { text: positional.join(" ") || undefined }; break;
    case "learn": args.site = positional[0]; if (positional.length > 1) args.fact = positional.slice(1).join(" "); break;
    case "call": {
      tool = positional[0] ?? "";
      const body = positional.slice(1).join(" ");
      try {
        args = { ...args, ...(body ? JSON.parse(body) as Record<string, unknown> : {}) };
      } catch {
        fail("usage: safari call <tool> '<json args>'", 2);
      }
      break;
    }
    default: {
      // Any tool by name, however it is written (login-form for login_form).
      const name = nameIn([...Object.keys(TOOLS), ...Object.keys(CALLER_TOOLS)], cmd);
      if (!name) fail(`unknown command: ${cmd}\n\n${USAGE}`, 2);
      tool = name;
      // safari passwords status: the word after a tool that takes do is its do.
      if (positional[0] !== undefined && toolDef(tool)?.params.do) args.do = positional[0];
    }
  }

  // Parameters given as flags fill what the positional words left out.
  const def = toolDef(tool);
  if (def) {
    for (const [k, v] of Object.entries(flagArgs(def, rest))) {
      if (args[k] === undefined || args[k] === "" || Number.isNaN(args[k])) args[k] = v;
    }
  }

  print(await invoke(tool, args, true));
}

// Flags that take no value; the word after them is positional.
const BOOLEAN_FLAGS = new Set(["bg", "keep", "append", "snapshot", "approved", "diff", "page", "annotate", "full", "json", "list", "bitwarden", "save", "all"]);

function isFlagValue(i: number, argv: string[]): boolean {
  const prev = argv[i - 1];
  return i > 0 && prev.startsWith("--") && !prev.includes("=") && !BOOLEAN_FLAGS.has(prev.slice(2));
}

main().then(
  // A tunnel to another Mac keeps the event loop alive; the command is done.
  () => process.exit(0),
  (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
);
