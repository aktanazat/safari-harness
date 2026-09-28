import { expect, test } from "bun:test";
import { Bridge, type ExtSocket } from "./bridge.ts";

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
