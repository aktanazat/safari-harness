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
import { basename, resolve } from "node:path";
import { TOOLS, formatResult, resolveTab, type TabInfo, type Tool } from "../daemon/tools.ts";
import { CALLER_TOOLS } from "../daemon/caller.ts";
import { invoke } from "../daemon/call.ts";
import { daemonHttp } from "../daemon/rpc.ts";
import { connectHost, hostHealth, listHosts, readHostConfig, setDefaultHost } from "../daemon/host.ts";
import { guide } from "../daemon/guides.ts";
import { ReplSession } from "../daemon/repl.ts";
import { closeSession, listSessions, runInSession } from "../daemon/repl-host.ts";
import { deleteSession, isRunning, listSessionRecords, loadSession, newSession, runSession, sendControl, statusOf, transcript, type SessionRecord } from "../daemon/sessions.ts";
import type { AgentEvent } from "../daemon/agent.ts";
import { daemonInstall, daemonUninstall, parseSchedule, routineAdd, routineList, routineRemove, routineRun } from "./launchd.ts";

const USAGE = `safari — drive Safari from the terminal

  safari guide                               the short card of rules for browsing
  safari guide reference                     every tool in full
  safari serve [--ws 37333] [--http 37334]   start the daemon in the foreground
  safari daemon install|uninstall            keep the daemon always on (launchd)
  safari status                              daemon + extension health
  safari tabs                                list tabs
  safari open <url> [--bg] [--keep]          open a tab; prints its id
  safari goto <url> --tab N                  navigate
  safari back|forward|reload --tab N         history
  safari close <tab>                         close a tab
  safari focus <tab>                         activate a tab
  safari snapshot --tab N [--query text] [--root sel] [--diff]
                                             page outline with [ref]s
  safari click <ref> --tab N                 click by snapshot ref
  safari clickat <x> <y> --tab N             click by coordinates
  safari type <ref> <text> --tab N           type by ref
  safari press <key> [--ref R] --tab N       press a key
  safari select <ref> <option> --tab N       choose a dropdown option
  safari hover <ref> --tab N                 hover an element
  safari upload <file>... [--ref R] --tab N
                                             attach files to a file input
  safari scroll <dy> --tab N                 scroll

  Page commands need --tab N, the id open printed, or --tab front for the
  tab the user has in front. Background tabs a command opens (--bg) close
  once the program that ran safari exits; --keep leaves them open.

  Actions (open goto back forward reload click clickat type press select
  hover upload) take --snapshot to print the resulting page too.

  safari eval <js-expression> --tab N [--page]
                                             evaluate JS, print JSON
  safari extract --tab N [--selector s]      readable text
  safari info --tab N                        url/title/scroll
  safari wait <ms> --tab N                   sleep in the page
  safari wait [--selector s] [--text t] [--ms timeout] --tab N [--front]
                                             wait until it is on the page; --front
                                             holds the tab on screen meanwhile
  safari net start|stop|read --tab N         fetch/XHR capture
  safari console start|read --tab N          console capture
  safari cookies --tab N                     cookies for the page
  safari shot --tab N [--out file.png] [--ref R] [--annotate] [--full]
                                             screenshot what the tab shows
  safari download <ref|url> [--out file] --tab N
                                             save a file into ~/Downloads
  safari dialog [read|accept|dismiss] [text] --tab N
                                             how the tab answers alerts and confirms
  safari fetch <url> --tab N                 request a URL with the page's cookies
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
                                             (safari passwords --do logins --tab N)

  safari repl [--session name] [code]        Playwright-style JavaScript with site globals
                                             (code from stdin when omitted); see: safari guide repl
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

  safari guide sites                         sites with a usage guide
  safari guide <site|host>                   one site's guide (e.g. slack, x.com)
  safari guide repl                          the REPL's API and recipes

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

function hasFlag(name: string, argv: string[]): boolean {
  return argv.includes(`--${name}`);
}

function tabArg(argv: string[]): Record<string, unknown> {
  const t = flag("tab", argv);
  if (t === undefined) return {};
  return { tab: t === "front" ? t : Number(t) };
}

// The tool a command runs, where its name differs.
const ALIAS: Record<string, string> = { focus: "activate", back: "history", forward: "history", reload: "history", clickat: "click", "history-search": "browsing_history" };

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
  const done = await runSession(rec, { apiKey: process.env.SAFARI_MODEL_KEY, maxSteps: Number(flag("steps", argv) ?? 30), onEvent: showEvent });
  if (done.status !== "done") console.error(`session ${done.id} ${done.status}; go on with: safari session resume ${done.id} "<prompt>"`);
  console.log(done.answer ?? "");
}

async function sessionCommand(argv: string[]) {
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
  const code = argv.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, argv)).join(" ") || (await readStdin());
  if (!code.trim()) fail('usage: safari repl [--session name] "<code>" (or pipe the code in)', 2);
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
    const text = await guide(which);
    if (text === null) fail(`no guide for ${which}; see: safari guide sites`);
    console.log(text);
    return;
  }

  if (cmd === "daemon") {
    const sub = rest[0];
    if (sub === "install") console.log(await daemonInstall());
    else if (sub === "uninstall") console.log(await daemonUninstall());
    else { console.error("usage: safari daemon install|uninstall"); process.exit(2); }
    return;
  }

  if (cmd === "routine") {
    const [sub, ...r] = rest;
    const pos = r.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, r));
    if (sub === "add") {
      const schedule = parseSchedule(flag("at", r), flag("every", r));
      console.log(await routineAdd(pos[0], pos.slice(1).join(" "), schedule, flag("model", r)));
    } else if (sub === "list") {
      print(await routineList());
    } else if (sub === "run") {
      const { code, log } = await routineRun(pos[0]);
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

  // Everything below talks to a daemon: this Mac's, or --host's.
  const host = await connectHost(flag("host", rest));

  if (cmd === "status") {
    try {
      print(await (await fetch(`${daemonHttp()}/health`)).json());
    } catch {
      fail(`daemon not reachable at ${daemonHttp()} — run: safari daemon install`);
    }
    return;
  }

  if (cmd === "do") {
    const task = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest)).join(" ");
    if (!task) fail("usage: safari do \"<task>\" [--tab N] [--steps N] [--model m]", 2);
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
    print(await invoke(...call));
    return;
  }

  const positional = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest));
  let tool = ALIAS[cmd] ?? cmd;
  let args: Record<string, unknown> = { ...tabArg(rest), ...(hasFlag("snapshot", rest) ? { snapshot: true } : {}) };

  switch (cmd) {
    case "tabs": break;
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
      args.paths = positional.map((p) => resolve(p));
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
    case "pdf": {
      args.do = positional[0] ?? "save";
      if (positional[1]) args.path = resolve(positional[1]);
      const out = flag("out", rest);
      if (out) args.out = resolve(out);
      break;
    }
    case "window": args.width = Number(positional[0]); args.height = Number(positional[1]); break;
    case "history-search": args = { text: positional.join(" ") || undefined }; break;
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
    default:
      if (!toolDef(cmd)) fail(`unknown command: ${cmd}\n\n${USAGE}`, 2);
  }

  // Parameters given as flags fill what the positional words left out.
  const def = toolDef(tool);
  if (def) {
    for (const [k, v] of Object.entries(flagArgs(def, rest))) {
      if (args[k] === undefined || args[k] === "" || Number.isNaN(args[k])) args[k] = v;
    }
  }

  // Tabs a command opens in the background close once the program that ran
  // safari exits (the daemon watches it); --keep leaves them open. Another
  // Mac's daemon cannot see this Mac's processes.
  if (host === "local" && !hasFlag("keep", rest)) {
    const opens = tool === "open" ? [args] : tool === "run" && Array.isArray(args.steps)
      ? args.steps.flatMap((s: unknown) => s && typeof s === "object" && "tool" in s && s.tool === "open" && "args" in s && s.args && typeof s.args === "object" ? [s.args as Record<string, unknown>] : [])
      : [];
    const owner = opens.length ? ownerPid() : undefined;
    if (owner !== undefined) for (const o of opens) o.owner = owner;
  }

  print(await invoke(tool, args));
}

// The program that ran this command: the first ancestor that is not a
// shell. A shell that ran one command ends with it; omp, claude, codex, a
// script, or a terminal's login session lasts as long as the work does.
const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true, fish: true, ksh: true, tcsh: true, csh: true };

function ownerPid(): number | undefined {
  for (let pid = process.ppid; pid > 1;) {
    const row = /^\s*(\d+)\s+(.+?)\s*$/.exec(Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)]).stdout.toString());
    if (!row) return undefined;
    if (!SHELLS[basename(row[2]).replace(/^-/, "")]) return pid;
    pid = Number(row[1]);
  }
  return undefined;
}

// Flags that take no value; the word after them is positional.
const BOOLEAN_FLAGS = new Set(["bg", "keep", "append", "snapshot", "approved", "diff", "page", "annotate", "full", "json", "list", "bitwarden"]);

function isFlagValue(i: number, argv: string[]): boolean {
  const prev = argv[i - 1];
  return i > 0 && prev.startsWith("--") && !prev.includes("=") && !BOOLEAN_FLAGS.has(prev.slice(2));
}

main().then(
  // A tunnel to another Mac keeps the event loop alive; the command is done.
  () => process.exit(0),
  (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
);
