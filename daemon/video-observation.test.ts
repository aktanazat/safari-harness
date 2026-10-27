import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runner } from "../bench/bench.ts";
import { HarnessError } from "./failures.ts";
import { createVideoTool } from "./video-observation.ts";

const root = join(import.meta.dir, "..");
const fields = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bench returned no object");
  return value as Record<string, unknown>;
};

async function fixture() {
  const media = Bun.file(join(root, "bench", "fixtures", "video-observation.mp4"));
  const mediaRequests: { range: string | null; status: number }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/video-observation.html") return new Response(request.method === "HEAD" ? null : Bun.file(join(root, "bench", "fixtures", "video-observation.html")), { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    if (path !== "/video-observation.mp4") return new Response(null, { status: 404 });
    // AVFoundation probes media with byte ranges; a full 200 response is not a range response.
    const headers = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" });
    const range = request.headers.get("range");
    if (range === null) {
      mediaRequests.push({ range, status: 200 });
      headers.set("content-length", String(media.size));
      return new Response(request.method === "HEAD" ? null : media, { headers });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, media.size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), media.size - 1) : media.size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= media.size || (!match[1] && Number(match[2]) === 0)) {
      mediaRequests.push({ range, status: 416 });
      headers.set("content-range", `bytes */${media.size}`);
      return new Response(null, { status: 416, headers });
    }
    mediaRequests.push({ range, status: 206 });
    headers.set("content-range", `bytes ${start}-${end}/${media.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(request.method === "HEAD" ? null : media.slice(start, end + 1), { status: 206, headers });
  } });
  const proc = Bun.spawn([runner, join(root, "extension")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const request = async (value: Record<string, unknown>): Promise<Record<string, unknown>> => {
    proc.stdin.write(`${JSON.stringify(value)}\n`);
    while (!buffered.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error(`bench stopped: ${await stderr}`);
      buffered += decoder.decode(next.value, { stream: true });
    }
    const end = buffered.indexOf("\n");
    const reply = fields(JSON.parse(buffered.slice(0, end)));
    buffered = buffered.slice(end + 1);
    if (typeof reply.error === "string") throw new Error(reply.error);
    return reply;
  };
  const evaluate = async (expression: string): Promise<unknown> => fields((await request({ op: "eval", args: [expression], timeout: 12000 })).value).result;
  const control = { held: false, released: false, captures: 0, visible: 0, maxVisible: 0, beforePresent: async () => {}, beforeCapture: async () => {} };
  const tool = createVideoTool({
    admit: async () => ({ signal: new AbortController().signal, check() { if (control.held) throw new HarnessError("stopped", "the user took control"); }, release() { control.released = true; } }),
    present: async (_tab, check, act) => {
      await control.beforePresent();
      check();
      control.visible++;
      control.maxVisible = Math.max(control.maxVisible, control.visible);
      try { return await act(); }
      finally { control.visible--; }
    },
    call: async (name, args) => {
      if (name === "eval") return fields((await request({ op: "eval", args: [args.expression], timeout: 12000 })).value);
      if (name !== "shot") throw new Error(`unexpected video tool ${name}`);
      control.captures++;
      await control.beforeCapture();
      throw new HarnessError("privacy", "screenshot privacy: capture refused", { effect: "none", retryable: false });
    },
  });
  const close = async () => {
    proc.stdin.end();
    try {
      const exit = await proc.exited;
      if (exit !== 0) throw new Error(`bench exited ${exit}: ${await stderr}`);
    } finally { reader.releaseLock(); server.stop(true); }
  };
  try {
    await request({ load: `http://127.0.0.1:${server.port}/video-observation.html` });
    await request({ op: "wait", args: [null, { any: ["video decoded", "video failed"] }], timeout: 6000 });
    const decoded = fields(await evaluate("({state:document.querySelector('#state').textContent,readyState:document.querySelector('#movie').readyState,width:document.querySelector('#movie').videoWidth,height:document.querySelector('#movie').videoHeight,error:document.querySelector('#movie').error?.code??null})"));
    expect(decoded).toMatchObject({ state: "video decoded", width: 160, height: 96, error: null });
    expect(Number(decoded.readyState)).toBeGreaterThanOrEqual(2);
    return { tool, evaluate, control, close };
  } catch (error) {
    let diagnostic: unknown;
    try { diagnostic = await evaluate("({state:document.querySelector('#state')?.textContent,readyState:document.querySelector('#movie')?.readyState,networkState:document.querySelector('#movie')?.networkState,error:document.querySelector('#movie')?.error?.code??null})"); }
    catch (inspectionError) { diagnostic = inspectionError instanceof Error ? inspectionError.message : String(inspectionError); }
    await close();
    throw new Error(`${error instanceof Error ? error.message : String(error)}; fixture: ${JSON.stringify(diagnostic)}; media requests: ${JSON.stringify(mediaRequests)}`, { cause: error });
  }
}

const mediaState = "({time:document.querySelector('#movie').currentTime,paused:document.querySelector('#movie').paused,rate:document.querySelector('#movie').playbackRate,muted:document.querySelector('#movie').muted})";

describe("video observation input contract", () => {
  const unavailable = createVideoTool({ call: async () => { throw new Error("invalid input crossed the browser boundary"); }, admit: async () => { throw new Error("invalid input reached admission"); }, present: async (_tab, check, act) => { check(); return act(); } });
  test.each([
    ["empty times", []], ["more than eight moments", Array.from({ length: 9 }, (_, n) => n)],
    ["negative time", [-1]], ["nonfinite time", [Infinity]], ["not numeric", ["1"]],
  ])("rejects %s before touching the browser", async (_name, times) => {
    await expect(unavailable.run({ tab: 7, ref: "#movie", do: "frames", times })).rejects.toMatchObject({ code: "invalid_argument", effect: "none" });
  });
});

describe.skipIf(!runner)("video observations in real WebKit", () => {
  test("inspection reports actual decoded video without revealing media query secrets or changing playback", async () => {
    const page = await fixture();
    try {
      const before = await page.evaluate(mediaState);
      const result = await page.tool.run({ tab: 7, selector: "#movie" });
      expect(result).toMatchObject({ status: "inspected", source: { width: 160, height: 96, duration: 2, paused: true, protected: false } });
      expect(JSON.stringify(result)).not.toContain("private-video-query");
      expect(await page.evaluate(mediaState)).toEqual(before);
      expect(page.control.released).toBe(true);
    } finally { await page.close(); }
  }, 20000);

  test("a refused protected capture restores the original paused position, rate and mute", async () => {
    const page = await fixture();
    try {
      await page.evaluate("document.querySelector('#movie').playbackRate=1.25");
      const before = await page.evaluate(mediaState);
      await expect(page.tool.run({ tab: 7, ref: "#movie", do: "frames", times: [1.4] })).rejects.toMatchObject({ code: "privacy", effect: "possibly_effected", retryable: false });
      expect(await page.evaluate(mediaState)).toEqual(before);
      expect(page.control.captures).toBe(1);
      expect(page.control.released).toBe(true);
    } finally { await page.close(); }
  }, 20000);

  test("a paused currentTime frame can settle without waiting forever for a new decoded frame", async () => {
    const page = await fixture();
    try {
      const before = fields(await page.evaluate(mediaState));
      await expect(page.tool.run({ tab: 7, ref: "#movie", do: "frames", times: [before.time] })).rejects.toMatchObject({ code: "privacy", effect: "possibly_effected" });
      expect(page.control.captures).toBe(1);
      expect(await page.evaluate(mediaState)).toEqual(before);
    } finally { await page.close(); }
  }, 20000);

  test("a media change during capture is not overwritten by restoration", async () => {
    const page = await fixture();
    try {
      page.control.beforeCapture = async () => { await page.evaluate("document.querySelector('#movie').playbackRate=1.5"); };
      await expect(page.tool.run({ tab: 7, ref: "#movie", do: "frames", times: [1.4] })).rejects.toMatchObject({ code: "privacy", effect: "possibly_effected", retryable: false });
      expect(await page.evaluate(mediaState)).toMatchObject({ time: 1.4, paused: true, rate: 1.5 });
    } finally { await page.close(); }
  }, 20000);

  test("a task takeover during capture stops restoration and all further frames", async () => {
    const page = await fixture();
    try {
      page.control.beforeCapture = async () => { page.control.held = true; };
      await expect(page.tool.run({ tab: 7, ref: "#movie", do: "frames", times: [1.4, 0.2] })).rejects.toMatchObject({ effect: "possibly_effected", retryable: false });
      expect(await page.evaluate(mediaState)).toMatchObject({ time: 1.4, paused: true });
      expect(page.control.captures).toBe(1);
      expect(page.control.released).toBe(true);
    } finally { await page.close(); }
  }, 20000);

  test("two captures do not compete for the foreground and both leave playback unchanged", async () => {
    const page = await fixture();
    try {
      const before = await page.evaluate(mediaState);
      const results = await Promise.allSettled([
        page.tool.run({ tab: 7, ref: "#movie", do: "frames", times: [0.2] }),
        page.tool.run({ tab: 8, ref: "#movie", do: "frames", times: [1.4] }),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "privacy" });
      }
      expect(page.control.maxVisible).toBe(1);
      expect(page.control.captures).toBe(2);
      expect(await page.evaluate(mediaState)).toEqual(before);
    } finally { await page.close(); }
  }, 20000);

  test("a paused task does not present or change the video after its idle wait", async () => {
    const page = await fixture();
    try {
      const before = await page.evaluate(mediaState);
      page.control.beforePresent = async () => { page.control.held = true; };
      await expect(page.tool.run({ tab: 7, ref: "#movie", do: "frames", times: [1.4] })).rejects.toMatchObject({ code: "stopped" });
      expect(page.control.visible).toBe(0);
      expect(page.control.captures).toBe(0);
      expect(page.control.released).toBe(true);
      expect(await page.evaluate(mediaState)).toEqual(before);
    } finally { await page.close(); }
  }, 20000);

  test("out-of-range moments are refused before changing playback", async () => {
    const page = await fixture();
    try {
      const before = await page.evaluate(mediaState);
      await expect(page.tool.run({ tab: 7, ref: "#movie", do: "frames", times: [200] })).rejects.toThrow("outside the currently seekable media");
      expect(await page.evaluate(mediaState)).toEqual(before);
      expect(page.control.captures).toBe(0);
    } finally { await page.close(); }
  }, 20000);
});
