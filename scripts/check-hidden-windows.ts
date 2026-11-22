import { strict as assert } from "node:assert";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const negative = process.argv.includes("--negative");
const count = Number(process.argv[2] ?? (negative ? 1 : 10));
assert(Number.isSafeInteger(count) && count > 0, "Pass a positive agent count");
const release = join(homedir(), ".local/share/safari-harness/current");
const cli = join(release, "cli/safari.ts");
const watcher = spawn(join(release, "scripts/window-watch"), negative ? ["--capture-agents"] : [], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: watcher.stdout });
const events = lines[Symbol.asyncIterator]();
watcher.on("error", () => lines.close());
async function next(): Promise<Record<string, unknown>> {
  const { value, done } = await events.next();
  assert.equal(done, false, "The native window observer stopped before answering");
  return JSON.parse(value) as Record<string, unknown>;
}
const checkpoint = async (command: string) => {
  watcher.stdin.write(`${command}\n`);
  const reply = await next();
  assert(!reply.error, JSON.stringify(reply));
  assert.equal(reply.checkpoint, command);
  if (negative) {
    assert(Array.isArray(reply.violations));
    const violations = reply.violations as Record<string, unknown>[];
    assert(violations.every((v) => "visiblePixelsOnDisplay" in v), JSON.stringify(reply));
    if (command === "pixels" || command === "final") assert(violations.some((v) => "visiblePixelsOnDisplay" in v), "The negative control did not detect the test window");
  } else assert.deepEqual(reply.violations, [], JSON.stringify(reply));
  assert.equal(reply.baselineUnchanged, true, "An existing Safari window changed");
  return reply;
};
async function safari(key: string, ...args: string[]) {
  const run = Bun.spawn([process.execPath, cli, ...args, "--owner", key, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [code, out, error] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  assert.equal(code, 0, `safari ${args.join(" ")}: ${error}\n${out}`);
  return out.trim() ? JSON.parse(out) as Record<string, unknown> : {};
}
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response("<title>Hidden window proof</title><h1>Hidden window proof</h1>", { headers: { "content-type": "text/html" } }),
});
const keys = new Set<string>();
try {
  const ready = await next();
  assert.equal(ready.ready, true, JSON.stringify(ready));
  assert(Array.isArray(ready.capturedDisplays) && ready.capturedDisplays.length > 0, "No composited-frame capture was started");
  console.log(JSON.stringify({ observer: ready }));
  for (let i = 0; i < count; i++) {
    const key = `hidden-proof-${process.pid}-${i}`;
    keys.add(key);
    const opened = await safari(key, "open", `http://127.0.0.1:${server.port}/${i}`, "--bg");
    assert.equal(typeof opened.id, "number", JSON.stringify(opened));
    await checkpoint(`open-${i}`);
    if (negative) await checkpoint("pixels");
    await safari(key, "close", String(opened.id));
    await safari(key, "owner", "--end");
    keys.delete(key);
    const ended = await checkpoint("empty");
    assert.deepEqual(ended.remaining, []);
    assert(Number(ended.windows) >= i + 1, "The observer did not see each new window");
    console.log(JSON.stringify({ agent: i + 1, ...ended }));
  }
  const final = await checkpoint("final");
  if (negative) assert(Number(final.capturedFrames) > 0, "The negative control checked no composited frame");
  console.log(JSON.stringify({ pass: true, negativeControl: negative, agents: count, ...final }));
} finally {
  for (const key of keys) await safari(key, "owner", "--end").catch(console.error);
  server.stop(true);
  watcher.stdin.end();
  lines.close();
  watcher.kill();
}
