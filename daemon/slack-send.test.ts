import { expect, test } from "bun:test";
import { HarnessError } from "./failures.ts";
import { refuseSlackSend, type SlackAct } from "./slack-send.ts";

// Slack's page as read on 11-16 (app.slack.com): the send button's and the
// message box's data-qa.
const CHANNEL = "https://app.slack.com/client/T07MNHAAG73/C0CFLHVL5ML";
const SEND = "texty_send_button";
const BOX = "texty_input";

const refused = (url: string, act: SlackAct, qa: string | null) => refuseSlackSend(url, act, async () => qa).then(() => false, (e: unknown) => e instanceof HarnessError && e.code === "blocked");

test.each([
  ["a click on the send button", { tool: "click" }, SEND],
  ["Enter in the message box", { tool: "press", key: "Enter" }, BOX],
  ["Cmd+Enter in the message box", { tool: "press", key: "Cmd+Enter" }, BOX],
  ["text with a line break typed in the message box", { tool: "type", text: "done\n" }, BOX],
] as [string, SlackAct, string][])("%s on Slack is refused", async (_, act, qa) => {
  expect(await refused(CHANNEL, act, qa)).toBe(true);
});

test.each([
  ["Shift+Enter in the message box", CHANNEL, { tool: "press", key: "Shift+Enter" }, BOX],
  ["text without a line break in the message box", CHANNEL, { tool: "type", text: "a draft for him to send" }, BOX],
  ["Enter in Slack's search", CHANNEL, { tool: "press", key: "Enter" }, null],
  ["a click on the same button on another site", "https://example.com/chat", { tool: "click" }, SEND],
] as [string, string, SlackAct, string | null][])("%s goes ahead", async (_, url, act, qa) => {
  expect(await refused(url, act, qa)).toBe(false);
});
