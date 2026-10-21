import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bridge } from "./bridge.ts";
import { captureFixture, connect } from "./fake-safari.ts";
import { callTool, captureTab } from "./tools.ts";
import { verifyEvidence, type CaptureResult } from "./evidence.ts";
import { keepSecret, tabSecrets } from "./redact.ts";

const HOME = "https://shop.example/";
const CART = "https://shop.example/cart";
const DOWN = "https://down.example/";
const DOWN_ERROR = "the page did not load within 30 s";

const tabs = new Map<number, { id: number; windowId: number; url: string; title: string }>();
const windowWidth = new Map<number, number>();
let nextId = 700;

function answer(op: string, args: unknown[]): { value?: unknown; error?: string } {
  if (op === "windows.open") {
    const windowId = ++nextId;
    const page = { id: ++nextId, windowId, url: String(args[0]), title: "Page" };
    tabs.set(page.id, page);
    windowWidth.set(windowId, 1000);
    return { value: { windowId, tabId: page.id } };
  }
  if (op === "windows.resolve") return { value: null };
  if (op === "tabs.list") return { value: [...tabs.values()] };
  if (op === "tabs.open") {
    const tab = { id: ++nextId, windowId: Number(args[2]), url: String(args[0]), title: "Page" };
    tabs.set(tab.id, tab);
    return { value: tab };
  }
  const tab = tabs.get(Number(args[0]));
  if (op === "window") {
    if (!tab) return { error: "no tab" };
    const { width, height } = args[1] as { width: number; height: number };
    windowWidth.set(tab.windowId, width);
    return { value: { windowId: tab.windowId, size: { width, height } } };
  }
  if (op === "tabs.navigate") {
    if (!tab) return { error: "no tab" };
    if (args[1] === DOWN) return { error: DOWN_ERROR };
    tab.url = String(args[1]);
    return { value: tab };
  }
  if (op === "shot") {
    if (!tab) return { error: "no tab" };
    return { value: captureFixture(tab.url, windowWidth.get(tab.windowId), 2) };
  }
  if (op === "tabs.close") {
    tabs.delete(Number(args[0]));
    return { value: { ok: true } };
  }
  // a relay: the quiet wait is met at once
  if (op === "relay") return { value: args[1] === "wait" ? { found: true } : { ok: true } };
  return { value: { ok: true } };
}

beforeEach(() => {
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      const reply = answer(op, args);
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
    },
    close() {},
  });
});

const outputs: string[] = [];
const freshOut = () => {
  const root = mkdtempSync(join(tmpdir(), "tools-shots-"));
  outputs.push(root);
  return join(root, "evidence", "run-1");
};
afterEach(() => {
  for (const root of outputs.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Shot = ({ url: string; width: number } & CaptureResult) | { url: string; width: number; error: string };

const shown = (files: Shot[]) => Promise.all(files.map(async (file) => {
  if ("error" in file) return { url: file.url, width: file.width, shows: file.error };
  const verified = await verifyEvidence(file.evidence.path);
  const width = readFileSync(file.path).readUInt32BE(16);
  return { url: file.url, width: file.width, shows: `${verified.evidence.url} at ${width}` };
}));

test("shots of 2 addresses at 2 widths writes 4 PNGs into a folder it makes, each the page at its width", async () => {
  const out = freshOut();
  const r = (await callTool("shots", { urls: [HOME, CART], widths: [390, 1440], out })) as { ok?: boolean; files: Shot[] };
  expect(r.ok).toBeUndefined();
  expect(new Set(r.files.map((f) => "path" in f ? f.path : undefined)).size).toBe(4);
  expect(r.files.every((f) => "path" in f && dirname(f.path) === out)).toBe(true);
  expect((await shown(r.files)).sort((a, b) => `${a.url} ${a.width}`.localeCompare(`${b.url} ${b.width}`))).toEqual([
    { url: HOME, width: 1440, shows: `${HOME} at 1440` },
    { url: HOME, width: 390, shows: `${HOME} at 390` },
    { url: CART, width: 1440, shows: `${CART} at 1440` },
    { url: CART, width: 390, shows: `${CART} at 390` },
  ]);
});

test("batch captures leave no owned tab open after saving their evidence", async () => {
  const before = new Set(tabs.keys());
  await callTool("shots", { urls: [HOME, CART], widths: [390, 1440], out: freshOut() });
  expect(new Set(tabs.keys())).toEqual(before);
});

test("a page that fails to load is a miss in its place at each width, and the other pages are still shot", async () => {
  const r = (await callTool("shots", { urls: [DOWN, HOME], widths: [390, 1440], out: freshOut() })) as { ok?: boolean; files: Shot[] };
  expect(r.ok).toBe(false);
  expect(await shown(r.files)).toEqual([
    { url: DOWN, width: 390, shows: DOWN_ERROR },
    { url: HOME, width: 390, shows: `${HOME} at 390` },
    { url: DOWN, width: 1440, shows: DOWN_ERROR },
    { url: HOME, width: 1440, shows: `${HOME} at 1440` },
  ]);
});

test("a remembered numeric code cannot corrupt a capture's timestamp", async () => {
  const code = "2026";
  const tab = { id: ++nextId, windowId: ++nextId, url: `${HOME}?token=${code}`, title: "Synthetic code fixture" };
  tabs.set(tab.id, tab);
  keepSecret(tab.id, code);
  try {
    const capture = await callTool("shot", { tab: tab.id, out: join(freshOut(), "numeric-code.png") }) as CaptureResult;
    const verified = await verifyEvidence(capture.evidence.path);
    expect(Number.isFinite(Date.parse(verified.evidence.capturedAt))).toBe(true);
    expect(verified.evidence.url).not.toContain(code);
    expect(verified.image.equals(readFileSync(capture.path))).toBe(true);
  } finally {
    tabSecrets.delete(tab.id);
    tabs.delete(tab.id);
  }
});

test("raw screenshot consumers refuse missing protection metadata", async () => {
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      const reply = op === "shot" ? { value: { data: captureFixture(HOME).data } } : answer(op, args);
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
    },
    close() {},
  });
  await expect(captureTab(++nextId)).rejects.toMatchObject({ code: "privacy", effect: "none" });
});
