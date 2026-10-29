import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const failure = {
  ok: false,
  code: "effect_unknown",
  retryable: false,
  effect: "possibly_effected",
  message: "send outcome unknown",
  next: "do not resend",
};

test.each([
  { name: "a structured failure", output: JSON.stringify(failure), exitCode: 1, exact: true },
  { name: "an ssh connection loss", output: "", exitCode: 255, exact: false },
  { name: "a malformed successful response", output: "not json", exitCode: 0, exact: false },
])("a remote send keeps its uncertain effect after $name", async ({ output, exitCode, exact }) => {
  const home = mkdtempSync("/private/var/tmp/safari-remote-send-");
  const response = output ? `printf '%s\\n' '${output}'\n` : "";
  writeFileSync(join(home, "ssh"), `#!/bin/sh\n${response}exit ${exitCode}\n`, { mode: 0o755 });
  try {
    const script = `
      import { remoteCall } from ${JSON.stringify(join(import.meta.dir, "host.ts"))};
      import { failureOf } from ${JSON.stringify(join(import.meta.dir, "failures.ts"))};
      try {
        await remoteCall("fixture", "imessage_send", { to: "fixture@example.com", approved: true });
        throw new Error("remote command unexpectedly succeeded");
      } catch (error) {
        process.stdout.write(JSON.stringify(failureOf(error, { effectful: false })));
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home, PATH: `${home}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`fake remote command failed (${code}): ${stderr}`);
    const reply = JSON.parse(stdout);
    if (exact) {
      expect(reply).toEqual(failure);
    } else {
      expect(reply).toMatchObject({ ok: false, code: "effect_unknown", effect: "possibly_effected", retryable: false });
      expect(reply.next).toContain("Do not resend");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
