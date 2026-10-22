import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runner } from "./bench.ts";

// The runner installs these shipping scripts in real, separate WebKit worlds.
// Requests exercise the same narrow bridge background.js invokes; no React,
// DOM, axe or browser-host implementations are replaced by test doubles.
const root = join(import.meta.dir, "..");
type Request = Record<string, unknown>;
async function replies(page: string, steps: Request[], reactHook = false): Promise<unknown[]> {
  const address = pathToFileURL(join(import.meta.dir, "fixtures", page.split("?")[0])).href + (page.includes("?") ? `?${page.split("?")[1]}` : "");
  const requests = [{ load: address, appChecks: true, reactHook }, ...steps];
  const proc = Bun.spawn([runner, join(root, "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(requests.map((request) => JSON.stringify(request) + "\n").join(""));
  proc.stdin.end();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`app-checks WebKit runner exited ${code}: ${err.trim()}`);
  const [loaded, ...answers] = out.trim().split("\n").map((line) => JSON.parse(line) as unknown);
  expect(loaded).toMatchObject({ url: address });
  return answers;
}
const app = (method: string, ...args: unknown[]) => ({ appChecks: { method, args } });

describe.skipIf(!runner)("optional app checks in real WebKit", () => {
  test("bundled axe reports an unlabelled field and stops reporting it once the user fixes its label", async () => {
    const answers = await replies("app-checks-audit.html", [
      app("audit", { rules: ["label"] }),
      { op: "click", args: ["fix label"] },
      app("audit", { rules: ["label"] }),
    ]);
    expect(answers[0]).toMatchObject({ value: {
      ok: true, status: "audited", engine: { name: "axe-core", version: "4.10.3" },
      violations: [{ id: "label", impact: "critical", nodeCount: 1, help: expect.stringContaining("label"), nodes: [{ selector: [expect.stringContaining("input:nth-of-type(1)")] }] }],
    } });
    expect(answers[2]).toMatchObject({ value: { ok: true, status: "audited", violations: [], counts: { violations: 0 } } });
    expect(JSON.stringify(answers)).not.toContain("private-form-value-never-output");
  }, 25_000);

  test("an isolated audit neither reads nor replaces the page's same-version axe getter", async () => {
    const answers = await replies("app-checks-audit.html", [
      app("audit", { rules: ["label"] }),
      { pageEval: "({ untouched: Object.getOwnPropertyDescriptor(window, 'axe').get === window.appAxeGetter, reads: window.appAxeReads })" },
      { pageEval: "window.__safariHarnessAppChecks.audit({rules:['label']})" },
    ]);
    expect(answers[0]).toMatchObject({ value: { ok: true, counts: { violations: 1 } } });
    expect(answers[1]).toMatchObject({ value: { untouched: true, reads: 0 } });
    expect(answers[2]).toMatchObject({ value: { ok: false, status: "unavailable" } });
  }, 25_000);

  test("axe reports a gradient contrast check needing review as incomplete rather than a pass", async () => {
    const answers = await replies("app-checks-audit.html", [app("audit", { rules: ["color-contrast"] })]);
    expect(answers[0]).toMatchObject({ value: {
      ok: true, status: "audited", incomplete: expect.arrayContaining([expect.objectContaining({ id: "color-contrast", impact: "serious", nodeCount: expect.any(Number), nodes: expect.arrayContaining([expect.objectContaining({ selector: [expect.any(String)] })]) })]),
    } });
  }, 25_000);

  test("an unreadable embedded document is a skipped frame, not silently included in a clean audit", async () => {
    const answers = await replies("app-checks-audit.html", [app("audit", { rules: ["label"] })]);
    expect(answers[0]).toMatchObject({ value: {
      framesIncluded: false,
      embeddedFrames: [{ status: "skipped", readable: false, reason: expect.stringContaining("separate frame"), selector: [expect.stringContaining("iframe:nth-of-type(1)")] }],
    } });
    expect(JSON.stringify(answers)).not.toContain("private-frame-value");
  }, 25_000);

  test("a large finding set keeps its true affected-node count while bounding the returned private form details", async () => {
    const answers = await replies("app-checks-many-inputs.html", [app("audit", { rules: ["label"], maxNodes: 2 })]);
    expect(answers[0]).toMatchObject({ value: {
      ok: true, truncated: true, violations: [{ id: "label", nodeCount: 30, truncated: true, nodes: [expect.anything(), expect.anything()] }],
    } });
    expect(JSON.stringify(answers)).not.toContain("private-form-value-never-output");
  }, 25_000);

  test("a bad audit region reports invalid input rather than a completed or empty audit", async () => {
    const answers = await replies("app-checks-audit.html", [app("audit", { selector: "[" })]);
    expect(answers[0]).toMatchObject({ value: { ok: false, status: "invalid_argument" } });
  });

  test("React remains uninstrumented unless app inspection was explicitly enabled before mount", async () => {
    const answers = await replies("app-checks-react.html", [
      { pageEval: "({ beforeMount: window.appHookBeforeMount, present: Object.hasOwn(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__'), count: document.querySelector('#count').textContent })" },
      app("react.inspect"),
    ]);
    expect(answers[0]).toMatchObject({ value: { beforeMount: false, present: false, count: "items: 1" } });
    expect(answers[1]).toMatchObject({ value: { ok: false, status: "not_detected" } });
  });

  test("an opted-in pre-mount hook exposes actual component state after the user changes it", async () => {
    const answers = await replies("app-checks-react.html", [
      { pageEval: "({ beforeMount: window.appHookBeforeMount })" },
      app("react.inspect", { name: "Counter", includeValues: true }),
      { op: "click", args: ["add one"] },
      { op: "wait", args: [null, { text: "items: 2" }] },
      app("react.inspect", { name: "Counter", includeValues: true }),
      { pageEval: "({ getterReads: window.appGetterReads })" },
    ], true);
    expect(answers[0]).toMatchObject({ value: { beforeMount: true } });
    expect(answers[1]).toMatchObject({ value: {
      ok: true, status: "inspected", hook: "harness", roots: 1, components: [{
        name: "Counter", props: { entries: { label: "items", password: { redacted: true }, metadata: { entries: { unreadable: { type: "accessor", withheld: true } } } } },
        hooks: { slots: [{ index: 0, kind: "useState", value: 1 }, { index: 1, kind: "useState", value: { entries: { apiToken: { redacted: true }, note: "draft note" } } }] },
        owners: [{ name: "Dashboard" }], source: { file: expect.stringContaining("app-checks-react.html"), line: 26 },
      }],
    } });
    expect(answers[4]).toMatchObject({ value: { components: [{ name: "Counter", hooks: { slots: [{ index: 0, kind: "useState", value: 2 }, expect.anything()] } }] } });
    expect(answers[5]).toMatchObject({ value: { getterReads: 0 } });
    expect(JSON.stringify(answers)).not.toContain("private-react-token-never-output");
    expect(JSON.stringify(answers)).not.toContain("private-react-password-never-output");
  }, 25_000);

  test("default React inspection withholds actual strings and scalar state values", async () => {
    const answers = await replies("app-checks-react.html", [app("react.inspect", { name: "Counter" })], true);
    expect(answers[0]).toMatchObject({ value: {
      valuesIncluded: false, components: [{ name: "Counter", props: { entries: { label: { type: "string", withheld: true }, password: { redacted: true } } }, hooks: { slots: [{ index: 0, value: { type: "number", withheld: true } }, expect.anything()] } }],
    } });
    expect(JSON.stringify(answers)).not.toContain("draft note");
    expect(JSON.stringify(answers)).not.toContain("private-react-token-never-output");
  });

  test("class inspection reads committed component state after a real setState update", async () => {
    const answers = await replies("app-checks-react.html", [
      app("react.inspect", { name: "Details", includeValues: true }),
      { op: "click", args: ["show details"] },
      { op: "wait", args: [null, { text: "hide details" }] },
      app("react.inspect", { name: "Details", includeValues: true }),
    ], true);
    expect(answers[0]).toMatchObject({ value: { components: [{ name: "Details", kind: "class", state: { entries: { expanded: false } } }] } });
    expect(answers[3]).toMatchObject({ value: { components: [{ name: "Details", kind: "class", state: { entries: { expanded: true } } }] } });
  }, 25_000);

  test("React inspection reports truncation when its component budget is reached", async () => {
    const answers = await replies("app-checks-react.html", [app("react.inspect", { maxComponents: 1 })], true);
    expect(answers[0]).toMatchObject({ value: { status: "inspected", truncated: true, components: [{ name: "Dashboard" }] } });
  });

  test("disabling the owned hook removes it and blocks further reads without breaking the app", async () => {
    const answers = await replies("app-checks-react.html", [
      app("react.disable"),
      { op: "click", args: ["add one"] },
      { op: "wait", args: [null, { text: "items: 2" }] },
      { pageEval: "({ present: Object.hasOwn(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__'), count: document.querySelector('#count').textContent })" },
      app("react.inspect"),
    ], true);
    expect(answers[0]).toMatchObject({ value: { ok: true, status: "disabled", removedHook: true } });
    expect(answers[3]).toMatchObject({ value: { present: false, count: "items: 2" } });
    expect(answers[4]).toMatchObject({ value: { ok: false, status: "disabled" } });
  }, 25_000);

  test("an already-present compatible hook is inspected but never replaced or removed on disable", async () => {
    const answers = await replies("app-checks-react.html?existing", [
      app("react.enable"),
      app("react.inspect", { name: "Counter", includeValues: true }),
      app("react.disable"),
      { pageEval: "({ same: window.__REACT_DEVTOOLS_GLOBAL_HOOK__ === window.appExistingHook.hook, disabled: window.appExistingHook.hook.isDisabled })" },
    ]);
    expect(answers[0]).toMatchObject({ value: { ok: true, status: "enabled", hook: "existing" } });
    expect(answers[1]).toMatchObject({ value: { status: "inspected", hook: "existing", components: [{ name: "Counter", hooks: { slots: [{ value: 1 }, expect.anything()] } }] } });
    expect(answers[2]).toMatchObject({ value: { ok: true, removedHook: false } });
    expect(answers[3]).toMatchObject({ value: { same: true, disabled: false } });
  });

  test("an unsupported pre-existing hook is reported honestly and left unchanged", async () => {
    const answers = await replies("app-checks-react.html?unsupported", [
      app("react.enable"), app("react.inspect"),
      { pageEval: "({ supportsFiber: window.__REACT_DEVTOOLS_GLOBAL_HOOK__.supportsFiber })" },
    ]);
    expect(answers[0]).toMatchObject({ value: { ok: false, status: "unsupported" } });
    expect(answers[1]).toMatchObject({ value: { ok: false, status: "unsupported" } });
    expect(answers[2]).toMatchObject({ value: { supportsFiber: false } });
  });
});
