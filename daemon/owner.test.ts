import { expect, jest, test } from "bun:test";
import { currentOwner, ownerOf, runAs, watchOwner } from "./owner.ts";

test("a process's owner is its first ancestor that is not a shell", async () => {
  // this test's bun -> sh -> sleep
  const sh = Bun.spawn(["/bin/sh", "-c", "sleep 60 & echo $!; wait"], { stdout: "pipe" });
  try {
    const { value } = await sh.stdout.getReader().read();
    const sleeper = Number(new TextDecoder().decode(value).trim());
    expect(await ownerOf(sleeper)).toBe(process.pid);
  } finally {
    Bun.spawnSync(["pkill", "-9", "-P", String(sh.pid)]);
    sh.kill(9);
  }
});

test("concurrent calls each see their own owner across awaits", async () => {
  const second = Promise.withResolvers<void>();
  const first = runAs(11, async () => {
    await second.promise;
    return currentOwner();
  });
  const other = runAs(22, async () => {
    const seen = currentOwner();
    second.resolve();
    return seen;
  });
  expect(await Promise.all([first, other])).toEqual([11, 22]);
  expect(currentOwner()).toBeUndefined();
});

test("watchOwner calls back once the process exits; a failing callback does not stop the others, and a stopped watch never runs", async () => {
  jest.useFakeTimers();
  try {
    const child = Bun.spawn(["sleep", "60"]);
    const calls: string[] = [];
    watchOwner(child.pid, () => {
      calls.push("failed");
      throw new Error("cleanup failed");
    });
    watchOwner(child.pid, () => calls.push("ran"));
    const unwatch = watchOwner(child.pid, () => calls.push("stopped"));
    unwatch();
    jest.advanceTimersByTime(3000);
    expect(calls).toEqual([]);
    child.kill(9);
    await child.exited;
    jest.advanceTimersByTime(1000);
    expect(calls).toEqual(["failed", "ran"]);
  } finally {
    jest.useRealTimers();
  }
});
