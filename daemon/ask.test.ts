import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_TOOLS } from "./ask.ts";
import * as phone from "./phone.ts";
import * as telegram from "./telegram.ts";

// ask puts an agent's question on the user's phone when he is away from the
// Mac, and sends nothing when he is at it. Telegram is a fake that records
// each line.

let dir = "";
let sent: string[] = [];

const ask = (a: Record<string, unknown>) => ASK_TOOLS.ask.run(a);

const away = process.env.SAFARI_HARNESS_AWAY;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "safari-ask-"));
  sent = [];
  spyOn(phone, "dataFile").mockImplementation((name) => join(dir, name));
  spyOn(telegram, "sendTelegram").mockImplementation(async (line) => void sent.push(line));
});
afterEach(() => {
  mock.restore();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  if (away === undefined) delete process.env.SAFARI_HARNESS_AWAY;
  else process.env.SAFARI_HARNESS_AWAY = away;
});

test("at the Mac, ask sends nothing and tells the agent to ask in its own chat", async () => {
  process.env.SAFARI_HARNESS_AWAY = "0";
  expect(await ask({ question: "which color?" })).toMatchObject({ atMac: true });
  expect(sent).toEqual([]);
});

test("away, the question goes to his phone once, and the call returns without waiting on a reply", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  expect(await ask({ question: "which color?" })).toMatchObject({ sent: true });
  expect(sent).toEqual([expect.stringContaining("which color?")]);
});
