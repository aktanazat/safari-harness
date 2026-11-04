import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as phone from "./phone.ts";
import { listPlaybooks, loadRecording, saveRecording } from "./recordings.ts";

// Each test saves into a folder of its own.
function scratch(): string {
  const home = mkdtempSync(join(tmpdir(), "recordings-"));
  spyOn(phone, "dataFile").mockImplementation((name) => join(home, name));
  return join(home, "recordings");
}

afterEach(() => mock.restore());


const saved = (dir: string, name: string): unknown => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

test("saved recordings omit typed secrets and values without field facts", () => {
  const dir = scratch();
  const fields = [
    { field: { type: "password", name: "pw" }, secret: "password" },
    { field: { autocomplete: "current-password" }, secret: "password" },
    { field: { name: "pin", label: "PIN" }, secret: "password" },
    { field: { autocomplete: "one-time-code" }, secret: "one-time-code" },
    { field: { name: "otp", label: "Verification code" }, secret: "one-time-code" },
    { field: { autocomplete: "cc-number" }, secret: "card" },
    { field: { name: "cvv", label: "Security code" }, secret: "card" },
    { field: { type: "hidden", name: "token" }, secret: "hidden" },
    { field: { type: "email", autocomplete: "username", name: "email" }, secret: null },
    { field: { type: "search", name: "q" }, secret: null },
    { field: { name: "spinner", label: "Spinning" }, secret: null },
  ];
  const typed = fields.map(({ field }, i) => ({
    kind: "type", url: "https://bank.example/login", field, value: `typed-${i}`,
  }));
  const chosen = { kind: "select", url: "https://bank.example/pay", field: { type: "select-one", name: "exp-month", label: "Expiry month" }, option: "12" };
  const unknown = { kind: "type", url: "https://bank.example/login", value: "no-field-facts" };
  const recording = { url: "https://bank.example/login", steps: [...typed, chosen, unknown] };
  const name = saveRecording(recording);
  expect(saved(dir, name)).toEqual({
    ...recording,
    steps: [
      ...typed.map((step, i) => fields[i].secret
        ? { kind: step.kind, url: step.url, field: step.field, secret: fields[i].secret }
        : step),
      { kind: chosen.kind, url: chosen.url, field: chosen.field, secret: "card" },
      { kind: unknown.kind, url: unknown.url, secret: "unknown" },
    ],
  });
});


// Two recordings begun in the same minute on one site must both survive,
// and only he may read them, even in a folder made looser before.
test("recordings begun in the same minute survive without overwriting, and only the user can read them", () => {
  const dir = scratch();
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const startedAt = new Date(2026, 8, 28, 14, 12, 30).getTime();
  const first = saveRecording({ url: "https://www.example.com/a", title: "first", startedAt, steps: [] });
  const second = saveRecording({ url: "https://www.example.com/b", title: "second", startedAt, steps: [] });
  expect([saved(dir, first), saved(dir, second)]).toMatchObject([{ title: "first" }, { title: "second" }]);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, `${first}.json`)).mode & 0o777).toBe(0o600);
});

test("what is not a recording is refused and nothing is written", () => {
  const dir = scratch();
  expect(() => saveRecording({ title: "no url", steps: [] })).toThrow("not a recording: it needs a url and steps");
  expect(() => statSync(dir)).toThrow();
});

test("a changed tool keeps its prior revision and rejects example text in the next publication", () => {
  const dir = scratch();
  const url = "https://catalog.example/";
  const record = {
    url, source: "agent", verified: true, goal: "Search products", params: ["query"],
    before: { selector: "#search" }, verify: { selector: "#results" },
    steps: [{ kind: "type", url, param: "query",
      field: { type: "search", autocomplete: "", name: "q", id: "", label: "Search" },
      target: { role: "searchbox", name: "Search", tag: "input", near: "", path: "", index: 0, count: 1 } }],
  };
  const first = saveRecording(record);
  const second = saveRecording({ ...record, goal: "Find products" }, first);
  expect(() => saveRecording({ ...record, before: { selector: "#wrong-start" } }, second)).toThrow("verified start condition");
  expect(() => saveRecording({ ...record, verify: { selector: "#wrong-end" } }, second)).toThrow("verified end condition");
  expect(listPlaybooks()).toMatchObject([{ name: second, revision: 2, revisions: [
    { name: second, revision: 2, current: true },
    { name: first, revision: 1, current: false },
  ] }]);
  expect(loadRecording(first)).toMatchObject({ goal: "Search products", version: { revision: 1 } });
  expect(() => saveRecording({ ...record, goal: "Search pears" }, second, { query: "pears" })).toThrow("example value appeared");
  expect(readdirSync(dir)).toHaveLength(2);
});
