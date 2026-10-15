// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BalabolConversation",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "Conversation", targets: ["Conversation"]),
    .library(name: "Voice", targets: ["Voice"]),
  ],
  dependencies: [
    .package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.17.0"),
    .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager.git", exact: "1.24.2")
  ],
  targets: [
    .target(name: "Conversation"),
    .target(
      name: "Voice",
      dependencies: [
        "Conversation",
        .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager"),
        .product(name: "LiveKit", package: "client-sdk-swift", condition: .when(platforms: [.iOS])),
      ]),
    .testTarget(name: "VoiceTests", dependencies: ["Voice", "Conversation"]),
    .testTarget(name: "ConversationTests", dependencies: ["Conversation"]),
  ]
)
