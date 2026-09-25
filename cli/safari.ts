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
import { runAgent } from "../daemon/agent.ts";


const HTTP = process.env.SAFARI_HARNESS_HTTP ?? "http://127.0.0.1:37334";

const USAGE = `safari — drive Safari from the terminal

  safari serve [--ws 37333] [--http 37334]   start the daemon (Safari extension connects)
  safari status                              daemon + extension health
  safari tabs                                list tabs
  safari open <url> [--bg]                   open a tab
  safari goto <url> [--tab N]                navigate
  safari close <tab>                         close a tab
  safari focus <tab>                         activate a tab
  safari snapshot [--tab N] [--root sel]     aria snapshot with [ref]s
  safari click <ref> [--tab N]               click by snapshot ref
  safari clickat <x> <y> [--tab N]           click by coordinates
  safari type <ref> <text> [--tab N]         type by ref
  safari press <key> [--tab N]               press a key
  safari scroll <dy> [--tab N]               scroll
  safari eval <js-expression> [--tab N]      evaluate JS, print JSON
  safari extract [--tab N] [--selector s]    readable text
  safari info [--tab N]                      url/title/scroll
  safari wait <ms> [--tab N]                 sleep in the page
  safari net start|stop|read [--tab N]       fetch/XHR capture
  safari console start|read [--tab N]        console capture
  safari cookies [--tab N]                   cookies for the page
  safari shot [--tab N] [--out file.png]     screenshot the Safari window
  safari do "<task>" [--tab N] [--steps 30]  run the agent loop
  safari mcp                                 run the MCP stdio server (thin client)
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
    return { ok: false, error: `daemon not reachable at ${HTTP} — run: safari serve` };
  }
}

function print(value: unknown) {
  if (typeof value === "string") { console.log(value); return; }
  console.log(JSON.stringify(value, null, 1));
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

  if (cmd === "status") {
    try {
      const res = await fetch(`${HTTP}/health`);
      print(await res.json());
    } catch {
      console.log(`daemon not reachable at ${HTTP} — run: safari serve`);
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
    if (!task) { console.error("usage: safari do \"<task>\""); process.exit(2); }
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

  const positional = rest.filter((a) => !a.startsWith("--") && !isFlagValue(a, rest));
  let tool = cmd;
  let args: Record<string, unknown> = { ...tabArg(rest) };

  switch (cmd) {
    case "tabs": break;
    case "open": args.url = positional[0]; args.background = hasFlag("bg", rest); break;
    case "goto": args.url = positional[0]; break;
    case "close": tool = "close"; args.tab = Number(positional[0]); break;
    case "focus": tool = "activate"; args.tab = Number(positional[0]); break;
    case "snapshot": {
      const root = flag("root", rest);
      if (root) args.root = root;
      const max = flag("max", rest);
      if (max) args.maxNodes = Number(max);
      break;
    }
    case "click": args.ref = positional[0]; break;
    case "clickat": args.x = Number(positional[0]); args.y = Number(positional[1]); break;
    case "type": args.ref = positional[0]; args.text = rest.slice(rest.indexOf(positional[1])).join(" ").replace(/^"|"$/g, ""); args.append = hasFlag("append", rest); break;
    case "press": args.key = positional[0]; break;
    case "scroll": args.dy = Number(positional[0] ?? 600); break;
    case "eval": args.expression = rest.filter((a) => !a.startsWith("--tab")).join(" "); break;
    case "extract": {
      const sel = flag("selector", rest);
      if (sel) args.selector = sel;
      break;
    }
    case "info": break;
    case "wait": args.ms = Number(positional[0]); break;
    case "net": {
      const sub = positional[0];
      tool = sub === "start" ? "net_start" : sub === "stop" ? "net_stop" : "net_read";
      break;
    }
    case "console": {
      const sub = positional[0];
      tool = sub === "start" ? "console_start" : "console_read";
      break;
    }
    case "cookies": {
      const u = flag("url", rest);
      if (u) args.url = u;
      break;
    }
    case "shot": {
      const out = flag("out", rest);
      if (out) args.out = out;
      break;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }

  const res = await rpc(tool, args);
  if (!res.ok) {
    console.error(`error: ${res.error}`);
    process.exit(1);
  }
  // snapshot: print the human tree, not JSON
  if (cmd === "snapshot" && res.value && typeof res.value === "object" && "snapshot" in (res.value as Record<string, unknown>)) {
    const v = res.value as { url: string; title: string; snapshot: string; truncated?: boolean; nodes: number };
    console.log(`# ${v.title} — ${v.url} (${v.nodes} nodes${v.truncated ? ", TRUNCATED" : ""})`);
    console.log(v.snapshot);
    return;
  }
  if (cmd === "extract" && res.value && typeof res.value === "object" && "text" in (res.value as Record<string, unknown>)) {
    const v = res.value as { title: string; text: string };
    console.log(`# ${v.title}\n\n${v.text}`);
    return;
  }
  print(res.value);
}

function isFlagValue(a: string, argv: string[]): boolean {
  const i = argv.indexOf(a);
  return i > 0 && argv[i - 1].startsWith("--") && !argv[i - 1].includes("=");
}

main();
