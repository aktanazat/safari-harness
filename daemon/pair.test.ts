import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { FILL_TOOLS } from "./fill.ts";
import * as pair from "./pair.ts";
import * as daemonRpc from "./rpc.ts";

// The daemon's side of Apple Passwords: locked until unlock gets the code
// the Mac showed. Each call it gets is kept.
const CODE = "402913";
function fakeDaemon(): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = [];
  let unlocked = false;
  spyOn(daemonRpc, "rpc").mockImplementation(async (tool: string, args: Record<string, unknown> = {}) => {
    if (tool !== "passwords") throw new Error(`unexpected ${tool}`);
    calls.push(args);
    if (args.do === "status") return { unlocked };
    if (args.do === "pair") return { codeShown: true, helper: 4242 };
    if (args.do === "unlock") {
      if (args.code !== CODE) throw new Error("that code did not pair");
      unlocked = true;
      return { unlocked: true };
    }
    return { ok: true };
  });
  return calls;
}

const away = process.env.SAFARI_HARNESS_AWAY;
afterEach(() => {
  mock.restore();
  if (away === undefined) delete process.env.SAFARI_HARNESS_AWAY;
  else process.env.SAFARI_HARNESS_AWAY = away;
});

// 01a0e20a: he took 7 minutes to send the pairing code through the chat.
test("the user types the Mac's code into a prompt there, and the agent gets only paired", async () => {
  process.env.SAFARI_HARNESS_AWAY = "0";
  const calls = fakeDaemon();
  spyOn(pair, "approve").mockResolvedValue({ approved: true });
  spyOn(pair, "readCode").mockResolvedValue(undefined);
  spyOn(pair, "askCode").mockResolvedValue({ code: CODE });
  const result = await FILL_TOOLS.passwords.run({ do: "pair" });
  expect(result).toEqual({ paired: true });
  expect(calls).toContainEqual({ do: "unlock", code: CODE });
});

test("a cancelled prompt pairs nothing and says why", async () => {
  process.env.SAFARI_HARNESS_AWAY = "0";
  const calls = fakeDaemon();
  spyOn(pair, "approve").mockResolvedValue({ approved: true });
  spyOn(pair, "readCode").mockResolvedValue(undefined);
  spyOn(pair, "askCode").mockResolvedValue({ why: "the user cancelled the prompt" });
  expect(await FILL_TOOLS.passwords.run({ do: "pair" })).toEqual({ paired: false, why: "the user cancelled the prompt" });
  expect(calls.map((c) => c.do)).not.toContain("unlock");
});

test("while the user is away, the call says he must come to the Mac, and pairs nothing", async () => {
  process.env.SAFARI_HARNESS_AWAY = "1";
  const calls = fakeDaemon();
  const asked = spyOn(pair, "askCode").mockResolvedValue({ code: CODE });
  expect(await FILL_TOOLS.passwords.run({ do: "pair" })).toEqual({ paired: false, why: expect.stringContaining("he must come to the Mac") });
  expect(calls.map((c) => c.do)).toEqual(["status"]);
  expect(asked).not.toHaveBeenCalled();
});
