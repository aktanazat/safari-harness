// One pacer for the daemon, by host: the requests every agent and every
// REPL session sends a site take turns here, and a host that rate-limited
// one of them is held for all. A REPL session runs in a process of its own
// (repl-host.ts), so its site kits reach this through the hidden pace tool
// (sites/kit.ts); map takes its turns in process.

import type { Tool } from "./tools.ts";

// A hold that ends sooner is waited out; a later one fails at once with its
// reset time. A REPL run gets 120 s (repl.ts), and some MCP clients end a
// call at 60 s.
const WAIT_MS = 30_000;
// The first back-off after a 429 that names no reset; each 429 in a row
// doubles it, up to MAX_BACKOFF_MS.
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export type Limit = { host: string; resetAt: number; guessed: boolean };
type Hold = { until: number; guessed: boolean; strikes: number };

// When each host's next turn may start.
const turns = new Map<string, number>();
// By host, or by "host bucket" for one of a host's limits: X limits each
// operation on its own.
const holds = new Map<string, Hold>();

// The host of an address as the pacer keys it: www.google.com and
// google.com take the same turns.
export function hostOf(address: string): string {
  return (URL.parse(address)?.hostname ?? address).replace(/^www\./, "");
}

// When a request to host may start, gap ms after the turn before it, and
// not before from; the turn is taken.
export function turnAt(host: string, gap: number, from = Date.now()): number {
  const key = hostOf(host);
  const at = Math.max(from, turns.get(key) ?? 0);
  turns.set(key, at + gap);
  return at;
}

// host's turn once a hold on it, or on its bucket, ends; a hold that ends
// past WAIT_MS answers instead, and takes no turn.
export function turn(host: string, gap: number, bucket?: string): { at: number } | Limit {
  const key = hostOf(host);
  const now = Date.now();
  const held = [holds.get(key), bucket === undefined ? undefined : holds.get(`${key} ${bucket}`)]
    .filter((h): h is Hold => h !== undefined && h.until > now)
    .sort((a, b) => b.until - a.until)[0];
  if (held && held.until - now > WAIT_MS) return { host: key, resetAt: held.until, guessed: held.guessed };
  return { at: turnAt(key, gap, held?.until ?? now) };
}

// Holds host, or its bucket, after a rate limit: until resetAt when the
// site named it, else for a back-off from base ms that doubles with each
// limit that comes within MAX_BACKOFF_MS of the last hold's end.
export function hold(host: string, bucket: string | undefined, resetAt: number | undefined, base = BACKOFF_MS): Limit {
  const key = hostOf(host);
  const name = bucket === undefined ? key : `${key} ${bucket}`;
  if (resetAt !== undefined) {
    holds.set(name, { until: resetAt, guessed: false, strikes: 0 });
    return { host: key, resetAt, guessed: false };
  }
  const now = Date.now();
  const was = holds.get(name);
  const strikes = was && now - was.until < MAX_BACKOFF_MS ? was.strikes + 1 : 1;
  const until = now + Math.min(base * 2 ** (strikes - 1), MAX_BACKOFF_MS);
  holds.set(name, { until, guessed: true, strikes });
  return { host: key, resetAt: until, guessed: true };
}

export const PACE_TOOL: Tool = {
  desc: "A site kit's turn for a request to a host, or a hold on the host after its rate limit (sites/kit.ts).",
  params: {
    do: { type: "string", enum: ["turn", "hold"], description: "default turn" },
    host: { type: "string", description: "host or address" },
    gap: { type: "number", description: "turn: ms after the turn before it" },
    bucket: { type: "string", description: "the one of the host's limits the request falls under" },
    until: { type: "number", description: "hold: the reset the site named, epoch ms" },
    backoff: { type: "number", description: "hold: the first back-off, ms, when the site named no reset" },
  },
  required: ["host"],
  hidden: true,
  run: async (a) => {
    const host = String(a.host);
    const bucket = a.bucket === undefined ? undefined : String(a.bucket);
    if (a.do === "hold") return hold(host, bucket, a.until === undefined ? undefined : Number(a.until), a.backoff === undefined ? undefined : Number(a.backoff));
    return turn(host, Number(a.gap ?? 0), bucket);
  },
};
