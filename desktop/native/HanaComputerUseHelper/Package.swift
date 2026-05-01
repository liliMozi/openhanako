// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HanaComputerUseHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "hana-computer-use-helper", targets: ["HanaComputerUseHelper"]),
    ],
    dependencies: [
        .package(url: "https://github.com/trycua/cua.git", revision: "d38bfbfb6b1d4296903477f517b1a0fa54af497b"),
        .package(url: "https://github.com/modelcontextprotocol/swift-sdk.git", from: "0.9.0"),
    ],
    targets: [
        .executableTarget(
            name: "HanaComputerUseHelper",
            dependencies: [
                .product(name: "CuaDriverCore", package: "cua"),
                .product(name: "CuaDriverServer", package: "cua"),
                .product(name: "MCP", package: "swift-sdk"),
            ]
        ),
    ]
)
