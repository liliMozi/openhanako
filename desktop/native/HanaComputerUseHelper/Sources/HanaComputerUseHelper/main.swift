import AppKit
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
    static func main() {
        do {
            try run()
        } catch let err as HelperError {
            fputs(err.message + "\n", stderr)
            Foundation.exit(err.code)
        } catch {
            fputs("hana-computer-use-helper failed: \(error)\n", stderr)
            Foundation.exit(ExitCode.software)
        }
    }

    private static func run() throws {
        var args = Array(CommandLine.arguments.dropFirst())
        let compact = args.removeAllFlags(["--compact"])
        let raw = args.removeAllFlags(["--raw"])
        let socketPath = args.removeOptionValue("--socket") ?? defaultDaemonSocketPath()

        guard let command = args.first else {
            printHelp()
            throw HelperError(code: ExitCode.usage, message: "Missing command.")
        }
        args.removeFirst()

        switch command {
        case "status":
            guard DaemonClient.isDaemonListening(socketPath: socketPath) else {
                throw HelperError(code: ExitCode.toolError, message: "hana-computer-use-helper daemon is not running on \(socketPath).")
            }
            print("hana-computer-use-helper daemon running; CuaDriverCore \(CuaDriverCore.version)\n  socket: \(socketPath)")
        case "serve":
            let exitCode = AppKitBootstrap.runBlockingAppKitWith {
                await runDaemon(socketPath: socketPath)
            }
            Foundation.exit(exitCode)
        case "stop":
            try stopDaemon(socketPath: socketPath)
        case "version", "--version":
            print(CuaDriverCore.version)
        case "list-tools":
            if !emitToolsFromDaemon(socketPath: socketPath, compact: compact) {
                try emitTools(compact: compact)
            }
        case "--help", "help":
            printHelp()
        default:
            let toolName = command
            let toolArgs = args
            let toolRaw = raw
            let toolCompact = compact
            let toolSocketPath = socketPath
            let exitCode = AppKitBootstrap.runBlockingAppKitWith {
                await runToolProcess(toolName, args: toolArgs, raw: toolRaw, compact: toolCompact, socketPath: toolSocketPath)
            }
            Foundation.exit(exitCode)
        }
    }

    private static func runToolProcess(_ name: String, args: [String], raw: Bool, compact: Bool, socketPath: String) async -> Int32 {
        do {
            try await callTool(name, args: args, raw: raw, compact: compact, socketPath: socketPath)
            return 0
        } catch let err as HelperError {
            fputs(err.message + "\n", stderr)
            return err.code
        } catch {
            fputs("hana-computer-use-helper failed: \(error)\n", stderr)
            return ExitCode.software
        }
    }

    private static func callTool(_ name: String, args: [String], raw: Bool, compact: Bool, socketPath: String) async throws {
        let arguments = try decodeArguments(args.first)
        guard ToolRegistry.default.handlers[name] != nil else {
            throw HelperError(code: ExitCode.usage, message: "Unknown tool: \(name)")
        }

        if try emitToolCallFromDaemon(name, arguments: arguments, socketPath: socketPath, raw: raw, compact: compact) {
            return
        }

        let config = await ConfigStore.shared.load()
        await MainActor.run {
            AgentCursor.shared.apply(config: config.agentCursor)
            applyHanaCursorRuntimeConfig(from: ProcessInfo.processInfo.environment)
        }

        let result: CallTool.Result
        do {
            result = try await ToolRegistry.default.call(name, arguments: arguments)
        } catch {
            throw HelperError(code: ExitCode.software, message: "Tool \(name) threw: \(error)")
        }

        try emitToolResult(result, raw: raw, compact: compact)
    }

    private static func emitToolResult(_ result: CallTool.Result, raw: Bool, compact: Bool) throws {
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

    private static func emitToolCallFromDaemon(_ name: String, arguments: [String: Value]?, socketPath: String, raw: Bool, compact: Bool) throws -> Bool {
        switch DaemonClient.sendRequest(
            DaemonRequest(method: "call", name: name, args: arguments),
            socketPath: socketPath
        ) {
        case .noDaemon:
            return false
        case .error(let message):
            throw HelperError(code: ExitCode.software, message: message)
        case .ok(let response):
            guard response.ok else {
                throw HelperError(
                    code: response.exitCode ?? ExitCode.software,
                    message: response.error ?? "hana-computer-use-helper daemon call failed."
                )
            }
            guard case .call(let result) = response.result else {
                throw HelperError(code: ExitCode.software, message: "hana-computer-use-helper daemon returned a non-call response.")
            }
            try emitToolResult(result, raw: raw, compact: compact)
            return true
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

    private static func emitToolsFromDaemon(socketPath: String, compact: Bool) -> Bool {
        switch DaemonClient.sendRequest(DaemonRequest(method: "list"), socketPath: socketPath) {
        case .ok(let response):
            guard response.ok, case .list(let tools) = response.result else { return false }
            do {
                try emit(["tools": tools.map(\.name).sorted()], compact: compact)
                return true
            } catch {
                return false
            }
        case .noDaemon, .error:
            return false
        }
    }

    private static func runDaemon(socketPath: String) async -> Int32 {
        do {
            let config = await ConfigStore.shared.load()
            await MainActor.run {
                AgentCursor.shared.apply(config: config.agentCursor)
                applyHanaCursorRuntimeConfig(from: ProcessInfo.processInfo.environment)
            }
            let server = DaemonServer(socketPath: socketPath, pidFilePath: nil)
            try await server.run()
            return 0
        } catch {
            fputs("hana-computer-use-helper daemon failed: \(error)\n", stderr)
            return ExitCode.software
        }
    }

    private static func stopDaemon(socketPath: String) throws {
        switch DaemonClient.sendRequest(DaemonRequest(method: "shutdown"), socketPath: socketPath) {
        case .ok(let response):
            guard response.ok else {
                throw HelperError(code: response.exitCode ?? ExitCode.software, message: response.error ?? "Failed to stop hana-computer-use-helper daemon.")
            }
            print("hana-computer-use-helper daemon stopped.")
        case .noDaemon:
            throw HelperError(code: ExitCode.toolError, message: "hana-computer-use-helper daemon is not running on \(socketPath).")
        case .error(let message):
            throw HelperError(code: ExitCode.software, message: message)
        }
    }

    private static func defaultDaemonSocketPath() -> String {
        let env = ProcessInfo.processInfo.environment
        if let explicit = env[hanaAgentSocketPathEnvKey], !explicit.isEmpty {
            return expandHome(explicit)
        }
        let home = env["HOME"] ?? NSHomeDirectory()
        return home + "/Library/Caches/hana-computer-use/hana-computer-use-helper.sock"
    }

    private static func expandHome(_ path: String) -> String {
        if path == "~" { return NSHomeDirectory() }
        if path.hasPrefix("~/") {
            return NSHomeDirectory() + "/" + String(path.dropFirst(2))
        }
        return path
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

private final class ExitCodeBox: @unchecked Sendable {
    var value: Int32 = 0
}

private enum AppKitBootstrap {
    static func runBlockingAppKitWith(_ work: @Sendable @escaping () async -> Int32) -> Int32 {
        let exitCode = ExitCodeBox()
        MainActor.assumeIsolated {
            NSApplication.shared.setActivationPolicy(.accessory)

            Task.detached(priority: .userInitiated) {
                let code = await work()
                await MainActor.run {
                    exitCode.value = code
                    NSApp.terminate(nil)
                }
            }

            NSApplication.shared.run()
        }
        return exitCode.value
    }
}

private let hanaAgentCursorConfigEnvKey = "HANA_AGENT_CURSOR_CONFIG_JSON"
private let hanaAgentSocketPathEnvKey = "HANA_COMPUTER_USE_SOCKET_PATH"

private struct HanaCursorRuntimeConfig: Decodable {
    let enabled: Bool?
    let style: Style?
    let motion: Motion?

    struct Style: Decodable {
        let gradientColors: [String]?
        let bloomColor: String?
        let imagePath: String?

        private enum CodingKeys: String, CodingKey {
            case gradientColors = "gradient_colors"
            case bloomColor = "bloom_color"
            case imagePath = "image_path"
        }
    }

    struct Motion: Decodable {
        let startHandle: Double?
        let endHandle: Double?
        let arcSize: Double?
        let arcFlow: Double?
        let spring: Double?
        let glideDurationMs: Double?
        let dwellAfterClickMs: Double?
        let idleHideMs: Double?

        private enum CodingKeys: String, CodingKey {
            case startHandle = "start_handle"
            case endHandle = "end_handle"
            case arcSize = "arc_size"
            case arcFlow = "arc_flow"
            case spring
            case glideDurationMs = "glide_duration_ms"
            case dwellAfterClickMs = "dwell_after_click_ms"
            case idleHideMs = "idle_hide_ms"
        }
    }
}

@MainActor
private func applyHanaCursorRuntimeConfig(from environment: [String: String]) {
    guard let raw = environment[hanaAgentCursorConfigEnvKey],
          let data = raw.data(using: .utf8),
          let config = try? JSONDecoder().decode(HanaCursorRuntimeConfig.self, from: data)
    else {
        return
    }

    if let style = config.style {
        AgentCursor.shared.applyStyleConfig(
            AgentCursorConfig.Style(
                gradientColors: style.gradientColors,
                bloomColor: style.bloomColor,
                imagePath: style.imagePath
            )
        )
    }

    if let motion = config.motion {
        var options = AgentCursor.shared.defaultMotionOptions
        if let value = motion.startHandle { options.startHandle = value }
        if let value = motion.endHandle { options.endHandle = value }
        if let value = motion.arcSize { options.arcSize = value }
        if let value = motion.arcFlow { options.arcFlow = value }
        if let value = motion.spring { options.spring = value }
        AgentCursor.shared.defaultMotionOptions = options
        if let value = motion.glideDurationMs {
            AgentCursor.shared.glideDurationSeconds = value / 1000.0
        }
        if let value = motion.dwellAfterClickMs {
            AgentCursor.shared.dwellAfterClickSeconds = value / 1000.0
        }
        if let value = motion.idleHideMs {
            AgentCursor.shared.idleHideDelay = value / 1000.0
        }
    }

    if let enabled = config.enabled {
        AgentCursor.shared.setEnabled(enabled)
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

    mutating func removeOptionValue(_ option: String) -> String? {
        if let index = firstIndex(where: { $0 == option }) {
            let valueIndex = self.index(after: index)
            guard valueIndex < endIndex else { return nil }
            let value = self[valueIndex]
            removeSubrange(index...valueIndex)
            return value
        }
        let prefix = option + "="
        if let index = firstIndex(where: { $0.hasPrefix(prefix) }) {
            let value = String(self[index].dropFirst(prefix.count))
            remove(at: index)
            return value
        }
        return nil
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
