import { expect, test } from "bun:test";
import { HarnessError, failureOf, readFailure, type FailureCode } from "./failures.ts";

test("a typed failure preserves its code, retry policy, effect, message, and next step in an action context", () => {
  const error = new HarnessError("invalid_argument", "choose an exact tab", { retryable: true, effect: "none", next: "supply the tab from open." });
  expect(failureOf(error, { effectful: true })).toEqual({ ok: false, code: "invalid_argument", retryable: true, effect: "none", message: "choose an exact tab", next: "supply the tab from open." });
});

test("a fully shaped failure from another release does not need the local error prototype", () => {
  const foreign = { code: "stale_view", message: "the document changed", retryable: false, effect: "none", next: "read the original tab again." } as const;
  expect(failureOf(foreign, { effectful: true })).toEqual({ ok: false, ...foreign });
});

test("a serialized failure can be read and reconstructed without losing its policy", () => {
  const original = failureOf(new HarnessError("privacy", "the frame cannot be inspected", { next: "keep the image private." }));
  const transported: unknown = JSON.parse(JSON.stringify(original));
  const read = readFailure(transported);
  expect(read).toEqual(original);
  expect(read && failureOf(new HarnessError(read.code, read.message, read))).toEqual(original);
});

test("a typed cause keeps its policy while the wrapper keeps the original outward message", () => {
  const cause = new HarnessError("waiting_for_human", "a passkey is waiting", { effect: "none", next: "wait for the user's passkey approval." });
  const error = new Error("the sign-in step is paused", { cause });
  expect(failureOf(error, { effectful: true })).toEqual({ ok: false, code: "waiting_for_human", retryable: false, effect: "none", message: "the sign-in step is paused", next: "wait for the user's passkey approval." });
});

test.each([
  ["plain action error", new Error("click failed")],
  ["prose claiming nothing ran", new Error("nothing ran; this is safe to retry")],
  ["validation-shaped prose", new Error("tab must be a number")],
  ["an untyped TypeError during an action", new TypeError("invalid field")],
  ["a thrown string", "the connection ended"],
] as const)("%s never grants an identical action retry", (_name, error) => {
  expect(failureOf(error, { effectful: true })).toMatchObject({ ok: false, code: "effect_unknown", effect: "possibly_effected", retryable: false, next: expect.stringMatching(/snapshot.*before repeating/i) });
});

test("an unknown failure without context does not claim the operation had no effects", () => {
  expect(failureOf(new Error("no answer"))).toMatchObject({ code: "effect_unknown", retryable: false, effect: "possibly_effected" });
});

test("a known read-only error stays a command failure without inventing action uncertainty", () => {
  expect(failureOf(new Error("the requested read failed"), { effectful: false })).toMatchObject({ code: "command_failed", retryable: false, effect: "none", message: "the requested read failed" });
});

test.each([
  ["invalid_argument", "none", true],
  ["stale_view", "none", true],
  ["stopped", "none", false],
  ["waiting_for_human", "none", false],
  ["privacy", "none", false],
  ["blocked", "none", false],
  ["not_content", "none", false],
  ["effect_unknown", "possibly_effected", false],
  ["timeout", "possibly_effected", false],
  ["unavailable", "possibly_effected", false],
  ["aborted", "possibly_effected", false],
  ["command_failed", "possibly_effected", false],
] satisfies [FailureCode, string, boolean][])("%s has a conservative default effect and retry policy", (code, effect, retryable) => {
  expect(failureOf(new HarnessError(code, "the operation stopped"), { effectful: true })).toMatchObject({ code, effect, retryable, next: expect.stringMatching(/\S/) });
});

test("an explicitly undispatched timeout can allow a new attempt", () => {
  expect(failureOf(new HarnessError("timeout", "waiting for a connection timed out", { effect: "none" }), { effectful: true })).toMatchObject({ code: "timeout", effect: "none", retryable: true });
});

test.each([
  ["timeout cause", new Error("fetch failed", { cause: { code: "ETIMEDOUT" } }), "timeout"],
  ["reset cause", new Error("fetch failed", { cause: { code: "ECONNRESET" } }), "unavailable"],
  ["abort type", new DOMException("cancelled", "AbortError"), "aborted"],
  ["timeout type", new DOMException("no answer", "TimeoutError"), "timeout"],
  ["server status", { message: "service failed", status: 503 }, "unavailable"],
  ["validation status", { message: "field was rejected", status: 422 }, "invalid_argument"],
] as const)("%s identifies the diagnosis, not whether an action already ran", (_name, error, code) => {
  expect(failureOf(error, { effectful: true })).toMatchObject({ code, effect: "possibly_effected", retryable: false });
});

test("an explicit validation code at a read-only boundary has no invented action effects", () => {
  expect(failureOf(Object.assign(new TypeError("unsupported argument"), { code: "ERR_INVALID_ARG_TYPE" }), { effectful: false })).toMatchObject({ code: "invalid_argument", effect: "none", retryable: true });
});

test.each([
  ["unknown code", { ok: false, code: "future_code", retryable: true, effect: "none", message: "refused", next: "retry" }],
  ["invalid effect", { ok: false, code: "stale_view", retryable: true, effect: "certainly_none", message: "refused", next: "retry" }],
  ["string retry policy", { code: "stale_view", retryable: "true", effect: "none", message: "refused", next: "retry" }],
  ["success envelope", { ok: true, code: "stale_view", retryable: true, effect: "none", message: "refused", next: "retry" }],
] as const)("%s is not trusted as a complete typed failure", (_name, value) => {
  expect(readFailure(value)).toBeUndefined();
  expect(failureOf(value, { effectful: true })).toMatchObject({ effect: "possibly_effected", retryable: false });
});

test("a cyclic generic cause still returns an honest unknown result", () => {
  const error = new Error("cause loop");
  error.cause = error;
  expect(failureOf(error, { effectful: true })).toMatchObject({ code: "effect_unknown", effect: "possibly_effected", retryable: false, message: "cause loop" });
});
