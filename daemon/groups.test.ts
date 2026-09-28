import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeQueue, deleteGroup, files, groupsOff, guarded, makeGroup, readQueue, startHelper, type Answer, type Helper } from "./groups.ts";
import { pass, type Daemon, type SpaceState } from "./keeper.ts";

const dir = mkdtempSync(join(tmpdir(), "groups-test-"));
Object.assign(files, { queue: join(dir, "groups.json"), off: join(dir, "groups-off.json"), keeper: join(dir, "keeper.pid"), log: join(dir, "keeper.log") });
beforeEach(() => {
  for (const f of [files.queue, files.off]) rmSync(f, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Row = { kind: "group" | "local" | "tab"; name?: string; selected?: boolean; open?: boolean };
const GROUP_MENU = [{ id: "RenameTabGroupMenuItem", title: "Rename", enabled: true }, { id: "DeleteTabGroupMenuItem", title: "Delete", enabled: true }];
const LOCAL_MENU = [{ id: "_safari_invokeBlockForMenuItem:", title: "New Tab Group with 2 Tabs", enabled: true }];
const TAB_MENU = [{ id: "_safari_invokeBlockForMenuItem:", title: "Copy Link", enabled: true }];

// Safari as scripts/spaces reports it: the agent's window 7, of 1003 x 781
// with two tabs, its sidebar rows, and the user a minute away from the keys
// with his terminal in front. on[op] runs as that op arrives: what changes
// under a step. A menu serves the row selected as it opens; a group with
// open tabs asks before it goes.
function safari(rows: Row[]) {
  const s = {
    rows,
    tabs: 2,
    idleMs: 60_000,
    front: "com.mitchellh.ghostty",
    sidebar: false,
    shown: "",
    menus: 0,
    menu: undefined as Row | undefined,
    asking: undefined as Row | undefined,
    // the group a Delete's sheet asks about, if not the menu's
    sheetFor: undefined as Row | undefined,
    // a menu Escape does not end
    stuck: false,
    closed: [] as number[],
    on: {} as Record<string, () => void>,
  };
  const ok = (a: Record<string, unknown> = {}): Answer => ({ ok: true, ...a });
  const h: Helper = async (op, a = {}) => {
    s.on[op]?.();
    switch (op) {
      case "gate":
        return ok({ idleMs: s.idleMs, locked: false, front: s.front, safariActive: false, trusted: true });
      case "find":
        return a.width === 1003 && a.height === 781 ? ok({ window: 7 }) : { ok: false, error: "no Safari window is that size" };
      case "state":
        return ok({ tabs: s.tabs, sidebar: s.sidebar, shown: s.sidebar ? null : s.shown });
      case "sidebar":
        s.sidebar = a.show === true;
        return ok();
      case "rows":
        return ok({ rows: s.rows.map((r) => ({ kind: r.kind, name: r.name, selected: !!r.selected })) });
      case "select":
        s.rows.forEach((r, i) => (r.selected = i === a.index));
        return ok();
      case "menu":
        s.menus++;
        s.menu = s.rows.find((r) => r.selected);
        return ok({ items: s.menu?.kind === "group" ? GROUP_MENU : s.menu?.kind === "local" ? LOCAL_MENU : TAB_MENU });
      case "press": {
        const row = s.menu!;
        s.menu = undefined;
        if (a.id === "DeleteTabGroupMenuItem") {
          if (!row.open) {
            s.rows = s.rows.filter((r) => r !== row);
            return ok({ closed: true, sheet: null });
          }
          s.asking = s.sheetFor ?? row;
          return ok({ closed: true, sheet: { text: [`Are you sure you want to permanently delete “${s.asking.name}”?`], buttons: ["Cancel", "Delete"] } });
        }
        s.rows.forEach((r) => (r.selected = false));
        s.rows.push({ kind: "group", name: "Untitled", selected: true, open: true });
        return ok({ closed: true, sheet: null });
      }
      case "name": {
        const made = s.rows.at(-1)!;
        made.name = String(a.name);
        s.shown = made.name;
        return ok({ named: made.name });
      }
      case "confirm":
        s.rows = s.rows.filter((r) => r !== s.asking);
        s.asking = undefined;
        return ok();
      case "dismiss": {
        const open = s.menu !== undefined || s.asking !== undefined;
        if (!s.stuck) [s.menu, s.asking] = [undefined, undefined];
        return ok({ menu: open, closed: !s.stuck, sheet: false });
      }
      case "close":
        s.closed.push(Number(a.window));
        return ok();
    }
    return { ok: false, error: `unknown op ${op}` };
  };
  return { s, h, groups: () => s.rows.filter((r) => r.kind === "group").map((r) => r.name) };
}

// The daemon's space tool, holding spaces, their windows 1003 x 781;
// released: its answer to a release of a window it knows, which leaves the
// page alone by default. told: what the keeper said.
function daemon(spaces: SpaceState[], released: Record<string, unknown> = { tabs: 1, left: 0 }) {
  const told: Record<string, unknown>[] = [];
  const d: Daemon = async (op, a = {}) => {
    if (op === "state") return { connected: true, spaces };
    told.push({ op, ...a });
    if (op === "release") return spaces.some((s) => s.name === a.name) ? { ok: true, width: 1003, height: 781, ...released } : { ok: true, tabs: 0, left: 0 };
    if (op === "scratch") return { ok: true, width: 1003, height: 781, tabs: 1 };
    return { ok: true };
  };
  return { d, told };
}

const TRIP = "trip (agent 41)";
const waiting: SpaceState = { name: TRIP, width: 1003, height: 781, tabs: 2, group: "waiting", ended: false, owner: process.pid };
const quiet = () => {};

// selectAlone waits 600 ms on the real clock for Safari to settle after a
// select, once here and in the orphan test: Bun.sleep has no fake clock.
test("a group is deleted only once the one of its exact name is selected alone, beside a name it prefixes", async () => {
  const { h, groups } = safari([{ kind: "local" }, { kind: "group", name: "agent-sweep-4", open: true, selected: true }, { kind: "group", name: "agent-sweep", open: true }, { kind: "tab", selected: true }]);
  expect(await deleteGroup(h, 7, "agent-sweep")).toEqual({ done: true });
  expect(groups()).toEqual(["agent-sweep-4"]);
});

test("a confirm sheet asking about another group is cancelled, and both groups stay", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: "agent-sweep", open: true, selected: true }, { kind: "group", name: "agent-sweep-4", open: true }]);
  s.sheetFor = s.rows[2];
  expect(await deleteGroup(h, 7, "agent-sweep")).toMatchObject({ done: false, wait: false });
  expect(groups()).toEqual(["agent-sweep", "agent-sweep-4"]);
  expect(s.asking).toBeUndefined();
});

test("when the selection moves to his group as the menu opens, the menu ends with nothing pressed", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }, { kind: "group", name: "Work" }]);
  s.on.menu = () => s.rows.forEach((r) => (r.selected = r.name === "Work"));
  expect(await deleteGroup(h, 7, TRIP)).toMatchObject({ done: false, wait: false });
  expect(groups()).toEqual([TRIP, "Work"]);
  expect(s.menu).toBeUndefined();
});

test("no menu opens while the user is at the keys, or once another app came to the front", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  s.idleMs = 4000;
  expect(await makeGroup(h, 7, TRIP)).toMatchObject({ done: false, wait: true });
  s.idleMs = 60_000;
  s.on.sidebar = () => (s.front = "com.apple.mail");
  expect(await makeGroup(h, 7, TRIP)).toMatchObject({ done: false, wait: true });
  expect(s.menus).toBe(0);
  expect(groups()).toEqual([]);
});

test("a menu that will not close turns group work off, and no later step opens one", async () => {
  const { s, h } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }, { kind: "tab" }]);
  s.on.menu = () => s.rows.forEach((r) => (r.selected = r.kind === "tab"));
  s.stuck = true;
  const g = guarded(h);
  expect(await deleteGroup(g, 7, TRIP)).toMatchObject({ done: false, wait: false });
  expect(groupsOff()).toContain("menu stayed open");
  expect(await makeGroup(g, 7, "next (agent 42)")).toEqual({ done: false, why: groupsOff()!, wait: false });
  expect(s.menus).toBe(1);
});

test("without the helper built, a waiting window stays plain and says how to build it", async () => {
  const { helper, stop } = startHelper(join(dir, "no-such-helper"));
  const { d, told } = daemon([waiting]);
  expect(await pass(helper, d, new Set(), quiet)).toBe(false);
  stop();
  expect(told).toEqual([{ op: "plain", name: TRIP, why: "the tab group helper is not built (bun run helpers)" }]);
});

test("a window made while the user types stays plain, and becomes its task's group at his first idle moment", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  const { d, told } = daemon([waiting]);
  s.idleMs = 3000;
  expect(await pass(h, d, new Set(), quiet)).toBe(true);
  expect([s.menus, groups()]).toEqual([0, []]);
  s.idleMs = 45_000;
  await pass(h, d, new Set(), quiet);
  expect(groups()).toEqual([TRIP]);
  expect(s.shown).toBe(TRIP);
  expect(told).toEqual([{ op: "making", name: TRIP }, { op: "grouped", name: TRIP }]);
  expect(Object.keys(readQueue())).toEqual([TRIP]);
});

// Its agent exits between the keeper's look at the windows and its first
// step: the daemon has closed the window, and a group made now would stay.
test("a window that ended after the keeper looked gets no group", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  const { d: daemonAnswers, told } = daemon([waiting]);
  const d: Daemon = async (op, a = {}) => (op === "making" ? (told.push({ op, ...a }), { ok: false }) : daemonAnswers(op, a));
  expect(await pass(h, d, new Set(), quiet)).toBe(false);
  expect([s.menus, groups(), Object.keys(readQueue())]).toEqual([0, [], []]);
  expect(told).toEqual([{ op: "making", name: TRIP }]);
});

// A handoff shows Safari for his passkey while the keeper makes another
// agent's group: before, the keeper took that for its own step's doing,
// switched him back to his terminal, and turned group work off.
test("Safari brought forward during a step by an agent's call, or by the user, leaves group work on", async () => {
  for (const who of ["agent", "user"] as const) {
    const { s, h } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
    const { d: daemonAnswers, told } = daemon([waiting]);
    let raisedAt = 0;
    const d: Daemon = async (op, a = {}) => (op === "raised" ? { at: raisedAt } : daemonAnswers(op, a));
    s.on.sidebar = () => {
      s.front = "com.apple.Safari";
      if (who === "agent") raisedAt = Date.now();
      else s.idleMs = 0;
    };
    expect(await pass(h, d, new Set(), quiet)).toBe(true);
    expect(groupsOff()).toBeUndefined();
    expect(told.at(-1)).toMatchObject({ op: "waiting", name: TRIP });
  }
});

test("an ended task's group goes once its tabs for the user are out, with its window, and the queue forgets it", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, open: true, selected: true }, { kind: "tab" }, { kind: "group", name: "Work" }]);
  s.tabs = 1;
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d, told } = daemon([{ ...waiting, group: "grouped", ended: true }]);
  expect(await pass(h, d, new Set(), quiet)).toBe(false);
  expect(groups()).toEqual(["Work"]);
  expect(s.closed).toEqual([7]);
  expect(told).toEqual([{ op: "release", name: TRIP }, { op: "gone", name: TRIP }]);
  expect(readQueue()).toEqual({});
});

// Deleting a group closes its tabs: one for the user still in it must stop
// the delete.
test("an ended task's group stays, queued, while a tab would not move out of it", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, open: true, selected: true }]);
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d } = daemon([{ ...waiting, group: "grouped", ended: true }], { tabs: 2, left: 1 });
  const given = new Set<string>();
  expect(await pass(h, d, given, quiet)).toBe(false);
  expect(await pass(h, d, given, quiet)).toBe(false);
  expect([s.menus, groups(), Object.keys(readQueue())]).toEqual([0, [TRIP], [TRIP]]);
});

test("a queued group no window claims goes once its agent has exited, from a window of its own; a running agent's stays", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "group", name: "old (agent 5)" }, { kind: "group", name: "live (agent 6)" }]);
  s.tabs = 1;
  const exited = Bun.spawnSync(["true"]).pid;
  changeQueue((q) => Object.assign(q, { "old (agent 5)": { owner: exited, since: 0 }, "live (agent 6)": { owner: process.pid, since: 0 } }));
  const { d, told } = daemon([]);
  expect(await pass(h, d, new Set(), quiet)).toBe(true);
  expect(groups()).toEqual(["live (agent 6)"]);
  expect(s.closed).toEqual([7]);
  expect(told).toEqual([{ op: "release", name: "old (agent 5)" }, { op: "scratch" }, { op: "gone", name: "old (agent 5)" }]);
  expect(Object.keys(readQueue())).toEqual(["live (agent 6)"]);
});
