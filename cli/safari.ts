#!/usr/bin/env bun
// safari — drive Safari from the terminal, aside-cli style.
//
//   safari tabs
//   safari open https://example.com
//   safari snapshot
//   safari click 12
//   safari type 14 "hello"
//   safari eval "document.title"
//   safari extract
//   safari shot
//   safari do "find the price of X on example.com"
//   safari serve            # start the daemon (the extension connects to it)
//
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgent } from "../daemon/agent.ts";
import { formatResult } from "../daemon/tools.ts";
import { IMESSAGE_TOOLS } from "../daemon/imessage.ts";
import { CALLER_TOOLS } from "../daemon/caller.ts";
import { daemonInstall, daemonUninstall, parseSchedule, routineAdd, routineList, routineRemove, routineRun } from "./launchd.ts";


const HTTP = process.env.SAFARI_HARNESS_HTTP ?? "http://127.0.0.1:37334";

const USAGE = `safari — drive Safari from the terminal

  safari guide                               how to use this for browsing and automations
  safari serve [--ws 37333] [--http 37334]   start the daemon in the foreground
  safari daemon install|uninstall            keep the daemon always on (launchd)
  safari status                              daemon + extension health
  safari tabs                                list tabs
  safari open <url> [--bg]                   open a tab
  safari goto <url> [--tab N]                navigate
  safari back|forward|reload [--tab N]       history
  safari close <tab>                         close a tab
  safari focus <tab>                         activate a tab
  safari snapshot [--tab N] [--query text] [--root sel] [--diff]
                                             page outline with [ref]s
  safari click <ref> [--tab N]               click by snapshot ref
  safari clickat <x> <y> [--tab N]           click by coordinates
  safari type <ref> <text> [--tab N]         type by ref
  safari press <key> [--ref R] [--tab N]     press a key
  safari select <ref> <option> [--tab N]     choose a dropdown option
  safari hover <ref> [--tab N]               hover an element
  safari upload <file>... [--ref R] [--tab N]
                                             attach files to a file input
  safari scroll <dy> [--tab N]               scroll

  Actions (open goto back forward reload click clickat type press select
  hover upload) take --snapshot to print the resulting page too.

  safari eval <js-expression> [--tab N] [--page]
                                             evaluate JS, print JSON
  safari extract [--tab N] [--selector s]    readable text
  safari info [--tab N]                      url/title/scroll
  safari wait <ms> [--tab N]                 sleep in the page
  safari wait [--selector s] [--text t] [--ms timeout] [--tab N]
                                             wait until it is on the page
  safari net start|stop|read [--tab N]       fetch/XHR capture
  safari console start|read [--tab N]        console capture
  safari cookies [--tab N]                   cookies for the page
  safari shot [--tab N] [--out file.png] [--ref R] [--annotate] [--full]
                                             screenshot what the tab shows
  safari download <ref|url> [--out file] [--tab N]
                                             save a file into ~/Downloads
  safari dialog [read|accept|dismiss] [text] [--tab N]
                                             how the tab answers alerts and confirms
  safari fetch <url> [--tab N]               request a URL with the page's cookies
  safari pdf [save|read] [file.pdf] [--out file.pdf] [--tab N]
                                             print the page to PDF, or read a PDF
  safari window <width> <height> --tab N     give a tab its own window at that size
  safari history-search [text]               search Safari browsing history
  safari call <tool> '<json args>'           any tool by name, as MCP calls it
  safari do "<task>" [--tab N] [--steps 30]  run the agent loop (local model)
  safari mcp                                 run the MCP stdio server (thin client)
  safari routine add <name> --at HH:MM|--every MIN [--model m] "<task>"
  safari routine list | run <name> | remove <name>
                                             scheduled tasks run through omp

  safari guide sites                         sites with a usage guide
  safari guide <site|host>                   one site's guide (e.g. amazon, x.com)

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

  Messages commands run in this terminal (they need its Full Disk Access),
  not in the daemon.
`;

type Rpc = { ok: boolean; value?: unknown; error?: string };

async function rpc(tool: string, args: Record<string, unknown> = {}): Promise<Rpc> {
  try {
    const res = await fetch(`${HTTP}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    return (await res.json()) as Rpc;
  } catch (e) {
    return { ok: false, error: `daemon not reachable at ${HTTP} — run: safari daemon install (or safari serve)` };
  }
}

function print(value: unknown) {
  console.log(formatResult(value));
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
  return t !== undefined ? { tab: Number(t) } : {};
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); process.exit(cmd ? 0 : 1); }

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
    if (!which) {
      console.log(await readFile(new URL("../docs/GUIDE.md", import.meta.url), "utf8"));
      return;
    }
    const text = await siteGuide(which);
    if (text === null) {
      console.error(`no guide for ${which}; see: safari guide sites`);
      process.exit(1);
    }
    console.log(text);
    return;
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
    if (!call) {
      console.error("usage: safari imessage chats|history|search|code|send …, or safari contacts <name>");
      process.exit(2);
    }
    try {
      print(await IMESSAGE_TOOLS[call[0]].run(call[1]));
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
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

  if (cmd === "status") {
    try {
      const res = await fetch(`${HTTP}/health`);
      print(await res.json());
    } catch {
      console.log(`daemon not reachable at ${HTTP} — run: safari daemon install`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "mcp") {
    const child = spawn(process.execPath, [new URL("../daemon/mcp.ts", import.meta.url).pathname], {
      stdio: "inherit",
      env: { ...process.env as Record<string, string>, SAFARI_HARNESS_HTTP: HTTP },
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  if (cmd === "do") {
    const task = rest[0];
    if (!task || task.startsWith("-")) { console.error("usage: safari do \"<task>\" [--tab N] [--steps N]"); process.exit(2); }
    const baseUrl = process.env.SAFARI_MODEL_BASE ?? "http://127.0.0.1:11434/v1";
    const model = process.env.SAFARI_MODEL ?? "gemma4:12b-mlx";
    const apiKey = process.env.SAFARI_MODEL_KEY;
    const t = await rpc("info", tabArg(rest));
    const final = await runAgent(task, {
      baseUrl,
      rpcUrl: HTTP,
      model,
      apiKey,
      maxSteps: Number(flag("steps", rest) ?? 30),
      onEvent: (ev) => {
        if (ev.type === "plan") console.error(`\x1b[2m▸ ${ev.text}\x1b[0m`);
        else if (ev.type === "tool") {
          const arg = JSON.stringify(ev.args).slice(0, 90);
          console.error(ev.ok ? `\x1b[36m● ${ev.name} ${arg}\x1b[0m` : `\x1b[31m✗ ${ev.name} ${arg} — ${ev.error}\x1b[0m`);
        } else if (ev.type === "error") console.error(`\x1b[31m! ${ev.text}\x1b[0m`);
      },
    }, (t.ok && typeof (t.value as { id?: number })?.id === "number") ? { tab: (t.value as { id: number }).id } : {});
    console.log(final);
    return;
  }

  const positional = rest.filter((a, i) => !a.startsWith("--") && !isFlagValue(i, rest));
  let tool = cmd;
  let args: Record<string, unknown> = { ...tabArg(rest), ...(hasFlag("snapshot", rest) ? { snapshot: true } : {}) };

  switch (cmd) {
    case "tabs": break;
    case "open": args.url = positional[0]; args.background = hasFlag("bg", rest); break;
    case "goto": args.url = positional[0]; break;
    case "back": case "forward": case "reload": tool = "history"; args.go = cmd; break;
    case "close": tool = "close"; args.tab = Number(positional[0]); break;
    case "focus": tool = "activate"; args.tab = Number(positional[0]); break;
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
    case "clickat": tool = "click"; args.x = Number(positional[0]); args.y = Number(positional[1]); break;
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
    case "history-search": tool = "browsing_history"; args = { text: positional.join(" ") || undefined }; break;
    case "call": {
      tool = positional[0] ?? "";
      const json = positional.slice(1).join(" ");
      try {
        args = { ...args, ...(json ? JSON.parse(json) as Record<string, unknown> : {}) };
      } catch {
        console.error("usage: safari call <tool> '<json args>'");
        process.exit(2);
      }
      break;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }

  const local = CALLER_TOOLS[tool];
  if (local) {
    try {
      print(await local.run(args));
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    return;
  }
  const res = await rpc(tool, args);
  if (!res.ok) {
    console.error(`error: ${res.error}`);
    process.exit(1);
  }
  print(res.value);
}

// Flags that take no value; the word after them is positional.
const BOOLEAN_FLAGS = new Set(["bg", "append", "snapshot", "approved", "diff", "page", "annotate", "full"]);

// docs/sites/<slug>.md, each opening with `name:` and `hosts:` front matter.
// A hosts entry is a domain, optionally with a path prefix (docs.google.com/
// spreadsheets); subdomains match, and the longest matching entry wins.
async function siteGuide(which: string): Promise<string | null> {
  const dir = new URL("../docs/sites/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const guides = await Promise.all(files.map(async (f) => {
    const text = await readFile(new URL(f, dir), "utf8");
    const hosts = (/^hosts:(.*)$/m.exec(text)?.[1] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    return { slug: f.slice(0, -3), name: /^name:\s*(.*)$/m.exec(text)?.[1] ?? f, hosts, text };
  }));
  if (which === "sites") return guides.map((g) => `${g.slug.padEnd(18)} ${g.hosts.join(", ")}`).join("\n");
  const q = which.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const named = guides.find((g) => g.slug === q || g.name.toLowerCase() === q);
  if (named) return named.text;
  const slash = q.indexOf("/");
  const [host, path] = slash < 0 ? [q, "/"] : [q.slice(0, slash), q.slice(slash)];
  let best: { text: string; score: number } | null = null;
  for (const g of guides) {
    for (const entry of g.hosts) {
      const cut = entry.indexOf("/");
      const [h, p] = cut < 0 ? [entry, ""] : [entry.slice(0, cut), entry.slice(cut)];
      if ((host === h || host.endsWith(`.${h}`)) && path.startsWith(p) && (!best || entry.length > best.score)) best = { text: g.text, score: entry.length };
    }
  }
  return best?.text ?? null;
}

function isFlagValue(i: number, argv: string[]): boolean {
  const prev = argv[i - 1];
  return i > 0 && prev.startsWith("--") && !prev.includes("=") && !BOOLEAN_FLAGS.has(prev.slice(2));
}

main();
