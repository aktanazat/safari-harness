import { afterEach, expect, jest, test } from "bun:test";
import { doctor, type Check, type Probes } from "./doctor.ts";

// A Mac where every part works: Safari up with the extension connected, the
// pairing idle as it is between tasks, and Apple's own lane left off.
function healthy(): Probes {
  return {
    safariRunning: async () => true,
    health: async () => ({ pid: 4242, extension: { connected: true, stuck: false, timeouts: {}, connectedAt: Date.now() } }),
    launchd: async () => true,
    extensionKeys: async () => ({ deployed: "9ed628c258f00030", installed: "9ed628c258f00030" }),
    tabs: async () => 12,
    roundTrip: async () => 640,
    accessibility: async () => {},
    messages: async () => {},
    passwords: async () => ({ unlocked: false, reason: "it has not been paired since the harness started at 09:17" }),
    safaridriverMcp: async () => true,
    remoteAutomation: async () => false,
    freeBytes: async () => 150e9,
    swapMb: async () => 0,
    groupsOff: () => undefined,
    alerts: () => ({ on: true, lastAt: Date.now() }),
    deploying: () => undefined,
  };
}

// Every failure carries the step that fixes it.
async function examine(probes: Probes, deep = false): Promise<Record<string, Check>> {
  const checks = await doctor(probes, { deep });
  for (const c of checks.filter((c) => c.status === "fail")) expect(c.fix, c.name).toBeTruthy();
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

const statuses = (checks: Record<string, Check>) => Object.fromEntries(Object.values(checks).map((c) => [c.name, c.status]));
const never = () => Promise.withResolvers<never>().promise;

// what the probes answer settles in microtasks, which all run before the next turn
function settled(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

afterEach(() => {
  jest.useRealTimers();
});

test("a working Mac fails nothing; Apple's lane off, an idle pairing, or no host-headroom are not failures", async () => {
  const checks = statuses(await examine(healthy(), true));
  expect(Object.entries(checks).filter(([, s]) => s !== "ok")).toEqual([["safaridriver", "off"]]);
  expect(statuses(await examine({ ...healthy(), remoteAutomation: async () => true })).safaridriver).toBe("ok");
  expect(statuses(await examine({ ...healthy(), safaridriverMcp: async () => false, remoteAutomation: async () => true })).safaridriver).toBe("off");
  expect(statuses(await examine({ ...healthy(), swapMb: async () => undefined })).swap).toBe("skip");
  // A flag that turned tab groups off is the owner's to clear, so it shows here.
  expect(statuses(await examine({ ...healthy(), groupsOff: () => "tab groups are off: Safari came to the front" }))["tab groups"]).toBe("warn");
});

test("with the daemon down, the fix fits why, and nothing that needs the daemon is asked", async () => {
  const asked: string[] = [];
  const down: Probes = {
    ...healthy(),
    health: async () => null,
    tabs: async () => { asked.push("tabs"); return 1; },
    roundTrip: async () => { asked.push("roundTrip"); return 1; },
    passwords: async () => { asked.push("passwords"); return { unlocked: true }; },
  };
  const notInstalled = await examine({ ...down, launchd: async () => false }, true);
  expect(notInstalled.daemon).toMatchObject({ status: "fail", fix: "safari daemon install" });
  expect(notInstalled.launchd).toMatchObject({ status: "fail", fix: "safari daemon install" });
  expect([notInstalled.extension.status, notInstalled.tabs.status, notInstalled["round trip"].status, notInstalled.passwords.status]).toEqual(["skip", "skip", "skip", "skip"]);
  // launchd has the job, so installing again is not the fix: the log says why it stops
  const crashing = await examine(down, true);
  expect(crashing.daemon.status).toBe("fail");
  expect(crashing.daemon.fix).toContain("daemon.log");
  // a deploy is restarting it: nothing to install or read, only to wait (HD-13)
  expect((await examine({ ...down, deploying: () => 40 }, true)).daemon).toMatchObject({ status: "warn", detail: "restarting for a deploy", fix: "run safari doctor again in 40 s" });
  expect(asked).toEqual([]);
});

test("with Safari not running, no tab is listed or opened, since asking for one would start Safari", async () => {
  const asked: string[] = [];
  const checks = await examine({
    ...healthy(),
    safariRunning: async () => false,
    health: async () => ({ pid: 4242, extension: { connected: false, stuck: false, timeouts: {} } }),
    tabs: async () => { asked.push("tabs"); return 0; },
    roundTrip: async () => { asked.push("roundTrip"); return 1; },
  }, true);
  expect(asked).toEqual([]);
  expect(checks.safari.status).toBe("warn");
  expect([checks.extension.status, checks.tabs.status, checks["round trip"].status]).toEqual(["skip", "skip", "skip"]);
});

test("a missing permission fails with the setting that grants it; Safari lacking a window, or a page in its front one, still proves Accessibility", async () => {
  const denied = await examine({
    ...healthy(),
    accessibility: async () => { throw new Error("input webarea failed: this app needs Accessibility permission: System Settings > Privacy & Security > Accessibility"); },
    messages: async () => { throw new Error("cannot read Messages (unable to open database file)"); },
  });
  expect(denied.accessibility.status).toBe("fail");
  expect(denied.accessibility.fix).toContain("Privacy & Security > Accessibility");
  expect(denied.messages.status).toBe("fail");
  expect(denied.messages.fix).toContain("Full Disk Access");
  const windowless = await examine({ ...healthy(), accessibility: async () => { throw new Error("input webarea failed: Safari has no open window"); } });
  expect(windowless.accessibility.status).toBe("ok");
  // a front window that just opened shows Safari's start page, no web page
  const pageless = await examine({ ...healthy(), accessibility: async () => { throw new Error("input webarea failed: no web page is showing in Safari's front window"); } });
  expect(pageless.accessibility.status).toBe("ok");
});

test("the extension Safari has must be the deployed release's, and a round trip that fails says why", async () => {
  const stale = await examine({ ...healthy(), extensionKeys: async () => ({ deployed: "9ed628c258f00030", installed: "1b2c3d4e5f607182" }) });
  expect(stale["extension version"].status).toBe("fail");
  expect(stale["extension version"].fix).toContain("dev-install.sh");
  expect((await examine({ ...healthy(), extensionKeys: async () => ({ deployed: "9ed628c258f00030" }) }))["extension version"].status).toBe("fail");
  expect((await examine({ ...healthy(), extensionKeys: async () => ({ installed: "9ed628c258f00030" }) }))["extension version"].status).toBe("skip");
  const stuck = await examine({ ...healthy(), roundTrip: async () => { throw new Error("the page at http://127.0.0.1:37334/space did not answer within 5 s"); } }, true);
  expect(stuck["round trip"]).toMatchObject({ status: "fail", detail: "the page at http://127.0.0.1:37334/space did not answer within 5 s" });
});

// On 10-13 and 10-16 doctor took 30 s while the extension was stuck: its
// round trip through a window of its own waited out windows.open's limit.
test("doctor answers within 3 s: a probe still running then is reported as not answering, and the round trip waits for --deep", async () => {
  jest.useFakeTimers();
  const asked: string[] = [];
  const slow: Probes = {
    ...healthy(),
    tabs: () => { asked.push("tabs"); return never(); },
    swapMb: never,
    roundTrip: async () => { asked.push("roundTrip"); return 640; },
  };
  let done = false;
  const run = examine(slow).finally(() => (done = true));
  let waited = 0;
  while (!done) {
    await settled();
    jest.advanceTimersByTime(100);
    waited += 100;
  }
  const checks = await run;
  expect(waited).toBeLessThanOrEqual(3100);
  expect(checks.tabs).toMatchObject({ status: "fail", detail: "no answer within 3 s", fix: expect.stringContaining("safari extension reload") });
  expect(checks.swap).toMatchObject({ status: "skip", detail: "host-headroom failed: no answer within 3 s" });
  expect(checks["round trip"]).toMatchObject({ status: "skip", detail: expect.stringContaining("safari doctor --deep") });
  expect(asked).toEqual(["tabs"]);
  jest.useRealTimers();
  expect((await examine(healthy(), true))["round trip"].status).toBe("ok");
});

// On 10-13 at 19:05 status said connected through a storm of tabs.list
// timeouts, and the agent ran guide and doctor before it reloaded.
test("an extension that is connected but stuck fails with the reload as the fix, and no tab list is asked of it", async () => {
  const asked: string[] = [];
  const checks = await examine({
    ...healthy(),
    health: async () => ({ pid: 4242, extension: { connected: true, stuck: true, timeouts: { "tabs.list": 3 }, connectedAt: Date.now() } }),
    tabs: async () => { asked.push("tabs"); return 12; },
  });
  expect(checks.extension).toMatchObject({ status: "fail", detail: expect.stringMatching(/stuck.*tabs\.list 3/), fix: expect.stringMatching(/^safari extension reload/) });
  expect(checks.tabs).toMatchObject({ status: "skip", detail: "the extension is stuck" });
  expect(asked).toEqual([]);
});
