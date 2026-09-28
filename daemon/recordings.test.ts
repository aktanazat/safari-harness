import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as phone from "./phone.ts";
import { saveRecording } from "./recordings.ts";

// Each test saves into a folder of its own.
function scratch(): string {
  const home = mkdtempSync(join(tmpdir(), "recordings-"));
  spyOn(phone, "dataFile").mockImplementation((name) => join(home, name));
  return join(home, "recordings");
}

afterEach(() => mock.restore());

// The page's own copy, between its markers in content.js.
function pageSecretOfField(): (f: object) => string | null {
  const src = readFileSync(join(import.meta.dir, "..", "extension", "content.js"), "utf8");
  const begin = src.indexOf("// ---- shared with daemon/recordings.ts: begin ----");
  const end = src.indexOf("// ---- shared with daemon/recordings.ts: end ----");
  return new Function(`${src.slice(begin, end)}\nreturn secretOfField;`)() as (f: object) => string | null;
}

const saved = (dir: string, name: string): unknown => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));

const field = (f: Partial<Record<"type" | "autocomplete" | "name" | "id" | "label", string>>) => ({ type: "text", autocomplete: "", name: "", id: "", label: "", ...f });
const FIELDS = [
  field({ type: "password", name: "pw", label: "Password" }),
  field({ autocomplete: "current-password", name: "x" }),
  field({ name: "pin", label: "PIN" }),
  field({ autocomplete: "one-time-code", name: "c" }),
  field({ name: "otp", label: "Verification code" }),
  field({ autocomplete: "cc-number" }),
  field({ name: "cvv", label: "Security code" }),
  field({ type: "hidden", name: "token" }),
  field({ type: "email", autocomplete: "username", name: "email", id: "email", label: "Email" }),
  field({ type: "search", autocomplete: "off", name: "q", label: "Search" }),
  // "pin" only as a word: a spinner is no secret
  field({ name: "spinner", label: "Spinning" }),
];

// Before, a page script's text for a secret field would have gone to disk
// as the page sent it; the daemon judges each field again with its own copy.
test("a saved recording keeps a field's text only where the page's own judge sees no secret, and names the kind elsewhere", () => {
  const dir = scratch();
  const judge = pageSecretOfField();
  const typed = FIELDS.map((f, i) => ({ kind: "type", url: "https://bank.example/login", field: f, value: `typed-${i}` }));
  const chosen = { kind: "select", url: "https://bank.example/pay", field: field({ type: "select-one", name: "exp-month", label: "Expiry month" }), option: "12" };
  const unjudged = { kind: "type", url: "https://bank.example/login", value: "no-field-facts" };
  const rec = { url: "https://bank.example/login", title: "Sign in", startedAt: Date.now(), steps: [...typed, chosen, unjudged] };
  const name = saveRecording(rec);
  const kinds = FIELDS.map((f) => judge(f));
  expect(new Set(kinds)).toEqual(new Set(["password", "one-time-code", "card", "hidden", null]));
  expect(saved(dir, name)).toEqual({
    ...rec,
    steps: [
      ...typed.map((s, i) => (kinds[i] ? { kind: s.kind, url: s.url, field: s.field, secret: kinds[i] } : s)),
      { kind: "select", url: chosen.url, field: chosen.field, secret: judge(chosen.field) },
      { kind: "type", url: unjudged.url, secret: "unknown" },
    ],
  });
});

// Two recordings begun in the same minute on one site must both survive,
// and only he may read them, even in a folder made looser before.
test("recordings are named by site and minute, a taken name gets -2 without overwriting, and only the user can read them", () => {
  const dir = scratch();
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const startedAt = new Date(2026, 8, 28, 14, 12, 30).getTime();
  const first = saveRecording({ url: "https://www.example.com/a", title: "first", startedAt, steps: [] });
  const second = saveRecording({ url: "https://www.example.com/b", title: "second", startedAt, steps: [] });
  expect([first, second]).toEqual(["www.example.com-20260928-1412", "www.example.com-20260928-1412-2"]);
  expect([saved(dir, first), saved(dir, second)]).toMatchObject([{ title: "first" }, { title: "second" }]);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, `${first}.json`)).mode & 0o777).toBe(0o600);
});

test("what is not a recording is refused and nothing is written", () => {
  const dir = scratch();
  expect(() => saveRecording({ title: "no url", steps: [] })).toThrow("not a recording: it needs a url and steps");
  expect(() => statSync(dir)).toThrow();
});
