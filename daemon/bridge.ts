// Extension bridge: the daemon's link to the Safari extension's background
// worker over a WebSocket, plus request/response plumbing every verb rides on.
//
// Protocol (JSON over ws):
//   extension -> daemon  {op:"hello", role:"extension", ua}
//   daemon -> extension  {id, op, args}   (op handled by background.js)
//   extension -> daemon  {id, value} | {id, error}
//   extension -> daemon  {op:"ticks", on}  start or stop the tick clock
//   daemon -> extension  {op:"tick"}       every TICK_MS while it runs
//   extension -> daemon  {op:"note", kind, ...}  an event for the journal
//   extension -> daemon  {op:"tab", kind:"replaced", from, to}  Safari swapped a tab
//   extension -> daemon  {op:"tab", kind:"popup", tab, opener, url}  an owned
//                        tab's page opened another outside an action
//   extension -> daemon  {op:"tab", kind:"renumbered", tabs}  each old tab id
//                        and its tab's id now, after the extension reloaded
//   extension -> daemon  {op:"recording", recording}  what the user did once
//                        in teach mode, to save (recordings.ts)

import { note } from "./journal.ts";

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
  timer: Timer;
  // the socket the request went out on: only that extension can answer it
  sock: ExtSocket;
};

// What a socket last said about itself: its user agent, whether it wants
// ticks, and the new ids a reload gave the tabs. A socket waiting to take
// over is heard only once it has.
type Said = { ua?: string; ticks: boolean; renumbered?: TabEvent };

export class Bridge {
  private sock: ExtSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private ticker: Timer | undefined;
  private waiting = new Set<() => void>(); // requests waiting for a socket
  // Sockets that opened while another was connected, each waiting to learn
  // whether that one still answers.
  private candidates = new Set<ExtSocket>();
  private said = new WeakMap<ExtSocket, Said>();
  // A copy that keeps retrying is refused twice a second: noted once.
  private refusing = false;
  public extensionInfo: { ua?: string; connectedAt?: number } | null = null;
  public onTab: (event: TabEvent) => void = () => {};
  public onRecording: (recording: unknown) => void = () => {};

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
  // connected one keeps it while it answers a ping.
  attach(sock: ExtSocket) {
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
    this.extensionInfo = { connectedAt: Date.now(), ...(said?.ua === undefined ? {} : { ua: said.ua }) };
    this.ticks(said?.ticks ?? false);
    if (said?.renumbered) this.onTab(said.renumbered);
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
    if (msg.op === "note" && typeof msg.kind === "string") {
      note(msg.kind, Object.fromEntries(Object.entries(msg).filter(([k]) => k !== "op" && k !== "kind")));
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
    if (!p) return;
    this.pending.delete(key);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
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
      ? "Safari extension not connected — enable the Safari Harness extension (Safari ▸ Settings ▸ Extensions)"
      : `Safari was not running: it is starting in the background, and its extension did not connect within ${CONNECT_MS / 1000} s; try again`);
  }

  async request(op: string, args: unknown[] = [], timeoutMs = 30000): Promise<unknown> {
    const sock = await this.socket();
    const id = `d${++this.seq}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      note("timeout", { op, ...(op === "relay" ? { tab: args[0], dom: args[1] } : {}), ms: timeoutMs });
      reject(new Error(`extension request ${op} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer, sock });
    sock.send(JSON.stringify({ id, op, args }));
    return promise;
  }

  // relay a DOM op into the content script of a specific tab: its top page,
  // or the embedded frame frameId. The extension gets the time limit too,
  // and answers first, so it never re-sends an op the daemon has given up on.
  tab(tabId: number, op: string, args: unknown[] = [], timeoutMs = 30000, frameId = 0): Promise<unknown> {
    return this.request("relay", [tabId, op, args, timeoutMs, frameId], timeoutMs + 2000);
  }
}

export const bridge = new Bridge();
