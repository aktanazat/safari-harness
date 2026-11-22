import AppKit
import ApplicationServices
import QuartzCore
import ScreenCaptureKit
import CoreMedia

@_silgen_name("_AXUIElementGetWindow")
func nativeWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

final class WindowWatch: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = WindowWatch()
    var baseline: [CGWindowID: CGRect] = [:]
    var frames: [CGWindowID: [CGRect]] = [:]
    var violations: [[String: Any]] = []
    var agents = CGRect.zero
    var physical: [CGRect] = []
    var samples = 0
    var pending: [String] = []
    var input = Data()
    var observer: AXObserver?
    var links: [CADisplayLink] = []
    var streams: [SCStream] = []
    var captureIDs: [ObjectIdentifier: CGDirectDisplayID] = [:]
    var visibleStreams: Set<ObjectIdentifier> = []
    var capturedFrames = 0
    var streamsStarted = false
    var readySent = false
    let captureAgents = CommandLine.arguments.contains("--capture-agents")
    let background = CGColor(red: 0, green: 0, blue: 0, alpha: 0)
    var waitingForPixels = false
    var safariPID: pid_t = 0
    var browserWindows: [CGWindowID: AXUIElement] = [:]

    func track(_ window: AXUIElement) {
        var id: CGWindowID = 0
        guard nativeWindow(window, &id) == .success else {
            emit(["error": "A Safari Accessibility window has no native window ID"])
            exit(1)
        }
        browserWindows[id] = window
    }

    func emit(_ value: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data([10]))
    }

    func windows() -> [CGWindowID: CGRect] {
        var result: [CGWindowID: CGRect] = [:]
        guard let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else {
            emit(["error": "Native window listing did not answer"])
            exit(1)
        }
        for info in list {
            guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == safariPID,
                  let number = info[kCGWindowNumber as String] as? NSNumber,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), !rect.isEmpty else { continue }
            let id = number.uint32Value
            let visible = (info[kCGWindowIsOnscreen as String] as? Bool) == true
                && (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
                && ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0
            guard browserWindows[id] != nil || visible else { continue }
            result[id] = rect
        }
        return result
    }

    func answer(_ command: String) {
        let now = windows()
        emit(["checkpoint": command, "samples": samples, "windows": frames.count, "frames": frames.values.reduce(0) { $0 + $1.count }, "capturedFrames": capturedFrames, "violations": violations, "remaining": now.keys.filter { baseline[$0] == nil }, "baselineUnchanged": baseline.allSatisfy { now[$0.key] == $0.value }])
    }

    func sample() {
        samples += 1
        let now = windows()
        for (id, rect) in baseline where now[id] != rect {
            if !violations.contains(where: { ($0["changedBaseline"] as? CGWindowID) == id }) {
                violations.append(["changedBaseline": id, "before": [rect.minX, rect.minY, rect.width, rect.height], "after": now[id].map { [$0.minX, $0.minY, $0.width, $0.height] } ?? []])
            }
        }
        for (id, rect) in now where baseline[id] == nil {
            if frames[id]?.last == rect { continue }
            frames[id, default: []].append(rect)
            if !agents.contains(rect) || physical.contains(where: { $0.intersects(rect) }) {
                violations.append(["window": id, "frame": [rect.minX, rect.minY, rect.width, rect.height]])
            }
        }
        if !pending.isEmpty && now.keys.allSatisfy({ baseline[$0] != nil }) {
            let commands = pending
            pending.removeAll()
            for command in commands { answer(command) }
        }
    }

    @objc func refresh(_ link: CADisplayLink) { sample() }

    func captureReady() {
        if streamsStarted && !readySent {
            readySent = true
            emit(["ready": true, "baseline": baseline.count, "agents": [agents.minX, agents.minY, agents.width, agents.height], "capturedDisplays": captureIDs.values.sorted(), "negativeControl": captureAgents])
        }
    }

    @MainActor func startStreams() async throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw NSError(domain: "window-watch", code: 1, userInfo: [NSLocalizedDescriptionKey: "Screen Recording permission is required for composited-frame proof"])
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let safari = content.applications.first(where: { $0.processID == safariPID }) else {
            throw NSError(domain: "window-watch", code: 2, userInfo: [NSLocalizedDescriptionKey: "Safari is not running"])
        }
        let excluded = content.windows.filter { baseline[$0.windowID] != nil }
        let agentIDs = Set(NSScreen.screens.filter { $0.localizedName == "Agents" }.compactMap { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value })
        for display in content.displays where agentIDs.contains(display.displayID) == captureAgents {
            let filter = SCContentFilter(display: display, including: [safari], exceptingWindows: excluded)
            let config = SCStreamConfiguration()
            config.width = display.width
            config.height = display.height
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.backgroundColor = background
            config.showsCursor = false
            config.minimumFrameInterval = CMTime(value: 1, timescale: 240)
            config.queueDepth = 8
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
            streams.append(stream)
            captureIDs[ObjectIdentifier(stream)] = display.displayID
            try await stream.startCapture()
        }
        guard !streams.isEmpty else {
            throw NSError(domain: "window-watch", code: 3, userInfo: [NSLocalizedDescriptionKey: "No display is available for composited-frame proof"])
        }
        streamsStarted = true
        captureReady()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int else {
            violations.append(["captureError": "A composited frame has no status"])
            return
        }
        if status == SCFrameStatus.suspended.rawValue {
            violations.append(["captureError": "Composited-frame capture was suspended"])
        }
        guard status == SCFrameStatus.complete.rawValue || status == SCFrameStatus.started.rawValue else { return }
        guard let pixels = CMSampleBufferGetImageBuffer(buffer),
              CVPixelBufferLockBaseAddress(pixels, .readOnly) == kCVReturnSuccess else {
            violations.append(["captureError": "Cannot read a composited frame"])
            return
        }
        defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixels),
              CVPixelBufferGetPixelFormatType(pixels) == kCVPixelFormatType_32BGRA else {
            violations.append(["captureError": "Unexpected composited-frame pixels"])
            return
        }
        let id = ObjectIdentifier(stream)
        let stride = CVPixelBufferGetBytesPerRow(pixels)
        let height = CVPixelBufferGetHeight(pixels)
        let width = CVPixelBufferGetWidth(pixels)
        capturedFrames += 1
        let visible = (0..<height).contains { row in
            UnsafeBufferPointer(start: base.advanced(by: row * stride).assumingMemoryBound(to: UInt32.self), count: width).contains { $0 & 0xff000000 != 0 }
        }
        if visible && visibleStreams.insert(id).inserted {
            violations.append(["visiblePixelsOnDisplay": captureIDs[id] ?? 0])
            if waitingForPixels {
                waitingForPixels = false
                answer("pixels")
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        violations.append(["captureError": error.localizedDescription])
        if !readySent { emit(["error": error.localizedDescription]) }
    }

    func start() {
        let primaryTop = NSScreen.screens[0].frame.maxY
        let screens = NSScreen.screens.map { screen in
            (screen.localizedName, CGRect(x: screen.frame.minX, y: primaryTop - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height))
        }
        guard let target = screens.first(where: { $0.0 == "Agents" })?.1 else {
            emit(["error": "No Agents display"])
            exit(1)
        }
        agents = target
        physical = screens.filter { $0.0 != "Agents" }.map { $0.1 }
        guard let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first else {
            emit(["error": "Safari is not running"])
            exit(1)
        }
        safariPID = safari.processIdentifier
        guard AXObserverCreate(safariPID, { observer, window, notification, _ in
                  let watch = WindowWatch.shared
                  if notification as String == kAXWindowCreatedNotification {
                      watch.track(window)
                      AXObserverAddNotification(observer, window, kAXMovedNotification as CFString, nil)
                      AXObserverAddNotification(observer, window, kAXResizedNotification as CFString, nil)
                      AXObserverAddNotification(observer, window, kAXUIElementDestroyedNotification as CFString, nil)
                  } else if notification as String == kAXUIElementDestroyedNotification,
                            let id = watch.browserWindows.first(where: { CFEqual($0.value, window) })?.key {
                      watch.browserWindows.removeValue(forKey: id)
                  }
                  watch.sample()
              }, &observer) == .success, let observer,
              AXObserverAddNotification(observer, AXUIElementCreateApplication(safari.processIdentifier), kAXWindowCreatedNotification as CFString, nil) == .success else {
            emit(["error": "Window creation observation needs Accessibility permission"])
            exit(1)
        }
        var held: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(safari.processIdentifier), kAXWindowsAttribute as CFString, &held) == .success,
              let existingWindows = held as? [AXUIElement] else {
            emit(["error": "Safari Accessibility windows could not be read"])
            exit(1)
        }
        for window in existingWindows {
            track(window)
            AXObserverAddNotification(observer, window, kAXMovedNotification as CFString, nil)
            AXObserverAddNotification(observer, window, kAXResizedNotification as CFString, nil)
            AXObserverAddNotification(observer, window, kAXUIElementDestroyedNotification as CFString, nil)
        }
        baseline = windows()
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        links = NSScreen.screens.map { $0.displayLink(target: self, selector: #selector(refresh(_:))) }
        for link in links { link.add(to: .main, forMode: .common) }
        FileHandle.standardInput.readabilityHandler = { handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                if data.isEmpty { exit(0) }
                let watch = WindowWatch.shared
                watch.input.append(data)
                while let newline = watch.input.firstIndex(of: 10) {
                    let command = String(data: watch.input.prefix(upTo: newline), encoding: .utf8) ?? ""
                    watch.input.removeSubrange(...newline)
                    watch.sample()
                    if command == "final" {
                        Task { @MainActor in
                            do {
                                for stream in WindowWatch.shared.streams { try await stream.stopCapture() }
                            } catch {
                                WindowWatch.shared.violations.append(["captureError": error.localizedDescription])
                            }
                            WindowWatch.shared.answer(command)
                        }
                    } else if command == "pixels" && watch.visibleStreams.isEmpty {
                        watch.waitingForPixels = true
                    } else if command == "empty" && watch.windows().keys.contains(where: { watch.baseline[$0] == nil }) {
                        watch.pending.append(command)
                    } else {
                        watch.answer(command)
                    }
                }
            }
        }
        Task { @MainActor in
            do { try await WindowWatch.shared.startStreams() }
            catch { WindowWatch.shared.emit(["error": error.localizedDescription]); exit(1) }
        }
    }
}

WindowWatch.shared.start()
RunLoop.main.run()
