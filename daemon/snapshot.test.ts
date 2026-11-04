import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
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
  connect({
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

// In the logs from 09-28 to 10-19 agents read a tab with snapshot in the
// turn after 373 actions on it: snapshot: true could have given 92 of
// those reads, and the rest asked for some words or a region, or came
// after a wait. Safari here answers each request at once, for a cart page
// whose snapshot keeps the lines with the words its query names, and
// records each request sent to the page.
function cartSafari() {
  const sent: string[] = [];
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data);
      if (op === "relay") sent.push(args[1]);
      const read: { query?: string } | undefined = op === "relay" && args[1] === "snapshot" ? args[2][0] : undefined;
      const lines = ['[1] button "Pay"', "Total $42.10", "Shipping $5.00"].filter((l) => read?.query === undefined || l.includes(read.query));
      const value = op !== "relay" ? [] : read ? { url: "https://shop.example/cart", title: "Cart", nodes: 3, truncated: false, snapshot: lines.join("\n") } : args[1] === "wait" ? { found: true } : { ok: true };
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  });
  return sent;
}

test("an action or a wait answers with the page after it, whole or only the lines with the words its snapshot names", async () => {
  cartSafari();
  expect(await callTool("click", { tab: 7, ref: "Next", snapshot: "Total" })).toMatchObject({ page: { snapshot: "Total $42.10" } });
  expect(await callTool("wait", { tab: 7, text: "Total", snapshot: true })).toMatchObject({ found: true, page: { snapshot: '[1] button "Pay"\nTotal $42.10\nShipping $5.00' } });
});

test("invalid action snapshot options refuse before the page receives an action", async () => {
  const sent = cartSafari();
  await expect(callTool("click", { tab: 7, ref: "Next", snapshot: { selector: "main" } })).rejects.toBeInstanceOf(Error);
  await expect(callTool("wait", { tab: 7, text: "Total", snapshot: 3 })).rejects.toBeInstanceOf(Error);
  expect(sent).toEqual([]);
});

// From 10-07 to 10-12 agents gave snapshot interactive seven times, as the
// repl's snapshot takes it, and each call failed. The read is a view of
// the page, as one with a query is, so a diff after it still runs from
// the last whole page. Safari here answers each request at once with a
// sign-in form whose fields sit indented under it.
const SIGN_IN = 'form "Sign in"\n  [1] textbox "Email"\n  Forgot your email?\n  [2] button "Next"';

test("a snapshot with interactive keeps only the lines with refs, unindented", async () => {
  connect({
    send(data: string) {
      const { id, op } = JSON.parse(data);
      const value = op === "relay" ? { url: "https://shop.example/login", title: "Sign in", nodes: 4, truncated: false, snapshot: SIGN_IN } : [];
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  });
  expect(await callTool("snapshot", { tab: 8 })).toMatchObject({ snapshot: SIGN_IN });
  expect(await callTool("snapshot", { tab: 8, interactive: true })).toMatchObject({ snapshot: '[1] textbox "Email"\n[2] button "Next"' });
  expect(await callTool("snapshot", { tab: 8, diff: true })).toMatchObject({ snapshot: "(no change)" });
});
