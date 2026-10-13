// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BalabolConversation",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "Conversation", targets: ["Conversation"])],
  targets: [
    .target(name: "Conversation"),
    .testTarget(name: "ConversationTests", dependencies: ["Conversation"]),
  ]
)
