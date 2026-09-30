import { expect, jest, test } from "bun:test";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { callTool } from "./tools.ts";

// A page that runs what eval sends the way content.js and pageEval do: new
// Function("return (" + code + ")"), with a promise awaited. frame is the
// frame the last request went to. Code not done by the limit the daemon
// gives is answered then, as background.js answers it.
let frame: unknown;
connect({
  send(data: string) {
    const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
    // relay: [tab, "eval", [code], ms, frame]; evalPage: [tab, code, frame, ms]
    const [code, at] = op === "relay" ? [(args[2] as string[])[0], args[4]] : [args[1], args[2]];
    frame = at;
    const answer = (reply: object) => bridge.handleMessage(JSON.stringify({ id, ...reply }));
    const late = typeof args[3] === "number" ? setTimeout(() => answer({ error: "your code ran past its limit" }), args[3]) : undefined;
    const end = (reply: object) => {
      clearTimeout(late);
      answer(reply);
    };
    Promise.resolve()
      .then(() => new Function(`return (${code})`)())
      .then((result) => end({ value: { ok: true, result: result ?? null } }), (e) => end({ error: String(e instanceof Error ? e.message : e) }));
  },
  close() {},
});

const run = async (expression: string, page = false) => ((await callTool("eval", { tab: 7, expression, page })) as { result: unknown }).result;

// On 09-28 an agent's "const a = 1; a + 1" failed with "Unexpected token ';'".
test("a script returns its last expression's value, as a console shows it", async () => {
  expect(await run("const a = 1; a + 1")).toBe(2);
  expect(await run("const r = await Promise.resolve({ status: 200 });\nr.status")).toBe(200);
  expect(await run("[1, 2].map((x) => x * 2)")).toEqual([2, 4]);
});

test("a semicolon or bracket inside a string, template, comment, or regex ends no statement", async () => {
  expect(await run('const s = "a;(b"; s // and/or; this')).toBe("a;(b");
  expect(await run("const t = `(${1 + 1};\n`; t")).toBe("(2;\n");
  expect(await run('const re = /\\(;/; re.test("(;")')).toBe(true);
});

test("a line that carries on the expression above it stays part of it", async () => {
  expect(await run("const a = 1; a\n+ 2")).toBe(3);
  expect(await run("const w = [1, 2]\n  .map((x) => x + 1)\n  .join()\nw")).toBe("2,3");
});

test("a script that ends in a statement runs whole and returns nothing", async () => {
  expect(await run("globalThis.ran = 0; for (const x of [1, 2]) globalThis.ran += x")).toBeNull();
  expect(Reflect.get(globalThis, "ran")).toBe(3);
  expect(await run("const n = f()\nfunction f() { return 7 }")).toBeNull();
});

// On 09-28 an agent's script that ended in a loop, then ({ len, out }),
// came back null with no error.
test("a value after a loop's or an if's block is the script's last value; after a function's brace it is the call", async () => {
  expect(await run("const out = [];\nfor (const x of [1, 2]) { if (x > 1) break; out.push(x) } ({ n: out.length, out })")).toEqual({ n: 1, out: [1] });
  expect(await run("if (true) { globalThis.hit = 1 }\n[1, 2].length")).toBe(2);
  expect(await run("const k = 2;\nglobalThis.twice = function (a) { return a * k }\n(4)")).toBe(8);
});

// On 09-28 a script with a stray word at its end failed with "Unexpected
// keyword 'const'", its first word, so the agent rewrote code that was fine.
test("a script that does not parse fails naming the error in its statements", async () => {
  await expect(run("const a = 1; a )")).rejects.toThrow("Unexpected token ')'");
});

// A snapshot names a cross-origin frame's refs "f3:12"; the same prefix on
// code runs it in that frame.
test("the prefix of a frame's refs runs a script in that frame, in either world", async () => {
  for (const page of [false, true]) {
    expect(await run("f3:const a = 1; a + 1", page)).toBe(2);
    expect(frame).toBe(3);
    expect(await run("const b = 2; b", page)).toBe(2);
    expect(frame).toBe(0);
  }
});

// On 09-30 page-world code past 30 s was told only that the daemon's
// request timed out: the page's answer at eval's limit must come first.
test("code past eval's limit gets the page's answer in either world, not the daemon's time-out", async () => {
  jest.useFakeTimers();
  try {
    for (const page of [false, true]) {
      let error: unknown;
      const ran = run("new Promise(() => {})", page).catch((e: unknown) => {
        error = e;
      });
      for (let ms = 0; error === undefined && ms < 40_000; ms += 500) {
        // the answers settle in microtasks, which all run before the next turn
        const turn = Promise.withResolvers<void>();
        setImmediate(turn.resolve);
        await turn.promise;
        jest.advanceTimersByTime(500);
      }
      await ran;
      expect(String(error)).toMatch(/ran past/);
    }
  } finally {
    jest.useRealTimers();
  }
});
