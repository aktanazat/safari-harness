// Tabs that change under an agent. Safari may swap a tab for another under a
// new id (a page it prepared ahead, shown in the tab's place), and gives
// every tab a new id when the extension reloads (a deploy of it): a call
// with an old id reaches the tab under its new one, and its result says
// replaced: {from, to}, so the agent can move to the new id. A popup an
// agent's page opens later, outside any action (a sign-in window a script
// opens), is that agent's tab too, and the agent's next result says popup:
// {tab, url}. The extension reports all three (background.js); tools.ts
// moves what it keeps per tab.

import { bridge } from "./bridge.ts";
import { currentOwner } from "./owner.ts";

type Replaced = { from: number; to: number };
type Popup = { tab: number; url: string };
type News = { replaced?: Replaced; popup?: Popup };

// Old id to newest, for the extension connection it was reported on. Once
// the extension connects again, Safari may have started over and given an
// old id to another tab; a reloaded extension says again, each time it
// connects, which tab each old id names now (recordRenumbered), and its own
// aliases (background.js) lead an old id to its new tab while Safari runs.
const moved = new Map<number, { to: number; connectedAt: number | undefined }>();
// Popups not yet reported, by the agent that owns them.
const popups = new Map<number, Popup[]>();

// A tab swapped twice is reached by its first id too: every id that led to
// the old one leads to the new one.
export function recordReplaced(from: number, to: number): void {
  const connectedAt = bridge.extensionInfo?.connectedAt;
  for (const [old, m] of moved) if (m.to === from && m.connectedAt === connectedAt) moved.set(old, { to, connectedAt });
  moved.set(from, { to, connectedAt });
}

// Every tab's id after the extension reloaded, by the id it had before; the
// extension has followed the swaps between already.
export function recordRenumbered(tabs: Map<number, number>): void {
  const connectedAt = bridge.extensionInfo?.connectedAt;
  for (const [from, to] of tabs) moved.set(from, { to, connectedAt });
}

// The id a tab has now: a replaced one's newest id, or the id as it is.
export function followTab(id: number): number {
  const m = moved.get(id);
  return m && m.connectedAt === bridge.extensionInfo?.connectedAt ? m.to : id;
}

export function queuePopup(owner: number, popup: Popup): void {
  popups.set(owner, [...(popups.get(owner) ?? []), popup]);
}

// Runs a tool call and adds its news to the result: replaced when the call
// named a tab by an old id, and the caller's oldest unreported popup. A
// result that is not an object (a list of tabs, a failure) carries none,
// and the popup waits for the next.
export async function withTabNews(tab: unknown, run: () => Promise<unknown>): Promise<unknown> {
  const result = await run();
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  const news: News = {};
  const id = typeof tab === "number" ? tab : typeof tab === "string" && tab.trim() !== "" ? Number(tab) : NaN;
  if (Number.isInteger(id) && followTab(id) !== id) news.replaced = { from: id, to: followTab(id) };
  const owner = currentOwner();
  const waiting = owner === undefined ? undefined : popups.get(owner);
  if (owner !== undefined && waiting?.length) {
    news.popup = waiting[0];
    if (waiting.length > 1) popups.set(owner, waiting.slice(1));
    else popups.delete(owner);
  }
  return news.replaced || news.popup ? { ...result, ...news } : result;
}

// formatResult's line for a result's news, and the result without it. The
// fields are the ones withTabNews wrote; the CLI gets them back through JSON.
export function splitNews(value: News): { line: string; rest: object } | null {
  const { replaced, popup, ...rest } = value;
  if (!replaced && !popup) return null;
  const lines = [
    ...(replaced ? [`tab ${replaced.from} is now tab ${replaced.to}: Safari gave it a new id; use ${replaced.to}`] : []),
    ...(popup ? [`your page opened tab ${popup.tab}${popup.url ? ` (${popup.url})` : ""}; it is yours to use and close`] : []),
  ];
  return { line: lines.join("\n"), rest };
}
