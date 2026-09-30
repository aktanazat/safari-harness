import { afterEach, expect, jest, test } from "bun:test";
import type { Invoke } from "../call.ts";
import { gmail, type GmailThreadSummary } from "./google.ts";
import { SiteKit } from "./kit.ts";

// Safari as the gmail global sees it: the n-th tab opened lands on the Gmail
// inbox of account landing[n - 1]. In a live tab, an eval that sets a search
// hash runs that search on mailbox, one that reads the list gets the rows
// the search found, and any other answers with the print view of a thread
// holding messages, each as read in the page (google.ts).
const ID = "18c2f0a1b2c3d4e5";
const THREAD = "19a0c3d4e5f60718";
const OLDER = "19a0c3d4e5f60700";

type Message = { from: string; date: string; lines: string[]; body: string; attachments: { url: string; name: string; size: string }[] };

// A message in the fake mailbox: its thread's id, when it came (the time its
// id carries), whether it matches the search waited on (the owner's reply
// does not match from:them), when Gmail's search begins to list it, which
// can be after it came, and the time Gmail dates it at, which can be a
// moment after it came.
type Mail = { thread: string; at: number; hit: boolean; listed?: number; shown?: number };
// A list row as the page reads it: last is the id of its thread's newest message.
type ListRow = GmailThreadSummary & { last: string };

function safari(messages: Message[], landing: number[] = [0], mailbox: Mail[] = []) {
  const live = new Map<number, number>();
  let opened = 0;
  // The list the tab shows: Gmail searches only for a hash it does not show,
  // and a hash already up keeps the rows it found.
  let view: { hash: string; rows: ListRow[] } = { hash: "#inbox", rows: [] };
  const send: Invoke = async (tool, args) => {
    if (tool === "open") {
      opened += 1;
      live.set(opened, landing[opened - 1] ?? 0);
      return { id: opened };
    }
    if (tool === "tabs") return [...live].map(([id, account]) => ({ id, url: `https://mail.google.com/mail/u/${account}/#inbox`, title: "Inbox (2) - Gmail" }));
    const account = live.get(Number(args.tab));
    if (account === undefined) throw new Error("that tab is gone: it was closed at the end of your turn, after 20 minutes unused, or by the user");
    const expression = String(args.expression);
    const to = /location\.hash = ("[^"]*")/.exec(expression)?.[1];
    if (to) {
      const hash = JSON.parse(to) as string;
      if (hash === view.hash) return { result: false };
      view = { hash, rows: search(mailbox, decodeURIComponent(hash.replace(/\+/g, " "))) };
      return { result: true };
    }
    if (expression.includes("tr.zA")) return { result: { counter: null, empty: !view.rows.length, rows: view.rows } };
    return { result: { status: 200, url: `https://mail.google.com/mail/u/${account}/?view=pt&search=all&th=${ID}`, subject: "Your order", messages } };
  };
  return { mail: gmail(new SiteKit(send)), close: (tab: number) => live.delete(tab) };
}

// Gmail's search as the probes of 2026-09-30 found it: a thread is listed
// when a message matching the search came after the after: bound; its row
// shows the newest such message's date to the minute, and carries the id of
// the thread's newest message, whatever that one matched.
function search(mailbox: Mail[], query: string): ListRow[] {
  const after = Number(/after:(\d+)/.exec(query)?.[1]) * 1000;
  const now = Date.now();
  const came = mailbox.filter((m) => m.at <= now);
  return [...new Set(came.map((m) => m.thread))].flatMap((thread) => {
    const mails = came.filter((m) => m.thread === thread);
    const hits = mails.filter((m) => m.hit && m.at >= after && (m.listed ?? m.at) <= now).map((m) => m.shown ?? m.at);
    if (!hits.length) return [];
    const newest = Math.max(...mails.map((m) => m.at));
    return [{ ...row(thread, Math.floor(Math.max(...hits) / 60_000) * 60_000), last: (BigInt(newest) << 20n).toString(16) }];
  });
}

// A thread row as search returns it, dated at.
function row(id: string, at: number): GmailThreadSummary {
  return { id, threadId: `thread-f:${BigInt(`0x${id}`)}`, from: "Apple", fromEmail: "appleid@id.apple.com", senders: [{ name: "Apple", email: "appleid@id.apple.com" }], subject: "Your Apple Account code", snippet: "Enter this code to continue.", date: new Date(at).toISOString(), unread: true };
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

afterEach(() => {
  jest.useRealTimers();
});

// setImmediate runs once every promise job has, and the fake clock leaves it be.
const settled = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

// A wait on the fake clock, which moves on 250 ms at a time once the page
// has answered all it was asked.
async function waited<T>(wait: Promise<T>): Promise<T> {
  let done = false;
  const end = () => {
    done = true;
  };
  void wait.then(end, end);
  while (!done) {
    await settled();
    jest.advanceTimersByTime(250);
  }
  return wait;
}

test("a wait for mail returns the thread that comes in while it waits, dated to the ms, and the since to pass next", async () => {
  jest.useFakeTimers();
  const at = Date.now() + 3_000;
  const { mail } = safari([], [0], [{ thread: THREAD, at, hit: true }]);
  expect(await waited(mail.waitForMail(0, "from:apple.com"))).toEqual({ status: "received", results: [row(THREAD, at)], since: at });
});

test("without since, mail from the minute before the call counts: a code often lands before the call", async () => {
  jest.useFakeTimers();
  const at = Date.now() - 20_000;
  const { mail } = safari([], [0], [{ thread: THREAD, at, hit: true }]);
  expect(await waited(mail.waitForMail(0, "from:apple.com"))).toMatchObject({ status: "received", results: [row(THREAD, at)] });
});

test("mail from before since never comes back, though Gmail's search still lists it", async () => {
  jest.useFakeTimers();
  const since = Date.now() - 10_000;
  const at = Date.now() + 3_000;
  const { mail } = safari([], [0], [{ thread: OLDER, at: since - 1, hit: true }, { thread: THREAD, at, hit: true }]);
  expect(await waited(mail.waitForMail(0, "from:apple.com", { since }))).toMatchObject({ status: "received", results: [row(THREAD, at)] });
});

test("the owner's reply in a thread a wait returned does not bring the thread back", async () => {
  jest.useFakeTimers();
  const at = Date.now() + 2_000;
  const { mail } = safari([], [0], [{ thread: THREAD, at, hit: true }, { thread: THREAD, at: at + 90_000, hit: false }]);
  const first = await waited(mail.waitForMail(0, "from:bob@example.com"));
  expect(first).toMatchObject({ status: "received", results: [row(THREAD, at)] });
  jest.advanceTimersByTime(90_000);
  expect(await waited(mail.waitForMail(0, "from:bob@example.com", { since: first.since, ms: 5_000 }))).toMatchObject({ status: "timeout" });
});

test("a wait that times out hands back its since, so mail Gmail lists only after the timeout still comes back", async () => {
  jest.useFakeTimers();
  const start = Date.now();
  // It came during the first wait; Gmail's search listed it once that wait was over.
  const late = { thread: THREAD, at: start + 1_000, hit: true, listed: start + 8_000 };
  const { mail } = safari([], [0], [late]);
  const first = await waited(mail.waitForMail(0, "from:apple.com", { ms: 5_000 }));
  expect(first.status).toBe("timeout");
  expect(await waited(mail.waitForMail(0, "from:apple.com", { since: first.since }))).toMatchObject({ status: "received", results: [row(THREAD, late.at)] });
});

test("a code Gmail dates in the minute after it came keeps its exact time, so a code resent within that minute comes back", async () => {
  jest.useFakeTimers();
  const since = Date.now();
  // Gmail dated one message of 50 in the minute after its id's (2026-09-30):
  // this code comes just before a minute begins and is dated just after.
  const minute = Math.ceil((since + 1_000) / 60_000) * 60_000;
  const code = { thread: OLDER, at: minute - 200, hit: true, shown: minute + 100 };
  const resent = { thread: THREAD, at: minute + 20_000, hit: true };
  const { mail } = safari([], [0], [code, resent]);
  jest.advanceTimersByTime(minute - since);
  const first = await waited(mail.waitForMail(0, "from:apple.com", { since }));
  expect(first).toMatchObject({ status: "received", results: [row(OLDER, code.at)] });
  jest.advanceTimersByTime(20_000);
  expect(await waited(mail.waitForMail(0, "from:apple.com", { since: first.since }))).toMatchObject({ status: "received", results: [row(THREAD, resent.at)] });
});
