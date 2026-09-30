import { expect, test } from "bun:test";
import type { Invoke } from "../call.ts";
import { gmail } from "./google.ts";
import { SiteKit } from "./kit.ts";

// Safari as the gmail global sees it: the n-th tab opened lands on the Gmail
// inbox of account landing[n - 1], and an eval in a live tab answers with the
// print view of a thread holding messages, as read in the page (google.ts).
const ID = "18c2f0a1b2c3d4e5";

type Message = { from: string; date: string; lines: string[]; body: string; attachments: { url: string; name: string; size: string }[] };

function safari(messages: Message[], landing: number[] = [0]) {
  const live = new Map<number, number>();
  let opened = 0;
  const send: Invoke = async (tool, args) => {
    if (tool === "open") {
      opened += 1;
      live.set(opened, landing[opened - 1] ?? 0);
      return { id: opened };
    }
    if (tool === "tabs") return [...live].map(([id, account]) => ({ id, url: `https://mail.google.com/mail/u/${account}/#inbox`, title: "Inbox (2) - Gmail" }));
    const account = live.get(Number(args.tab));
    if (account === undefined) throw new Error("that tab is gone: it was closed at the end of your turn, after 20 minutes unused, or by the user");
    return { result: { status: 200, url: `https://mail.google.com/mail/u/${account}/?view=pt&search=all&th=${ID}`, subject: "Your order", messages } };
  };
  return { mail: gmail(new SiteKit(send)), close: (tab: number) => live.delete(tab) };
}

function message(body: string, attachments: Message["attachments"] = []): Message {
  return { from: "DoorDash <no-reply@doordash.com>", date: "Sat, Sep 26, 2026 at 12:51 AM", lines: ["To: Aktan <aktanaazat@gmail.com>"], body, attachments };
}

test("a message body reads without the characters mail templates pad it with", async () => {
  const padding = "\u00ad\u034f \u2007\u00ad\u034f \u2007\u200c\u00a0\u200d\u2060\ufeff".repeat(3);
  const { mail } = safari([message(`<div style="display:none">${padding}</div><p>Your receipt\u200b is attached.</p><p>Total: $12.40</p>`)]);
  const thread = await mail.getThread(0, ID);
  expect(thread.messages[0].body).toBe("Your receipt is attached.\n\nTotal: $12.40");
});

test("a thread lists every message's attachments, each with the message it came in", async () => {
  const pdf = { url: `?ui=2&ik=abc123&view=att&th=${ID}&attid=0.1&disp=attd&safe=1&zw`, name: "contract.pdf", size: "289 KB" };
  const { mail } = safari([message("<p>Here it is.</p>"), message("<p>Signed.</p>", [pdf])]);
  const thread = await mail.getThread(0, ID);
  expect(thread.attachments).toEqual([{ ...thread.messages[1].attachments[0], message: 1 }]);
  expect(thread.attachments[0].name).toBe("contract.pdf");
});

test("a message that is only quoted text says so", async () => {
  const { mail } = safari([message("<p>Here it is.</p>"), message("<div>[Quoted text hidden]</div>")]);
  const thread = await mail.getThread(0, ID);
  expect(thread.messages.map((m) => m.quotedOnly)).toEqual([undefined, true]);
});

test("a Gmail tab gone since the last call gives way to a new one, checked for its account before a read", async () => {
  const { mail, close } = safari([message("<p>Hi</p>")], [0, 0, 1]);
  await mail.getThread(0, ID);
  close(1);
  expect((await mail.getThread(0, ID)).messages[0].body).toBe("Hi");
  // The third tab lands on /u/1/, as when account 0 signed out meanwhile.
  close(2);
  await expect(mail.getThread(0, ID)).rejects.toThrow("no Google account at index 0 in Safari (Gmail opened /u/1/ instead)");
});
