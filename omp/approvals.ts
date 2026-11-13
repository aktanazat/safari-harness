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
import { isAway } from "../daemon/phone.ts";
import { rpc } from "../daemon/rpc.ts";

type Kind = "secret" | "login" | "card" | "message" | "shortcut" | "handoff";
type Row = { lead: string; value: string; mono?: boolean };

export type Ask = {
  kind: Kind;
  verb: string;
  item: { name: string };
  // The literal thing approved, and what a yes does, in one plain line.
  title: string;
  line: string;
  rows: Row[];
  where?: string;
  purpose?: string;
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
// retries does not raise the popup again at once. prompted: a terminal
// prompt already shows it.
type Pending = { answer: Promise<Answer>; at: number; send(word: "approve" | "deny"): void; settled?: Answer; settledAt?: number; prompted?: boolean };

const WAIT_MS = 25_000;
const LIFE_MS = 10 * 60_000;
const DENIED_MS = 60_000;
const REUSE_MS = 10 * 60_000;
const INFO_MS = 3_000;
const PHONE_POLL_MS = 2_000;
const POPUP = new URL("../scripts/approve", import.meta.url).pathname;
const LOG = join(homedir(), "Library", "Logs", "safari-harness", "approvals.jsonl");

const pending = new Map<string, Pending>();
const grants = new Map<string, number>();

const VAR = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_SHELL = /\bmem-secret\s+(?:run|edit|keychain-restore)\b|\bsops\s+(?:-d\b|--decrypt\b|decrypt\b|exec-env\b|exec-file\b)|engram-age-identity/;

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function clip(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// What a shell command or code would do with the vault: which secrets, and
// the program they go to.
function secretAsk(code: string, cwd: string, purpose: string | undefined): Ask | undefined {
  if (!SECRET_SHELL.test(code)) return undefined;
  const run = /\bmem-secret\s+run\s+((?:\S+\s+)*?)--\s+(.+)/.exec(code);
  const names = run?.[1]?.trim().split(/\s+/).filter((w) => VAR.test(w) || w === "--all") ?? [];
  const target = run?.[2]?.split("\n")[0]?.trim();
  const program = target ? basename(target.split(/\s+/)[0] ?? "") : "";
  const every = names.includes("--all") || !run;
  const name = every ? "Every secret in the vault" : names.join(", ");
  return {
    kind: "secret",
    verb: every ? "open the vault" : "use a secret",
    item: { name },
    title: name,
    line: program ? `omp passes ${every || names.length > 1 ? "them" : "it"} to ${program}.` : "omp opens the vault for this command.",
    rows: [{ lead: "Runs", value: clip(target ?? code.trim()), mono: true }, { lead: "In", value: tilde(cwd), mono: true }],
    purpose,
    scope: program || code.trim(),
    reuseMs: every ? 0 : REUSE_MS,
    auth: true,
  };
}

// The page's host for the copy, when the daemon knows the tab; where, for
// the grant key and the log, still tells two unknown tabs apart.
async function pageOf(tab: unknown): Promise<{ host?: string; where?: string }> {
  if (tab === undefined) return {};
  try {
    const info = await Promise.race([rpc("info", { tab }), Bun.sleep(INFO_MS)]);
    const url = info && typeof info === "object" && "url" in info && typeof info.url === "string" ? info.url : undefined;
    const host = url ? new URL(url).host || url : undefined;
    if (host) return { host, where: host };
  } catch {}
  return { where: `tab ${String(tab)}` };
}

async function safariAsk(tool: string, a: Record<string, unknown>, purpose: string | undefined): Promise<Ask | undefined> {
  if (tool === "passwords") {
    const site = text(a.site);
    const user = text(a.username);
    switch (a.do) {
      case "fill": {
        const { host, where } = site ? { host: site, where: site } : await pageOf(a.tab);
        const title = host ?? "Saved password";
        return { kind: "login", verb: "fill a saved password", item: { name: title }, title, line: `omp fills your saved password${user ? ` for ${user}` : ""} into the page without seeing it.`, rows: [], where, purpose, scope: user ?? "", reuseMs: REUSE_MS, auth: true };
      }
      case "code": {
        const { host, where } = site ? { host: site, where: site } : await pageOf(a.tab);
        const title = host ?? "Sign-in code";
        return { kind: "login", verb: "fill a sign-in code", item: { name: title }, title, line: "omp fills the sign-in code from Apple Passwords without seeing it.", rows: [], where, purpose, scope: "code", reuseMs: REUSE_MS, auth: true };
      }
      case "change": {
        const { host, where } = site ? { host: site, where: site } : await pageOf(a.tab);
        const title = host ?? "Saved password";
        return { kind: "login", verb: "change a saved password", item: { name: title }, title, line: `omp replaces your saved password${user ? ` for ${user}` : ""} with a new strong one.`, rows: [], where, purpose, scope: "change", reuseMs: 0, auth: true };
      }
      case "card-fill": {
        const { host, where } = await pageOf(a.tab);
        const amount = text(a.amount);
        const card = text(a.card) ?? "Saved card";
        return { kind: "card", verb: "fill a saved card", item: { name: card }, title: card, line: `omp fills it into the checkout${host ? ` on ${host}` : ""}${amount ? ` for ${amount}` : ""}.`, rows: [], where, purpose, scope: amount ?? "", reuseMs: REUSE_MS, auth: true };
      }
      case "card-save": {
        const card = text(a.name) ?? "New card";
        return { kind: "card", verb: "save a card", item: { name: card }, title: card, line: "omp saves it to this Mac's keychain, behind Touch ID.", rows: [], purpose, scope: "save", reuseMs: 0, auth: true };
      }
      default:
        return undefined;
    }
  }
  if (tool === "type" && text(a.secret)) {
    const { host, where } = await pageOf(a.tab);
    const title = host ?? "Sign-in code";
    const from: Record<string, string> = { sms: "your texts", mail: "your email", page: "another tab", passwords: "Apple Passwords" };
    return { kind: "login", verb: "type a sign-in code", item: { name: title }, title, line: `omp types a code from ${from[String(a.secret)] ?? String(a.secret)} into the page without seeing it.`, rows: [], where, purpose, scope: String(a.secret), reuseMs: REUSE_MS, auth: true };
  }
  if (tool === "imessage_send" && a.approved !== undefined && a.approved !== false) {
    const files = Array.isArray(a.files) ? a.files.map(String) : [];
    const body = String(a.text ?? "");
    const to = String(a.to ?? "");
    const hash = createHash("sha256").update(JSON.stringify([a.to, body, files])).digest("hex");
    const rows: Row[] = [];
    if (body) rows.push({ lead: "Says", value: clip(body, 400) });
    if (files.length) rows.push({ lead: "Files", value: files.map((f) => basename(f)).join(", "), mono: true });
    return { kind: "message", verb: "send a text", item: { name: to }, title: `Text to ${to}`, line: "omp sends exactly this from your Messages.", rows, purpose, scope: hash, reuseMs: 0, auth: true, approve: "Send" };
  }
  if (tool === "handoff" && a.id === undefined) {
    const { host, where } = await pageOf(a.tab);
    const title = host ?? "Safari";
    const why = text(a.why);
    return { kind: "handoff", verb: "hand you a step", item: { name: title }, title, line: "Safari comes forward so you can do this step yourself.", rows: why ? [{ lead: "Why", value: clip(why) }] : [], where, purpose, scope: why ?? "", reuseMs: REUSE_MS, auth: false, approve: "Show me", deny: "Not now" };
  }
  return undefined;
}

// Every step of a call that needs his ok, in order. request: what the user
// last asked the lead, shown as the why.
export async function asksOf(toolName: string, input: Record<string, unknown>, cwd: string, request?: string): Promise<Ask[]> {
  const line = request?.split("\n").map((l) => l.trim()).find(Boolean);
  const purpose = line ? clip(line, 90) : undefined;
  if (toolName === "bash") {
    const ask = typeof input.command === "string" ? secretAsk(input.command, text(input.cwd) ?? cwd, purpose) : undefined;
    return ask ? [ask] : [];
  }
  if (toolName === "eval") {
    const ask = typeof input.code === "string" && /mem-secret|\bsops\s/.test(input.code) ? secretAsk(input.code, cwd, purpose) : undefined;
    return ask ? [ask] : [];
  }
  if (toolName === "mac_shortcut" && text(input.name)) {
    const name = String(input.name);
    const files = Array.isArray(input.input) ? input.input.map(String) : [];
    return [{ kind: "shortcut", verb: "run a shortcut", item: { name }, title: name, line: "omp runs this shortcut, which can act in any app.", rows: files.length ? [{ lead: "On", value: files.map(tilde).join(", "), mono: true }] : [], purpose, scope: "", reuseMs: REUSE_MS, auth: true }];
  }
  if (toolName === "mac_handoff") {
    const app = String(input.app ?? "An app");
    const recovery = input.reason === "account_recovery_required";
    return [{ kind: "handoff", verb: "hand you a step", item: { name: app }, title: app, line: "The app comes forward so you can finish this yourself.", rows: [{ lead: "Why", value: recovery ? "Account recovery only you can finish" : "A sign-in only you can finish" }], purpose, scope: String(input.reason ?? ""), reuseMs: REUSE_MS, auth: false, approve: "Show me", deny: "Not now" }];
  }
  if (toolName === "mcp__safari_run" && Array.isArray(input.steps)) {
    const asks: Ask[] = [];
    for (const step of input.steps) {
      if (!step || typeof step !== "object") continue;
      const s = step as { tool?: unknown; args?: unknown };
      const args = s.args && typeof s.args === "object" ? (s.args as Record<string, unknown>) : {};
      const ask = typeof s.tool === "string" ? await safariAsk(s.tool, args, purpose) : undefined;
      if (ask) asks.push(ask);
    }
    return asks;
  }
  if (toolName.startsWith("mcp__safari_")) {
    const ask = await safariAsk(toolName.slice("mcp__safari_".length), input, purpose);
    return ask ? [ask] : [];
  }
  return [];
}

// What every surface shows: the ask's own rows, then why and how long.
function rowsOf(ask: Ask): Row[] {
  const rows = [...ask.rows];
  if (ask.purpose) rows.push({ lead: "For", value: ask.purpose });
  if (ask.kind !== "handoff") rows.push({ lead: "Lasts", value: ask.reuseMs > 0 ? `${Math.round(ask.reuseMs / 60_000)} minutes in this session` : "This one time" });
  return rows;
}

function log(ask: Ask, lead: string, decision: string, via?: string): void {
  try {
    mkdirSync(join(homedir(), "Library", "Logs", "safari-harness"), { recursive: true });
    appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), kind: ask.kind, item: ask.item.name, where: ask.where, lead, decision, via })}\n`, { mode: 0o600 });
  } catch {}
}

function popup(ask: Ask): { answer: Promise<Answer>; send(word: "approve" | "deny"): void; stop(): void } {
  const child = spawn(POPUP, [], { stdio: ["pipe", "pipe", "ignore"] });
  const { promise, resolve } = Promise.withResolvers<Answer>();
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stdin.on("error", () => {});
  child.on("error", () => resolve({ approved: false, reason: "no_popup", via: "mac" }));
  child.on("close", () => {
    try {
      const a = JSON.parse(out) as { approved?: unknown; reason?: unknown };
      resolve({ approved: a.approved === true, reason: typeof a.reason === "string" ? a.reason : "unknown", via: "mac" });
    } catch {
      resolve({ approved: false, reason: "closed", via: "mac" });
    }
  });
  const request = { asker: "omp", title: ask.title, line: ask.line, rows: rowsOf(ask), approve: ask.approve, deny: ask.deny, auth: ask.auth, reason: `let omp ${ask.verb}: ${ask.item.name}`, timeoutMs: LIFE_MS };
  child.stdin.write(`${JSON.stringify(request)}\n`);
  return {
    answer: promise,
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
      const request = { verb: ask.verb, kind: ask.kind, item: ask.item, purpose: ask.purpose, detail: ask.line, where: ask.where, title: ask.title, line: ask.line, rows: rowsOf(ask), approve: ask.approve, deny: ask.deny };
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
  const p: Pending = { answer, at: Date.now(), send: mac.send };
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
    const keep = p.settled === undefined ? LIFE_MS + WAIT_MS : p.settled.approved ? LIFE_MS : DENIED_MS;
    if (now - (p.settledAt ?? p.at) > keep) pending.delete(k);
  }
  for (const [k, until] of grants) if (until <= now) grants.delete(k);
}

const ON_CLAY = "\x1b[48;2;217;119;87m\x1b[38;2;20;20;20m";
const PLAIN = "\x1b[0m";

function wrap(s: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (Bun.stringWidth(next) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
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

// The popup's card in the terminal: no frame, hairlines, and the same rail
// (lead column, then the value). Enter and Esc go to the popup, which
// still asks Touch ID before it answers yes.
function prompt(ask: Ask, p: Pending, theme: Theme, keys: { matches(data: string, action: string): boolean }, redraw: () => void): Prompt {
  let checking = false;
  const rows = rowsOf(ask);
  const lead = Math.max(...rows.map((r) => r.lead.length), 0) + 3;
  return {
    render(width) {
      const inner = Math.max(width - 4, 20);
      const pad = (s: string) => `  ${s}`;
      const rule = theme.fg("border", "─".repeat(Math.max(width, 1)));
      const status = checking ? `${theme.fg("dim", "◌")} Waiting for Touch ID on your Mac` : `${ON_CLAY}!${PLAIN} Needs you`;
      const gap = Math.max(inner - Bun.stringWidth(checking ? "◌ Waiting for Touch ID on your Mac" : "! Needs you") - 3, 1);
      const out = [rule, pad(`${status}${" ".repeat(gap)}${theme.fg("dim", "omp")}`), ""];
      for (const l of wrap(ask.title, inner)) out.push(pad(theme.bold(l)));
      for (const l of wrap(ask.line, inner)) out.push(pad(theme.fg("muted", l)));
      out.push("");
      for (const r of rows) {
        wrap(r.value, Math.max(inner - lead, 10)).forEach((l, i) => out.push(pad(`${theme.fg("dim", (i ? "" : r.lead).padEnd(lead))}${l}`)));
      }
      out.push("");
      const yes = ask.approve ?? "Approve";
      const deny = `esc ${theme.fg("muted", ask.deny ?? "Deny")}`;
      out.push(pad(checking ? deny : `enter ${theme.fg("muted", ask.auth ? `${yes} with Touch ID` : yes)}    ${deny}`));
      out.push(rule);
      return out;
    },
    handleInput(data) {
      if (keys.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
        if (checking) return;
        checking = ask.auth;
        p.send("approve");
        redraw();
      } else if (keys.matches(data, "tui.select.cancel") || data === "\x1b") p.send("deny");
    },
    invalidate() {},
  };
}

// undefined lets the call run; a reason turns it back. ui: the lead's own
// terminal, when it has one.
export async function decide(asks: Ask[], lead: string, ui?: TerminalUi): Promise<string | undefined> {
  for (const a of asks) {
    const now = Date.now();
    sweep(now);
    const key = JSON.stringify([lead, a.kind, a.item.name, a.where ?? "", a.scope]);
    if ((grants.get(key) ?? 0) > now) continue;
    const p = pending.get(key) ?? ask(key, a, lead);
    if (ui && !p.settled && !p.prompted) {
      p.prompted = true;
      try {
        await ui.custom<void>((tui, theme, keys, done) => {
          void p.answer.then(() => done());
          return prompt(a, p, theme, keys, () => tui.requestRender());
        });
      } catch {}
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
    return `the user denied this (${a.verb}: ${a.item.name}), so nothing ran. Do not retry it; ask him in chat if it is still needed.`;
  }
  return undefined;
}
