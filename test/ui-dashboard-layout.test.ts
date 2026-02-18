import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const swiftUiSource = readFileSync(
  new URL("../native/apple/Sources/PromptOrDieSocialSuiteNative/main.swift", import.meta.url),
  "utf8"
);

const webStyles = readFileSync(
  new URL("../web/styles.css", import.meta.url),
  "utf8"
);

describe("native dashboard layout", () => {
  it("uses NavigationSplitView pane-based sections", () => {
    expect(swiftUiSource).toContain("NavigationSplitView");
    expect(swiftUiSource).toContain("private var dashboardPane: some View");
    expect(swiftUiSource).toContain("private var controlCenterPane: some View");
    expect(swiftUiSource).toContain("private var logsPane: some View");
    expect(swiftUiSource).toContain("case .dashboard:");
    expect(swiftUiSource).toContain("case .controlCenter:");
    expect(swiftUiSource).toContain("case .logs:");
    expect(swiftUiSource).toContain("@State private var paneSelection: SuitePane = .dashboard");
  });
});

describe("cowork dashboard style profile", () => {
  it("applies professional grid and lane tokens", () => {
    expect(webStyles).toContain(".cowork-grid {");
    expect(webStyles).toContain("gap: 14px;");
    expect(webStyles).toContain(
      "grid-template-columns: minmax(220px, 280px) minmax(360px, 1fr) minmax(320px, 420px);"
    );
    expect(webStyles).toContain(".cowork-lane > h3 {");
    expect(webStyles).toContain("text-transform: uppercase;");
    expect(webStyles).toContain(".cowork-chat-log {");
    expect(webStyles).toContain("justify-items: start;");
    expect(webStyles).toContain("white-space: pre-wrap;");
  });
});
