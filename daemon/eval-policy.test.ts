import { expect, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { callTool } from "./tools.ts";

// A stand-in extension on pages whose security policy forbids eval. The
// extension's world refuses code that mentions "strict" before running it
// (as content.js answers), and the page's world refuses code that mentions
// "csp" in WebKit's own words. Each world notes that it ran code.
const BLOCKED = "this page's security policy blocks eval; use snapshot, extract, or data";
const WEBKIT = "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\".";
const ran: string[] = [];
function answer(op: string, args: unknown[]): { value: unknown } | { error: string } {
  if (op === "relay" && args[1] === "eval") {
    const code = Array.isArray(args[2]) ? String(args[2][0]) : "";
    if (code.includes("strict")) return { error: BLOCKED };
    ran.push("extension");
    if (code.includes("throw")) return { error: "TypeError: undefined is not an object" };
    return { value: { ok: true, result: "extension" } };
  }
  if (op === "evalPage") {
    if (String(args[1]).includes("csp")) return { error: WEBKIT };
    ran.push("page");
    return { value: { ok: true, result: "page" } };
  }
  return { value: { ok: true } };
}
bridge.attach({
  send(raw: string) {
    const { id, op, args } = JSON.parse(raw) as { id: string; op: string; args: unknown[] };
    bridge.handleMessage(JSON.stringify({ id, ...answer(op, args) }));
  },
  close() {},
});
const run = (expression: string, page = false) => {
  ran.length = 0;
  return callTool("eval", { tab: 7, expression, page });
};

test("code the page's policy refuses in the extension's world runs once, in the page's world", async () => {
  expect(await run("'strict'")).toEqual({ ok: true, result: "page" });
  expect(ran).toEqual(["page"]);
});

test("code refused in both worlds fails with words that say what to use instead", async () => {
  await expect(run("'strict csp'")).rejects.toThrow(new Error(BLOCKED));
});

test("page: true runs only in the page's world, and its refusal says what to use instead", async () => {
  await expect(run("'csp'", true)).rejects.toThrow(new Error(BLOCKED));
  expect(ran).toEqual([]);
});

test("an error the code itself throws is reported, not run again in the page's world", async () => {
  await expect(run("throw 1")).rejects.toThrow("TypeError: undefined is not an object");
  expect(ran).toEqual(["extension"]);
});
