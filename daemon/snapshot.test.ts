import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { callTool } from "./tools.ts";

// A snapshot says when the tab shows a bot check (challenge.ts), which may
// sit in any of its frames, so every frame is asked: the probe. It goes out
// with the snapshot request. Sent after the snapshot's answer, it added 5 of
// the 14 ms a snapshot of cnn.com took, and 3 ms on pages without frames.

// Safari as the daemon sees it: it records each request ("relay:<op>" for
// one sent to the page) and answers only when the test lets it. The probe
// finds a Cloudflare check box in a frame of the page.
function heldSafari() {
  const sent: string[] = [];
  const held: (() => void)[] = [];
  bridge.attach({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      sent.push(op === "relay" ? `relay:${args[1]}` : op);
      const value = op === "probe"
        ? [{ frame: 0, url: "https://shop.example/login", title: "Sign in", text: "", markers: [], answered: [], frames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile"] }]
        : { url: "https://shop.example/login", title: "Sign in", nodes: 1, truncated: false, snapshot: '[1] button "Sign in"' };
      held.push(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  });
  return { sent, answer: () => held.splice(0).forEach((a) => a()) };
}

test("a snapshot asks every frame about a bot check while the page is still being read", async () => {
  const safari = heldSafari();
  const snap = callTool("snapshot", { tab: 7 });
  // Up to Safari's answer, the call runs in microtasks, which all run
  // before an immediate callback.
  const settled = Promise.withResolvers<void>();
  setImmediate(settled.resolve);
  await settled.promise;
  expect(safari.sent).toEqual(["relay:snapshot", "probe"]);
  safari.answer();
  expect(await snap).toMatchObject({ snapshot: '[1] button "Sign in"', challenge: { kind: "cloudflare", where: "box" } });
});
