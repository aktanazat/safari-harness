import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeQueue, deleteGroup, files, groupsOff, guarded, keeperRunning, makeGroup, readQueue, startHelper, turnOff, type Answer, type Helper } from "./groups.ts";
import { keep, pass, type Daemon, type Given, type SpaceState } from "./keeper.ts";

const dir = mkdtempSync(join(tmpdir(), "groups-test-"));
Object.assign(files, { queue: join(dir, "groups.json"), off: join(dir, "groups-off.json"), keeper: join(dir, "keeper.pid"), log: join(dir, "keeper.log") });
beforeEach(() => {
  for (const f of [files.queue, files.off]) rmSync(f, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// open: the group holds tabs, its Delete sheet naming them: the window's own
// page alone, or the line given.
type Row = { kind: "group" | "local" | "tab"; name?: string; selected?: boolean; open?: boolean | string };
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
    frontPid: process.pid,
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
        return ok({ idleMs: s.idleMs, locked: false, front: s.front, frontPid: s.frontPid, safariActive: false, trusted: true });
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
          const closes = typeof s.asking.open === "string" ? s.asking.open : "“127.0.0.1” will be closed immediately.";
          return ok({ closed: true, sheet: { text: [`Are you sure you want to permanently delete “${s.asking.name}”?`, closes], buttons: ["Cancel", "Delete"] } });
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
    if (op === "release") return spaces.some((s) => s.name === a.name) ? { ok: true, width: 1003, height: 781, ...released } : { ok: false };
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

// A flag no one removes ends after a day: on 09-29 one from the day before
// still kept every agent's windows plain.
test("group work turned off comes back on a day later", () => {
  turnOff("Safari's menu stayed open after delete");
  const raisedAgo = (hours: number) => {
    const at = new Date(Date.now() - hours * 60 * 60_000);
    utimesSync(files.off, at, at);
  };
  raisedAgo(23);
  expect(groupsOff()).toContain("menu stayed open");
  raisedAgo(25);
  expect(groupsOff()).toBeUndefined();
});

test("without the helper built, a waiting window stays plain and says how to build it", async () => {
  const { helper, stop } = startHelper(join(dir, "no-such-helper"));
  const { d, told } = daemon([waiting]);
  expect(await pass(helper, d, new Map(), quiet)).toBe(false);
  stop();
  expect(told).toEqual([{ op: "plain", name: TRIP, why: "the tab group helper is not built (bun run helpers)" }]);
});

test("a window made while the user types stays plain, and becomes its task's group at his first idle moment", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  const { d, told } = daemon([waiting]);
  s.idleMs = 3000;
  expect(await pass(h, d, new Map(), quiet)).toBe(true);
  expect([s.menus, groups()]).toEqual([0, []]);
  s.idleMs = 45_000;
  await pass(h, d, new Map(), quiet);
  expect(groups()).toEqual([TRIP]);
  expect(s.shown).toBe(TRIP);
  expect(told).toEqual([{ op: "making", name: TRIP }, { op: "grouped", name: TRIP }]);
  expect(Object.keys(readQueue())).toEqual([TRIP]);
});

test("a failed sidebar hide reports the failed step, not identical group names", async () => {
  const { h } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  const failedHide: Helper = (op, args) => op === "sidebar" && args?.show === false
    ? Promise.resolve({ ok: false, error: "the sidebar could not hide" }) : h(op, args);
  const result = await makeGroup(failedHide, 7, TRIP);
  expect(result).toMatchObject({ done: false, why: "the sidebar could not hide" });
});

// Its agent exits between the keeper's look at the windows and its first
// step: the daemon has closed the window, and a group made now would stay.
test("a window that ended after the keeper looked gets no group", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  const { d: daemonAnswers, told } = daemon([waiting]);
  const d: Daemon = async (op, a = {}) => (op === "making" ? (told.push({ op, ...a }), { ok: false }) : daemonAnswers(op, a));
  expect(await pass(h, d, new Map(), quiet)).toBe(false);
  expect([s.menus, groups(), Object.keys(readQueue())]).toEqual([0, [], []]);
  expect(told).toEqual([{ op: "making", name: TRIP }]);
});

// 11-11: Safari held two windows of a new agent window's size, and the
// keeper left it plain with no line in keeper.log.
test("a window the keeper cannot find stays plain, and keeper.log says why", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  const two = "Safari has 2 windows of 1003 x 781 points";
  const twice: Helper = (op, a) => (op === "find" ? Promise.resolve({ ok: false, error: two }) : h(op, a));
  const { d, told } = daemon([waiting]);
  const lines: string[] = [];
  expect(await pass(twice, d, new Map(), (line) => { lines.push(line); })).toBe(false);
  expect([s.menus, groups()]).toEqual([0, []]);
  expect(told).toEqual([{ op: "plain", name: TRIP, why: two }]);
  expect(lines).toEqual([`making ${TRIP}: ${two}`]);
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
    expect(await pass(h, d, new Map(), quiet)).toBe(true);
    expect(groupsOff()).toBeUndefined();
    expect(told.at(-1)).toMatchObject({ op: "waiting", name: TRIP });
  }
});

test("an ended task's group goes once its tabs for the user are out, with its window, and the queue forgets it", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, open: true, selected: true }, { kind: "tab" }, { kind: "group", name: "Work" }]);
  s.tabs = 1;
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d, told } = daemon([{ ...waiting, group: "grouped", ended: true }]);
  expect(await pass(h, d, new Map(), quiet)).toBe(false);
  expect(groups()).toEqual(["Work"]);
  expect(s.closed).toEqual([7]);
  expect(told).toEqual([{ op: "release", name: TRIP, pass: expect.any(String) }, { op: "gone", name: TRIP }]);
  expect(readQueue()).toEqual({});
});

// Deleting a group closes its tabs: one for the user still in it must stop
// the delete. He may keep that tab for days: no keeper stays on for it.
test("an ended task's group stays, queued, while a tab would not move out of it", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, open: true, selected: true }]);
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d } = daemon([{ ...waiting, group: "grouped", ended: true }], { tabs: 2, left: 1 });
  const given: Given = new Map();
  expect(await pass(h, d, given, quiet)).toBe(false);
  expect(await pass(h, d, given, quiet)).toBe(false);
  expect([s.menus, groups(), Object.keys(readQueue())]).toEqual([0, [TRIP], [TRIP]]);
});

// 10-30: a sheet naming tabs the daemon did not see makes the group the
// user's: it stays, with its window, and leaves the queue. Wording not seen
// before is no proof, and the group stays queued.
test("an ended task's group whose Delete would close pages stays, and only proof of pages lets the queue forget it", async () => {
  for (const [closes, queued] of [["“app.dover.com” and 8 other tabs will be closed immediately.", []], ["“Start Page” will be closed immediately.", [TRIP]]] as const) {
    const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, open: closes, selected: true }]);
    s.tabs = 1;
    changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
    const { d } = daemon([{ ...waiting, group: "grouped", ended: true }]);
    await pass(h, d, new Map(), quiet);
    expect([groups(), s.closed, s.asking, Object.keys(readQueue())]).toEqual([[TRIP], [], undefined, [...queued]]);
  }
});

// 10-07: a delete left agent 8780's group queued (the selection moved off
// it as the menu opened), and the keeper, kept on by another agent's
// groups, never tried it again: the group stood in his sidebar for hours,
// its page saying the harness had restarted. On 10-30 a keeper with no
// other window to watch quit at once, and window 5 waited 55 min.
test("a group a failed delete left queued is tried again by the same keeper a while later, not at once", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }, { kind: "group", name: "Work" }]);
  s.tabs = 1;
  s.on.menu = () => {
    delete s.on.menu;
    s.rows.forEach((r) => (r.selected = r.name === "Work"));
  };
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d } = daemon([{ ...waiting, group: "grouped", ended: true }]);
  const given: Given = new Map();
  expect(await pass(h, d, given, quiet)).toBe(true);
  expect(await pass(h, d, given, quiet)).toBe(true);
  expect([s.menus, groups()]).toEqual([1, [TRIP, "Work"]]);
  setSystemTime(new Date(Date.now() + 15 * 60_000));
  try {
    await pass(h, d, given, quiet);
  } finally {
    setSystemTime();
  }
  expect(groups()).toEqual(["Work"]);
  expect(readQueue()).toEqual({});
});

// 10-27 and 10-29: two groups queued with no window the daemon knew stood
// in his sidebar for days, every pass asking for them again.
test("a queued group no window claims is left to the user once its agent has exited; a running agent's stays queued", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "group", name: "old (agent 5)" }, { kind: "group", name: "live (agent 6)" }]);
  const exited = Bun.spawnSync(["true"]).pid;
  changeQueue((q) => Object.assign(q, { "old (agent 5)": { owner: exited, since: 0 }, "live (agent 6)": { owner: process.pid, since: 0 } }));
  const { d, told } = daemon([]);
  expect(await pass(h, d, new Map(), quiet)).toBe(true);
  expect([s.menus, groups(), told, Object.keys(readQueue())]).toEqual([0, ["old (agent 5)", "live (agent 6)"], [], ["live (agent 6)"]]);
});

// 10-27: a make whose check misread the window left its group, and the
// window, told plain, never went the way of a group's: no keeper could
// delete it.
test("a make that leaves its group tells the daemon the window is a group's, and the group stays queued", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  const failedHide: Helper = (op, args) => {
    if (op !== "sidebar" || args?.show !== false) return h(op, args);
    s.idleMs = 0;
    return Promise.resolve({ ok: false, error: "the sidebar could not hide" });
  };
  const { d, told } = daemon([waiting]);
  await pass(failedHide, d, new Map(), quiet);
  expect([groups(), Object.keys(readQueue()), told.at(-1)]).toEqual([[TRIP], [TRIP], { op: "grouped", name: TRIP }]);
});

// 10-30: as the menu opened, the sidebar read for a moment as a tab row
// selected, the group again 300 ms on, and deletes stopped there.
test("a selection that reads as moved for a moment as the menu opens still deletes the group", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }, { kind: "tab" }, { kind: "group", name: "Work" }]);
  // the menu serves the group; the next read finds a tab selected, the one
  // after it the group
  s.on.menu = () => {
    delete s.on.menu;
    s.on.rows = () => {
      s.rows.forEach((r) => (r.selected = r.kind === "tab"));
      s.on.rows = () => {
        delete s.on.rows;
        s.rows.forEach((r) => (r.selected = r.name === TRIP));
      };
    };
  };
  expect(await deleteGroup(h, 7, TRIP)).toEqual({ done: true });
  expect(groups()).toEqual(["Work"]);
});

// 10-22: Safari came forward during a delete that worked; the group, gone,
// stayed queued as if it were still there.
test("a delete that worked while Safari came forward turns group work off, and the queue still forgets the group", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }, { kind: "group", name: "Work" }]);
  s.tabs = 1;
  s.on.press = () => (s.front = "com.apple.Safari");
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d } = daemon([{ ...waiting, group: "grouped", ended: true }]);
  await pass(h, d, new Map(), quiet);
  expect([groups(), readQueue(), groupsOff()]).toEqual([["Work"], {}, expect.stringContaining("Safari came to the front")]);
});

// 11-11: the app in front, a scratch app another session quit and opened
// again every minute or two, quit during steps; its own quit gave Safari
// the front.
test("a delete during which his app quit, giving Safari the front, leaves group work on", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }, { kind: "group", name: "Work" }]);
  s.tabs = 1;
  const app = Bun.spawn(["sleep", "60"]);
  s.frontPid = app.pid;
  s.on.press = () => {
    app.kill();
    s.front = "com.apple.Safari";
  };
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d } = daemon([{ ...waiting, group: "grouped", ended: true }]);
  await pass(h, d, new Map(), quiet);
  expect([groups(), readQueue(), groupsOff()]).toEqual([["Work"], {}, undefined]);
});

// 10-30: with group work off for a day after a make left its group, ended
// agents' groups stood in his sidebar that whole day; he asked for them to
// go anyway. A flag a menu or a delete raised still stops deletes: on 10-22
// a delete brought Safari forward, and the next ones would have too.
test("a flag a make raised lets an ended task's group go and keeps a waiting window plain; any other flag keeps the group", async () => {
  for (const deletes of [false, true]) {
    const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }, { kind: "group", name: "Work" }]);
    s.tabs = 1;
    turnOff("the window shows no group, and its new group is left", deletes);
    changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
    const next = { ...waiting, name: "next (agent 42)" };
    const { d, told } = daemon([{ ...waiting, group: "grouped", ended: true }, next]);
    await pass(h, d, new Map(), quiet);
    expect([groups(), Object.keys(readQueue())]).toEqual(deletes ? [[TRIP, "Work"], [TRIP]] : [["Work"], []]);
    expect(told.at(-1)).toEqual({ op: "plain", name: next.name, why: groupsOff() });
  }
});

// 11-06: a window opened to delete a group from (scratch) holds one tab, its
// page, and Safari draws no tab bar for a plain window of one tab, so the
// helper counted none there (measured live: {"tabs":0,"sidebar":false}).
// Every delete from one waited, and 16 ended groups stayed for days.
test("an ended group whose own window is gone goes from a window of one tab that shows no tab bar", async () => {
  const { s, h, groups } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }, { kind: "group", name: "Work" }]);
  s.tabs = 0;
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d, told } = daemon([{ ...waiting, group: "grouped", ended: true }], { tabs: 0, left: 0 });
  await pass(h, d, new Map(), quiet);
  expect([groups(), s.closed, told.at(-1), readQueue()]).toEqual([["Work"], [7], { op: "gone", name: TRIP }, {}]);
});

// 11-06: a delete that waited was tried again the next pass, 3 s on, with
// nothing in keeper.log: 16 groups so made 865k tab lists in 49 h.
test("a delete that waits is said once, and tried again only after a wait that grows", async () => {
  const { s, h } = safari([{ kind: "local" }]);
  // a tab opening meanwhile: the window of its size holds 3, not 1
  s.tabs = 3;
  const names = Array.from({ length: 16 }, (_, i) => `agent ${1000 + i}`);
  const { d, told } = daemon(names.map((name) => ({ ...waiting, name, group: "grouped", ended: true })), { tabs: 0, left: 0 });
  const given: Given = new Map();
  const logged: string[] = [];
  const releases = () => told.filter((t) => t.op === "release").length;
  const start = Date.now();
  try {
    for (let i = 0; i < 3; i++) expect(await pass(h, d, given, (l) => logged.push(l))).toBe(true);
    expect([releases(), logged.length, given.size]).toEqual([16, 16, 16]);
    expect(logged[0]).toBe("agent 1000 waits: the window of its size holds 3 tabs, not 1");
    setSystemTime(new Date(start + 31_000));
    await pass(h, d, given, (l) => logged.push(l));
    expect([releases(), logged.length]).toEqual([32, 16]);
    // the second wait is twice as long
    setSystemTime(new Date(start + 62_000));
    await pass(h, d, given, (l) => logged.push(l));
    expect(releases()).toBe(32);
  } finally {
    setSystemTime();
  }
});

// 11-06: one keeper retried two groups his tabs held every 10 min for 17
// hours, though such a group waits for the next keeper.
test("a group a tab of his holds is not tried again by the same keeper, however long it runs", async () => {
  const { h } = safari([{ kind: "local" }, { kind: "group", name: TRIP, open: true, selected: true }]);
  changeQueue((q) => (q[TRIP] = { owner: process.pid, since: 0 }));
  const { d, told } = daemon([{ ...waiting, group: "grouped", ended: true }], { tabs: 2, left: 1 });
  const given: Given = new Map();
  try {
    await pass(h, d, given, quiet);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    await pass(h, d, given, quiet);
  } finally {
    setSystemTime();
  }
  expect(told.filter((t) => t.op === "release")).toHaveLength(1);
});

// 11-06: 18 ended groups whose agents had exited and whose windows were
// gone stood in the daemon's records since 11-02, each delete from a
// scratch window failing.
test("an exited agent's group is left to the user after three failed deletes from a scratch window; a running agent's stays queued", async () => {
  const { h } = safari([{ kind: "local" }, { kind: "group", name: "old (agent 5)" }, { kind: "group", name: "live (agent 6)" }]);
  const exited = Bun.spawnSync(["true"]).pid;
  changeQueue((q) => Object.assign(q, { "old (agent 5)": { owner: exited, since: 0 }, "live (agent 6)": { owner: process.pid, since: 0 } }));
  const { d: answers, told } = daemon([{ ...waiting, name: "old (agent 5)", owner: exited, group: "grouped", ended: true }, { ...waiting, name: "live (agent 6)", group: "grouped", ended: true }], { tabs: 0, left: 0 });
  // a scratch window of a size the helper finds no window of
  const d: Daemon = async (op, a = {}) => (op === "scratch" ? (told.push({ op }), { ok: true, width: 1200, height: 870, tabs: 1 }) : answers(op, a));
  const given: Given = new Map();
  const logged: string[] = [];
  const start = Date.now();
  try {
    for (let i = 0; i < 3; i++) {
      setSystemTime(new Date(start + i * 10 * 60_000 + i * 1000));
      await pass(h, d, given, (l) => logged.push(l));
    }
  } finally {
    setSystemTime();
  }
  expect(told.filter((t) => t.op === "gone")).toEqual([{ op: "gone", name: "old (agent 5)" }]);
  expect(Object.keys(readQueue())).toEqual(["live (agent 6)"]);
  expect(logged.at(-2)).toStartWith("left old (agent 5) to the user: its agent exited, its window is gone, and 3 deletes from a window opened for it failed");
});

// 11-08: a group named agent 3910, left in his sidebar, kept each later
// window of that name waiting, and the keeper tried them again every 3 s,
// a keeper.log line each time: 935 in what it kept.
test("a window named like a tab group already in the sidebar stays plain with its sidebar hidden, said once, and is not tried again", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "group", name: TRIP }, { kind: "tab" }, { kind: "tab" }]);
  const space = { ...waiting };
  const { d: answers, told } = daemon([]);
  // as the daemon: a plain window is listed no more
  const d: Daemon = async (op, a = {}) => {
    if (op === "state") return { connected: true, spaces: space.group === "plain" ? [] : [space] };
    if (op === "making" || op === "waiting" || op === "plain" || op === "grouped") space.group = op;
    return answers(op, a);
  };
  const given: Given = new Map();
  const logged: string[] = [];
  for (let i = 0; i < 3; i++) await pass(h, d, given, (l) => logged.push(l));
  expect([groups(), s.menus, s.sidebar, readQueue()]).toEqual([[TRIP], 0, false, {}]);
  expect(told).toEqual([{ op: "making", name: TRIP }, { op: "plain", name: TRIP, why: expect.stringContaining(`a tab group named ${TRIP} is already in the sidebar`) }]);
  expect(logged).toEqual([expect.stringContaining(`making ${TRIP}: a tab group named ${TRIP} is already in the sidebar`)]);
});

// A keeper whose last pass finds nothing due still reads as running to an
// open that lands then, which so starts none (call.ts), and the window
// that open fills would wait for its agent's next open. The keeper making
// its group reads as running too: the daemon holds a window being made
// open only while one runs (spaces.ts).
test("a window filled as the keeper takes its last look still becomes its task's group", async () => {
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "tab" }, { kind: "tab" }]);
  const space = { ...waiting, owner: Bun.spawnSync(["true"]).pid };
  const { d: answers } = daemon([]);
  let looks = 0;
  let started: boolean | undefined;
  let making: boolean | undefined;
  const d: Daemon = async (op, a = {}) => {
    if (op !== "state") {
      if (op === "making") making = keeperRunning();
      if (op === "making" || op === "waiting" || op === "plain" || op === "grouped") space.group = op;
      return answers(op, a);
    }
    // The first look lists no window, its two tabs not yet enough; the
    // third opens then, and its call starts a keeper only if none runs.
    if (++looks === 1) {
      [s.tabs, space.tabs] = [3, 3];
      started = !keeperRunning();
      return { connected: true, spaces: [] };
    }
    return { connected: true, spaces: space.group === "waiting" ? [space] : [] };
  };
  await keep(h, d, quiet);
  expect([started, making, groups()]).toEqual([false, true, [TRIP]]);
}, 10_000);

// A last pass that works on a window and finds nothing more is no last
// look: a window another open fills meanwhile still becomes a group.
test("a window filled while the keeper's last pass works on another still becomes its task's group", async () => {
  const OTHER = "other (agent 42)";
  const { s, h, groups } = safari([{ kind: "local", selected: true }, { kind: "group", name: OTHER }, { kind: "tab" }, { kind: "tab" }]);
  s.tabs = 3;
  const exited = Bun.spawnSync(["true"]).pid;
  const spaces = [{ ...waiting, name: OTHER, tabs: 3, owner: exited }, { ...waiting, owner: exited }];
  const { d: answers } = daemon([]);
  let looks = 0;
  let started: boolean | undefined;
  const d: Daemon = async (op, a = {}) => {
    if (op === "state") return { connected: true, spaces: ++looks === 1 ? [] : spaces.filter((x) => x.group === "waiting" && (x.tabs ?? 0) >= 3) };
    const space = spaces.find((x) => x.name === a.name);
    // the other window's third tab opens as the keeper starts on this one
    if (space?.name === OTHER && op === "making") {
      spaces[1].tabs = 3;
      started = !keeperRunning();
    }
    if (space && (op === "making" || op === "waiting" || op === "plain" || op === "grouped")) space.group = op;
    return answers(op, a);
  };
  await keep(h, d, quiet);
  expect([started, groups()]).toEqual([false, [OTHER, TRIP]]);
}, 10_000);

// The last look acts on nothing: an ended group the last pass let be, with
// deletes off, is no cause for another pass at once, which would spin.
test("a keeper whose ended group waits on deletes turned off stops after one more look", async () => {
  const { h } = safari([{ kind: "local" }, { kind: "group", name: TRIP, selected: true }]);
  turnOff("a step stopped");
  const { d: answers } = daemon([{ ...waiting, group: "grouped", ended: true }]);
  let looks = 0;
  const d: Daemon = async (op, a = {}) => {
    if (op === "state" && ++looks > 9) throw new Error("the keeper looks on and on");
    return answers(op, a);
  };
  await keep(h, d, quiet);
  expect(looks).toBe(2);
});
