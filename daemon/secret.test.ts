import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { invoke } from "./call.ts";
import { connect } from "./fake-safari.ts";
import * as imessage from "./imessage.ts";
import { recent } from "./journal.ts";
import { watched } from "./mission.ts";
import * as daemonRpc from "./rpc.ts";
import { callTool } from "./tools.ts";

// A stand-in page that keeps what each type put in its field, and a daemon
// port that records each call as the daemon does (mission.ts).
const CODE = "402913";
const fields: unknown[] = [];
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    if (op === "relay") fields.push(args[2]);
    queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value: op === "relay" ? { ok: true, kept: true } : [] })));
  },
  close() {},
});
afterEach(() => mock.restore());

// 01a0e50b: an agent typed an emailed code by hand, and type echoed it back.
test("{{code}} in type's text is filled from the user's texts, and the code comes back nowhere", async () => {
  spyOn(imessage, "waitCode").mockResolvedValue({ status: "received", code: CODE, from: "+15550000000", at: "2026-09-20T12:00:00.000Z", rowid: 1 });
  spyOn(daemonRpc, "rpc").mockImplementation((tool: string, args: Record<string, unknown> = {}, model = false) => watched(process.pid, tool, args, () => callTool(tool, args, model)));
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
