// Live check that the Apple Passwords pairing survives daemon restarts, as a
// deploy restarts it: the hidden Helium, Apple's helper, and the pairing
// carry on under each new daemon, which proves the pairing before it says
// unlocked. Run it with a pairing up (passwords {do: "status"} says
// unlocked), holding the live lock:
//
//   until mkdir /private/var/tmp/safari-harness-live.lock 2>/dev/null; do sleep 2; done
//   bun scripts/check-pairing.ts; rmdir /private/var/tmp/safari-harness-live.lock
//
// It restarts the daemon twice, and works only in a background tab it opens
// and closes. It prints no username or password.

import { DEFAULT_PORT } from "../daemon/bridge.ts";
import { heliumProfile, runningHelium, runningHelper } from "../daemon/passwords.ts";

const HTTP = "http://127.0.0.1:37334";
const LABEL = "at.aktan.safari-harness.daemon";
const PROFILE = heliumProfile(DEFAULT_PORT);

async function call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${HTTP}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args }) });
  const r = (await res.json()) as { ok: boolean; value?: unknown; error?: string };
  if (!r.ok) throw new Error(`${tool}: ${r.error}`);
  return r.value;
}

let failed = 0;
function check(name: string, pass: boolean, detail: unknown) {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : `\n     got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

async function health(): Promise<{ pid?: number; extension?: unknown } | undefined> {
  return fetch(`${HTTP}/health`).then((r) => r.json()).catch(() => undefined);
}

// Restarts the daemon as dev-install.sh does, and waits for the new one and
// Safari's extension on it.
async function restart(): Promise<void> {
  const before = (await health())?.pid;
  const r = Bun.spawnSync(["launchctl", "kickstart", "-k", `gui/${process.getuid?.()}/${LABEL}`]);
  if (r.exitCode !== 0) throw new Error(`launchctl kickstart failed: ${r.stderr.toString()}`);
  for (let i = 0; i < 120; i++) {
    const h = await health();
    if (h?.pid && h.pid !== before && h.extension) return;
    await Bun.sleep(500);
  }
  throw new Error("the daemon and the extension did not come back within 60s");
}

const status = await call("passwords", { do: "status" });
if (status.unlocked !== true) {
  console.log(`Apple Passwords is locked (${status.reason}); pair first, then run this again`);
  process.exit(1);
}
const helium = runningHelium(PROFILE)?.pid;
const helper = runningHelper(PROFILE);
const tab = (await call("open", { url: "https://example.com/", background: true })).id as number;
try {
  for (const n of [1, 2]) {
    await restart();
    const after = await call("passwords", { do: "status" });
    check(`restart ${n}: still unlocked`, after.unlocked === true, after);
    const now = { helium: runningHelium(PROFILE)?.pid, helper: runningHelper(PROFILE) };
    check(`restart ${n}: the same Helium and helper`, now.helium === helium && now.helper === helper, { before: { helium, helper }, now });
    const logins = await call("passwords", { do: "logins", tab }).catch((e: Error) => e.message);
    check(`restart ${n}: logins answers under the pairing`, typeof logins === "object" && logins.site === "example.com", typeof logins === "string" ? logins : { site: logins.site });
  }
  const processes = Bun.spawnSync(["ps", "-A", "-ww", "-o", "command="]).stdout.toString().split("\n").filter((l) => l.includes(`--user-data-dir=${PROFILE} `));
  check("the hidden Helium runs in at most 4 processes", processes.length <= 4, processes.length);
} finally {
  await call("close", { tab });
}
process.exit(failed ? 1 : 0);
