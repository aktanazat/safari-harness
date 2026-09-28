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
// Each command prints one JSON line. code needs Accessibility permission for
// the app that runs this.
import ApplicationServices
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

let argv = Array(CommandLine.arguments.dropFirst())
let rest = Array(argv.dropFirst())
switch argv.first {
case "approve": approve(rest)
case "code": code(rest)
default: fail("usage: pairing approve REASON | code --pid N [--wait MS]", 2)
}
