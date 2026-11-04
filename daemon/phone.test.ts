import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as phone from "./phone.ts";
import * as telegram from "./telegram.ts";

// Every alert to the user's phone goes through phone.ts, which holds them to
// six an hour across every process. Telegram is a fake that records each
// line, or fails while failing says so.

let dir = "";
let sent: string[] = [];
let failing = false;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "safari-phone-"));
  sent = [];
  failing = false;
  spyOn(phone, "dataFile").mockImplementation((name) => join(dir, name));
  spyOn(telegram, "sendTelegram").mockImplementation(async (line) => {
    if (failing) throw new Error("Telegram did not take the message: no route to host");
    sent.push(line);
  });
});
afterEach(() => {
  mock.restore();
  setSystemTime();
  rmSync(dir, { recursive: true, force: true });
});

test("the harness alerts the user's phone at most six times an hour; the seventh waits until the first is an hour old", async () => {
  const start = Date.UTC(2026, 8, 28, 12);
  for (let i = 0; i < 6; i++) {
    setSystemTime(start + i * 60_000);
    await phone.alert(`alert ${i}`);
  }
  setSystemTime(start + 30 * 60_000);
  // the agent learns when it may alert again
  await expect(phone.alert("alert 6")).rejects.toThrow(/\b30 min\b/);
  setSystemTime(start + 60 * 60_000);
  await phone.alert("alert 6");
  expect(sent).toEqual(["alert 0", "alert 1", "alert 2", "alert 3", "alert 4", "alert 5", "alert 6"]);
});

test("an alert Telegram fails to take gives back its place in the hour", async () => {
  failing = true;
  await expect(phone.alert("alert 0")).rejects.toThrow("Telegram did not take the message");
  failing = false;
  for (let i = 1; i <= 6; i++) await phone.alert(`alert ${i}`);
  expect(sent).toHaveLength(6);
});
