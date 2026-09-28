// Extension bridge: the daemon's link to the Safari extension's background
// worker over a WebSocket, plus request/response plumbing every verb rides on.
//
// Protocol (JSON over ws):
//   extension -> daemon  {op:"hello", role:"extension", ua}
//   daemon -> extension  {id, op, args}   (op handled by background.js)
//   extension -> daemon  {id, value} | {id, error}
//   extension -> daemon  {op:"ticks", on}  start or stop the tick clock
//   daemon -> extension  {op:"tick"}       every TICK_MS while it runs

export const DEFAULT_PORT = 37333;

// The clock for hidden tabs the extension keeps running (see "keeping owned
// tabs running" in background.js): Safari holds the extension's own timers
// to four a second, and this one is exact.
const TICK_MS = 50;

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

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// With the extension gone, either Safari has quit or the extension is off.
// A quit Safari starts again hidden, without taking the screen, and connects
// in about 5 s; an agent that got only "not connected" once spent 2 min
// before anyone opened it.
async function notConnected(): Promise<never> {
  const running = await Bun.spawn(["pgrep", "-x", "Safari"], { stdout: "ignore", stderr: "ignore" }).exited === 0;
  if (running) throw new Error("Safari extension not connected — enable the Safari Harness extension (Safari ▸ Settings ▸ Extensions)");
  Bun.spawn(["open", "-g", "-j", "-a", "Safari"], { stdout: "ignore", stderr: "ignore" });
  throw new Error("Safari is not running: it is starting in the background now; try again in a few seconds");
}

export class Bridge {
  private sock: ExtSocket | null = null;
  private seq = 0;
  private pending: Record<string, Pending> = {};
  private ticker: Timer | undefined;
  public extensionInfo: { ua?: string; connectedAt?: number } | null = null;

  get connected(): boolean {
    return this.sock !== null;
  }

  attach(sock: ExtSocket, hello?: WireMessage) {
    if (this.sock && this.sock !== sock) {
      try { this.sock.close(); } catch {}
    }
    this.sock = sock;
    this.extensionInfo = { ua: hello?.ua, connectedAt: Date.now() };
  }

  detach() {
    this.sock = null;
    this.extensionInfo = null;
    this.ticks(false);
    this.failAll(new Error("extension disconnected"));
  }

  // called by the server for every inbound frame on the extension socket
  handleMessage(raw: string) {
    const msg = asWire(raw);
    if (!msg) return;
    if (msg.op === "hello") {
      this.extensionInfo = { ua: msg.ua, connectedAt: Date.now() };
      return;
    }
    if (msg.op === "ticks") {
      this.ticks(msg.on === true);
      return;
    }
    if (msg.id === undefined) return;
    const key = String(msg.id);
    const p = this.pending[key];
    if (!p) return;
    delete this.pending[key];
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.value);
  }

  private failAll(e: Error) {
    for (const key of Object.keys(this.pending)) {
      clearTimeout(this.pending[key].timer);
      this.pending[key].reject(e);
      delete this.pending[key];
    }
  }

  private ticks(on: boolean) {
    clearInterval(this.ticker);
    this.ticker = on ? setInterval(() => this.sock?.send('{"op":"tick"}'), TICK_MS) : undefined;
  }

  request(op: string, args: unknown[] = [], timeoutMs = 30000): Promise<unknown> {
    if (!this.sock) return notConnected();
    const id = `d${++this.seq}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      delete this.pending[id];
      reject(new Error(`extension request ${op} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending[id] = { resolve, reject, timer };
    this.sock.send(JSON.stringify({ id, op, args }));
    return promise;
  }

  // relay a DOM op into the content script of a specific tab: its top page,
  // or the embedded frame frameId. The extension gets the time limit too,
  // and times out first, so it never re-sends an op the daemon has given up on.
  tab(tabId: number, op: string, args: unknown[] = [], timeoutMs = 30000, frameId = 0): Promise<unknown> {
    return this.request("relay", [tabId, op, args, timeoutMs, frameId], timeoutMs + 2000);
  }
}

export const bridge = new Bridge();
