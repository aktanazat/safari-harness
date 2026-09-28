import { expect, test } from "bun:test";
import { Bridge, type ExtSocket } from "./bridge.ts";

// An extension socket that answers every request with value, or never.
function extension(bridge: Bridge, value?: string) {
  const asked: string[] = [];
  const first = Promise.withResolvers<void>();
  const sock: ExtSocket = {
    send(data: string) {
      const { id, op } = JSON.parse(data) as { id: string; op: string };
      asked.push(op);
      first.resolve();
      if (value !== undefined) queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  };
  return { sock, asked, sent: first.promise };
}

test("an extension that reconnects takes over: the old socket's requests fail at once, and its late close leaves the new one serving", async () => {
  const bridge = new Bridge();
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
