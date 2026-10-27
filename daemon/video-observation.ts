import type { CaptureResult } from "./evidence.ts";
import { failureOf, HarnessError } from "./failures.ts";
import type { Tool } from "./tools.ts";

type Fields = Record<string, unknown>;
export type VideoObservationPermit = { signal: AbortSignal; check(): void; release(): void };
export type VideoObservationDependencies = {
  call(tool: string, args: Fields): Promise<unknown>;
  admit(tab: number, acting: boolean): Promise<VideoObservationPermit>;
  present<T>(tab: number, act: () => Promise<T>): Promise<T>;
};
export type VideoSource = {
  document: string;
  media: string | null;
  duration: number | null;
  width: number;
  height: number;
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  muted: boolean;
  readyState: number;
  seekable: [number, number][];
  protected: boolean;
};
type Checkpoint = { document: number; media: string; time: number; paused: boolean; rate: number; muted: boolean };
export type VideoFrame = { requestedTime: number; actualTime: number; timestampBasis: string; source: VideoSource; capture: CaptureResult };
export type VideoFramesResult = { status: "captured"; frames: VideoFrame[]; restoration: Fields };

function object(value: unknown, label: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("unavailable", `${label} returned no usable result`, { effect: "none", retryable: false });
  return value as Fields;
}

// Each evaluation owns and removes its own hooks. Nothing is installed between calls.
async function inVideoDocument(input: { operation: string; target: string; time?: number; times?: number[]; expected?: Checkpoint; original?: Checkpoint }, helpers?: { resolve(target: string): Element | null }) {
  const unavailable = (reason: string): never => { throw new Error(`video unavailable: ${reason}`); };
  if (typeof helpers?.resolve !== "function") return unavailable("isolated ref resolution is unavailable; page-world evaluation is not permitted");
  const element = helpers.resolve(input.target);
  if (!(element instanceof HTMLVideoElement)) return unavailable("the target is not an accessible HTML video element; embedded players require a readable frame ref");
  const video = element;
  const rawSource = video.currentSrc;
  const documentTime = performance.timeOrigin;
  const safeAddress = (raw: string): string | null => {
    if (!raw) return null;
    try {
      const url = new URL(raw, location.href);
      if (url.protocol === "blob:") return "blob:";
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:") return url.protocol;
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch { return null; }
  };
  const metadata = (): VideoSource => ({
    document: safeAddress(location.href) ?? location.protocol, media: safeAddress(video.currentSrc),
    duration: Number.isFinite(video.duration) ? video.duration : null,
    width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime,
    paused: video.paused, playbackRate: video.playbackRate, muted: video.muted, readyState: video.readyState,
    seekable: Array.from({ length: Math.min(video.seekable.length, 32) }, (_, n) => [video.seekable.start(n), video.seekable.end(n)] as [number, number]),
    protected: Boolean(video.mediaKeys || (video as HTMLVideoElement & { webkitKeys?: unknown }).webkitKeys),
  });
  if (input.operation === "inspect") return { status: "inspected", source: metadata() };
  if (metadata().protected) return unavailable("encrypted/protected media cannot provide trustworthy visible-frame evidence");
  if (video.srcObject) return unavailable("live media streams cannot be sampled by a finite timestamp");
  if (video.error || !rawSource || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return unavailable("the loaded media has no decoded frame");
  if (!crypto.subtle) return unavailable("a private media identity check is unavailable");
  const identity = Promise.withResolvers<ArrayBuffer>();
  const cancelIdentity = (event: Event) => { if (event.isTrusted) identity.reject(new Error("video unavailable: human intervention during media identification")); };
  const identityEvents = ["pointerdown", "keydown", "touchstart", "wheel", "pagehide"];
  for (const event of identityEvents) window.addEventListener(event, cancelIdentity, true);
  const identityTimeout = window.setTimeout(() => identity.reject(new Error("video unavailable: media identification did not finish within 2 seconds")), 2000);
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawSource)).then(identity.resolve, identity.reject);
  let fingerprint: string;
  try {
    fingerprint = Array.from(new Uint8Array(await identity.promise), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    clearTimeout(identityTimeout);
    for (const event of identityEvents) window.removeEventListener(event, cancelIdentity, true);
  }
  const checkpoint = (): Checkpoint => ({ document: documentTime, media: fingerprint, time: video.currentTime, paused: video.paused, rate: video.playbackRate, muted: video.muted });
  const current = checkpoint();
  const expected = input.expected;
  if (expected && (expected.document !== current.document || expected.media !== current.media || expected.paused !== current.paused || expected.rate !== current.rate || expected.muted !== current.muted || Math.abs(expected.time - current.time) > 0.001)) return unavailable("document or media state changed; playback was left with the user");
  if (video.currentSrc !== rawSource || helpers.resolve(input.target) !== video || video.ownerDocument !== document || !video.isConnected) return unavailable("the selected media changed during inspection");
  if (input.operation === "verify") return { source: metadata(), checkpoint: checkpoint() };
  if (input.operation === "begin") {
    if (!input.times?.every((time) => metadata().seekable.some(([start, end]) => time >= start && time < end))) return unavailable("a requested timestamp is outside the currently seekable media");
    video.pause();
    return { original: current, checkpoint: checkpoint(), source: metadata() };
  }
  if (input.operation !== "seek" && input.operation !== "restore") return unavailable("unknown operation");
  const time = input.operation === "restore" ? input.original!.time : input.time!;
  const source = metadata();
  if (!source.seekable.some(([start, end]) => time >= start && (input.operation === "restore" ? time <= end : time < end))) return unavailable("the requested moment is no longer seekable");
  if (!video.paused) return unavailable("the selected media is no longer paused");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const removals: (() => void)[] = [];
  let timer: number | undefined;
  let raf = 0;
  let frame = 0;
  let frameTime: number | undefined;
  let interrupted = false;
  let completed = false;
  let rejectResume: ((reason: Error) => void) | undefined;
  const listen = (target: EventTarget, name: string, listener: EventListener, capture = false) => {
    target.addEventListener(name, listener, capture);
    removals.push(() => target.removeEventListener(name, listener, capture));
  };
  const finish = (reason?: string) => {
    if (completed) return;
    completed = true;
    if (reason) reject(new Error(`video unavailable: ${reason}`));
    else resolve();
  };
  const interrupt = () => {
    interrupted = true;
    const reason = "human or page intervention; playback was left with the user";
    finish(reason);
    rejectResume?.(new Error(`video unavailable: ${reason}`));
  };
  const valid = () => {
    if (interrupted || !video.isConnected || video.ownerDocument !== document || helpers?.resolve(input.target) !== video || video.currentSrc !== rawSource || video.srcObject || performance.timeOrigin !== documentTime) return unavailable("the video or document changed");
    if (!video.paused || video.playbackRate !== current.rate || video.muted !== current.muted || metadata().protected || video.error) return unavailable("media state changed outside this observation");
  };
  const paint = () => {
    if (completed || video.seeking) return;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => finish()); });
  };
  try {
    for (const event of ["pointerdown", "keydown", "touchstart", "wheel"]) listen(document, event, ((event: Event) => { if (event.isTrusted) interrupt(); }) as EventListener, true);
    listen(window, "pagehide", interrupt);
    const mediaListeners = removals.length;
    listen(video, "seeked", paint);
    listen(video, "error", () => finish("media decoding failed"));
    for (const event of ["play", "ratechange", "volumechange", "emptied", "encrypted"]) listen(video, event, () => { try { valid(); } catch { interrupt(); } });
    timer = window.setTimeout(() => finish("the frame did not seek and paint within 4 seconds"), 4000);
    if (typeof video.requestVideoFrameCallback === "function") frame = video.requestVideoFrameCallback((_now, info) => { frame = 0; frameTime = info.mediaTime; if (!video.seeking) paint(); });
    if (Math.abs(video.currentTime - time) > 0.000001) video.currentTime = time;
    else paint();
    await promise;
    valid();
    if (video.seeking || video.readyState < 2 || Math.abs(video.currentTime - time) > 0.05) return unavailable("the requested frame did not settle");
    if (input.operation === "restore") {
      for (const remove of removals.splice(mediaListeners)) remove();
      if (!input.original!.paused) {
        const resumed = Promise.withResolvers<void>();
        rejectResume = resumed.reject;
        clearTimeout(timer);
        timer = window.setTimeout(() => resumed.reject(new Error("video unavailable: original playback did not resume within 4 seconds")), 4000);
        video.play().then(() => resumed.resolve(), resumed.reject);
        await resumed.promise;
        if (interrupted || video.currentSrc !== rawSource || video.playbackRate !== current.rate || video.muted !== current.muted) return unavailable("media state changed while original playback resumed");
      }
      return { restored: true, currentTime: video.currentTime, paused: video.paused, playbackRate: video.playbackRate, muted: video.muted, checkpoint: checkpoint() };
    }
    const hasFrameTime = frameTime !== undefined && frameTime <= video.currentTime + 0.001 && video.currentTime - frameTime < 0.5;
    return { actualTime: hasFrameTime ? frameTime : video.currentTime, timestampBasis: hasFrameTime ? "video-frame" : "settled-current-time", source: metadata(), checkpoint: checkpoint() };
  } catch (error) {
    let unchanged = false;
    try { valid(); unchanged = true; } catch { /* An intervention must not become a new restoration baseline. */ }
    return { failure: error instanceof Error ? error.message : String(error), interrupted: !unchanged, ...(unchanged ? { checkpoint: checkpoint() } : {}) };
  } finally {
    clearTimeout(timer);
    if (raf) cancelAnimationFrame(raf);
    if (frame) video.cancelVideoFrameCallback(frame);
    for (const remove of removals) remove();
  }
}

export function createVideoTool(dependencies: VideoObservationDependencies): Tool {
  return {
    hidden: true,
    desc: "Inspect a currently loaded HTML video or capture up to eight settled visible moments with protected screenshot receipts. No downloading or transcript substitution. Frames temporarily seek, then restore playback only while this task still owns the unchanged document.",
    params: {
      tab: { type: "number", description: "exact tab opened by this caller" },
      ref: { type: "string", description: "video snapshot ref or CSS selector; frame refs are supported" },
      selector: { type: "string", description: "CSS selector instead of ref" },
      do: { type: "string", enum: ["inspect", "frames"], description: "default inspect" },
      times: { type: "array", items: { type: "number" }, description: "frames only: one to eight finite nonnegative times in seconds" },
    },
    required: ["tab"],
    run: async (args): Promise<unknown> => {
      if (!Number.isSafeInteger(args.tab) || Number(args.tab) < 1) throw new HarnessError("invalid_argument", "video needs an exact positive tab id");
      const tab = Number(args.tab);
      const operation = args.do ?? "inspect";
      if (operation !== "inspect" && operation !== "frames") throw new HarnessError("invalid_argument", "video do must be inspect or frames");
      if ((args.ref === undefined) === (args.selector === undefined)) throw new HarnessError("invalid_argument", "video needs exactly one ref or selector");
      const target = args.ref ?? args.selector;
      if (typeof target !== "string" || !target.trim() || target.length > 4096) throw new HarnessError("invalid_argument", "video target must be a nonempty ref or selector");
      if (operation === "inspect" && args.times !== undefined) throw new HarnessError("invalid_argument", "times is only valid for video frames");
      const times = args.times;
      if (operation === "frames" && (!Array.isArray(times) || times.length < 1 || times.length > 8 || times.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0))) throw new HarnessError("invalid_argument", "video frames needs one to eight finite nonnegative times in seconds");
      const [, frame = "0", localTarget] = /^(?:f(\d+):)?([\s\S]*)$/.exec(target)!;
      const prefix = frame === "0" ? "" : `f${frame}:`;
      const permit = await dependencies.admit(tab, operation === "frames");
      let original: Checkpoint | undefined;
      let expected: Checkpoint | undefined;
      let restoreAllowed = true;
      let dispatched = false;
      let failure: unknown;
      let restoration: Fields = { restored: false, reason: "not started" };
      const frames: VideoFrame[] = [];
      const check = () => { permit.signal.throwIfAborted(); permit.check(); };
      const evaluate = async (action: string, time?: number): Promise<Fields> => {
        check();
        const input = { operation: action, target: localTarget, time, times, expected, original };
        const result = object(await dependencies.call("eval", { tab, expression: `${prefix}(${inVideoDocument.toString()})(${JSON.stringify(input)}, typeof sh === "undefined" ? undefined : sh)`, timeoutMs: action === "restore" ? 12500 : 8500 }).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes("human intervention")) restoreAllowed = false;
          if (error instanceof Error && error.message.includes("video unavailable:")) throw new HarnessError("unavailable", error.message, { effect: "none", retryable: false });
          throw error;
        }), "video evaluation");
        const value = object(result.result, "video document");
        if (value.checkpoint) expected = object(value.checkpoint, "video checkpoint") as Checkpoint;
        if (value.original) original = object(value.original, "original video checkpoint") as Checkpoint;
        if (value.interrupted === true) restoreAllowed = false;
        check();
        if (typeof value.failure === "string") throw new HarnessError("unavailable", value.failure, { retryable: false });
        return value;
      };
      try {
        if (operation === "inspect") return await evaluate("inspect");
        return await dependencies.present(tab, async () => {
          try {
            check();
            dispatched = true;
            await evaluate("begin");
            for (const time of times as number[]) {
              const settled = await evaluate("seek", time);
              check();
              const capture = object(await dependencies.call("shot", { tab, ref: target, live: true }), "protected video capture");
              if (typeof capture.path !== "string" || !capture.evidence || typeof capture.evidence !== "object") throw new HarnessError("privacy", "video capture returned no protected evidence receipt", { retryable: false });
              await evaluate("verify");
              frames.push({ requestedTime: time, actualTime: Number(settled.actualTime), timestampBasis: String(settled.timestampBasis), source: object(settled.source, "settled video source") as VideoSource, capture: capture as CaptureResult });
            }
          } catch (error) { failure = error; }
          finally {
            if (original && restoreAllowed) {
              try { restoration = await evaluate("restore"); }
              catch (error) { restoration = { restored: false, reason: error instanceof Error ? error.message : String(error) }; }
            }
            else if (original) restoration = { restored: false, reason: "human or page intervention; playback was left with the user" };
          }
          if (failure !== undefined) {
            const known = failureOf(failure, { effectful: dispatched });
            throw new HarnessError(known.code, `${known.message}; restoration: ${JSON.stringify(restoration)}`, { effect: dispatched ? "possibly_effected" : known.effect, retryable: false, next: known.next });
          }
          return { status: "captured", frames, restoration } satisfies VideoFramesResult;
        });
      } finally {
        permit.release();
      }
    },
  };
}
