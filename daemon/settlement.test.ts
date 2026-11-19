import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../extension/content.js"), "utf8");
const body = source.match(/  function settlementClear\(heard, deadline, since\) \{[\s\S]*?\n  \}/)?.[0];
const clear = body ? new Function(`${body}; return settlementClear;`)() : null;
const quiet = { version: 1, early: true, intact: true, visible: true, frames: 0, idle: 0, network: 0, unbounded: 0, loads: 0, posted: -1, timers: [] };

test.skipIf(!clear)("settlement requires complete current telemetry and no possible work before the old deadline", () => {
  expect(clear(quiet, 450, 0)).toBe(true);
  expect(clear({ ...quiet, timers: [{ due: 451, every: false }] }, 450, 0)).toBe(true);
  for (const heard of [undefined, null, {}, { ...quiet, version: 0 }, { ...quiet, early: false }, { ...quiet, intact: false }, { ...quiet, visible: false },
    ...["frames", "idle", "network", "unbounded", "loads"].map(key => ({ ...quiet, [key]: 1 })),
    { ...quiet, posted: 0 }, { ...quiet, timers: null }, { ...quiet, timers: [null] }, { ...quiet, timers: [{ due: NaN, every: false }] },
    { ...quiet, timers: [{ due: 450, every: false }] }, { ...quiet, timers: [{ due: 451, every: true }] },
  ]) expect(clear(heard, 450, 0)).toBe(false);
});

test.skipIf(!clear)("settlement refuses partially populated or malformed telemetry", () => {
  for (const key of Object.keys(quiet)) {
    const incomplete = { ...quiet };
    delete incomplete[key];
    expect(clear(incomplete, 450, 0)).toBe(false);
  }
  expect(clear({ ...quiet, timers: [{ due: "500", every: false }] }, 450, 0)).toBe(false);
});
