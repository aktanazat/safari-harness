// ask: an agent's question to the user. Away from the Mac (as handoff
// measures it), he gets it as a text on his phone, choices numbered, and
// his first reply is the answer. At the Mac nothing is sent: the agent asks
// in its own chat, where he is. It runs in the caller, which may control
// Messages and read its database; the daemon may do neither.
//
// A wait can outlast one tool call (about 2 minutes), so the question is
// kept in a file of the agent's own, and the next call with the same
// question goes on waiting for the same answer. An agent has one question
// out at a time: a second would leave his replies ambiguous.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ownerOf } from "./owner.ts";
import { dataFile, firstWord, isAway, isThread, POLL_MS, readJson, replies, text, type Thread, writeJson } from "./phone.ts";
import type { Tool } from "./tools.ts";

// One call waits this long at most, inside a tool call's 2 minutes.
const CALL_MS = 110_000;
const DEFAULT_MS = 10 * 60_000;
const MAX_MS = 30 * 60_000;

type Question = { question: string; choices: string[]; deadline: number; thread: Thread };
type Asked = { answer: string; choice?: string } | { answered: false; waiting?: true } | { atMac: true; hint: string };

function isQuestion(v: unknown): v is Question {
  return !!v && typeof v === "object" && "question" in v && typeof v.question === "string" && "choices" in v && Array.isArray(v.choices)
    && v.choices.every((c) => typeof c === "string") && "deadline" in v && typeof v.deadline === "number" && "thread" in v && isThread(v.thread);
}

// Whether pid still runs: signal 0 asks without sending anything.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

// Case, spacing, and punctuation aside: "Blue!" names the choice "blue".
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const isChoice = (c: unknown): c is string => typeof c === "string" && c.trim() !== "";

// His reply, and the choice it names by number or by its words.
function answer(reply: string, choices: string[]): Asked {
  const n = Number(firstWord(reply));
  const choice = Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1] : choices.find((c) => plain(c) === plain(reply));
  return { answer: reply, ...(choice === undefined ? {} : { choice }) };
}

async function ask(question: string, choices: string[], ms: number): Promise<Asked> {
  const dir = dataFile("questions");
  const now = Date.now();
  // Questions of agents that have exited, or whose wait is over, are
  // dropped; a file still being written has another name.
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!/^\d+\.json$/.test(f)) continue;
    const q = readJson(join(dir, f));
    if (!isQuestion(q) || q.deadline <= now || !alive(Number.parseInt(f, 10))) rmSync(join(dir, f), { force: true });
  }
  // The CLI's shell is not the agent; a caller with no agent above it
  // (launchd) is its own.
  const file = join(dir, `${(await ownerOf(process.pid)) ?? process.pid}.json`);
  const kept = readJson(file);
  let open = isQuestion(kept) ? kept : undefined;
  if (open && open.question !== question) {
    throw new Error(`this agent already asked the user "${open.question}" and waits on the answer until ${new Date(open.deadline).toLocaleTimeString()}; ask that again to go on waiting`);
  }
  if (!open) {
    if (!(await isAway())) return { atMac: true, hint: "the user is at the Mac: ask in your own chat; nothing was texted" };
    const line = `${process.env.SAFARI_HARNESS_AWAY === "1" ? "test of the question text: " : ""}an agent asks: ${question}${choices.length ? ` reply ${choices.map((c, i) => `${i + 1} for ${c}`).join(", ")}` : ""}`;
    const sent = await text(line, "ask");
    open = { question, choices, deadline: now + ms, thread: sent.thread };
    writeJson(file, open);
  }
  const until = Math.min(open.deadline, Date.now() + CALL_MS);
  for (;;) {
    const [reply] = replies(open.thread);
    if (reply !== undefined) {
      rmSync(file, { force: true });
      return answer(reply, open.choices);
    }
    if (Date.now() >= until) break;
    await Bun.sleep(POLL_MS);
  }
  // past its deadline, the next call's sweep drops it
  return Date.now() < open.deadline ? { answered: false, waiting: true } : { answered: false };
}

export const ASK_TOOLS: Record<string, Tool> = {
  ask: {
    desc: "Ask the user a question. Away from the Mac, texts his phone and returns his answer, and choice if he picked one; waiting: call again. At the Mac, texts nothing (atMac): ask in your chat.",
    params: {
      question: { type: "string", description: "one short line" },
      choices: { type: "array", items: { type: "string" }, description: "answers he may pick by number" },
      ms: { type: "number", description: "time he has: default 600000, max 1800000" },
    },
    required: ["question"],
    run: async (a) => {
      if (typeof a.question !== "string" || !a.question.trim()) throw new Error("question must be a line of text");
      const choices: unknown = a.choices ?? [];
      if (!Array.isArray(choices) || !choices.every(isChoice)) throw new Error("choices must be a list of answers");
      const ms = a.ms === undefined ? DEFAULT_MS : Number(a.ms);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("ms must be a positive number");
      return ask(a.question.trim(), choices.map((c) => c.trim()), Math.min(ms, MAX_MS));
    },
  },
};
