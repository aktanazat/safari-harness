import { afterEach, expect, jest, test } from "bun:test";
import { Bridge, type ExtSocket } from "./bridge.ts";
import { recent } from "./journal.ts";

// An extension socket that answers every request with value, or never. Its
// ticks are counted apart from what it is asked.
function extension(bridge: Bridge, value?: string) {
  const asked: string[] = [];
  const first = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<number | undefined>();
  let tick = Promise.withResolvers<void>();
  const sock: ExtSocket = {
    send(data: string) {
      const { id, op } = JSON.parse(data) as { id: string; op: string };
      if (op === "tick") {
        tick.resolve();
        return;
      }
      asked.push(op);
      first.resolve();
      if (value !== undefined) queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value }), sock));
    },
    close(code?: number) {
      closed.resolve(code);
    },
  };
  const says = (frame: object) => bridge.handleMessage(JSON.stringify(frame), sock);
  // Settles on the first tick after the call.
  const nextTick = () => {
    tick = Promise.withResolvers<void>();
    return tick.promise;
  };
  return { sock, asked, sent: first.promise, closed: closed.promise, says, nextTick };
}

test("an extension whose socket stopped answering is replaced: that socket's requests fail, and its late close leaves the new one serving", async () => {
  const bridge = new Bridge(5);
  const old = extension(bridge);
  const now = extension(bridge, "answered by the new socket");
  bridge.attach(old.sock);
  const lost = bridge.request("tabs.list", [], 60000);
  await old.sent;
  bridge.attach(now.sock);
  await expect(lost).rejects.toThrow("restarted before it answered");
  bridge.detach(old.sock);
  expect(await bridge.request("tabs.list")).toBe("answered by the new socket");
});

test("a second copy of the extension is refused while the connected one answers, and nothing it says moves requests or ticks", async () => {
  const bridge = new Bridge(60000);
  const user = extension(bridge, "the user's Safari");
  const copy = extension(bridge, "a WebDriver session's copy");
  bridge.attach(user.sock);
  user.says({ op: "ticks", on: true });
  bridge.attach(copy.sock);
  copy.says({ op: "ticks", on: false });
  expect(await copy.closed).toBe(4001);
  expect(await bridge.request("tabs.list")).toBe("the user's Safari");
  expect(copy.asked).toEqual([]);
  await user.nextTick();
  user.says({ op: "ticks", on: false });
});

test("an extension that answers the ping with an error is still there, so a second copy is refused", async () => {
  const bridge = new Bridge(60000);
  const older: ExtSocket = {
    send(data: string) {
      const { id, op } = JSON.parse(data) as { id: string; op: string };
      queueMicrotask(() => bridge.handleMessage(JSON.stringify(op === "ping" ? { id, error: "unknown op ping" } : { id, value: "the older build" }), older));
    },
    close() {},
  };
  const copy = extension(bridge, "a WebDriver session's copy");
  bridge.attach(older);
  bridge.attach(copy.sock);
  expect(await copy.closed).toBe(4001);
  expect(await bridge.request("tabs.list")).toBe("the older build");
});

test("a socket that takes over from a silent one keeps the ticks it asked for while it waited", async () => {
  const bridge = new Bridge(5);
  const gone = extension(bridge);
  const back = extension(bridge, "back");
  bridge.attach(gone.sock);
  bridge.attach(back.sock);
  back.says({ op: "ticks", on: true });
  await back.nextTick();
  back.says({ op: "ticks", on: false });
});

test("an extension that disconnects fails what it was asked at once, not at the time limit", async () => {
  const bridge = new Bridge();
  const ext = extension(bridge);
  bridge.attach(ext.sock);
  const lost = bridge.request("relay", [7, "click", []], 60000);
  await ext.sent;
  bridge.detach(ext.sock);
  await expect(lost).rejects.toThrow("disconnected before it answered");
  expect(bridge.health()).toMatchObject({ connected: false, stuck: false, sinceAnswerMs: null });
});

test("a request made while the extension reconnects goes out once it is back", async () => {
  const bridge = new Bridge();
  const ext = extension(bridge, "tabs");
  const asked = bridge.request("tabs.list");
  bridge.attach(ext.sock);
  expect(await asked).toBe("tabs");
  expect(ext.asked).toEqual(["tabs.list"]);
});

// An extension that reloads can connect again before the daemon notices its
// old socket is dead, and says at once which new id each tab has: those
// ids are the new connection's, as its ticks are.
test("the tab ids a reloaded extension sends while its dead socket still holds the connection count once it takes over", async () => {
  const bridge = new Bridge(5);
  const heard: { tabs: Map<number, number>; connectedAt: number | undefined }[] = [];
  bridge.onTab = (e) => { if (e.kind === "renumbered") heard.push({ tabs: e.tabs, connectedAt: bridge.extensionInfo?.connectedAt }); };
  const gone = extension(bridge);
  const back = extension(bridge);
  bridge.attach(gone.sock);
  const before = bridge.extensionInfo?.connectedAt;
  // connections are told apart by the millisecond they began
  for (const began = Date.now(); Date.now() === began; );
  bridge.attach(back.sock);
  back.says({ op: "tab", kind: "renumbered", tabs: { 3: 10 } });
  await gone.closed;
  expect(heard).toEqual([{ tabs: new Map([[3, 10]]), connectedAt: bridge.extensionInfo?.connectedAt }]);
  expect(bridge.extensionInfo?.connectedAt).not.toBe(before);
});

// A request the extension leaves unanswered, waited out on the fake clock.
// setImmediate runs once every promise job has, the request's timer set
// among them, and the fake clock leaves it be.
async function timesOut(bridge: Bridge, op: string, ms: number) {
  const asked = bridge.request(op, [], ms);
  await new Promise<void>((r) => setImmediate(r));
  jest.advanceTimersByTime(ms);
  await expect(asked).rejects.toThrow("timed out");
}

const settled = () => new Promise<void>((r) => setImmediate(r));

// An extension connected long enough that its timeouts count toward stuck:
// the 20 s after a connect (CONNECT_GRACE_MS in bridge.ts) are past.
function pastGrace(bridge: Bridge, sock: ExtSocket) {
  bridge.attach(sock);
  jest.advanceTimersByTime(20_000);
}

// An extension socket that holds each request until the test answers it.
function holding(bridge: Bridge) {
  const asked: { id: string; op: string }[] = [];
  const sock: ExtSocket = {
    send(data: string) {
      const { id, op } = JSON.parse(data) as { id: string; op: string };
      asked.push({ id, op });
    },
    close() {},
  };
  const answer = (id: string, value: unknown) => bridge.handleMessage(JSON.stringify({ id, value }), sock);
  return { sock, asked, answer };
}

afterEach(() => {
  jest.useRealTimers();
});

// 10-13: tabs.list went unanswered for minutes while the extension answered
// pages' relays, and map's opens each waited out 30 s on it.
test("two requests of one kind in a row that time out make it stuck: the next fails at once, naming the fix, and /health says so", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  pastGrace(bridge, ext.sock);
  await timesOut(bridge, "tabs.list", 5000);
  expect(bridge.health()).toMatchObject({ connected: true, stuck: false, timeouts: { "tabs.list": 1 } });
  await timesOut(bridge, "tabs.list", 5000);
  expect(bridge.health()).toMatchObject({ connected: true, stuck: true, sinceAnswerMs: 30000, timeouts: { "tabs.list": 2 } });
  expect(recent().at(-1)).toMatchObject({ kind: "stuck", op: "tabs.list" });
  await expect(bridge.request("tabs.list")).rejects.toThrow(/^extension stuck: .* tabs\.list requests .*run safari extension reload/);
  expect(ext.asked).toEqual(["tabs.list", "tabs.list"]);
});

// 10-16: a deploy's connect took 6 s to adopt Safari's tabs, two tabs.list
// requests sent 3 and 7 s after it timed out, and every tabs.list then
// failed at once for 12 s.
test("requests sent in the first 20 s after a connect make nothing stuck, however many time out; later ones do", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  bridge.attach(ext.sock);
  // sent at 0, 5, 10, and 15 s
  for (let i = 0; i < 4; i++) await timesOut(bridge, "tabs.list", 5000);
  expect(bridge.health()).toMatchObject({ stuck: false, timeouts: {} });
  // sent at 20 and 25 s
  await timesOut(bridge, "tabs.list", 5000);
  await timesOut(bridge, "tabs.list", 5000);
  expect(bridge.health()).toMatchObject({ stuck: true, timeouts: { "tabs.list": 2 } });
  expect(ext.asked).toHaveLength(6);
});

test("an answer to another kind leaves a stuck kind stuck, and a page or a site that holds its requests makes nothing stuck", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = holding(bridge);
  pastGrace(bridge, ext.sock);
  await timesOut(bridge, "tabs.list", 5000);
  await timesOut(bridge, "tabs.list", 5000);
  const focus = bridge.request("windows.focus", [1]);
  await settled();
  ext.answer(ext.asked[2].id, "focused");
  expect(await focus).toBe("focused");
  await expect(bridge.request("tabs.list")).rejects.toThrow("extension stuck:");
  for (const op of ["relay", "relay", "shot", "shot", "fetchFile", "fetchFile"]) await timesOut(bridge, op, 30000);
  expect(bridge.health().timeouts).toEqual({ "tabs.list": 2 });
});

test("a stuck kind lets one request through each ten seconds, and its answer ends it", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = holding(bridge);
  pastGrace(bridge, ext.sock);
  await timesOut(bridge, "tabs.list", 5000);
  await timesOut(bridge, "tabs.list", 5000);
  jest.advanceTimersByTime(9000);
  await expect(bridge.request("tabs.list")).rejects.toThrow("extension stuck:");
  jest.advanceTimersByTime(1000);
  const trial = bridge.request("tabs.list");
  await settled();
  // the rest still fail at once while the trial waits
  await expect(bridge.request("tabs.list")).rejects.toThrow("extension stuck:");
  expect(ext.asked.map((a) => a.op)).toEqual(["tabs.list", "tabs.list", "tabs.list"]);
  ext.answer(ext.asked[2].id, ["a tab"]);
  expect(await trial).toEqual(["a tab"]);
  expect(bridge.health()).toMatchObject({ stuck: false, timeouts: {} });
  expect(bridge.health().timeouts).toEqual({});
  expect(recent().at(-1)).toMatchObject({ kind: "unstuck", op: "tabs.list" });
  const next = bridge.request("tabs.list");
  await settled();
  ext.answer(ext.asked[3].id, []);
  expect(await next).toEqual([]);
});

// An answer that comes after its request timed out still shows the
// extension answers that kind: it is slow, not stuck.
test("a late answer ends its kind's run of timeouts", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = holding(bridge);
  pastGrace(bridge, ext.sock);
  await timesOut(bridge, "windows.open", 30000);
  ext.answer(ext.asked[0].id, "late");
  await timesOut(bridge, "windows.open", 30000);
  expect(bridge.health()).toMatchObject({ stuck: false, timeouts: { "windows.open": 1 } });
});

test("an extension that connects again is not stuck", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const old = extension(bridge);
  const back = extension(bridge, "back");
  pastGrace(bridge, old.sock);
  await timesOut(bridge, "tabs.list", 5000);
  await timesOut(bridge, "tabs.list", 5000);
  bridge.detach(old.sock);
  bridge.attach(back.sock);
  expect(await bridge.request("tabs.list")).toBe("back");
});

// A page slow to answer, or Safari on a swapping Mac, keeps one request past
// its limit while the extension is fine, and a reload fails every other.
test("one request that times out, however long it waited, does not reload the extension", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  pastGrace(bridge, ext.sock);
  await timesOut(bridge, "windows.open", 120000);
  expect(ext.asked).toEqual(["windows.open"]);
});

// Time nothing waited on the extension is not time it failed to answer.
test("requests that time out an hour apart, nothing asked between them, do not reload the extension", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  pastGrace(bridge, ext.sock);
  await timesOut(bridge, "windows.open", 30000);
  jest.advanceTimersByTime(60 * 60_000);
  await timesOut(bridge, "windows.open", 30000);
  expect(ext.asked).toEqual(["windows.open", "windows.open"]);
});

// 10-13: the connected extension answered nothing for over two minutes, its
// page running all along, until it was turned off and on in Safari
// Settings, and turning it on made macOS ask the owner for his password. A
// reload brings it back asking nothing.
test("a kind unanswered for a minute while it is asked has the extension reload itself, and the journal says why", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  pastGrace(bridge, ext.sock);
  // tabs.list stuck for 10 s: too soon to reload
  await timesOut(bridge, "tabs.list", 5000);
  await timesOut(bridge, "tabs.list", 5000);
  await timesOut(bridge, "windows.open", 30000);
  expect(ext.asked).toEqual(["tabs.list", "tabs.list", "windows.open"]);
  await timesOut(bridge, "windows.open", 30000);
  expect(ext.asked.slice(3)).toEqual(["windows.open", "reload"]);
  expect(recent().at(-1)).toMatchObject({ kind: "reload", why: "windows.open went unanswered for 60 s, 2 requests in a row" });
});

// Storms ran 5 to 29 min and got one reload in 17 days. A reload fails
// every request in flight, and two that did not help will not help a
// moment later.
test("a reload that does not help is followed by a second a minute later, and by no third within ten minutes", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const reloads: number[] = [];
  let start = 0;
  pastGrace(bridge, {
    send(data: string) {
      if (data === '{"op":"reload"}') reloads.push((Date.now() - start) / 1000);
    },
    close() {},
  });
  start = Date.now();
  // an agent asks every ten seconds; while stuck, all but the trial fail at once
  while (Date.now() - start < 11 * 60_000) {
    void bridge.request("windows.open", [], 30000).catch(() => {});
    await settled();
    jest.advanceTimersByTime(10_000);
  }
  expect(reloads).toEqual([60, 140, 660]);
});

// 10-13: the sweep, the agent windows' pages, and agents asked for the tab
// list over each other, 191 of a storm's 235 timeouts.
test("tabs.list callers at one moment share one request, each with its own limit", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = holding(bridge);
  bridge.attach(ext.sock);
  const quick = bridge.request("tabs.list", [], 2000);
  const patient = bridge.request("tabs.list", [], 30000);
  await settled();
  jest.advanceTimersByTime(500);
  const late = bridge.request("tabs.list");
  await settled();
  expect(ext.asked.map((a) => a.op)).toEqual(["tabs.list"]);
  jest.advanceTimersByTime(1500);
  await expect(quick).rejects.toThrow("timed out after 2000ms");
  ext.answer(ext.asked[0].id, ["a tab"]);
  expect(await Promise.all([patient, late])).toEqual([["a tab"], ["a tab"]]);
});

// A caller that closed a tab lists the tabs after the close.
test("a tabs.list asked after the extension answered something else shares none asked before", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = holding(bridge);
  bridge.attach(ext.sock);
  const before = bridge.request("tabs.list");
  const close = bridge.request("tabs.close", [7]);
  await settled();
  ext.answer(ext.asked[1].id, { closed: 7 });
  await close;
  const after = bridge.request("tabs.list");
  await settled();
  expect(ext.asked.map((a) => a.op)).toEqual(["tabs.list", "tabs.close", "tabs.list"]);
  ext.answer(ext.asked[0].id, ["tab 7", "tab 8"]);
  ext.answer(ext.asked[2].id, ["tab 8"]);
  expect([await before, await after]).toEqual([["tab 7", "tab 8"], ["tab 8"]]);
});

test("/health counts how long each kind of request took to answer, a page's by its op", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = holding(bridge);
  bridge.attach(ext.sock);
  const list = bridge.request("tabs.list");
  const click = bridge.tab(7, "click", []);
  await settled();
  jest.advanceTimersByTime(300);
  ext.answer(ext.asked[0].id, []);
  jest.advanceTimersByTime(3000);
  ext.answer(ext.asked[1].id, "clicked");
  await Promise.all([list, click]);
  const { boundsMs, ops } = bridge.latency();
  expect(boundsMs[ops["tabs.list"].indexOf(1)]).toBe(500);
  expect(boundsMs[ops["relay click"].indexOf(1)]).toBe(5000);
});

// safari extension reload: the reload a stuck extension gets, asked for.
test("a reload asked for is done once the extension connects again, and fails at once when none is connected", async () => {
  const bridge = new Bridge();
  await expect(bridge.reload()).rejects.toThrow("not connected");
  const old = extension(bridge);
  const back = extension(bridge);
  bridge.attach(old.sock);
  const reloaded = bridge.reload();
  expect(old.asked).toEqual(["reload"]);
  expect(await Promise.race([reloaded, Promise.resolve("waiting")])).toBe("waiting");
  bridge.detach(old.sock);
  bridge.attach(back.sock);
  expect(await reloaded).toEqual({ ms: expect.any(Number) });
});

// The log held only timeouts, so no one could say which kinds of request
// were slow (DaemonLogs).
test("an answer that took over 5 s is noted slow with its kind and time, and a page's is left to the page", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = holding(bridge);
  bridge.attach(ext.sock);
  const list = bridge.request("tabs.list", [], 30000);
  const click = bridge.tab(7, "click", []);
  await settled();
  jest.advanceTimersByTime(6000);
  ext.answer(ext.asked[0].id, []);
  ext.answer(ext.asked[1].id, { ok: true });
  await Promise.all([list, click]);
  expect(recent(1)).toMatchObject([{ kind: "slow", op: "tabs.list", ms: 6000 }]);
});
