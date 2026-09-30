// The user's payment cards, kept in this Mac's keychain for the harness to
// fill checkout forms with (daemon/cards.ts), so an agent pays without seeing
// a card's digits. Each card is a data-protection keychain item in this app's
// own keychain group, which only an app signed with its entitlement reaches.
// A provisioning profile grants that entitlement, so this is an Xcode target
// embedded in Safari Harness.app rather than a script. A card's data opens
// only with Touch ID; what names it (brand, last 4, expiry, name on the
// card) sits in the item's attributes, which open without it, so listing
// never asks. The Mac's login password does not substitute for Touch ID.
//   list                  {"cards": [{id, label, brand, last4, exp, name}]}
//   save                  the card as JSON on stdin, {number, exp, csc, and
//                         optionally name, zip, label}: {"saved": card}. It
//                         replaces a card saved under the same label.
//   add [--label L]       a window where the user types a card at the Mac:
//                         {"saved": card}, or {"cancelled": true}
//   rm ID                 asks Touch ID, then {"removed": card}
//   serve                 reads {"read": ID, "site": HOST} lines and answers
//                         each with {"card": {number, month, year, csc, name,
//                         zip}} or {"error"}. The first read asks Touch ID, and
//                         that approval opens every read of the next 5 minutes.
//                         Ends with its input.
// Every other command prints one JSON line; an error goes to stderr with a
// nonzero exit.
import AppKit
import Foundation
import LocalAuthentication
import Security

let service = "at.aktan.safari-harness.card"
// How long one Touch ID opens reads for (owner's choice, 10-01).
let approvalSeconds: TimeInterval = 5 * 60
// A prompt nobody answers is taken down after this.
let promptSeconds = 120

struct Failure: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func jsonLine(_ value: [String: Any]) -> Data {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes, .sortedKeys]) else { fail("cannot encode result") }
    return data + Data("\n".utf8)
}

func messageOf(_ error: Error) -> String {
    (error as? Failure)?.message ?? error.localizedDescription
}

// Runs one command: its answer on stdout, or its error on stderr.
func answer(_ body: () throws -> [String: Any]) -> Never {
    do {
        FileHandle.standardOutput.write(jsonLine(try body()))
        exit(0)
    } catch {
        fail(messageOf(error))
    }
}

// ---------- a card ----------

// What names a card, in its item's attributes: agents see this.
struct Label: Codable {
    let label: String
    let brand: String
    let last4: String
    let exp: String
    let name: String
}

// What fills a card in, in its item's data: behind Touch ID.
struct Secret: Codable {
    let number: String
    let month: Int
    let year: Int
    let csc: String
    let name: String
    let zip: String
}

func digits(_ text: String) -> Bool {
    !text.isEmpty && text.unicodeScalars.allSatisfy { ("0"..."9").contains($0) }
}

// The checksum every card number carries, which catches a mistyped digit.
func luhn(_ number: String) -> Bool {
    var sum = 0
    for (i, c) in number.reversed().enumerated() {
        guard var d = c.wholeNumberValue else { return false }
        if i % 2 == 1 {
            d *= 2
            if d > 9 { d -= 9 }
        }
        sum += d
    }
    return sum % 10 == 0
}

func brandOf(_ n: String) -> String {
    let lead = { (k: Int) in Int(n.prefix(k)) ?? -1 }
    if n.hasPrefix("4") { return "Visa" }
    if (51...55).contains(lead(2)) || (2221...2720).contains(lead(4)) { return "Mastercard" }
    if n.hasPrefix("34") || n.hasPrefix("37") { return "Amex" }
    if n.hasPrefix("6011") || n.hasPrefix("65") || (644...649).contains(lead(3)) { return "Discover" }
    if (3528...3589).contains(lead(4)) { return "JCB" }
    if (300...305).contains(lead(3)) || n.hasPrefix("36") || n.hasPrefix("38") { return "Diners" }
    if n.hasPrefix("62") { return "UnionPay" }
    return "Card"
}

// "07/29", "7/2029", "07 / 29", "0729", or "072029": the month and the
// four-digit year. A card past its month is refused.
func expiry(_ raw: String) throws -> (month: Int, year: Int) {
    let runs = raw.split(whereSeparator: { !("0"..."9").contains($0) }).map(String.init)
    let parts: [String]
    if runs.count == 2 {
        parts = runs
    } else if runs.count == 1, runs[0].count == 4 || runs[0].count == 6 {
        parts = [String(runs[0].prefix(2)), String(runs[0].dropFirst(2))]
    } else {
        throw Failure("the expiry must read MM/YY")
    }
    guard let month = Int(parts[0]), (1...12).contains(month), parts[1].count == 2 || parts[1].count == 4, let y = Int(parts[1]) else {
        throw Failure("the expiry must read MM/YY")
    }
    let year = parts[1].count == 2 ? 2000 + y : y
    let now = Calendar(identifier: .gregorian).dateComponents([.year, .month], from: Date())
    if let thisYear = now.year, let thisMonth = now.month, year < thisYear || (year == thisYear && month < thisMonth) {
        throw Failure(String(format: "that card expired at the end of %02d/%02d", month, year % 100))
    }
    return (month, year)
}

func card(from input: [String: Any]) throws -> (Label, Secret) {
    let text = { (key: String) in (input[key] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    let number = text("number").filter { $0 != " " && $0 != "-" }
    guard (12...19).contains(number.count), digits(number) else { throw Failure("the card number must be 12 to 19 digits") }
    guard luhn(number) else { throw Failure("that card number fails the check every card number passes; look for a mistyped digit") }
    let (month, year) = try expiry(text("exp"))
    let csc = text("csc")
    guard (3...4).contains(csc.count), digits(csc) else { throw Failure("the security code must be 3 or 4 digits") }
    let brand = brandOf(number)
    let last4 = String(number.suffix(4))
    let given = text("label")
    let label = given.isEmpty ? "\(brand) \(last4)" : String(given.prefix(40))
    let exp = String(format: "%02d/%02d", month, year % 100)
    return (
        Label(label: label, brand: brand, last4: last4, exp: exp, name: text("name")),
        Secret(number: number, month: month, year: year, csc: csc, name: text("name"), zip: text("zip"))
    )
}

// ---------- the keychain ----------

func query(_ extra: [CFString: Any] = [:]) -> CFDictionary {
    var q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecUseDataProtectionKeychain: true]
    q.merge(extra) { $1 }
    return q as CFDictionary
}

func keychainFailure(_ status: OSStatus, _ doing: String) -> Failure {
    switch status {
    case errSecMissingEntitlement:
        return Failure("this copy of Safari Harness Cards is not signed with its keychain entitlement, so it keeps no cards; install Safari Harness with scripts/dev-install.sh")
    case errSecUserCanceled:
        return Failure("the user declined")
    case errSecInteractionNotAllowed:
        return Failure("the Mac is locked, and the keychain opens only while it is unlocked")
    default:
        let why = SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)"
        return Failure("the keychain could not \(doing): \(why)")
    }
}

struct Stored {
    let id: String
    let label: Label
}

// Every saved card by its attributes. The context forbids a prompt, so a
// list can never ask for Touch ID.
func stored() throws -> [Stored] {
    let context = LAContext()
    context.interactionNotAllowed = true
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query([kSecMatchLimit: kSecMatchLimitAll, kSecReturnAttributes: true, kSecUseAuthenticationContext: context]), &out)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = out as? [[String: Any]] else { throw keychainFailure(status, "list the cards") }
    return try items.map { item in
        let id = item[kSecAttrAccount as String] as? String ?? ""
        guard let data = item[kSecAttrGeneric as String] as? Data, let label = try? JSONDecoder().decode(Label.self, from: data) else {
            throw Failure("the saved card \(id) has no label this app can read; remove it with rm \(id)")
        }
        return Stored(id: id, label: label)
    }.sorted { $0.label.label < $1.label.label }
}

func described(_ card: Stored) -> [String: Any] {
    ["id": card.id, "label": card.label.label, "brand": card.label.brand, "last4": card.label.last4, "exp": card.label.exp, "name": card.label.name]
}

func find(_ id: String) throws -> Stored {
    guard let card = try stored().first(where: { $0.id == id }) else { throw Failure("no saved card has id \(id)") }
    return card
}

// The card goes in as a new item, and only then does the one it replaces go.
func save(_ input: [String: Any]) throws -> [String: Any] {
    let (label, secret) = try card(from: input)
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryAny, &error) else {
        throw Failure("the keychain could not make the card's access rule: \(error.map { $0.takeRetainedValue().localizedDescription } ?? "no reason given")")
    }
    let replaced = try stored().filter { $0.label.label == label.label }
    let id = UUID().uuidString
    let item: [CFString: Any] = [
        kSecAttrAccount: id,
        kSecAttrLabel: "Safari Harness card \(label.label)",
        kSecAttrGeneric: try JSONEncoder().encode(label),
        kSecAttrAccessControl: access,
        kSecValueData: try JSONEncoder().encode(secret),
    ]
    let status = SecItemAdd(query(item), nil)
    guard status == errSecSuccess else { throw keychainFailure(status, "save the card") }
    var saved = described(Stored(id: id, label: label))
    let left = replaced.filter { SecItemDelete(query([kSecAttrAccount: $0.id])) != errSecSuccess }
    if !left.isEmpty { saved["note"] = "an older card saved as \(label.label) could not be removed; remove it with rm \(left.map(\.id).joined(separator: ", "))" }
    return saved
}

// Asks Touch ID, with the reason finishing "Safari Harness Cards is trying
// to ...". The context then opens the keychain's cards without asking
// again; a password fallback cannot open them.
func authenticate(_ context: LAContext, reason: String) throws {
    var error: NSError?
    context.localizedFallbackTitle = ""
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error), context.biometryType == .touchID else {
        throw Failure("this Mac cannot ask for Touch ID: \(error?.localizedDescription ?? "Touch ID is unavailable")")
    }
    final class Reply: @unchecked Sendable {
        var approved = false
        var error: Error?
    }
    let reply = Reply()
    let answered = DispatchSemaphore(value: 0)
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, err in
        reply.approved = ok
        reply.error = err
        answered.signal()
    }
    if answered.wait(timeout: .now() + .seconds(promptSeconds)) == .timedOut {
        context.invalidate()
        _ = answered.wait(timeout: .now() + .seconds(5))
        throw Failure("nobody answered Touch ID within \(promptSeconds / 60) minutes")
    }
    if reply.approved { return }
    if let e = reply.error as? LAError, [.userCancel, .userFallback, .authenticationFailed].contains(e.code) {
        throw Failure("the user declined")
    }
    throw Failure("the Mac did not finish asking: \(reply.error?.localizedDescription ?? "no reason given")")
}

func secret(_ id: String, _ context: LAContext) throws -> [String: Any] {
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query([kSecAttrAccount: id, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne, kSecUseAuthenticationContext: context]), &out)
    guard status == errSecSuccess, let data = out as? Data else { throw keychainFailure(status, "read the card") }
    let s = try JSONDecoder().decode(Secret.self, from: data)
    return ["number": s.number, "month": s.month, "year": s.year, "csc": s.csc, "name": s.name, "zip": s.zip]
}

func remove(_ id: String) throws -> [String: Any] {
    let card = try find(id)
    try authenticate(LAContext(), reason: "remove your card \(card.label.label) from Safari Harness")
    let status = SecItemDelete(query([kSecAttrAccount: id]))
    guard status == errSecSuccess else { throw keychainFailure(status, "remove the card") }
    return described(card)
}

// The site shown in the prompt: a host name and nothing else, so a caller
// cannot word the prompt.
func hostName(_ raw: Any?) -> String {
    let host = (raw as? String ?? "").lowercased()
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-")
    return !host.isEmpty && host.count <= 100 && host.unicodeScalars.allSatisfy(allowed.contains) ? host : "a checkout page"
}

// One process holds one approval: the caller keeps this running while it
// fills cards, and a read past the approval's 5 minutes asks again. Card
// data stays in no variable past the answer that carries it.
func serve() -> Never {
    var context: LAContext?
    var approvedAt = Date.distantPast
    while let text = readLine() {
        var reply: [String: Any]
        do {
            guard let request = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], let id = request["read"] as? String else {
                throw Failure("each line must be {\"read\": ID, \"site\": HOST}")
            }
            let card = try find(id)
            if let old = context, Date().timeIntervalSince(approvedAt) >= approvalSeconds {
                old.invalidate()
                context = nil
            }
            let open: LAContext
            if let current = context {
                open = current
            } else {
                open = LAContext()
                try authenticate(open, reason: "fill your card \(card.label.label) on \(hostName(request["site"])), and approve card fills for the next 5 minutes")
                context = open
                approvedAt = Date()
            }
            reply = ["card": try secret(id, open)]
        } catch {
            reply = ["error": messageOf(error)]
        }
        FileHandle.standardOutput.write(jsonLine(reply))
    }
    context?.invalidate()
    exit(0)
}

// ---------- the window that adds a card ----------

// The user types a card at the Mac, into fields whose text the rest of the
// system cannot read back: the number and security code go in secure fields,
// which also keep other apps from reading the keys as they are typed.
@MainActor
final class AddCard: NSObject, NSWindowDelegate {
    private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    private let number = NSSecureTextField()
    private let exp = NSTextField()
    private let csc = NSSecureTextField()
    private let name = NSTextField()
    private let zip = NSTextField()
    private let label = NSTextField()
    private let message = NSTextField(wrappingLabelWithString: "Kept in this Mac's keychain. An agent fills it in after you approve with Touch ID, and never sees its number.")
    private var finished = false

    init(label given: String) {
        super.init()
        label.stringValue = given
        exp.placeholderString = "MM/YY"
        zip.placeholderString = "optional"
        label.placeholderString = "optional, e.g. work Amex"
        let rows: [(String, NSTextField)] = [("Card number", number), ("Expires", exp), ("Security code", csc), ("Name on card", name), ("Billing ZIP", zip), ("Label", label)]
        let grid = NSGridView(views: rows.map { [NSTextField(labelWithString: $0.0), $0.1] })
        grid.column(at: 0).xPlacement = .trailing
        grid.rowAlignment = .firstBaseline
        for (_, field) in rows { field.widthAnchor.constraint(equalToConstant: 260).isActive = true }
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelled))
        cancel.keyEquivalent = "\u{1b}"
        let save = NSButton(title: "Save Card", target: self, action: #selector(saved))
        save.keyEquivalent = "\r"
        message.preferredMaxLayoutWidth = 400
        let stack = NSStackView(views: [message, grid, NSStackView(views: [cancel, save])])
        stack.orientation = .vertical
        stack.alignment = .trailing
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        window.contentView = stack
        window.title = "Add a Card for Safari Harness"
        window.level = .floating
        window.isReleasedWhenClosed = false
        window.delegate = self
    }

    func show() {
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(number)
        NSApp.activate()
        // A window nobody answers goes after 10 minutes.
        Timer.scheduledTimer(withTimeInterval: 600, repeats: false) { _ in
            MainActor.assumeIsolated { self.finish(["cancelled": true]) }
        }
    }

    @objc private func saved() {
        do {
            let card = try save(["number": number.stringValue, "exp": exp.stringValue, "csc": csc.stringValue, "name": name.stringValue, "zip": zip.stringValue, "label": label.stringValue])
            finish(["saved": card])
        } catch {
            message.stringValue = messageOf(error)
            message.textColor = .systemRed
        }
    }

    @objc private func cancelled() {
        finish(["cancelled": true])
    }

    func windowWillClose(_ notification: Notification) {
        finish(["cancelled": true])
    }

    private func finish(_ result: [String: Any]) {
        guard !finished else { return }
        finished = true
        FileHandle.standardOutput.write(jsonLine(result))
        exit(0)
    }
}

// ---------- main ----------

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "list":
    answer { ["cards": try stored().map(described)] }
case "save":
    answer {
        guard let input = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any] else {
            throw Failure("save reads the card as a JSON object on stdin")
        }
        return ["saved": try save(input)]
    }
case "rm":
    guard args.count == 2 else { fail("usage: Safari Harness Cards rm ID", 2) }
    answer { ["removed": try remove(args[1])] }
case "serve":
    serve()
case "add":
    let given = args.firstIndex(of: "--label").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? ""
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let window = AddCard(label: given)
        window.show()
        app.run()
    }
default:
    fail("usage: Safari Harness Cards list | save | add [--label L] | rm ID | serve", 2)
}
