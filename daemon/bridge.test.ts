import { afterEach, expect, jest, test } from "bun:test";
import { Bridge, MESSAGE_MAX, type ExtSocket } from "./bridge.ts";
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

test("an extension whose socket stopped answering is replaced: that socket's actions fail, and its late close leaves the new one serving", async () => {
  const bridge = new Bridge(5);
  const old = extension(bridge);
  const now = extension(bridge, "answered by the new socket");
  bridge.attach(old.sock);
  const lost = bridge.request("tabs.open", ["https://example.com/"], 60000);
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

// 10-28 to 10-29 the link dropped 533 times, Bun closing it at a message of
// about 25.5 MB it seems, and nothing kept why (StormRootCause).
test("a link Bun closed at a message too large tells the caller so, and the journal keeps its close code, reason, and the requests it failed", async () => {
  const bridge = new Bridge();
  const ext = extension(bridge);
  bridge.attach(ext.sock);
  const lost = bridge.request("relay", [7, "click", ["e1"]], 60000);
  await ext.sent;
  bridge.detach(ext.sock, 1006, "Received too big message");
  await expect(lost).rejects.toThrow("MB its link carries");
  expect(recent().findLast((e) => e.kind === "disconnect")).toMatchObject({ code: 1006, reason: "Received too big message", cause: "too_large", unanswered: { "relay click": 1 } });
  expect(bridge.health().drops).toEqual({ too_large: 1 });
});

test("a read in flight when the link drops is asked once more of the extension that comes back; an action is not", async () => {
  const bridge = new Bridge();
  const gone = holding(bridge);
  bridge.attach(gone.sock);
  const read = bridge.request("relay", [7, "snapshot", [{}]], 60000);
  const act = bridge.request("relay", [7, "click", ["e1"]], 60000);
  await settled();
  expect(gone.asked).toHaveLength(2);
  bridge.detach(gone.sock, 1000, "");
  await expect(act).rejects.toThrow("disconnected before it answered");
  const back = holding(bridge);
  bridge.attach(back.sock);
  await settled();
  expect(back.asked.map((a) => a.op)).toEqual(["relay"]);
  back.answer(back.asked[0].id, "the page");
  expect(await read).toBe("the page");
});

// Until the extension hears it, it holds its answers to Bun's 16 MB default.
test("a hello is answered with the most a message on the link may hold", () => {
  const bridge = new Bridge();
  const said: unknown[] = [];
  const sock: ExtSocket = { send: (data: string) => void said.push(JSON.parse(data)), close() {} };
  bridge.attach(sock);
  bridge.handleMessage(JSON.stringify({ op: "hello", role: "extension", ua: "test" }), sock);
  expect(said).toContainEqual({ op: "limit", bytes: MESSAGE_MAX });
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
test("two requests of one kind in a row that time out make it stuck: the harness's own next one fails at once, and /health says so", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  pastGrace(bridge, ext.sock);
  await timesOut(bridge, "tabs.list", 5000);
  expect(bridge.health()).toMatchObject({ connected: true, stuck: false, timeouts: { "tabs.list": 1 } });
  await timesOut(bridge, "tabs.list", 5000);
  expect(bridge.health()).toMatchObject({ connected: true, stuck: true, sinceAnswerMs: 30000, timeouts: { "tabs.list": 2 } });
  await expect(bridge.request("tabs.list")).rejects.toThrow("extension stuck: the Safari extension has answered none of the last 2 tabs.list requests (for 10 s); try again in a minute");
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
test("a kind unanswered for a minute while it is asked has the extension reload itself", async () => {
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

// 10-05 to 10-19: in 17 stuck spells agents' calls failed at once 44
// times, each telling the agent to reload the extension, and agents ran
// safari extension reload 27 times.
test("a model's calls that meet a stuck kind share one reload of the extension, go out once it is back, and learn how long they waited", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const old = holding(bridge);
  pastGrace(bridge, old.sock);
  await timesOut(bridge, "tabs.list", 5000);
  await timesOut(bridge, "tabs.list", 5000);
  const calls = Promise.all([bridge.healing(() => bridge.request("tabs.list")), bridge.healing(() => bridge.request("tabs.list"))]);
  await settled();
  expect(old.asked.map((a) => a.op)).toEqual(["tabs.list", "tabs.list", "reload"]);
  jest.advanceTimersByTime(2000);
  const back = holding(bridge);
  bridge.detach(old.sock);
  bridge.attach(back.sock);
  await settled();
  for (const { id } of back.asked) back.answer(id, ["a tab"]);
  expect(await calls).toEqual([{ value: ["a tab"], reloadedMs: 2000 }, { value: ["a tab"], reloadedMs: 2000 }]);
});

// A reload fails every request in flight, and two that did not help will
// not help a moment later.
test("past two reloads in ten minutes, a model's call that meets a stuck kind fails at once, as the harness's own do", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  let ext = holding(bridge);
  for (let i = 0; i < 2; i++) {
    pastGrace(bridge, ext.sock);
    await timesOut(bridge, "tabs.list", 5000);
    await timesOut(bridge, "tabs.list", 5000);
    const healed = bridge.healing(() => bridge.request("tabs.list"));
    await settled();
    const back = holding(bridge);
    bridge.detach(ext.sock);
    bridge.attach(back.sock);
    await settled();
    back.answer(back.asked[0].id, []);
    expect(await healed).toEqual({ value: [], reloadedMs: 0 });
    ext = back;
  }
  pastGrace(bridge, ext.sock);
  await timesOut(bridge, "tabs.list", 5000);
  await timesOut(bridge, "tabs.list", 5000);
  await expect(bridge.healing(() => bridge.request("tabs.list"))).rejects.toThrow("extension stuck: the Safari extension has answered none of the last 2 tabs.list requests (for 10 s), and it was reloaded 2 times in the last 10 minutes");
  expect(ext.asked.map((a) => a.op)).toEqual(["tabs.list", "tabs.list", "tabs.list"]);
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

