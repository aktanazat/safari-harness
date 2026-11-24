import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { HarnessError } from "./failures.ts";
import { callTool } from "./tools.ts";

// Slack's page as read on 11-16 (app.slack.com): a channel, and the send
// button's data-qa.
const CHANNEL = "https://app.slack.com/client/T07MNHAAG73/C0CFLHVL5ML";

// A Safari with one Slack tab, tab, whose send button is ref 3. tabsUrl:
// whether its extension knows tabs.url (one from before the op answers an
// error, as background.js does for an op it lacks). asked counts each op.
function safari(tab: number, tabsUrl: boolean) {
  const asked: Record<string, number> = {};
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id?: string; op: string; args: unknown[] };
      if (id === undefined) return;
      asked[op] = (asked[op] ?? 0) + 1;
      const answer = (reply: object) => queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
      if (op === "tabs.url") return answer(tabsUrl ? { value: CHANNEL } : { error: "unknown bg op tabs.url" });
      if (op === "tabs.list") return answer({ value: [{ id: tab, url: CHANNEL, title: "general (Channel) - Slack", windowId: 1, active: true, front: true }] });
      if (op === "relay" && args[1] === "element") return answer({ value: { value: "texty_send_button" } });
      answer({ value: { ok: true } });
    },
    close() {},
  });
  return asked;
}

const refused = (tool: string, args: Record<string, unknown>) => callTool(tool, args).then(() => false, (e: unknown) => e instanceof HarnessError && e.code === "blocked");

test("a click on Slack's send button is refused by the tab's own address, without listing every tab, and a second one within 2 s asks for no address again", async () => {
  const asked = safari(7, true);
  expect(await refused("click", { tab: 7, ref: 3 })).toBe(true);
  expect(await refused("click", { tab: 7, ref: 3 })).toBe(true);
  expect(asked["tabs.list"]).toBeUndefined();
  expect(asked["tabs.url"]).toBe(1);
});

test("with an extension from before tabs.url, the click is refused by the tab list, as before", async () => {
  const asked = safari(8, false);
  expect(await refused("click", { tab: 8, ref: 3 })).toBe(true);
  expect(asked["tabs.list"]).toBe(1);
});
