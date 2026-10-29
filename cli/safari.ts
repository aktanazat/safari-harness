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
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOOLS, formatResult, resolveTab, type Tool } from "../daemon/tools.ts";
import { rowsOf } from "../daemon/tabs-view.ts";
import { CALLER_TOOLS } from "../daemon/caller.ts";
import { invoke } from "../daemon/call.ts";
import { closestParam, missFor, nameIn, nearest, paramFor } from "../daemon/guard.ts";
import { waitCardsOut } from "../daemon/cards.ts";
import { daemonHttp, deployingFor } from "../daemon/rpc.ts";
import { alertHealth } from "../daemon/phone.ts";
import { ownerOf } from "../daemon/owner.ts";
import { connectHost, hostHealth, listHosts, readHostConfig, setDefaultHost } from "../daemon/host.ts";
import type { AgentEvent } from "../daemon/agent.ts";
import type { SessionRecord } from "../daemon/sessions.ts";
import type { JournalEvent } from "../daemon/journal.ts";
import type { Overview } from "../daemon/mission.ts";
import { failureOf } from "../daemon/failures.ts";

// Commands beyond the tools (guide, repl, session, do, daemon, routine, doctor)
// import their own modules when they run: imported here, those modules
// would add 5 ms to the start of every command.

const USAGE = `safari — drive Safari from the terminal

  safari guide                               the short card of rules for browsing
  safari guide reference                     every tool in full
  safari help <command>                      one command's usage and flags
  safari serve [--ws 37333] [--http 37334]   start the daemon in the foreground
  safari daemon install|uninstall            keep the daemon always on (launchd)
  safari status                              daemon + extension health
  safari extension reload                    reload the extension by hand (calls reload
                                             a stuck one themselves); asks no password
  safari agents                              agents using Safari now, and the page
                                             that pauses or stops them
  safari doctor                              check every part the harness needs on this
                                             Mac, with the fix for each that fails
  safari memory status                       inspect collection and saved pages
  safari memory search <words>               find remembered page text and summaries
  safari memory show --id ID                 inspect a saved page
  safari memory configure --config '<json>'  set research saving, browsing sites, or retention
  safari memory edit --id ID --note <text>    correct a summary or add a note
  safari memory forget --id ID --approved    delete a page and its summary
  safari save_source --receipt ID --reason <text>
                                             remember a useful public source already read
  safari tabs [--site host] [--all]          your tabs, his front one, a count of his;
                                             --site lists his on one site, --all every tab
  safari open <url> [--bg] [--keep] [--new] [--id]
                                             open a tab, or load in yours on that site
                                             (--new: a second one); prints its id
                                             (--id: the id alone, for T=$(safari open ...))
  safari goto <url> --tab N                  navigate
  safari back|forward|reload --tab N         history
  safari close <tab>                         close a tab
  safari keep <tab>                          leave a tab open for the user when your
                                             turn ends
  safari focus <tab>                         activate a tab
  safari snapshot --tab N [--query text] [--root sel] [--diff | --updates [--since revision]]
                                             page outline with [ref]s; recoverable updates
  safari click <ref> --tab N                 click by snapshot ref
  safari clickat <x> <y> --tab N             click by coordinates
  safari type <ref> <text> --tab N           type by ref; '{{code}}' in text types the
                                             code texted to him (--secret passwords: his saved one;
                                             --secret env --env VAR: this call's variable VAR)
  safari press <key> [--ref R] --tab N       press a key
  safari select <ref> [option] --tab N       choose a dropdown option; none lists them
  safari hover <ref> --tab N                 hover an element
  safari upload <file>... [--ref R] --tab N
                                             attach files to a file input
  safari upload --find <words> --tab N       list the user's files that match, to pick
                                             one (iCloud Drive, Documents, Desktop,
                                             Downloads); attaches nothing
  safari scroll <dy> --tab N [--to top|bottom]
                                             scroll by dy, or all the way to the page's top or bottom

  Page commands need --tab N, the id open printed, or --tab front for the
  tab the user has in front. Tabs a command opens close when omp's turn
  ends, once the program that ran safari exits, or after 20 minutes
  unused; --keep on open, or safari keep <tab>, leaves one open for him.

  Actions (open goto back forward reload click clickat type press select
  hover upload) and wait take --snapshot to print the page after them too,
  or --snapshot=<words> for only its lines that have those words.

  Reads (snapshot eval extract fetch read) take --save to write the whole output
  to a new file in ~/.local/share/safari-harness/saved, or --save=<file>
  (or --save <file>, for a path starting with / ./ or ../), and print only
  its path, size, and first 500 characters.

  safari eval <js> --tab N [--page] [--raw]  run JS, print the last value as JSON
                                             (--raw: the value alone, a string unquoted;
                                             code from --expression js, --file path, or
                                             stdin when omitted; --timeout secs lets it
                                             run up to 300 s, 30 when omitted;
                                             --reader name runs a script saved with learn)
  safari extract --tab N [--selector s]      readable text
  safari extract --as table --tab N          tables and card lists as JSON rows
  safari extract --as chat --tab N           a chat's messages, each with who wrote it
  safari data --tab N [--pick path] [--max bytes]
                                             the page's own data as JSON (JSON-LD, Next.js, ...)
  safari info --tab N                        url/title/scroll
  safari wait <ms> --tab N                   until the page goes quiet, ms at most
  safari wait [--selector s] [--text t] [--ms timeout | --timeout secs] --tab N [--front]
                                             wait until it is on the page; --front
                                             holds the tab on screen meanwhile
  safari wait --any '["a","b"]' | --gone t | --url part|/re/ | --quiet --tab N
                                             the first text shown (named in the
                                             answer), text gone, an address, or
                                             0.5 s without a change
  safari wait --changed [--ms 25000] --tab N new lines since the last look (added):
                                             a chat's reply; call again until found
  safari net read|start|stop --tab N         fetch/XHR since the page loaded
  safari net read --body I|URL-PART --tab N  one request's whole body: its index, or
                                             part of its url (the latest with it)
  safari console start|read --tab N          console capture
  safari cookies --tab N                     cookies for the page
  safari cookies clear --tab N|--url U       forget the site (cookies, storage);
                                             closes your tabs on it
  safari shot --tab N [--out file.png | file.png] [--ref R] [--annotate] [--full] [--live] [--tiles] [--ifChanged]
                                             protected screenshot and source receipt;
                                             unchanged pixels can return the prior receipt
  safari shots <url>... --widths 390,1440 --out folder [--full] [--tiles]
                                             capture each page and width with its receipt

  safari report --out folder --answer text --findings '[{"claim":"…","evidence":"/absolute/receipt.json"}]'
                                             write an evidence-backed report with local images
  safari download <ref|url> [--out file] [--tab N]
                                             save a file into ~/Downloads; a url needs
                                             no tab, a tab alone saves the file it shows
  safari download <url> <url>... [--out dir] save each as 01-name, 02-name... in dir
  safari dialog [read|accept|dismiss] [text] --tab N
                                             how the tab answers alerts and confirms
  safari fetch <url> --tab N                 request a URL with the page's cookies
  safari read <url> [--tab N] [--expect text]
                                             readable text without navigating to the URL;
                                             --expect checks content, not account identity;
                                             --format raw keeps HTML or JSON unchanged
  safari request_catalog list                list privately saved JSON reads
  safari request_catalog save --tab N --name NAME --request I --observed-at T --field F --type array
                                             check and save an observed GET
  safari request_catalog run --tab N --name NAME
                                             rerun its unchanged result check
  safari request_catalog forget --name NAME  delete its private record
  safari map <url>... [--what extract|snapshot|eval|fetch] [--save[=dir]]
                                             read up to 20 pages at once, each in a
                                             background tab that closes after
                                             (--expression js, --as table, --concurrency 4,
                                             --wait '{"text":"Price"}' before each read,
                                             --follow '{"match":"a.item"}' to read the
                                             pages a listing links to, --fresh to read
                                             pages this task read in the last 10 min again)
  safari pdf [save|read] [file.pdf|url] [--out file.pdf] [--tab N]
                                             print the page to PDF, or read a PDF
                                             (a file.pdf or url needs no tab)
  safari window <width> <height> --tab N     resize the tab's window to that size
  safari window --size 390x844 --tab N       the same, as WIDTHxHEIGHT
  safari history-search [text] [--any a b c] search Safari browsing history; --any: any of several texts
  safari fill address [--label home] --tab N
                                             your address, name, email, phone from your Contacts card
  safari fill login [--bitwarden] [--user name] --tab N
                                             a saved login (Apple Passwords, or Bitwarden); you never see it
  safari call <tool> '<json args>'           any tool by name, as MCP calls it
  safari <tool> [--<param> value ...]        the same, with each parameter as a flag
                                             (safari passwords logins --tab N: a first word is do)
  safari real_input --do drag --ref R --target R --tab N
                                             guarded native drag; no implicit scroll
  safari real_input --do paste --text text [--html html] [--tsv text] --tab N
                                             formatted paste; restores an unchanged clipboard
  safari guide audit|react|site_actions|video
                                             on-demand accessibility, app and video inspection
  safari run --steps '<json>' | --steps-file <path> | --steps -
                                             several tools in one call; steps from a
                                             file, or stdin for -, need no shell quoting

  safari repl [--session name] [code]        Playwright-style JavaScript with site globals
                                             (code from stdin when omitted, or --file path); without
                                             --session, in this agent's own session; see: safari guide repl
  safari repl --list | --close <name>        sessions still running; end one

  safari do "<task>" [--tab N] [--steps 30] [--model m]
                                             run the agent loop (local model); prints its session
  safari mint "<task>" --url <url> --example '{"query":"sample"}'
                      [--from <name>] [--steps 30] [--model m]
                                             learn one live read-only example; return its
                                             saved verified name and checked result
  safari mint start "<task>" --url <url> --example '<json>'
                                             start the same work in a durable session
  safari mint get|cancel <id>                read or stop that authoring session
  safari session list | show <id>            agent sessions, newest first; one's transcript
  safari session resume <id> ["<prompt>"]    go on with a session
  safari session steer <id> "<text>"         tell a running session now (cuts in)
  safari session queue <id> "<text>"         give a running session its next task
  safari session stop|delete <id>

  safari host [list] | use <ssh-host|local> | status [host]
                                             drive another Mac's Safari through ssh
  safari mcp                                 run the MCP stdio server (thin client)
  safari routine add <name> --at HH:MM|--every MIN [--on YYYY-MM-DD] [--model m | --session id] "<task>"
  safari routine list | run <name> [--dry] | pause|resume|remove <name>
                                             new tasks run through omp; --session continues
                                             saved Safari work; --on runs once on that day
  safari routine add <name> --at HH:MM|--every MIN --watch <url>
                      --selector CSS | --text REGEX | --eval JS | --replay <recording>
                                             a watch: no model; texts your phone when the
                                             value it reads off the page changes
  safari routine add <name> --at HH:MM [--on YYYY-MM-DD] --script <file.js>
                                             a script: no model; runs a repl script and
                                             texts your phone what it printed; run --dry
                                             gives it DRY = true and texts no one
  safari record list | show <name> | rm <name>
                                             tasks recorded with the toolbar button
                                             (teach mode), newest first
  safari replay <name> [--tab N] [--vars '{"field":"text"}'] [--json]
                                             do a recording again in a background tab;
                                             exits 1 when a step fails
  safari playbooks preview --tab N --output '{"rows":"tr.item","fields":{"title":".title"}}'
                                             check rows on the current page without replaying actions
  safari playbooks learn --tab N --goal "Search the catalog"
                      --params '["q"]' --before '{"selector":"#search"}'
                      [--output '{"rows":"tr.item","fields":{"title":".title"}}']
                                             opt in; capture starting rows for searches
  safari playbooks save --tab N --selector '#results[data-ready="yes"]'
                      [--output '{"rows":"tr.item","fields":{"title":".title"}}']
                      [--applied '{"param":"q","in":"hash","prefix":"search/"}']
                      [--result-selector '#results']
                                             verify new results; optionally return rows
  safari playbooks list | cancel --tab N
  safari playbooks run --url https://example.com/ --goal "Search the catalog"
                      --vars '{"q":"shoes"}'
                                             Jev chooses or abstains; replay checks
                                             live targets and stops at owner gates

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
  safari imessage search [text] [--from who] [--chat who] [--days 90]
                                             search messages, or one conversation's
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

  Every command takes --host <ssh-host> to use another Mac's Safari,
  --json to print JSON, and -q (or --quiet) to print nothing when it works
  and one line on stderr when it misses or fails. A miss (ok, found, or
  kept false) exits 1, as a failure does, with or without -q; on wait,
  --quiet also waits for the page to go quiet. Messages, Contacts, history,
  and fill commands run in this terminal (they need its Full Disk Access),
  not in the daemon. A command's parameters also work as flags (click
  --ref 3 is click 3), and safari help <command> lists them.
`;

const json = process.argv.includes("--json");

// -q, or --quiet, on any command: nothing printed when it works, and one
// line on stderr when it misses or fails. From 10-01 to 10-04 a 99point
// agent sent 450 of its 933 safari commands to /dev/null, and the misses
// went with them: a type whose text never landed, a wait that found
// nothing (S99PartA). say writes that line, and show what a flag asks to
// print alone (eval --raw, open --id), quiet or not.
const quiet = process.argv.includes("-q") || hasFlag("quiet", process.argv);
const say = console.error.bind(console);
const show = console.log.bind(console);
if (quiet) console.log = console.error = () => {};

function print(value: unknown) {
  console.log(json ? JSON.stringify(value) : formatResult(value));
}

function fail(message: string, code = 1): never {
  say(`error: ${quiet ? message.replace(/\s*\n\s*/g, " ") : message}`);
  process.exit(code);
}

// An answer that missed, in one line: a run step that failed, a shots
// page that did, or ok, found, or kept false.
function missOf(r: unknown): string | undefined {
  if (!r || typeof r !== "object" || Array.isArray(r)) return undefined;
  const a = r as { ok?: unknown; found?: unknown; kept?: unknown; steps?: unknown; notRun?: unknown; files?: unknown };
  const step = Array.isArray(a.steps) ? a.steps.find((s) => typeof s?.error === "string") : undefined;
  if (step) return `[${step.step} ${step.tool}] ${step.error}${typeof a.notRun === "number" && a.notRun > 0 ? `; the ${a.notRun} other step${a.notRun === 1 ? "" : "s"} did not run` : ""}`;
  const shots = Array.isArray(a.files) ? a.files.filter((f) => typeof f?.error === "string") : [];
  if (shots.length) return shots.map((f) => `${f.url} at ${f.width}: ${f.error}`).join("; ");
  return a.ok === false || a.found === false || a.kept === false ? JSON.stringify(r) : undefined;
}

// A miss exits 1, with or without -q, so a && chain stops at it: a wait
// that found nothing exited 0 (S99PartA). Its line goes to stderr when
// stdout holds nothing of it: quiet, or a value printed alone.
function exitOnMiss(result: unknown, alone = false): void {
  const miss = missOf(result);
  if (miss === undefined) return;
  if (quiet || alone) say(`miss: ${miss}`);
  process.exit(1);
}

function answer(result: unknown): void {
  print(result);
  exitOnMiss(result);
}

// eval --raw: the value alone, for n=$(safari eval --raw ...): a string as
// it is, anything else as JSON on one line, nothing for undefined. Agents
// cut it out with grep -o '"result".*' 47 times (S99PartA). The answer's
// other words (note, hint) go to stderr.
function printRaw(result: unknown): void {
  const { result: value, ...more } = result as { result?: unknown };
  for (const [k, v] of Object.entries(more)) if (k !== "ok") console.error(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (value !== undefined) show(typeof value === "string" ? value : JSON.stringify(value));
  exitOnMiss(result);
}

// open --id: the tab's id alone, for T=$(safari open <url> --id). Agents
// scraped it with grep -oE '[0-9]+' | head -1 48 times (S99PartA), which
// takes the first number an error names too.
function printId(result: unknown): void {
  const { id } = result as { id?: unknown };
  if (id !== undefined) show(String(id));
  exitOnMiss(result, true);
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

// What a command's help says of --save: a word after it is its file only
// when it starts as a path does (isSavePath), so --save rows.json saves
// into the saved folder and reads rows.json as the command's word.
const SAVE_HOW = " (--save alone saves into the saved folder; give a path as --save=<path> or --save ./<path>, a relative one taken from the current folder)";

// --snapshot prints the page after an action whole, and --snapshot=<words>
// only its lines that have them. A word after a bare --snapshot is the
// command's own, unless it is true or false (BOOLEAN_FLAGS).
function snapshotArg(argv: string[]): Record<string, unknown> {
  if (hasFlag("snapshot", argv)) return { snapshot: true };
  const words = flag("snapshot", argv);
  return words === undefined || words === "false" ? {} : { snapshot: words === "true" ? true : words };
}

const SNAPSHOT_HOW = "also print the page after it; --snapshot=<words> prints only its lines that have them";

// The tool a command runs, where its name differs, and a tool's name
// however it is written (real-input for real_input).
const ALIAS: Record<string, string> = { focus: "activate", back: "history", forward: "history", reload: "history", clickat: "click", "history-search": "browsing_history", "browsing-history": "browsing_history", record: "recordings", read: "authenticated_read" };

const toolName = (cmd: string): string | undefined => (Object.hasOwn(ALIAS, cmd) ? ALIAS[cmd] : nameIn([...Object.keys(TOOLS), ...Object.keys(CALLER_TOOLS)], cmd));

function toolDef(cmd: string): Tool | undefined {
  const name = toolName(cmd);
  return name === undefined ? undefined : TOOLS[name] ?? CALLER_TOOLS[name];
}

// Flags every command takes, and those a command reads beside its tool's
// parameters (open --bg, snapshot --max).
const COMMON_FLAGS = ["json", "host", "help", "tab", "save", "snapshot", "quiet"];
const COMMAND_FLAGS: Record<string, string[]> = { tabs: ["site"], open: ["bg", "id"], snapshot: ["max"], shot: ["full"], shots: ["full"], eval: ["file", "timeout", "raw"], wait: ["timeout"], window: ["size"], run: ["steps-file"] };
// A parameter a command takes under another flag: tabs's host is --site,
// since --host names another Mac. Its help said --host (10-04, 01a10737).
// shot's fullPage is --full, as its usage says: its help listed --fullPage
// under [--full] (S99PartC).
const FLAG_FOR: Record<string, Record<string, string>> = { tabs: { host: "site" }, shot: { fullPage: "full" }, shots: { fullPage: "full" } };
// Parameters that name a file or folder, which the CLI resolves against the
// folder it runs in, given as words or as flags: the daemon runs in a
// folder of its own, so it refuses a relative out and found no relative
// upload (S99PartB). Their help said absolute, as the tools' do (smoke run
// after the 10-16 deploy).
const PATH_PARAMS: Record<string, string[]> = { shot: ["out"], shots: ["out"], report: ["out"], download: ["out"], pdf: ["out", "path"], upload: ["paths"] };

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
      const miss = missFor(tool, given);
      if (miss) fail(miss, 2);
      const listed = [...Object.keys(tools[tool].params), ...own];
      const near = closestParam(given, listed);
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
  // A parameter the usage gives as a word is a flag too: window's help
  // listed --width as required under <width>, and agents read --help 6
  // times for window and shot alone (S99PartA).
  const paths = PATH_PARAMS[toolName(cmd) ?? ""] ?? [];
  const params = Object.entries(def.params).map(([name, p]) => {
    const how = [...(def.required?.includes(name) ? ["required"] : []), ...(usage.some((l) => l.includes(`<${name}>`)) ? [`or as <${name}> above`] : [])].join(", ");
    let desc = p.description;
    if (name === "save" || paths.includes(name)) desc = `${(desc ?? "path").replace(/\ban absolute\b/, "a").replace(/\babsolute /, "")}${name === "save" ? SAVE_HOW : " (a relative path is taken from the current folder)"}`;
    if (name === "snapshot") desc = SNAPSHOT_HOW;
    const value = name === "snapshot" ? "[=<words>]" : p.type === "boolean" ? "" : ` <${p.enum?.join("|") ?? p.type ?? "string"}>`;
    return `  --${FLAG_FOR[cmd]?.[name] ?? name}${value}${how ? ` (${how})` : ""}${desc ? `\n      ${desc}` : ""}`;
  });
  return [...usage, ...(usage.length ? [""] : []), def.desc, "", ...params].join("\n");
}

// A command that is none names the nearest one: `safari windows` printed
// all of USAGE (S99PartC).
function unknownCommand(cmd: string): never {
  const commands = [...USAGE.matchAll(/^ {2}safari ([\w|-]+)/gm)].flatMap((m) => m[1].split("|"));
  const tools = [...Object.entries(TOOLS), ...Object.entries(CALLER_TOOLS)].filter(([, t]) => !t.hidden).map(([n]) => n);
  const near = nearest(cmd, [...commands, ...tools, ...Object.keys(ALIAS)]);
  return fail(`unknown command: ${cmd}${near ? `; did you mean ${near}?` : ""} (safari --help lists every command)`, 2);
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
  const steps = Number(flag("steps", argv) ?? 30);
  if (rec.mint && (!Number.isInteger(steps) || steps < 1)) fail("steps must be a positive whole number", 2);
  const done = await runSession(rec, {
    apiKey: process.env.SAFARI_MODEL_KEY, maxSteps: steps,
    onEvent: rec.mint ? () => {} : showEvent,
  });
  if (rec.mint) {
    if (done.status === "done" && done.mint?.result) return answer({ ...done.mint.result, session: done.id });
    return answer({ ok: false, session: done.id, status: done.status, error: done.mint?.failure ?? done.answer ?? "no verified tool was saved" });
  }
  if (done.status !== "done") console.error(`session ${done.id} ${done.status}; go on with: safari session resume ${done.id} "<prompt>"`);
  console.log(done.answer ?? "");
  if (done.status !== "done") process.exit(1);
}

async function mintCommand(argv: string[], host: string) {
  const flags = ["url", "example", "from", "steps", "model", "host", "json", "quiet"];
  for (const [i, arg] of argv.entries()) {
    if (arg.startsWith("--") && !isFlagValue(i, argv) && !flags.includes(arg.slice(2).split("=")[0])) fail(`mint takes no ${arg.split("=")[0]}; see: safari mint --help`, 2);
  }
  if (host !== "local") fail("mint needs the owner's Safari on this Mac; use --host local", 2);
  const pos = argv.filter((arg, i) => !arg.startsWith("--") && !isFlagValue(i, argv));
  if (pos[0] === "get" || pos[0] === "cancel") {
    if (pos.length !== 2) fail("usage: safari mint get|cancel <id>", 2);
    const { MINT_TOOLS } = await import("../daemon/mint.ts");
    return answer(await MINT_TOOLS.mint.run({ do: pos[0], id: pos[1] }));
  }
  const background = pos[0] === "start";
  if (background) pos.shift();
  let url = flag("url", argv);
  if (url === undefined) {
    const at = pos.findIndex((word) => /^https?:\/\//.test(word));
    if (at >= 0) [url] = pos.splice(at, 1);
  }
  const task = pos.join(" ").trim();
  const sample = flag("example", argv);
  if (!task || !url || sample === undefined) fail("usage: safari mint <task> --url <url> --example '<json>' [--from <name>]", 2);
  let example: unknown;
  try { example = JSON.parse(sample); }
  catch { fail("example must be a JSON object mapping public parameter names to text", 2); }
  const { MINT_TOOLS, mintProvider, mintRequest } = await import("../daemon/mint.ts");
  const request = mintRequest(url, example, flag("from", argv));
  const steps = Number(flag("steps", argv) ?? 30);
  if (!Number.isInteger(steps) || steps < 1) fail("steps must be a positive whole number", 2);
  if (background) return answer(await MINT_TOOLS.mint.run({ do: "start", task, ...request, steps, model: flag("model", argv) }));
  const { newSession } = await import("../daemon/sessions.ts");
  const rec = await newSession(task, {
    host, ...mintProvider(flag("model", argv)), mint: request,
  });
  console.error(`session ${rec.id}; stop it with: safari session stop ${rec.id}`);
  return runAndReport(rec, argv);
}

async function sessionCommand(argv: string[]) {
  const { deleteSession, isRunning, listSessionRecords, loadSession, sendControl, statusOf, transcript } = await import("../daemon/sessions.ts");
  const [sub, id, ...words] = argv.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, argv));
  const text = words.join(" ");
  switch (sub) {
    case undefined:
    case "list": {
      const recs = await listSessionRecords();
      if (json) return print(recs.map(({ messages, mint, ...r }) => ({
        ...r, ...(mint ? { answer: undefined, kind: "mint", ...(mint.result ? { saved: mint.result.name, revision: mint.result.revision } : {}) } : {}),
        status: statusOf({ ...r, messages }), steps: messages.filter((m) => m.role === "assistant").length,
      })));
      if (!recs.length) return console.log("no sessions yet; start one with: safari do \"<task>\"");
      for (const r of recs) console.log(`${r.id}  ${statusOf(r).padEnd(12)} ${r.updated.slice(0, 16).replace("T", " ")}  ${r.task.replace(/\s+/g, " ").slice(0, 70)}`);
      return;
    }
    case "show":
      return console.log(json ? JSON.stringify(await loadSession(id ?? "")) : transcript(await loadSession(id ?? "")));
    case "resume": {
      const rec = await loadSession(id ?? "");
      if (isRunning(rec)) fail(`session ${rec.id} is running; talk to it with: safari session steer ${rec.id} "<text>"`);
      if (rec.mint && (rec.mint.result || rec.mint.failure || rec.mint.pendingAction)) fail(`this authoring session cannot be replayed or repaired; review its result and start a new safari mint request${rec.mint.result ? ` with --from ${rec.mint.result.name}` : ""}`, 2);
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
    if (!running.length) return console.log("no sessions running");
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
  // Without --session, a call runs in its agent's own session (the agent
  // above this process: owner.ts), so what one call binds the next reads:
  // on 10-07 Akyl's globalThis.dmid was gone in its next call, each call
  // then a session of its own. The session ends when that agent does.
  const agent = session ? undefined : await ownerOf(process.pid);
  const name = session ?? (agent === undefined ? undefined : `agent-${agent}`);
  if (name !== undefined) {
    const r = await runInSession(name, code, { host: flag("host", argv), endsWith: agent });
    if (r.started) console.error(`\x1b[2m(session ${name} started; it ends ${agent === undefined ? "" : "when this agent exits or "}after 30 min unused, or: safari repl --close ${name})\x1b[0m`);
    if (r.hint !== undefined) console.error(`hint: ${r.hint}`);
    result = r;
  } else {
    // No agent above this process (launchd ran it): one call, one session,
    // whose bindings and tabs end with it.
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
  if (what === "address") return answer(await invoke("fill_address", { tab, label: flag("label", argv), root: flag("root", argv) }));
  if (what === "login") {
    const username = flag("user", argv);
    return answer(hasFlag("bitwarden", argv) ? await invoke("bitwarden", { do: "fill", tab, username }) : await invoke("passwords", { do: "fill", tab, username }));
  }
  fail("usage: safari fill address [--label home] | login [--bitwarden] [--user name]", 2);
}

// The daemon's answer at path, as JSON. Only a refused connection means
// nothing listens there, which daemon install fixes: on 10-16 a reload
// whose fetch failed after 28 s said to install the daemon that was
// running (S99PartC, DaemonLogs). Anything else says what came back.
async function daemonJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = daemonHttp();
  const res = await fetch(`${base}${path}`, init).catch((e: unknown) => {
    const deploy = deployingFor();
    return fail(e instanceof Error && "code" in e && e.code === "ConnectionRefused"
      ? deploy !== undefined ? `safari is restarting for a deploy; try again in ${deploy} s` : `daemon not reachable at ${base}: nothing listens there; start it with: safari daemon install`
      : `the daemon at ${base} did not answer ${path}: ${e instanceof Error ? e.message : String(e)}`);
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`the daemon at ${base} answered ${path} with HTTP ${res.status}, not JSON: ${text.slice(0, 200) || "nothing"}`);
  }
  if (!res.ok) fail(`the daemon at ${base} answered ${path} with HTTP ${res.status}: ${text.slice(0, 200)}`);
  return body as T;
}

// The extension's own events, which status lists: tab and window events
// are not.
const EXTENSION_EVENTS: Record<string, true> = { start: true, stop: true, connect: true, disconnect: true, timeout: true, slow: true, stuck: true, unstuck: true, reload: true };

async function main() {
  // This process ends with its answer, and a card's Touch ID prompt with
  // it: a card fill waits until he answers. A pairing runs in a process of
  // its own and answers within 25 s, as through MCP (pair.ts).
  waitCardsOut();
  const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "-q");
  if (!cmd || cmd === "--help") { console.log(USAGE); process.exit(cmd ? 0 : 1); }
  // help <command> prints that command alone, as <command> --help does,
  // where it printed all of USAGE.
  if (cmd === "help" || rest.includes("--help")) {
    const which = cmd === "help" ? rest.find((a) => !a.startsWith("-")) : cmd;
    return console.log(which === undefined ? USAGE : commandHelp(which) ?? unknownCommand(which));
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
    // Every word names the guide: guide reference two lanes read only its
    // first word, and printed the whole reference.
    const which = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest)).join(" ") || undefined;
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
    else fail("usage: safari daemon install|uninstall", 2);
    return;
  }

  if (cmd === "routine") {
    const [sub, ...r] = rest;
    const { parseSchedule, routineAdd, routineAddScript, routineAddWatch, routineList, routinePause, routineResume, routineRemove, routineRun } = await import("./launchd.ts");
    const pos = r.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, r));
    if (sub === "add") {
      const schedule = parseSchedule(flag("at", r), flag("every", r), flag("on", r));
      const url = flag("watch", r);
      const script = flag("script", r);
      const session = flag("session", r);
      if (session !== undefined && (script !== undefined || url !== undefined)) fail("--session continues model work; do not combine it with --script or --watch");
      if (script !== undefined) {
        if (url !== undefined || pos.length > 1) fail("a script routine takes a name, a schedule, and --script: no task, no --watch");
        console.log(await routineAddScript(pos[0], resolve(script), schedule));
      } else if (url === undefined) console.log(await routineAdd(pos[0], pos.slice(1).join(" "), schedule, flag("model", r), session));
      else if (pos.length > 1) fail("a watch runs no model, so it takes no task");
      else console.log(await routineAddWatch(pos[0], url, { selector: flag("selector", r), text: flag("text", r), eval: flag("eval", r), replay: flag("replay", r) }, schedule));
    } else if (sub === "list") {
      print(await routineList());
    } else if (sub === "run") {
      const { code, log, note } = await routineRun(pos[0], { dry: hasFlag("dry", r), scheduled: hasFlag("scheduled", r), generation: flag("generation", r) });
      if (note !== undefined) console.log(note);
      console.log(log ? `exit ${code}; log: ${log}` : `exit ${code}`);
      // Under -q a failed run printed nothing at all (Tools.md, 10-16): its
      // one line on stderr has the exit, the note's first line, and the log.
      if (quiet && code !== 0) say(`error: exit ${code}${note ? `: ${note.split("\n")[0]}` : ""}${log ? `; log: ${log}` : ""}`);
      process.exit(code);
    } else if (sub === "pause") {
      console.log(await routinePause(pos[0]));
    } else if (sub === "resume") {
      console.log(await routineResume(pos[0]));
    } else if (sub === "remove") {
      console.log(await routineRemove(pos[0]));
    } else fail("usage: safari routine add|list|run|pause|resume|remove", 2);
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
  // 1 when a check fails (--json: the checks as data). Under -q it printed
  // nothing at all, the failures with the rest: each failed check is a
  // line on stderr, with its fix.
  if (cmd === "doctor") {
    const { doctor, report } = await import("./doctor.ts");
    const checks = await doctor(undefined, { deep: hasFlag("deep", rest) });
    const failed = checks.filter((c) => c.status === "fail");
    console.log(json ? JSON.stringify({ ok: failed.length === 0, checks }) : report(checks));
    if (quiet) for (const c of failed) say(`fail: ${c.name}: ${c.detail}${c.fix ? `; fix: ${c.fix}` : ""}`);
    process.exit(failed.length > 0 ? 1 : 0);
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
    return answer(r);
  }

  // status: the daemon; its extension, stuck (connected, but its calls
  // time out), connected, or disconnected; whether alerts reach the user's
  // phone; how far the live release is ahead of origin/master, as its
  // deploy found it (scripts/dev-install.sh); and the extension's own
  // events of the last 10 minutes, 5 at most (--json: the whole health
  // answer, with alerts and upstream). It printed every tab and window
  // event, 2.2 KB for a yes or no, and said connected while every call
  // timed out (S99PartC).
  if (cmd === "status") {
    type Health = { pid?: number; code?: string; root?: string; inFlight?: number; stopping?: string; extension: { connected?: boolean; stuck?: boolean; sinceAnswerMs?: number | null; timeouts?: Record<string, number>; connectedAt?: number } | null; journal?: JournalEvent[] };
    type Upstream = { branch: string; ahead: number; master: string; at: string };
    const h = await daemonJson<Health>("/health");
    const alerts = alertHealth();
    let upstream: Upstream | undefined;
    try {
      upstream = h.root ? (JSON.parse(readFileSync(join(h.root, ".upstream"), "utf8")) as Upstream) : undefined;
    } catch {
      upstream = undefined;
    }
    if (json) return print({ ...h, alerts, ...(upstream ? { upstream } : {}) });
    const at = (t: string | number) => new Date(t).toLocaleString("sv").slice(5);
    console.log(`daemon ${h.pid ?? "running"}${h.stopping ? `, stopping: ${h.stopping}` : ""}, ${h.inFlight ?? 0} call(s) in flight${h.root ? `, running ${h.root} (code ${h.code})` : ""}`);
    const e = h.extension;
    const missed = Object.entries(e?.timeouts ?? {}).filter(([, n]) => n > 0).map(([op, n]) => `${op} ${n} in a row`).join(", ");
    const answered = typeof e?.sinceAnswerMs === "number" ? `, last answered ${Math.round(e.sinceAnswerMs / 1000)} s ago` : "";
    console.log(!e || e.connected === false ? "extension disconnected: Safari is closed, or Safari Harness is off in Safari Settings > Extensions"
      : e.stuck ? `extension stuck: connected, but its calls time out (${missed})${answered}; run: safari extension reload`
      : `extension connected${e.connectedAt ? ` since ${at(e.connectedAt)}` : ""}${answered}${missed ? `; timed out: ${missed}` : ""}`);
    console.log(!alerts.on ? `${alerts.why}: handoff, ask, and watch routines cannot reach the user's phone; tell him in your chat`
      : alerts.lastFailed !== undefined && alerts.lastAt !== undefined ? `phone alerts on, but the last one, at ${at(alerts.lastAt)}, failed: ${alerts.lastFailed}`
      : "phone alerts on");
    if (upstream && upstream.ahead > 0) console.log(`live release is ${upstream.ahead} commit(s) ahead of origin/master, from branch ${upstream.branch}, as its deploy at ${at(upstream.at)} found it: merge it`);
    const since = Date.now() - 10 * 60_000;
    const events = (h.journal ?? []).filter((ev) => Object.hasOwn(EXTENSION_EVENTS, ev.kind) && Date.parse(ev.t) >= since).slice(-5);
    for (const { t, kind, ...more } of events) console.log(`${at(t)}  ${kind}${Object.keys(more).length ? `  ${JSON.stringify(more)}` : ""}`);
    return;
  }

  // extension reload: Safari reloads the extension, as the daemon has it do
  // by itself once it is stuck (bridge.ts), and no password is asked for.
  if (cmd === "extension") {
    const [sub] = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest));
    if (sub !== "reload") fail("usage: safari extension reload", 2);
    const r = await daemonJson<{ ok: boolean; value?: { ms: number }; error?: string }>("/extension/reload", { method: "POST" });
    if (!r.ok || !r.value) fail(r.error ?? "the daemon gave no answer");
    if (json) return print(r.value);
    return console.log(`the extension reloaded, and connected again in ${(r.value.ms / 1000).toFixed(1)} s`);
  }

  // agents: every agent that used Safari in the last hour, its last call,
  // and the pages that show it and let the user pause or stop it (--json:
  // the whole answer).
  if (cmd === "agents") {
    const o = await daemonJson<Overview>("/agents.json");
    if (json) return print(o);
    for (const a of o.agents) {
      const tabs = a.tabs === null ? "" : `, ${a.tabs} tab${a.tabs === 1 ? "" : "s"}`;
      const raised = a.raised === 0 ? "" : `, brought Safari to the front ${a.raised} time${a.raised === 1 ? "" : "s"}`;
      console.log(`${a.owner === null ? "no agent" : `agent ${a.owner}${a.process ? ` (${a.process})` : ""}`}: ${a.status}${tabs}${raised}`);
      for (const t of a.tasks) console.log(`  ${t.name}  ${daemonHttp()}/space?id=${t.id}&name=${encodeURIComponent(t.name)}`);
      const c = a.last;
      if (c) console.log(`  last: ${new Date(c.t).toLocaleTimeString("sv")} ${c.tool} ${c.args}  ${c.error ?? c.outcome ?? (c.held ? "held" : "running")}`);
    }
    if (o.agents.length === 0) console.log("no agent has used Safari in the last hour");
    console.log(`watch, pause, or stop them: ${daemonHttp()}/agents`);
    return;
  }

  if (cmd === "mint") return mintCommand(rest, host);

  if (cmd === "do") {
    const task = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest)).join(" ");
    if (!task) fail("usage: safari do \"<task>\" [--tab N] [--steps N] [--model m]", 2);
    const { newSession } = await import("../daemon/sessions.ts");
    const tab = flag("tab", rest);
    const rec = await newSession(task, {
      tab: tab === undefined ? undefined : await resolveTab(tab, async () => rowsOf(await invoke("tabs", {}))),
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
      search: ["imessage_search", { text: pos.join(" ") || undefined, from: flag("from", rest), chat: flag("chat", rest), days: numFlag("days"), limit: numFlag("limit") }],
      files: ["imessage_files", { ids: pos, out: flag("out", rest), clipboard: hasFlag("clipboard", rest) }],
      code: ["imessage_wait_code", { seconds: numFlag("seconds"), since: numFlag("since") }],
      send: ["imessage_send", { to: pos[0], text: pos.slice(1).join(" "), files: fileFlags(rest), approved: hasFlag("approved", rest) }],
    };
    const call = sub ? calls[sub] : undefined;
    if (!call) fail("usage: safari imessage chats|history|search|files|code|send …, or safari contacts <name>", 2);
    answer(await invoke(...call, true));
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
  let args: Record<string, unknown> = { ...tabArg(rest), ...saveArg(rest), ...snapshotArg(rest) };

  switch (cmd) {
    case "memory": {
      args.do = positional[0] ?? "status";
      if (args.do === "search" || args.do === "recall") args.query = positional.slice(1).join(" ") || undefined;
      break;
    }
    case "tabs": args.host = flag(FLAG_FOR.tabs.host, rest) ?? null; break;
    case "open": {
      // open opens a tab of its own: `open <url> --tab 12153` opened tab
      // 13608 and left 12153 on its old page (S99PartC).
      if (args.tab !== undefined) fail(`open takes no --tab: it opens a tab of its own. To load the page in tab ${String(args.tab)}, run: safari goto ${positional[0] ?? "<url>"} --tab ${String(args.tab)}`, 2);
      args.url = positional[0];
      args.background = hasFlag("bg", rest);
      break;
    }
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
    case "select": {
      args.ref = positional[0];
      if (positional.length > 1) args.option = positional.slice(1).join(" ");
      break;
    }
    case "hover": args.ref = positional[0]; break;
    case "upload": {
      if (positional.length) args.paths = positional;
      const ref = flag("ref", rest);
      if (ref) args.ref = ref;
      break;
    }
    case "scroll": args.dy = Number(positional[0] ?? 600); break;
    case "eval": {
      // --timeout is in seconds, as the error that suggests it says
      const secs = flag("timeout", rest);
      if (secs !== undefined) args.timeoutMs = Number(secs) * 1000;
      // --file carries a script with no quoting to get right; the code may
      // also come as --expression, as a --reader saved with learn, or on stdin
      const file = flag("file", rest);
      if (file !== undefined) args.expression = await Bun.file(resolve(file)).text();
      else if (positional.length) args.expression = positional.join(" ");
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
      // --timeout in seconds, as eval's: agents wrote wait --timeout, and
      // it was refused (S99PartC)
      const secs = flag("timeout", rest);
      if (secs !== undefined) args.ms = Number(secs) * 1000;
      const sel = flag("selector", rest);
      if (sel) args.selector = sel;
      const text = flag("text", rest);
      if (text) args.text = text;
      if (hasFlag("front", rest)) args.front = true;
      // --quiet waits for the page to go quiet, and quiets the output too
      if (hasFlag("quiet", rest)) args.quiet = true;
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
      // A path is this terminal's, and one given as a word is the file too:
      // from 10-04 a 99point agent's `--out ui-evidence/...` shots went to
      // the daemon's folder (S99PartB), which now refuses a relative one.
      const given = flag("out", rest);
      if (given !== undefined && positional[0] !== undefined) fail(`shot takes one path, not both --out ${given} and ${positional[0]}`, 2);
      const out = given ?? positional[0];
      if (out !== undefined) args.out = out;
      const ref = flag("ref", rest);
      if (ref) args.ref = ref;
      args.annotate = hasFlag("annotate", rest);
      args.fullPage = hasFlag("full", rest);
      break;
    }
    case "shots": {
      args.urls = positional;
      const widths = flag("widths", rest);
      if (widths !== undefined) args.widths = widths.split(",").map(Number);
      args.fullPage = hasFlag("full", rest);
      break;
    }
    case "download": {
      const target = positional[0];
      if (positional.length > 1) args.urls = positional;
      else if (target !== undefined && /^https?:/.test(target)) args.url = target;
      else if (target !== undefined) args.ref = target;
      break;
    }
    case "dialog":
      if (positional[0]) args.do = positional[0];
      if (positional[1] !== undefined) args.text = positional.slice(1).join(" ");
      break;
    case "fetch": case "read": args.url = positional[0]; break;
    case "map": args.urls = positional; break;
    case "pdf": {
      // On 10-29 `pdf --do read --url` failed "tab is required": do was
      // save before the flags were read.
      if (positional[0] !== undefined) args.do = positional[0];
      if (positional[1] !== undefined) args[/^https?:/.test(positional[1]) ? "url" : "path"] = positional[1];
      break;
    }
    case "window": {
      // --size WIDTHxHEIGHT too, as agents wrote it (S99PartC)
      const size = flag("size", rest);
      const wh = size === undefined ? positional : /^(\d+)x(\d+)$/i.exec(size)?.slice(1);
      if (wh === undefined) fail(`--size takes WIDTHxHEIGHT in points, as 390x844, not ${size}`, 2);
      args.width = Number(wh[0]);
      args.height = Number(wh[1]);
      break;
    }
    case "history-search": case "browsing-history": {
      // --any a b c: each word a text of its own, as in browsing_history's any
      const any = flag("any", rest);
      args = any === undefined || any.startsWith("[") ? { text: positional.join(" ") || undefined } : { any: [any, ...positional] };
      break;
    }
    case "learn": args.site = positional[0]; if (positional.length > 1) args.fact = positional.slice(1).join(" "); break;
    case "record": args.do = positional[0] ?? "list"; if (positional[1] !== undefined) args.name = positional[1]; break;
    case "ask": args.question = positional.join(" "); break;
    case "run": {
      // Steps from a file, or stdin for --steps -, need no shell quoting:
      // an apostrophe in one step's text broke an agent's quoted JSON (09-29).
      // A bare JSON array is the steps too: `run --json '[…]'` failed then.
      // A file may hold the MCP call's object, {"steps": […], "tab": N}, as
      // the guide shows it: two agents' files so were refused (10-22).
      const file = flag("steps-file", rest);
      const bare = positional[0]?.trimStart().startsWith("[") ? positional.join(" ") : undefined;
      const steps = file !== undefined ? await Bun.file(resolve(file)).text() : flag("steps", rest) === "-" ? await readStdin() : bare;
      if (steps === undefined) break;
      try {
        const parsed: unknown = JSON.parse(steps);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "steps" in parsed) args = { ...parsed, ...args };
        else args.steps = parsed;
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
      tool = toolName(cmd) ?? unknownCommand(cmd);
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
  // A path is this terminal's, as a word or as a flag (PATH_PARAMS).
  for (const key of PATH_PARAMS[name ?? ""] ?? []) {
    const v = args[key];
    if (typeof v === "string" && v !== "") args[key] = resolve(v);
    else if (Array.isArray(v)) args[key] = v.map((p) => resolve(String(p)));
  }
  // eval's code from stdin, when no word, --expression, --file, or --reader gave it
  if (cmd === "eval" && args.reader === undefined) {
    if (args.expression === undefined || args.expression === "") args.expression = await readStdin();
    if (!String(args.expression).trim()) fail('usage: safari eval "<js>" --tab N [--page] | --expression js | --file path (or pipe the code in)', 2);
  }
  const raw = cmd === "eval" && hasFlag("raw", rest);
  if (raw && args.save !== undefined) fail("eval --raw prints the value, and --save writes it to a file: give one of them", 2);

  // The caller's environment goes with the call, for a type's secret "env".
  const result = await invoke(tool, args, true, false, process.env);
  if (raw) return printRaw(result);
  if (cmd === "open" && hasFlag("id", rest)) return printId(result);
  answer(result);
}

// Flags that take no value; the word after them is positional, unless it is
// true or false: on 10-04 `eval --page true "const ..."` ran "true const
// ..." and failed at its second word.
const BOOLEAN_FLAGS: Record<string, true> = { bg: true, keep: true, append: true, snapshot: true, approved: true, clipboard: true, diff: true, updates: true, ifChanged: true, includeValues: true, page: true, annotate: true, full: true, live: true, tiles: true, history: true, json: true, list: true, bitwarden: true, save: true, all: true, quiet: true, changed: true, showHidden: true, base64: true, front: true, dry: true, scheduled: true, background: true, raw: true, id: true, fresh: true };

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
  (e: unknown) => {
    if (json) {
      say(JSON.stringify(failureOf(e)));
      process.exit(1);
    }
    fail(e instanceof Error ? e.message : String(e));
  },
);
