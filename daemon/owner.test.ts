import { expect, jest, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentOwner, ownerOf, runAs, watchOwner } from "./owner.ts";

// bun, which starts a sleep through a shell (bun -> sh -> sleep), says its
// pid and the sleep's, and lives as long as the sleep does.
const KERNEL = `const sh = Bun.spawn(["/bin/sh", "-c", "sleep 60 & echo $!; wait"], { stdout: "pipe" });
const { value } = await sh.stdout.getReader().read();
console.log(process.pid, Number(new TextDecoder().decode(value)));
await sh.exited`;

// argv, whose output is a KERNEL's, and the pids it says. Killing the sleep
// ends every process above it.
async function kernelUnder(argv: string[]) {
  const top = Bun.spawn(argv, { stdout: "pipe" });
  const { value } = await top.stdout.getReader().read();
  const [kernel, sleeper] = new TextDecoder().decode(value).trim().split(" ").map(Number);
  return { top, kernel, sleeper };
}

test("with no agent harness above it, a process's owner is its first ancestor that is not a shell", async () => {
  // The shell exits once it has started the kernel, which launchd then
  // takes: launchd -> kernel -> sh -> sleep, whatever runs this test.
  const { top, kernel, sleeper } = await kernelUnder(["/bin/sh", "-c", `${JSON.stringify(process.execPath)} -e '${KERNEL}' &`]);
  try {
    await top.exited;
    expect(await ownerOf(sleeper)).toBe(kernel);
  } finally {
    process.kill(sleeper, 9);
  }
});

// 10-07: omp's Python kernel counted as an agent apart from its omp, so the
// calls one agent made from it and from its shell opened two windows.
test("an agent harness owns everything under it, a kernel or script between included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-test-"));
  // bun under the name omp: the kernel reads a process's name from its file
  const omp = join(dir, "omp");
  linkSync(process.execPath, omp);
  const { top, sleeper } = await kernelUnder([omp, "-e", `await Bun.spawn(${JSON.stringify([process.execPath, "-e", KERNEL])}, { stdout: "inherit" }).exited`]);
  try {
    expect(await ownerOf(sleeper)).toBe(top.pid);
  } finally {
    process.kill(sleeper, 9);
    rmSync(dir, { recursive: true, force: true });
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
