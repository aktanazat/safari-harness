// Prints the CGWindowID of Safari's frontmost normal window, so
// `screencapture -l<id>` can grab exactly that window.
// Usage: winshot [ownerName]   (default: Safari)
import CoreGraphics
import Foundation

let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Safari"

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let infoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("no window list\n".data(using: .utf8)!)
    exit(2)
}

for info in infoList {
    guard let ownerName = info[kCGWindowOwnerName as String] as? String, ownerName == owner else { continue }
    guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
    guard let wid = info[kCGWindowNumber as String] as? Int else { continue }
    let name = info[kCGWindowName as String] as? String ?? ""
    print(wid)
    FileHandle.standardError.write("\(wid) \(name)\n".data(using: .utf8)!)
    exit(0)
}

FileHandle.standardError.write("no visible \(owner) window\n".data(using: .utf8)!)
exit(1)
