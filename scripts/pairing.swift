// Pairing Apple Passwords with one touch, for daemon/fill.ts: the user
// approves with Touch ID, and the 6-digit code the Mac shows is read off the
// window of Apple's password helper, so nobody reads it out.
//   pairing approve REASON        Touch ID, or the login password where there
//                                 is no sensor: {"approved"}, and {"why"} when
//                                 the user declines. Exits 1 when no prompt
//                                 could be shown or the system took it down.
//                                 REASON finishes "<app> is trying to ..."
//   pairing code --pid N [--wait MS]
//                                 the code process N's window shows, waiting
//                                 up to MS (default 5000) for it: {"code"}
//   pairing confirm --pid N --site HOST [--wait MS]
//                                 presses the default button of process N's
//                                 window asking to save a password for HOST,
//                                 waiting up to MS (default 5000) for it:
//                                 {"pressed": the button's title}
//   pairing qr < PNG              the text of every QR code in the image on
//                                 stdin: {"found": [...]}. The daemon reads
//                                 an authenticator key this way, so the
//                                 image never lands on disk.
// Each command prints one JSON line. code and confirm need Accessibility
// permission for the app that runs this.
import ApplicationServices
import CoreImage
import Foundation
import LocalAuthentication

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

func attribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

// ---------- approve ----------

func approve(_ args: [String]) {
    guard let reason = args.first, !reason.isEmpty else { fail("usage: pairing approve REASON", 2) }
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        fail("this Mac cannot ask for Touch ID or the login password: \(error?.localizedDescription ?? "no reason given")")
    }
    let answered = DispatchSemaphore(value: 0)
    var approved = false
    var failure: Error?
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
        approved = ok
        failure = err
        answered.signal()
    }
    answered.wait()
    if approved { return printJSON(["approved": true]) }
    // Cancelling, or failing to prove who they are, is the user's answer.
    if let e = failure as? LAError, e.code == .userCancel || e.code == .authenticationFailed {
        return printJSON(["approved": false, "why": e.localizedDescription])
    }
    fail("the Mac did not finish asking: \(failure?.localizedDescription ?? "no reason given")")
}

// ---------- code ----------

// Every string an element and the elements inside it show.
func texts(_ el: AXUIElement, depth: Int = 0) -> [String] {
    let own = [kAXValueAttribute, kAXTitleAttribute].compactMap { attribute(el, $0) as? String }
    guard depth < 8, let children = attribute(el, kAXChildrenAttribute) as? [AXUIElement] else { return own }
    return own + children.flatMap { texts($0, depth: depth + 1) }
}

// The helper shows the code spaced out, "1 2 3   4 5 6", and nothing else of
// six digits. The window title is not matched: it is translated.
func code(_ args: [String]) {
    requireAccess()
    guard let raw = option(args, "--pid"), let pid = pid_t(raw), pid > 1 else { fail("usage: pairing code --pid N [--wait MS]", 2) }
    let wait = Double(option(args, "--wait") ?? "5000") ?? 5000
    let app = AXUIElementCreateApplication(pid)
    let deadline = Date().addingTimeInterval(wait / 1000)
    repeat {
        for window in attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
            let digits = texts(window)
                .filter { !$0.isEmpty && $0.allSatisfy { ($0.isASCII && $0.isNumber) || $0 == " " } }
                .map { $0.filter { $0 != " " } }
            if let found = digits.first(where: { $0.count == 6 }) {
                printJSON(["code": found])
                exit(0)
            }
        }
        usleep(100_000)
    } while Date() < deadline
    fail("no pairing code showed in a window of process \(pid)")
}

// ---------- confirm ----------

// Words the texts put in curly quotes: the helper names the login and the
// site that way, “user” on “site”.
func quoted(_ texts: [String]) -> [String] {
    texts.flatMap { text in
        text.split(separator: "“").dropFirst().compactMap { part in part.split(separator: "”", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) }
    }
}

// A save the harness makes (MAYBE_ADD) waits on the helper's own "update
// the password saved for ... ?" window, which answers nothing until a
// button is pressed. Only a window naming HOST, or a domain HOST is under,
// is pressed, and only its default button (Update Password or Save), found
// by role, not by its translated title.
func confirm(_ args: [String]) {
    requireAccess()
    guard let raw = option(args, "--pid"), let pid = pid_t(raw), pid > 1, let host = option(args, "--site"), !host.isEmpty else {
        fail("usage: pairing confirm --pid N --site HOST [--wait MS]", 2)
    }
    let wait = Double(option(args, "--wait") ?? "5000") ?? 5000
    let app = AXUIElementCreateApplication(pid)
    let deadline = Date().addingTimeInterval(wait / 1000)
    // what the helper's windows named, for the error when none is HOST's
    var seen: [String] = []
    repeat {
        seen = []
        for window in attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
            let named = quoted(texts(window))
            seen += named
            guard named.contains(where: { host == $0 || host.hasSuffix("." + $0) }) else { continue }
            guard let found = attribute(window, kAXDefaultButtonAttribute), CFGetTypeID(found) == AXUIElementGetTypeID() else {
                fail("the helper's window for \(host) has no default button")
            }
            let button = found as! AXUIElement
            let title = attribute(button, kAXTitleAttribute) as? String ?? ""
            guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { fail("could not press \(title) in the helper's window") }
            printJSON(["pressed": title])
            exit(0)
        }
        usleep(100_000)
    } while Date() < deadline
    fail("no window asking to save a password for \(host) showed in process \(pid)" + (seen.isEmpty ? "" : "; its windows named \(seen.joined(separator: ", "))"))
}

// ---------- qr ----------

func qr() {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let image = CIImage(data: data) else { fail("stdin is not an image") }
    guard let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]) else { fail("this Mac cannot read QR codes") }
    let found = detector.features(in: image).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
    printJSON(["found": found])
}

let argv = Array(CommandLine.arguments.dropFirst())
let rest = Array(argv.dropFirst())
switch argv.first {
case "approve": approve(rest)
case "code": code(rest)
case "confirm": confirm(rest)
case "qr": qr()
default: fail("usage: pairing approve REASON | code --pid N [--wait MS] | confirm --pid N --site HOST [--wait MS] | qr < PNG", 2)
}
