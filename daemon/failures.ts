export type FailureCode = "stale_view" | "effect_unknown" | "privacy" | "blocked" | "not_content" | "timeout" | "unavailable" | "aborted" | "invalid_argument" | "command_failed" | "stopped" | "waiting_for_human" | "rate_limited";
export type FailureEffect = "none" | "possibly_effected";
export type Failure = { ok: false; code: FailureCode; retryable: boolean; effect: FailureEffect; message: string; next: string };
type FailureOptions = { retryable?: boolean; effect?: FailureEffect; next?: string; recovery?: { kind: "present"; document: string; target: string; frame?: number }; detail?: { host: string; resetAt: number } };

const DEFAULTS: Record<FailureCode, { effect: FailureEffect; retryable: boolean; next: string }> = {
  stale_view: { effect: "none", retryable: true, next: "read a fresh snapshot of this tab before acting again." },
  effect_unknown: { effect: "possibly_effected", retryable: false, next: "read a fresh snapshot and check what happened before repeating the action." },
  privacy: { effect: "none", retryable: false, next: "stop this read or capture; keep secret fields hidden and do not bypass the privacy guard." },
  blocked: { effect: "none", retryable: false, next: "report the block or use an authorized source; do not bypass access controls." },
  not_content: { effect: "none", retryable: false, next: "inspect the page state and use a source you are allowed to read." },
  timeout: { effect: "possibly_effected", retryable: true, next: "check whether the page or service is ready before trying again." },
  unavailable: { effect: "possibly_effected", retryable: true, next: "check the Safari connection and service status before trying again." },
  aborted: { effect: "possibly_effected", retryable: false, next: "leave the cancelled operation stopped until a new request is made." },
  invalid_argument: { effect: "none", retryable: true, next: "correct the arguments before making a new call." },
  command_failed: { effect: "possibly_effected", retryable: false, next: "inspect the error and current state before choosing another action." },
  stopped: { effect: "none", retryable: false, next: "leave control with the user; resume only after a new takeover and fresh read." },
  waiting_for_human: { effect: "none", retryable: false, next: "wait for the user to finish the requested step, then read the page again." },
  rate_limited: { effect: "none", retryable: true, next: "ask that site again after it resets (detail.resetAt, epoch ms); meanwhile use another source." },
};

export class HarnessError extends Error {
  readonly code: FailureCode;
  readonly retryable: boolean;
  readonly effect: FailureEffect;
  readonly next: string;
  readonly recovery?: { kind: "present"; document: string; target: string; frame?: number };
  // rate_limited: the host and when its limit resets, in epoch ms.
  readonly detail?: { host: string; resetAt: number };

  constructor(code: FailureCode, message: string, options: FailureOptions = {}) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.effect = options.effect ?? DEFAULTS[code].effect;
    this.retryable = options.retryable ?? (this.effect === "none" && DEFAULTS[code].retryable);
    this.next = options.next ?? (this.effect === "possibly_effected" ? DEFAULTS.effect_unknown.next : DEFAULTS[code].next);
    this.recovery = this.effect === "none" ? options.recovery : undefined;
    this.detail = options.detail;
  }
}

// host's rate limit, as the site named it, or as the back-off the harness
// keeps when it named none (pace.ts).
export function rateLimited(host: string, resetAt: number, guessed = false): HarnessError {
  const s = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
  const named = guessed ? `; ${host} named no reset time, so that is the harness's back-off` : "";
  return new HarnessError("rate_limited", `${host} rate-limited this; it resets at ${new Date(resetAt).toISOString()} (in ${s} s)${named}`, { detail: { host, resetAt } });
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isCode(value: unknown): value is FailureCode {
  return typeof value === "string" && Object.hasOwn(DEFAULTS, value);
}

export function readFailure(value: unknown): Failure | undefined {
  const f = fields(value);
  if (!f || ("ok" in f && f.ok !== false) || !isCode(f.code) || typeof f.retryable !== "boolean"
    || (f.effect !== "none" && f.effect !== "possibly_effected") || typeof f.message !== "string" || typeof f.next !== "string") return undefined;
  return { ok: false, code: f.code, retryable: f.retryable, effect: f.effect, message: f.message, next: f.next };
}

// An error the extension answered, typed when the page said what kind it
// was: content.js marks a click it refused before sending any event.
export function answeredError(message: string, failure: unknown): Error {
  const f = fields(failure);
  if (!f || !isCode(f.code) || (f.effect !== "none" && f.effect !== "possibly_effected")) return new Error(message);
  return new HarnessError(f.code, message, {
    effect: f.effect,
    retryable: f.retryable === false ? false : undefined,
    next: typeof f.next === "string" ? f.next : undefined,
    recovery: f.code === "stale_view" && f.effect === "none" && f.recovery === "present"
      && typeof f.document === "string" && f.document.length > 0 && typeof f.target === "string" && f.target.length > 0
      && (f.frame === undefined || (typeof f.frame === "number" && Number.isSafeInteger(f.frame) && f.frame > 0))
      ? { kind: "present", document: f.document, target: f.target, frame: typeof f.frame === "number" ? f.frame : undefined } : undefined,
  });
}

function diagnosticCode(value: Record<string, unknown>): FailureCode | undefined {
  if (isCode(value.code)) return value.code;
  switch (value.code) {
    case "ETIMEDOUT": case "ESOCKETTIMEDOUT": case "ERR_TIMEOUT": case "UND_ERR_CONNECT_TIMEOUT": case "UND_ERR_HEADERS_TIMEOUT": case "UND_ERR_BODY_TIMEOUT": return "timeout";
    case "ABORT_ERR": case "ERR_ABORTED": return "aborted";
    case "ERR_INVALID_ARG_TYPE": case "ERR_INVALID_ARG_VALUE": case "ERR_OUT_OF_RANGE": return "invalid_argument";
    case "ECONNREFUSED": case "ConnectionRefused": case "ECONNRESET": case "ENOTFOUND": case "EAI_AGAIN": case "EPIPE": case "ENETUNREACH": case "EHOSTUNREACH": return "unavailable";
  }
  if (value.name === "AbortError") return "aborted";
  if (value.name === "TimeoutError" || (value instanceof Error && value.constructor.name === "TimedOut")) return "timeout";
  if (typeof value.status !== "number" || !Number.isInteger(value.status)) return undefined;
  if (value.status === 400 || value.status === 422) return "invalid_argument";
  if (value.status === 401 || value.status === 403 || value.status === 407 || value.status === 451) return "blocked";
  if (value.status === 402 || value.status === 404 || value.status === 410) return "not_content";
  if (value.status === 408 || value.status === 504) return "timeout";
  if (value.status === 429 || (value.status >= 500 && value.status <= 599)) return "unavailable";
  return undefined;
}

export function failureOf(error: unknown, facts: { effectful?: boolean } = {}): Failure {
  const original = fields(error);
  const message = typeof original?.message === "string" ? original.message : String(error);
  let code: FailureCode | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth++) {
    const known = readFailure(current);
    if (known) return { ...known, message };
    const detail = fields(current);
    if (!detail) break;
    code ??= diagnosticCode(detail);
    current = detail.cause;
  }
  const effect = facts.effectful === false ? "none" : "possibly_effected";
  code ??= effect === "possibly_effected" ? "effect_unknown" : "command_failed";
  return { ok: false, code, effect, retryable: effect === "none" && DEFAULTS[code].retryable, message,
    next: effect === "possibly_effected" ? DEFAULTS.effect_unknown.next : DEFAULTS[code].next };
}
