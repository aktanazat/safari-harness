import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { invoke } from "./call.ts";
import { CALLER_TOOLS } from "./caller.ts";
import { connect } from "./fake-safari.ts";
import * as imessage from "./imessage.ts";
import { recent } from "./journal.ts";
import { watched } from "./mission.ts";
import * as daemonRpc from "./rpc.ts";
import { tabSecrets } from "./redact.ts";
import { callTool } from "./tools.ts";

// A stand-in page that keeps what each type put in its field, shows shown
// when read, takes a login, and whose request log and own script repeat
// the code, as USCIS's code field repeated it in its name (09-30); and a
// daemon port that records each call as the daemon does (mission.ts).
// CUT_NET is the request log with the code cut, and a longer number
// holding its digits whole.
const CODE = "402913";
const fields: unknown[] = [];
let shown = "";
const selections = new Map<string, { text: string } | { error: string }>();
const answers: Record<string, unknown> = {
  netRead: { entries: [{ url: "https://my.example/verify", t: 1, body: `{"code":"${CODE}","case":"1${CODE}"}` }] },
  evalPage: { ok: true, result: `Secure Verification Code required ${CODE}` },
  fillLogin: { ok: true, filled: ["password"] },
};
const CUT_NET = { entries: [{ url: "https://my.example/verify", t: 1, body: `{"code":"...","case":"1${CODE}"}` }] };
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    const ask = op === "relay" ? String(args[1]) : op;
    const known = Object.hasOwn(answers, ask);
    if (op === "relay" && ask !== "extract" && !known) fields.push(args[2]);
    const options = op === "relay" && ask === "extract" ? (args[2] as { selector?: string }[])[0] : undefined;
    const selection = options?.selector === undefined ? { text: shown } : selections.get(options.selector) ?? { error: "source selector matches 0 elements, not one" };
    const value = ask === "extract" ? { title: "Your code", url: "https://mail.example/1", ...selection } : known ? answers[ask] : op === "relay" ? { ok: true, kept: true } : [];
    queueMicrotask(() => bridge.handleMessage(JSON.stringify(ask === "extract" && "error" in selection ? { id, error: selection.error } : { id, value })));
  },
  close() {},
});
afterEach(() => {
  mock.restore();
  fields.length = 0;
  tabSecrets.clear();
  selections.clear();
  shown = "";
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

// Threaded reset emails must not require deleting older messages to select
// the intended code. The extension boundary supplies the selected subtree.
const SECRET_TOOLS = ["type", "real_input"];
function watchSecretTyping() {
  watchedPort();
  spyOn(CALLER_TOOLS.real_input, "run").mockImplementation(async (a) => {
    fields.push(a);
    return { ok: true, kept: true };
  });
}
const secretArgs = (tool: string, from_selector: string) => ({
  tab: 6001, ref: "1", text: "{{code}}", secret: "page", from: 6002, from_selector,
  ...(tool === "real_input" ? { do: "type" } : {}),
});

test.each(SECRET_TOOLS)("%s types only the selected email's code from a two-code thread and keeps it secret", async (tool) => {
  shown = `Old code: 118822\nNew code: ${CODE}`;
  selections.set("#current-email", { text: `Enter this code: ${CODE}` });
  watchSecretTyping();
  const result = await invoke(tool, secretArgs(tool, "#current-email"), true);
  expect(result).toEqual({ ok: true, kept: true, typed: "code, 6 chars" });
  expect(fields).toEqual(tool === "type" ? [["1", CODE, { append: false, secret: true }]] : [{ tab: 6001, ref: "1", do: "type", text: CODE }]);
  expect(await callTool("net", { tab: 6001 })).toEqual(CUT_NET);
  expect(await callTool("eval", { tab: 6001, expression: "document.title", page: true })).toEqual({ ok: true, result: "Secure Verification Code required ..." });
  expect(JSON.stringify(recent(500))).not.toContain(CODE);
  expect(JSON.stringify(recent(500))).not.toContain("118822");
});

test.each(SECRET_TOOLS)("%s refuses two codes inside the selected email without naming or typing either", async (tool) => {
  shown = `Enter this code: ${CODE}`;
  selections.set("#current-email", { text: `Old code: 118822\nNew code: ${CODE}` });
  watchSecretTyping();
  const typed = invoke(tool, secretArgs(tool, "#current-email"));
  await expect(typed).rejects.toThrow("shows 2 codes, not one");
  await typed.catch((e: Error) => {
    expect(e.message).not.toContain(CODE);
    expect(e.message).not.toContain("118822");
  });
  expect(fields).toEqual([]);
});

test.each(SECRET_TOOLS)("%s refuses a missing selected email instead of typing the whole-page code", async (tool) => {
  shown = `Enter this code: ${CODE}`;
  watchSecretTyping();
  await expect(invoke(tool, secretArgs(tool, "#missing-email"))).rejects.toThrow("source selector matches 0 elements, not one");
  expect(fields).toEqual([]);
});

test.each(SECRET_TOOLS)("%s refuses an empty selected email instead of typing the whole-page code", async (tool) => {
  shown = `Enter this code: ${CODE}`;
  selections.set("#current-email", { text: "" });
  watchSecretTyping();
  await expect(invoke(tool, secretArgs(tool, "#current-email"))).rejects.toThrow("shows 0 codes, not one");
  expect(fields).toEqual([]);
});

test.each(SECRET_TOOLS)("%s refuses an empty source selector instead of typing the whole-page code", async (tool) => {
  shown = `Enter this code: ${CODE}`;
  watchSecretTyping();
  await expect(invoke(tool, secretArgs(tool, ""))).rejects.toThrow("from_selector");
  expect(fields).toEqual([]);
});

// GEICO's emailed codes are 6 capital letters and digits ("56625F", 09-30);
// such a run with no word code beside it is a policy or order number.
test("a code of letters and digits is typed when the page calls it a code, and one elsewhere is not a code", async () => {
  shown = "Your GEICO Verification Code\nUse this code to verify it's you: 5F9E8E\nRef A1B2C3\n© 2026 GEICO";
  watchedPort();
  const result = await invoke("type", { tab: 6001, ref: "1", text: "{{code}}", secret: "page", from: 6002 }, true);
  expect(result).toEqual({ ok: true, kept: true, typed: "code, 6 chars" });
  expect(fields).toEqual([["1", "5F9E8E", { append: false, secret: true }]]);
});

// A field that ignores scripted typing (GEICO's code box, 09-30) takes the
// code only from the real keyboard.
test("{{code}} in real_input's text types the code the page shows with the real keyboard, and the code comes back nowhere", async () => {
  shown = `Enter this code: ${CODE}`;
  watchedPort();
  const typed: unknown[] = [];
  spyOn(CALLER_TOOLS.real_input, "run").mockImplementation(async (a) => {
    typed.push(a);
    return { ok: true };
  });
  const result = await invoke("real_input", { tab: 6001, ref: "1", type: "{{code}}", secret: "page", from: 6002 }, true);
  expect(result).toEqual({ ok: true, typed: "code, 6 chars", note: 'used do "type" and text for type' });
  expect(typed).toEqual([{ tab: 6001, ref: "1", do: "type", text: CODE }]);
  expect(await callTool("net", { tab: 6001 })).toEqual(CUT_NET);
});

// USCIS named its code field by a label that repeats the code, and a
// snapshot printed it (09-30); a page's request log and its own script can
// hold it too. The email tab still gives it, for a second try.
test("a code typed as a secret is cut from what its tab answers after, the request log and page script too, and the email tab still gives it", async () => {
  shown = `Enter this code: ${CODE}`;
  watchedPort();
  await invoke("type", { tab: 6003, ref: "1", text: "{{code}}", secret: "page", from: 6002 }, true);
  expect(await callTool("net", { tab: 6003 })).toEqual(CUT_NET);
  expect(await callTool("eval", { tab: 6003, expression: "document.title", page: true })).toEqual({ ok: true, result: "Secure Verification Code required ..." });
  expect(await invoke("type", { tab: 6003, ref: "1", text: "{{code}}", secret: "page", from: 6002 }, true)).toEqual({ ok: true, kept: true, typed: "code, 6 chars" });
});

test("a text an agent types as a secret itself, or a password filled from Bitwarden, is cut from what its tab answers after", async () => {
  await callTool("type", { tab: 6004, ref: "1", text: CODE, secret: true });
  await callTool("login_fill", { tab: 6005, site: "my.example", password: CODE });
  expect([await callTool("net", { tab: 6004 }), await callTool("net", { tab: 6005 })]).toEqual([CUT_NET, CUT_NET]);
});
