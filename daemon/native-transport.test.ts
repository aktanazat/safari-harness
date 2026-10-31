import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test.each([true, false])("native paste keeps its stdin open until the page completion answer is %s", async (complete) => {
  const directory = await mkdtemp(join(tmpdir(), "native-paste-transport-"));
  directories.push(directory);
  await mkdir(join(directory, "daemon"));
  await mkdir(join(directory, "scripts"));
  for (const file of ["front.ts", "failures.ts"]) await copyFile(join(import.meta.dir, file), join(directory, "daemon", file));
  await writeFile(join(directory, "scripts", "input"), `#!/usr/bin/env node\nimport { createInterface } from 'node:readline';\nconst lines = createInterface({input:process.stdin})[Symbol.asyncIterator]();\nconst payload = (await lines.next()).value;\nconsole.log(JSON.stringify({awaitingCompletion:true}));\nconst acknowledgment = (await lines.next()).value;\nconsole.log(JSON.stringify({args:process.argv.slice(2),payload,acknowledgment}));\nprocess.exit(0);\n`, { mode: 0o700 });
  await writeFile(join(directory, "driver.ts"), `import {input} from './daemon/front.ts';\nconst payload=await Bun.stdin.text();\nconsole.log(JSON.stringify(await input(['paste'],2000,payload,async()=>${complete})));\n`);
  const payload = JSON.stringify({ text: "Zoë\t42\n", html: "<b>Zoë</b>", tsv: "Zoë\t42" });
  const child = Bun.spawn([process.execPath, join(directory, "driver.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(payload);
  child.stdin.end();
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(JSON.parse(out)).toEqual({ args: ["paste"], payload, acknowledgment: complete ? "complete" : "uncertain" });
});
