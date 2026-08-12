import Foundation

enum RuntimeReporter {
    private static var logURL: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("mtc-runtime.log")
    }

    static func reset() {
        guard let logURL else { return }
        try? FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? Data().write(to: logURL, options: .atomic)
    }

    static func report(_ event: String, detail: String = "") {
        let message = "MTC_EVENT \(event)\(detail.isEmpty ? "" : " \(detail)")"
        NSLog("%@", message)
        guard let logURL, let data = "\(message)\n".data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
        } else {
            try? data.write(to: logURL, options: .atomic)
        }
    }
}
