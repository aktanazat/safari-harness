import { homedir } from "node:os";
import { join } from "node:path";
import { takesMarks } from "../daemon/fresh.ts";
import { connectionRefused, daemonBack, daemonHttp, type Missed } from "../daemon/rpc.ts";
import { setSessionTask } from "../daemon/session-task.ts";
import { cancelLeftSheets } from "../daemon/sheets.ts";
import { newRun, unanswered, webResult, type Block, type ToolResult } from "./walls.ts";

type AgentEnd = { willContinue?: boolean };
type Context = {
  mode: string;
  agent?: { kind: "main" | "sub"; id: string; parentId?: string };
  sessionManager?: { getSessionId(): string };
};
type ToolCall = { toolName: string; toolCallId?: string; input: Record<string, unknown> };
type ToolCallResult = { input: Record<string, unknown> } | { block: true; reason: string };
type ExtensionApi = {
  on(event: "agent_end", handler: (event: AgentEnd, ctx: Context) => void | Promise<void>): void;
  on(event: "tool_call", handler: (event: ToolCall, ctx: Context) => Promise<ToolCallResult | undefined>): void;
  on(event: "tool_result", handler: (event: ToolResult, ctx: Context) => Promise<{ content: Block[] } | undefined>): void;
  on(event: "session_stop", handler: (event: unknown, ctx: Context) => { continue: true; additionalContext: string } | undefined): void;
  on(event: "before_agent_start", handler: (event: unknown, ctx: Context) => void): void;
  logger?: { warn(message: string): void };
};

// omp runs each helper in a session of its own. A helper's task also names
// its lead's session, fixed at the helper's first call, so the daemon keeps
// a session's reads for its helpers too (daemon/reads.ts). By agent id, the
// lead's session of that agent's latest call; by helper session, its lead's.
const leadOfAgent = new Map<string, string>();
const leadOfHelper = new Map<string, string>();

function taskOf(ctx: Context): string | undefined {
  const session = ctx.sessionManager?.getSessionId();
  const agent = ctx.agent;
  if (!session || !agent?.id) return undefined;
  const parent = agent.parentId === undefined ? undefined : leadOfAgent.get(agent.parentId);
  const lead = agent.kind === "main" ? session : leadOfHelper.get(session) ?? parent ?? session;
  if (agent.kind === "sub") leadOfHelper.set(session, lead);
  leadOfAgent.set(agent.id, lead);
  return JSON.stringify(lead === session ? [session, agent.id] : [session, agent.id, lead]);
}

// A lead's turn end releases its pages this long after its agent_end,
// unless its session starts again first. omp ends a reply the user's
// message interrupts with a final agent_end and starts the next run about
// a second later: from 11-02 to 11-04, 19 tab closes came within the same
// minute as such a steer, and each cost the agent a failed call and a
// fresh load (AuditSafariHarness-2). A helper's end releases at once.
const RELEASE_DELAY_MS = 15_000;
// By lead session, its release waiting out that pause.
const releasing = new Map<string, Timer>();

export default function safariTurnEnd(pi: ExtensionApi) {
  pi.on("tool_call", async (event, ctx) => {
    // A helper ends its run by calling yield; one whose run met a page
    // that did not load, with no Safari attempt at it, is sent back once.
    if (event.toolName === "yield" && ctx.agent?.kind === "sub") {
      const session = ctx.sessionManager?.getSessionId();
      const reason = session === undefined ? undefined : unanswered(session);
      return reason === undefined ? undefined : { block: true, reason };
    }
    const refused = event.toolName === "bash" && typeof event.input.command === "string" ? shellMisuse(event.input.command) : undefined;
    if (refused !== undefined) return { block: true, reason: refused };
    const task = taskOf(ctx);
    if (task === undefined) return;
    if (event.toolName.startsWith("mcp__safari_")) {
      // Nested write xd:// dispatches emit this same canonical tool event.
      // omp's eval bridge names its calls js-<tool>-<uuid>, and their answers
      // reach the cell's code. The model's own calls, whose answers reach it
      // as given, are marked: only those may answer with what changed
      // (mcp-tools.ts). A session keeps this extension across deploys, so
      // each call asks whether the release current names takes the mark.
      const own = event.toolCallId !== undefined && !event.toolCallId.startsWith("js-")
        && takesMarks(join(homedir(), ".local", "share", "safari-harness", "current")) ? { __safariVerbatim: true } : {};
      return { input: { ...event.input, __safariTask: task, ...own } };
    }
    // Every shell command's calls carry the task, not only safari's:
    // scripts and REPL code it starts reach the daemon through rpc.ts too.
    const session = ctx.sessionManager?.getSessionId();
    if (event.toolName === "bash" && session) {
      try {
        setSessionTask(session, task);
      } catch (e: unknown) {
        // omp blocks a command whose tool_call handler throws
        pi.logger?.warn(`safari-harness: shell commands go without their task: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue || (ctx.mode === "print" && ctx.agent?.kind !== "sub")) return;
    const task = taskOf(ctx);
    if (ctx.agent?.kind !== "sub") {
      // The lead's own task, which also reaches the pages no task names:
      // its helpers' pages are theirs to release, and they may still run.
      const session = ctx.sessionManager?.getSessionId() ?? "";
      clearTimeout(releasing.get(session));
      const timer = setTimeout(() => {
        releasing.delete(session);
        void release(pi, task);
      }, RELEASE_DELAY_MS);
      timer.unref();
      releasing.set(session, timer);
      return;
    }
    if (task === undefined) {
      pi.logger?.warn("safari-harness turn end: helper task identity is unavailable; leaving its pages protected");
      return;
    }
    return release(pi, task);
  });
  pi.on("tool_result", (event, ctx) => webResult(event, ctx.sessionManager?.getSessionId(), () => taskOf(ctx)));
  // A lead's run that would end the same way continues once.
  pi.on("session_stop", (_event, ctx) => {
    const session = ctx.sessionManager?.getSessionId();
    const reason = session === undefined ? undefined : unanswered(session);
    return reason === undefined ? undefined : { continue: true, additionalContext: reason };
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const session = ctx.sessionManager?.getSessionId();
    if (ctx.agent?.kind === "sub") return;
    clearTimeout(releasing.get(session ?? ""));
    releasing.delete(session ?? "");
    if (session !== undefined) newRun(session);
  });
}

// ---------- safari output a shell command hides ----------

// From 11-06 to 11-16, 383 of 492 distinct shell commands that ran the
// safari CLI piped its output into head, tail, grep, sed or cut, or sent it
// to /dev/null, against the card; on 11-11 and 11-16 a failed call went
// with it (LOCK#691-692, BERK#168). Shell loops of goto, eval and window
// ran a page at a time where one map or shots call reads them all.
const CUTS: Record<string, true> = { head: true, tail: true, grep: true, sed: true, cut: true };
const LOOPED: Record<string, true> = { map: true, eval: true, goto: true, open: true, shot: true, window: true, repl: true };
const LOOPS: Record<string, true> = { for: true, while: true, until: true, select: true };
// Words before a command's own name: shell keywords, and wrappers that run
// the command after them. A Set, as an object with a then key is thenable.
const LEADS = new Set(["do", "then", "else", "elif", "if", "!", "{", "time", "command", "exec", "nohup"]);
const DEV_NULL = /^(?:\d|&)?>>?\/dev\/null$|^>&\/dev\/null$/;
// A quoted word's text: the shell's words inside quotes are not commands.
const QUOTED = "\u0000";
const CARD_PIPE = "\"Read the whole output. Narrow with `query` or `root`, never `| head`, `| grep`, `sed`, or `>/dev/null`, which hide a failed call.\"";
const CARD_QUIET = "\"A CLI step whose answer you do not need takes `-q`: silent when it works, one line and exit 1 when it misses.\"";
const CARD_LOOP = "\"More than three pages of one kind: one `map` call (up to 20 addresses), ... never a loop of `goto` or a bash loop of `map` or `eval`.\" and \"Screenshots of several pages: one `shots` call (`safari shots --widths 1440 --out DIR URL...`), not a loop of `window` and `shot`.\"";

type Command = string[];

// The command's own name and the words after it, past assignments
// (T=7 safari ...), keywords (do safari ...), and timeout's duration.
function ownWords(words: Command): Command {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_]\w*=/.test(w) || LEADS.has(w)) i++;
    else if (w === "timeout") {
      i++;
      while (words[i]?.startsWith("-")) i++;
      i++;
    } else break;
  }
  return words.slice(i);
}

// The pipelines of a shell command, each a list of commands' words, in the
// order they run; a command substitution's, a subshell's and a backquoted
// command's are pipelines of their own. A here-document's lines are its
// command's input, not commands: a repl script's `for` and `|` are not the
// shell's.
function pipelinesOf(command: string): Command[][] {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const ends = [...lines[i].matchAll(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/g)].map((m) => m[2]);
    for (const end of ends) while (i + 1 < lines.length && lines[++i].replace(/^\t+/, "") !== end);
  }
  const src = kept.join("\n");
  const out: Command[][] = [];
  const scan = (start: number, close: string | undefined): number => {
    let pipeline: Command[] = [];
    let words: Command = [];
    let word = "";
    const endWord = () => {
      if (word !== "") words.push(word);
      word = "";
    };
    const endCommand = () => {
      endWord();
      if (words.length) pipeline.push(words);
      words = [];
    };
    const endPipeline = () => {
      endCommand();
      if (pipeline.length) out.push(pipeline);
      pipeline = [];
    };
    let i = start;
    while (i < src.length) {
      const c = src[i];
      const next = src[i + 1];
      if (c === close) {
        endPipeline();
        return i + 1;
      }
      if (c === "\\") {
        if (next !== "\n") word += next ?? "";
        i += 2;
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        word += QUOTED;
        i = end < 0 ? src.length : end + 1;
      } else if (c === '"') {
        word += QUOTED;
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\") i += 2;
          else if (src[i] === "$" && src[i + 1] === "(") i = scan(i + 2, ")");
          else if (src[i] === "`") i = scan(i + 1, "`");
          else i++;
        }
        i++;
      } else if (c === "$" && next === "(") {
        word += QUOTED;
        i = scan(i + 2, ")");
      } else if (c === "`") {
        word += QUOTED;
        i = scan(i + 1, "`");
      } else if (c === "(") {
        endWord();
        i = scan(i + 1, ")");
      } else if (c === "#" && word === "") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (c === " " || c === "\t") {
        endWord();
        i++;
      } else if (c === "\n" || c === ";") {
        endPipeline();
        i++;
      } else if (c === "|") {
        if (next === "|") endPipeline();
        else endCommand();
        i += next === "|" || next === "&" ? 2 : 1;
      } else if (c === "&" && next !== ">" && !word.endsWith(">")) {
        endPipeline();
        i += next === "&" ? 2 : 1;
      } else {
        word += c;
        i++;
      }
    }
    endPipeline();
    return i;
  };
  scan(0, undefined);
  return out;
}

// Why a shell command is refused before it runs: it cuts or hides a safari
// command's output, or runs a page at a time in a shell loop what one call
// does. Each kind is named once, with the card's line and the right form.
function shellMisuse(command: string): string | undefined {
  if (!/(?:^|[\s;&|('"`])safari\s/.test(command)) return undefined;
  const found = new Map<string, string>();
  let depth = 0;
  for (const pipeline of pipelinesOf(command)) {
    let ran: string | undefined;
    for (const words of pipeline) {
      let own = ownWords(words);
      if (Object.hasOwn(LOOPS, own[0] ?? "")) {
        depth++;
        own = ownWords(own.slice(1));
      } else if (own[0] === "done") depth = Math.max(0, depth - 1);
      const name = own[0] ?? "";
      if (ran !== undefined && Object.hasOwn(CUTS, name) && !found.has("pipe")) {
        found.set("pipe", `\`safari ${ran}\` pipes its output into ${name}, which can hide a failed call. The card (safari guide) says: ${CARD_PIPE} Run it without the pipe: narrow a read with --query or --root, take a tab's id alone with safari open --id URL, or keep a long output whole with --save and read that file. A pipe into jq is fine.`);
      }
      if (name !== "safari" || !/^[a-z][a-z_-]*$/.test(own[1] ?? "")) continue;
      const sub = own[1];
      ran ??= sub;
      if (!found.has("quiet") && own.some((w, i) => DEV_NULL.test(w) || (/^(?:\d|&)?>>?$/.test(w) && own[i + 1] === "/dev/null"))) {
        found.set("quiet", `\`safari ${sub}\` sends its output to /dev/null, which hides a failed call. The card says: ${CARD_QUIET} Give it -q instead.`);
      }
      if (depth > 0 && Object.hasOwn(LOOPED, sub) && !found.has("loop")) {
        found.set("loop", `a shell loop runs \`safari ${sub}\` a page at a time. The card says: ${CARD_LOOP} Read every address in one safari map call (--what eval --expression for a script on each page), take widths with one safari shots call, or put steps that must go page by page in one safari repl script.`);
      }
    }
  }
  if (found.size === 0) return undefined;
  return `safari: refused before it ran. ${[...found.values()].join("\n")}`;
}

// How long one release waits on the daemon. It first drains the task's
// calls in flight, and a lead interrupted mid-call may have one waiting on
// a page or the user for minutes; its pages then close when unused for 20
// minutes or as this process exits.
const RELEASE_MS = 30_000;

// A release the daemon missed as it restarted (a deploy) goes again once
// it answers: before 11-06 it was dropped, and the turn's pages stayed
// until the idle close (AuditSafariHarness-10). Once the daemon
// has answered, a print sheet a page left on a window the turn closed
// (sheets.ts) is cancelled from here, where the terminal's Accessibility
// permission is; a tab that would not close may be one that sheet held.
async function release(pi: ExtensionApi, task?: string): Promise<void> {
  const admission = { owner: process.pid, ...(task === undefined ? {} : { task }) };
  const base = daemonHttp();
  const warn = (e: unknown) => {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    pi.logger?.warn(`safari-harness turn end: ${timedOut ? `no answer within ${RELEASE_MS / 1000} s; its pages close when unused for 2 minutes or when this process exits` : e instanceof Error ? e.message : String(e)}`);
  };
  try {
    let answer = await releaseOnce(base, admission);
    if (typeof answer === "string" && await daemonBack(base, answer)) answer = await releaseOnce(base, admission);
    if (answer === "restarting") throw new Error("the daemon was restarting, and did not answer again in time");
    if (typeof answer === "string") return;
    if (answer.failed > 0) warn(new Error(`could not close ${answer.failed} tab(s); they close when this process exits`));
    await cancelLeftSheets();
  } catch (e: unknown) {
    warn(e);
  }
}

async function releaseOnce(base: string, admission: { owner: number; task?: string }): Promise<Missed | { failed: number }> {
  const signal = AbortSignal.timeout(RELEASE_MS);
  const post = async (path: string, body: unknown): Promise<Response | Missed> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), signal });
    } catch (e: unknown) {
      if (connectionRefused(e)) return "refused";
      throw e;
    }
    if (res.ok) return res;
    const text = await res.text();
    if (res.status === 503 && /"restarting":true/.test(text)) return "restarting";
    throw new Error(`${path}: ${res.status} ${text}`);
  };
  const prepare = await post("/turn-end/prepare", admission);
  if (typeof prepare === "string") return prepare;
  const prepared: unknown = await prepare.json();
  const res = await post("/turn-end", { ...admission, prepared });
  if (typeof res === "string") return res;
  const result: unknown = await res.json();
  return { failed: result && typeof result === "object" && "failed" in result && typeof result.failed === "number" ? result.failed : 0 };
}
