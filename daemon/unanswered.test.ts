import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool } from "./tools.ts";
import * as unanswered from "./unanswered.ts";

// Safari fails a request that got no answer with only "Load failed". The
// page here fails every fetch so; DNS is a fake that knows one host.
let refusal = "Load failed";
connect({
  send(data: string) {
    const { id } = JSON.parse(data) as { id: string };
    bridge.handleMessage(JSON.stringify({ id, error: refusal }));
  },
  close() {},
});
afterEach(() => {
  mock.restore();
  refusal = "Load failed";
});

// On 09-28 an agent took "Load failed" for this Mac's network, when the
// host it built from a dealer page's settings existed nowhere.
test("a request that got no answer says whether its host exists", async () => {
  spyOn(unanswered, "hostAnswer").mockImplementation(async (host) => (host === "shop.example" ? "found" : "missing"));
  await expect(callTool("fetch", { tab: 7, url: "https://gone.example/1/query" })).rejects.toThrow(/no such host as gone\.example/);
  const reached = callTool("fetch", { tab: 7, url: "https://shop.example/1/query" });
  await expect(reached).rejects.toThrow(/shop\.example exists/);
  await expect(reached).rejects.not.toThrow(/no such host/);
});

// On 11-17 an eval reading a page's script bundles failed whole with
// "Load failed", one cross-origin bundle refused, and said not which.
// eval's own fetch in content.js names it.
test("an eval whose fetch got no answer names the request and how to keep the others' answers", async () => {
  spyOn(unanswered, "hostAnswer").mockImplementation(async () => "found");
  refusal = "Load failed for https://cdn.other.example/bundle.js?token=abc and 2 more";
  const failed = callTool("eval", { tab: 7, expression: "1" });
  await expect(failed).rejects.toThrow(/^Load failed for https:\/\/cdn\.other\.example\/bundle\.js\?token=\.\.\. and 2 more requests: cdn\.other\.example exists, so the page's rules/);
  await expect(failed).rejects.toThrow(/Promise\.allSettled.*read: true/);
});
