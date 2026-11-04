final class MemoryClipboard: ClipboardStore {
    var changeCount = 1
    var contents: ClipboardContents
    var afterSnapshot: (() -> Void)?
    var rejectNextWrite = false
    init(_ contents: ClipboardContents) { self.contents = contents }
    func snapshot() throws -> ClipboardContents {
        let saved = contents
        afterSnapshot?()
        return saved
    }
    func clear(ifUnchangedSince count: Int) -> Int? {
        guard count == changeCount else { return nil }
        contents = []
        changeCount += 1
        return changeCount
    }
    func write(_ value: ClipboardContents, ifUnchangedSince count: Int) throws -> Bool {
        guard count == changeCount else { return false }
        if rejectNextWrite {
            rejectNextWrite = false
            throw ClipboardFailure.rejected
        }
        contents = value
        return true
    }
    func userCopies(_ value: ClipboardContents) {
        contents = value
        changeCount += 1
    }
}

final class UnavailableClipboardData: NSObject, NSPasteboardItemDataProvider {
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        // This declared representation deliberately cannot be fulfilled.
    }
}

func require(_ condition: Bool, _ message: String) {
    if !condition { fail(message) }
}

let original: ClipboardContents = [
    [.string: Data("original".utf8), .html: Data("<b>original</b>".utf8), NSPasteboard.PasteboardType("example.private-format"): Data([0, 255, 3])],
    [.png: Data([137, 80, 78, 71]), NSPasteboard.PasteboardType("public.file-url"): Data("file:///test-only".utf8)]
]
let supplied = PastePayload(text: "name\tamount\nada\t42", html: "<table><tr><td>ada</td><td>42</td></tr></table>", tsv: "ada\t42").contents
let concurrent: ClipboardContents = [[.string: Data("user copied something else".utf8)]]
let scenario = CommandLine.arguments.dropFirst().first ?? ""
do {
    switch scenario {
    case "all-formats":
        let board = MemoryClipboard(original)
        let transaction = try TemporaryClipboard(board, contents: supplied)
        require(board.contents == supplied, "paste representations were not installed")
        require(try transaction.restore(), "original clipboard was not restored")
        require(board.contents == original, "clipboard items or formats were lost")
    case "concurrent-copy":
        let board = MemoryClipboard(original)
        let transaction = try TemporaryClipboard(board, contents: supplied)
        board.userCopies(concurrent)
        require(try !transaction.restore(), "a concurrent copy was overwritten")
        require(board.contents == concurrent, "the user's new clipboard changed")
    case "snapshot-race":
        let board = MemoryClipboard(original)
        board.afterSnapshot = { board.userCopies(concurrent) }
        do {
            _ = try TemporaryClipboard(board, contents: supplied)
            fail("a changed clipboard was replaced")
        } catch ClipboardFailure.changed {
            require(board.contents == concurrent, "the snapshot race overwrote a new copy")
        }
    case "failed-write":
        let board = MemoryClipboard(original)
        board.rejectNextWrite = true
        do {
            _ = try TemporaryClipboard(board, contents: supplied)
            fail("a rejected pasteboard write was reported as success")
        } catch ClipboardFailure.rejected {
            require(board.contents == original, "a rejected write lost the previous clipboard")
        }
    case "restore-once":
        let board = MemoryClipboard(original)
        let transaction = try TemporaryClipboard(board, contents: supplied)
        require(try transaction.restore(), "first restoration failed")
        board.userCopies(concurrent)
        require(try !transaction.restore(), "restoration ran more than once")
        require(board.contents == concurrent, "a later copy was lost to repeated cleanup")
    case "native-isolated":
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("safari-harness-input-test-\(getpid())"))
        defer { pasteboard.releaseGlobally() }
        let board = NativeClipboard(board: pasteboard)
        let start = board.changeCount
        guard let prepared = board.clear(ifUnchangedSince: start) else { fail("could not prepare an isolated pasteboard") }
        require(try board.write(original, ifUnchangedSince: prepared), "isolated pasteboard rejected its initial data")
        let transaction = try TemporaryClipboard(board, contents: supplied)
        require(try board.snapshot() == supplied, "the native pasteboard did not hold every supplied representation")
        require(try transaction.restore(), "native pasteboard restoration failed")
        require(try board.snapshot() == original, "native pasteboard changed original bytes or item order")
    case "native-unavailable":
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("safari-harness-unavailable-test-\(getpid())"))
        defer { pasteboard.releaseGlobally() }
        let readable = NSPasteboardItem()
        let unavailable = NSPasteboardItem()
        let missingType = NSPasteboard.PasteboardType("example.unavailable-original-format")
        let provider = UnavailableClipboardData()
        require(readable.setString("first fixture item", forType: .string), "could not prepare the readable fixture item")
        require(unavailable.setString("second fixture item", forType: .string), "could not prepare the unavailable fixture item")
        require(unavailable.setDataProvider(provider, forTypes: [missingType]), "could not declare the unavailable representation")
        pasteboard.clearContents()
        require(pasteboard.writeObjects([readable, unavailable]), "could not install the isolated unavailable fixture")
        let board = NativeClipboard(board: pasteboard)
        let before = board.changeCount
        do {
            _ = try TemporaryClipboard(board, contents: supplied)
            fail("an unreadable original representation was replaced")
        } catch {
            require(error.localizedDescription.contains("clipboard item 2") && error.localizedDescription.contains(missingType.rawValue), "the refusal did not identify the unavailable item and type")
            require(board.changeCount == before, "refusing an unavailable representation changed clipboard ownership")
            let items = pasteboard.pasteboardItems ?? []
            require(items.count == 2, "refusing an unavailable representation lost an original item")
            require(items[0].string(forType: .string) == "first fixture item" && items[1].string(forType: .string) == "second fixture item", "refusing an unavailable representation changed original data")
            require(items[1].types.contains(missingType), "refusing an unavailable representation dropped its declaration")
        }
    case "native-empty":
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("safari-harness-empty-test-\(getpid())"))
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        let board = NativeClipboard(board: pasteboard)
        let transaction = try TemporaryClipboard(board, contents: supplied)
        require(try board.snapshot() == supplied, "an empty original clipboard prevented installing the paste")
        require(try transaction.restore(), "the empty original clipboard was not restored")
        require(try board.snapshot().isEmpty, "restoring an empty original clipboard left paste data behind")
    default:
        fail("unknown native clipboard test", 2)
    }
    printJSON(["passed": scenario])
} catch {
    fail("native clipboard contract failed: \(error)")
}
