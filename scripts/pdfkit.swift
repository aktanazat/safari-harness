// PDF helper for the daemon, which runs headless under launchd.
//   pdfkit render HTMLFILE BASEURL OUT.pdf [--width 1280]
//     Lays the HTML out in an offscreen WKWebView and prints it to a paginated
//     US Letter PDF, like Safari's File > Export as PDF. Prints
//     {"path","pages","bytes"}.
//   pdfkit text PDF [--max-bytes 200000]
//     Extracts the text of every page with PDFKit, pages separated by "\n\f\n".
//     Prints {"pages","text","truncated"}.
// Neither needs any privacy permission.
import AppKit
import PDFKit
import WebKit

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

// ---------- text ----------

func text(_ args: [String]) {
    guard args.count >= 1 else { fail("usage: pdfkit text PDF [--max-bytes N]", 2) }
    let maxBytes = Int(option(args, "--max-bytes") ?? "") ?? 200_000
    guard let doc = PDFDocument(url: URL(fileURLWithPath: args[0])) else { fail("cannot open PDF: \(args[0])") }
    if doc.isLocked { fail("PDF is password-protected: \(args[0])") }
    var pages: [String] = []
    for i in 0..<doc.pageCount { pages.append(doc.page(at: i)?.string ?? "") }
    var out = pages.joined(separator: "\n\u{0C}\n")
    var truncated = false
    if out.utf8.count > maxBytes {
        truncated = true
        // Cut on a character boundary at or below maxBytes.
        var bytes = 0
        var end = out.startIndex
        for ch in out {
            let n = String(ch).utf8.count
            if bytes + n > maxBytes { break }
            bytes += n
            end = out.index(after: end)
        }
        out = String(out[..<end])
    }
    printJSON(["pages": doc.pageCount, "text": out, "truncated": truncated])
}

// ---------- render ----------

// Resolves once the page has finished loading and its images have settled.
final class Loader: NSObject, WKNavigationDelegate {
    var done: ((Error?) -> Void)?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?(nil) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done?(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { done?(error) }
}

// True once every <img> has finished (loaded or failed) and web fonts are ready.
let settledJS = "Array.from(document.images).every(i => i.complete) && document.fonts.status === 'loaded'"

final class Renderer: NSObject {
    let web: WKWebView
    let window: NSWindow
    let loader = Loader()
    let out: URL
    let deadline = Date().addingTimeInterval(20)

    init(width: CGFloat, out: URL) {
        self.out = out
        let frame = NSRect(x: 0, y: 0, width: width, height: 1000)
        web = WKWebView(frame: frame, configuration: WKWebViewConfiguration())
        // Printing lays out through the view's window; it never appears on screen.
        window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        super.init()
        web.navigationDelegate = loader
    }

    func start(html: String, base: URL?) {
        loader.done = { [weak self] error in
            if let error { fail("page failed to load: \(error.localizedDescription)") }
            self?.waitForImages()
        }
        web.loadHTMLString(html, baseURL: base)
    }

    // Poll every 100 ms until images settle or the deadline passes, then give
    // layout a short moment before printing.
    func waitForImages() {
        web.evaluateJavaScript(settledJS) { [weak self] value, _ in
            guard let self else { return }
            if (value as? Bool) == true || Date() > self.deadline {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.printPDF() }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForImages() }
            }
        }
    }

    func printPDF() {
        let info = NSPrintInfo(dictionary: [
            .jobDisposition: NSPrintInfo.JobDisposition.save,
            .jobSavingURL: out,
        ])
        info.paperSize = NSSize(width: 612, height: 792)
        info.topMargin = 36
        info.bottomMargin = 36
        info.leftMargin = 36
        info.rightMargin = 36
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        let op = web.printOperation(with: info)
        op.showsPrintPanel = false
        op.showsProgressPanel = false
        // WKWebView prints asynchronously; runModal keeps the run loop turning
        // and reports back when the file is written.
        op.view?.frame = web.bounds
        op.runModal(for: window, delegate: self, didRun: #selector(printed(_:success:contextInfo:)), contextInfo: nil)
    }

    @objc func printed(_ op: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        if !success { fail("printing to PDF failed") }
        guard let doc = PDFDocument(url: out) else { fail("printed PDF is unreadable: \(out.path)") }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0
        printJSON(["path": out.path, "pages": doc.pageCount, "bytes": bytes])
        exit(0)
    }
}

func render(_ args: [String]) {
    guard args.count >= 3 else { fail("usage: pdfkit render HTMLFILE BASEURL OUT.pdf [--width 1280]", 2) }
    guard let html = try? String(contentsOfFile: args[0], encoding: .utf8) else { fail("cannot read HTML file: \(args[0])") }
    let base = URL(string: args[1])
    let out = URL(fileURLWithPath: args[2])
    let width = CGFloat(Double(option(args, "--width") ?? "") ?? 1280)
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let renderer = Renderer(width: width, out: out)
    renderer.start(html: html, base: base)
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { fail("timed out rendering PDF") }
    withExtendedLifetime(renderer) { app.run() }
}

let argv = Array(CommandLine.arguments.dropFirst())
switch argv.first {
case "render": render(Array(argv.dropFirst()))
case "text": text(Array(argv.dropFirst()))
default: fail("usage: pdfkit render HTMLFILE BASEURL OUT.pdf [--width 1280] | pdfkit text PDF [--max-bytes N]", 2)
}
