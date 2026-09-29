import { expect, test } from "bun:test";
import { doctor, type Check, type Probes } from "./doctor.ts";

// A Mac where every part works: Safari up with the extension connected, the
// pairing idle as it is between tasks, and Apple's own lane left off.
function healthy(): Probes {
  return {
    safariRunning: async () => true,
    health: async () => ({ pid: 4242, extension: { connectedAt: Date.now() } }),
    launchd: async () => true,
    extensionKeys: async () => ({ deployed: "9ed628c258f00030", installed: "9ed628c258f00030" }),
    roundTrip: async () => 640,
    accessibility: async () => {},
    messages: async () => {},
    passwords: async () => ({ unlocked: false, reason: "it has not been paired since the harness started at 09:17" }),
    safaridriverMcp: async () => true,
    remoteAutomation: async () => false,
    freeBytes: async () => 150e9,
    swapMb: async () => 0,
    groupsOff: () => undefined,
  };
}

// Every failure carries the step that fixes it.
async function examine(probes: Probes): Promise<Record<string, Check>> {
  const checks = await doctor(probes);
  for (const c of checks.filter((c) => c.status === "fail")) expect(c.fix, c.name).toBeTruthy();
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

const statuses = (checks: Record<string, Check>) => Object.fromEntries(Object.values(checks).map((c) => [c.name, c.status]));

test("a working Mac fails nothing; Apple's lane off, an idle pairing, or no host-headroom are not failures", async () => {
  const checks = statuses(await examine(healthy()));
  expect(Object.entries(checks).filter(([, s]) => s !== "ok")).toEqual([["safaridriver", "off"]]);
  expect(statuses(await examine({ ...healthy(), remoteAutomation: async () => true })).safaridriver).toBe("ok");
  expect(statuses(await examine({ ...healthy(), safaridriverMcp: async () => false, remoteAutomation: async () => true })).safaridriver).toBe("off");
  expect(statuses(await examine({ ...healthy(), swapMb: async () => undefined })).swap).toBe("skip");
  // A day-old flag that turned tab groups off is the owner's to clear, so it shows here.
  expect(statuses(await examine({ ...healthy(), groupsOff: () => "tab groups are off: Safari came to the front" }))["tab groups"]).toBe("warn");
});

test("with the daemon down, the fix fits why, and nothing that needs the daemon is asked", async () => {
  const asked: string[] = [];
  const down: Probes = {
    ...healthy(),
    health: async () => null,
    roundTrip: async () => { asked.push("roundTrip"); return 1; },
    passwords: async () => { asked.push("passwords"); return { unlocked: true }; },
  };
  const notInstalled = await examine({ ...down, launchd: async () => false });
  expect(notInstalled.daemon).toMatchObject({ status: "fail", fix: "safari daemon install" });
  expect(notInstalled.launchd).toMatchObject({ status: "fail", fix: "safari daemon install" });
  expect([notInstalled.extension.status, notInstalled["round trip"].status, notInstalled.passwords.status]).toEqual(["skip", "skip", "skip"]);
  // launchd has the job, so installing again is not the fix: the log says why it stops
  const crashing = await examine(down);
  expect(crashing.daemon.status).toBe("fail");
  expect(crashing.daemon.fix).toContain("daemon.log");
  expect(asked).toEqual([]);
});

test("with Safari not running, no tab is opened, since opening one would start Safari", async () => {
  let opened = 0;
  const checks = await examine({ ...healthy(), safariRunning: async () => false, health: async () => ({ pid: 4242, extension: null }), roundTrip: async () => ++opened });
  expect(opened).toBe(0);
  expect(checks.safari.status).toBe("warn");
  expect([checks.extension.status, checks["round trip"].status]).toEqual(["skip", "skip"]);
});

test("a missing permission fails with the setting that grants it; Safari lacking a window still proves Accessibility", async () => {
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
});

test("the extension Safari has must be the deployed release's, and a round trip that fails says why", async () => {
  const stale = await examine({ ...healthy(), extensionKeys: async () => ({ deployed: "9ed628c258f00030", installed: "1b2c3d4e5f607182" }) });
  expect(stale["extension version"].status).toBe("fail");
  expect(stale["extension version"].fix).toContain("dev-install.sh");
  expect((await examine({ ...healthy(), extensionKeys: async () => ({ deployed: "9ed628c258f00030" }) }))["extension version"].status).toBe("fail");
  expect((await examine({ ...healthy(), extensionKeys: async () => ({ installed: "9ed628c258f00030" }) }))["extension version"].status).toBe("skip");
  const stuck = await examine({ ...healthy(), roundTrip: async () => { throw new Error("the page at http://127.0.0.1:37334/space did not answer within 5 s"); } });
  expect(stuck["round trip"]).toMatchObject({ status: "fail", detail: "the page at http://127.0.0.1:37334/space did not answer within 5 s" });
});
