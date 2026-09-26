// Fake extension: speaks the same ws protocol as background.js + content.js,
// so the daemon, CLI, CDP shim, and MCP server can be tested end-to-end
// without Safari. Answers relay ops with canned content-script results.

// The daemon gives the extension socket only to an extension origin.
const ws = new WebSocket("ws://127.0.0.1:37333/", { headers: { Origin: "safari-web-extension://fake-extension" } });
const tabs = new Map<number, { id: number; url: string; title: string; active: boolean; windowId: number }>([
  [101, { id: 101, url: "https://example.com/", title: "Example Domain", active: true, windowId: 1 }],
]);
let nextTab = 102;

type Wire = { id?: number; op?: string; args?: unknown[] };

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ op: "hello", role: "extension", ua: "fake" }));
  console.log("fake extension connected");
});

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data)) as Wire;
  const reply = (value?: unknown, error?: string) =>
    ws.send(JSON.stringify({ id: msg.id, ...(error ? { error } : { value }) }));
  const args = (msg.args ?? []) as unknown[];

  if (msg.op === "ping") return reply("pong");
  if (msg.op === "tabs.list") return reply([...tabs.values()]);
  if (msg.op === "tabs.open") {
    const t = { id: nextTab++, url: String(args[0]), title: "New", active: !args[1], windowId: 1 };
    tabs.set(t.id, t);
    return reply(t);
  }
  if (msg.op === "tabs.close") { tabs.delete(Number(args[0])); return reply({ ok: true }); }
  if (msg.op === "tabs.navigate") {
    const t = tabs.get(Number(args[0]));
    if (!t) return reply(undefined, "no tab");
    t.url = String(args[1]); t.title = "Loaded " + String(args[1]);
    return reply(t);
  }
  if (msg.op === "tabs.activate") return reply({ ok: true });
  if (msg.op === "windows.focus") return reply({ ok: true });
  if (msg.op === "cookies") return reply([{ name: "fake", value: "1", domain: ".example.com", path: "/", secure: true, httpOnly: false }]);
  if (msg.op === "relay") {
    const tabId = Number(args[0]);
    const op = String(args[1]);
    const domArgs = (args[2] ?? []) as unknown[];
    const t = tabs.get(tabId);
    if (!t) return reply(undefined, "no tab");
    if (op === "snapshot") {
      return reply({
        url: t.url, title: t.title, nodes: 3, truncated: false,
        snapshot: `h1 "Example Domain"\nThis domain is for use in illustrative examples.\n[1] link "More information…" https://www.iana.org/domains/example\n[2] textbox`,
      });
    }
    if (op === "click") return reply({ ok: true, at: { x: 100, y: 200 }, tag: "A" });
    if (op === "type") return reply({ ok: true, value: domArgs[1] });
    if (op === "tabInfo") return reply({ url: t.url, title: t.title, ready: "complete", scrollY: 0, viewport: { w: 1440, h: 900 } });
    if (op === "eval") return reply({ ok: true, result: "fake-eval-result" });
    if (op === "extract") return reply({ url: t.url, title: t.title, text: "This domain is for use in illustrative examples.", truncated: false });
    if (op === "netRead") return reply({ entries: [{ kind: "fetch", url: "https://api.example.com/x", method: "GET", status: 200, ms: 12, t: Date.now() }] });
    if (op === "consoleRead") return reply({ entries: [{ level: "log", text: "hello", t: Date.now() }] });
    return reply({ ok: true });
  }
  reply(undefined, `fake: unknown op ${String(msg.op)}`);
});

ws.addEventListener("close", () => { console.log("fake extension closed"); process.exit(0); });
ws.addEventListener("error", () => { console.log("fake extension error (daemon down?)"); process.exit(1); });
