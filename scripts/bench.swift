// Offline WebKit bench for the extension's page scripts (bench/*.test.ts).
// A web view that no window shows opens a page with extension/dialogs.js in
// the page's own world and extension/content.js in a world of its own, as
// Safari's manifest puts them there, and sends content.js the requests
// background.js sends. The web view is Safari's own WebKit, so the page's
// DOM, styles, and layout are the ones Safari computes.
//   bench EXTENSION_DIR
//     Reads one JSON request a line on stdin, until stdin closes, and prints
//     one JSON line for each, in order:
//       {"load": URL, "frames": N, "timeout": MS}
//           opens URL, and answers once the page has loaded and content.js
//           has reported in from it and from N embedded frames (default 0):
//           {"url", "frames": [{"url", "token"}]}, token being the frame's
//           window.__safariHarnessFrame
//       {"op": NAME, "args": [...], "frame": URL, "timeout": MS}
//           hands content.js {__safariHarness: 1, id, op: NAME, args} as
//           tabs.sendMessage does, in the page or in the embedded frame at
//           URL, and prints its answer as it gave it: {"id", "value"} or
//           {"id", "error"}
//       {"takeover": true, "timeout": MS}
//           reloads the extension and puts a fresh copy of content.js in
//           the page, as background.js's takeover does: the claim set to
//           null, then content.js run again in the same world. A copy
//           already there keeps the old load's API, which reaches no one;
//           ops go to the fresh copy. Answers {"value": {"url"}} once the
//           fresh copy has reported in.
//       {"sent": true}
//           what the page's copies sent the extension since the page
//           loaded or since the last sent: {"value": [{"load", "message"}]},
//           load counting the extension's loads from 1. An answer a copy
//           gave after its load ended, which reaches no one in Safari, is
//           there as {"load", "answer"}.
//     MS bounds the request (default 10000 for load, 5000 for op and
//     takeover). What the bench itself cannot do prints {"error": "bench: ..."}.
// Nothing shows, nothing takes focus, and the pages keep no data on disk.
import AppKit
import WebKit

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

func line(_ value: [String: Any]) -> Data {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]) else { fail("cannot encode result") }
    return data
}

func problem(_ message: String) -> Data {
    line(["error": "bench: " + message])
}

// Safari runs no extension script in about:blank and srcdoc frames (see
// inlineDoc in content.js); WebKit would. A script that throws while it
// starts says so, instead of leaving a page that never reports in. Both
// wrappers keep the script's own line numbers.
func extensionScript(_ name: String, _ source: String) -> String {
    "if (!location.href.startsWith(\"about:\")) { try {" + source
        + "\n} catch (e) { window.webkit.messageHandlers.bench.postMessage({ threw: \"\(name): \" + ((e && e.stack) || e), url: location.href }); } }"
}

// The part of the extension API content.js uses, in content.js's world, as
// one load of the extension gives it; a takeover makes the next load. The
// ready message gets background.js's answer for a tab the harness opened,
// the tabs agents work in: dialogs answered by the default policy, and the
// page's requests logged.
let runtimeShim = #"""
(() => {
  const sent = [];
  let current = 0;
  const event = (list) => ({ addListener: (fn) => { list.push(fn); } });
  window.__benchSent = () => sent.splice(0);
  window.__benchReload = () => {
    const load = ++current;
    const ended = () => load !== current;
    const listeners = [];
    window.browser = {
      runtime: {
        onMessage: event(listeners),
        sendMessage: (msg) => {
          sent.push({ load, message: msg });
          if (ended()) return Promise.reject(new Error("the extension reloaded"));
          if (!msg || msg.__safariHarnessReady !== 1) return Promise.resolve(undefined);
          window.webkit.messageHandlers.bench.postMessage({ ready: String(window.__safariHarnessFrame), url: location.href });
          return Promise.resolve({ dialogs: { accept: false, text: null }, tab: 1, window: 1, net: true });
        },
        connect: (info) => ({ name: (info && info.name) || "", onMessage: event([]), onDisconnect: event([]), postMessage() {}, disconnect() {} }),
      },
    };
    // As tabs.sendMessage: the first listener that returns a promise answers.
    window.__benchSend = async (json) => {
      const msg = JSON.parse(json);
      for (const fn of listeners) {
        const out = fn(msg, {}, () => {});
        if (out === undefined) continue;
        const answer = await out;
        if (ended()) sent.push({ load, answer });
        return JSON.stringify(answer);
      }
      return null;
    };
  };
  window.__benchReload();
})();
"""#

final class Bench: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let world = WKContentWorld.world(name: "Safari Harness")
    let content: String
    let web: WKWebView
    var waiting: [String] = []
    var busy = false
    var inputEnded = false
    var nextId = 0
    // The request being answered: what ends it early, and a load's progress.
    var abort: ((String) -> Void)?
    var progress: (() -> Void)?
    // The document in the web view, as its scripts reported in.
    var navigation: WKNavigation?
    var loaded = false
    var mainURL: String?
    var threw: String?
    var frames: [(url: String, token: String, info: WKFrameInfo)] = []

    init(content: String, dialogs: String) {
        self.content = content
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        // A web view in no window is inactive, and WebKit would slow its
        // timers; a page's timers then fire late by varying amounts.
        config.preferences.inactiveSchedulingPolicy = .none
        let scripts = config.userContentController
        scripts.addUserScript(WKUserScript(source: extensionScript("dialogs.js", dialogs), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        scripts.addUserScript(WKUserScript(source: extensionScript("bench shim", runtimeShim), injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world))
        scripts.addUserScript(WKUserScript(source: extensionScript("content.js", content), injectionTime: .atDocumentEnd, forMainFrameOnly: false, in: world))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: config)
        super.init()
        scripts.add(self, contentWorld: world, name: "bench")
        scripts.add(self, contentWorld: .page, name: "bench")
        web.navigationDelegate = self
    }

    func take(_ request: String) {
        if request.allSatisfy(\.isWhitespace) { return }
        waiting.append(request)
        next()
    }

    func endInput() {
        inputEnded = true
        next()
    }

    // Requests run one at a time, and each is answered once: an answer that
    // comes after its request timed out is dropped.
    func next() {
        guard !busy else { return }
        guard !waiting.isEmpty else {
            if inputEnded { exit(0) }
            return
        }
        busy = true
        let text = waiting.removeFirst()
        var answered = false
        let reply = { [self] (data: Data) in
            guard !answered else { return }
            answered = true
            abort = nil
            progress = nil
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
            busy = false
            next()
        }
        abort = { reply(problem($0)) }
        guard let request = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else {
            return reply(problem("not a JSON object: \(text)"))
        }
        let ms = (request["timeout"] as? NSNumber)?.intValue
        if let target = request["load"] as? String {
            let want = (request["frames"] as? NSNumber)?.intValue ?? 0
            let limit = ms ?? 10000
            after(limit) { [self] in reply(problem("\(target) did not load within \(limit) ms: \(loadState(want))")) }
            load(target, frames: want, reply: reply)
        } else if let op = request["op"] as? String {
            let limit = ms ?? 5000
            after(limit) { reply(problem("\(op) did not answer within \(limit) ms")) }
            send(op, request, reply: reply)
        } else if request["takeover"] as? Bool == true {
            let limit = ms ?? 5000
            after(limit) { reply(problem("the fresh copy of content.js did not report in within \(limit) ms")) }
            takeover(reply: reply)
        } else if request["sent"] as? Bool == true {
            web.callAsyncJavaScript("return JSON.stringify({ value: __benchSent() })", arguments: [:], in: nil, in: world) { result in
                switch result {
                case .success(let answer as String): reply(Data(answer.utf8))
                case .success: reply(problem("the page has no record of what content.js sent"))
                case .failure(let error): reply(problem("cannot read what content.js sent: \(error.localizedDescription)"))
                }
            }
        } else {
            reply(problem("a request has load, op, takeover, or sent: \(text)"))
        }
    }

    func after(_ ms: Int, _ run: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms), execute: run)
    }

    // ---------- load ----------

    func load(_ target: String, frames want: Int, reply: @escaping (Data) -> Void) {
        guard let url = URL(string: target), url.scheme != nil else { return reply(problem("not a URL: \(target)")) }
        loaded = false
        progress = { [self] in
            if let threw { return reply(problem(threw)) }
            guard loaded, let mainURL, frames.count >= want else { return }
            reply(line(["url": mainURL, "frames": frames.map { ["url": $0.url, "token": $0.token] }]))
        }
        navigation = url.isFileURL
            ? web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            : web.load(URLRequest(url: url))
    }

    func loadState(_ want: Int) -> String {
        if !loaded { return "the page is still loading" }
        if mainURL == nil { return "content.js did not report in from the page" }
        return "content.js reported in from \(frames.count) of \(want) embedded frames"
    }

    // A new document, whose scripts report in afresh.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        mainURL = nil
        threw = nil
        frames = []
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === self.navigation else { return }
        loaded = true
        progress?()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard navigation === self.navigation else { return }
        abort?("the page failed to load: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard navigation === self.navigation else { return }
        abort?("the page failed to load: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        abort?("WebKit's page process quit")
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        let url = body["url"] as? String ?? ""
        if let error = body["threw"] as? String {
            threw = "\(error) (in \(url))"
        } else if let token = body["ready"] as? String {
            if message.frameInfo.isMainFrame { mainURL = url }
            else { frames.append((url, token, message.frameInfo)) }
        }
        progress?()
    }

    // ---------- ops ----------

    func send(_ op: String, _ request: [String: Any], reply: @escaping (Data) -> Void) {
        var frame: WKFrameInfo?
        if let url = request["frame"] as? String {
            let found = frames.filter { $0.url == url }
            guard found.count == 1 else { return reply(problem("\(found.count) embedded frames at \(url) reported in; an op goes to one")) }
            frame = found[0].info
        } else if mainURL == nil {
            return reply(problem("content.js has not reported in from the page since it last changed"))
        }
        nextId += 1
        let message: [String: Any] = ["__safariHarness": 1, "id": nextId, "op": op, "args": request["args"] as? [Any] ?? []]
        guard let json = String(data: line(message), encoding: .utf8) else { return reply(problem("cannot encode \(op)")) }
        web.callAsyncJavaScript("return await __benchSend(message)", arguments: ["message": json], in: frame, in: world) { result in
            switch result {
            case .success(let answer as String): reply(Data(answer.utf8))
            case .success: reply(problem("no copy of content.js answered \(op)"))
            case .failure(let error):
                let js = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String
                reply(problem("\(op) failed: \(js ?? error.localizedDescription)"))
            }
        }
    }

    // ---------- takeover ----------

    // The claim is cleared on the script's first line, so the script keeps
    // content.js's line numbers.
    func takeover(reply: @escaping (Data) -> Void) {
        guard mainURL != nil else { return reply(problem("content.js has not reported in from the page since it last changed")) }
        mainURL = nil
        progress = { [self] in
            if let threw { return reply(problem(threw)) }
            guard let mainURL else { return }
            reply(line(["value": ["url": mainURL]]))
        }
        let script = "__benchReload(); window.__safariHarnessInjected = null; " + extensionScript("content.js", content) + "\ntrue"
        web.evaluateJavaScript(script, in: nil, in: world) { [self] result in
            if case .failure(let error) = result { abort?("content.js did not run again: \(error.localizedDescription)") }
        }
    }
}

let argv = Array(CommandLine.arguments.dropFirst())
guard argv.count == 1 else { fail("usage: bench EXTENSION_DIR, then one JSON request a line on stdin", 2) }
let dir = URL(fileURLWithPath: argv[0])
func source(_ name: String) -> String {
    guard let text = try? String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8) else { fail("cannot read \(name) in \(dir.path)") }
    return text
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let bench = Bench(content: source("content.js"), dialogs: source("dialogs.js"))
Thread.detachNewThread {
    while let request = readLine() {
        DispatchQueue.main.async { bench.take(request) }
    }
    DispatchQueue.main.async { bench.endInput() }
}
withExtendedLifetime(bench) { app.run() }
