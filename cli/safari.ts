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
import { nameIn, nearest, paramFor } from "../daemon/guard.ts";
import { waitPairingOut } from "../daemon/pair.ts";
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
  safari keep <tab>                          leave a tab open for the user when your
                                             turn ends
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
  tab the user has in front. Tabs a command opens close when omp's turn
  ends, once the program that ran safari exits, or after 20 minutes
  unused; --keep on open, or safari keep <tab>, leaves one open for him.

  Actions (open goto back forward reload click clickat type press select
  hover upload) take --snapshot to print the resulting page too.

  Reads (snapshot eval extract fetch) take --save to write the whole output
  to a new file in ~/.local/share/safari-harness/saved, or --save=<file>
  (or --save <file>, for a path starting with / ./ or ../), and print only
  its path, size, and first 500 characters.

  safari eval <js> --tab N [--page]          run JS, print the last value as JSON
                                             (code from --file path, or stdin when omitted;
                                             --reader name runs a script saved with learn)
  safari extract --tab N [--selector s]      readable text
  safari extract --as table --tab N          tables and card lists as JSON rows
  safari data --tab N [--pick path] [--max bytes]
                                             the page's own data as JSON (JSON-LD, Next.js, ...)
  safari info --tab N                        url/title/scroll
  safari wait <ms> --tab N                   until the page goes quiet, ms at most
  safari wait [--selector s] [--text t] [--ms timeout] --tab N [--front]
                                             wait until it is on the page; --front
                                             holds the tab on screen meanwhile
  safari wait --any '["a","b"]' | --gone t | --url part|/re/ | --quiet --tab N
                                             the first text shown (which), text gone,
                                             an address, or 0.5 s without a change
  safari wait --changed [--ms 25000] --tab N new lines since the last look (added):
                                             a chat's reply; call again until found
  safari net read|start|stop --tab N         fetch/XHR since the page loaded
  safari net read --body I|URL-PART --tab N  one request's whole body: its index, or
                                             part of its url (the latest with it)
  safari console start|read --tab N          console capture
  safari cookies --tab N                     cookies for the page
  safari cookies clear --tab N|--url U       forget the site (cookies, storage);
                                             closes your tabs on it
  safari shot --tab N [--out file.png] [--ref R] [--annotate] [--full]
                                             screenshot what the tab shows
  safari download <ref|url> [--out file] [--tab N]
                                             save a file into ~/Downloads; a url needs
                                             no tab, a tab alone saves the file it shows
  safari dialog [read|accept|dismiss] [text] --tab N
                                             how the tab answers alerts and confirms
  safari fetch <url> --tab N                 request a URL with the page's cookies
  safari map <url>... [--what extract|snapshot|eval|fetch] [--save[=dir]]
                                             read up to 20 pages at once, each in a
                                             background tab that closes after
                                             (--expression js, --as table, --concurrency 4,
                                             --wait '{"text":"Price"}' before each read)
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
  safari run --steps '<json>' | --steps-file <path> | --steps -
                                             several tools in one call; steps from a
                                             file, or stdin for -, need no shell quoting

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
  safari record list | show <name> | rm <name>
                                             tasks recorded with the toolbar button
                                             (teach mode), newest first
  safari replay <name> [--tab N] [--vars '{"field":"text"}'] [--json]
                                             do a recording again in a background tab;
                                             exits 1 when a step fails

  safari guide sites                         sites with a usage guide
  safari guide <site|host>                   one site's guide and learned notes (e.g. slack, x.com)
  safari guide repl                          the REPL's API and recipes
  safari learn <site> "<fact>"               save a fact about a site for later agents
                                             (at most 300 characters; never a secret)
  safari learn <site> [--forget <n>]         list a site's notes; remove note n
  safari learn <site> --real true|false      a model's click and type there go as real input

  safari imessage chats [--limit N]          recent conversations
  safari imessage history <chat> [--limit N] [--since rowid]
                                             one conversation (id, phone, email, or name)
  safari imessage search [text] [--from who] [--days 90]
                                             search messages
  safari imessage files <id>... [--out /absolute/folder] [--clipboard]
                                             ids from history/search files; fetch originals,
                                             save copies or copy verified file URLs
                                             (downloads may mark the conversation read)
  safari imessage code [--seconds 30] [--since rowid]
                                             wait for a sign-in code by text
  safari imessage send <to> [text] [--file path]... [--approved]
                                             draft a text and/or files; sends only with --approved
  safari contacts <name>                     phones and emails for a contact
  safari ask "<question>"                    away from the Mac, send the question to your phone
                                             (answer it back here); at the Mac, send nothing

  Every command takes --host <ssh-host> to use another Mac's Safari, and
  --json to print JSON. Messages, Contacts, history, and fill commands run
  in this terminal (they need its Full Disk Access), not in the daemon.
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

// A flag that takes no value is on when given, unless the word after it is
// false (BOOLEAN_FLAGS).
function hasFlag(name: string, argv: string[]): boolean {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== "false";
}

// Every --file value, resolved against this terminal; undefined when none.
function fileFlags(argv: string[]): string[] | undefined {
  const files = argv.flatMap((a, i) => (a === "--file" && i + 1 < argv.length ? [argv[i + 1]] : a.startsWith("--file=") ? [a.slice(7)] : []));
  return files.length ? files.map((f) => resolve(f)) : undefined;
}

function tabArg(argv: string[]): Record<string, unknown> {
  const t = flag("tab", argv);
  if (t === undefined) return {};
  return { tab: t === "front" ? t : Number(t) };
}

// --save writes a read's whole output to a new file in the saved folder;
// --save=<path> names the file, as does a path after --save: agents wrote
// --save /private/var/tmp/rows.json, and the path went into eval's code. A
// relative path is the terminal's, not the daemon's.
function saveArg(argv: string[]): Record<string, unknown> {
  const i = argv.indexOf("--save");
  if (i >= 0) return isSavePath(i + 1, argv) ? { save: resolve(argv[i + 1]) } : { save: true };
  const path = flag("save", argv);
  return path === undefined ? {} : { save: resolve(path) };
}

// A word after --save names its file when it reads as a path: a URL never
// starts so, and code only as a regular expression.
function isSavePath(i: number, argv: string[]): boolean {
  return argv[i - 1] === "--save" && /^\.{0,2}\//.test(argv[i] ?? "");
}

// The tool a command runs, where its name differs, and a tool's name
// however it is written (real-input for real_input).
const ALIAS: Record<string, string> = { focus: "activate", back: "history", forward: "history", reload: "history", clickat: "click", "history-search": "browsing_history", "browsing-history": "browsing_history", record: "recordings" };

const toolName = (cmd: string): string | undefined => (Object.hasOwn(ALIAS, cmd) ? ALIAS[cmd] : nameIn([...Object.keys(TOOLS), ...Object.keys(CALLER_TOOLS)], cmd));

function toolDef(cmd: string): Tool | undefined {
  const name = toolName(cmd);
  return name === undefined ? undefined : TOOLS[name] ?? CALLER_TOOLS[name];
}

// Flags every command takes, and those a command reads beside its tool's
// parameters (open --bg, snapshot --max).
const COMMON_FLAGS = ["json", "host", "help", "tab", "save", "snapshot"];
const COMMAND_FLAGS: Record<string, string[]> = { tabs: ["site"], open: ["bg"], snapshot: ["max"], shot: ["full"], eval: ["file"], run: ["steps-file"] };
// A parameter a command takes under another flag: tabs's host is --site,
// since --host names another Mac. Its help said --host (10-04, 01a10737).
const FLAG_FOR: Record<string, Record<string, string>> = { tabs: { host: "site" } };

// A tool's parameters given as --name value, however the name is written
// (--max-bytes, or --note for learn's fact, as a model's call may name
// them: guard.ts); a boolean one needs only --name. A flag neither the
// tool nor the command takes fails, naming those they do: learn --note
// once dropped the fact it carried, and the command still went through.
function flagArgs(cmd: string, tool: string, argv: string[]): Record<string, unknown> {
  const tools = Object.hasOwn(TOOLS, tool) ? TOOLS : CALLER_TOOLS;
  const own = COMMAND_FLAGS[cmd] ?? [];
  const args: Record<string, unknown> = {};
  for (const [i, a] of argv.entries()) {
    if (!a.startsWith("--") || isFlagValue(i, argv)) continue;
    const eq = a.indexOf("=");
    const given = a.slice(2, eq < 0 ? undefined : eq);
    if (COMMON_FLAGS.includes(given) || own.includes(given)) continue;
    const found = paramFor(tools, tool, given);
    if (found === undefined) {
      const listed = [...Object.keys(tools[tool].params), ...own];
      const near = nearest(given, listed);
      fail(`${cmd} takes no --${given}${near ? `; did you mean --${near}?` : ""} (flags: ${listed.map((f) => `--${f}`).join(" ")}; safari ${cmd} --help says what each does)`, 2);
    }
    const [name, p] = found;
    if (Object.hasOwn(args, name)) continue;
    if (name !== given) console.error(`note: used --${name} for --${given}`);
    if (p.type === "boolean") {
      args[name] = (eq < 0 ? argv[i + 1] : a.slice(eq + 1)) !== "false";
      continue;
    }
    const v = eq < 0 ? argv[i + 1] : a.slice(eq + 1);
    if (v === undefined) fail(`--${given} needs a value`, 2);
    args[name] = p.type === "number" ? Number(v) : p.type === "object" ? JSON.parse(v) : p.type === "array" ? (v.startsWith("[") ? JSON.parse(v) : [v]) : v;
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
    `  --${FLAG_FOR[cmd]?.[name] ?? name}${p.type === "boolean" ? "" : ` <${p.enum?.join("|") ?? p.type ?? "string"}>`}${def.required?.includes(name) ? " (required)" : ""}\n      ${p.description}`);
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
  else if (!result.error) console.log("(no output; return or console.log what you want back)");
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
  // This process ends with its answer, and a pairing prompt still up would
  // end with it: a call that pairs waits until the pairing is done.
  waitPairingOut();
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
    const { guide, noGuide } = await import("../daemon/guides.ts");
    const text = await guide(which);
    if (text === null) fail(noGuide(which ?? ""));
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

  // replay prints one result whether or not it went through (--json: one
  // line, which watch.ts reads) and exits 0 only when every step did.
  if (cmd === "replay") {
    let r: unknown;
    try {
      const vars = flag("vars", rest);
      r = await invoke("replay", { name: rest.find((a, i) => !a.startsWith("--") && !isFlagValue(i, rest)), ...tabArg(rest), ...(vars === undefined ? {} : { vars: JSON.parse(vars) }) }, true);
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    print(r);
    process.exit(r && typeof r === "object" && "ok" in r && r.ok === true ? 0 : 1);
  }

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
      files: ["imessage_files", { ids: pos, out: flag("out", rest), clipboard: hasFlag("clipboard", rest) }],
      code: ["imessage_wait_code", { seconds: numFlag("seconds"), since: numFlag("since") }],
      send: ["imessage_send", { to: pos[0], text: pos.slice(1).join(" "), files: fileFlags(rest), approved: hasFlag("approved", rest) }],
    };
    const call = sub ? calls[sub] : undefined;
    if (!call) fail("usage: safari imessage chats|history|search|files|code|send …, or safari contacts <name>", 2);
    print(await invoke(...call, true));
    return;
  }

  const positional = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest));
  // A command's words are words, not its call's JSON: on 09-30 an agent
  // wrote `safari dialog --tab front '{"do":"read"}'`, which sent the whole
  // object as do, and open, snapshot, and goto failed on theirs with errors
  // that hid why.
  if (cmd !== "call" && jsonObject(positional[0])) {
    fail(`${cmd} takes words and flags, not a JSON object: safari call ${toolName(cmd) ?? cmd} '${positional[0]}' (flags such as --tab still apply), or its flags (safari ${cmd} --help)`, 2);
  }
  let tool = ALIAS[cmd] ?? cmd;
  let args: Record<string, unknown> = { ...tabArg(rest), ...saveArg(rest), ...(hasFlag("snapshot", rest) ? { snapshot: true } : {}) };

  switch (cmd) {
    case "tabs": args.host = flag(FLAG_FOR.tabs.host, rest) ?? null; break;
    case "open": args.url = positional[0]; args.background = hasFlag("bg", rest); break;
    case "goto": args.url = positional[0]; break;
    case "back": case "forward": case "reload": args.do = cmd; break;
    case "close": case "focus": case "keep": if (positional[0] !== undefined) args.tab = Number(positional[0]); break;
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
    case "eval": {
      // a reader saved for the site (learn) is the code
      const reader = flag("reader", rest);
      if (reader !== undefined) {
        args.reader = reader;
        break;
      }
      // --file, or stdin, carries a script with no quoting to get right
      const file = flag("file", rest);
      args.expression = file !== undefined ? await Bun.file(resolve(file)).text() : positional.join(" ") || (await readStdin());
      if (!String(args.expression).trim()) fail('usage: safari eval "<js>" --tab N [--page] | --file path (or pipe the code in)', 2);
      args.page = hasFlag("page", rest);
      break;
    }
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
    case "net": case "console": {
      if (positional[0]) args.do = positional[0];
      const body = flag("body", rest);
      if (cmd === "net" && body !== undefined) args.body = body;
      break;
    }
    case "cookies": {
      if (positional[0]) args.do = positional[0];
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
      const target = positional[0];
      if (target !== undefined && /^https?:/.test(target)) args.url = target;
      else if (target !== undefined) args.ref = target;
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
    case "record": args.do = positional[0] ?? "list"; if (positional[1] !== undefined) args.name = positional[1]; break;
    case "ask": args.question = positional.join(" "); break;
    case "run": {
      // Steps from a file, or stdin for --steps -, need no shell quoting:
      // an apostrophe in one step's text broke an agent's quoted JSON (09-29).
      // A bare JSON array is the steps too: `run --json '[…]'` failed then.
      const file = flag("steps-file", rest);
      const bare = positional[0]?.trimStart().startsWith("[") ? positional.join(" ") : undefined;
      const steps = file !== undefined ? await Bun.file(resolve(file)).text() : flag("steps", rest) === "-" ? await readStdin() : bare;
      if (steps === undefined) break;
      try {
        args.steps = JSON.parse(steps);
      } catch (e) {
        fail(`the steps are not JSON (${e instanceof Error ? e.message : String(e)}): give an array like [{"tool": "open", "args": {"url": "…"}}]`, 2);
      }
      break;
    }
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
      tool = toolName(cmd) ?? fail(`unknown command: ${cmd}\n\n${USAGE}`, 2);
      // safari passwords status: the word after a tool that takes do is its do.
      if (positional[0] !== undefined && toolDef(tool)?.params.do) args.do = positional[0];
    }
  }

  // Parameters given as flags fill what the positional words left out.
  const name = toolName(tool);
  if (name !== undefined) {
    for (const [k, v] of Object.entries(flagArgs(cmd, name, rest))) {
      if (args[k] === undefined || args[k] === "" || Number.isNaN(args[k])) args[k] = v;
    }
  }

  print(await invoke(tool, args, true));
}

// Flags that take no value; the word after them is positional, unless it is
// true or false: on 10-04 `eval --page true "const ..."` ran "true const
// ..." and failed at its second word.
const BOOLEAN_FLAGS: Record<string, true> = { bg: true, keep: true, append: true, snapshot: true, approved: true, clipboard: true, diff: true, page: true, annotate: true, full: true, json: true, list: true, bitwarden: true, save: true, all: true, quiet: true, changed: true, showHidden: true, base64: true, front: true };

function isFlagValue(i: number, argv: string[]): boolean {
  const prev = argv[i - 1];
  return i > 0 && ((prev.startsWith("--") && !prev.includes("=") && (!Object.hasOwn(BOOLEAN_FLAGS, prev.slice(2)) || argv[i] === "true" || argv[i] === "false")) || isSavePath(i, argv));
}

function jsonObject(word: string | undefined): boolean {
  if (!word?.trimStart().startsWith("{")) return false;
  try {
    const v: unknown = JSON.parse(word);
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

main().then(
  // A tunnel to another Mac keeps the event loop alive; the command is done.
  () => process.exit(0),
  (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
);
