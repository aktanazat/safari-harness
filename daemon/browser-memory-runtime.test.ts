import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh process gives the real singleton an isolated home, without replacing
// the store or the read dispatcher. Only Safari's wire boundary is a fixture.
const SCRIPT = `
import { mkdirSync, writeFileSync, rmSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { bridge } from ${JSON.stringify(new URL("./bridge.ts", import.meta.url).href)};
import { connect } from ${JSON.stringify(new URL("./fake-safari.ts", import.meta.url).href)};
import { browserMemory } from ${JSON.stringify(new URL("./browser-memory.ts", import.meta.url).href)};
import { callTool, formatResult } from ${JSON.stringify(new URL("./tools.ts", import.meta.url).href)};
import { stopBrowserMemory } from ${JSON.stringify(new URL("./browser-memory-runtime.ts", import.meta.url).href)};
import { runAs } from ${JSON.stringify(new URL("./owner.ts", import.meta.url).href)};
const mode = process.env.RESEARCH_FAILURE_FIXTURE;
const directory = join(homedir(), ".local/share/safari-harness/browser-memory");
const source = { url: "https://example.com/research", title: "Public report", body: "PRIVATE_CANDIDATE_MUST_NOT_LEAK", partial: false };
mkdirSync(join(directory, ".."), { recursive: true });
if (mode === "during-read") browserMemory.configure({ researchEnabled: true, summarize: false });
else writeFileSync(directory, "fixture blocks optional memory storage");
let disrupted = false;
let reads = 0;
connect({
  send(data) {
    const { id, op, args } = JSON.parse(data);
    let value = [];
    if (op === "tabs.list") value = [{ id: 1, url: source.url, title: source.title }];
    if (op === "relay" && ["extract", "snapshot"].includes(args[1])) {
      reads++;
      if (mode === "read-error") {
        bridge.handleMessage(JSON.stringify({ id, error: "fixture page read failed" }));
        return;
      }
      if (mode === "during-read" && !disrupted) {
        disrupted = true;
        browserMemory.close();
        rmSync(directory, { recursive: true });
        writeFileSync(directory, "fixture storage failed after the read started");
      }
      value = { url: source.url, title: source.title, ...(args[1] === "extract"
        ? { text: "The report describes lithium battery recycling.", truncated: false }
        : { snapshot: '- text "The report describes lithium battery recycling."', nodes: 1, truncated: false }),
        ...(mode === "disabled" || mode === "read-error" ? {} : { memorySource: source }) };
    }
    bridge.handleMessage(JSON.stringify({ id, value }));
  },
  close() {},
});
if (mode === "read-error") {
  try { await callTool("extract", { tab: 1 }); }
  catch (error) { console.log(JSON.stringify({ reads, error: error.message })); }
} else {
  const invoke = (name, args) => runAs(process.pid, () => callTool(name, args));
  const extract = await invoke("extract", { tab: 1 });
  const snapshot = await invoke("snapshot", { tab: 1 });
  const savedExtract = await invoke("extract", { tab: 1, save: true });
  const savedSnapshot = await invoke("snapshot", { tab: 1, save: true });
  console.log(JSON.stringify({
    reads, extract, snapshot, savedExtract, savedSnapshot,
    formatted: [extract, snapshot, savedExtract, savedSnapshot].map(formatResult),
    files: [readFileSync(savedExtract.saved, "utf8"), readFileSync(savedSnapshot.saved, "utf8")],
    blockedDirectoryPreserved: lstatSync(directory).isFile(),
  }));
}
await stopBrowserMemory();
process.exit(0);
`;

async function readFixture(mode: string): Promise<Record<string, unknown>> {
  const directory = mkdtempSync(join(tmpdir(), "memory-read-failure-"));
  const child = Bun.spawn([process.execPath, "-e", SCRIPT], {
    env: { ...process.env, HOME: directory, RESEARCH_FAILURE_FIXTURE: mode },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    return JSON.parse(stdout);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("disabled research never opens its unavailable store or warns during ordinary real-dispatcher reads", async () => {
  const result = await readFixture("disabled");
  expect(result.reads).toBe(4);
  expect(result.blockedDirectoryPreserved).toBe(true);
  for (const key of ["extract", "snapshot", "savedExtract", "savedSnapshot"]) {
    expect(result[key]).not.toHaveProperty("memoryWarning");
    expect(result[key]).not.toHaveProperty("memoryReceipt");
  }
  expect(result.files).toEqual(["The report describes lithium battery recycling.", '- text "The report describes lithium battery recycling."']);
});

test.each(["unavailable", "during-read"])("%s research storage cannot destroy a read or expose its internal candidate", async (mode) => {
  const result = await readFixture(mode);
  expect(result.reads).toBe(4);
  expect(result.blockedDirectoryPreserved).toBe(true);
  expect(result.extract).toHaveProperty("text", "The report describes lithium battery recycling.");
  expect(result.snapshot).toHaveProperty("snapshot", '- text "The report describes lithium battery recycling."');
  for (const key of ["extract", "snapshot", "savedExtract", "savedSnapshot"]) {
    const value = result[key];
    expect(value).toHaveProperty("memoryWarning", "research memory is unavailable; check safari memory status.");
    expect(value).not.toHaveProperty("memorySource");
    expect(value).not.toHaveProperty("memoryReceipt");
  }
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("PRIVATE_CANDIDATE_MUST_NOT_LEAK");
  expect(serialized).not.toContain("EEXIST");
  expect(result.files).toEqual(["The report describes lithium battery recycling.", '- text "The report describes lithium battery recycling."']);
  expect(result.formatted).toEqual(Array(4).fill(expect.stringContaining("memoryWarning: research memory is unavailable;")));
});

test("a real page read failure still fails instead of becoming an optional-memory warning", async () => {
  const result = await readFixture("read-error");
  expect(result).toEqual({ reads: 1, error: "fixture page read failed" });
});
