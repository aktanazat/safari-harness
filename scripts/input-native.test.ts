import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory = "";
let binary = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "native-input-contracts-"));
  binary = join(directory, "native-input-tests");
  const source = join(directory, "main.swift");
  const implementation = await readFile(join(import.meta.dir, "input.swift"), "utf8");
  const contracts = await readFile(join(import.meta.dir, "..", "bench", "fixtures", "input-native-tests.swift"), "utf8");
  await writeFile(source, `${implementation}\n${contracts}`);
  const compiler = Bun.spawn(["xcrun", "swiftc", "-D", "INPUT_TESTING", source, "-o", binary], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(compiler.stdout).text(), new Response(compiler.stderr).text(), compiler.exited]);
  expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
}, 60_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.each([
  ["all-formats", "restores every item and representation after paste"],
  ["concurrent-copy", "preserves a user copy made while paste is in flight"],
  ["snapshot-race", "refuses to replace a clipboard changed during its native snapshot"],
  ["failed-write", "restores the previous clipboard when installing paste data fails"],
  ["restore-once", "does not overwrite a later copy on repeated cleanup"],
  ["native-isolated", "round-trips bytes and item order through an isolated real pasteboard"],
])("native paste %s: %s", async (scenario) => {
  const process = Bun.spawn([binary, scenario], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(JSON.parse(out)).toEqual({ passed: scenario });
});
