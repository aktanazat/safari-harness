import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a saved observed GET refuses changed results and stores no response values", async () => {
  const home = mkdtempSync(join(tmpdir(), "request-catalog-test-"));
  const script = `
    import { readFileSync } from "node:fs";
    import { homedir } from "node:os";
    import { requestCatalogTool } from ${JSON.stringify(new URL("./request-catalog.ts", import.meta.url).href)};
    import { dataFile } from ${JSON.stringify(new URL("./phone.ts", import.meta.url).href)};
    if (homedir() !== ${JSON.stringify(home)}) throw new Error("the private store is not isolated");
    const tab = 7, at = Date.now(), url = "https://catalog.example/api/items";
    const observation = { t: at, kind: "fetch", method: "GET", frame: 0, status: 200, url };
    const original = JSON.stringify({ items: [{ title: "Result" }], secret: "private fixture value" });
    let current = original;
    const call = async (tool, args) => {
      if (tool === "request_catalog_context") return { tab, url: "https://catalog.example/workspace", ready: "complete", timeOrigin: at - 1000 };
      if (tool === "net") return args.body === undefined ? { entries: [observation] } : { ...observation, text: original };
      if (tool === "authenticated_read") return { ok: true, tab, requestedUrl: url, url, status: 200, type: "application/json", format: "raw", source: "page", truncated: false, content: current };
      throw new Error("unexpected browser tool " + tool);
    };
    const saved = await requestCatalogTool({ do: "save", name: "items", tab, request: 0, observedAt: at, field: "items", type: "array" }, call);
    const first = await requestCatalogTool({ do: "run", name: "items", tab }, call);
    current = JSON.stringify({ items: [] });
    const changed = await requestCatalogTool({ do: "run", name: "items", tab }, call);
    const listed = await requestCatalogTool({ do: "list" }, call);
    const stored = readFileSync(dataFile("request-catalog/catalog.json"), "utf8");
    console.log(JSON.stringify({ saved, first, changed, listed, stored }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  try {
    const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    const result = JSON.parse(text);
    expect(result.saved).toMatchObject({ ok: true, saved: true, check: { passed: true } });
    expect(result.first).toMatchObject({ ok: true, value: [{ title: "Result" }], check: { passed: true } });
    expect(result.changed).toMatchObject({ ok: false, reason: expect.stringContaining("empty") });
    expect(result.listed.entries).toHaveLength(1);
    expect(result.stored).not.toContain("private fixture value");
    expect(result.stored).not.toContain("Result");
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(home, { recursive: true, force: true });
  }
});
