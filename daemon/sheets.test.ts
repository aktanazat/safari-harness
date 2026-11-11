import { expect, spyOn, test } from "bun:test";
import { invoke } from "./call.ts";
import type { Answer, Helper } from "./groups.ts";
import * as daemonRpc from "./rpc.ts";
import { cancelSheets } from "./sheets.ts";

// Two windows as the space tool lists them (spaces.ts).
const listed = [{ id: "a", width: 1100, height: 801, look: 3 }, { id: "b", width: 1101, height: 801, look: 4 }];

// The helper finds a window by its size alone, so it is asked by the size
// the daemon gave. A caller without Accessibility permission, or one that
// finds Safari not running, makes no look: another caller's must still
// find that window due.
test("each listed window is looked at by its size, and one the helper could not look at stays the next caller's", async () => {
  const asked: unknown[] = [];
  const told: unknown[] = [];
  const answers: Answer[] = [{ ok: true, cancelled: true }, { ok: false, error: "the terminal the agent runs in has no Accessibility permission" }];
  const helper: Helper = async (op, args) => {
    asked.push({ op, ...args });
    return answers.shift()!;
  };
  await cancelSheets(async (op, args) => {
    if (op === "sheets") return { windows: listed };
    told.push({ op, ...args });
    return { ok: true };
  }, () => ({ helper, stop() {} }));
  expect({ asked, told }).toEqual({
    asked: [{ op: "cancelPrint", width: 1100, height: 801 }, { op: "cancelPrint", width: 1101, height: 801 }],
    told: [{ op: "looked", id: "a", look: 3, cancelled: true }],
  });
});

// Every close and turn end asks, and the helper is a process of its own.
test("no helper starts while the daemon lists no window to look at", async () => {
  let started = 0;
  await cancelSheets(async () => ({ windows: [] }), () => {
    started++;
    return { helper: async () => ({ ok: true }), stop() {} };
  });
  expect(started).toBe(0);
});

// A print sheet a page left holds its window's other tabs, so a close of
// one of them, or of the whole window, fails: the window an earlier close
// marked is still looked at, from the caller whose close failed.
test("a close call that failed still looks for a print sheet a closed tab left", async () => {
  const asked: string[] = [];
  const port = spyOn(daemonRpc, "rpc").mockImplementation(async (tool: string, args: Record<string, unknown> = {}) => {
    asked.push(tool === "space" ? `space ${String(args.op)}` : tool);
    if (tool === "close") throw new Error("Safari did not close the tab");
    return { windows: [] };
  });
  try {
    await expect(invoke("close", { tab: 7 })).rejects.toThrow("Safari did not close the tab");
  } finally {
    port.mockRestore();
  }
  expect(asked).toEqual(["close", "space sheets"]);
});
