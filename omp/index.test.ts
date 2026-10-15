import { expect, test } from "bun:test";
import safariTurnEnd from "./index.ts";

type Handler = Parameters<Parameters<typeof safariTurnEnd>[0]["on"]>[1];
type Context = Parameters<Handler>[1];
const identity = { runtimeId: "fixture", sessionId: "session", agentId: "Main", sessionFile: null, branchLeafId: "answer", promptGeneration: 1, promptSequence: 1, submissionGeneration: 1 };
const state = { identity, outcome: "completed" as const, blockers: [] as string[] };
const prepared = { owner: process.pid, epoch: "owned-generation", tabs: [101] };
const authorize: NonNullable<Context["releaseTaskUI"]> = async (_request, lifecycle) => {
  const owned = await lifecycle.prepare(new AbortController().signal);
  await lifecycle.release(owned);
  return { released: true, state };
};
const context: Context = { mode: "interactive", getTaskCompletion: () => state, waitForIdle: async () => {}, releaseTaskUI: authorize };

async function withHook(run: (handler: Handler, requests: { path: string; body: unknown }[], release: PromiseWithResolvers<void>, arrived: PromiseWithResolvers<void>) => Promise<void>, receipt: unknown = { ok: true, failed: 0 }) {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: { path: string; body: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, body: await request.json() });
    if (path === "/turn-end/prepare") return Response.json(prepared);
    arrived.resolve();
    await release.promise;
    return Response.json(receipt);
  } });
  const before = process.env.SAFARI_HARNESS_HTTP;
  process.env.SAFARI_HARNESS_HTTP = `http://127.0.0.1:${server.port}`;
  let handler: Handler | undefined;
  safariTurnEnd({ on: (_event, callback) => { handler = callback; } });
  try {
    if (!handler) throw new Error("completion hook was not registered");
    await run(handler, requests, release, arrived);
  } finally {
    release.resolve(); server.stop(true);
    if (before === undefined) delete process.env.SAFARI_HARNESS_HTTP;
    else process.env.SAFARI_HARNESS_HTTP = before;
  }
}

test("the hook returns before idle and runtime authorization awaits the exact cleanup receipt", async () => {
  await withHook(async (handler, requests, release, arrived) => {
    const idle = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let done = false;
    handler({}, { ...context, waitForIdle: () => idle.promise, async releaseTaskUI(request, lifecycle) {
      const result = await authorize(request, lifecycle);
      done = true; finished.resolve();
      return result;
    } });
    await Promise.resolve();
    expect(requests).toEqual([]);
    idle.resolve();
    await arrived.promise;
    expect({ done, requests }).toEqual({ done: false, requests: [
      { path: "/turn-end/prepare", body: { owner: process.pid } },
      { path: "/turn-end", body: { owner: process.pid, prepared } },
    ] });
    release.resolve(); await finished.promise;
    expect(done).toBe(true);
  });
});

test.each(["continuing", "print", "background", "queued", "delivering", "input", "handoff", "incomplete", "unknown", "legacy", "missing-idle"])("the hook preserves %s work without preparing or closing pages", async mode => {
  await withHook(async (handler, requests) => {
    const outcome = mode === "incomplete" || mode === "unknown" ? mode : "completed";
    const blocked = ["background", "queued", "delivering", "input", "handoff"].includes(mode);
    let authorizations = 0;
    const current: Context = mode === "legacy" ? { mode: "interactive" } : {
      ...context,
      mode: mode === "print" ? "print" : "interactive",
      waitForIdle: mode === "missing-idle" ? undefined : context.waitForIdle,
      getTaskCompletion: () => ({ identity, outcome, blockers: blocked ? [mode] : [] }),
      async releaseTaskUI(request, lifecycle) { authorizations++; return authorize(request, lifecycle); },
    };
    handler({ willContinue: mode === "continuing" }, current);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect({ authorizations, requests }).toEqual({ authorizations: 0, requests: [] });
  });
});

test.each(["cancelled", "failed"] as const)("%s releases only temporary resources after runtime authorization", async outcome => {
  await withHook(async (handler, requests, release) => {
    const finished = Promise.withResolvers<void>();
    const current: Context = {
      ...context,
      getTaskCompletion: () => ({ identity, outcome, blockers: [] }),
      async releaseTaskUI(request, lifecycle) {
        expect(request).toEqual({ expected: identity, reason: outcome, resource: "temporary" });
        const owned = await lifecycle.prepare(new AbortController().signal);
        release.resolve();
        await lifecycle.release(owned);
        finished.resolve();
        return { released: true, state: { identity, outcome, blockers: [] } };
      },
    };
    handler({}, current);
    await finished.promise;
    expect(requests.map(request => request.path)).toEqual(["/turn-end/prepare", "/turn-end"]);
  });
});

test("new input during idle cannot replace the original owning task identity", async () => {
  await withHook(async (handler, requests) => {
    const idle = Promise.withResolvers<void>();
    const refused = Promise.withResolvers<void>();
    let changed = false;
    handler({}, { ...context, waitForIdle: () => idle.promise,
      getTaskCompletion: () => ({ ...state, identity: changed ? { ...identity, promptGeneration: 2 } : identity }),
      async releaseTaskUI(request) {
        expect(request.expected).toEqual(identity);
        refused.resolve();
        return { released: false, state: { ...state, blockers: ["new input"] } };
      },
    });
    changed = true; idle.resolve();
    await refused.promise;
    expect(requests).toEqual([]);
  });
});

test.each(["failed", "deferred", "invalidated"])("%s cleanup never resolves as a successful runtime release", async kind => {
  const receipt = { ok: true, failed: kind === "failed" ? 1 : 0, deferred: kind === "deferred", invalidated: kind === "invalidated" };
  await withHook(async (handler, requests, release) => {
    const finished = Promise.withResolvers<boolean>();
    release.resolve();
    handler({}, { ...context, async releaseTaskUI(request, lifecycle) {
      try {
        const result = await authorize(request, lifecycle);
        finished.resolve(result.released);
        return result;
      } catch (error) {
        finished.resolve(false);
        throw error;
      }
    } });
    expect(await finished.promise).toBe(false);
    expect(requests.map(request => request.path)).toEqual(["/turn-end/prepare", "/turn-end"]);
  }, receipt);
});
