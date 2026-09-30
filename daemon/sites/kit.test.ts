import { expect, test } from "bun:test";
import type { Invoke } from "../call.ts";
import { SiteKit } from "./kit.ts";

// Safari as the kit sees it: open makes tabs 1, 2, 3, ... at the address
// asked, and a call on a tab in gone fails the way the extension answers for
// a tab the owner closed or the idle sweep took.
const SITE = "https://site.example";

test("a call on a site's tab that is gone runs once more in a new tab where the site last asked", async () => {
  const opened: string[] = [];
  const gone = new Set<number>();
  const send: Invoke = async (tool, args) => {
    if (tool === "open") {
      opened.push(String(args.url));
      return { id: opened.length };
    }
    if (gone.has(Number(args.tab))) throw new Error("that tab is gone: it was closed at the end of your turn, after 20 minutes unused, or by the user");
    return { result: args.tab };
  };
  const kit = new SiteKit(send);
  const first = await kit.tab(SITE, `${SITE}/u/0/`);
  await kit.tab(SITE, `${SITE}/u/1/`);
  gone.add(first);

  expect(await kit.eval(SITE, "location.href")).toBe(2);
  // A call still holding the gone id lands in the tab that took its place.
  expect(await kit.invoke("goto", { tab: first, url: `${SITE}/u/1/` })).toEqual({ result: 2 });
  expect(opened).toEqual([`${SITE}/u/0/`, `${SITE}/u/1/`]);

  // Gone again, the error stands: one new tab per call, never a loop.
  gone.add(2).add(3);
  await expect(kit.eval(SITE, "location.href")).rejects.toThrow("that tab is gone");
  expect(opened).toHaveLength(3);
});
