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

  await kit.eval(SITE, "location.href");
  // A call still holding the gone id lands in the tab that took its place.
  await kit.invoke("goto", { tab: first, url: `${SITE}/u/1/` });
  expect(opened).toEqual([`${SITE}/u/0/`, `${SITE}/u/1/`]);

  // Gone again, the error stands: one new tab per call, never a loop.
  gone.add(2).add(3);
  await expect(kit.eval(SITE, "location.href")).rejects.toThrow("that tab is gone");
  expect(opened).toHaveLength(3);
});

// On 10-31 an X read failed this way twice in a minute while Safari itself
// stalled; asked again in the same tab, the daemon refuses an eval that may
// already have run there until that tab is read.
test("a read the site's page did not answer runs once more in a new tab, and the held tab is closed; any other eval, or a second hold, fails", async () => {
  const calls: string[] = [];
  const held = new Set<number>();
  let opened = 0;
  const send: Invoke = async (tool, args) => {
    calls.push(`${tool} ${args.tab ?? ""}`.trim());
    if (tool === "open") return { id: ++opened };
    if (tool === "eval" && held.has(Number(args.tab))) throw new Error(`the page at ${SITE}/ did not answer in 10 s (a dialog open on it, or a page stuck loading, holds it); reload it with goto and retry`);
    return { result: args.tab };
  };
  const kit = new SiteKit(send);
  held.add(1);
  expect(await kit.eval(SITE, "document.title", { read: true })).toBe(2);
  expect(calls).toEqual(["open", "eval 1", "close 1", "open", "eval 2"]);

  held.add(2);
  await expect(kit.eval(SITE, "document.title")).rejects.toThrow("did not answer");
  held.add(3);
  await expect(kit.eval(SITE, "document.title", { read: true })).rejects.toThrow("did not answer");
  expect(opened).toBe(3);
});
