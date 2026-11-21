import { expect, test, vi } from "bun:test";
import { bridge, type ExtSocket } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { recent } from "./journal.ts";
import { displaysChanged } from "./spaces.ts";

// The stray check after a display change asks Safari for its tabs first; a
// Safari that cannot answer (quitting, too loaded) must cost one journal note
// per pass, never the daemon. A failing tab list also keeps the check away
// from the native window lister, which would read this Mac's real screens.
test("a display change checks now and once more later, and a failing tab list fails neither pass", async () => {
  const sock: ExtSocket = {
    send(data) {
      const { id, op } = JSON.parse(data) as { id?: string; op: string };
      if (id === undefined) return;
      const reply = op === "tabs.list" ? { error: "tabs.list timed out" } : { value: null };
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, ...reply })));
    },
    close() {},
  };
  connect(sock);
  const failed = () => recent(2000).filter((e) => e.kind === "windows not checked for the agents' display after a display change")
    .reduce((sum, e) => sum + (typeof e.n === "number" ? e.n : 1), 0);
  vi.useFakeTimers();
  try {
    const before = failed();
    await displaysChanged();
    expect(failed()).toBe(before + 1);

    expect(displaysChanged()).toBeUndefined();
    vi.advanceTimersByTime(11_000);
    // The later pass's request and the fake's answer settle as microtasks.
    for (let i = 0; i < 100 && failed() < before + 2; i++) await Promise.resolve();
    expect(failed()).toBe(before + 2);
  } finally {
    vi.useRealTimers();
  }
});
