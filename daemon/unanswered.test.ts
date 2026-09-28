import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { callTool } from "./tools.ts";
import * as unanswered from "./unanswered.ts";

// Safari fails a request that got no answer with only "Load failed". The
// page here fails every fetch so; DNS is a fake that knows one host.
bridge.attach({
  send(data: string) {
    const { id } = JSON.parse(data) as { id: string };
    bridge.handleMessage(JSON.stringify({ id, error: "Load failed" }));
  },
  close() {},
});
afterEach(() => mock.restore());

// On 09-28 an agent took "Load failed" for this Mac's network, when the
// host it built from a dealer page's settings existed nowhere.
test("a request that got no answer says whether its host exists", async () => {
  spyOn(unanswered, "hostResolves").mockImplementation(async (host) => host === "shop.example");
  await expect(callTool("fetch", { tab: 7, url: "https://gone.example/1/query" })).rejects.toThrow(/no such host as gone\.example/);
  const reached = callTool("fetch", { tab: 7, url: "https://shop.example/1/query" });
  await expect(reached).rejects.toThrow(/shop\.example exists/);
  await expect(reached).rejects.not.toThrow(/no such host/);
});
