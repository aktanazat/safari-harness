// Real mouse and keyboard input for daemon/input.ts. Events go in at the HID
// level, like a physical mouse and keyboard, so pages see event.isTrusted
// true; the extension's scripted events are ignored by captcha checkboxes,
// some drag handles, and sites that check isTrusted. press and setvalue
// have Safari's accessibility tree click an element or set a field's text
// instead, which reaches a window behind other apps.
//   input webarea                 Safari's page viewport in its front window:
//                                 {"x","y","width","height"}
//   input press MARK W H          presses the element marked MARK in the
//                                 Safari window of that size, from behind
//   input setvalue [--append] MARK W H
//                                 sets the text of the field marked MARK to
//                                 UTF-8 text on stdin, or after its own with
//                                 --append, from behind
//   input click X Y [--count N] [--button left|right]
//   input move X Y
//   input drag X1 Y1 X2 Y2
//   input type [--gap MS]         UTF-8 text on stdin, through EOF
//   input key SPEC                Enter, Tab, Escape, Backspace, ArrowUp, cmd+a, shift+Tab
//   input idle MS MAX             waits until the user has let go of keys and
//                                 buttons for MS, MAX at most: {"idle"}
//   input front                   {"bundleId"} of the frontmost app
//   input activate BUNDLEID       brings that app to the front
//   input window W H              Safari's window of that size, the screen
//                                 holding most of it, and the main display's
//                                 free part: {"window","screen","visible"}
// Points are global screen points with the origin at the top-left of the main
// display, the space of both the Accessibility API and CGEvent. Each command
// prints one JSON line. click, type, and key end with a press of F20 (see
// mark). All but idle, front, activate, and window need Accessibility
// permission for the app that runs this.
import AppKit
import ApplicationServices

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

func printJSON(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]) else { fail("cannot encode result") }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

// Value following `name` in the arguments, if present.
func option(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func requireAccess() {
    if !AXIsProcessTrusted() { fail("this app needs Accessibility permission: System Settings > Privacy & Security > Accessibility") }
}

func pause(_ ms: UInt32) {
    usleep(ms * 1000)
}

func point(_ x: String, _ y: String) -> CGPoint {
    guard let px = Double(x), let py = Double(y), px.isFinite, py.isFinite else { fail("not a point: \(x) \(y)", 2) }
    return CGPoint(x: px, y: py)
}

// The system pins the pointer to the screens, so an event off every screen
// would land at the nearest edge instead.
func requireOnScreen(_ p: CGPoint) {
    var count: UInt32 = 0
    CGGetDisplaysWithPoint(p, 0, nil, &count)
    if count == 0 { fail("\(p.x),\(p.y) is not on any screen") }
}

// ---------- mouse ----------

let source = CGEventSource(stateID: .hidSystemState)

// Posts one mouse event without modifier flags, so a key the user happens to
// hold does not turn a click into a Cmd-click.
func mouse(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton = .left, clickState: Int64 = 1) {
    guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: button) else { fail("cannot create a mouse event") }
    e.flags = []
    e.setIntegerValueField(.mouseEventClickState, value: clickState)
    e.post(tap: .cghidEventTap)
}

// Moves to the point and clicks count times (2 is a double click), then puts
// the pointer back where it was.
func click(_ args: [String]) {
    guard args.count >= 2 else { fail("usage: input click X Y [--count N] [--button left|right]", 2) }
    let at = point(args[0], args[1])
    guard let count = Int64(option(args, "--count") ?? "1"), (1...3).contains(count) else { fail("--count must be 1, 2, or 3", 2) }
    let button = option(args, "--button") ?? "left"
    guard button == "left" || button == "right" else { fail("--button must be left or right", 2) }
    requireAccess()
    requireOnScreen(at)
    let right = button == "right"
    let home = CGEvent(source: nil)?.location
    mouse(.mouseMoved, at)
    pause(50)
    for n in 1...count {
        mouse(right ? .rightMouseDown : .leftMouseDown, at, right ? .right : .left, clickState: n)
        pause(40)
        mouse(right ? .rightMouseUp : .leftMouseUp, at, right ? .right : .left, clickState: n)
        pause(40)
    }
    if let home { mouse(.mouseMoved, home) }
    mark()
    printJSON(["x": at.x, "y": at.y])
}

func move(_ args: [String]) {
    guard args.count >= 2 else { fail("usage: input move X Y", 2) }
    let at = point(args[0], args[1])
    requireAccess()
    requireOnScreen(at)
    mouse(.mouseMoved, at)
    printJSON(["x": at.x, "y": at.y])
}

// Presses at the start, moves to the end in small steps with the button held,
// and lets go there, the way sliders and drag handles expect.
func drag(_ args: [String]) {
    guard args.count >= 4 else { fail("usage: input drag X1 Y1 X2 Y2", 2) }
    let from = point(args[0], args[1])
    let to = point(args[2], args[3])
    requireAccess()
    requireOnScreen(from)
    requireOnScreen(to)
    let home = CGEvent(source: nil)?.location
    mouse(.mouseMoved, from)
    pause(50)
    mouse(.leftMouseDown, from)
    pause(60)
    let steps = 15
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
        pause(16)
    }
    pause(50)
    mouse(.leftMouseUp, to)
    pause(40)
    if let home { mouse(.mouseMoved, home) }
    printJSON(["from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y]])
}

// ---------- keyboard ----------

struct Modifier {
    let flag: CGEventFlags
    let code: CGKeyCode
}

let shiftKey = Modifier(flag: .maskShift, code: 56)
let modifierKeys: [String: Modifier] = [
    "cmd": Modifier(flag: .maskCommand, code: 55), "command": Modifier(flag: .maskCommand, code: 55), "meta": Modifier(flag: .maskCommand, code: 55),
    "shift": shiftKey,
    "option": Modifier(flag: .maskAlternate, code: 58), "opt": Modifier(flag: .maskAlternate, code: 58), "alt": Modifier(flag: .maskAlternate, code: 58),
    "ctrl": Modifier(flag: .maskControl, code: 59), "control": Modifier(flag: .maskControl, code: 59),
]

// Key codes by lowercased KeyboardEvent.key name, plus short aliases.
let namedKeys: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "esc": 53, "delete": 117,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "arrowleft": 123, "left": 123, "arrowright": 124, "right": 124, "arrowdown": 125, "down": 125, "arrowup": 126, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

// Key codes of the character keys on the US layout, and the characters those
// keys type with Shift.
let charKeys: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
]
let shiftedChars: [Character: Character] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
]

// Posts one key event. text, when given, is what the key types, so the
// result does not depend on the keyboard layout.
func key(_ code: CGKeyCode, down: Bool, flags: CGEventFlags, text: [UniChar] = []) {
    guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { fail("cannot create a key event") }
    e.flags = flags
    if !text.isEmpty { e.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text) }
    e.post(tap: .cghidEventTap)
}

// Presses and releases a key with modifiers held. The modifier keys go down
// first and come up last, as on a keyboard, for pages that watch them.
func press(_ code: CGKeyCode, _ mods: [Modifier], text: [UniChar] = []) {
    var flags: CGEventFlags = []
    for m in mods {
        flags.insert(m.flag)
        key(m.code, down: true, flags: flags)
        pause(10)
    }
    key(code, down: true, flags: flags, text: text)
    pause(10)
    key(code, down: false, flags: flags, text: text)
    for m in mods.reversed() {
        pause(10)
        flags.remove(m.flag)
        key(m.code, down: false, flags: flags)
    }
}

// Ends click, type, and key: a press of F20, a key no Mac keyboard has.
// Safari hands input events to a page in the order they were posted, so a
// page that has seen this press has seen everything before it. daemon/input.ts
// waits for it before it gives the user's tab back. It carries the character
// AppKit gives F20 (NSF20FunctionKey), which types nothing; the layout's
// own character for the key would type U+0010 into a text field.
func mark() {
    press(90, [], text: [0xF717])
}

// The US-layout key that types ch, with Shift when ch needs it; key 0 for a
// character no key types. The event still carries ch itself, so what lands
// in the field does not depend on the layout; the key code is for pages that
// read event.code or keyCode, as key named alone already sends (keyCombo).
func keyFor(_ ch: Character) -> (CGKeyCode, [Modifier]) {
    if let c = charKeys[ch] { return (c, []) }
    if ch.isUppercase, let lower = ch.lowercased().first, let c = charKeys[lower] { return (c, [shiftKey]) }
    if let base = shiftedChars[ch], let c = charKeys[base] { return (c, [shiftKey]) }
    return (0, [])
}

// Where keys go: Safari, and the window it had in front when the command
// began. A key goes to the app and window in front when it arrives, not
// when it was posted, so a user who brings another app or window forward
// while text is typed would get the rest of it. On 10-07 a reply typed into
// a Philips support chat went on after the user went back to his terminal;
// a test of 120 letters with TextEdit brought forward after 2 s then put 25
// in the field, 57 in TextEdit, and 38 elsewhere in Safari, and the call
// answered ok.
struct KeyTarget {
    let safari: AXUIElement
    let pid: pid_t
    let window: AXUIElement?
}

// Safari and its window in front; fails, sending nothing, when they are not.
func keyTarget() -> KeyTarget {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else { fail("Safari is not running") }
    let safari = AXUIElementCreateApplication(app.processIdentifier)
    // Safari answers on its main thread, which a busy page can hold.
    AXUIElementSetMessagingTimeout(safari, 1)
    let target = KeyTarget(safari: safari, pid: app.processIdentifier, window: element(attribute(safari, kAXFocusedWindowAttribute)))
    if let other = inFrontInstead(of: target) { fail("Safari is not the app in front (\(other) is), so no keys were sent") }
    return target
}

// What is in front in place of the target, by name; nil while it still
// is. The app in front is NSWorkspace's, which follows changes only while
// the run loop runs; the system-wide focused application failed every read
// here (AXError -25204, 10-07). A panel or popover of Safari's (an AutoFill
// list) stays with the window that opened it, and a Safari that does not
// answer in time is still the app in front.
func inFrontInstead(of t: KeyTarget) -> String? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return "no app" }
    if app.processIdentifier != t.pid { return app.localizedName ?? app.bundleIdentifier ?? "another app" }
    guard let was = t.window, let now = element(attribute(t.safari, kAXFocusedWindowAttribute)), !CFEqual(was, now) else { return nil }
    return attribute(now, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole ? "another Safari window" : nil
}

// Types text one character at a time, each as the character itself. Line
// breaks press Return and tabs press Tab. Characters go 40 ms apart unless
// --gap says otherwise: a page that reformats a field after each key (a
// card-number mask) moved the caret back while the next key was on its
// way, and a card number landed with its first digit last (2026-09-29).
// daemon/input.ts types faster where it checks the field after and types
// again at 40 ms when the text came out wrong. Each goes only while the
// key target is in front; typing stops at the first that is not.
func typeText(_ args: [String]) {
    let gap = option(args, "--gap").flatMap(Double.init)
    guard args.isEmpty || (args.count == 2 && gap.map { $0 >= 0 && $0 <= 1000 } == true) else { fail("usage: input type [--gap MS] (UTF-8 text on stdin)", 2) }
    // Card fills use this path too: arguments expose the text to other
    // processes, so accept it only on stdin (09-30).
    guard let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) else {
        fail("type needs UTF-8 text on stdin", 2)
    }
    requireAccess()
    let target = keyTarget()
    var typed = 0
    for ch in text {
        if let other = inFrontInstead(of: target) {
            fail("typing stopped after \(typed) of \(text.count) characters: \(other) came in front, so the rest was not sent. Let the user finish before typing again; typing at a ref replaces the field")
        }
        switch ch {
        case "\n", "\r", "\r\n": press(36, [])
        case "\t": press(48, [])
        default:
            let (code, mods) = keyFor(ch)
            press(code, mods, text: Array(String(ch).utf16))
        }
        typed += 1
        RunLoop.current.run(until: Date(timeIntervalSinceNow: (gap ?? 40) / 1000))
    }
    mark()
    printJSON(["typed": text.count])
}

// A key or combo: "Enter", "/", "?", "A", "cmd+shift+z", "Cmd+K". Inside a
// combo a letter names its key in either case; alone, "A" types a capital.
// A trailing "+" is the plus key.
func keyCombo(_ args: [String]) {
    guard args.count == 1, !args[0].isEmpty else { fail("usage: input key SPEC (Enter, Tab, cmd+a, shift+Tab)", 2) }
    let spec = args[0]
    let plus = spec.hasSuffix("+")
    var parts = (plus ? String(spec.dropLast()) : spec).split(separator: "+").map { String($0) }
    let name = plus ? "+" : (parts.popLast() ?? "")
    var mods: [Modifier] = []
    for p in parts {
        guard let m = modifierKeys[p.lowercased()] else { fail("unknown modifier \(p): use cmd, shift, option, or ctrl", 2) }
        if !mods.contains(where: { $0.code == m.code }) { mods.append(m) }
    }
    // On 09-28 an agent pressed "Shift" alone and read "unknown key Shift".
    if modifierKeys[name.lowercased()] != nil { fail("\(name) is a modifier, which presses nothing alone: name it with its key, like \(name.lowercased())+A", 2) }
    requireAccess()
    _ = keyTarget()
    if let code = namedKeys[name.lowercased()] {
        press(code, mods)
        mark()
        printJSON(["key": spec])
        return
    }
    guard name.count == 1, let ch = name.first else { fail("unknown key \(name)", 2) }
    // A key named alone types its own character, whatever the layout. In a
    // combo the key goes by position, as the layout maps the user's own
    // shortcuts.
    let alone = mods.isEmpty
    var code: CGKeyCode = 0
    if let c = charKeys[ch] {
        code = c
    } else if ch.isUppercase, let lower = ch.lowercased().first, let c = charKeys[lower] {
        code = c
        if alone { mods = [shiftKey] }
    } else if let base = shiftedChars[ch], let c = charKeys[base] {
        code = c
        if !mods.contains(where: { $0.code == shiftKey.code }) { mods.insert(shiftKey, at: 0) }
    } else if !alone {
        fail("unknown key \(name) in a combo", 2)
    }
    press(code, mods, text: alone ? Array(String(ch).utf16) : [])
    mark()
    printJSON(["key": spec])
}

// Waits until the user has let go of every key and mouse button for MS
// milliseconds, MAX at most. Real input lands on whatever is in front, so
// Safari comes forward only once he pauses: on 10-07 it came in front about
// 30 times in 30 minutes while he typed in his terminal. Key-ups count, not
// key-downs: here something posts a held key's repeats (key 145, about 60
// a second) and never its key-up, so the last key-down was always now
// (10-07). Needs no permission. Prints {"idle": true|false, "waitedMs"}.
func idle(_ args: [String]) {
    guard args.count == 2, let quiet = Double(args[0]), let most = Double(args[1]), quiet > 0, most >= 0 else { fail("usage: input idle MS MAX", 2) }
    let start = Date()
    let events: [CGEventType] = [.keyUp, .leftMouseUp, .rightMouseUp]
    while true {
        let since = events.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min()! * 1000
        let waited = Date().timeIntervalSince(start) * 1000
        if since >= quiet || waited >= most { return printJSON(["idle": since >= quiet, "waitedMs": Int(waited)]) }
        usleep(useconds_t(min(quiet - since, most - waited, 100) * 1000))
    }
}

// ---------- apps ----------

func front() {
    printJSON(["bundleId": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""])
}

// Activates the app and waits up to two seconds until it is frontmost.
// NSWorkspace hears of the change through the run loop, so it turns while
// this waits.
func activate(_ args: [String]) {
    guard args.count == 1 else { fail("usage: input activate BUNDLEID", 2) }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: args[0]).first else { fail("\(args[0]) is not running") }
    app.activate()
    for _ in 0..<100 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
            printJSON(["bundleId": args[0]])
            return
        }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    fail("\(args[0]) did not come to the front")
}

// ---------- window ----------

func rectJSON(_ r: CGRect) -> [String: Any] {
    ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
}

// AppKit counts screen rects up from the bottom of the main display.
func topDown(_ r: NSRect) -> CGRect {
    CGRect(x: r.minX, y: NSScreen.screens[0].frame.maxY - r.maxY, width: r.width, height: r.height)
}

// Where Safari's window of W by H points is (an agent window's size is its
// own, daemon/spaces.ts): its frame; the screen holding most of it, from
// whose top-left Safari's windows.update counts a window's left and top;
// and the part of the main display the menu bar and Dock leave free.
// Safari keeps small windows at the same level, a link's status bar among
// them, so the size picks the window; of two that share it, the one in
// front. Window bounds and screens need no permission.
func window(_ args: [String]) {
    guard args.count == 2, let w = Double(args[0]), let h = Double(args[1]) else { fail("usage: input window W H", 2) }
    guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else { fail("Safari is not running") }
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    let found = list.lazy.compactMap { info -> CGRect? in
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == safari.processIdentifier,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              abs(r.width - w) < 1, abs(r.height - h) < 1 else { return nil }
        return r
    }.first
    guard let frame = found else { fail("no Safari window of \(args[0]) by \(args[1]) is on screen") }
    let share = { (s: CGRect) -> CGFloat in s.intersection(frame).width * s.intersection(frame).height }
    let screen = NSScreen.screens.map { topDown($0.frame) }.max { share($0) < share($1) }!
    printJSON(["window": rectJSON(frame), "screen": rectJSON(screen), "visible": rectJSON(topDown(NSScreen.screens[0].visibleFrame))])
}

// ---------- webarea ----------

func attribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let p = attribute(el, kAXPositionAttribute), let s = attribute(el, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: origin, size: size)
}

// The web areas under el, without looking inside one (a page's frames are
// web areas too). A window holds only the web area of the tab it shows.
func webAreas(_ el: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    if attribute(el, kAXRoleAttribute) as? String == "AXWebArea" { return [el] }
    guard depth < 12, let kids = attribute(el, kAXChildrenAttribute) as? [AXUIElement] else { return [] }
    return kids.flatMap { webAreas($0, depth: depth + 1) }
}

// A web area spans the whole document and moves as the page scrolls; the
// scroll area around it is the part on screen.
func viewport(_ area: AXUIElement) -> CGRect? {
    if let parent = element(attribute(area, kAXParentAttribute)), attribute(parent, kAXRoleAttribute) as? String == "AXScrollArea" {
        return frame(parent)
    }
    return frame(area)
}

// Safari's front window and the largest page viewport in it whose middle is
// on a screen, in global screen points. (CGGetDisplaysWithRect would need a
// window server connection this tool never opens; the point query does not.)
func webarea() {
    requireAccess()
    guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else { fail("Safari is not running") }
    let app = AXUIElementCreateApplication(safari.processIdentifier)
    guard let window = element(attribute(app, kAXFocusedWindowAttribute)) ?? element(attribute(app, kAXMainWindowAttribute)) else { fail("Safari has no open window") }
    let shown = webAreas(window).compactMap(viewport).filter { r in
        var count: UInt32 = 0
        CGGetDisplaysWithPoint(CGPoint(x: r.midX, y: r.midY), 0, nil, &count)
        return count > 0 && r.width > 0 && r.height > 0
    }
    guard let best = shown.max(by: { $0.width * $0.height < $1.width * $1.height }) else { fail("no web page is showing in Safari's front window") }
    printJSON(["x": best.minX, "y": best.minY, "width": best.width, "height": best.height])
}

// ---------- press ----------

// Safari's windows of this size, which a page reads as its outerWidth and
// outerHeight. Its screenY does not place its window: on a display other
// than the main one it counts from that display's top (30 for a window at
// -1410). An agent window's size is its own (daemon/spaces.ts); two of
// the user's windows may share one, and the mark tells their pages apart.
func windowsOfSize(_ app: AXUIElement, _ width: Double, _ height: Double) -> [AXUIElement] {
    let all = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    return all.filter { w in
        guard let f = frame(w) else { return false }
        return abs(f.width - width) < 1 && abs(f.height - height) < 1
    }
}

// The node at or under el whose element has the class mark. The whole tree
// is searched: a node's frame need not hold its children's, so a search
// that went only into frames holding the element missed 73 of 104 links on
// Hacker News. Both attributes come in one request, which halves the trips
// to Safari on a page of thousands of nodes.
func markedNode(_ el: AXUIElement, _ mark: String, depth: Int = 0) -> AXUIElement? {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(el, ["AXDOMClassList", kAXChildrenAttribute] as CFArray, [], &values) == .success,
          let pair = values as? [Any], pair.count == 2 else { return nil }
    if let classes = pair[0] as? [String], classes.contains(mark) { return el }
    guard depth < 200, let kids = pair[1] as? [AXUIElement] else { return nil }
    for k in kids {
        if let hit = markedNode(k, mark, depth: depth + 1) { return hit }
    }
    return nil
}

// The node of the element a page marked with the class args[0] (pressMark
// and typeMark in extension/content.js), in Safari's windows of args[1] by
// args[2] points. Where there is none, prints {key: false, "why"} and ends:
// no such window, or the element is not in the tree (a canvas, a label).
func markedElement(_ args: [String], usage: String, key: String) -> AXUIElement {
    guard args.count == 3, let w = Double(args[1]), let h = Double(args[2]) else { fail("usage: input \(usage)", 2) }
    requireAccess()
    guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else { fail("Safari is not running") }
    let windows = windowsOfSize(AXUIElementCreateApplication(safari.processIdentifier), w, h)
    if windows.isEmpty {
        printJSON([key: false, "why": "no Safari window is \(args[1]) by \(args[2])"])
        exit(0)
    }
    guard let node = windows.flatMap({ webAreas($0) }).lazy.compactMap({ markedNode($0, args[0]) }).first else {
        printJSON([key: false, "why": "the element is not in Safari's accessibility tree"])
        exit(0)
    }
    return node
}

// Presses the marked element (pressMark in extension/content.js) through
// Safari's accessibility tree. WebKit clicks the element's middle for it:
// mousedown, mouseup, and click, each isTrusted, with no pointer events.
// Safari, its windows, and the pointer stay where they are, in a window
// hidden behind another app's too. Prints {"pressed": true}, or
// {"pressed": false, "why"} when no press was made: no element (see
// markedElement), or WebKit offers it no press, which would report
// success and click nothing.
func press(_ args: [String]) {
    let node = markedElement(args, usage: "press MARK W H", key: "pressed")
    var names: CFArray?
    guard AXUIElementCopyActionNames(node, &names) == .success, (names as? [String])?.contains(kAXPressAction) == true else {
        return printJSON(["pressed": false, "why": "Safari offers no press on the element"])
    }
    let err = AXUIElementPerformAction(node, kAXPressAction as CFString)
    if err != .success { fail("the press did not go through: AXError \(err.rawValue)") }
    printJSON(["pressed": true])
}

// Sets the text of the marked field (typeMark in extension/content.js)
// through Safari's accessibility tree, in place of what it held; the text
// comes on stdin, as type's does. The page hears trusted beforeinput and
// input events, as from typing (deleteContent, then insertText), and
// macOS never autocorrects it. Safari, its windows, and the keyboard stay
// as they are. WebKit takes the value only into the element the page has
// focused, which typeMark does; the field's AXFocused is never set, since
// that brings Safari to the front (10-07). --append sets the field's own
// text with the text after it. Prints {"set": true}, or {"set": false,
// "why"} when nothing was set.
func setValue(_ args: [String]) {
    let append = args.first == "--append"
    guard let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) else {
        fail("setvalue needs UTF-8 text on stdin", 2)
    }
    let node = markedElement(Array(args.dropFirst(append ? 1 : 0)), usage: "setvalue [--append] MARK W H (UTF-8 text on stdin)", key: "set")
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
        return printJSON(["set": false, "why": "Safari does not let the field's text be set"])
    }
    var held: CFTypeRef?
    if append && (AXUIElementCopyAttributeValue(node, kAXValueAttribute as CFString, &held) != .success || !(held is String)) {
        return printJSON(["set": false, "why": "Safari did not say what the field holds"])
    }
    let err = AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, ((held as? String ?? "") + text) as CFString)
    if err != .success { return printJSON(["set": false, "why": "AXError \(err.rawValue)"]) }
    printJSON(["set": true])
}

let argv = Array(CommandLine.arguments.dropFirst())
let rest = Array(argv.dropFirst())
switch argv.first {
case "webarea": webarea()
case "press": press(rest)
case "setvalue": setValue(rest)
case "click": click(rest)
case "move": move(rest)
case "drag": drag(rest)
case "type": typeText(rest)
case "key": keyCombo(rest)
case "idle": idle(rest)
case "front": front()
case "activate": activate(rest)
case "window": window(rest)
default: fail("usage: input webarea | press MARK W H | setvalue [--append] MARK W H (text on stdin) | click X Y [--count N] [--button left|right] | move X Y | drag X1 Y1 X2 Y2 | type [--gap MS] (UTF-8 text on stdin) | key SPEC | idle MS MAX | front | activate BUNDLEID | window W H", 2)
}
