// What the tabs tool shows its caller. An agent sees its own tabs: those in
// its windows (spaces.ts) and the background tabs it opened (tools.ts),
// wherever they went. Of the user's tabs it sees his front tab, which
// "front" names, and a count; host lists those on one site and all lists
// every tab, a tab not its own cut to its origin and path. A research agent
// once listed his whole Safari six times over, and a leak check sent his
// tabs, an OAuth state token among them, into a subagent. The user himself,
// at a terminal, and a caller with no agent behind it get every tab.

import { currentOwner, processName } from "./owner.ts";
import { siteHost } from "./notes.ts";
import { isSpacePage, windowOwners } from "./spaces.ts";
import type { TabInfo } from "./tools.ts";

// The first process above a command he types in a terminal window that is
// not a shell: his own call, never an agent's.
const HIS_TERMINAL = "login";

// owners: whose each background tab the harness opened is (tools.ts).
export async function tabsView(tabs: TabInfo[], owners: Map<number, number | undefined>, a: Record<string, unknown>): Promise<(TabInfo | string)[]> {
  const site = typeof a.host === "string" && a.host !== "" ? siteHost(a.host) : undefined;
  const onSite = (t: TabInfo) => {
    const host = URL.parse(t.url ?? "")?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
    return site === undefined || host === site || host.endsWith(`.${site}`);
  };
  const me = currentOwner();
  if (me === undefined || (await processName(me)) === HIS_TERMINAL) return a.all === true ? tabs : tabs.filter(onSite);

  // A tab the harness opened is its opener's wherever it is; any other tab
  // is the agent's whose window holds it, and the user's outside them.
  const windows = windowOwners();
  const whose = (t: TabInfo): "mine" | "his" | "other" => {
    if (owners.has(t.id)) return owners.get(t.id) === me ? "mine" : "other";
    if (t.windowId !== undefined && windows.has(t.windowId)) return windows.get(t.windowId) === me ? "mine" : "other";
    return isSpacePage(t) ? "other" : "his";
  };
  if (a.all === true) return tabs.map((t) => (whose(t) === "mine" ? t : cut(t)));
  if (site !== undefined) return tabs.filter((t) => whose(t) === "his" && onSite(t)).map(cut);

  const mine = tabs.filter((t) => whose(t) === "mine" && !isSpacePage(t));
  const front = tabs.find((t) => t.front && whose(t) !== "mine");
  const his = tabs.filter((t) => whose(t) === "his").length;
  return [
    ...mine,
    ...(front ? [{ id: front.id, windowId: front.windowId, active: true, front: true }] : []),
    ...(his > 0 ? [`the user has ${his} other tab${his === 1 ? "" : "s"}; pass host: "github.com" to see those on a site, or all: true`] : []),
  ];
}

// A tab with its address cut to origin and path: no query, no fragment.
function cut(t: TabInfo): TabInfo {
  const u = URL.parse(t.url ?? "");
  if (!u) return t;
  return { ...t, url: u.protocol === "http:" || u.protocol === "https:" ? u.origin + u.pathname : `${u.protocol}…` };
}
