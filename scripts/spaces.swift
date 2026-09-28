// Safari tab groups for agent windows (daemon/groups.ts), through
// Accessibility: Safari gives extensions and AppleScript no tab groups, and
// its File menu commands for them need a key window, which Safari has only
// while it is active, and it is never activated for this. So this helper
// works the controls of the agent's own window, in the background: the
// sidebar's menus (New Tab Group with the window's tabs, Delete) and the
// sidebar's name field. It only reports and acts; groups.ts decides, so
// every check between two steps is there, where tests reach it.
//
// The sidebar's menu serves its selected row, wherever that row is (probe
// of 09-28: a selected tab gave a tab's menu with a group under the
// sidebar's centre, and a selected group a group's menu with a section
// there). Selecting a group the window does not show makes the window show
// it, and Safari then selects that group's front tab instead; selecting the
// group again then holds.
//
// A menu Safari opens draws above the user's app and takes his keys while
// it is open. So an op that opens one first checks, then and there, that
// he has left the keys alone minIdleMs, the screen is unlocked, and front
// is still the app in front. Every op that ends a menu then reads, within
// 500 ms, that Safari has no menu window left, and posts one more Escape
// to Safari alone (never the front app) if it has; closed: false says the
// menu is still open, and groups.ts stops all group work. AXCancel leaves
// a menu open (09-28), and the Escape counts as input: HIDIdleTime starts
// again from it, so the next menu waits for the idle time again.
//   spaces serve              one JSON request per line on stdin, one JSON
//                             answer per line on stdout, until stdin closes
//   spaces OP ['<json>']      one request, for a person at a terminal
// Requests are {"op": OP, ...}; answers {"ok": true, ...} or {"ok": false,
// "error"}. OPs, the most on one Safari window by its CGWindowID (window):
//   gate                      {idleMs, locked, front, safariActive, trusted}
//   find {width, height}      {window}: the one Safari window of that size
//   state                     {tabs, sidebar, shown}
//   sidebar {show}            shows or hides the window's sidebar
//   rows                      {rows: [{kind, name?, selected}]}; kind: group
//                             (a synced tab group, with its name), local
//                             (the window's own tabs), private, tab, or other
//   select {index}            selects that row
//   menu {minIdleMs, front}   opens the sidebar's menu: {items: [{id, title,
//                             enabled}]}
//   press {id | title}        presses that item of the open menu, by its
//                             id or its exact title: {closed, sheet: {text,
//                             buttons} | null}
//   dismiss                   ends an open menu, cancels an open sheet:
//                             {menu, closed, sheet}
//   confirm {button}          presses the sheet's button of that title
//   name {name}               names the new group: {named}, the name its
//                             row then shows
//   close                     closes the window
//   lock {ms} / unlock        one helper at a time on the group queue
// Needs Accessibility permission for the app that runs it (gate says).
import AppKit
import ApplicationServices
import IOKit

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ el: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

// closed: false when a menu the op opened is still open (see the top).
struct Failure: Error {
    let message: String
    var closed: Bool? = nil
}

func pause(_ ms: Int) { usleep(useconds_t(ms * 1000)) }

func poll<T>(_ ms: Int, _ get: () -> T?) -> T? {
    let deadline = Date().addingTimeInterval(Double(ms) / 1000)
    repeat {
        if let v = get() { return v }
        pause(25)
    } while Date() < deadline
    return nil
}

// ---------- Accessibility ----------

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func text(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }
func kids(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func role(_ el: AXUIElement) -> String { text(el, kAXRoleAttribute) ?? "" }
func ident(_ el: AXUIElement) -> String { text(el, kAXIdentifierAttribute) ?? "" }
func perform(_ el: AXUIElement, _ action: String) -> Bool { AXUIElementPerformAction(el, action as CFString) == .success }
func windowId(_ el: AXUIElement) -> CGWindowID? {
    var id: CGWindowID = 0
    return _AXUIElementGetWindow(el, &id) == .success ? id : nil
}

// Every element below el that matches, depth first; never enters a page.
func findAll(_ el: AXUIElement, depth: Int, _ match: (AXUIElement) -> Bool) -> [AXUIElement] {
    if match(el) { return [el] }
    if depth == 0 || role(el) == "AXWebArea" { return [] }
    return kids(el).flatMap { findAll($0, depth: depth - 1, match) }
}
func find(_ el: AXUIElement, depth: Int, _ match: (AXUIElement) -> Bool) -> AXUIElement? {
    if match(el) { return el }
    if depth == 0 || role(el) == "AXWebArea" { return nil }
    for k in kids(el) { if let hit = find(k, depth: depth - 1, match) { return hit } }
    return nil
}

let SAFARI = "com.apple.Safari"
var safariApp: (pid: pid_t, el: AXUIElement)?

func safari() throws -> (pid: pid_t, el: AXUIElement) {
    if let s = safariApp, kill(s.pid, 0) == 0 { return s }
    guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: SAFARI).first else { throw Failure(message: "Safari is not running") }
    let el = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 2)
    safariApp = (running.processIdentifier, el)
    return safariApp!
}

// ---------- the user ----------

// Milliseconds since the last keyboard or mouse event, as IOHIDSystem
// counts them; Accessibility actions are not events and leave it alone.
func idleMs() -> Int? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    guard service != 0 else { return nil }
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber else { return nil }
    return Int(value.uint64Value / 1_000_000)
}

// Off the console (another user's session) counts as locked.
func screenLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    return (session["CGSSessionScreenIsLocked"] as? Bool ?? false) || (session[kCGSessionOnConsoleKey as String] as? Bool) == false
}

// The frontmost app. NSWorkspace hears of a change through the run loop,
// which a long serve would otherwise never turn, so it turns it first.
func frontApp() -> String {
    RunLoop.current.run(until: Date())
    return NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
}

func gate() -> [String: Any] {
    let front = frontApp()
    return [
        "idleMs": idleMs() ?? 0,
        "locked": screenLocked(),
        "front": front,
        "safariActive": front == SAFARI,
        "trusted": AXIsProcessTrusted(),
    ]
}

// ---------- the agent's window ----------

func window(_ req: [String: Any]) throws -> AXUIElement {
    guard let id = (req["window"] as? NSNumber)?.uint32Value else { throw Failure(message: "window must be a CGWindowID") }
    guard let w = ((attr(try safari().el, kAXWindowsAttribute) as? [AXUIElement]) ?? []).first(where: { windowId($0) == id }) else { throw Failure(message: "Safari has no window \(id)") }
    return w
}

// The ids of Safari's windows of width x height points.
func windowsOfSize(_ width: Double, _ height: Double) throws -> [CGWindowID] {
    let pid = try safari().pid
    let list = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.compactMap { info in
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let b = info[kCGWindowBounds as String] as? [String: Any],
              let w = (b["Width"] as? NSNumber)?.doubleValue, let h = (b["Height"] as? NSNumber)?.doubleValue,
              abs(w - width) < 1, abs(h - height) < 1 else { return nil }
        return (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    }
}

func tabs(_ w: AXUIElement) -> [AXUIElement] { findAll(w, depth: 5) { ident($0).hasPrefix("TabBarTab?") } }

// The group the window shows, as its toolbar's group picker names it; the
// picker shows only while the sidebar is hidden.
func shownGroup(_ w: AXUIElement) -> String? {
    let prefix = "TabGroupPickerButton?TabGroup="
    return find(w, depth: 3) { ident($0).hasPrefix(prefix) }.map { el in
        let raw = String(ident(el).dropFirst(prefix.count))
        return raw.removingPercentEncoding ?? raw
    }
}

func outline(_ w: AXUIElement) -> AXUIElement? { find(w, depth: 4) { ident($0) == "LibraryView" } }

func requireOutline(_ w: AXUIElement) throws -> AXUIElement {
    guard let o = outline(w) else { throw Failure(message: "the window's sidebar is hidden") }
    return o
}

func rows(_ o: AXUIElement) -> [AXUIElement] { (attr(o, kAXRowsAttribute) as? [AXUIElement]) ?? [] }

// What a sidebar row is, by its cell: a synced tab group (with its name),
// the window's own tabs, the private group, a tab, or anything else.
func describeRow(_ row: AXUIElement) -> (kind: String, name: String?) {
    guard let cell = find(row, depth: 3, { ident($0).hasPrefix("SidebarLibraryItem") }) else { return ("other", nil) }
    let id = ident(cell)
    if id == "SidebarLibraryItemTab" { return ("tab", nil) }
    let prefix = "SidebarLibraryItemTabGroup?"
    guard id.hasPrefix(prefix) else { return ("other", nil) }
    let query = Dictionary((URLComponents(string: "x:?" + id.dropFirst(prefix.count))?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
    if query["isPrivate"] == "true" { return ("private", nil) }
    if query["isSyncable"] != "true" { return ("local", nil) }
    return ("group", find(row, depth: 5) { ident($0) == "LibraryItemCellTextField" }.flatMap { text($0, kAXValueAttribute) })
}

// ---------- menus and sheets ----------

func openMenu(_ app: AXUIElement, _ el: AXUIElement) -> AXUIElement? {
    guard perform(el, "AXShowMenu") else { return nil }
    return poll(1500) { shownMenu(app, el) }
}
func shownMenu(_ app: AXUIElement, _ near: AXUIElement?) -> AXUIElement? {
    near.flatMap { find($0, depth: 2) { role($0) == "AXMenu" } } ?? kids(app).first { role($0) == "AXMenu" }
}

// Safari's menus on screen: a context menu is a window of the pop-up menu
// level, and the one sure sign it is still open.
func menuWindows(_ pid: pid_t) -> Int {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == Int(CGWindowLevelForKey(.popUpMenuWindow)) }.count
}

func escape(_ pid: pid_t) {
    let source = CGEventSource(stateID: .privateState)
    for down in [true, false] {
        CGEvent(keyboardEventSource: source, virtualKey: 0x35, keyDown: down)?.postToPid(pid)
        pause(20)
    }
}

// Whether Safari's menu is gone within 500 ms of its dismissal, with one
// more Escape if it is not.
func settled(_ pid: pid_t) -> Bool {
    let gone = { poll(500) { menuWindows(pid) == 0 ? true : nil } != nil }
    if gone() { return true }
    escape(pid)
    return gone()
}

// Ends whatever menu Safari has open: an Escape only while one is, since
// one with none would reach a page.
func endMenu(_ pid: pid_t) -> Bool {
    guard menuWindows(pid) > 0 else { return true }
    escape(pid)
    return settled(pid)
}

func clear(_ req: [String: Any]) throws {
    guard let minIdle = (req["minIdleMs"] as? NSNumber)?.intValue, let front = req["front"] as? String else { throw Failure(message: "an op that opens a menu needs minIdleMs and front") }
    if screenLocked() { throw Failure(message: "the screen is locked") }
    let now = frontApp()
    if now != front || now == SAFARI { throw Failure(message: "the front app changed from \(front) to \(now)") }
    if (idleMs() ?? 0) < minIdle { throw Failure(message: "the user is at the keyboard or mouse") }
}

func sheet(_ w: AXUIElement) -> AXUIElement? { kids(w).first { role($0) == "AXSheet" } }
func button(_ s: AXUIElement, _ title: String) -> AXUIElement? { findAll(s, depth: 4) { role($0) == "AXButton" && text($0, kAXTitleAttribute) == title }.first }

// ---------- one helper at a time ----------

let LOCK_PATH = NSHomeDirectory() + "/.local/share/safari-harness/groups.lock"
var lockFd: Int32 = -1

func lock(_ ms: Int) throws {
    if lockFd >= 0 { return }
    try FileManager.default.createDirectory(atPath: (LOCK_PATH as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let fd = open(LOCK_PATH, O_RDWR | O_CREAT, 0o600)
    guard fd >= 0 else { throw Failure(message: "cannot open \(LOCK_PATH)") }
    guard poll(ms, { flock(fd, LOCK_EX | LOCK_NB) == 0 ? true : nil }) != nil else {
        close(fd)
        throw Failure(message: "another helper held the tab group lock for \(ms / 1000) s")
    }
    lockFd = fd
}

func unlock() {
    guard lockFd >= 0 else { return }
    flock(lockFd, LOCK_UN)
    close(lockFd)
    lockFd = -1
}

// ---------- requests ----------

func handle(_ req: [String: Any]) throws -> [String: Any] {
    let op = req["op"] as? String ?? ""
    switch op {
    case "gate":
        return gate()
    case "find":
        guard let width = (req["width"] as? NSNumber)?.doubleValue, let height = (req["height"] as? NSNumber)?.doubleValue else { throw Failure(message: "find needs width and height") }
        guard let ids = poll(3000, { () -> [CGWindowID]? in
            let ids = try? windowsOfSize(width, height)
            return ids?.count == 1 ? ids : nil
        }) else { throw Failure(message: "Safari has no one window of \(Int(width)) x \(Int(height)) points") }
        return ["window": ids[0]]
    case "dismiss":
        let pid = try safari().pid
        let open = menuWindows(pid) > 0
        var out: [String: Any] = ["menu": open, "closed": endMenu(pid), "sheet": false]
        if req["window"] != nil, let s = sheet(try window(req)), let cancel = button(s, "Cancel") { out["sheet"] = perform(cancel, kAXPressAction) }
        return out
    case "lock":
        try lock((req["ms"] as? NSNumber)?.intValue ?? 60000)
        return [:]
    case "unlock":
        unlock()
        return [:]
    default:
        break
    }

    let app = try safari().el
    let w = try window(req)
    switch op {
    case "state":
        return ["tabs": tabs(w).count, "sidebar": outline(w) != nil, "shown": shownGroup(w) ?? NSNull()]
    case "sidebar":
        let show = req["show"] as? Bool ?? true
        if (outline(w) != nil) != show {
            guard let toggle = find(w, depth: 4, { ident($0) == "SidebarButton" }), perform(toggle, kAXPressAction) else { throw Failure(message: "the window has no sidebar button") }
            guard poll(1500, { (outline(w) != nil) == show ? true : nil }) != nil else { throw Failure(message: "the sidebar did not \(show ? "show" : "hide")") }
        }
        return [:]
    case "rows":
        let o = try requireOutline(w)
        let selected = (attr(o, kAXSelectedRowsAttribute) as? [AXUIElement]) ?? []
        return ["rows": rows(o).map { row -> [String: Any] in
            let d = describeRow(row)
            var r: [String: Any] = ["kind": d.kind, "selected": selected.contains { CFEqual($0, row) }]
            if let name = d.name { r["name"] = name }
            return r
        }]
    case "select":
        let o = try requireOutline(w)
        let all = rows(o)
        guard let index = (req["index"] as? NSNumber)?.intValue, all.indices.contains(index) else { throw Failure(message: "the sidebar has no row \(req["index"] ?? "")") }
        guard AXUIElementSetAttributeValue(o, kAXSelectedRowsAttribute as CFString, [all[index]] as CFArray) == .success else { throw Failure(message: "the row could not be selected") }
        return [:]
    case "menu":
        let o = try requireOutline(w)
        try clear(req)
        guard let menu = openMenu(app, o) else { throw Failure(message: "the sidebar's menu did not open", closed: endMenu(try safari().pid)) }
        return ["items": kids(menu).filter { role($0) == "AXMenuItem" }.map { ["id": ident($0), "title": text($0, kAXTitleAttribute) ?? "", "enabled": (attr($0, kAXEnabledAttribute) as? Bool) ?? false] }]
    case "press":
        let pid = try safari().pid
        guard let menu = shownMenu(app, outline(w)) else { throw Failure(message: "no menu is open", closed: endMenu(pid)) }
        let id = req["id"] as? String, title = req["title"] as? String
        guard let it = kids(menu).first(where: { id != nil ? ident($0) == id : text($0, kAXTitleAttribute) == title }), perform(it, kAXPressAction) else { throw Failure(message: "the open menu has no \(id ?? title ?? "item")", closed: endMenu(pid)) }
        let closed = settled(pid)
        return ["closed": closed, "sheet": poll(1500, { sheet(w) }).map { s -> [String: Any] in
            ["text": findAll(s, depth: 4) { role($0) == "AXStaticText" }.compactMap { text($0, kAXValueAttribute) },
             "buttons": findAll(s, depth: 4) { role($0) == "AXButton" }.compactMap { text($0, kAXTitleAttribute) }]
        } ?? NSNull()]
    case "confirm":
        guard let title = req["button"] as? String, let s = sheet(w) else { throw Failure(message: "no sheet is open") }
        guard let b = button(s, title), perform(b, kAXPressAction) else { throw Failure(message: "the sheet has no \(title) button") }
        guard poll(2000, { sheet(w) == nil ? true : nil }) != nil else { throw Failure(message: "the sheet stayed open") }
        return [:]
    case "name":
        guard let name = req["name"] as? String, !name.isEmpty else { throw Failure(message: "name needs a name") }
        // Safari shows the new group selected in the sidebar, its name field
        // ready.
        guard let (row, field) = poll(2000, { () -> (AXUIElement, AXUIElement)? in
            guard let o = outline(w), let row = (attr(o, kAXSelectedRowsAttribute) as? [AXUIElement])?.first, describeRow(row).kind == "group",
                  let field = find(row, depth: 5, { ident($0) == "LibraryItemCellTextField" }) else { return nil }
            return (row, field)
        }) else { throw Failure(message: "the new tab group did not show in the window's sidebar") }
        guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, name as CFString) == .success, perform(field, "AXConfirm") else { throw Failure(message: "the new tab group's name field took no name") }
        let named = poll(2000, { describeRow(row).name == name ? name : nil }) ?? describeRow(row).name
        return ["named": named.map { $0 as Any } ?? NSNull()]
    case "close":
        guard let b = find(w, depth: 1, { text($0, kAXSubroleAttribute) == "AXCloseButton" }), perform(b, kAXPressAction) else { throw Failure(message: "the window has no close button") }
        return [:]
    default:
        throw Failure(message: "unknown op \(op)")
    }
}

func answer(_ req: [String: Any]) -> [String: Any] {
    do {
        return ["ok": true].merging(try handle(req)) { a, _ in a }
    } catch let f as Failure {
        return ["ok": false, "error": f.message].merging(f.closed.map { ["closed": $0] } ?? [:]) { a, _ in a }
    } catch {
        return ["ok": false, "error": String(describing: error)]
    }
}

func write(_ value: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])) ?? Data(#"{"ok":false,"error":"cannot encode the answer"}"#.utf8)
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func parse(_ line: String) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] }

let argv = CommandLine.arguments
switch argv.count > 1 ? argv[1] : "" {
case "serve":
    signal(SIGPIPE, SIG_IGN)
    while let line = readLine() {
        write(parse(line).map(answer) ?? ["ok": false, "error": "a request is one JSON object per line"])
    }
case "", "-h", "--help":
    FileHandle.standardError.write(Data("usage: spaces serve | spaces OP ['<json>']\n".utf8))
    exit(2)
default:
    guard var req = argv.count > 2 ? parse(argv[2]) : [:] else {
        FileHandle.standardError.write(Data("the request must be a JSON object\n".utf8))
        exit(2)
    }
    req["op"] = argv[1]
    let out = answer(req)
    write(out)
    exit(out["ok"] as? Bool == true ? 0 : 1)
}
