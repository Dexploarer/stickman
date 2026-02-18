import AppKit
import Foundation
import SwiftUI
import WebKit

private let defaultDashboardURL = URL(string: "http://localhost:8787")!
private let defaultProjectRoot = FileManager.default.currentDirectoryPath
private let nodeCandidates = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
]
private let bunCandidates = [
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
  "/Users/home/.bun/bin/bun",
]

@MainActor
final class LocalServerManager: ObservableObject {
  @Published var projectRoot: String
  @Published var statusText: String = "stopped"
  @Published var lastOutput: String = "Server not started."
  @Published var isRunning = false

  private var process: Process?
  private var stdoutPipe: Pipe?
  private var stderrPipe: Pipe?

  init(projectRoot: String) {
    self.projectRoot = projectRoot
  }

  func start() {
    if process?.isRunning == true {
      return
    }

    if isPortListening(8787) {
      statusText = "running (external)"
      appendOutput("Port 8787 already has a running server. Using existing instance.\n")
      return
    }

    let rootPath = NSString(string: projectRoot).expandingTildeInPath
    var isDir: ObjCBool = false
    if !FileManager.default.fileExists(atPath: rootPath, isDirectory: &isDir) || !isDir.boolValue {
      statusText = "invalid project path"
      lastOutput = "Project root not found: \(rootPath)"
      return
    }

    let newProcess = Process()
    let bundledServerPath = Bundle.main.resourceURL?.appendingPathComponent("server.mjs").path
    let hasBundledServer = bundledServerPath.map { FileManager.default.fileExists(atPath: $0) } ?? false

    if hasBundledServer {
      guard let nodePath = resolveNodePath(), let serverPath = bundledServerPath else {
        statusText = "node not found"
        lastOutput = "Bundled server exists but Node is unavailable. Set POD_NODE_PATH."
        return
      }
      newProcess.executableURL = URL(fileURLWithPath: nodePath)
      newProcess.arguments = [serverPath]
      appendOutput("Using bundled server at \(serverPath)\n")
    } else {
      guard let bunPath = resolveBunPath() else {
        statusText = "bun not found"
        lastOutput = "Install Bun or set POD_BUN_PATH."
        return
      }
      newProcess.executableURL = URL(fileURLWithPath: bunPath)
      newProcess.arguments = ["src/server.ts"]
      appendOutput("Using source server with Bun at \(bunPath)\n")
    }
    newProcess.currentDirectoryURL = URL(fileURLWithPath: rootPath, isDirectory: true)

    var env = ProcessInfo.processInfo.environment
    let existingPath = env["PATH"] ?? ""
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/Users/home/.bun/bin:\(existingPath)"
    env["POD_SUITE_ROOT"] = rootPath
    let nodeModulesPath = URL(fileURLWithPath: rootPath, isDirectory: true).appendingPathComponent("node_modules").path
    let existingNodePath = (env["NODE_PATH"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if existingNodePath.isEmpty {
      env["NODE_PATH"] = nodeModulesPath
    } else if !existingNodePath.split(separator: ":").contains(Substring(nodeModulesPath)) {
      env["NODE_PATH"] = "\(nodeModulesPath):\(existingNodePath)"
    }
    newProcess.environment = env

    let out = Pipe()
    let err = Pipe()
    stdoutPipe = out
    stderrPipe = err
    newProcess.standardOutput = out
    newProcess.standardError = err

    out.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
        return
      }
      Task { @MainActor in
        self?.appendOutput(text)
      }
    }

    err.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
        return
      }
      Task { @MainActor in
        self?.appendOutput(text)
      }
    }

    newProcess.terminationHandler = { [weak self] terminated in
      Task { @MainActor in
        guard let self else {
          return
        }
        self.isRunning = false
        self.statusText = "stopped (exit \(terminated.terminationStatus))"
        self.cleanupPipes()
        self.process = nil
      }
    }

    do {
      try newProcess.run()
      process = newProcess
      isRunning = true
      statusText = "running"
      appendOutput("Started local server process.\n")
    } catch {
      statusText = "failed to start"
      appendOutput("Failed to launch server: \(error.localizedDescription)\n")
      cleanupPipes()
      process = nil
    }
  }

  func stop() {
    guard let active = process else {
      return
    }
    if active.isRunning {
      active.terminate()
      statusText = "stopping"
    }
    cleanupPipes()
    process = nil
    isRunning = false
  }

  func restart() {
    stop()
    start()
  }

  private func appendOutput(_ text: String) {
    let next = (lastOutput + text)
    if next.count > 12000 {
      lastOutput = String(next.suffix(12000))
    } else {
      lastOutput = next
    }
  }

  private func cleanupPipes() {
    stdoutPipe?.fileHandleForReading.readabilityHandler = nil
    stderrPipe?.fileHandleForReading.readabilityHandler = nil
    stdoutPipe = nil
    stderrPipe = nil
  }

  private func resolveBunPath() -> String? {
    let env = ProcessInfo.processInfo.environment
    if let fromEnv = env["POD_BUN_PATH"], FileManager.default.isExecutableFile(atPath: fromEnv) {
      return fromEnv
    }

    for candidate in bunCandidates where FileManager.default.isExecutableFile(atPath: candidate) {
      return candidate
    }

    let pathValue = env["PATH"] ?? ""
    for segment in pathValue.split(separator: ":") {
      let candidate = "\(segment)/bun"
      if FileManager.default.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }
    return nil
  }

  private func resolveNodePath() -> String? {
    let env = ProcessInfo.processInfo.environment
    if let fromEnv = env["POD_NODE_PATH"], FileManager.default.isExecutableFile(atPath: fromEnv) {
      return fromEnv
    }

    for candidate in nodeCandidates where FileManager.default.isExecutableFile(atPath: candidate) {
      return candidate
    }

    let pathValue = env["PATH"] ?? ""
    for segment in pathValue.split(separator: ":") {
      let candidate = "\(segment)/node"
      if FileManager.default.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }
    return nil
  }

  private func isPortListening(_ port: Int) -> Bool {
    let checker = Process()
    checker.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    checker.arguments = ["-n", "-P", "-iTCP:\(port)", "-sTCP:LISTEN"]
    checker.standardOutput = Pipe()
    checker.standardError = Pipe()
    do {
      try checker.run()
      checker.waitUntilExit()
      return checker.terminationStatus == 0
    } catch {
      return false
    }
  }
}

final class WebViewStore: ObservableObject {
  @Published var targetURL: URL = defaultDashboardURL
  let webView = WKWebView()
}

struct BrowserTab: Identifiable, Hashable {
  let id: UUID
  var title: String
  var url: String
  var pinnedToMission: Bool

  init(
    id: UUID = UUID(),
    title: String,
    url: String,
    pinnedToMission: Bool = false
  ) {
    self.id = id
    self.title = title
    self.url = url
    self.pinnedToMission = pinnedToMission
  }
}

struct WebContainer: NSViewRepresentable {
  @ObservedObject var store: WebViewStore

  func makeNSView(context: Context) -> WKWebView {
    store.webView.load(URLRequest(url: store.targetURL))
    return store.webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    if webView.url?.absoluteString != store.targetURL.absoluteString {
      webView.load(URLRequest(url: store.targetURL))
    }
  }
}

struct ContentView: View {
  @StateObject private var webStore = WebViewStore()
  @StateObject private var serverManager: LocalServerManager

  @State private var inputURL = defaultDashboardURL.absoluteString
  @State private var projectRootInput: String
  @State private var providerStatusText = "Provider status not loaded."
  @State private var extensionsStatusText = "Extension status not loaded."
  @State private var autonomyStatusText = "Autonomy status not loaded."
  @State private var approvalsStatusText = "Approvals not loaded."
  @State private var skillsStatusText = "Skills not loaded."
  @State private var tasksStatusText = "Tasks not loaded."
  @State private var macStatusText = "Mac app status not loaded."
  @State private var watchStatusText = "Watch status not loaded."
  @State private var integrationsStatusText = "Integration status not loaded."
  @State private var integrationActionStatusText = "Integration actions not run."
  @State private var bridgeStatusText = "Bridge status not loaded."
  @State private var badgeCodingReady = false
  @State private var badgeSocialReady = false
  @State private var badgeWatchReady = false
  @State private var badgeClaudeSession = false
  @State private var badgeCodexAvailable = false
  @State private var badgeLivekitConfigured = false
  @State private var approvalId = ""
  @State private var selectedSkillId = "codex.run_task"
  @State private var selectedWatchSource = "embedded-browser"
  @State private var selectedWatchSessionId = ""
  @State private var browserTabs: [BrowserTab]
  @State private var activeBrowserTabId: UUID
  @State private var newTabURL = defaultDashboardURL.absoluteString
  @State private var embeddedSnapshotTimer: Timer?
  @State private var integrationPollTimer: Timer?

  init() {
    let savedRoot = UserDefaults.standard.string(forKey: "PODProjectRoot")
    let root = savedRoot ?? ProcessInfo.processInfo.environment["POD_SUITE_ROOT"] ?? defaultProjectRoot
    let initialTab = BrowserTab(title: "Dashboard", url: defaultDashboardURL.absoluteString, pinnedToMission: true)
    _projectRootInput = State(initialValue: root)
    _browserTabs = State(initialValue: [initialTab])
    _activeBrowserTabId = State(initialValue: initialTab.id)
    _serverManager = StateObject(wrappedValue: LocalServerManager(projectRoot: root))
  }

  private func performRequest(
    path: String,
    method: String = "GET",
    body: [String: Any]? = nil
  ) async -> String {
    guard let base = URL(string: inputURL), let url = URL(string: path, relativeTo: base) else {
      return "Invalid dashboard URL."
    }

    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 30

    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [])
    }

    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      let text = String(data: data, encoding: .utf8) ?? ""
      return "[\(statusCode)] \(text)"
    } catch {
      return "Request failed: \(error.localizedDescription)"
    }
  }

  private func performJSONRequest(
    path: String,
    method: String = "GET",
    body: [String: Any]? = nil
  ) async -> (status: Int, json: [String: Any]?, text: String) {
    guard let base = URL(string: inputURL), let url = URL(string: path, relativeTo: base) else {
      return (0, nil, "Invalid dashboard URL.")
    }

    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 30

    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [])
    }

    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      let text = String(data: data, encoding: .utf8) ?? ""
      let jsonObject = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
      return (statusCode, jsonObject, "[\(statusCode)] \(text)")
    } catch {
      return (0, nil, "Request failed: \(error.localizedDescription)")
    }
  }

  private func applyIntegrationSnapshot(_ json: [String: Any]) {
    let integrations = json["integrations"] as? [String: Any]
    let readiness = integrations?["readiness"] as? [String: Any]
    let claude = integrations?["claude"] as? [String: Any]
    let codex = integrations?["codex"] as? [String: Any]
    let livekit = integrations?["livekit"] as? [String: Any]

    badgeCodingReady = readiness?["codingAgentReady"] as? Bool ?? false
    badgeSocialReady = readiness?["socialAgentReady"] as? Bool ?? false
    badgeWatchReady = readiness?["watchReady"] as? Bool ?? false
    badgeClaudeSession = claude?["sessionDetected"] as? Bool ?? false
    badgeCodexAvailable = codex?["available"] as? Bool ?? false
    badgeLivekitConfigured = livekit?["configured"] as? Bool ?? false
  }

  private func refreshIntegrationStatus() {
    Task {
      let integrations = await performJSONRequest(path: "/api/integrations/status")
      integrationsStatusText = integrations.text
      if let json = integrations.json {
        applyIntegrationSnapshot(json)
      }
      let bridge = await performRequest(path: "/api/integrations/bridge/status")
      bridgeStatusText = bridge
    }
  }

  private func runIntegrationRunbook(_ actionId: String) {
    Task {
      let dryRun = await performJSONRequest(
        path: "/api/integrations/actions",
        method: "POST",
        body: [
          "mode": "dry_run",
          "actionId": actionId,
          "params": [
            "sourceId": "embedded-browser",
            "fps": 2,
          ],
        ]
      )
      integrationActionStatusText = dryRun.text
      guard dryRun.status == 200,
        let json = dryRun.json,
        let confirmToken = json["confirmToken"] as? String,
        !confirmToken.isEmpty
      else {
        return
      }

      let execute = await performJSONRequest(
        path: "/api/integrations/actions",
        method: "POST",
        body: [
          "mode": "execute",
          "actionId": actionId,
          "params": [
            "sourceId": "embedded-browser",
            "fps": 2,
          ],
          "confirmToken": confirmToken,
        ]
      )
      integrationActionStatusText = execute.text
      refreshIntegrationStatus()
    }
  }

  private func badgePill(_ label: String, _ ok: Bool) -> some View {
    Text("\(label): \(ok ? "ready" : "blocked")")
      .font(.system(.caption2, design: .monospaced))
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(ok ? Color.green.opacity(0.2) : Color.red.opacity(0.2))
      .clipShape(Capsule())
  }

  private var activeTab: BrowserTab? {
    browserTabs.first(where: { $0.id == activeBrowserTabId })
  }

  private func openTab(_ tab: BrowserTab) {
    inputURL = tab.url
    if let parsed = URL(string: tab.url) {
      webStore.targetURL = parsed
    }
  }

  private func addBrowserTab(url: String) {
    let normalized = url.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return }
    let tab = BrowserTab(
      title: normalized.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: ""),
      url: normalized
    )
    browserTabs.append(tab)
    activeBrowserTabId = tab.id
    openTab(tab)
  }

  private func closeActiveTab() {
    guard let index = browserTabs.firstIndex(where: { $0.id == activeBrowserTabId }) else { return }
    if browserTabs[index].pinnedToMission {
      return
    }
    browserTabs.remove(at: index)
    if let fallback = browserTabs.last {
      activeBrowserTabId = fallback.id
      openTab(fallback)
    }
  }

  private func togglePinActiveTab() {
    guard let index = browserTabs.firstIndex(where: { $0.id == activeBrowserTabId }) else { return }
    browserTabs[index].pinnedToMission.toggle()
  }

  private func reloadActiveTab() {
    webStore.webView.reload()
  }

  private func sendActiveTabToAgent() {
    guard let tab = activeTab else { return }
    Task {
      let response = await performRequest(
        path: "/api/agent/tasks",
        method: "POST",
        body: [
          "prompt": "Analyze embedded tab context for mission work: \(tab.url)",
          "skillId": "browser.embedded.open_tab",
          "args": ["url": tab.url],
        ]
      )
      tasksStatusText = response
    }
  }

  private func pushEmbeddedWatchFrame() {
    guard selectedWatchSource == "embedded-browser" else { return }
    let config = WKSnapshotConfiguration()
    webStore.webView.takeSnapshot(with: config) { image, _ in
      guard let image,
        let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let pngData = bitmap.representation(using: .png, properties: [:])
      else {
        return
      }
      let encoded = pngData.base64EncodedString()
      Task {
        _ = await performRequest(
          path: "/api/watch/frame",
          method: "POST",
          body: [
            "sourceId": "embedded-browser",
            "frame": "data:image/png;base64,\(encoded)",
          ]
        )
      }
    }
  }

  var body: some View {
    VStack(spacing: 10) {
      HStack(spacing: 10) {
        Text("Server: \(serverManager.statusText)")
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(serverManager.isRunning ? .green : .secondary)
        Spacer()
        Button("Start") {
          serverManager.projectRoot = projectRootInput
          UserDefaults.standard.set(projectRootInput, forKey: "PODProjectRoot")
          serverManager.start()
        }
        .disabled(serverManager.isRunning)
        Button("Restart") {
          serverManager.projectRoot = projectRootInput
          UserDefaults.standard.set(projectRootInput, forKey: "PODProjectRoot")
          serverManager.restart()
        }
        Button("Stop") {
          serverManager.stop()
        }
        .disabled(!serverManager.isRunning)
      }

      HStack(spacing: 8) {
        badgePill("coding-agent", badgeCodingReady)
        badgePill("social-agent", badgeSocialReady)
        badgePill("watch", badgeWatchReady)
        badgePill("claude-session", badgeClaudeSession)
        badgePill("codex", badgeCodexAvailable)
        badgePill("livekit", badgeLivekitConfigured)
        Spacer()
      }

      HStack(spacing: 10) {
        TextField("Project root", text: $projectRootInput)
          .textFieldStyle(.roundedBorder)
        Button("Apply Path") {
          serverManager.projectRoot = projectRootInput
          UserDefaults.standard.set(projectRootInput, forKey: "PODProjectRoot")
        }
      }

      HStack(spacing: 10) {
        TextField("Dashboard URL", text: $inputURL)
          .textFieldStyle(.roundedBorder)
        Button("Open Dashboard") {
          if let parsed = URL(string: inputURL) {
            webStore.targetURL = parsed
            if let index = browserTabs.firstIndex(where: { $0.id == activeBrowserTabId }) {
              browserTabs[index].url = parsed.absoluteString
              browserTabs[index].title = parsed.host ?? parsed.absoluteString
            }
          }
        }
        Button("New Tab") {
          addBrowserTab(url: newTabURL)
        }
        Button("Open in Chrome") {
          if let parsed = URL(string: inputURL) {
            Task {
              macStatusText = await performRequest(
                path: "/api/mac/apps/open",
                method: "POST",
                body: [
                  "appId": "chrome",
                  "url": parsed.absoluteString,
                ]
              )
            }
          }
        }
      }

      HStack(spacing: 10) {
        TextField("New tab URL", text: $newTabURL)
          .textFieldStyle(.roundedBorder)
        Button("Reload Active") {
          reloadActiveTab()
        }
        Button("Pin/Unpin Mission") {
          togglePinActiveTab()
        }
        Button("Send Tab to Agent") {
          sendActiveTabToAgent()
        }
        Button("Close Active") {
          closeActiveTab()
        }
      }

      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          ForEach(browserTabs) { tab in
            Button(tab.pinnedToMission ? "[Pinned] \(tab.title)" : tab.title) {
              activeBrowserTabId = tab.id
              openTab(tab)
            }
            .buttonStyle(.borderedProminent)
            .tint(tab.id == activeBrowserTabId ? .blue : .gray)
          }
        }
      }

      HStack(alignment: .top, spacing: 10) {
        GroupBox("Integrations") {
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
              Button("Refresh Integrations") {
                refreshIntegrationStatus()
              }
              Button("Prepare Workspace") {
                runIntegrationRunbook("prepare_observer_workspace")
              }
              Button("Launch Watch") {
                runIntegrationRunbook("launch_watch_surface")
              }
              Button("Repair Provider") {
                runIntegrationRunbook("repair_provider_route")
              }
              Button("Recover LiveKit") {
                runIntegrationRunbook("recover_livekit_bridge")
              }
            }
            ScrollView {
              Text(integrationsStatusText + "\n\n" + integrationActionStatusText + "\n\n" + bridgeStatusText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .textSelection(.enabled)
            }
            .frame(height: 72)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)

        GroupBox("Provider") {
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
              Button("Refresh") {
                Task {
                  providerStatusText = await performRequest(path: "/api/providers/status")
                }
              }
              Button("Start Claude Login") {
                Task {
                  providerStatusText = await performRequest(path: "/api/claude/login/start", method: "POST", body: [:])
                }
              }
              Button("Check Claude Session") {
                Task {
                  providerStatusText = await performRequest(path: "/api/claude/login/status")
                }
              }
            }
            ScrollView {
              Text(providerStatusText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .textSelection(.enabled)
            }
            .frame(height: 72)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)

        GroupBox("Extensions + Autonomy") {
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
              Button("Refresh Ext") {
                Task {
                  extensionsStatusText = await performRequest(path: "/api/extensions")
                }
              }
              Button("Enable X") {
                Task {
                  extensionsStatusText = await performRequest(path: "/api/extensions/x-social/enable", method: "POST", body: [:])
                }
              }
              Button("Disable X") {
                Task {
                  extensionsStatusText = await performRequest(path: "/api/extensions/x-social/disable", method: "POST", body: [:])
                }
              }
              Button("Enable Code") {
                Task {
                  extensionsStatusText = await performRequest(path: "/api/extensions/code-workspace/enable", method: "POST", body: [:])
                }
              }
              Button("Disable Code") {
                Task {
                  extensionsStatusText = await performRequest(path: "/api/extensions/code-workspace/disable", method: "POST", body: [:])
                }
              }
            }
            HStack(spacing: 8) {
              Button("Autonomy On") {
                Task {
                  autonomyStatusText = await performRequest(
                    path: "/api/agent/autonomy",
                    method: "POST",
                    body: ["enabled": true]
                  )
                }
              }
              Button("Autonomy Off") {
                Task {
                  autonomyStatusText = await performRequest(
                    path: "/api/agent/autonomy",
                    method: "POST",
                    body: ["enabled": false]
                  )
                }
              }
              Button("Refresh Auto") {
                Task {
                  autonomyStatusText = await performRequest(path: "/api/agent/autonomy")
                }
              }
            }
            ScrollView {
              Text(extensionsStatusText + "\n\n" + autonomyStatusText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .textSelection(.enabled)
            }
            .frame(height: 72)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)

        GroupBox("Approvals") {
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
              TextField("Approval ID", text: $approvalId)
                .textFieldStyle(.roundedBorder)
              Button("Refresh Queue") {
                Task {
                  approvalsStatusText = await performRequest(path: "/api/agent/approvals")
                }
              }
            }
            HStack(spacing: 8) {
              Button("Approve") {
                let id = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !id.isEmpty else { return }
                Task {
                  approvalsStatusText = await performRequest(
                    path: "/api/agent/approvals/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/approve",
                    method: "POST",
                    body: [:]
                  )
                }
              }
              Button("Reject") {
                let id = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !id.isEmpty else { return }
                Task {
                  approvalsStatusText = await performRequest(
                    path: "/api/agent/approvals/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/reject",
                    method: "POST",
                    body: [:]
                  )
                }
              }
            }
            ScrollView {
              Text(approvalsStatusText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .textSelection(.enabled)
            }
            .frame(height: 72)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)

        GroupBox("Skills + Tasks + Watch") {
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
              TextField("Skill ID", text: $selectedSkillId)
                .textFieldStyle(.roundedBorder)
              Button("Run Skill") {
                Task {
                  skillsStatusText = await performRequest(
                    path: "/api/skills/run",
                    method: "POST",
                    body: [
                      "skillId": selectedSkillId,
                      "args": ["prompt": "Run from native panel"],
                    ]
                  )
                }
              }
              Button("Refresh Skills") {
                Task {
                  skillsStatusText = await performRequest(path: "/api/skills")
                }
              }
            }
            HStack(spacing: 8) {
              Button("Create Task") {
                Task {
                  tasksStatusText = await performRequest(
                    path: "/api/agent/tasks",
                    method: "POST",
                    body: [
                      "prompt": "Open Antigravity and prep workspace context",
                      "skillId": selectedSkillId,
                    ]
                  )
                }
              }
              Button("Refresh Tasks") {
                Task {
                  tasksStatusText = await performRequest(path: "/api/agent/tasks")
                }
              }
              Button("Refresh Mac/Watch") {
                Task {
                  let apps = await performRequest(path: "/api/mac/apps")
                  let watch = await performRequest(path: "/api/watch/sources")
                  macStatusText = apps
                  watchStatusText = watch
                }
              }
            }
            HStack(spacing: 8) {
              TextField("Watch Source", text: $selectedWatchSource)
                .textFieldStyle(.roundedBorder)
              Button("Start Watch") {
                Task {
                  watchStatusText = await performRequest(
                    path: "/api/watch/start",
                    method: "POST",
                    body: [
                      "sourceId": selectedWatchSource,
                    ]
                  )
                  if let start = watchStatusText.range(of: "\"id\":\""),
                    let end = watchStatusText[start.upperBound...].firstIndex(of: "\"")
                  {
                    selectedWatchSessionId = String(watchStatusText[start.upperBound..<end])
                  }
                }
              }
              Button("Stop Watch") {
                Task {
                  watchStatusText = await performRequest(
                    path: "/api/watch/stop",
                    method: "POST",
                    body: [
                      "sessionId": selectedWatchSessionId,
                    ]
                  )
                }
              }
            }
            ScrollView {
              Text(skillsStatusText + "\n\n" + tasksStatusText + "\n\n" + macStatusText + "\n\n" + watchStatusText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .font(.system(size: 10, weight: .regular, design: .monospaced))
                .textSelection(.enabled)
            }
            .frame(height: 72)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
      }

      WebContainer(store: webStore)

      ScrollView {
        Text(serverManager.lastOutput)
          .frame(maxWidth: .infinity, alignment: .leading)
          .font(.system(size: 11, weight: .regular, design: .monospaced))
          .textSelection(.enabled)
          .padding(8)
      }
      .frame(height: 140)
      .background(Color.black.opacity(0.06))
      .clipShape(RoundedRectangle(cornerRadius: 8))
    }
    .padding(12)
    .frame(minWidth: 1100, minHeight: 760)
    .onAppear {
      serverManager.projectRoot = projectRootInput
      serverManager.start()
      if let parsed = URL(string: inputURL) {
        webStore.targetURL = parsed
      }
      Task {
        providerStatusText = await performRequest(path: "/api/providers/status")
        extensionsStatusText = await performRequest(path: "/api/extensions")
        autonomyStatusText = await performRequest(path: "/api/agent/autonomy")
        approvalsStatusText = await performRequest(path: "/api/agent/approvals")
        skillsStatusText = await performRequest(path: "/api/skills")
        tasksStatusText = await performRequest(path: "/api/agent/tasks")
        macStatusText = await performRequest(path: "/api/mac/apps")
        watchStatusText = await performRequest(path: "/api/watch/sources")
        let integrations = await performJSONRequest(path: "/api/integrations/status")
        integrationsStatusText = integrations.text
        if let json = integrations.json {
          applyIntegrationSnapshot(json)
        }
        bridgeStatusText = await performRequest(path: "/api/integrations/bridge/status")
      }
      embeddedSnapshotTimer?.invalidate()
      embeddedSnapshotTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
        pushEmbeddedWatchFrame()
      }
      integrationPollTimer?.invalidate()
      integrationPollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
        refreshIntegrationStatus()
      }
    }
    .onDisappear {
      embeddedSnapshotTimer?.invalidate()
      embeddedSnapshotTimer = nil
      integrationPollTimer?.invalidate()
      integrationPollTimer = nil
      serverManager.stop()
    }
  }
}

@main
struct PromptOrDieSocialSuiteNativeApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}
