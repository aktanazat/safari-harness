// The one popup that asks the user's ok for an agent's step, for
// omp/approvals.ts. The first line on stdin is the request as JSON; later
// lines "approve" or "deny" answer it from omp's terminal prompt. stdout
// gets "shown" once the popup is on screen, then one JSON answer.
//   {"asker","title","detail","mono","approve","deny","auth","reason","timeoutMs"}
//   => {"approved": bool, "reason": "approved|denied|timeout|auth_failed|orphaned"}
// Approve asks Touch ID (or his password) and only then answers yes; auth
// false (a handoff's "Show me") answers yes without it. stdin closing means
// the omp session is gone and nobody waits for the answer.
// Every omp process starts its own: each waits for approve.lock before it
// shows, so two agents' popups come one after the other. While one waits,
// "deny" and stdin closing still end it, and "approve" is ignored: he has
// not seen it.
// The look follows the owner's hub (aktan-hub web/STANDARD.md): colour
// roles in both themes, one flat card, clay only on the mark that says it
// needs him.
import AppKit
import LocalAuthentication
import SwiftUI

struct Request: Decodable {
    let asker: String
    let title: String
    let detail: String?
    let mono: Bool?
    let approve: String?
    let deny: String?
    let auth: Bool?
    let reason: String?
    let timeoutMs: Int?
}

func answer(_ approved: Bool, _ reason: String) -> Never {
    FileHandle.standardOutput.write("{\"approved\":\(approved),\"reason\":\"\(reason)\"}\n".data(using: .utf8)!)
    exit(0)
}

func hex(_ v: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: alpha)
}

func role(_ light: NSColor, _ dark: NSColor) -> Color {
    Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light })
}

let card = role(hex(0xffffff), hex(0x141414))
let raised = role(hex(0xf1f1ee), hex(0x1c1c1c))
let edge = role(hex(0x141413, 0.1), hex(0xffffff, 0.08))
let ink = role(hex(0x141413), hex(0xf5f5f4))
let muted = role(hex(0x141413, 0.66), hex(0xf5f5f4, 0.66))
let faint = role(hex(0x141413, 0.52), hex(0xf5f5f4, 0.46))
let clay = role(hex(0xb5532f), hex(0xd97757))

let monoName = ["BerkeleyMono-Regular", "Berkeley Mono"].first { NSFont(name: $0, size: 13) != nil }
func mono(_ size: CGFloat) -> Font { monoName.map { .custom($0, size: size) } ?? .system(size: size, design: .monospaced) }
let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

final class Model: ObservableObject {
    @Published var checking = false
}

struct Action: ButtonStyle {
    let primary: Bool

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, primary: primary)
    }

    struct Face: View {
        let configuration: Configuration
        let primary: Bool
        @State private var hover = false
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            let lit = hover || configuration.isPressed
            configuration.label
                .font(.system(size: 15, weight: primary ? .medium : .regular))
                .foregroundStyle(primary ? card : ink)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(RoundedRectangle(cornerRadius: 10).fill(primary ? ink.opacity(lit ? 0.84 : 1) : lit ? raised : card))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(primary ? .clear : edge, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: 10))
                .opacity(enabled ? 1 : 0.5)
                .onHover { h in withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { hover = h } }
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: configuration.isPressed)
        }
    }
}

struct Mark: View {
    let asker: String
    let checking: Bool

    var body: some View {
        HStack(spacing: 8) {
            if checking {
                Circle().strokeBorder(faint, style: StrokeStyle(lineWidth: 1.5, dash: [2, 2.4])).frame(width: 14, height: 14)
                Text("Touch ID").foregroundStyle(faint)
            } else {
                Circle().fill(clay).frame(width: 14, height: 14)
                    .overlay(Text("!").font(.system(size: 10, weight: .bold)).foregroundStyle(card))
                Text(asker).foregroundStyle(muted)
            }
        }
        .font(.system(size: 13))
        .frame(height: 18)
    }
}

struct Card: View {
    let request: Request
    @ObservedObject var model: Model
    let decide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Mark(asker: request.asker, checking: model.checking)
            Text(request.title)
                .font(.system(size: 28, weight: .medium))
                .tracking(-0.56)
                .foregroundStyle(ink)
                .lineLimit(2)
                .truncationMode(.middle)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 20)
            if let detail = request.detail {
                Text(detail)
                    .font(request.mono == true ? mono(13) : .system(size: 15))
                    .lineSpacing(request.mono == true ? 3 : 5)
                    .foregroundStyle(muted)
                    .lineLimit(request.mono == true ? 3 : 6)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }
            HStack(spacing: 8) {
                Button { decide(false) } label: { Text(request.deny ?? "Deny") }
                    .buttonStyle(Action(primary: false))
                    .keyboardShortcut(.cancelAction)
                Button { decide(true) } label: {
                    HStack(spacing: 8) {
                        if request.auth != false { Image(systemName: "touchid").font(.system(size: 15)) }
                        Text(request.approve ?? "Approve")
                    }
                }
                .buttonStyle(Action(primary: true))
                .keyboardShortcut(.defaultAction)
            }
            .disabled(model.checking)
            .padding(.top, 28)
        }
        .padding(32)
        .frame(width: 400, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(card))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(edge, lineWidth: 1))
    }
}

final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class Asker: NSObject, NSApplicationDelegate {
    let request: Request
    let model = Model()
    var panel: Panel!

    init(_ request: Request) { self.request = request }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(request.timeoutMs ?? 600_000)) { answer(false, "timeout") }
        let view = NSHostingView(rootView: Card(request: request, model: model) { [weak self] yes in self?.decide(yes) })
        let size = view.fittingSize
        panel = Panel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.contentView = view
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: screen.maxX - size.width - 16, y: screen.maxY - size.height - 16))
        }
        panel.alphaValue = reduceMotion ? 1 : 0
        panel.orderFrontRegardless()
        panel.makeKey()
        if !reduceMotion {
            NSAnimationContext.runAnimationGroup { $0.duration = 0.2; panel.animator().alphaValue = 1 }
        }
        NSSound(named: "Tink")?.play()
        shownLock.lock()
        shown = true
        shownLock.unlock()
        FileHandle.standardOutput.write("shown\n".data(using: .utf8)!)
    }

    func decide(_ yes: Bool) {
        guard yes else { answer(false, "denied") }
        guard !model.checking else { return }
        guard request.auth != false else { answer(true, "approved") }
        model.checking = true
        let context = LAContext()
        context.localizedCancelTitle = "Deny"
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: request.reason ?? "approve this step") { ok, _ in
            DispatchQueue.main.async { ok ? answer(true, "approved") : answer(false, "auth_failed") }
        }
    }
}

guard let first = readLine(), let request = try? JSONDecoder().decode(Request.self, from: Data(first.utf8)) else {
    FileHandle.standardError.write("approve: expected a request as one line of JSON on stdin\n".data(using: .utf8)!)
    exit(2)
}
let shownLock = NSLock()
nonisolated(unsafe) var shown = false
nonisolated(unsafe) var asker: Asker?
Thread.detachNewThread {
    while let line = readLine() {
        let yes = line.trimmingCharacters(in: .whitespaces) == "approve"
        guard yes else { answer(false, "denied") }
        shownLock.lock()
        let seen = shown
        shownLock.unlock()
        if seen { DispatchQueue.main.async { asker?.decide(true) } }
    }
    answer(false, "orphaned")
}
let lockDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/safari-harness")
try? FileManager.default.createDirectory(at: lockDir, withIntermediateDirectories: true)
let lock = open(lockDir.appendingPathComponent("approve.lock").path, O_CREAT | O_RDWR, 0o600)
guard lock >= 0, flock(lock, LOCK_EX) == 0 else {
    FileHandle.standardError.write("approve: cannot take the popup lock\n".data(using: .utf8)!)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
asker = Asker(request)
app.delegate = asker
app.run()
