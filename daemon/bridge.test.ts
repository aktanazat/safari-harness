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
  expect(bridge.connected).toBe(false);
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

afterEach(() => {
  jest.useRealTimers();
});

// 10-13: the connected extension answered nothing for over two minutes, its
// page running all along, until it was turned off and on in Safari
// Settings, and turning it on made macOS ask the owner for his password. A
// reload brings it back asking nothing.
test("an extension that answers nothing for a minute while requests time out is asked to reload itself, and the journal says why", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  bridge.attach(ext.sock);
  for (const [op, ms] of [["tabs.list", 5000], ["windows.open", 30000], ["tabs.list", 5000]] as const) await timesOut(bridge, op, ms);
  expect(ext.asked).toEqual(["tabs.list", "windows.open", "tabs.list"]);
  await timesOut(bridge, "windows.open", 30000);
  expect(ext.asked.slice(3)).toEqual(["windows.open", "reload"]);
  expect(recent().at(-1)).toMatchObject({ kind: "reload", why: expect.any(String) });
});

// A page slow to answer, or Safari on a swapping Mac, keeps one request past
// its limit while the extension is fine, and a reload fails every other.
test("one request that times out, however long it waited, does not reload the extension", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  bridge.attach(ext.sock);
  await timesOut(bridge, "fetchFile", 120000);
  expect(ext.asked).toEqual(["fetchFile"]);
});

// An answer that comes after its request timed out still shows the
// extension answers: it is slow, not stuck.
test("an extension that answers late is not stuck: the next request to time out does not reload it", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const asked: string[] = [];
  let probe = "";
  const slow: ExtSocket = {
    send(data: string) {
      const { id, op } = JSON.parse(data) as { id: string; op: string };
      asked.push(op);
      if (op === "probe") probe = id;
    },
    close() {},
  };
  bridge.attach(slow);
  await timesOut(bridge, "probe", 2000);
  bridge.handleMessage(JSON.stringify({ id: probe, value: "late" }), slow);
  await timesOut(bridge, "fetchFile", 120000);
  expect(asked).toEqual(["probe", "fetchFile"]);
});

// Time nothing waited on the extension is not time it failed to answer.
test("requests that time out an hour apart, nothing asked between them, do not reload the extension", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  bridge.attach(ext.sock);
  await timesOut(bridge, "probe", 2000);
  jest.advanceTimersByTime(60 * 60_000);
  await timesOut(bridge, "probe", 2000);
  expect(ext.asked).toEqual(["probe", "probe"]);
});

// A reload fails every request in flight, and one that did not help will
// not help a moment later.
test("a stuck extension is asked to reload once each ten minutes at most", async () => {
  jest.useFakeTimers();
  const bridge = new Bridge();
  const ext = extension(bridge);
  bridge.attach(ext.sock);
  for (let i = 0; i < 3; i++) await timesOut(bridge, "windows.open", 30000);
  expect(ext.asked).toEqual(["windows.open", "windows.open", "reload", "windows.open"]);
  jest.advanceTimersByTime(10 * 60_000);
  await timesOut(bridge, "windows.open", 30000);
  expect(ext.asked.slice(4)).toEqual(["windows.open", "reload"]);
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
