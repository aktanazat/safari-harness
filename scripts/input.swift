// Real mouse and keyboard input for daemon/input.ts. Events go in at the HID
// level, like a physical mouse and keyboard, so pages see event.isTrusted
// true; the extension's scripted events are ignored by captcha checkboxes,
// some drag handles, and sites that check isTrusted.
//   input webarea                 Safari's page viewport in its front window:
//                                 {"x","y","width","height"}
//   input click X Y [--count N] [--button left|right]
//   input move X Y
//   input drag X1 Y1 X2 Y2
//   input type TEXT
//   input key SPEC                Enter, Tab, Escape, Backspace, ArrowUp, cmd+a, shift+Tab
//   input front                   {"bundleId"} of the frontmost app
//   input activate BUNDLEID       brings that app to the front
// Points are global screen points with the origin at the top-left of the main
// display, the space of both the Accessibility API and CGEvent. Each command
// prints one JSON line. click, type, and key end with a press of F20 (see
// mark). All but front and activate need Accessibility permission for the
// app that runs this.
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

// Types text one character at a time, each as the character itself. Line
// breaks press Return and tabs press Tab.
func typeText(_ args: [String]) {
    guard args.count == 1 else { fail("usage: input type TEXT", 2) }
    requireAccess()
    for ch in args[0] {
        switch ch {
        case "\n", "\r", "\r\n": press(36, [])
        case "\t": press(48, [])
        default: press(0, [], text: Array(String(ch).utf16))
        }
        pause(10)
    }
    mark()
    printJSON(["typed": args[0].count])
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
    requireAccess()
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

let argv = Array(CommandLine.arguments.dropFirst())
let rest = Array(argv.dropFirst())
switch argv.first {
case "webarea": webarea()
case "click": click(rest)
case "move": move(rest)
case "drag": drag(rest)
case "type": typeText(rest)
case "key": keyCombo(rest)
case "front": front()
case "activate": activate(rest)
default: fail("usage: input webarea | click X Y [--count N] [--button left|right] | move X Y | drag X1 Y1 X2 Y2 | type TEXT | key SPEC | front | activate BUNDLEID", 2)
}
