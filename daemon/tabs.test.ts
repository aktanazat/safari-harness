import { expect, test } from "bun:test";
import { resolveTab, type TabInfo } from "./tools.ts";

// Two windows: each has an active tab, and the user has the second in front.
const TWO_WINDOWS: TabInfo[] = [
  { id: 11, active: true, windowId: 1 },
  { id: 12, active: false, windowId: 1 },
  { id: 21, active: true, windowId: 2, front: true },
];
const tabs = async () => TWO_WINDOWS;

test("a call without tab is an error, never the user's front tab", async () => {
  // On 09-28 a call that left out tab read the user's MyChart page.
  await expect(resolveTab(undefined, tabs)).rejects.toThrow(/^tab is required/);
  await expect(resolveTab(null, tabs)).rejects.toThrow(/^tab is required/);
});

test('"front" is the active tab of the window in front, not the first active tab', async () => {
  expect(await resolveTab("front", tabs)).toBe(21);
  await expect(resolveTab("front", async () => [])).rejects.toThrow("Safari has no front tab");
});

// An id that is not a number would reach Safari as NaN, which it reports as
// an invalid tab identifier.
test("a tab id arrives as a number or a numeric string, and nothing else", async () => {
  expect(await resolveTab(12, tabs)).toBe(12);
  expect(await resolveTab("12", tabs)).toBe(12);
  await expect(resolveTab("Front", tabs)).rejects.toThrow('tab must be a tab id from open, or "front"');
});
