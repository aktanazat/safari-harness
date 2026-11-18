// A Slack message sent from Slack's own page skips the draft the owner
// approves (sites/slack.ts, kit.ts draftOrSend). On 11-11 and 11-16 agents
// posted that way, by click on the send button and by Enter in the
// message box, and on 11-16 one saved the route as a site note for every
// agent after it. The owner chose (11-16) that such a send is refused:
// agents send through the slack global's drafts alone. Typing in the box
// stays allowed, so a draft can wait there for him to send; a line break
// typed there is refused, since the box may send on it.
//
// Code run in the page is refused when it names the send button, or the
// message box together with an Enter: on 11-11 an agent listed the send
// buttons by data-qa with eval before clicking one, and on 11-16 one
// readied the box with a script (LOCK#864, LOCK#1945). A script that finds
// the button some other way is not caught.
//
// Slack's page as read on 11-16 (app.slack.com): the send button is
// button[data-qa=texty_send_button], with its icon inside; the message box
// is div.ql-editor[data-qa=texty_input], focused itself when it takes keys.

import { HarnessError } from "./failures.ts";

const SLACK = /(?:^|\.)slack\.com$/;
const ENTER = /^(?:(?:cmd|meta|command|ctrl|control)\+)?(?:enter|return)$/i;

const REFUSED = "a message sent from Slack's own page skips the draft the owner approves; send it with the slack global in safari repl (client.postMessage, upload or update), whose draft he sees first";

export type SlackAct =
  | { tool: "click" }
  | { tool: "press"; key: string }
  | { tool: "type"; text: string }
  | { tool: "eval"; code: string };

// The data-qa of the element at at (a page expression for an element) or
// of the nearest one around it: a point on the send button lands on its
// icon, and the click goes up to the button.
export const qaAround = (at: string) => `${at}?.closest("[data-qa]")?.getAttribute("data-qa") ?? null`;

const blocked = () => new HarnessError("blocked", REFUSED, { effect: "none", next: "draft it with the slack global and show the owner the draft" });

// Refuses act when it would send a Slack message from the page at url.
// qa answers the data-qa attribute of the element act lands on: the ref's,
// the point's, or for a key without a ref, the focused element's.
export async function refuseSlackSend(url: string | undefined, act: SlackAct, qa: () => Promise<string | null | undefined>): Promise<void> {
  const host = url !== undefined && URL.canParse(url) ? new URL(url).hostname : undefined;
  if (host === undefined || !SLACK.test(host)) return;
  if (act.tool === "eval") {
    if (act.code.includes("texty_send_button") || (act.code.includes("texty_input") && /\bEnter\b|keyCode\s*[:=]+\s*13\b/.test(act.code))) throw blocked();
    return;
  }
  if (act.tool === "press" && !ENTER.test(act.key.replace(/\s+/g, ""))) return;
  if (act.tool === "type" && !/[\r\n]/.test(act.text)) return;
  const on = await qa();
  if (on === (act.tool === "click" ? "texty_send_button" : "texty_input")) throw blocked();
}
