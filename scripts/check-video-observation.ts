import assert from "node:assert/strict";
import { join } from "node:path";
import { inFront } from "../daemon/front.ts";
import { removeCapture, verifyEvidence, type CaptureResult } from "../daemon/evidence.ts";
import type { VideoFramesResult, VideoSource } from "../daemon/video-observation.ts";

const base = process.env.SAFARI_HARNESS_HTTP ?? "http://127.0.0.1:37334";
const ua = "OpenAI File Downloader, XaiImageApiFetch/1.0";
async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${base}/rpc`, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify({ tool, args, caller: process.pid, own: true }) });
  const reply = await response.json() as { ok: boolean; value: T; error?: string };
  if (!reply.ok) throw new Error(`${tool}: ${reply.error}`);
  return reply.value;
}

const ffmpeg = Bun.which("ffmpeg");
if (!ffmpeg) throw new Error("ffmpeg is needed to inspect the colours in the verified protected evidence images");
const captures: CaptureResult[] = [];
let tab: number | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const html = Bun.file(join(import.meta.dir, "..", "bench", "fixtures", "video-observation.html"));
  const media = Bun.file(join(import.meta.dir, "..", "bench", "fixtures", "video-observation.mp4"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/video-observation.html") return new Response(request.method === "HEAD" ? null : html, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    if (path !== "/video-observation.mp4") return new Response(null, { status: 404 });
    const headers = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" });
    const range = request.headers.get("range");
    if (range === null) {
      headers.set("content-length", String(media.size));
      return new Response(request.method === "HEAD" ? null : media, { headers });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, media.size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), media.size - 1) : media.size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= media.size || (!match[1] && Number(match[2]) === 0)) {
      headers.set("content-range", `bytes */${media.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${media.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(request.method === "HEAD" ? null : media.slice(start, end + 1), { status: 206, headers });
  } });
  tab = (await call<{ id: number }>("open", { url: `http://127.0.0.1:${server.port}/video-observation.html`, background: true, new: true })).id;
  try {
    await call("wait", { tab, any: ["video decoded", "video failed"], ms: 6000 });
    const state = await call<{ result: { state: string; readyState: number; networkState: number; error: number | null } }>("eval", { tab, expression: "({state:document.querySelector('#state').textContent,readyState:document.querySelector('#movie').readyState,networkState:document.querySelector('#movie').networkState,error:document.querySelector('#movie').error?.code??null})" });
    assert.equal(state.result.state, "video decoded", JSON.stringify(state.result));
    assert.ok(state.result.readyState >= 2, "the checked-in media has no decoded frame");
    assert.equal(state.result.error, null);
  } catch (error) {
    const diagnostic = await call("eval", { tab, expression: "({state:document.querySelector('#state')?.textContent,readyState:document.querySelector('#movie')?.readyState,networkState:document.querySelector('#movie')?.networkState,error:document.querySelector('#movie')?.error?.code??null})" }).catch((inspectionError: unknown) => inspectionError instanceof Error ? inspectionError.message : String(inspectionError));
    throw new Error(`checked-in video did not decode: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  const before = await call<{ status: string; source: VideoSource }>("video", { tab, ref: "#movie", do: "inspect" });
  assert.equal(before.status, "inspected");
  assert.equal(before.source.width, 160);
  assert.equal(before.source.height, 96);
  assert.equal(before.source.duration, 2);
  assert.ok(!JSON.stringify(before).includes("private-video-query"));
  const captured = await inFront(tab, {
    tabs: async () => (await call<{ tabs: { id: number; windowId?: number; active?: boolean; front?: boolean }[] }>("tabs")).tabs,
    activate: (id) => call("activate", { tab: id }),
  }, async () => {
    const result = await call<VideoFramesResult>("video", { tab, ref: "#movie", do: "frames", times: [0.2, 1.4] });
    captures.push(...result.frames.map((frame) => frame.capture));
    return result;
  });
  assert.equal(captured.status, "captured");
  assert.equal(captured.frames.length, 2);
  assert.equal(captured.restoration.restored, true);
  for (const [index, frame] of captured.frames.entries()) {
    const requested = [0.2, 1.4][index];
    assert.equal(frame.requestedTime, requested);
    assert.ok(Number.isFinite(frame.actualTime));
    assert.ok(Math.abs(frame.actualTime - requested) < 0.15, "actual visible frame is outside its timestamp tolerance");
    assert.ok(Math.abs(frame.source.currentTime - requested) < 0.05);
    assert.ok(!JSON.stringify(frame.source).includes("private-video-query"));
    const verified = await verifyEvidence(frame.capture.evidence.path);
    assert.equal(verified.evidence.sha256, frame.capture.evidence.sha256);
    assert.ok(verified.evidence.crop, "video evidence was not cropped through the protected target");
    const decoded = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "crop=iw/2:ih/2:iw/4:ih/4,scale=1:1", "-frames:v", "1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdin: verified.image, stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const [code, rgb, diagnostic] = await Promise.all([decoded.exited, new Response(decoded.stdout).arrayBuffer(), new Response(decoded.stderr).text()]);
    assert.equal(code, 0, `verified screenshot colour inspection failed: ${diagnostic}`);
    const channels = new Uint8Array(rgb);
    assert.equal(channels.length, 3, "protected screenshot did not yield one RGB pixel");
    const dominant = index === 0 ? 0 : 2;
    assert.ok(channels[dominant] > 180 && channels[(dominant + 1) % 3] < 75 && channels[(dominant + 2) % 3] < 75, `protected ${index === 0 ? "red" : "blue"} moment has the wrong visible colour: ${Array.from(channels)}`);
  }
  assert.notEqual(captured.frames[0].capture.evidence.sha256, captured.frames[1].capture.evidence.sha256, "red and blue moments returned identical evidence images");
  const after = await call<{ source: VideoSource }>("video", { tab, selector: "#movie", do: "inspect" });
  assert.equal(after.source.currentTime, before.source.currentTime);
  assert.equal(after.source.paused, before.source.paused);
  assert.equal(after.source.playbackRate, before.source.playbackRate);
  assert.equal(after.source.muted, before.source.muted);
  await assert.rejects(call("video", { tab, ref: "#movie", do: "frames", times: [200] }), /outside the currently seekable media/);
  const unchanged = await call<{ source: VideoSource }>("video", { tab, ref: "#movie" });
  assert.equal(unchanged.source.currentTime, before.source.currentTime);
  await inFront(tab, {
    tabs: async () => (await call<{ tabs: { id: number; windowId?: number; active?: boolean; front?: boolean }[] }>("tabs")).tabs,
    activate: (id) => call("activate", { tab: id }),
  }, async () => {
    await call("eval", { tab, expression: "(async()=>{const v=document.querySelector('#movie');v.currentTime=0.2;v.playbackRate=0.5;await v.play();return {paused:v.paused,rate:v.playbackRate}})()" });
    const playing = await call<VideoFramesResult>("video", { tab, ref: "#movie", do: "frames", times: [1.4] });
    captures.push(...playing.frames.map((frame) => frame.capture));
    assert.equal(playing.restoration.restored, true);
    assert.equal(playing.restoration.paused, false);
    assert.equal(playing.restoration.playbackRate, 0.5);
    assert.equal(playing.restoration.muted, true);
    const resumed = await call<{ source: VideoSource }>("video", { tab, ref: "#movie" });
    assert.equal(resumed.source.paused, false);
    assert.equal(resumed.source.playbackRate, 0.5);
    assert.equal(resumed.source.muted, true);
    assert.ok(resumed.source.currentTime >= Number(playing.restoration.currentTime), "restored playing media did not retain its position");
    await verifyEvidence(playing.frames[0].capture.evidence.path);
    await call("eval", { tab, expression: "document.querySelector('#movie').pause()" });
  });
  console.log(JSON.stringify({ passed: 4, failed: 0, scenarios: ["checked-in media produces verified red and blue protected frames", "original paused position restored", "unseekable time refused without mutation", "original playing state and rate restored"], frames: captured.frames.map((frame) => ({ requestedSeconds: frame.requestedTime, actualSeconds: frame.actualTime, timestampBasis: frame.timestampBasis })) }));
} finally {
  try { if (tab !== undefined) await call("close", { tab }); }
  finally {
    server?.stop(true);
    for (const capture of captures) await removeCapture(capture.evidence.path);
  }
}
