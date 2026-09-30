import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { invoke } from "./call.ts";
import { connect } from "./fake-safari.ts";
import * as imessage from "./imessage.ts";
import { recent } from "./journal.ts";
import { watched } from "./mission.ts";
import * as daemonRpc from "./rpc.ts";
import { callTool } from "./tools.ts";

// A stand-in page that keeps what each type put in its field, and shows
// shown when read; and a daemon port that records each call as the daemon
// does (mission.ts).
const CODE = "402913";
const fields: unknown[] = [];
let shown = "";
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const read = op === "relay" && args[1] === "extract";
    if (op === "relay" && !read) fields.push(args[2]);
    const value = read ? { title: "Your code", url: "https://mail.example/1", text: shown } : op === "relay" ? { ok: true, kept: true } : [];
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
  },
  close() {},
});
afterEach(() => {
  mock.restore();
  fields.length = 0;
});
const watchedPort = () => spyOn(daemonRpc, "rpc").mockImplementation((tool: string, args: Record<string, unknown> = {}, model = false) => watched(process.pid, tool, args, () => callTool(tool, args, model)));

// 01a0e50b: an agent typed an emailed code by hand, and type echoed it back.
test("{{code}} in type's text is filled from the user's texts, and the code comes back nowhere", async () => {
  spyOn(imessage, "waitCode").mockResolvedValue({ status: "received", code: CODE, from: "+15550000000", at: "2026-09-20T12:00:00.000Z", rowid: 1 });
  watchedPort();
  const result = await invoke("type", { tab: 6001, ref: "1", text: "{{code}}" }, true);
  expect(result).toEqual({ ok: true, kept: true, typed: "code, 6 chars" });
  expect(fields).toEqual([["1", CODE, { append: false, secret: true }]]);
  expect(JSON.stringify(recent(500))).not.toContain(CODE);
});

test("a code that never comes by text types nothing", async () => {
  spyOn(imessage, "waitCode").mockResolvedValue({ status: "timeout", since: 0 });
  const port = spyOn(daemonRpc, "rpc");
  await expect(invoke("type", { tab: 6001, ref: "1", text: "{{code}}" }, true)).rejects.toThrow("no code came by text");
  expect(port).not.toHaveBeenCalled();
});

// An emailed code: the times, counts, years, and digits run into a word
// (Gmail's "recentdata" after Delta's footer, 09-29) around it are not codes.
test("secret page types the one code tab from shows, and the code comes back nowhere", async () => {
  shown = `Inbox 339 · Today, 16:24\nEnter this code: ${CODE}\n© 1999-2026 PayPal\nAtlanta, GA 30320-6001\n\n481516recentdata`;
  watchedPort();
  const result = await invoke("type", { tab: 6001, ref: "1", text: "{{code}}", secret: "page", from: 6002 }, true);
  expect(result).toEqual({ ok: true, kept: true, typed: "code, 6 chars" });
  expect(fields).toEqual([["1", CODE, { append: false, secret: true }]]);
  expect(JSON.stringify(recent(500))).not.toContain(CODE);
});

test("a page showing two codes types neither, and names neither", async () => {
  shown = `Old code: 118822\nNew code: ${CODE}`;
  watchedPort();
  const typed = invoke("type", { tab: 6001, ref: "1", text: "{{code}}", secret: "page", from: 6002 }, true);
  await expect(typed).rejects.toThrow("tab 6002 shows 2 codes, not one");
  await typed.catch((e: Error) => expect(e.message).not.toContain(CODE));
  expect(fields).toEqual([]);
});
