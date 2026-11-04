// Messages attachment download buttons and Finder-style file clipboard writes.
// fetch reads {guid, at, conversation, files:[{id,name,wanted}]} from stdin.
// It requests downloads; daemon/imessage.ts confirms their files in chat.db.
import AppKit
import ApplicationServices
import Foundation

struct Attachment: Decodable {
    let id: String
    let name: String
    let wanted: Bool
}
struct Request: Decodable {
    let guid: String
    let at: Double
    let conversation: [String]
    let files: [Attachment]
}
struct Failure: Error { let message: String }

func printJSON(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    } catch {
        FileHandle.standardError.write(Data("cannot encode attachment result\n".utf8))
        exit(1)
    }
}
func attribute(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}
func normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
}
func sameConversation(_ title: String, _ names: [String]) -> Bool {
    names.contains { name in
        if normalized(title) == normalized(name) { return true }
        let digits = name.filter(\.isNumber)
        return digits.count >= 10 && title.filter(\.isNumber).suffix(10) == digits.suffix(10)
    }
}
func messages() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.MobileSMS").first
}
func openMessage(_ guid: String) throws {
    guard UUID(uuidString: guid) != nil else { throw Failure(message: "invalid message guid") }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-g", "messages://open?message-guid=\(guid)"]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw Failure(message: "Messages could not open the attachment's conversation") }
}
struct Balloon {
    let element: AXUIElement
    let description: String
    let y: CGFloat
}
func balloons(_ el: AXUIElement, _ time: String, depth: Int = 0, into result: inout [Balloon]) {
    guard depth < 40 else { return }
    if attribute(el, kAXRoleAttribute) as? String == kAXButtonRole,
       attribute(el, kAXIdentifierAttribute) as? String == "Sticker" {
        let description = attribute(el, kAXDescriptionAttribute) as? String ?? ""
        if normalized(description).hasSuffix(", " + time),
           let position = attribute(el, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID() {
            var point = CGPoint.zero
            AXValueGetValue(position as! AXValue, .cgPoint, &point)
            if !result.contains(where: { CFEqual($0.element, el) }) {
                result.append(Balloon(element: el, description: description, y: point.y))
            }
        }
        return
    }
    for child in attribute(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        balloons(child, time, depth: depth + 1, into: &result)
    }
}
func fetch(_ request: Request) {
    guard AXIsProcessTrusted() else {
        return printJSON(["error": "this app needs Accessibility permission in System Settings > Privacy & Security > Accessibility"])
    }
    let wasRunning = messages() != nil
    var result: [String: Any] = [:]
    defer {
        if !wasRunning, let app = messages() { result["launched"] = app.processIdentifier }
        printJSON(result)
    }
    do {
        try openMessage(request.guid)
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        let time = normalized(formatter.string(from: Date(timeIntervalSince1970: request.at)))
        let nameCounts = request.files.reduce(into: [String: Int]()) { $0[$1.name, default: 0] += 1 }
        let start = Date()
        let deadline = start.addingTimeInterval(10)
        var reopened = false
        var nextScroll = start.addingTimeInterval(1)
        var pages = 0
        repeat {
            // Pump AppKit's running-application cache as Messages starts.
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
            if let running = messages() {
                let app = AXUIElementCreateApplication(running.processIdentifier)
                AXUIElementSetMessagingTimeout(app, 1)
                for window in attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
                    let title = attribute(window, kAXTitleAttribute) as? String ?? ""
                    guard sameConversation(title, request.conversation) else { continue }
                    var rows: [Balloon] = []
                    balloons(window, time, into: &rows)
                    rows.sort { $0.y < $1.y }
                    var selected: [(Attachment, AXUIElement)] = []
                    for (index, file) in request.files.enumerated() where file.wanted {
                        if selected.contains(where: { $0.0.id == file.id }) { continue }
                        let named = rows.filter { $0.description.contains(", " + file.name + ", ") }
                        if named.count == 1, nameCounts[file.name] == 1 {
                            selected.append((file, named[0].element))
                        } else if rows.count == request.files.count {
                            // Cached thumbnails omit names. Only use their order
                            // when the entire minute's attachment set is visible.
                            selected.append((file, rows[index].element))
                        }
                    }
                    if !selected.isEmpty {
                        var pressed: [String] = []
                        for (file, element) in selected {
                            guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
                                throw Failure(message: "Messages could not request \(file.name); check its download before retrying")
                            }
                            pressed.append(file.id)
                        }
                        result["pressed"] = pressed
                        return
                    }
                    if Date() >= nextScroll, pages < 8, let last = rows.last {
                        guard AXUIElementPerformAction(last.element, "AXScrollDownByPage" as CFString) == .success else {
                            throw Failure(message: "Messages could not scroll to the remaining attachments")
                        }
                        pages += 1
                        nextScroll = Date().addingTimeInterval(0.3)
                    }
                }
            }
            // A cold launch sometimes creates a window without following the URL.
            if !reopened, Date().timeIntervalSince(start) >= 2 {
                try openMessage(request.guid)
                reopened = true
            }
        } while Date() < deadline
        throw Failure(message: "Messages did not expose an unambiguous download button for the requested files; no guessed button was pressed")
    } catch {
        result["error"] = (error as? Failure)?.message ?? error.localizedDescription
    }
}
func copyFiles(_ paths: [String]) throws {
    guard !paths.isEmpty else { throw Failure(message: "copy needs file paths") }
    let urls = try paths.map { path -> NSURL in
        var directory: ObjCBool = false
        guard path.hasPrefix("/"), FileManager.default.fileExists(atPath: path, isDirectory: &directory), !directory.boolValue else {
            throw Failure(message: "no file at \(path); clipboard unchanged")
        }
        return NSURL(fileURLWithPath: path)
    }
    let board = NSPasteboard.general
    board.clearContents()
    guard board.writeObjects(urls) else { throw Failure(message: "the clipboard rejected the files") }
    let readback = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [NSURL] ?? []
    guard readback.map(\.path) == urls.map(\.path) else { throw Failure(message: "the clipboard did not retain every file") }
    printJSON(["clipboard": true, "files": paths])
}

let args = Array(CommandLine.arguments.dropFirst())
do {
    switch args.first {
    case "fetch":
        let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
        fetch(request)
    case "copy": try copyFiles(Array(args.dropFirst()))
    case "quit":
        guard let raw = args.dropFirst().first, let pid = pid_t(raw) else { throw Failure(message: "quit needs the launched Messages pid") }
        if let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == "com.apple.MobileSMS" {
            guard app.terminate() else { throw Failure(message: "could not close the Messages app opened for downloads") }
            let deadline = Date().addingTimeInterval(5)
            while !app.isTerminated, Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            }
            guard app.isTerminated else { throw Failure(message: "Messages did not close after its downloads finished") }
        }
        printJSON(["closed": true])
    default: throw Failure(message: "usage: attachments fetch < request.json | copy PATH... | quit PID")
    }
} catch {
    FileHandle.standardError.write(Data(((error as? Failure)?.message ?? error.localizedDescription).utf8))
    FileHandle.standardError.write(Data([10]))
    exit(1)
}
