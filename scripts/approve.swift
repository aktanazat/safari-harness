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
    let kind: String?
    let attach: String?
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
// The window shadow outlines the card in light; dark needs a faint rim.
let rim = role(.clear, hex(0xffffff, 0.1))
let edge = role(hex(0x141413, 0.1), hex(0xffffff, 0.08))
let ink = role(hex(0x141413), hex(0xf5f5f4))
let muted = role(hex(0x141413, 0.66), hex(0xf5f5f4, 0.66))
let faint = role(hex(0x141413, 0.52), hex(0xf5f5f4, 0.46))
let clay = role(hex(0xb5532f), hex(0xd97757))

let monoName = ["BerkeleyMono-Regular", "Berkeley Mono"].first { NSFont(name: $0, size: 13) != nil }
func mono(_ size: CGFloat) -> Font { monoName.map { .custom($0, size: size) } ?? .system(size: size, design: .monospaced) }
let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

// The window's state lives here, not in @State: on macOS 27.2 the SDK's
// @State is a macro whose plugin ships only with Xcode, so Command Line
// Tools alone cannot build it.
final class Model: ObservableObject {
    @Published var checking = false
    @Published var shown = reduceMotion
    /// The button under the pointer: true for the approve one.
    @Published var hovered: Bool?
}

struct Action: ButtonStyle {
    let primary: Bool
    let model: Model

    func makeBody(configuration: Configuration) -> some View {
        Face(configuration: configuration, primary: primary, model: model)
    }

    struct Face: View {
        let configuration: Configuration
        let primary: Bool
        @ObservedObject var model: Model
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            let lit = model.hovered == primary || configuration.isPressed
            configuration.label
                .font(.system(size: 15, weight: primary ? .medium : .regular))
                .foregroundStyle(primary ? card : ink)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(primary ? ink.opacity(lit ? 0.84 : 1) : ink.opacity(lit ? 0.1 : 0.06)))
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .opacity(enabled ? 1 : 0.5)
                .onHover { h in
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                        if h { model.hovered = primary } else if model.hovered == primary { model.hovered = nil }
                    }
                }
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: configuration.isPressed)
        }
    }
}

// The kind's line glyph inside the clay "needs you" disc.
let glyphs = ["secret": "key", "login": "person.badge.key", "card": "creditcard", "message": "message", "shortcut": "bolt", "handoff": "hand.raised"]

struct Mark: View {
    let asker: String
    let kind: String?
    let checking: Bool

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(checking ? raised : clay)
                Image(systemName: checking ? "touchid" : glyphs[kind ?? ""] ?? "exclamationmark")
                    .font(.system(size: checking ? 13 : 11, weight: .semibold))
                    .foregroundStyle(checking ? clay : card)
            }
            .frame(width: 24, height: 24)
            Text(checking ? "Touch ID" : asker).foregroundStyle(checking ? faint : muted)
        }
        .font(.system(size: 13, weight: .medium))
        .frame(height: 24)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: checking)
    }
}

// The window behind the card: the desktop shows faintly through it.
struct Glass: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .popover
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

struct Card: View {
    let request: Request
    @ObservedObject var model: Model
    let decide: (Bool) -> Void

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            Mark(asker: request.asker, kind: request.kind, checking: model.checking)
            Text(request.title)
                .font(.system(size: 28, weight: .medium))
                .tracking(-0.56)
                .foregroundStyle(ink)
                .lineLimit(2)
                .truncationMode(.middle)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 22)
            if let detail = request.detail {
                Detail(text: detail, command: request.mono == true, bubble: request.kind == "message")
                    .padding(.top, request.mono == true || request.kind == "message" ? 14 : 8)
            }
            if let attach = request.attach {
                Label(attach, systemImage: "paperclip")
                    .font(.system(size: 13))
                    .foregroundStyle(faint)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: request.kind == "message" ? .trailing : .leading)
                    .padding(.top, 10)
            }
            HStack(spacing: 10) {
                Button { decide(false) } label: { Text(request.deny ?? "Deny") }
                    .buttonStyle(Action(primary: false, model: model))
                    .keyboardShortcut(.cancelAction)
                Button { decide(true) } label: {
                    HStack(spacing: 8) {
                        if request.auth != false { Image(systemName: "touchid").font(.system(size: 16)) }
                        Text(request.approve ?? "Approve")
                    }
                }
                .buttonStyle(Action(primary: true, model: model))
                .keyboardShortcut(.defaultAction)
            }
            .disabled(model.checking)
            .padding(.top, 28)
        }
        .padding(28)
        .frame(width: 380, alignment: .leading)
        .background(ZStack { Glass(); card.opacity(0.8) }.clipShape(shape))
        .overlay(shape.strokeBorder(rim, lineWidth: 1))
        .opacity(model.shown ? 1 : 0)
        .offset(y: model.shown ? 0 : -8)
        .onAppear { withAnimation(.easeOut(duration: 0.22)) { model.shown = true } }
    }
}

// The one fact under the title: a command sits in a well, a text in a
// bubble the way Messages shows it, anything else as a plain line.
struct Detail: View {
    let text: String
    let command: Bool
    let bubble: Bool

    var body: some View {
        if command {
            (Text("$ ").foregroundStyle(faint) + Text(text))
                .font(mono(13))
                .lineSpacing(3)
                .foregroundStyle(ink.opacity(0.8))
                .lineLimit(3)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(raised))
        } else if bubble {
            Text(text)
                .font(.system(size: 15))
                .lineSpacing(3)
                .foregroundStyle(card)
                .lineLimit(6)
                .truncationMode(.tail)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 5, topTrailingRadius: 18, style: .continuous).fill(clay))
                .padding(.leading, 36)
                .frame(maxWidth: .infinity, alignment: .trailing)
        } else {
            Text(text)
                .font(.system(size: 15))
                .lineSpacing(5)
                .foregroundStyle(muted)
                .lineLimit(6)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
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
        panel.hasShadow = true
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
