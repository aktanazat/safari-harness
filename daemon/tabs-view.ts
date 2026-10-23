// What the tabs tool shows its caller, always as {tabs, note?}: on 10-11 a
// list that ended in a sentence about the rest failed a script reading each
// row's url ("'str' object has no attribute 'get'"). An agent sees its own
// tabs: those in its windows (spaces.ts) and the tabs it opened (tools.ts),
// wherever they went. Of the user's tabs it sees his front tab, which
// "front" names, and the note counts the others; host lists those on one
// site and all lists every tab, a tab not its own cut to its origin and
// path. A research agent once listed his whole Safari six times over, and a
// leak check sent his tabs, an OAuth state token among them, into a
// subagent. The user himself, at a terminal, and a caller with no agent
// behind it get every tab.

import { currentOwner, currentTask, processName } from "./owner.ts";
import { siteHost } from "./notes.ts";
import { isSpacePage, windowOwners } from "./spaces.ts";
import type { TabInfo } from "./tools.ts";

// The first process above a command he types in a terminal window that is
// not a shell: his own call, never an agent's.
const HIS_TERMINAL = "login";

export type TabList = { tabs: TabInfo[]; note?: string };

// The rows of a tabs answer, for a caller that lists through the daemon's
// RPC port (input.ts, handoff.ts, fill.ts, the CLI).
export function rowsOf(listed: unknown): TabInfo[] {
  if (!listed || typeof listed !== "object" || !("tabs" in listed) || !Array.isArray(listed.tabs)) throw new Error("the daemon answered tabs without a tabs list: it runs an older harness than this caller; run safari daemon install to start the current one");
  return listed.tabs;
}

function listed(tabs: TabInfo[], ...notes: (string | undefined)[]): TabList {
  const note = notes.filter((n) => n !== undefined).join("; ");
  return note === "" ? { tabs } : { tabs, note };
}

// owners: whose each background tab the harness opened is (tools.ts).
export async function tabsView(tabs: TabInfo[], owners: Map<number, number | undefined>, a: Record<string, unknown>): Promise<TabList> {
  const site = typeof a.host === "string" && a.host !== "" ? siteHost(a.host) : undefined;
  const onSite = (t: TabInfo) => {
    const host = URL.parse(t.url ?? "")?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
    return site === undefined || host === site || host.endsWith(`.${site}`);
  };
  // A listing whose look at Safari's windows did not finish within 2.5 s
  // marks each row partial and names no front tab (background.js), which is
  // not the user having none.
  const unsure = tabs.some((t) => typeof t.partial === "string") ? "Safari did not say which tab is in front within 2.5 s; call tabs again to see it" : undefined;
  const me = currentOwner();
  if (me === undefined || (await processName(me)) === HIS_TERMINAL) return listed(a.all === true ? tabs : tabs.filter(onSite), unsure);

  // A tab the harness opened is its opener's wherever it is; any other tab
  // is the agent's whose window holds it, and the user's outside them.
  const windows = windowOwners(currentTask());
  const whose = (t: TabInfo): "mine" | "his" | "other" => {
    if (owners.has(t.id)) return owners.get(t.id) === me ? "mine" : "other";
    if (t.windowId !== undefined && windows.has(t.windowId)) return windows.get(t.windowId) === me ? "mine" : "other";
    return isSpacePage(t) ? "other" : "his";
  };
  if (a.all === true) return listed(tabs.map((t) => (whose(t) === "mine" ? t : cut(t))), unsure);
  if (site !== undefined) return listed(tabs.filter((t) => whose(t) === "his" && onSite(t)).map(cut), unsure);

  const mine = tabs.filter((t) => whose(t) === "mine" && !isSpacePage(t));
  const front = tabs.find((t) => t.front && whose(t) !== "mine");
  // his tabs besides the front one, which the list shows
  const others = tabs.filter((t) => whose(t) === "his" && t.id !== front?.id).length;
  return listed(
    [...mine, ...(front ? [{ id: front.id, windowId: front.windowId, active: true, front: true }] : [])],
    others > 0 ? `the user has ${others} other tab${others === 1 ? "" : "s"}; pass host: "github.com" (CLI --site github.com) to see those on a site, or all: true` : undefined,
    unsure,
  );
}

// A tab with its address cut to origin and path: no query, no fragment.
function cut(t: TabInfo): TabInfo {
  const u = URL.parse(t.url ?? "");
  if (!u) return t;
  return { ...t, url: u.protocol === "http:" || u.protocol === "https:" ? u.origin + u.pathname : `${u.protocol}…` };
}
