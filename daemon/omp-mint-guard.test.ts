import { expect, test } from "bun:test";
import guard from "./omp-mint-guard.mjs";

test("the authoring model cannot use ambient browser or file tools", async () => {
  const handlers = new Map<string, (event?: unknown) => unknown>();
  let active = ["write", "mcp__safari_click"];
  guard({
    on(event: string, handler: (event?: unknown) => unknown) { handlers.set(event, handler); },
    async setActiveTools(names: string[]) { active = names; },
  });

  await handlers.get("session_start")?.();
  expect(active).toEqual([]);
  active = ["mcp__safari_click"];
  await handlers.get("before_agent_start")?.();
  expect(active).toEqual([]);
  expect(handlers.get("tool_call")?.({ toolName: "mcp__safari_click" })).toMatchObject({ block: true });
});
