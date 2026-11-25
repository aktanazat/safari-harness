// Ladybird's own WebDriver: it launches the browser, holds the one session,
// and answers WebDriver BiDi over a websocket and classic WebDriver over
// HTTP. Ladybird has no extension API, so the bridge (bridge.ts) drives
// everything through this.

import { spawn, type Subprocess } from "bun";

// The fork install-app.sh installs; a stock Ladybird takes launch and headless only.
const APP = process.env.LADYBIRD_APP ?? "/Applications/Ladybird Harness.app";

export type BidiEvent = { method: string; params: Record<string, unknown> };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Wire = { id?: number; type?: string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: string; message?: string };

// attach: the user's own Ladybird, started with --allow-webdriver-attach (or
// started now, as he would start it), which outlives the session; this
// takes the Ladybird build with that patch (LADYBIRD_APP). launch and
// headless: a browser of the driver's own, closed with the session.
export type LaunchOptions = { port: number; browser: "attach" | "launch" | "headless"; profilePath?: string; profile?: string };

// The driver prints this once it accepts sessions.
async function untilListening(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Ladybird WebDriver exited before listening: ${seen.trim()}`);
    seen += decoder.decode(value, { stream: true });
    if (seen.includes("Listening on")) break;
  }
  // Keep draining, or the driver blocks once the pipe fills.
  void (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  })();
}

export class Ladybird {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: BidiEvent) => void>();
  #seq = 0;
  // Classic WebDriver acts on one "current" window at a time, so its calls
  // run one after another.
  #classicTail: Promise<unknown> = Promise.resolve();
  readonly closed: Promise<string>;

  private constructor(
    readonly driver: Subprocess,
    readonly base: string,
    readonly session: string,
    readonly userAgent: string,
    ws: WebSocket,
  ) {
    this.#ws = ws;
    const closed = Promise.withResolvers<string>();
    this.closed = closed.promise;
    ws.onmessage = (e) => this.#receive(JSON.parse(String(e.data)) as Wire);
    ws.onclose = (e) => {
      const why = `BiDi socket closed (${e.code})`;
      for (const p of this.#pending.values()) p.reject(new Error(why));
      this.#pending.clear();
      closed.resolve(why);
    };
  }

  static async launch(opts: LaunchOptions): Promise<Ladybird> {
    const args = [`${APP}/Contents/MacOS/WebDriver`, "--port", String(opts.port)];
    if (opts.browser === "attach") args.push("--attach");
    if (opts.browser === "headless") args.push("--headless");
    if (opts.profilePath) args.push("--profile-path", opts.profilePath);
    else if (opts.profile) args.push("--profile", opts.profile);
    const driver = spawn(args, { stdout: "pipe", stderr: "inherit" });
    await untilListening(driver.stdout);
    const base = `http://127.0.0.1:${opts.port}`;
    const res = await fetch(`${base}/session`, {
      method: "POST",
      body: JSON.stringify({ capabilities: { alwaysMatch: { webSocketUrl: true, unhandledPromptBehavior: "ignore" } } }),
    });
    const body = (await res.json()) as { value: { sessionId: string; capabilities: { webSocketUrl: string; userAgent: string }; message?: string } };
    if (!res.ok) {
      driver.kill();
      throw new Error(`Ladybird WebDriver refused the session: ${body.value.message}`);
    }
    const ws = new WebSocket(body.value.capabilities.webSocketUrl);
    const open = Promise.withResolvers<void>();
    ws.onopen = () => open.resolve();
    ws.onerror = () => open.reject(new Error("BiDi socket failed to open"));
    await open.promise;
    return new Ladybird(driver, base, body.value.sessionId, body.value.capabilities.userAgent, ws);
  }

  #receive(m: Wire) {
    if (m.id !== undefined) {
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if (m.type === "error") p.reject(new Error(`${m.error}: ${m.message}`));
      else p.resolve(m.result);
      return;
    }
    if (m.type === "event" && m.method) {
      const event = { method: m.method, params: m.params ?? {} };
      for (const fn of this.#listeners) fn(event);
    }
  }

  call<T>(method: string, params: object = {}): Promise<T> {
    const id = ++this.#seq;
    const reply = Promise.withResolvers<unknown>();
    this.#pending.set(id, reply);
    this.#ws.send(JSON.stringify({ id, method, params }));
    return reply.promise as Promise<T>;
  }

  on(fn: (event: BidiEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  // One classic command; `steps` lets a caller switch windows and act
  // before another caller switches away.
  classic<T>(steps: (send: <V>(method: string, path: string, body?: object) => Promise<V>) => Promise<T>): Promise<T> {
    const send = async <V>(method: string, path: string, body?: object): Promise<V> => {
      const res = await fetch(`${this.base}/session/${this.session}${path}`, { method, body: body ? JSON.stringify(body) : undefined });
      const out = (await res.json()) as { value: V & { error?: string; message?: string } };
      if (!res.ok) throw new Error(`${out.value.error}: ${out.value.message}`);
      return out.value;
    };
    const run = this.#classicTail.then(() => steps(send));
    this.#classicTail = run.catch(() => {});
    return run;
  }

  async close(): Promise<void> {
    await fetch(`${this.base}/session/${this.session}`, { method: "DELETE" }).catch(() => {});
    this.driver.kill();
  }
}
