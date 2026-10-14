import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as phone from "./phone.ts";
import * as client from "./rpc.ts";
import { invoke } from "./call.ts";
import { playbooksTool } from "./playbooks.ts";
import { loadRecording, saveRecording } from "./recordings.ts";
import { replay } from "./replay.ts";

// User-visible risks: storing a failed/private run, typing into a changed
// field, crossing an approval gate, and silently bringing rediscovery back.
// Only the browser/Jev boundaries are doubled. Persistence and the caller's
// published tool routing are real. Each test owns its files and virtual time.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "playbooks-"));
  spyOn(phone, "dataFile").mockImplementation((name) => join(home, name));
  spyOn(client, "agentOf").mockResolvedValue(42);
});
afterEach(() => { mock.restore(); rmSync(home, { recursive: true, force: true }); });
const url = "https://catalog.example/";
const goal = "Search the catalog";
const field = { type: "search", autocomplete: "off", name: "q", id: "query", label: "Search" };
const fp = (role: string, tag: string, name = "Search") => ({ role, tag, name, near: "", path: "", index: 0, count: 1 });
const rec = (steps: unknown[] = [{ kind: "type", url, field, param: "q", target: fp("searchbox", "input") }, { kind: "click", url, target: fp("button", "button") }]) => ({ url, source: "agent", verified: true, goal, params: ["q"], before: { selector: "#search" }, verify: { selector: "#results" }, steps });
function fixture(options: { drift?: boolean; ambiguous?: boolean; secret?: boolean; submit?: boolean; before?: boolean; after?: boolean; failedAction?: boolean; challenge?: boolean } = {}) {
  let typed = ""; let clicked = 0;
  const calls: string[] = []; const modelCalls: string[] = [];
  const call = async (tool: string, a: Record<string, unknown>, model = false): Promise<unknown> => {
    calls.push(tool); if (model) modelCalls.push(tool);
    switch (tool) {
      case "open": case "goto": return { id: 7, url, ...(options.challenge ? { challenge: { kind: "captcha", where: "page" } } : {}) };
      case "info": return { url };
      case "real_site": return undefined;
      case "news": return {};
      case "snapshot": return { url, snapshot: '[1] searchbox "Search"\n[2] button "Search"' };
      case "eval": {
        const expression = String(a.expression);
        const input = expression.includes('ref=\\"1\\"') || expression.includes('ref="1"');
        const f = input ? { ...field, ...(options.secret ? { type: "password" } : {}) } : { type: options.submit ? "submit" : "button", autocomplete: "", name: "", id: "go", label: "Search" };
        return { ok: true, result: { ref: input ? "1" : "2", role: input ? "searchbox" : "button", name: expression.includes("getRootNode") ? "Search" : f.name, tag: input ? "input" : "button", field: f, type: f.type, autocomplete: f.autocomplete, submit: options.submit && !input, href: null } };
      }
      case "lookalikes": {
        const target = a.target as { role: string; tag: string; name: string };
        if (options.drift && target.tag === "button") return [];
        const c = { ...target, ref: target.tag === "input" ? "1" : "2", near: "private row content", path: "#private-account" };
        return options.ambiguous ? [c, { ...c, ref: "3" }] : [c];
      }
      case "type": typed = String(a.text); return { ok: !options.failedAction, kept: !options.failedAction };
      case "click": clicked++; return { ok: true, effect: { added: 1 } };
      case "wait": return { found: a.selector === "#search" ? options.before !== false : options.after !== false };
      case "close": return { ok: true };
      default: throw new Error(`fixture does not implement ${tool}`);
    }
  };
  spyOn(client, "rpc").mockImplementation(call);
  return { call, calls, modelCalls, state: () => ({ typed, clicked }) };
}
const virtualClock = () => { let now = 0; return { now: () => now, sleep: async (ms: number) => { now += ms; } }; };
async function learn() {
  await invoke("open", { url, background: true }, true);
  await invoke("playbooks", { do: "learn", tab: 7, goal, params: ["q"], before: { selector: "#search" } }, true);
  await invoke("type", { tab: 7, ref: 1, text: "private input value" }, true);
  await invoke("click", { tab: 7, ref: 2 }, true);
  return await invoke("playbooks", { do: "save", tab: 7, selector: "#results" }, true) as { name: string; verified: boolean };
}

test("an opted-in verified run stores only named parameters and replays with one advisory choice and no agent-written browser actions", async () => {
  const p = fixture(); const saved = await learn();
  const disk = readFileSync(join(home, "recordings", `${saved.name}.json`), "utf8");
  expect(saved.verified).toBe(true);
  expect(disk).not.toContain("private input value");
  expect(disk).not.toContain("private row content");
  expect(disk).not.toContain("private-account");
  expect(statSync(join(home, "recordings", `${saved.name}.json`)).mode & 0o777).toBe(0o600);
  p.calls.length = 0; p.modelCalls.length = 0;
  const choices: unknown[] = [];
  const result = await playbooksTool({ do: "run", goal, url, vars: { q: "new current value" } }, p.call, async (criteria, state) => {
    choices.push({ criteria, state }); return { code: 0, stdout: "p1\t0.95", stderr: "" };
  });
  expect(result).toMatchObject({ ok: true, verified: true, matched: true });
  expect(p.state()).toEqual({ typed: "new current value", clicked: 2 });
  expect(JSON.stringify(choices)).not.toContain("new current value");
  expect(choices).toHaveLength(1);
  expect(p.modelCalls).toEqual([]);
  expect(p.calls).toEqual(["open", "wait", "info", "lookalikes", "eval", "type", "info", "lookalikes", "eval", "click", "wait", "close"]);
});

test("a failed end check stores no playbook", async () => {
  fixture({ after: false });
  await expect(learn()).rejects.toThrow("the run is not verified");
  expect(await playbooksTool({ do: "list" })).toEqual([]);
});
test("a failed action cannot be laundered by a later passing end check", async () => {
  fixture({ failedAction: true });
  await expect(learn()).rejects.toThrow("an action failed");
  expect(await playbooksTool({ do: "list" })).toEqual([]);
});
test("learning cannot observe an owner tab even when it has a numeric id", async () => {
  const p = fixture();
  await expect(playbooksTool({ do: "learn", tab: 99, goal, params: [], before: { selector: "#search" } }, p.call)).rejects.toThrow("learn only a background tab this agent opened");
  expect(p.calls).toEqual([]);
});
test("a stored unverified agent run is rejected before replay opens anything", async () => {
  const p = fixture(); const name = saveRecording(rec());
  const path = join(home, "recordings", `${name}.json`);
  writeFileSync(path, JSON.stringify({ ...loadRecording(name), verified: false }));
  await expect(replay({ name, vars: { q: "shoes" } }, p.call)).rejects.toThrow("not verified");
  expect(p.calls).toEqual([]);
});
test("an agent recording carrying a value is refused at storage", () => {
  expect(() => saveRecording(rec([{ kind: "type", url, field, param: "q", target: fp("searchbox", "input"), value: "secret" }]))).toThrow("unsafe or unsupported data");
});
test("learning a secret field stores neither its value nor surrounding content and preserves its handoff", async () => {
  fixture({ secret: true });
  const saved = await learn();
  const recording = loadRecording(saved.name);
  expect(recording.steps[0]).toMatchObject({ gate: "sign-in or secret", field: { type: "password" }, param: "q" });
  expect(JSON.stringify(recording)).not.toContain("private input value");
});
test("a missing parameter fails before any tab opens", async () => {
  const p = fixture(); const name = saveRecording(rec());
  await expect(replay({ name }, p.call)).rejects.toThrow("missing playbook parameter q");
  expect(p.calls).toEqual([]);
});
test("drift stops before the changed button is clicked", async () => {
  const p = fixture({ drift: true }); const name = saveRecording(rec());
  expect(await replay({ name, vars: { q: "shoes" } }, p.call, virtualClock())).toMatchObject({ ok: false, failedAt: 2, error: expect.stringContaining("nothing on the page looks like button") });
  expect(p.state().clicked).toBe(0);
});
test("ambiguous live targets receive no parameter value", async () => {
  const p = fixture({ ambiguous: true }); const name = saveRecording(rec());
  expect(await replay({ name, vars: { q: "shoes" } }, p.call, virtualClock())).toMatchObject({ ok: false, failedAt: 1 });
  expect(p.state().typed).toBe("");
});
test("a changed secret field receives no parameter value", async () => {
  const p = fixture({ secret: true }); const name = saveRecording(rec());
  expect(await replay({ name, vars: { q: "shoes" } }, p.call)).toMatchObject({ ok: false, error: expect.stringContaining("field changed") });
  expect(p.state().typed).toBe("");
});
test.each(["Send", "Buy", "Delete", "Stop", "Settings", "Sign in"])("a %s boundary stops without executing its action even if approved is supplied", async (label) => {
  const p = fixture(); const name = saveRecording({ ...rec([{ kind: "click", url, target: fp("button", "button", label) }]), params: [] });
  expect(await replay({ name, approved: true }, p.call)).toMatchObject({ ok: false, failedAt: 1, gate: expect.any(String) });
  expect(p.state().clicked).toBe(0);
});
test("a button that becomes a submit control stops at an owner gate", async () => {
  const p = fixture({ submit: true }); const name = saveRecording({ ...rec([{ kind: "click", url, target: fp("button", "button") }]), params: [] });
  expect(await replay({ name }, p.call)).toMatchObject({ ok: false, gate: "send or submit" });
  expect(p.state().clicked).toBe(0);
});
test("a missing start condition leaves all actions untouched", async () => {
  const p = fixture({ before: false }); const name = saveRecording(rec());
  expect(await replay({ name, vars: { q: "shoes" } }, p.call)).toMatchObject({ ok: false, failedAt: 0 });
  expect(p.state()).toEqual({ typed: "", clicked: 0 });
});
test("a missing end condition never reports a verified result", async () => {
  const p = fixture({ after: false }); const name = saveRecording(rec());
  expect(await replay({ name, vars: { q: "shoes" } }, p.call)).toMatchObject({ ok: false, failedAt: 3 });
});
test("a captcha is handed back before any action", async () => {
  const p = fixture({ challenge: true }); const name = saveRecording(rec());
  expect(await replay({ name, vars: { q: "shoes" } }, p.call)).toMatchObject({ ok: false, challenge: { kind: "captcha" } });
  expect(p.state()).toEqual({ typed: "", clicked: 0 });
});
test.each([
  { code: 0, stdout: "none\t0.95", stderr: "" },
  { code: 1, stdout: "", stderr: "unavailable" },
  { code: 2, stdout: "", stderr: "wrong model" },
  { code: 0, stdout: "unknown\t0.99", stderr: "" },
  { code: 0, stdout: "p1\t0.46", stderr: "" },
])("an abstaining or failed Jev answer starts no replay: %j", async (answer) => {
  const p = fixture(); saveRecording(rec());
  expect(await playbooksTool({ do: "run", url, goal, vars: { q: "shoes" } }, p.call, async () => answer)).toMatchObject({ ok: false, abstained: true, reason: expect.any(String) });
  expect(p.calls).toEqual([]);
});
