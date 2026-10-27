import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridge } from "./bridge.ts";
import { connect } from "./fake-safari.ts";
import { runAs } from "./owner.ts";
import { callTool, loadTabs } from "./tools.ts";

const origin = "https://account.example";
const dashboard = '<html><body><main><h1>Active orders</h1><p>Account dashboard has three active orders ready for shipment.</p></main><dialog><form action="/login"><input type="password"></form></dialog></body></html>';
const signIn = '<html><body><main><h1>Sign in</h1><form action="/login"><input type="password"></form></main></body></html>';

test("a read opens one owned tab, reuses it, and ignores a hidden sign-in dialog without accepting a login page", async () => {
  const home = mkdtempSync(join(tmpdir(), "authenticated-read-"));
  const agent = Bun.spawn(["sleep", "60"]);
  const tabs = new Map<number, { id: number; url: string; windowId: number; title: string }>();
  let opens = 0;
  loadTabs(join(home, "tabs.json"));
  connect({
    send(data: string) {
      const { id, op, args } = JSON.parse(data) as { id: string; op: string; args: unknown[] };
      let value: unknown = { ok: true };
      if (op === "tabs.list") value = [...tabs.values()];
      else if (op === "windows.open") {
        tabs.set(101, { id: 101, url: String(args[0]), windowId: 100, title: "Agent window" });
        value = { windowId: 100, tabId: 101 };
      } else if (op === "tabs.open") {
        opens++;
        const tab = { id: 102, url: String(args[0]), windowId: 100, title: "Account" };
        tabs.set(tab.id, tab);
        value = tab;
      } else if (op === "relay") {
        const [tab, action, input] = args as [number, string, unknown[]];
        if (action === "tabInfo") value = tabs.get(tab);
        else if (action === "fetch") {
          const url = String(input[0]);
          value = { status: 200, url, type: "text/html", text: url.endsWith("/visible-login") ? signIn : dashboard };
        } else if (action === "eval") value = { result: true };
      }
      queueMicrotask(() => bridge.handleMessage(JSON.stringify({ id, value })));
    },
    close() {},
  });
  try {
    const first = await runAs(agent.pid, () => callTool("authenticated_read", { url: `${origin}/incidental`, expect: "Active orders" })) as { tab: number; content: string };
    expect(first).toMatchObject({ tab: 102, content: expect.stringContaining("Account dashboard") });
    const explicit = await runAs(agent.pid, () => callTool("authenticated_read", { tab: first.tab, url: `${origin}/incidental`, expect: "Active orders" })) as { tab: number };
    const repeated = await runAs(agent.pid, () => callTool("authenticated_read", { url: `${origin}/incidental`, expect: "Active orders" })) as { tab: number };
    expect([explicit.tab, repeated.tab, opens]).toEqual([first.tab, first.tab, 1]);
    await expect(runAs(agent.pid, () => callTool("authenticated_read", { tab: first.tab, url: `${origin}/visible-login`, expect: "Active orders" }))).rejects.toThrow("sign-in, challenge, or loading page");
  } finally {
    agent.kill();
    await agent.exited;
    process.once("exit", () => rmSync(home, { recursive: true, force: true }));
  }
});
