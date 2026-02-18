// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "PromptOrDieSocialSuiteNative",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "PromptOrDieSocialSuiteNative", targets: ["PromptOrDieSocialSuiteNative"]),
  ],
  targets: [
    .executableTarget(
      name: "PromptOrDieSocialSuiteNative",
      path: "Sources/PromptOrDieSocialSuiteNative",
    ),
  ],
)
