import { test } from "bun:test";

if (process.env.SAFARI_HARNESS_SEND_TEST_CHILD === "1") {
  // A static import would install process mocks in the shared test runner.
  await import("./imessage-send.fixture.ts");
} else {
  test("message sends run against an isolated fixture", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, SAFARI_HARNESS_SEND_TEST_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`isolated send checks failed (${code})\n${stdout}\n${stderr}`);
  });
}
