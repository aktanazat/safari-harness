// The user's ok for an agent's step that uses his secrets or acts in his
// name: one request for every tool, shown before omp runs the call, as a
// popup on his Mac (scripts/approve.swift), as a prompt in the omp session
// that asked, and on his phone while he is away. It gates what agents that
// follow the rules do through their tools; it does not contain one that
// goes around them (its shell can still reach the vault key or
// osascript). Launchd jobs and his own terminal never pass through omp, so
// they are never asked, and neither is a headless (print) session's lead
// or its helpers: a scheduled routine has nobody at the Mac to answer.
//
// The popup is the one judge: the terminal prompt only forwards Enter or
// Esc to it, so a yes typed there still needs Touch ID. omp gives a
// tool_call handler 30 s, paused while it shows a dialog. A lead with a
// terminal waits on the prompt as long as the popup lives; any other call
// waits WAIT_MS and is then turned back with "call again": the popup stays
// up, and the same call made again joins it rather than asking twice. The
// first answer, Mac or phone, wins.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { STEP_TOOLS } from "../daemon/call.ts";
import { checkCall, checkStep } from "../daemon/guard.ts";
import { isAway } from "../daemon/phone.ts";
import { rpc } from "../daemon/rpc.ts";
import { secretType } from "../daemon/secret.ts";

type Kind = "secret" | "login" | "card" | "message" | "shortcut" | "handoff";

export type Ask = {
  kind: Kind;
  verb: string;
  item: { name: string };
  // What every surface shows: the literal thing approved, and at most one
  // fact under it (the command, the amount, the text). mono: the fact is a
  // command.
  title: string;
  detail?: string;
  mono?: boolean;
  where?: string;
  // What one yes covers besides kind, item and where: the program a secret
  // goes to, a text's exact content.
  scope: string;
  // How long one yes keeps covering the same step for this lead's session;
  // 0 asks every time.
  reuseMs: number;
  // false: a handoff's "Show me", which needs no Touch ID.
  auth: boolean;
  approve?: string;
  deny?: string;
};

// The parts of omp's ctx.ui and its TUI the terminal prompt uses.
type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type Prompt = { render(width: number): string[]; handleInput(data: string): void; invalidate(): void };
export type TerminalUi = {
  custom<T>(factory: (tui: { requestRender(): void }, theme: Theme, keys: { matches(data: string, action: string): boolean }, done: (result: T) => void) => Prompt): Promise<T>;
};

type Answer = { approved: boolean; reason: string; via: "mac" | "phone" };
// settledAt: when his answer came. A yes waits LIFE_MS for the call made
// again; a no turns back the same call for DENIED_MS, so an agent that
// retries does not raise the popup again at once. An unanswered one stays:
// its popup always ends it, by an answer, its timeout, or closing.
// shown: the popup is on screen, not waiting behind another's. prompted: a
// terminal prompt already shows it.
type Pending = { answer: Promise<Answer>; shown: Promise<void>; isShown: boolean; send(word: "approve" | "deny"): void; settled?: Answer; settledAt?: number; prompted?: boolean };

const WAIT_MS = 25_000;
const LIFE_MS = 10 * 60_000;
const DENIED_MS = 60_000;
const REUSE_MS = 10 * 60_000;
const INFO_MS = 3_000;
const PHONE_POLL_MS = 2_000;
// The phone page takes a title up to 200 characters and a line up to 300.
const TITLE_MAX = 200;
const DETAIL_MAX = 300;
const POPUP = new URL("../scripts/approve", import.meta.url).pathname;
const LOG = join(homedir(), "Library", "Logs", "safari-harness", "approvals.jsonl");

const pending = new Map<string, Pending>();
const grants = new Map<string, number>();

const VAR = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_RUN = /\bmem-secret\s+run\s+((?:\S+\s+)*?)--\s+([^\n]*)/g;
const VAULT_SHELL = /\bmem-secret\s+(?:edit|keychain-restore)\b|\bsops\s+(?:-d\b|--decrypt\b|decrypt\b|exec-env\b|exec-file\b)|engram-age-identity/;
// The safari CLI calls the daemon itself, so its fills, codes and texts
// never reach the Safari tools this gate reads.
const SAFARI_SHELL = /\bsafari\s+(?:fill|passwords|bitwarden|imessage\s+send)\b|\bsafari\s[^\n]*(?:\{\{code\}\}|--secret\b|\b(?:passwords|bitwarden|imessage_send)\b)/i;

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// What a shell command or code would do with the vault or Safari: every
// secret it names, and the whole command, which one yes covers exactly.
function shellAsk(code: string): Ask | undefined {
  const all = code.trim();
  const runs = [...all.matchAll(SECRET_RUN)];
  const vault = VAULT_SHELL.test(all) || (all.match(/\bmem-secret\s+run\b/g)?.length ?? 0) > runs.length;
  if (runs.length === 0 && !vault) {
    if (!SAFARI_SHELL.test(all)) return undefined;
    return { kind: "login", verb: "use Safari in your name", item: { name: "Safari" }, title: "Safari", detail: all, mono: true, scope: all, reuseMs: REUSE_MS, auth: true };
  }
  const names = [...new Set(runs.flatMap((r) => (r[1] ?? "").trim().split(/\s+/).filter((w) => VAR.test(w) || w === "--all")))];
  const every = vault || names.length === 0 || names.includes("--all");
  const name = every ? "Your whole vault" : names.join(", ");
  const only = runs.length === 1 && !vault && runs[0]?.[0].trim() === all ? runs[0][2]?.trim() : undefined;
  return { kind: "secret", verb: every ? "open the vault" : "use a secret", item: { name }, title: name, detail: only || all, mono: true, scope: all, reuseMs: every ? 0 : REUSE_MS, auth: true };
}

// The page a step acts on. host: shown and part of the grant; without it
// the step asks every time, since one yes must not cover another site.
// where: the log's and the grant's, which still tells two tabs apart.
type Place = { host?: string; where?: string };

function hostOf(url: unknown): Place {
  try {
    const host = new URL(String(url)).host;
    if (host) return { host, where: host };
  } catch {}
  return {};
}

async function pageOf(tab: unknown): Promise<Place> {
  if (tab === undefined) return {};
  try {
    const info = await Promise.race([rpc("info", { tab }), Bun.sleep(INFO_MS)]);
    const url = info && typeof info === "object" && "url" in info ? info.url : undefined;
    const place = hostOf(url);
    if (place.host) return place;
  } catch {}
  return { where: `tab ${String(tab)}` };
}

function loginAsk(verb: string, scope: string, detail: string, reuseMs: number, place: Place): Ask {
  const title = place.host ?? "This page";
  return { kind: "login", verb, item: { name: title }, title, detail, where: place.where, scope, reuseMs: place.host ? reuseMs : 0, auth: true };
}

const CODE_FROM: Record<string, string> = { sms: "Code from your texts", mail: "Code from your email", page: "Code from another tab", passwords: "Code from Apple Passwords", env: "Code from a variable" };

// A call as the daemon will run it (guard.ts), and where it acts.
async function safariAsk(tool: string, a: Record<string, unknown>, place: () => Promise<Place>): Promise<Ask | undefined> {
  if (tool === "passwords" || tool === "bitwarden") {
    const user = text(a.username);
    switch (a.do ?? (tool === "bitwarden" ? "fill" : undefined)) {
      case "fill":
        return loginAsk("fill a saved password", user ?? "", user ? `Password for ${user}` : "Saved password", REUSE_MS, await place());
      case "code":
        return loginAsk("fill a sign-in code", "code", "Sign-in code", REUSE_MS, await place());
      case "change": {
        const site = text(a.site);
        return loginAsk("change a saved password", "change", user ? `New password for ${user}` : "New password", 0, site ? { host: site, where: site } : await place());
      }
      case "card-fill": {
        const { host, where } = await place();
        const amount = text(a.amount);
        const card = text(a.card) ?? "Saved card";
        const detail = [amount, host].filter(Boolean).join(" at ") || undefined;
        return { kind: "card", verb: "fill a saved card", item: { name: card }, title: card, detail, where, scope: amount ?? "", reuseMs: host ? REUSE_MS : 0, auth: true };
      }
      case "card-save": {
        const card = text(a.name) ?? "New card";
        return { kind: "card", verb: "save a card", item: { name: card }, title: card, detail: "Save to this Mac", scope: "save", reuseMs: 0, auth: true };
      }
      default:
        return undefined;
    }
  }
  if (secretType(tool, a)) {
    const how = text(a.secret);
    return loginAsk("type a sign-in code", how ?? "code", (how && CODE_FROM[how]) ?? "Code from your texts or email", REUSE_MS, await place());
  }
  if (tool === "imessage_send" && a.approved !== undefined && a.approved !== false) {
    const files = Array.isArray(a.files) ? a.files.map(String) : [];
    const body = String(a.text ?? "");
    const to = String(a.to ?? "");
    const hash = createHash("sha256").update(JSON.stringify([a.to, body, files])).digest("hex");
    const detail = [body, files.map((f) => basename(f)).join(", ")].filter(Boolean).join("\n") || undefined;
    return { kind: "message", verb: "send a text", item: { name: to }, title: `Text to ${to}`, detail, scope: hash, reuseMs: 0, auth: true, approve: "Send" };
  }
  if (tool === "handoff" && a.id === undefined) {
    const { host, where } = await place();
    const why = text(a.why);
    const title = why ?? "A step in Safari";
    return { kind: "handoff", verb: "hand you a step", item: { name: host ?? "Safari" }, title, detail: why ? host ?? "Safari" : host, where, scope: why ?? "", reuseMs: host ? REUSE_MS : 0, auth: false, approve: "Show me", deny: "Not now" };
  }
  return undefined;
}

// A call as the daemon reads it: names and parameters it takes another
// way folded in. One it would turn back is read as written.
function checked(tool: string, given: Record<string, unknown>, step: boolean): { tool: string; args: Record<string, unknown> } {
  try {
    return step ? checkStep(STEP_TOOLS, tool, given) : checkCall(STEP_TOOLS, tool, given, true);
  } catch {
    return { tool, args: given };
  }
}

// A run's steps, each on the tab the daemon gives it (tools.ts runSteps):
// its own, else the page the run's latest open made, else the last tab a
// step or the run named. An open or goto earlier in the run sets that
// page's host before the step acts.
async function runAsks(run: Record<string, unknown>): Promise<Ask[]> {
  if (!Array.isArray(run.steps)) return [];
  const asks: Ask[] = [];
  const moved = new Map<string, Place>();
  let named = run.tab;
  let opened = false;
  for (const raw of run.steps) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as { tool?: unknown; args?: unknown };
    if (typeof s.tool !== "string") continue;
    const { tool, args } = checked(s.tool, s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {}, true);
    if (args.tab !== undefined) named = args.tab;
    if (tool === "open") {
      opened = true;
      moved.set("opened", hostOf(args.url));
      continue;
    }
    const tab = args.tab ?? (opened ? undefined : named);
    const key = tab === undefined ? (opened ? "opened" : undefined) : `tab ${String(tab)}`;
    if (tool === "goto") {
      if (key) moved.set(key, hostOf(args.url));
      continue;
    }
    const ask = await safariAsk(tool, args, async () => (key ? moved.get(key) : undefined) ?? (tab === undefined ? {} : pageOf(tab)));
    if (ask) asks.push(ask);
  }
  return asks;
}

// Every step of a call that needs his ok, in order.
export async function asksOf(toolName: string, input: Record<string, unknown>): Promise<Ask[]> {
  if (toolName === "bash" || toolName === "eval") {
    const code = toolName === "bash" ? input.command : input.code;
    const ask = typeof code === "string" ? shellAsk(code) : undefined;
    return ask ? [ask] : [];
  }
  if (toolName === "mac_shortcut" && text(input.name)) {
    const name = String(input.name);
    const files = Array.isArray(input.input) ? input.input.map(String) : [];
    return [{ kind: "shortcut", verb: "run a shortcut", item: { name }, title: name, detail: files.length ? files.map((f) => basename(f)).join(", ") : "Shortcut", scope: "", reuseMs: REUSE_MS, auth: true }];
  }
  if (toolName === "mac_handoff") {
    const app = String(input.app ?? "An app");
    const recovery = input.reason === "account_recovery_required";
    return [{ kind: "handoff", verb: "hand you a step", item: { name: app }, title: recovery ? "Account recovery" : "Finish signing in", detail: app, scope: String(input.reason ?? ""), reuseMs: REUSE_MS, auth: false, approve: "Show me", deny: "Not now" }];
  }
  if (!toolName.startsWith("mcp__safari_")) return [];
  const { tool, args } = checked(toolName.slice("mcp__safari_".length), input, false);
  if (tool === "run") return runAsks(args);
  const ask = await safariAsk(tool, args, () => pageOf(args.tab));
  return ask ? [ask] : [];
}

function log(ask: Ask, lead: string, decision: string, via?: string): void {
  try {
    mkdirSync(join(homedir(), "Library", "Logs", "safari-harness"), { recursive: true });
    appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), kind: ask.kind, item: ask.item.name, where: ask.where, lead, decision, via })}\n`, { mode: 0o600 });
  } catch {}
}

// The popup prints "shown" once it is on screen, and its answer as the last
// line.
function popup(ask: Ask): { answer: Promise<Answer>; shown: Promise<void>; send(word: "approve" | "deny"): void; stop(): void } {
  const child = spawn(POPUP, [], { stdio: ["pipe", "pipe", "ignore"] });
  const { promise, resolve } = Promise.withResolvers<Answer>();
  const shown = Promise.withResolvers<void>();
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    if (out.startsWith("shown\n")) shown.resolve();
  });
  child.stdin.on("error", () => {});
  child.on("error", () => resolve({ approved: false, reason: "no_popup", via: "mac" }));
  child.on("close", () => {
    try {
      const a = JSON.parse(out.trim().split("\n").at(-1) ?? "") as { approved?: unknown; reason?: unknown };
      resolve({ approved: a.approved === true, reason: typeof a.reason === "string" ? a.reason : "closed", via: "mac" });
    } catch {
      resolve({ approved: false, reason: "closed", via: "mac" });
    }
  });
  const request = { asker: "omp", title: ask.title, detail: ask.detail, mono: ask.mono, approve: ask.approve, deny: ask.deny, auth: ask.auth, reason: `let omp ${ask.verb}: ${ask.item.name}`, timeoutMs: LIFE_MS };
  child.stdin.write(`${JSON.stringify(request)}\n`);
  return {
    answer: promise,
    shown: shown.promise,
    send: (word) => { if (child.exitCode === null) child.stdin.write(`${word}\n`); },
    stop: () => child.kill(),
  };
}

// The same request on his phone while he is away. Resolves only on his
// answer there; a daemon that cannot take it leaves the Mac popup alone.
function phone(ask: Ask, done: Promise<Answer>): Promise<Answer> {
  const { promise, resolve } = Promise.withResolvers<Answer>();
  void (async () => {
    try {
      if (!(await isAway())) return;
      const request = { verb: ask.verb, kind: ask.kind, item: { name: clip(ask.item.name, TITLE_MAX) }, where: ask.where, title: clip(ask.title, TITLE_MAX), line: ask.detail === undefined ? undefined : clip(ask.detail.replaceAll("\n", " · "), DETAIL_MAX), mono: ask.mono, rows: [], approve: ask.approve, deny: ask.deny };
      const opened = (await rpc("approval_phone_open", { request })) as { id?: unknown };
      const id = opened.id;
      if (typeof id !== "string") return;
      let over = false;
      void done.then(() => {
        over = true;
        void rpc("approval_phone_close", { id }).catch(() => {});
      });
      while (!over) {
        await Bun.sleep(PHONE_POLL_MS);
        if (over) return;
        const s = (await rpc("approval_phone_state", { id })) as { state?: unknown };
        if (s.state === "approved" || s.state === "denied") return resolve({ approved: s.state === "approved", reason: String(s.state), via: "phone" });
        if (s.state === "expired") return;
      }
    } catch {}
  })();
  return promise;
}

function ask(key: string, a: Ask, lead: string): Pending {
  const mac = popup(a);
  const done = Promise.withResolvers<Answer>();
  const answer = Promise.race([mac.answer, phone(a, done.promise)]);
  const p: Pending = { answer, shown: mac.shown, isShown: false, send: mac.send };
  void mac.shown.then(() => { p.isShown = true; });
  void answer.then((x) => {
    p.settled = x;
    p.settledAt = Date.now();
    done.resolve(x);
    if (x.via === "phone") mac.stop();
    log(a, lead, x.approved ? "approved" : x.reason, x.via);
  });
  pending.set(key, p);
  return p;
}

function sweep(now: number): void {
  for (const [k, p] of pending) {
    if (p.settled === undefined || p.settledAt === undefined) continue;
    if (now - p.settledAt > (p.settled.approved ? LIFE_MS : DENIED_MS)) pending.delete(k);
  }
  for (const [k, until] of grants) if (until <= now) grants.delete(k);
}

const CLAY = "\x1b[38;2;217;119;87m";
const PLAIN = "\x1b[39m";

function wrap(s: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (Bun.stringWidth(next) <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.flatMap((l) => {
    const out: string[] = [];
    let rest = l;
    while (Bun.stringWidth(rest) > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    return [...out, rest];
  });
}

// The popup's card in the terminal: the asker, the thing, one fact, and
// the two keys. Enter and Esc go to the popup, which still asks Touch ID
// before it answers yes; Enter waits until the popup is on screen, so it
// never answers one he cannot see on the Mac.
function prompt(ask: Ask, p: Pending, theme: Theme, keys: { matches(data: string, action: string): boolean }, redraw: () => void): Prompt {
  let checking = false;
  return {
    render(width) {
      const inner = Math.max(width - 4, 20);
      const pad = (s: string) => `  ${s}`;
      const mark = checking ? theme.fg("dim", "◌ Touch ID on your Mac") : p.isShown ? `${CLAY}●${PLAIN} ${theme.fg("dim", "omp")}` : theme.fg("dim", "◌ After the one on your Mac");
      const out = ["", pad(mark), ""];
      for (const l of wrap(ask.title, inner)) out.push(pad(theme.bold(l)));
      if (ask.detail) for (const l of wrap(ask.detail, inner).slice(0, 6)) out.push(pad(theme.fg("muted", l)));
      out.push("");
      const deny = `${theme.fg("dim", "esc")} ${ask.deny ?? "Deny"}`;
      out.push(pad(checking || !p.isShown ? deny : `${theme.fg("dim", "enter")} ${ask.approve ?? "Approve"}   ${deny}`));
      out.push("");
      return out;
    },
    handleInput(data) {
      if (keys.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
        if (checking || !p.isShown) return;
        checking = ask.auth;
        p.send("approve");
        redraw();
      } else if (keys.matches(data, "tui.select.cancel") || data === "\x1b") p.send("deny");
    },
    invalidate() {},
  };
}

// omp shows one custom card at a time and swaps a second in over the
// first, so a second request waits on the popup alone.
let carded = false;

// undefined lets the call run; a reason turns it back. ui: the lead's own
// terminal, when it has one.
export async function decide(asks: Ask[], lead: string, ui?: TerminalUi): Promise<string | undefined> {
  for (const a of asks) {
    const now = Date.now();
    sweep(now);
    const key = JSON.stringify([lead, a.kind, a.item.name, a.where ?? "", a.scope]);
    if ((grants.get(key) ?? 0) > now) continue;
    const p = pending.get(key) ?? ask(key, a, lead);
    if (ui && !carded && !p.settled && !p.prompted) {
      p.prompted = true;
      carded = true;
      try {
        await ui.custom<void>((tui, theme, keys, done) => {
          void p.answer.then(() => done());
          void p.shown.then(() => tui.requestRender());
          return prompt(a, p, theme, keys, () => tui.requestRender());
        });
      } catch {}
      carded = false;
      p.prompted = false;
    }
    const answer = p.settled ?? await Promise.race([p.answer, Bun.sleep(WAIT_MS).then(() => undefined)]);
    if (answer === undefined) return `waiting for the user's ok on his Mac${a.kind === "handoff" ? "" : " (or his phone)"}: ${a.verb}, ${a.item.name}. Make the same call again to keep waiting; it joins the same request and does not ask twice. Do other work meanwhile if you have any.`;
    if (answer.approved) {
      pending.delete(key);
      if (a.reuseMs > 0) grants.set(key, Date.now() + a.reuseMs);
      continue;
    }
    if (a.kind === "handoff" && answer.reason === "denied") return `the user chose "Not now" for this step (${a.item.name}). Do other work, or ask him in chat when he wants to take it.`;
    if (answer.reason === "timeout") return `the user did not answer in ${LIFE_MS / 60_000} min (${a.verb}: ${a.item.name}), so nothing ran. Ask him in chat before trying again.`;
    if (answer.reason === "no_popup") return `the approval popup could not start (${POPUP}), so nothing ran. Tell the user; this needs a safari-harness deploy.`;
    if (answer.reason !== "denied" && answer.reason !== "auth_failed") {
      pending.delete(key);
      return `the approval popup closed without an answer (${a.verb}: ${a.item.name}), so nothing ran. Make the same call again to ask once more.`;
    }
    return `the user denied this (${a.verb}: ${a.item.name}), so nothing ran. Do not retry it; ask him in chat if it is still needed.`;
  }
  return undefined;
}
