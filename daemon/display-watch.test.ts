import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISPLAYS_CHANGED, watchDisplayChanges } from "./display-watch.ts";

test("the companion's touch after a display change starts a check, its other files do not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "display-watch-"));
  const checked = Promise.withResolvers<void>();
  let checks = 0;
  const stop = watchDisplayChanges(dir, () => {
    checks++;
    checked.resolve();
  });
  try {
    writeFileSync(join(dir, "claims"), "1 2 - 0 0 -");
    // A file event that is not delivered has no signal to await; this wait
    // gives the claims write's event the time to arrive if it were counted.
    await Bun.sleep(200);
    expect(checks).toBe(0);

    writeFileSync(join(dir, DISPLAYS_CHANGED), "");
    await checked.promise;
    expect(checks).toBeGreaterThan(0);
  } finally {
    stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without the companion's folder nothing is watched and nothing fails", () => {
  expect(watchDisplayChanges(join(tmpdir(), "no-such-agent-display-folder"), () => {})).toBeUndefined();
});
