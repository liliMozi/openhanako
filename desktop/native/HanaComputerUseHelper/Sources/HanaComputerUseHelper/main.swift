import CuaDriverCore
import CuaDriverServer
import Foundation
import MCP

private enum ExitCode {
    static let toolError: Int32 = 1
    static let usage: Int32 = 64
    static let dataError: Int32 = 65
    static let software: Int32 = 70
}

private struct HelperError: Error {
    let code: Int32
    let message: String
}

@main
struct HanaComputerUseHelper {
    static func main() async {
        do {
            try await run()
        } catch let err as HelperError {
            fputs(err.message + "\n", stderr)
            Foundation.exit(err.code)
        } catch {
            fputs("hana-computer-use-helper failed: \(error)\n", stderr)
            Foundation.exit(ExitCode.software)
        }
    }

    private static func run() async throws {
        var args = Array(CommandLine.arguments.dropFirst())
        let compact = args.removeAllFlags(["--compact"])
        let raw = args.removeAllFlags(["--raw"])

        guard let command = args.first else {
            printHelp()
            throw HelperError(code: ExitCode.usage, message: "Missing command.")
        }
        args.removeFirst()

        switch command {
        case "status":
            print("hana-computer-use-helper running; CuaDriverCore \(CuaDriverCore.version)")
        case "version", "--version":
            print(CuaDriverCore.version)
        case "list-tools":
            try emitTools(compact: compact)
        case "--help", "help":
            printHelp()
        default:
            try await callTool(command, args: args, raw: raw, compact: compact)
        }
    }

    private static func callTool(_ name: String, args: [String], raw: Bool, compact: Bool) async throws {
        let arguments = try decodeArguments(args.first)
        guard ToolRegistry.default.handlers[name] != nil else {
            throw HelperError(code: ExitCode.usage, message: "Unknown tool: \(name)")
        }

        let result: CallTool.Result
        do {
            result = try await ToolRegistry.default.call(name, arguments: arguments)
        } catch {
            throw HelperError(code: ExitCode.software, message: "Tool \(name) threw: \(error)")
        }

        if raw {
            try emit(result, compact: compact)
        } else if result.isError == true {
            fputs(firstText(result.content) ?? "Tool reported an error.\n", stderr)
        } else if let structured = result.structuredContent {
            try emit(structured, compact: compact)
        } else {
            print(allText(result.content))
        }

        if result.isError == true {
            throw HelperError(code: ExitCode.toolError, message: "")
        }
    }

    private static func decodeArguments(_ raw: String?) throws -> [String: Value]? {
        let source: String?
        if let raw, !raw.isEmpty {
            source = raw
        } else {
            source = nil
        }
        guard let source else { return nil }
        do {
            return try JSONDecoder().decode([String: Value].self, from: Data(source.utf8))
        } catch {
            throw HelperError(code: ExitCode.dataError, message: "Failed to parse JSON arguments: \(error)")
        }
    }

    private static func emitTools(compact: Bool) throws {
        let names = ToolRegistry.default.allTools.map(\.name).sorted()
        try emit(["tools": names], compact: compact)
    }

    private static func emit<T: Encodable>(_ value: T, compact: Bool) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = compact ? [.sortedKeys, .withoutEscapingSlashes] : [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        FileHandle.standardOutput.write(try encoder.encode(value))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    private static func printHelp() {
        print("""
        hana-computer-use-helper status
        hana-computer-use-helper list_apps '{"bundle_id":"com.apple.finder"}' --raw --compact
        hana-computer-use-helper get_window_state '{"pid":844,"window_id":10725}' --raw --compact
        """)
    }
}

private extension Array where Element == String {
    mutating func removeAllFlags(_ flags: Set<String>) -> Bool {
        var found = false
        self = filter { item in
            if flags.contains(item) {
                found = true
                return false
            }
            return true
        }
        return found
    }
}

private func firstText(_ content: [Tool.Content]) -> String? {
    for item in content {
        if case .text(let text, _, _) = item {
            return text
        }
    }
    return nil
}

private func allText(_ content: [Tool.Content]) -> String {
    content.compactMap { item in
        if case .text(let text, _, _) = item {
            return text
        }
        return nil
    }.joined(separator: "\n")
}
