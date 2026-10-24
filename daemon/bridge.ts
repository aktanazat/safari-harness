// Extension bridge: the daemon's link to the Safari extension's background
// worker over a WebSocket, plus request/response plumbing every verb rides on.
//
// Protocol (JSON over ws):
//   extension -> daemon  {op:"hello", role:"extension", ua}
//   daemon -> extension  {id, op, args}   (op handled by background.js)
//   extension -> daemon  {id, value} | {id, error, failure?}  (failures.ts)
//   extension -> daemon  {op:"ticks", on}  start or stop the tick clock
//   daemon -> extension  {op:"tick"}       every TICK_MS while it runs
//   daemon -> extension  {op:"reload"}     have Safari reload the extension,
//                        stuck (see STUCK_AFTER) or asked to (reload)
//   extension -> daemon  {op:"note", kind, ...}  an event for the journal
//   extension -> daemon  {op:"tab", kind:"replaced", from, to}  Safari swapped a tab
//   extension -> daemon  {op:"tab", kind:"popup", tab, opener, url}  an owned
//                        tab's page opened another outside an action
//   extension -> daemon  {op:"tab", kind:"renumbered", tabs}  each old tab id
//                        and its tab's id now, after the extension reloaded
//   extension -> daemon  {op:"recording", recording}  what the user did once
//                        in teach mode, to save (recordings.ts)
//   extension -> daemon  {op:"load", url, from, to}  an owned tab loaded a page

import { AsyncLocalStorage } from "node:async_hooks";
import { note } from "./journal.ts";
import { redactUrl, unsecret } from "./redact.ts";
import { noteLoad } from "./loads.ts";
import { answeredError } from "./failures.ts";

export const DEFAULT_PORT = 37333;

// The clock for hidden tabs the extension keeps running (see "keeping owned
// tabs running" in background.js): Safari holds the extension's own timers
// to four a second, and this one is exact.
const TICK_MS = 50;

// How long a request waits for the extension when none is connected. It
// connects again within a second or two of a daemon restart or an extension
// reload (its retries back off to 10 s at most); a Safari that was not
// running starts hidden and connects in about 5 s.
const CONNECT_MS = 10000;

// How long the connected extension has to answer a ping before a socket
// that opened after it takes its place (see attach).
const ALIVE_MS = 1500;

// When one kind of request (its op) is stuck on the connected extension:
// STUCK_AFTER of them in a row timed out, with no answer to one since, not
// even a late one. Kinds apart: on 10-13 tabs.list went unanswered for
// minutes while the extension went on answering pages' relays, each answer
// set the count of timeouts back to none, and in 17 days of storms (3,054
// timed-out requests) the extension reloaded itself once.
const STUCK_AFTER = 2;

// Requests sent in the first CONNECT_GRACE_MS after the extension connects
// make no kind stuck: it is still finding Safari's tabs and windows again
// (adopt in background.js), which a swapping Mac stretches. On 10-16 a
// deploy's connect took 6 s to adopt them, two tabs.list requests sent 3
// and 7 s after it timed out, and every tabs.list failed at once for 12 s.
const CONNECT_GRACE_MS = 20_000;

// While a kind is stuck its requests do not each wait out their own limit:
// on 10-13 map's opens waited 30 s each all through a storm. A model's call
// has the extension reloaded (healed); the harness's own fail at once
// (extension stuck: …). One goes through each TRIAL_MS to learn whether
// the extension answers again, and its answer ends it.
const TRIAL_MS = 10_000;

// A kind stuck RELOAD_AFTER_MS since its first timeout, or since the last
// reload, has the extension asked to reload itself, RELOADS times in
// RELOADS_MS at most. On 10-13 it answered nothing for over two minutes
// while its page still ran, until an agent turned it off and on in Safari
// Settings, and turning it on made macOS ask the owner for his password; a
// reload unloads and loads it the same way, asking nothing, and one asked
// by hand that day ended a storm in 10 s. That morning's slow spells of a
// swapping Mac timed out 2 and 5 s requests for up to a minute and passed
// by themselves, and a reload fails every request in flight, so the bar is
// a minute. One reload in ten minutes was the most before, while storms
// ran 5 to 29 min: a second now comes a minute after a first that did not
// end it.
const RELOAD_AFTER_MS = 60_000;
const RELOADS = 2;
const RELOADS_MS = 600_000;

// A model's call that meets a stuck kind has the extension reloaded at
// once, within the same RELOADS in RELOADS_MS, and its request goes out
// once it connects again (healed). From 10-05 to 10-19 such calls failed
// at once 44 times in 17 stuck spells, each telling the agent to reload
// it, and agents ran safari extension reload 27 times.

// How long a reload (safari extension reload, or a model's call that met a
// stuck kind) waits for the extension to connect again; it takes a second
// or two (CONNECT_MS).
const RELOADED_MS = 30000;

// How long a tabs.list waits when its caller sets no limit: the extension
// answers one within 2.5 s with what it has by then (background.js), and on
// 10-13 map's opens each waited 30 s on one that never came.
const LIST_MS = 5000;

// A request the extension did not answer within its limit, from a slow
// Safari as from a stuck extension: an open goes on without the tab list
// (spaceWindow in spaces.ts).
export class TimedOut extends Error {}

// A tabs.list asked within JOIN_MS of another still unanswered shares its
// answer rather than asking again: on 10-13 the sweep, the agent windows'
// pages, and agents asked over each other, 191 of a storm's 235 timeouts.
// Never one asked before the extension's latest answer (epoch): a caller
// that closed a tab lists the tabs after the close.
const JOIN_MS = 1000;

// The bounds (ms) of /health's counts of how long each kind of request took
// to answer: the daemon log had only timeouts, so no one could say how
// slow tabs.list was on a good day.
const LATENCY_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

// Minimal structural view of Bun's ServerWebSocket so the bridge stays
// testable without a live server.
export type ExtSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type WireMessage = {
  id?: string | number;
  op?: string;
  args?: unknown[];
  value?: unknown;
  error?: unknown;
  ua?: string;
  role?: string;
  on?: boolean;
  kind?: unknown;
  from?: unknown;
  to?: unknown;
  tab?: unknown;
  opener?: unknown;
  url?: unknown;
  tabs?: unknown;
  recording?: unknown;
  revision?: unknown;
};

function asWire(raw: string): WireMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as WireMessage;
    return null;
  } catch {
    return null;
  }
}

// A change to the agents' tabs the extension saw (see continuity.ts).
export type TabEvent =
  | { kind: "replaced"; from: number; to: number }
  | { kind: "popup"; tab: number; opener: number; url: string }
  | { kind: "renumbered"; tabs: Map<number, number> };

function tabEvent(m: WireMessage): TabEvent | null {
  const isId = (v: unknown): v is number => Number.isSafeInteger(v);
  if (m.kind === "replaced" && isId(m.from) && isId(m.to)) return { kind: "replaced", from: m.from, to: m.to };
  if (m.kind === "popup" && isId(m.tab) && isId(m.opener)) return { kind: "popup", tab: m.tab, opener: m.opener, url: typeof m.url === "string" ? m.url : "" };
  if (m.kind === "renumbered" && m.tabs && typeof m.tabs === "object") {
    const tabs = new Map<number, number>();
    for (const [from, to] of Object.entries(m.tabs)) if (isId(Number(from)) && isId(to)) tabs.set(Number(from), to);
    return { kind: "renumbered", tabs };
  }
  return null;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  // a ping's time limit; a request's are its callers' (Asked)
  timer?: Timer;
  // the socket the request went out on: only that extension can answer it
  sock: ExtSocket;
  asked?: Asked;
};

// A request on the wire and the callers waiting on it, each until its own
// limit: one, or each tabs.list caller that shared it (JOIN_MS). It ends
// unanswered once the last of them gives up; ms is the longest limit, and
// latencyKey what its answer's time counts under (a relay by its page op).
type Asked = { id: string; op: string; latencyKey: string; detail: Record<string, unknown>; sock: ExtSocket; sent: number; epoch: number; ms: number; waiters: Set<Waiter> };
type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: Timer };

// One kind of request's timeouts in a row on the connected extension: how
// many, since when it was asked through them, when the latest came, the
// ids of those an answer may still come for, and when one may go as the
// trial while it is stuck (Infinity while one waits).
type Run = { misses: number; since: number; last: number; ids: Set<string>; trial: number };

// What a socket last said about itself: its user agent, whether it wants
// ticks, and the new ids a reload gave the tabs. A socket waiting to take
// over is heard only once it has.
type Said = { ua?: string; ticks: boolean; renumbered?: TabEvent };

// The requests a tab's page answers, the tab first among their arguments:
// its content script (relay), its own world's script (evalPage, pageData),
// its dialogs, and its frames (probe). Each answer has what the harness
// typed there as a secret cut (redact.ts): a request log, a console, and
// the page's own script answer here without passing content.js's cut.
const FROM_TAB: Record<string, true> = { relay: true, evalPage: true, pageData: true, dialogs: true, probe: true, "upgrade.audit": true, "upgrade.react": true, "upgrade.site": true, "upgrade.context": true, "upgrade.configure": true, "upgrade.native": true };

// The requests whose time is a page's or a site's, not the extension's: a
// tab's (FROM_TAB, and shot, window, storage.clear, which reach into its
// page) wait on a page a dialog can hold, and fetchFile on a server. Their
// timeouts make no kind stuck.
const ELSEWHERE: Record<string, true> = { ...FROM_TAB, shot: true, window: true, "storage.clear": true, fetchFile: true };
// An answer that took this long from the extension itself is noted: the
// log held only timeouts, so no one could say which kinds were slow
// (DaemonLogs).
const SLOW_ANSWER_MS = 5000;

export class Bridge {
  private sock: ExtSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private ticker: Timer | undefined;
  private waiting = new Set<() => void>(); // requests waiting for a socket, and a reload for the next one
  // Sockets that opened while another was connected, each waiting to learn
  // whether that one still answers.
  private candidates = new Set<ExtSocket>();
  private said = new WeakMap<ExtSocket, Said>();
  // A copy that keeps retrying is refused twice a second: noted once.
  private refusing = false;
  // The connected extension's answers, for telling when a kind of request
  // is stuck on it: when it last answered anything, each kind's timeouts in
  // a row, and when the daemon asked it to reload itself, the latest last.
  // An answer can change what tabs.list says, so a list asked after one
  // shares none asked before (epoch, listing).
  private answeredAt = 0;
  private runs = new Map<string, Run>();
  private reloads: number[] = [];
  private epoch = 0;
  private listing: Asked | undefined;
  // how long the extension took over each kind of request (LATENCY_MS)
  private answeredIn = new Map<string, number[]>();
  // A model's call (healing) and how long it waited on a reload; the reload
  // the calls that meet a stuck kind wait on together.
  private healer = new AsyncLocalStorage<{ reloadedMs?: number }>();
  private reloading: Promise<ExtSocket> | null = null;
  public extensionInfo: { ua?: string; connectedAt?: number } | null = null;
  public onTab: (event: TabEvent) => void = () => {};
  public onRecording: (recording: unknown) => void = () => {};
  public onMemory: (tab: number, url: string, revision: number) => void = () => {};
  public onConnect: () => void = () => {};

  constructor(private readonly aliveMs = ALIVE_MS) {}

  get connected(): boolean {
    return this.sock !== null;
  }

  // A socket that opens while another is connected is the same extension
  // again, its old socket dead without the daemon noticing (it reloaded),
  // or a second copy of it: Safari runs one inside each WebDriver session,
  // as Apple's safaridriver opens, and that copy sees none of the user's
  // windows. The newest socket used to win, so the two copies took it from
  // each other twice a second for as long as the session lasted. The
  // connected one keeps it while it answers a ping. A ping under load says
  // nothing about which copy is the user's, so a copy from a Safari
  // launched for automation (automation.ts) is refused outright (10-17);
  // 4002 tells it to stop trying (background.js).
  attach(sock: ExtSocket, automation = false) {
    if (automation) {
      note("connect", { refused: "a copy of the extension in a Safari launched for automation, which sees none of the user's windows" });
      sock.close(4002, "this Safari was launched for automation");
      return;
    }
    const old = this.sock;
    if (old === sock) return;
    if (old === null) return this.take(sock);
    this.candidates.add(sock);
    void this.answers(old).then((alive) => {
      if (!this.candidates.delete(sock)) return; // it closed meanwhile
      if (this.sock !== old) return this.attach(sock); // judged against the one connected now
      if (!alive) return this.take(sock);
      if (!this.refusing) note("connect", { refused: "another copy of the extension is connected and answering" });
      this.refusing = true;
      sock.close(4001, "another Safari Harness extension is connected");
    });
  }

  // What the old socket was asked it will never answer, so those requests
  // fail now, not at their limit.
  private take(sock: ExtSocket) {
    const old = this.sock;
    const said = this.said.get(sock);
    this.sock = sock;
    this.refusing = false;
    this.answeredAt = Date.now();
    this.runs.clear();
    this.extensionInfo = { connectedAt: Date.now(), ...(said?.ua === undefined ? {} : { ua: said.ua }) };
    this.ticks(said?.ticks ?? false);
    if (said?.renumbered) this.onTab(said.renumbered);
    this.onConnect();
    if (old) {
      const lost = this.drop(old, "the Safari extension restarted before it answered; try again");
      try { old.close(); } catch {}
      note("connect", { replaced: true, ...(lost ? { unanswered: lost } : {}) });
    } else note("connect");
    for (const wake of this.waiting) wake();
  }

  // Whether sock answers a ping within aliveMs. An error is an answer too:
  // a build without ping is still connected.
  private answers(sock: ExtSocket): Promise<boolean> {
    const id = `d${++this.seq}`;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      resolve(false);
    }, this.aliveMs);
    this.pending.set(id, { resolve: () => resolve(true), reject: () => resolve(true), timer, sock });
    sock.send(JSON.stringify({ id, op: "ping", args: [] }));
    return promise;
  }

  // A socket closed. Only the current one takes the connection with it; an
  // old one closing after its replacement leaves the new one alone.
  detach(sock: ExtSocket) {
    this.candidates.delete(sock);
    const lost = this.drop(sock, "the Safari extension disconnected before it answered (Safari quit, or the extension reloaded); try again");
    if (this.sock !== sock) return;
    this.sock = null;
    this.runs.clear();
    this.extensionInfo = null;
    this.ticks(false);
    note("disconnect", lost ? { unanswered: lost } : {});
  }

  // called by the server for every inbound frame on an extension socket
  handleMessage(raw: string, from: ExtSocket | null = this.sock) {
    const msg = asWire(raw);
    if (!msg) return;
    if (msg.op === "hello" || msg.op === "ticks") {
      if (!from) return;
      const said = this.said.get(from) ?? { ticks: false };
      if (msg.op === "hello") said.ua = msg.ua;
      else said.ticks = msg.on === true;
      this.said.set(from, said);
      if (from !== this.sock) return;
      if (msg.op === "hello") this.extensionInfo = { ...this.extensionInfo, ua: msg.ua };
      else this.ticks(said.ticks);
      return;
    }
    if (msg.op === "memory") {
      if (from === this.sock && typeof msg.tab === "number" && Number.isSafeInteger(msg.tab) && typeof msg.url === "string" && msg.url.length <= 4096 && typeof msg.revision === "number" && Number.isSafeInteger(msg.revision) && msg.revision >= 0) this.onMemory(msg.tab, msg.url, msg.revision);
      return;
    }
    if (msg.op === "note" && typeof msg.kind === "string") {
      note(msg.kind, Object.fromEntries(Object.entries(msg).filter(([k]) => k !== "op" && k !== "kind")));
      return;
    }
    if (msg.op === "load") {
      if (from && from === this.sock && typeof msg.url === "string" && typeof msg.from === "number" && Number.isFinite(msg.from) && typeof msg.to === "number" && Number.isFinite(msg.to) && msg.from <= msg.to) {
        this.epoch++;
        noteLoad({ from: msg.from, to: msg.to, urls: [msg.url] });
      }
      return;
    }
    if (msg.op === "tab") {
      const event = tabEvent(msg);
      if (!event) return;
      // new ids are those of the Safari behind the connected socket
      if (event.kind === "renumbered" && from !== this.sock) {
        if (from) this.said.set(from, { ticks: false, ...this.said.get(from), renumbered: event });
        return;
      }
      this.epoch++;
      this.onTab(event);
      return;
    }
    if (msg.op === "recording") {
      this.onRecording(msg.recording);
      return;
    }
    if (msg.id === undefined) return;
    const key = String(msg.id);
    const p = this.pending.get(key);
    // an answer the daemon gave up on still shows the extension answers
    if (from === this.sock) this.heard(key, p?.asked, msg.error === undefined);
    if (!p) return;
    this.pending.delete(key);
    clearTimeout(p.timer);
    // a typed refusal may name the address of the link it did not click
    if (msg.error !== undefined) p.reject(answeredError(msg.failure === undefined ? String(msg.error) : redactUrl(String(msg.error)), msg.failure));
    else p.resolve(msg.value);
  }

  private drop(sock: ExtSocket, reason: string): number {
    let n = 0;
    for (const [key, p] of this.pending) {
      if (p.sock !== sock) continue;
      this.pending.delete(key);
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      n++;
    }
    return n;
  }

  private ticks(on: boolean) {
    clearInterval(this.ticker);
    this.ticker = on ? setInterval(() => this.sock?.send('{"op":"tick"}'), TICK_MS) : undefined;
  }

  // The extension's socket, waiting for one when there is none. With the
  // extension gone, it is reconnecting, Safari has quit, or the extension is
  // off. A quit Safari starts again hidden, without taking the screen; an
  // agent that got only "not connected" once spent 2 min before anyone
  // opened it.
  private async socket(): Promise<ExtSocket> {
    if (this.sock) return this.sock;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, CONNECT_MS);
    this.waiting.add(resolve);
    const running = await Bun.spawn(["pgrep", "-x", "Safari"], { stdout: "ignore", stderr: "ignore" }).exited === 0;
    if (!running && !this.sock) Bun.spawn(["open", "-g", "-j", "-a", "Safari"], { stdout: "ignore", stderr: "ignore" });
    await promise;
    clearTimeout(timer);
    this.waiting.delete(resolve);
    if (this.sock) return this.sock;
    throw new Error(running
      ? "Safari extension not connected — enable the Safari Harness extension (Safari ▸ Settings ▸ Extensions; turning it on asks for the Mac's password or Touch ID)"
      : `Safari was not running: it is starting in the background, and its extension did not connect within ${CONNECT_MS / 1000} s; try again`);
  }

  async request(op: string, args: unknown[] = [], timeoutMs = op === "tabs.list" ? LIST_MS : 30000): Promise<unknown> {
    const sock = await this.socket();
    const answer = this.ask(sock, op, args, timeoutMs);
    if (!Object.hasOwn(FROM_TAB, op)) return answer;
    const tab = Number(args[0]);
    return answer.then((v) => unsecret(tab, v), (e: unknown) => {
      if (e instanceof Error) e.message = String(unsecret(tab, e.message));
      throw e;
    });
  }

  // Whether a kind of request is stuck on the connected extension.
  get stuck(): boolean {
    return [...this.runs.values()].some((r) => r.misses >= STUCK_AFTER);
  }

  // The extension as /health tells it (main.ts): connected or not, stuck or
  // not, how long since it last answered anything, and each kind of
  // request's timeouts in a row; while connected, its user agent and when
  // it connected.
  health(): { connected: boolean; stuck: boolean; sinceAnswerMs: number | null; timeouts: Record<string, number>; ua?: string; connectedAt?: number } {
    return {
      connected: this.sock !== null,
      stuck: this.stuck,
      sinceAnswerMs: this.sock === null ? null : Date.now() - this.answeredAt,
      timeouts: Object.fromEntries([...this.runs].map(([op, r]) => [op, r.misses])),
      ...this.extensionInfo,
    };
  }

  // How long each kind of request took to answer since the daemon started:
  // for each, how many answers came within each of boundsMs, and last how
  // many took longer. A relay counts by its page op.
  latency(): { boundsMs: number[]; ops: Record<string, number[]> } {
    return { boundsMs: LATENCY_MS, ops: Object.fromEntries(this.answeredIn) };
  }

  // Sends op on sock, or has a tabs.list caller share one asked within
  // JOIN_MS; the caller waits until timeoutMs. A stuck kind's request fails
  // at once, but for one each TRIAL_MS.
  private ask(sock: ExtSocket, op: string, args: unknown[], timeoutMs: number): Promise<unknown> {
    const now = Date.now();
    const list = op === "tabs.list" && args.length === 0;
    const run = this.runs.get(op);
    const shared = this.listing;
    if (run && run.misses >= STUCK_AFTER) {
      if (now < run.trial) return this.healed(sock, op, args, timeoutMs, run, now);
      run.trial = Infinity;
    } else if (list && shared && shared.sock === sock && shared.epoch === this.epoch && now - shared.sent <= JOIN_MS && this.pending.has(shared.id)) {
      return this.wait(shared, timeoutMs);
    }
    const id = `d${++this.seq}`;
    const relay = op === "relay";
    const asked: Asked = { id, op, latencyKey: relay ? `relay ${String(args[1])}` : op, detail: relay ? { tab: args[0], dom: args[1] } : {}, sock, sent: now, epoch: this.epoch, ms: 0, waiters: new Set() };
    const each = (settle: (w: Waiter) => void) => {
      for (const w of asked.waiters) {
        clearTimeout(w.timer);
        settle(w);
      }
      asked.waiters.clear();
    };
    // The caller waits before the request goes out: an answer may come
    // inside send (a test's extension answers there).
    const answer = this.wait(asked, timeoutMs);
    if (list) this.listing = asked;
    this.pending.set(id, { resolve: (v) => each((w) => w.resolve(v)), reject: (e) => each((w) => w.reject(e)), sock, asked });
    try {
      sock.send(JSON.stringify({ id, op, args }));
    } catch (e) {
      this.pending.delete(id);
      each((w) => w.reject(e instanceof Error ? e : new Error(String(e))));
    }
    return answer;
  }

  private wait(asked: Asked, timeoutMs: number): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    asked.ms = Math.max(asked.ms, timeoutMs);
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        asked.waiters.delete(waiter);
        reject(new TimedOut(`extension request ${asked.op} timed out after ${timeoutMs}ms`));
        if (asked.waiters.size === 0) this.unanswered(asked);
      }, timeoutMs),
    };
    asked.waiters.add(waiter);
    return promise;
  }

  // The connected extension answered request id (asked, unless the daemon
  // had given up on it): any answer, a late one or an error too, ends its
  // kind's run of timeouts.
  private heard(id: string, asked: Asked | undefined, ok: boolean) {
    const now = Date.now();
    this.answeredAt = now;
    if (asked !== this.listing) this.epoch++;
    const op = asked?.op ?? [...this.runs].find(([, r]) => r.ids.has(id))?.[0];
    const run = op === undefined ? undefined : this.runs.get(op);
    if (op !== undefined && run) {
      this.runs.delete(op);
      if (run.misses >= STUCK_AFTER) note("unstuck", { op, ms: now - run.since });
    }
    if (!asked || !ok) return;
    const ms = now - asked.sent;
    const counts = this.answeredIn.get(asked.latencyKey) ?? Array<number>(LATENCY_MS.length + 1).fill(0);
    const within = LATENCY_MS.findIndex((bound) => ms <= bound);
    counts[within === -1 ? LATENCY_MS.length : within]++;
    this.answeredIn.set(asked.latencyKey, counts);
    if (ms > SLOW_ANSWER_MS && !Object.hasOwn(ELSEWHERE, asked.op)) note("slow", { op: asked.op, ms });
  }

  // No one waits on request asked any longer, and the extension never
  // answered it. Its kind's run grows: stuck, its requests fail at once
  // (ask), and stuck a while, the extension is asked to reload itself.
  private unanswered(asked: Asked) {
    this.pending.delete(asked.id);
    const now = Date.now();
    note("timeout", { op: asked.op, ...asked.detail, ms: asked.ms });
    if (asked !== this.listing) this.epoch++;
    if (asked.sock !== this.sock || Object.hasOwn(ELSEWHERE, asked.op)) return;
    if (asked.sent - (this.extensionInfo?.connectedAt ?? 0) < CONNECT_GRACE_MS) return;
    const run = this.runs.get(asked.op) ?? { misses: 0, since: asked.sent, last: now, ids: new Set<string>(), trial: 0 };
    // asked again after a quiet spell: time no one asked is not time the
    // extension failed to answer
    if (asked.sent - run.last > RELOAD_AFTER_MS) run.since = asked.sent;
    run.misses++;
    run.last = now;
    run.ids.add(asked.id);
    run.trial = now + TRIAL_MS;
    this.runs.set(asked.op, run);
    if (run.misses === STUCK_AFTER) note("stuck", { op: asked.op, ms: now - run.since });
    const reloaded = this.reloads.at(-1) ?? -Infinity;
    this.reloads = this.reloads.filter((t) => now - t < RELOADS_MS);
    if (run.misses < STUCK_AFTER || now - Math.max(run.since, reloaded) < RELOAD_AFTER_MS || this.reloads.length >= RELOADS) return;
    this.reloads.push(now);
    this.askReload(asked.sock, `${asked.op} went unanswered for ${Math.round((now - run.since) / 1000)} s, ${run.misses} requests in a row`);
  }

  // Safari unloads the extension and loads it again (background.js): its
  // socket closes, failing what it was asked, and a new one connects.
  private askReload(sock: ExtSocket, why: string) {
    note("reload", { why });
    sock.send('{"op":"reload"}');
  }

  // Has the extension on sock reload (askReload) and waits for it to
  // connect again: its new socket, or an error after RELOADED_MS.
  private async reconnect(sock: ExtSocket, why: string): Promise<ExtSocket> {
    this.askReload(sock, why);
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, RELOADED_MS);
    this.waiting.add(resolve);
    await promise;
    clearTimeout(timer);
    this.waiting.delete(resolve);
    if (this.sock && this.sock !== sock) return this.sock;
    throw new Error(this.sock === sock
      ? `the extension did not reload within ${RELOADED_MS / 1000} s; run safari doctor for the fix`
      : `the extension reloaded but did not connect again within ${RELOADED_MS / 1000} s; run safari doctor for the fix`);
  }

  // A request of a kind stuck now (ask). In a model's call (healing) the
  // extension reloads, once for every call that meets a stuck kind
  // meanwhile and at most RELOADS times in RELOADS_MS, its own reloads
  // (unanswered) counted, and the request goes out once it is back; the
  // call learns how long it waited. Otherwise the request fails at once.
  private healed(sock: ExtSocket, op: string, args: unknown[], timeoutMs: number, run: Run, now: number): Promise<unknown> {
    const heal = this.healer.getStore();
    const stuck = `extension stuck: the Safari extension has answered none of the last ${run.misses} ${op} requests (for ${Math.round((now - run.since) / 1000)} s)`;
    if (!heal) throw new Error(`${stuck}; try again in a minute`);
    if (!this.reloading) {
      this.reloads = this.reloads.filter((t) => now - t < RELOADS_MS);
      if (this.reloads.length >= RELOADS) throw new Error(`${stuck}, and it was reloaded ${RELOADS} times in the last ${RELOADS_MS / 60_000} minutes; try again in a minute, then tell the user Safari is not answering`);
      this.reloads.push(now);
      this.reloading = this.reconnect(sock, `${op} went unanswered for ${Math.round((now - run.since) / 1000)} s, ${run.misses} requests in a row, and a call met it`).finally(() => {
        this.reloading = null;
      });
    }
    return this.reloading.then((fresh) => {
      heal.reloadedMs = Date.now() - now;
      return this.ask(fresh, op, args, timeoutMs);
    }, (e: unknown) => {
      throw new Error(`${stuck}, and reloading it did not help: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  // Runs a model's call (guard.ts), whose requests of a stuck kind have
  // the extension reloaded (healed): its value, and how long it waited on
  // a reload if it did.
  async healing<T>(call: () => Promise<T>): Promise<{ value: T; reloadedMs: number | undefined }> {
    const heal: { reloadedMs?: number } = {};
    const value = await this.healer.run(heal, call);
    return { value, reloadedMs: heal.reloadedMs };
  }

  // safari extension reload (main.ts): the reload a stuck extension gets,
  // asked for whenever. Done once a new socket connects: how long it took.
  async reload(): Promise<{ ms: number }> {
    const sock = this.sock;
    if (!sock) throw new Error("Safari extension not connected, so there is nothing to reload; run safari doctor for the fix");
    const began = Date.now();
    await this.reconnect(sock, "asked for (safari extension reload)");
    return { ms: Date.now() - began };
  }

  // relay a DOM op into the content script of a specific tab: its top page,
  // or the embedded frame frameId. The extension gets the time limit too,
  // and answers first, so it never re-sends an op the daemon has given up on.
  tab(tabId: number, op: string, args: unknown[] = [], timeoutMs = 30000, frameId = 0): Promise<unknown> {
    return this.request("relay", [tabId, op, args, timeoutMs, frameId], timeoutMs + 2000);
  }
}

export const bridge = new Bridge();
