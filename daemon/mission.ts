// Mission control: what each agent does in Safari, and the user's hand on
// it. Agent windows open behind his (spaces.ts), so he could see neither
// what one was doing nor stop it. Each window's first tab is this file's
// live page for its agent, and /agents lists every agent at work.
//
// Every call goes through watched (main.ts /rpc): it lands in its agent's
// flight record, waits while the user has paused that agent, and fails once
// he has stopped it. A call with no agent process behind it lands under "no
// agent", and nothing holds it. The record is default-deny: an argument
// shows its value only when its name is in SHOWN, and an answer only
// whether it worked, where its tab went, and how many, so nothing the agent
// typed or read (a password, a code, page text) is kept, beyond a tab's
// title and address.
//
// The pages call back from their own origin, which main.ts's check for
// local callers refuses; admitted checks these routes instead. A control
// also needs the secret its page was served with, sent as JSON, which a
// page of another origin cannot send without asking first.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { bridge } from "./bridge.ts";
import { followTab } from "./continuity.ts";
import { onRaised } from "./front.ts";
import { removeCapture, verifyEvidence } from "./evidence.ts";
import { failureOf, HarnessError } from "./failures.ts";
import { affectsPage } from "./lanes.ts";
import { captureSummaries, MissionHistory, type CaptureSummary, type HistoryPicture } from "./mission-history.ts";
import { note } from "./journal.ts";
import { alive, currentOwner, watchOwner } from "./owner.ts";
import { closeManagedWindow, managedWindows, spaceById, spaceEnded, type ManagedWindow } from "./spaces.ts";
import { closeTabsOf, recentlyClosedTabs, resolveTab, restoreClosedTab, screenshot, tabsOpenedBy, tabsOwnedBy, TOOLS, type RecentTab, type TabInfo } from "./tools.ts";
import { localRequest } from "./requests.ts";

// What a held call answers: each tells the agent what to do next.
const PAUSED = "the user paused this task from its window; wait a minute, then call again";
const STOPPED = "the user stopped this task from its window; stop and tell the user what you had done";

// A paused agent's call waits this long for the user, then fails: well
// inside the time an agent's client waits for an answer.
const HOLD_MS = 90_000;
const KEPT = 200;
const SHOWN_CALLS = 50;
const HOUR = 60 * 60_000;

// One call as the pages show it. ms is set once it answered, with outcome
// or error; held, while it waits for the user to resume its agent.
type Call = {
  t: number;
  tool: string;
  args: string;
  tab?: number;
  held?: true;
  ms?: number;
  outcome?: string;
  error?: string;
  url?: string;
  title?: string;
  code?: string;
  evidence?: CaptureSummary[];
  picture?: HistoryPicture;
  pendingNative?: boolean;
};

type Hold = "paused" | "driving";
type Status = "working" | "waiting on the user" | "paused" | "user is driving" | "stopped" | "ended";
type View = { revision: number; stale: boolean; retries: Set<string>; native?: Map<string, Call>; all?: true };

// raised: the times it brought Safari to the front (front.ts)
type Agent = {
  id: string;
  revision: number;
  views: Map<number, View>;
  pictures: boolean;
  inspectionOnly: boolean;
  takeovers: Set<Promise<number | undefined>>;
  owner?: number;
  process?: string;
  first: number;
  last: number;
  calls: Call[];
  running: Set<Call>;
  raised: number;
  hold?: Hold;
  stopped?: number;
  ended?: number;
  waiting: Set<() => void>;
  actions: Set<AbortController>;
  unwatch?: () => void;
};

function fresh(owner?: number): Agent {
  const now = Date.now();
  return { id: randomUUID(), revision: 0, views: new Map(), pictures: false, inspectionOnly: false, takeovers: new Set(), owner, first: now, last: now, calls: [], running: new Set(), raised: 0, waiting: new Set(), actions: new Set() };
}

const agents = new Map<number, Agent>();
const nobody = fresh();
let history = new MissionHistory();
let historyError: string | undefined;
const scope = new AsyncLocalStorage<{ agent: Agent; call: Call; delegated: boolean; nested: boolean; trustedInspection: boolean }>();
const spaceAgents = new Map<string, string>();

export function openMissionHistory(path: string): void {
  try {
    history = new MissionHistory(path);
    historyError = undefined;
    for (const record of history.list()) for (const id of record.spaces) spaceAgents.set(id, record.id);
    void history.cleanup().catch(() => { historyError = "Expired pictures could not be removed."; });
  } catch {
    historyError = "History could not be opened.";
    console.error("[safari-harness] mission history could not be opened");
  }
}

function remember(agent: Agent): void {
  try {
    history.save({
      id: agent.id, owner: agent.owner ?? null, process: agent.process ?? null,
      since: agent.first, active: agent.last, raised: agent.raised, status: statusOf(agent),
      ...(agent.ended === undefined ? {} : { ended: agent.ended }),
      spaces: [...spaceAgents].filter(([, id]) => id === agent.id).map(([id]) => id),
      pictures: agent.pictures,
      ...(agent.inspectionOnly ? { inspectionOnly: true } : {}),
      calls: agent.calls.map((c) => ({
        t: c.t, tool: c.tool, tab: c.tab, ms: c.ms, code: c.code, evidence: c.evidence, picture: c.picture,
        outcome: c.pendingNative ? agent.ended === undefined ? "running" : "interrupted" : c.ms === undefined ? "running" : c.error ? "failed" : "done",
      })),
    });
    const retained = new Map(history.list(agent.id)[0]?.calls.flatMap((c) => c.picture ? [[c.picture.id, c.picture] as const] : []) ?? []);
    for (const call of agent.calls) if (call.picture) call.picture = retained.get(call.picture.id) ?? { id: call.picture.id, missing: "picture expired" };
    historyError = undefined;
    void history.cleanup().catch(() => { historyError = "Expired pictures could not be removed."; });
  } catch {
    historyError = "History could not be saved.";
    console.error("[safari-harness] mission history could not be saved");
  }
}

// The record a new call of owner goes in: a pid the system has given to
// another process since its agent ended starts a new one.
function recordOf(owner: number | undefined): Agent {
  if (owner === undefined) return nobody;
  const had = agents.get(owner);
  return had && had.ended === undefined ? had : track(owner);
}

onRaised(() => {
  const owner = currentOwner();
  const agent = owner === undefined ? nobody : agents.get(owner);
  if (agent) {
    agent.raised += 1;
    remember(agent);
  }
  note("safari to front", { owner: owner ?? null });
});

function track(owner: number): Agent {
  prune(Date.now());
  const agent = fresh(owner);
  const previous = history.list().find((record) => record.owner === owner);
  agent.inspectionOnly = previous?.interrupted === true && previous.inspectionOnly === true;
  if (!agents.has(owner)) {
    for (const id of spaceAgents.keys()) if (spaceById(id)?.owner === owner) spaceAgents.set(id, agent.id);
  }
  agents.set(owner, agent);
  agent.unwatch = watchOwner(owner, () => {
    agent.ended = Date.now();
    for (const action of agent.actions) action.abort();
    release(agent);
    remember(agent);
    agent.unwatch = undefined;
  });
  named(agent).catch((e) => console.error(`[safari-harness] no program name for agent ${owner}:`, e instanceof Error ? e.message : e));
  return agent;
}

// Its program (claude, omp, codex, node), which tells two agents apart
// better than a pid does.
async function named(agent: Agent): Promise<void> {
  const ps = Bun.spawn(["ps", "-o", "comm=", "-p", String(agent.owner)], { stdout: "pipe", stderr: "ignore" });
  const path = (await new Response(ps.stdout).text()).trim();
  if (path) agent.process = basename(path);
  remember(agent);
}

// On /agents: an agent seen within the hour, or one the user holds while
// it runs. Any other record goes.
function listed(a: Agent, now: number): boolean {
  if (a.running.size > 0) return true;
  if (a.ended === undefined && (a.hold !== undefined || a.stopped !== undefined)) return true;
  return a.calls.length > 0 && a.last >= now - HOUR;
}

function prune(now: number) {
  for (const [owner, a] of agents) {
    if (listed(a, now)) continue;
    a.unwatch?.();
    agents.delete(owner);
  }
}

function statusOf(a: Agent): Status {
  if (a.stopped !== undefined) return "stopped";
  if (a.ended !== undefined) return "ended";
  if (a.hold === "driving") return "user is driving";
  if (a.hold === "paused") return "paused";
  for (const c of a.running) if (c.tool === "handoff_wait") return "waiting on the user";
  return "working";
}

// ---------- the gate ----------

function completesNative(agent: Agent, tool: string, args: Record<string, unknown>): boolean {
  return tool === "action_finish" || tool === "input_state" && typeof args.tab === "number" && !!agent.views.get(followTab(args.tab))?.native?.size;
}

// Runs one call of owner's through the user's hold on it, and records it.
export async function watched<T>(owner: number | undefined, tool: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const parent = scope.getStore();
  if (parent) parent.nested = true;
  const agent = recordOf(owner);
  const withheld: string[] = [];
  const call: Call = { t: Date.now(), tool: cut(tool, 40), args: cut(argsOf(args, withheld), 300), ...tabOf(args.tab) };
  agent.calls.push(call);
  if (agent.calls.length > KEPT) agent.calls.splice(0, agent.calls.length - KEPT);
  agent.running.add(call);
  agent.last = call.t;
  const began = performance.now();
  let ran = false;
  const context = { agent, call, delegated: false, nested: false, trustedInspection: parent?.trustedInspection === true || tool === "video" && (args.do === undefined || args.do === "inspect") };
  remember(agent);
  try {
    return await scope.run(context, async () => {
      if (owner !== undefined && !completesNative(agent, tool, args)) await admit(agent, call);
      ran = true;
      const value = await execute(agent, tool, args, () => run(), false, () => context.delegated);
      Object.assign(call, outcomeOf(tool, value, withheld));
      const evidence = captureSummaries(value);
      if (evidence.length) call.evidence = evidence;
      return value;
    });
  } catch (e) {
    call.code = failureOf(e).code;
    call.error = cut(redact(e instanceof Error ? e.message : String(e), withheld), 300);
    throw e;
  } finally {
    call.ms = Math.round(performance.now() - began);
    agent.running.delete(call);
    agent.last = Date.now();
    remember(agent);
    // A tab a call in flight opened after the user stopped its agent is marked
    // too: it closes with the others when the agent's turn ends.
    if (ran && owner !== undefined && agent.stopped !== undefined && agents.get(owner) === agent) closeTabsOf(owner);
  }
}

export async function missionCall<T>(tool: string, args: Record<string, unknown>, run: (pinned: Record<string, unknown>) => Promise<T>): Promise<T> {
  const context = scope.getStore();
  // Only the public watched boundary creates a mission. Internal resource
  // calls may use runAs without representing another live agent task.
  if (!context) return run(args);
  if (context.call.tool !== tool || context.delegated) {
    context.nested = true;
    return watched(currentOwner(), tool, args, () => missionCall(tool, args, run));
  }
  context.delegated = true;
  if (context.agent.owner !== undefined && !completesNative(context.agent, tool, args)) await admit(context.agent, context.call);
  const needsTab = affectsPage(tool, args) || wholeView(tool, args);
  const tab = needsTab && args.tab !== undefined && args.tab !== null ? await resolveTab(args.tab) : undefined;
  const pinned = tab === undefined ? args : { ...args, tab };
  if (context.agent.owner !== undefined && !completesNative(context.agent, tool, pinned)) await admit(context.agent, context.call);
  return execute(context.agent, tool, pinned, () => run(pinned), true, () => context.nested);
}

export async function withTaskCancellation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const context = scope.getStore();
  if (!context) throw new HarnessError("unavailable", "site actions need an active harness request", { effect: "none" });
  const controller = new AbortController();
  context.agent.actions.add(controller);
  try { return await run(controller.signal); }
  finally { context.agent.actions.delete(controller); }
}
export async function admitPageObservation(tab: number, acting: boolean): Promise<{ signal: AbortSignal; check(): void; release(): void }> {
  const context = scope.getStore();
  if (!context) throw new HarnessError("unavailable", "video observation needs an active harness request", { effect: "none" });
  await admit(context.agent, context.call);
  const revision = context.agent.revision;
  const controller = new AbortController();
  const check = () => {
    if (context.agent.stopped !== undefined || context.agent.ended !== undefined) throw new HarnessError("stopped", STOPPED);
    if (context.agent.hold !== undefined) throw new HarnessError("waiting_for_human", PAUSED);
    if (context.agent.revision !== revision) throw new HarnessError("stale_view", "the task changed during video observation; leave playback as it is");
    if (!tabsOwnedBy(context.agent.owner).includes(tab)) throw new HarnessError("blocked", "video observation needs a tab opened by this task");
    checkAction(context.agent, "video", { tab, do: acting ? "frames" : "inspect" });
    controller.signal.throwIfAborted();
  };
  check();
  context.agent.actions.add(controller);
  return { signal: controller.signal, check, release: () => { context.agent.actions.delete(controller); } };
}


export async function admitSiteAction(tab: number, args: Record<string, unknown>): Promise<() => void> {
  const context = scope.getStore();
  if (!context) throw new HarnessError("unavailable", "site actions need an active harness request", { effect: "none" });
  await admit(context.agent, context.call);
  const check = () => {
    if (context.agent.stopped !== undefined || context.agent.ended !== undefined) throw new HarnessError("stopped", STOPPED);
    if (context.agent.hold !== undefined) throw new HarnessError("waiting_for_human", PAUSED);
    checkAction(context.agent, "site_actions", { ...args, tab, do: "call" });
  };
  check();
  return check;
}

export async function admitNativeAction(args: Record<string, unknown>): Promise<{ ok: true; tab: number; permit: string }> {
  return missionCall("real_input", args, async (pinned) => {
    const context = scope.getStore();
    if (!context) throw new HarnessError("unavailable", "native input needs an active request", { effect: "none" });
    const { agent, call } = context;
    const tab = tabOf(pinned.tab).tab;
    if (tab === undefined) throw new HarnessError("invalid_argument", "native input needs an exact tab");
    const permit = randomUUID();
    const view: View = agent.views.get(tab) ?? { revision: 0, stale: false, retries: new Set<string>() };
    view.revision = ++agent.revision;
    call.pendingNative = true;
    if (agent.pictures) call.picture = { id: randomUUID(), missing: "action result is unknown" };
    (view.native ??= new Map()).set(permit, call);
    agent.views.set(tab, view);
    return { ok: true, tab, permit };
  });
}

export async function finishNativeAction(tab: number, permit: string, uncertain: boolean, picture = true): Promise<void> {
  const owner = currentOwner();
  const context = scope.getStore();
  const agent = context && context.agent.owner === owner ? context.agent : owner === undefined ? nobody : agents.get(owner);
  if (!agent) throw new HarnessError("invalid_argument", "native input permit is not current");
  syncViews(agent);
  tab = followTab(tab);
  const view = agent.views.get(tab);
  const call = view?.native?.get(permit);
  if (!view || !call || !view.native?.delete(permit)) throw new HarnessError("invalid_argument", "native input permit is not current");
  call.pendingNative = false;
  if (uncertain) {
    view.revision = ++agent.revision;
    view.all = true;
    call.code = "effect_unknown";
    call.error = "native input result is unknown";
  }
  call.ms = Math.max(0, Date.now() - call.t);
  if (!view.stale && !view.all && !view.retries.size && !view.native.size) agent.views.delete(tab);
  if (picture) await pictureAfter(agent, call, tab, uncertain);
  else delete call.picture;
  remember(agent);
}

async function pictureAfter(agent: Agent, call: Call, tab: number, uncertain = false): Promise<void> {
  if (!agent.calls.includes(call)) return;
  const id = call.picture?.id ?? randomUUID();
  if (!agent.pictures) {
    if (call.picture) call.picture = { id, missing: "picture saving stopped" };
    return;
  }
  if (uncertain || agent.hold !== undefined || agent.stopped !== undefined || agent.ended !== undefined) {
    call.picture = { id, missing: uncertain ? "action result is unknown" : "task is paused or ended" };
    return;
  }
  let receipt: string | undefined;
  try {
    await history.cleanup();
    if (!agent.pictures) return;
    if (agent.hold !== undefined || agent.stopped !== undefined || agent.ended !== undefined) {
      call.picture = { id, missing: "task is paused or ended" };
      return;
    }
    const saved = await screenshot({ tab, out: history.pictureOutput(agent.id, id) });
    receipt = saved.evidence.path;
    const verified = await verifyEvidence(receipt);
    if (verified.image.byteLength > 16 * 1024 * 1024) {
      call.picture = { id, missing: "picture exceeded size limit" };
      await removeCapture(receipt);
      return;
    }
    const summary = captureSummaries(saved)[0];
    if (!summary || summary.sha256 !== verified.evidence.sha256) throw new Error("capture could not be verified");
    if (!agent.pictures || !agent.calls.includes(call)) {
      if (agent.calls.includes(call)) call.picture = { id, missing: "picture saving stopped" };
      await removeCapture(receipt);
      return;
    }
    call.picture = { id, capture: summary, receipt, bytes: verified.image.byteLength };
    remember(agent);
  } catch (e) {
    call.picture = { id, missing: failureOf(e, { effectful: false }).code === "privacy" ? "privacy guard refused capture" : "capture unavailable" };
    if (receipt) await removeCapture(receipt).catch(() => { historyError = "An unused picture could not be removed."; });
  }
}

const OBSERVATIONS: Record<string, true> = { snapshot: true, extract: true, shot: true };
const PICTURE_ACTIONS: Record<string, true> = { open: true, click: true, type: true, press: true, select: true, goto: true, history: true, upload: true, eval: true, fetch: true, scroll: true, dialog: true, window: true, autofill: true, login_fill: true, card_fill: true, passwords: true, site_actions: true, react: true };
const OUTPUT_OPTIONS: Record<string, true> = { snapshot: true, save: true, out: true, timeoutMs: true, maxBytes: true, diff: true, noWaitAfter: true, ifChanged: true };
const INSPECTION_READS = new Set("tabs info snapshot extract shot report data wait run element painted lookalikes net console browsing_history status doctor action_finish input_state audit".split(" "));

function inspectionAllowed(tool: string, args: Record<string, unknown>): boolean {
  if (INSPECTION_READS.has(tool)) return true;
  if (tool === "eval") return scope.getStore()?.trustedInspection === true && args.page !== true;
  if (tool === "dialog") return args.do === undefined || args.do === "read";
  if (tool === "react") return args.do === undefined || args.do === "status" || args.do === "inspect";
  if (tool === "video") return args.do === undefined || args.do === "inspect";
  if (tool === "pdf") return args.do === "read";
  if (tool === "recordings") return args.do === undefined || args.do === "list" || args.do === "show";
  if (tool === "memory") return args.do === undefined || args.do === "status" || args.do === "search" || args.do === "show";
  return false;
}


function syncViews(agent: Agent): void {
  for (const [old, view] of agent.views) {
    const tab = followTab(old);
    if (tab === old) continue;
    const current = agent.views.get(tab) ?? view;
    current.revision = ++agent.revision;
    current.stale ||= view.stale;
    current.all = true;
    if (current !== view && view.native) {
      current.native ??= new Map();
      for (const [permit, call] of view.native) current.native.set(permit, call);
    }
    agent.views.delete(old);
    agent.views.set(tab, current);
  }
}

function fingerprint(tool: string, args: Record<string, unknown>): string {
  const definition = TOOLS[tool];
  const effect = Object.fromEntries(Object.entries(args).filter(([key]) => !Object.hasOwn(OUTPUT_OPTIONS, key) && (!definition || Object.hasOwn(definition.params, key) || definition.unlisted && Object.hasOwn(definition.unlisted, key))));
  if (tool === "press" && effect.ref === null) delete effect.ref;
  if (effect.ref !== undefined) effect.ref = String(effect.ref);
  if (tool === "click" && effect.ref !== undefined) { delete effect.x; delete effect.y; }
  if (tool === "type") { effect.append = !!effect.append; delete effect.secret; }
  if (tool === "fetch" && typeof effect.method === "string") effect.method = effect.method.toUpperCase();
  const stable = JSON.stringify(effect, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  return createHmac("sha256", KEY).update(tool).update(stable).digest("hex");
}

function invalidate(agent: Agent, tab: number, retry?: string): void {
  tab = followTab(tab);
  const view: View = agent.views.get(tab) ?? { revision: 0, stale: false, retries: new Set<string>() };
  view.revision = ++agent.revision;
  if (retry === undefined) view.stale = true;
  else if (view.retries.size < KEPT) view.retries.add(retry);
  else view.all = true;
  agent.views.set(tab, view);
}

function wholeView(tool: string, args: Record<string, unknown>): boolean {
  return Object.hasOwn(OBSERVATIONS, tool) && args.query === undefined && args.root === undefined && args.selector === undefined && args.pick === undefined && args.ref === undefined && args.as === undefined && args.maxNodes === undefined && args.maxBytes === undefined && args.diff !== true && args.interactive !== true;
}

function observed(tool: string, args: Record<string, unknown>, value: unknown): boolean {
  if (!wholeView(tool, args) || value === null || value === undefined) return false;
  if (typeof value !== "object") return tool === "extract" && typeof value === "string";
  if ("ok" in value && value.ok === false || "isError" in value && value.isError === true || "error" in value) return false;
  if ("truncated" in value && value.truncated === true || "cut" in value && !!value.cut) return false;
  if ("unchanged" in value && value.unchanged === true) return false;
  if (tool === "snapshot" && "update" in value && value.update && typeof value.update === "object" && "kind" in value.update && value.update.kind !== "full") return false;
  if (tool === "shot") return captureSummaries(value).length > 0;
  if (tool === "snapshot") return "snapshot" in value && typeof value.snapshot === "string";
  return tool === "extract" && "text" in value && typeof value.text === "string";
}

function checkAction(agent: Agent, tool: string, args: Record<string, unknown>) {
  if (agent.inspectionOnly && !inspectionAllowed(tool, args)) throw new HarnessError("blocked", "this task may only inspect its current pages; the user must allow actions from its task controls", { next: "continue reading current pages, or wait for the user to allow actions" });
  syncViews(agent);
  const rawTab = tabOf(args.tab).tab;
  const tab = rawTab === undefined ? undefined : followTab(rawTab);
  const effectful = affectsPage(tool, args);
  const guarded = effectful && tool !== "run" && tool !== "replay";
  const key = guarded ? fingerprint(tool, args) : undefined;
  const view = tab === undefined ? undefined : agent.views.get(tab);
  if (guarded && view?.stale) throw new HarnessError("stale_view", "the user changed this tab; snapshot or read it before acting", { next: "snapshot or extract this tab, then decide what to do" });
  if (effectful && view?.native?.size) {
    throw new HarnessError("effect_unknown", "native input has not reported completion; reading the page cannot release unfinished input", { effect: "none", retryable: false, next: "wait for input to finish; if its client has exited, stop any remaining input helper and restart the agent before starting another task" });
  }
  if (effectful && key !== undefined && (view?.all || view?.retries.has(key))) {
    throw new HarnessError("effect_unknown", "that action may already have happened; snapshot or read this tab before repeating it", { effect: "none", retryable: true, next: "snapshot or extract this tab and check whether the action already happened" });
  }
  return { tab, effectful, key };
}

async function execute<T>(agent: Agent, tool: string, args: Record<string, unknown>, run: () => Promise<T>, dispatched: boolean, delegated: () => boolean = () => false): Promise<T> {
  const { tab, effectful, key } = checkAction(agent, tool, args);
  const revision = agent.revision;
  try {
    const value = await run();
    // A tab may have been replaced while this result was in flight. Move
    // its hold forward before an old observation can acknowledge it.
    syncViews(agent);
    if (!delegated() && tab !== undefined && observed(tool, args, value) && agent.hold !== "driving") {
      const pending = agent.views.get(tab);
      if (pending && pending.revision <= revision && !pending.native?.size) agent.views.delete(tab);
    }
    if (!delegated() && dispatched && effectful && tab !== undefined && key !== undefined && value && typeof value === "object" && "ok" in value && value.ok === false) {
      const failure = failureOf(value, { effectful: true });
      if (failure.effect === "possibly_effected") invalidate(agent, tab, key);
    }
    const pictureTab = tab ?? (tool === "open" && value && typeof value === "object" && "id" in value ? tabOf(value.id).tab : undefined);
    if (!delegated() && dispatched && (effectful || tool === "open") && pictureTab !== undefined && Object.hasOwn(PICTURE_ACTIONS, tool)) {
      const call = scope.getStore()?.call;
      if (call) await pictureAfter(agent, call, pictureTab, !!(value && typeof value === "object" && "ok" in value && value.ok === false && failureOf(value, { effectful: true }).effect === "possibly_effected"));
    }
    return value;
  } catch (e) {
    if (!delegated() && effectful && tab !== undefined && key !== undefined && failureOf(e, { effectful: dispatched }).effect === "possibly_effected") {
      invalidate(agent, tab, key);
      const call = scope.getStore()?.call;
      if (dispatched && call && Object.hasOwn(PICTURE_ACTIONS, tool)) await pictureAfter(agent, call, tab, true);
    }
    throw e;
  }
}

// A paused agent's call waits for the user, up to HOLD_MS; a stopped
// agent's fails. Calls already in flight when he pressed finish.
async function admit(agent: Agent, call: Call): Promise<void> {
  if (agent.stopped !== undefined || agent.ended !== undefined) throw new HarnessError("stopped", STOPPED);
  if (agent.hold === undefined) return;
  call.held = true;
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, HOLD_MS);
  agent.waiting.add(resolve);
  await promise;
  clearTimeout(timer);
  agent.waiting.delete(resolve);
  delete call.held;
  if (agent.stopped !== undefined || agent.ended !== undefined) throw new HarnessError("stopped", STOPPED);
  if (agent.hold !== undefined) throw new HarnessError("waiting_for_human", PAUSED);
}

function release(agent: Agent) {
  agent.hold = undefined;
  for (const wake of agent.waiting) wake();
  agent.waiting.clear();
}

// ---------- the record ----------

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function tabOf(tab: unknown): { tab?: number } {
  const id = typeof tab === "number" ? tab : typeof tab === "string" && /^\d+$/.test(tab) ? Number(tab) : undefined;
  return id !== undefined && Number.isSafeInteger(id) ? { tab: id } : {};
}

// Arguments that say what a call did and hold nothing the agent typed or
// read: their values show. Any other shows only its kind and size.
const SHOWN: Record<string, true> = { tab: true, ref: true, do: true, background: true, keep: true, group: true, snapshot: true, x: true, y: true, dx: true, dy: true, ms: true, selector: true, root: true, why: true, what: true, frame: true, site: true, id: true, annotate: true, fullPage: true, diff: true, maxNodes: true, maxBytes: true, method: true, front: true, page: true, append: true, width: true, height: true, away: true };

function argsOf(args: object, withheld: string[]): string {
  return Object.entries(args).map(([k, v]) => `${cut(k, 20)}=${argOf(k, v, withheld)}`).join(" ");
}

function argOf(key: string, v: unknown, withheld: string[]): string {
  if (key === "url" && typeof v === "string") return place(v, withheld);
  if (key === "key" && typeof v === "string") return keyOf(v);
  if (key === "steps" && Array.isArray(v)) return `[${v.map((s) => stepOf(s, withheld)).join("; ")}]`;
  if (!Object.hasOwn(SHOWN, key)) return kindOf(v, withheld);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(cut(v, 60)) : cut(v, 60);
  return kindOf(v, withheld);
}

function stepOf(step: unknown, withheld: string[]): string {
  if (!step || typeof step !== "object" || !("tool" in step) || typeof step.tool !== "string") return kindOf(step, withheld);
  const args = "args" in step && step.args && typeof step.args === "object" ? argsOf(step.args, withheld) : "";
  return args ? `${cut(step.tool, 40)} ${args}` : cut(step.tool, 40);
}

// A value that may hold what the agent typed or read: only its kind and
// size show, and its text is cut out of the call's error too.
function kindOf(v: unknown, withheld: string[]): string {
  collect(v, withheld);
  if (typeof v === "string") return `<${v.length} chars>`;
  if (Array.isArray(v)) return `<${v.length} items>`;
  if (v && typeof v === "object") return `<${Object.keys(v).length} fields>`;
  return `<${v === null ? "null" : typeof v}>`;
}

function collect(v: unknown, withheld: string[]) {
  if (typeof v === "string" || typeof v === "number") {
    const s = String(v);
    if (s.length >= 3) withheld.push(s);
  } else if (v && typeof v === "object") {
    for (const inner of Object.values(v)) collect(inner, withheld);
  }
}

// An address shows its site and path. Its query and fragment (a token, a
// search, an email) show only that they were there, and a scheme other
// than http only itself.
function place(url: string, withheld: string[]): string {
  const u = URL.parse(url);
  if (!u) return kindOf(url, withheld);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    collect(url, withheld);
    return `${u.protocol}…`;
  }
  const rest = u.search + u.hash;
  for (const part of [rest, u.username, u.password]) collect(part, withheld);
  return `${cut(u.origin + u.pathname, 120)}${rest ? "?…" : ""}`;
}

// A named key or a shortcut shows; a character alone, or with shift, is
// typing (press, one key at a time).
function keyOf(key: string): string {
  const parts = key.split("+");
  const combo = parts.length > 1 && parts.at(-1) !== "";
  const main = combo ? (parts.at(-1) ?? "") : key;
  const shortcut = combo && parts.slice(0, -1).some((m) => m.trim().toLowerCase() !== "shift");
  return shortcut || [...main].length > 1 ? cut(key, 30) : `<${[...main].length} char>`;
}

function redact(text: string, withheld: string[]): string {
  return [...withheld].sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join("…"), text);
}

// What an answer says, as the pages show it: whether it worked, where its
// tab went, and how many; never a value or text it read.
function outcomeOf(tool: string, value: unknown, withheld: string[]): Pick<Call, "outcome" | "tab" | "url" | "title"> {
  if (value === undefined || value === null) return { outcome: "done" };
  if (typeof value === "boolean") return { outcome: String(value) };
  if (typeof value === "string") return { outcome: `text, ${value.length} chars` };
  if (typeof value !== "object") return { outcome: typeof value };
  if (Array.isArray(value)) return { outcome: `${value.length} items` };
  const o = value as Record<string, unknown>;
  const went: object = o.navigated && typeof o.navigated === "object" ? o.navigated : o;
  return {
    outcome: cut(said(o, withheld).join(", ") || "done", 300),
    ...(tool === "open" && typeof o.id === "number" ? { tab: o.id } : {}),
    ...("url" in went && typeof went.url === "string" ? { url: place(went.url, []) } : {}),
    ...("title" in went && typeof went.title === "string" && went.title ? { title: cut(went.title, 120) } : {}),
  };
}

function said(o: Record<string, unknown>, withheld: string[]): string[] {
  const parts: string[] = [];
  if (o.ok === true) parts.push("ok");
  if (typeof o.found === "boolean") parts.push(o.found ? "found" : "not found");
  if (typeof o.done === "boolean") parts.push(o.done ? "done" : "not done");
  if (typeof o.status === "number") parts.push(`status ${o.status}`);
  if (typeof o.waitedMs === "number") parts.push(`waited ${Math.round(o.waitedMs / 1000)} s`);
  if (o.navigated) parts.push("navigated");
  const opened = o.newTab && typeof o.newTab === "object" && "id" in o.newTab ? o.newTab.id : undefined;
  if (typeof opened === "number") parts.push(`opened tab ${opened}`);
  if (o.challenge) parts.push("bot check");
  if (Array.isArray(o.steps)) parts.push(...stepsOf(o.steps, o.notRun, withheld));
  return parts;
}

// A run's steps: how many ran, the one that failed, and how many never ran.
function stepsOf(steps: unknown[], notRun: unknown, withheld: string[]): string[] {
  const parts = [`${steps.length} step${steps.length === 1 ? "" : "s"}`];
  for (const s of steps) {
    if (!s || typeof s !== "object" || !("error" in s) || typeof s.error !== "string") continue;
    const which = "tool" in s && typeof s.tool === "string" ? ` (${s.tool})` : "";
    parts.push(`step ${"step" in s ? String(s.step) : "?"}${which} failed: ${redact(s.error, withheld)}`);
  }
  if (typeof notRun === "number" && notRun > 0) parts.push(`${notRun} not run`);
  return parts;
}

// ---------- what the pages read ----------

type Summary = { id: string; owner: number | null; process: string | null; status: Status; since: number; active: number; raised: number; controls: boolean; needsObservation: number[]; pictures: boolean; inspectionOnly?: boolean; controlSecret?: string };
// /agents.json, and what safari agents prints. tabs: those the agent opened
// that are open, in its windows or not.
type WindowSummary = ManagedWindow & { closeSecret: string };
type RecentTabSummary = RecentTab & { reopenSecret: string };
export type Overview = { now: number; agents: (Summary & { last: Call | null; tasks: { id: string; name: string }[]; tabs: number | null })[]; windows: WindowSummary[] | null; recentTabs: RecentTabSummary[] };

function summaryOf(a: Agent): Summary {
  const status = statusOf(a);
  return {
    id: a.id,
    owner: a.owner ?? null,
    process: a.process ?? null,
    status,
    since: a.first,
    active: a.last,
    raised: a.raised,
    pictures: a.pictures,
    inspectionOnly: a.inspectionOnly,
    controls: a.owner !== undefined && status !== "stopped" && status !== "ended",
    needsObservation: [...a.views].filter(([, view]) => view.stale || view.all || view.native?.size || view.retries.size > 0).map(([tab]) => tab),
    ...(a.owner === undefined || status === "stopped" || status === "ended" ? {} : { controlSecret: secretOf(`agent:${a.id}`) }),
  };
}

// Safari's tabs, only while the extension is there: a page's poll must
// never start a Safari the user quit (socket in bridge.ts).
async function tabList(): Promise<TabInfo[] | undefined> {
  if (!bridge.connected) return undefined;
  return (await bridge.request("tabs.list", [], 5000).catch(() => undefined)) as TabInfo[] | undefined;
}

// An agent window's page, by its address (spaceWindow in spaces.ts).
function pageOf(url: string | undefined): { id: string; name: string } | undefined {
  const u = url === undefined ? null : URL.parse(url);
  const id = u?.pathname === "/space" ? u.searchParams.get("id") : null;
  return u && id ? { id, name: u.searchParams.get("name") ?? "agent" } : undefined;
}

type Window = { id: string; name: string; owner?: number; window: number };

// The agent windows open now, found by their pages. A copy of a page the
// user opened in a window of his own is not one.
function windowsIn(tabs: TabInfo[]): Window[] {
  return tabs.flatMap((t) => {
    const page = pageOf(t.url);
    const space = page && spaceById(page.id);
    return page && space && t.windowId === space.window ? [{ ...page, ...space }] : [];
  });
}

const inWindows = (tabs: TabInfo[], windows: Set<number>) => tabs.filter((t) => t.windowId !== undefined && windows.has(t.windowId) && !pageOf(t.url));

async function spaceState(url: URL): Promise<Response> {
  const now = Date.now();
  const id = url.searchParams.get("id") ?? "";
  const space = spaceById(id);
  if (!space) return json({ now, agent: null, tabs: null, ended: spaceEnded(id) });
  const agent = space.owner === undefined ? nobody : agents.get(space.owner);
  if (!agent) return json({ now, agent: null, tabs: null, ended: space.owner !== undefined && !alive(space.owner) });
  if (spaceAgents.has(id) && spaceAgents.get(id) !== agent.id) return json({ now, agent: null, tabs: null, ended: true });
  if (!spaceAgents.has(id)) {
    spaceAgents.set(id, agent.id);
    remember(agent);
  }
  const tabs = await tabList();
  return json({
    now,
    agent: { ...summaryOf(agent), controlSecret: secretOf(`space:${id}:${agent.id}`), calls: agent.calls.slice(-SHOWN_CALLS).reverse().map((c) => publicCall(c, agent.id)) },
    history: agent.id,
    tabs: tabs ? inWindows(tabs, new Set([space.window])).map((t) => ({ id: t.id, title: cut(t.title ?? "", 120), url: t.url ? place(t.url, []) : "", active: t.active === true })) : null,
  });
}

function publicWindow(window: ManagedWindow): WindowSummary {
  return {
    ...window,
    tabs: window.tabs.map((tab) => ({ id: tab.id, title: cut(tab.title, 120), url: tab.url ? place(tab.url, []) : "" })),
    closeSecret: secretOf(`window:${window.id}`),
  };
}

function publicRecentTab(tab: RecentTab): RecentTabSummary {
  return {
    ...tab,
    title: cut(tab.title.trim(), 120),
    url: place(tab.url, []),
    reopenSecret: `${tab.closedAt}.${tab.expiresAt}.${secretOf(`closed-tab:${tab.tab}:${tab.closedAt}:${tab.expiresAt}`)}`,
  };
}

function publicCall<T extends { picture?: HistoryPicture }>(call: T, mission: string) {
  const { picture, ...rest } = call;
  return { ...rest, ...(picture ? { picture: "missing" in picture ? picture : { id: picture.id, capture: picture.capture }, mission } : {}) };
}

async function historyRows(url: URL): Promise<Response> {
  const missions = history.list(url.searchParams.get("id") ?? undefined);
  await history.cleanup().catch(() => { historyError = "Expired pictures could not be removed."; });
  return json({ now: Date.now(), missions: missions.map((m) => ({ ...m, calls: m.calls.map((c) => publicCall(c, m.id)) })), ...(historyError ? { error: historyError } : {}) });
}

async function historyPicture(url: URL): Promise<Response> {
  const mission = url.searchParams.get("id");
  const id = url.searchParams.get("picture");
  const picture = mission ? history.list(mission)[0]?.calls.find((c) => c.picture?.id === id)?.picture : undefined;
  if (!picture || !("receipt" in picture)) return problem(404, "picture is not in retained history");
  try {
    await history.cleanup();
    const saved = await verifyEvidence(picture.receipt);
    if (saved.evidence.sha256 !== picture.capture.sha256) return problem(409, "picture could not be verified");
    return new Response(saved.image, { headers: { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'", "referrer-policy": "no-referrer" } });
  } catch {
    return problem(410, "picture is unavailable");
  }
}

async function overview(): Promise<Overview> {
  const now = Date.now();
  prune(now);
  const tabs = await tabList();
  const windows = tabs ? windowsIn(tabs) : [];
  const rows = [...agents.values(), nobody].filter((a) => listed(a, now)).map((a) => {
    const mine = windows.filter((w) => w.owner === a.owner);
    const last = a.calls.at(-1);
    return {
      ...summaryOf(a),
      last: last ? { ...last, picture: undefined } : null,
      tasks: mine.map((w) => ({ id: w.id, name: w.name })),
      // On 10-07 an agent showed 0 tabs while one it opened sat in a window
      // apart from its own.
      tabs: tabs ? tabsOpenedBy(a.owner) : null,
    };
  });
  // Agents at work first, then those stopped or ended, each newest first:
  // a row stays put while its agent works, so its buttons never move under
  // the user's pointer.
  const over = (s: Status) => s === "stopped" || s === "ended";
  return {
    now,
    agents: rows.sort((x, y) => Number(over(x.status)) - Number(over(y.status)) || y.since - x.since),
    windows: tabs === undefined ? null : (await managedWindows(tabs)).map(publicWindow),
    recentTabs: recentlyClosedTabs().map(publicRecentTab),
  };
}

const json = (v: unknown) => Response.json(v, { headers: { "cache-control": "no-store" } });

// ---------- the controls ----------

const ACTIONS = ["pause", "resume", "stop", "drive", "giveback", "pictures_on", "pictures_off", "inspect_on", "inspect_off"] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (a: unknown): a is Action => typeof a === "string" && (ACTIONS as readonly string[]).includes(a);

const KEY = randomBytes(32);
const secretOf = (scope: string) => createHmac("sha256", KEY).update(scope).digest("base64url");

function matches(given: unknown, scope: string): boolean {
  if (typeof given !== "string") return false;
  const [got, want] = [Buffer.from(given), Buffer.from(secretOf(scope))];
  return got.length === want.length && timingSafeEqual(got, want);
}

const problem = (status: number, error: string) => Response.json({ ok: false, error }, { status });

async function bodyOf(req: Request): Promise<Record<string, unknown> | undefined> {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return undefined;
  const v: unknown = await req.json().catch(() => undefined);
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

async function spaceControl(req: Request): Promise<Response> {
  const body = await bodyOf(req);
  if (!body) return problem(400, "send JSON: {id, secret, action}");
  const id = typeof body.id === "string" ? body.id : "";
  const space = spaceById(id);
  if (!space) return problem(409, "the harness restarted after this window opened, so it no longer knows its agent");
  const agent = space.owner === undefined ? nobody : agents.get(space.owner);
  if (!agent) return problem(409, space.owner !== undefined && !alive(space.owner) ? "this task has ended" : "No live task record. Wait for the agent's next call.");
  if (spaceAgents.get(id) !== agent.id) return problem(409, "this task has ended");
  if (!matches(body.secret, `space:${id}:${agent.id}`)) return problem(403, "not this window's page");
  return control(space.owner, body.action, "its window", space.window);
}

async function agentsControl(req: Request): Promise<Response> {
  const body = await bodyOf(req);
  if (!body) return problem(400, "send JSON: {owner, secret, action}");
  const owner = typeof body.owner === "number" && agents.has(body.owner) ? body.owner : undefined;
  if (owner === undefined) return problem(404, "no such agent");
  const agent = agents.get(owner)!;
  const legacy = typeof body.secret === "string" ? agentPages.get(body.secret) : undefined;
  if (!matches(body.secret, `agent:${agent.id}`) && legacy?.get(owner) !== agent.id) return problem(403, "reload the agents page");
  if (body.mission !== undefined && body.mission !== agents.get(owner)?.id) return problem(409, "this task has ended");
  return control(owner, body.action, "the agents page");
}

async function windowClose(req: Request): Promise<Response> {
  const body = await bodyOf(req);
  if (!body) return problem(400, "send JSON: {id, secret}");
  const id = typeof body.id === "string" ? body.id : "";
  if (!(await managedWindows()).some((window) => window.id === id)) return problem(409, "this window is no longer registered; reload the agents page");
  if (!matches(body.secret, `window:${id}`)) return problem(403, "reload the agents page");
  try {
    return json(await closeManagedWindow(id));
  } catch {
    return problem(409, "this window could not be closed; reload the agents page");
  }
}

async function tabReopen(req: Request): Promise<Response> {
  const body = await bodyOf(req);
  if (!body || Object.keys(body).some((key) => key !== "tab" && key !== "secret") || typeof body.tab !== "number" || !Number.isSafeInteger(body.tab) || body.tab <= 0) return problem(400, "send JSON: {tab, secret}");
  const token = typeof body.secret === "string" ? /^(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(body.secret) : null;
  const closedAt = Number(token?.[1]);
  const expiresAt = Number(token?.[2]);
  const signed = token !== null && Number.isSafeInteger(closedAt) && Number.isSafeInteger(expiresAt) && matches(token[3], `closed-tab:${body.tab}:${closedAt}:${expiresAt}`);
  const closed = recentlyClosedTabs().find((tab) => tab.tab === body.tab);
  if (!closed) return signed && expiresAt <= Date.now() ? problem(410, "This page's five-minute recovery period has ended.") : problem(404, "This page is no longer available to reopen.");
  if (!signed || closedAt !== closed.closedAt || expiresAt !== closed.expiresAt) return problem(403, "Reload the agents page before reopening this page.");
  if (expiresAt <= Date.now()) return problem(410, "This page's five-minute recovery period has ended.");
  try {
    const tab = await restoreClosedTab(body.tab);
    return json({ ok: true, tab: tab.id });
  } catch (error) {
    if (error instanceof HarnessError && error.code === "stale_view") return problem(409, error.message);
    return expiresAt <= Date.now() ? problem(410, "This page's five-minute recovery period has ended.") : problem(503, "Safari could not reopen this page. Try again.");
  }
}

async function control(owner: number | undefined, action: unknown, from: string, window?: number): Promise<Response> {
  if (!isAction(action)) return problem(400, `action is one of ${ACTIONS.join(", ")}`);
  if (owner === undefined) return problem(409, "calls with no agent behind them cannot be paused or stopped");
  const agent = agents.get(owner);
  if (!agent || agent.ended !== undefined) return problem(409, "this agent has ended");
  if (agent.stopped !== undefined) return problem(409, "this agent is stopped");
  switch (action) {
    case "inspect_on":
    case "inspect_off":
      agent.inspectionOnly = action === "inspect_on";
      agent.revision++;
      if (agent.inspectionOnly) for (const action of agent.actions) action.abort();
      note(agent.inspectionOnly ? "task inspect-only" : "task actions allowed", { owner, from });
      break;
    case "pictures_on":
    case "pictures_off":
      agent.pictures = action === "pictures_on";
      break;
    case "pause":
      agent.hold = "paused";
      note("agent paused", { owner, from });
      break;
    case "drive": {
      agent.hold = "driving";
      const taking = raise(agent, window);
      agent.takeovers.add(taking);
      try {
        const tab = await taking;
        remember(agent);
        note("user drives", { owner, from, ...(tab === undefined ? {} : { tab }) });
        return Response.json({ ok: true, status: statusOf(agent), tab: tab ?? null });
      } finally {
        agent.takeovers.delete(taking);
      }
    }
    case "resume":
    case "giveback": {
      while (agent.takeovers.size) await Promise.allSettled(agent.takeovers);
      const was = agent.hold;
      if (was === undefined) break;
      for (const [tab, view] of agent.views) if (view.stale) invalidate(agent, tab);
      if (was === "driving") for (const tab of tabsOwnedBy(agent.owner)) if (!agent.views.get(tab)?.stale) invalidate(agent, tab);
      release(agent);
      note(was === "driving" ? "user gave back" : "agent resumed", { owner, from });
      break;
    }
    case "stop":
      agent.stopped = Date.now();
      for (const action of agent.actions) action.abort();
      release(agent);
      closeTabsOf(owner);
      note("agent stopped", { owner, from });
      break;
  }
  remember(agent);
  if (action === "inspect_on" && historyError) return problem(503, "Inspect-only is active, but its setting could not be saved.");
  return Response.json({ ok: true, status: statusOf(agent) });
}

// The tab the user takes over: the one the agent used last among the tabs
// of its windows (or of the window whose page he pressed), else the last
// one there. Safari brings it to the front of its window.
async function raise(agent: Agent, window: number | undefined): Promise<number | undefined> {
  const tabs = await tabList();
  if (!tabs || agent.stopped !== undefined || agent.ended !== undefined) return undefined;
  const windows = new Set(window === undefined ? windowsIn(tabs).filter((w) => w.owner === agent.owner).map((w) => w.window) : [window]);
  const mine = inWindows(tabs, windows);
  const tab = agent.calls.findLast((c) => c.tab !== undefined && mine.some((t) => t.id === c.tab))?.tab ?? mine.at(-1)?.id;
  if (tab === undefined) return undefined;
  for (const affected of mine) invalidate(agent, affected.id);
  for (const owned of tabsOwnedBy(agent.owner)) if (!agent.views.get(owned)?.stale) invalidate(agent, owned);
  try {
    await bridge.request("tabs.activate", [tab], 10_000);
    return tab;
  } catch (e) {
    console.error(`[safari-harness] could not show tab ${tab} for the user to drive:`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

// ---------- the pages ----------

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: oklch(98.5% 0.004 90);
  --text: oklch(23% 0.01 90);
  --muted: oklch(45% 0.012 90);
  --line: oklch(89% 0.008 90);
  --hover: oklch(95% 0.006 90);
  --hold: oklch(45% 0.11 240);
  --go: oklch(45% 0.1 150);
  --ask: oklch(49% 0.11 65);
  --stop: oklch(50% 0.17 27);
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(19% 0.006 90);
    --text: oklch(94% 0.006 90);
    --muted: oklch(73% 0.01 90);
    --line: oklch(31% 0.008 90);
    --hover: oklch(25% 0.008 90);
    --hold: oklch(79% 0.09 240);
    --go: oklch(79% 0.11 150);
    --ask: oklch(83% 0.11 75);
    --stop: oklch(73% 0.15 27);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { max-width: 58rem; padding: 2.5rem clamp(1rem, 4vw, 2.5rem) 4rem; }
h1 { margin: 0; font-size: 1.7rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.015em; text-wrap: balance; overflow-wrap: anywhere; }
h2 { margin: 2.5rem 0 0.4rem; color: var(--muted); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; }
p { margin: 0; }
header p { margin-top: 0.3rem; color: var(--muted); text-wrap: pretty; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.5rem; margin-top: 1.75rem; }
.status { font-size: 1.1rem; font-weight: 650; }
.go { color: var(--go); }
.ask { color: var(--ask); }
.hold { color: var(--hold); }
.end { color: var(--muted); }
.controls { display: flex; flex-wrap: wrap; gap: 0.5rem; }
button { min-height: 2.1rem; padding: 0.3rem 0.95rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--text); font: inherit; font-size: 0.9rem; font-weight: 550; cursor: pointer; transition: background-color 0.15s ease-out, border-color 0.15s ease-out, color 0.15s ease-out; }
button:hover { background: var(--hover); border-color: var(--muted); }
button:active { background: var(--line); }
button:focus-visible, a:focus-visible { outline: 2px solid var(--hold); outline-offset: 2px; }
button:disabled, button[aria-disabled="true"] { opacity: 0.55; cursor: default; }
button.primary { background: var(--text); border-color: var(--text); color: var(--bg); }
button.primary:hover { background: var(--muted); border-color: var(--muted); }
button.stop:hover, button.stop[data-armed="1"] { border-color: var(--stop); color: var(--stop); }
@media (pointer: coarse) { button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
.note { min-height: 1.5em; margin-top: 0.75rem; color: var(--muted); }
ul, ol { margin: 0; padding: 0; list-style: none; }
.rows > li { padding: 0.6rem 0; border-top: 1px solid var(--line); }
.rows > li:last-child { border-bottom: 1px solid var(--line); }
.tab { display: grid; }
.tab .title { overflow: hidden; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.url, .where { color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
.recent > li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; }
.recent .tab { flex: 1; min-width: min(14rem, 100%); }
.call { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) auto; gap: 0.15rem 1rem; align-items: baseline; }
.when, .took { color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
.when { grid-row: 1; grid-column: 1; }
.took { grid-row: 1; grid-column: 3; }
.what, .out, .where { grid-column: 2; }
.what { font-family: var(--mono); font-size: 0.82rem; overflow-wrap: anywhere; }
.tool { font-weight: 700; }
.args { color: var(--muted); }
.failed .out { color: var(--stop); }
.running .out, .held .out { color: var(--ask); }
.empty { color: var(--muted); }
.foot { margin-top: 2.5rem; color: var(--muted); font-size: 0.85rem; }
.agents > li { padding: 1.25rem 0; border-top: 1px solid var(--line); }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 1rem; }
.agents h2, .windows h3 { margin: 0; color: var(--text); font-size: 1.05rem; font-weight: 650; letter-spacing: 0; text-transform: none; overflow-wrap: anywhere; }
.facts, .tasks, .last { margin-top: 0.3rem; }
.facts { color: var(--muted); }
.last { color: var(--muted); font-family: var(--mono); font-size: 0.82rem; overflow-wrap: anywhere; }
.agents .controls { margin-top: 0.8rem; }
[hidden] { display: none !important; }
a { color: var(--hold); text-underline-offset: 0.15em; }
header p a, .tasks a, .windows h3 a, .foot a { display: inline-flex; min-height: 44px; min-width: 44px; align-items: center; }
.picture { grid-column: 2; margin: 0.4rem 0; min-width: 0; }
.picture img { display: block; max-width: 100%; max-height: 32rem; height: auto; object-fit: contain; border: 1px solid var(--line); }
.picture figcaption { color: var(--muted); font-size: 0.85rem; }
`;

// Static, so the page's CSP names it by hash; what it shows comes from the
// JSON routes and goes in as text, never as markup.
const SCRIPT = String.raw`
"use strict";
{
  const data = document.body.dataset;
  const overview = data.kind === "agents";
  const windowsLink = document.querySelector("[data-windows]");
  windowsLink?.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const opened = window.open(windowsLink.href, "safari-window-manager", "popup");
    if (opened) { opened.opener = null; event.preventDefault(); }
  });
  const byId = (id) => document.getElementById(id);
  const LABEL = { pause: "Pause", resume: "Resume", drive: "Let me drive", giveback: "Give back", stop: "Stop", pictures_on: "Save action pictures", pictures_off: "Stop saving pictures", inspect_on: "Inspect only", inspect_off: "Allow actions" };
  const SAY = { working: "Working", "waiting on the user": "Waiting on you", paused: "Paused", "user is driving": "You are driving", stopped: "Stopped", ended: "Ended" };
  const TONE = { working: "go", "waiting on the user": "ask", paused: "hold", "user is driving": "hold", stopped: "end", ended: "end" };
  const DONE = {
    pause: () => "Paused.",
    resume: () => "Resumed.",
    drive: (out) => out.tab === null ? "Paused. No tab is open." : "You are driving.",
    giveback: () => "Given back. It checks the tab before acting.",
    stop: () => "Stopped.",
    pictures_on: () => "Saving action pictures.",
    pictures_off: () => "Not saving new pictures.",
    inspect_on: () => "Inspect-only mode.",
    inspect_off: () => "Actions allowed.",
  };
  const ARMING = "Press again to stop.";
  let timer = 0;
  let loading = false;
  let again = false;
  let offline = false;
  let armed = "";
  let arming = 0;

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function say(text) {
    setText(byId("note"), text);
  }

  function span(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return "under a minute";
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  function clock(t) {
    return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function who(a) {
    if (data.kind === "history") return a.owner === null ? "No agent" : "Agent " + a.owner;
    if (a.owner === null) return "Calls with no agent behind them";
    return "Agent " + a.owner + (a.process ? " (" + a.process + ")" : "");
  }

  function raised(a) {
    return a.raised === 0 ? "" : "brought Safari to the front " + a.raised + (a.raised === 1 ? " time" : " times");
  }

  function actionsOf(a) {
    if (!a.controls) return [];
    const pictures = a.pictures ? "pictures_off" : "pictures_on";
    const inspection = a.inspectionOnly ? "inspect_off" : "inspect_on";
    if (a.status === "paused") return ["resume", "drive", "stop", pictures, inspection];
    if (a.status === "user is driving") return ["giveback", "stop", pictures, inspection];
    return ["pause", "drive", "stop", pictures, inspection];
  }

  function buttons(a, target, prefix) {
    return actionsOf(a).map((action) => {
      const key = prefix + action;
      const primary = action === "pause" || action === "resume" || action === "giveback";
      const b = make("button", primary ? "primary" : action === "stop" ? "stop" : "", LABEL[action]);
      b.type = "button";
      b.dataset.key = key;
      if (action === "stop" && armed === key) {
        b.dataset.armed = "1";
        b.textContent = "Stop for good?";
      }
      b.addEventListener("click", () => press(b, key, target, action));
      return b;
    });
  }

  // Puts an armed Stop back to asking once, in place: a redraw under the
  // second press would lose it.
  function unarm() {
    const b = armed ? document.querySelector('[data-key="' + CSS.escape(armed) + '"]') : null;
    armed = "";
    if (!(b instanceof HTMLElement)) return;
    delete b.dataset.armed;
    b.textContent = LABEL.stop;
  }

  // Stop takes a second press within 4 s: it cannot be taken back.
  function press(button, key, target, action) {
    if (action === "stop" && armed !== key) {
      unarm();
      armed = key;
      const n = ++arming;
      button.dataset.armed = "1";
      button.textContent = "Stop for good?";
      say(ARMING);
      setTimeout(() => {
        if (arming !== n || armed !== key) return;
        unarm();
        if (byId("note").textContent === ARMING) say("");
      }, 4000);
      return;
    }
    unarm();
    send(button, target, action);
  }

  async function send(button, target, action) {
    button.disabled = true;
    try {
      const res = await fetch(overview ? "/agents/control" : "/space/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ secret: data.secret, action: action }, target)),
      });
      const out = await res.json().catch(() => ({}));
      say(res.ok ? DONE[action](out) : out.error || "The harness refused that.");
    } catch {
      say("The harness is not answering.");
    }
    button.disabled = false;
    poll();
  }

  async function closeWindow(button, window) {
    if (!confirm(window.ended ? "Close this window and all its tabs, including kept pages?" : "Close this working window and all its tabs, including kept pages? The task will keep running.")) return;
    button.disabled = true;
    try {
      const res = await fetch("/agents/windows/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: window.id, secret: window.closeSecret }),
      });
      const out = await res.json().catch(() => ({}));
      say(!res.ok ? out.error || "The harness refused that." : out.ok ? "Window closed." : "The window still has open tabs. Review it before closing again.");
    } catch {
      say("The harness is not answering.");
    }
    button.disabled = false;
    poll();
  }

  async function reopenTab(row) {
    if (row.busy || row.reopened) return;
    row.busy = true;
    row.button.setAttribute("aria-disabled", "true");
    setText(row.button, "Reopening…");
    row.button.setAttribute("aria-label", "Reopening " + (row.current.title || row.current.url));
    try {
      const res = await fetch("/agents/tabs/reopen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tab: row.current.tab, secret: row.current.reopenSecret }),
      });
      const out = await res.json().catch(() => ({}));
      row.reopened = res.ok && out.ok === true;
      if (!row.reopened) say(out.error || "Safari could not reopen this page. Try again.");
    } catch {
      say("The harness is not answering.");
    }
    row.busy = false;
    row.button.setAttribute("aria-disabled", String(row.reopened));
    setText(row.button, row.reopened ? "Reopened" : "Reopen");
    row.button.setAttribute("aria-label", (row.reopened ? "Reopened " : "Reopen ") + (row.current.title || row.current.url));
    poll();
  }

  function tabRow(t) {
    const li = make("li", "tab");
    li.append(make("span", "title", t.title || "Untitled"), make("span", "url", t.url));
    return li;
  }

  function callRow(c) {
    const state = c.held ? "held" : c.pendingNative || c.ms === undefined ? "running" : c.error ? "failed" : "done";
    const li = make("li", "call " + state);
    const when = make("time", "when", clock(c.t));
    when.dateTime = new Date(c.t).toISOString();
    const what = make("div", "what");
    what.append(make("span", "tool", c.tool), " ", make("span", "args", c.args));
    const result = c.held ? "Waiting for you to resume it" : c.pendingNative || c.ms === undefined ? "Running" : c.error || c.outcome || "done";
    li.append(when, what, make("div", "out", result));
    if (c.title || c.url) li.append(make("div", "where", [c.title, c.url].filter(Boolean).join(" · ")));
    if (c.ms !== undefined) li.append(make("span", "took", c.ms < 1000 ? c.ms + " ms" : (c.ms / 1000).toFixed(1) + " s"));
    if (c.evidence) for (const e of c.evidence) li.append(make("div", "where", "Saved capture · " + e.width + " × " + e.height + (e.url ? " · " + e.url : "") + " · " + e.sha256.slice(0, 12)));
    if (c.picture) {
      const figure = make("figure", "picture");
      if (c.picture.missing) figure.append(make("figcaption", "", "No picture · " + c.picture.missing));
      else {
        const image = make("img");
        image.alt = "After " + c.tool;
        image.loading = "lazy";
        image.width = c.picture.capture.width;
        image.height = c.picture.capture.height;
        image.src = "/agents/picture?id=" + encodeURIComponent(c.mission) + "&picture=" + encodeURIComponent(c.picture.id);
        image.addEventListener("error", () => figure.replaceChildren(make("figcaption", "", "Picture unavailable.")));
        figure.append(image, make("figcaption", "", new Date(c.picture.capture.capturedAt).toLocaleString()));
      }
      li.append(figure);
    }
    return li;
  }

  // What each part of the page last showed: a poll redraws a part only when
  // that changed, so a press that spans a poll lands on the button it began
  // on, and a selection in the record survives.
  const drawn = new WeakMap();
  function draw(el, sig, children) {
    if (drawn.get(el) === sig) return;
    drawn.set(el, sig);
    el.replaceChildren(...children());
  }

  function renderSpace(s) {
    const status = byId("status");
    const a = s.agent;
    if (!a) {
      status.className = "status end";
      setText(status, s.ended ? "Ended" : "Not tracked");
      setText(byId("who"), s.ended ? "This task has ended." : "No live task record.");
      draw(byId("controls"), "", () => []);
      setText(byId("picture-note"), "");
      const gone = s.ended ? "Not shown once the task has ended." : "Unknown.";
      draw(byId("tabs"), gone, () => [make("li", "empty", gone)]);
      draw(byId("calls"), gone, () => [make("li", "empty", gone)]);
      return;
    }
    status.className = "status " + (TONE[a.status] || "go");
    setText(status, SAY[a.status] || a.status);
    const over = a.status === "stopped" || a.status === "ended";
    setText(byId("who"), (a.inspectionOnly ? "Inspect only · " : "") + (a.owner === null ? who(a) + ": nothing can pause them." : who(a) + (over ? ", worked for " + span(a.active - a.since) : ", at work for " + span(s.now - a.since)) + (raised(a) ? ", " + raised(a) : "")));
    draw(byId("controls"), a.id + "|" + actionsOf(a).join(), () => buttons(a, { id: data.id, secret: a.controlSecret }, ""));
    setText(byId("picture-note"), a.controls ? "Pictures save locally and may briefly select the tab." : "");
    draw(byId("tabs"), JSON.stringify(s.tabs), () => (!s.tabs ? [make("li", "empty", "Safari is not connected.")] : s.tabs.length ? s.tabs.map(tabRow) : [make("li", "empty", "None besides this page.")]));
    draw(byId("calls"), JSON.stringify(a.calls), () => (a.calls.length ? a.calls.map(callRow) : [make("li", "empty", "No calls yet.")]));
  }

  // One row per agent, kept across polls with its parts changed in place,
  // so its links and buttons stay put while it works.
  const rows = new Map();
  const none = make("li", "empty", "No agent has used Safari in the last hour.");

  function agentRow(a, now) {
    const key = a.id || String(a.owner);
    let row = rows.get(key);
    if (!row) {
      row = { li: make("li", "agent"), head: make("div", "head"), facts: make("p", "facts"), tasks: make("p", "tasks"), last: make("p", "last"), controls: make("div", "controls"), pictureNote: make("p", "where") };
      row.controls.setAttribute("role", "group");
      row.controls.setAttribute("aria-labelledby", "agent-" + key);
      row.li.append(row.head, row.facts, row.tasks, row.last, row.controls, row.pictureNote);
      rows.set(key, row);
    }
    draw(row.head, who(a) + "|" + a.status, () => {
      const heading = make("h2", "", who(a));
      heading.id = "agent-" + key;
      return [heading, make("span", "status " + (TONE[a.status] || "go"), SAY[a.status] || a.status)];
    });
    setText(row.facts, (a.inspectionOnly ? "Inspect only · " : "") + (a.tabs === null ? "" : a.tabs + (a.tabs === 1 ? " tab · " : " tabs · ")) + (raised(a) ? raised(a) + " · " : "") + "last seen " + span(now - a.active) + " ago");
    row.tasks.hidden = !a.tasks.length;
    draw(row.tasks, JSON.stringify(a.tasks), () => a.tasks.flatMap((t, i) => {
      const link = make("a", "", t.name);
      link.href = "/space?id=" + encodeURIComponent(t.id) + "&name=" + encodeURIComponent(t.name);
      return i ? [", ", link] : [link];
    }));
    const c = a.last;
    row.last.hidden = !c;
    setText(row.last, c ? clock(c.t) + "  " + c.tool + " " + c.args + "  " + (c.held ? "waiting for you" : c.ms === undefined ? "running" : c.error || c.outcome || "done") : "");
    row.controls.hidden = !a.controls;
    draw(row.controls, a.id + "|" + actionsOf(a).join(), () => buttons(a, { owner: a.owner, mission: a.id, secret: a.controlSecret }, key + ":"));
    setText(row.pictureNote, a.controls ? "Pictures save locally and may briefly select the tab." : "");
    return row.li;
  }

  const windowRows = new Map();
  const noWindows = make("li", "empty", "No registered windows are open.");

  function windowRow(window) {
    let row = windowRows.get(window.id);
    if (!row) {
      const heading = make("h3");
      const link = make("a");
      heading.append(link);
      const button = make("button", "stop", "Close window");
      button.type = "button";
      button.dataset.key = "window:" + window.id + ":close";
      const controls = make("div", "controls");
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-labelledby", "window-" + window.id);
      heading.id = "window-" + window.id;
      controls.append(button);
      row = { li: make("li"), link, status: make("span"), facts: make("p", "facts"), titles: make("p", "facts"), current: window };
      const head = make("div", "head");
      head.append(heading, row.status);
      row.li.append(head, row.facts, row.titles, controls);
      button.addEventListener("click", () => closeWindow(button, row.current));
      windowRows.set(window.id, row);
    }
    row.current = window;
    const name = window.name.replace(/\s*\(agent \d+\)(?=, window \d+$|$)/, "").replace(/^agent \d+(?=, window \d+$|$)/, "Agent window");
    const title = window.tabs[0]?.title || name;
    setText(row.link, title);
    row.link.href = "/space?id=" + encodeURIComponent(window.id) + "&name=" + encodeURIComponent(window.name);
    row.status.className = "status " + (window.ended ? "end" : "go");
    setText(row.status, window.ended ? "Finished" : "Working");
    setText(row.facts, (title === name ? "" : name + " · ") + window.tabs.length + (window.tabs.length === 1 ? " tab" : " tabs"));
    setText(row.titles, window.tabs.slice(1).map((tab) => tab.title || tab.url || "Untitled").join(" · "));
    row.titles.hidden = window.tabs.length < 2;
    return row.li;
  }

  function renderWindows(windows) {
    const list = byId("windows");
    if (windows === null) {
      list.replaceChildren(make("li", "empty", "Safari's windows are unavailable. Try again."));
      return;
    }
    const shown = new Set(windows.map((window) => window.id));
    for (const key of windowRows.keys()) if (!shown.has(key)) windowRows.delete(key);
    const next = windows.length ? windows.map(windowRow) : [noWindows];
    if (next.length !== list.children.length || next.some((li, i) => list.children[i] !== li)) list.replaceChildren(...next);
  }

  const recentRows = new Map();
  const noRecentTabs = make("li", "empty", "No recently closed pages.");

  function recentTabRow(tab, now) {
    let row = recentRows.get(tab.tab);
    if (!row) {
      const button = make("button", "", "Reopen");
      button.type = "button";
      button.dataset.key = "closed-tab:" + tab.tab + ":reopen";
      const title = make("span", "title");
      const left = make("span", "url");
      const page = make("div", "tab");
      page.append(title, left);
      row = { li: make("li"), title, left, button, current: tab, busy: false, reopened: false };
      row.li.append(page, button);
      button.addEventListener("click", () => reopenTab(row));
      recentRows.set(tab.tab, row);
    }
    row.current = tab;
    const title = tab.title || tab.url;
    setText(row.title, title);
    row.button.setAttribute("aria-label", (row.reopened ? "Reopened " : "Reopen ") + title);
    const seconds = Math.max(1, Math.ceil((tab.expiresAt - now) / 1000));
    setText(row.left, Math.floor(seconds / 60) + " min " + (seconds % 60) + " s left");
    return row.li;
  }

  function renderRecentTabs(tabs, now) {
    const list = byId("recent-tabs");
    const focused = document.activeElement;
    const focusIndex = Array.from(list.children).findIndex((li) => li.contains(focused));
    const shown = new Set(tabs.map((tab) => tab.tab));
    for (const key of recentRows.keys()) if (!shown.has(key)) recentRows.delete(key);
    const next = tabs.length ? tabs.map((tab) => recentTabRow(tab, now)) : [noRecentTabs];
    if (next.length === list.children.length && next.every((li, i) => list.children[i] === li)) return;
    list.replaceChildren(...next);
    if (focusIndex < 0) return;
    const back = list.contains(focused) ? focused : next[Math.min(focusIndex, next.length - 1)].querySelector("button") || byId("recent-title");
    back.focus();
  }

  function renderAgents(o) {
    renderWindows(o.windows);
    renderRecentTabs(o.recentTabs, o.now);
    const list = byId("agents");
    const shown = new Set(o.agents.map((a) => a.id || String(a.owner)));
    for (const key of rows.keys()) if (!shown.has(key)) rows.delete(key);
    const next = o.agents.length ? o.agents.map((a) => agentRow(a, o.now)) : [none];
    // Moves rows only when the list itself changed.
    if (next.length !== list.children.length || next.some((li, i) => list.children[i] !== li)) list.replaceChildren(...next);
  }

  function renderHistory(o) {
    const list = byId("history");
    draw(list, JSON.stringify(o.missions) + (o.error || ""), () => {
      if (o.error) return [make("li", "empty", o.error)];
      if (!o.missions.length) return [make("li", "empty", "No history yet.")];
      return o.missions.map((a) => {
        const li = make("li");
        const title = make("h2", "", who(a));
        const state = a.interrupted ? "Ended after restart" : SAY[a.status] || a.status;
        li.append(title, make("p", "facts", new Date(a.since).toLocaleString() + " · " + state));
        const calls = make("ol", "rows");
        calls.append(...a.calls.toReversed().map((c) => callRow(Object.assign({}, c, { ms: c.ms === undefined ? 0 : c.ms, error: c.outcome === "failed" ? c.code || "Failed" : undefined, outcome: c.outcome === "interrupted" ? "Interrupted" : c.outcome === "running" ? "Running" : c.outcome }))));
        li.append(calls);
        return li;
      });
    });
  }

  // Polls only while the page shows: a window behind his asks nothing.
  async function poll() {
    clearTimeout(timer);
    if (document.visibilityState !== "visible") return;
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const res = await fetch(data.kind === "history" ? "/agents/history.json" + (data.id ? "?id=" + encodeURIComponent(data.id) : "") : overview ? "/agents.json" : "/space/state?id=" + encodeURIComponent(data.id || ""), { cache: "no-store" });
      if (!res.ok) throw new Error("status " + res.status);
      const state = await res.json();
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined;
      if (data.kind === "history") renderHistory(state);
      else if (overview) renderAgents(state);
      else renderSpace(state);
      const back = focused ? document.querySelector('[data-key="' + CSS.escape(focused) + '"]') : null;
      if (back) back.focus();
      if (offline) say("");
      offline = false;
    } catch {
      offline = true;
      say("The harness is not answering. This page tries again every few seconds.");
    }
    loading = false;
    if (document.visibilityState !== "visible") return;
    timer = setTimeout(poll, again ? 0 : 2000);
    again = false;
  }

  document.addEventListener("visibilitychange", poll);
  poll();
}
`;

const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; script-src ${hash(SCRIPT)}; style-src ${hash(STYLE)}; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

// title and attrs arrive escaped.
function page(title: string, attrs: string, body: string): Response {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${STYLE}</style></head><body ${attrs}><main>${body}</main><script>${SCRIPT}</script></body></html>`;
  return new Response(doc, { headers: HEADERS });
}

// The page an agent window opens on, titled with its assignment's name,
// which labels the window for the user (and adopt in background.js finds).
function spacePage(url: URL): Response {
  const id = url.searchParams.get("id") ?? "";
  const name = html(url.searchParams.get("name") ?? "agent");
  const space = spaceById(id);
  const agent = space?.owner === undefined ? space ? nobody : undefined : agents.get(space.owner);
  if (agent && !spaceAgents.has(id)) {
    spaceAgents.set(id, agent.id);
    remember(agent);
  }
  const secret = agent && spaceAgents.get(id) === agent.id ? secretOf(`space:${id}:${agent.id}`) : "";
  return page(name, `data-kind="space" data-id="${html(id)}" data-secret="${secret}"`, [
    `<header><h1 id="task-name">${name}</h1><p id="who"></p></header>`,
    `<div class="bar"><p id="status" class="status" aria-live="polite">Loading</p><div id="controls" class="controls" role="group" aria-labelledby="task-name"></div></div>`,
    `<p id="picture-note" class="where"></p>`,
    `<p id="note" class="note" aria-live="polite"></p>`,
    `<h2>Tabs in this window</h2><ul id="tabs" class="rows"></ul>`,
    `<h2>What it did</h2><ol id="calls" class="rows"></ol>`,
    `<p class="foot"><a href="/agents#windows" target="_blank" rel="noopener" data-windows>Windows</a> · <a href="/agents/history${spaceAgents.has(id) ? `?id=${spaceAgents.get(id)}` : ""}">History</a></p>`,
  ].join(""));
}

const agentPages = new Map<string, Map<number, string>>();

function agentsPage(): Response {
  const secret = secretOf(`agents:${randomUUID()}`);
  agentPages.set(secret, new Map([...agents].map(([owner, agent]) => [owner, agent.id])));
  if (agentPages.size > 32) agentPages.delete(agentPages.keys().next().value!);
  return page("Agents in Safari", `data-kind="agents" data-secret="${secret}"`, [
    `<header><h1>Agents in Safari</h1><p><a href="/memory">Memory</a> · <a href="/agents/history">History</a></p></header>`,
    `<p id="note" class="note" aria-live="polite"></p>`,
    `<section aria-labelledby="windows-title"><h2 id="windows-title">Windows</h2><ul id="windows" class="agents windows"></ul></section>`,
    `<section aria-labelledby="recent-title"><h2 id="recent-title" tabindex="-1">Recently closed</h2><ul id="recent-tabs" class="rows recent"></ul></section>`,
    `<ul id="agents" class="agents"></ul>`,
  ].join(""));
}

// ---------- routes ----------


function refused(req: Request, url: URL): Response {
  console.log(`[safari-harness] refused ${req.method} ${url.pathname} for ${url.host}, origin ${req.headers.get("origin") ?? "(none)"}, site ${req.headers.get("sec-fetch-site") ?? "(none)"}`);
  return new Response("forbidden", { status: 403 });
}

const ROUTES: Record<string, (req: Request, url: URL) => Response | Promise<Response>> = {
  "GET /space": (_req, url) => spacePage(url),
  "GET /space/state": (_req, url) => spaceState(url),
  "POST /space/control": (req) => spaceControl(req),
  "GET /agents": () => agentsPage(),
  "GET /agents.json": async () => json(await overview()),
  "GET /agents/picture": (_req, url) => historyPicture(url),
  "GET /agents/history": (_req, url) => page("Safari history", `data-kind="history" data-id="${html(url.searchParams.get("id") ?? "")}"`, [
    `<header><h1>Safari history</h1><p><a href="/agents">Active tasks</a></p></header>`,
    `<p id="note" class="note" aria-live="polite"></p>`,
    `<ul id="history" class="agents"></ul>`,
  ].join("")),
  "GET /agents/history.json": (_req, url) => historyRows(url),
  "POST /agents/control": (req) => agentsControl(req),
  "POST /agents/windows/close": (req) => windowClose(req),
  "POST /agents/tabs/reopen": (req) => tabReopen(req),
};

// The answer to one of this file's routes; undefined for any other request.
export async function missionRoute(req: Request, url: URL): Promise<Response | undefined> {
  const route = ROUTES[`${req.method} ${url.pathname}`];
  if (!route) return undefined;
  if (!localRequest(req, url)) return refused(req, url);
  return route(req, url);
}
