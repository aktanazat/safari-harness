import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// safari extension reload waits up to 30 s for the extension to connect
// again (bridge.ts). Bun's server cut any request its handler had not
// answered within 10 s, so a reload that took longer failed as "daemon not
// reachable" while the reload went on (10-16, 10-17). The daemon runs in a
// process of its own, as under launchd, with a stand-in extension that
// connects again 13 s after it is asked to reload.

const probes = [Bun.serve({ port: 0, fetch: () => new Response() }), Bun.serve({ port: 0, fetch: () => new Response() })];
const [wsPort, httpPort] = probes.map((s) => s.port);
await Promise.all(probes.map((s) => s.stop(true)));
const home = mkdtempSync(join(tmpdir(), "reload-wait-"));
const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
  env: { ...process.env, HOME: home, SAFARI_HARNESS_WS: String(wsPort), SAFARI_HARNESS_HTTP_PORT: String(httpPort) },
  stdout: "ignore",
  stderr: "inherit",
});

afterAll(async () => {
  daemon.kill();
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
});

const RECONNECT_MS = 13_000;

// The stand-in: it answers every request with an empty list, and on reload
// closes its socket and connects again RECONNECT_MS later, as a slow Safari.
// The wait is real time because the cut it guards against is Bun's own
// timer in the daemon's process, which no fake clock here reaches.
function extension(): void {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`, { headers: { origin: "safari-web-extension://stand-in" } });
  ws.onmessage = (e) => {
    const { id, op } = JSON.parse(String(e.data)) as { id?: string; op: string };
    if (op === "reload") {
      ws.close();
      setTimeout(extension, RECONNECT_MS);
    } else if (id !== undefined) ws.send(JSON.stringify({ id, value: [] }));
  };
}

// Whether the daemon answers, and whether its extension is connected.
async function health(): Promise<{ extension: { connected: boolean } } | undefined> {
  return fetch(`http://127.0.0.1:${httpPort}/health`).then((r) => r.json() as Promise<{ extension: { connected: boolean } }>, () => undefined);
}

async function until(ready: () => Promise<boolean>): Promise<void> {
  while (!(await ready())) await Bun.sleep(50);
}

test("a reload whose extension takes 13 s to connect again is answered, not dropped", async () => {
  await until(async () => (await health()) !== undefined);
  extension();
  await until(async () => (await health())?.extension.connected === true);
  const answer = await fetch(`http://127.0.0.1:${httpPort}/extension/reload`, { method: "POST" })
    .then((r) => r.json() as Promise<{ ok: boolean; value?: { ms: number }; error?: string }>, (e: Error) => ({ ok: false, error: e.message }));
  expect(answer.error).toBeUndefined();
  expect(answer.value?.ms).toBeGreaterThanOrEqual(RECONNECT_MS);
}, 25_000);
