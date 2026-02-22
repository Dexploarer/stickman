import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const electronMainSource = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
const dashboardAppSource = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const dashboardHtml = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const webStyles = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");

describe("electron desktop shell", () => {
  it("creates a secure BrowserWindow and hosts the local dashboard", () => {
    expect(electronMainSource).toContain("new BrowserWindow");
    expect(electronMainSource).toContain("contextIsolation: true");
    expect(electronMainSource).toContain("nodeIntegration: false");
    expect(electronMainSource).toContain("mainWindow.loadURL(appUrl)");
    expect(electronMainSource).toContain("startServer()");
  });
});

describe("dashboard ide workspace layout", () => {
  it("boots from the ide workspace runtime path with v3 layout state", () => {
    expect(dashboardAppSource).toContain("UI_LAYOUT_STATE_KEY");
    expect(dashboardAppSource).toContain("state.uiLayout = readUiLayoutState()");
    expect(dashboardAppSource).toContain("initIdeWorkspace()");
    expect(dashboardAppSource).toContain("setIdeActivityTab");
    expect(dashboardAppSource).toContain("setIdeCenterTab");
    expect(dashboardAppSource).toContain("runIdeWorkspaceAction");
    expect(dashboardAppSource).toContain("centerSplitRatio: 0.72");
    expect(dashboardAppSource).toContain("rightInspectorCollapsed: true");
    expect(dashboardAppSource).not.toContain("initDashboardWorkbench();");
    expect(dashboardAppSource).not.toContain("initBlueprintShell();");
  });

  it("renders the IDE shell primitives and viewer-first workspace tabs", () => {
    expect(dashboardHtml).toContain('id="dashboard-root" class="ide-shell');
    expect(dashboardHtml).toContain('class="ide-topbar"');
    expect(dashboardHtml).toContain('id="ide-activity-rail"');
    expect(dashboardHtml).toContain('id="ide-left-dock"');
    expect(dashboardHtml).toContain('id="ide-center-tabs"');
    expect(dashboardHtml).toContain('id="ide-main-dock"');
    expect(dashboardHtml).toContain('id="dashboard-utility-rail" class="utility-rail ide-inspector"');
    expect(dashboardHtml).toContain('id="ide-bottom-rail"');
    expect(dashboardHtml).toContain('data-ide-center-tab="live_observer"');
    expect(dashboardHtml).toContain('data-ide-center-tab="mission_console"');
    expect(dashboardHtml).toContain('data-ide-center-tab="tweet_composer"');
    expect(dashboardHtml).toContain('id="cowork-live-iframe"');
  });

  it("ships IDE shell styling primitives and responsive viewer constraints", () => {
    expect(webStyles).toContain("#dashboard-root.ide-shell {");
    expect(webStyles).toContain(".ide-topbar");
    expect(webStyles).toContain(".ide-activity-rail");
    expect(webStyles).toContain(".ide-sidebar");
    expect(webStyles).toContain(".ide-editor-surface");
    expect(webStyles).toContain(".ide-inspector");
    expect(webStyles).toContain(".ide-bottom-rail");
    expect(webStyles).toContain("min-width: 900px");
    expect(webStyles).toContain("min-height: 600px");
    expect(webStyles).toContain("@media (max-width: 1279px)");
  });

  it("keeps social + agent feature wiring ids in the replacement shell", () => {
    expect(dashboardHtml).toContain('id="login-form"');
    expect(dashboardHtml).toContain('id="tweet-form"');
    expect(dashboardHtml).toContain('id="x-algo-form"');
    expect(dashboardHtml).toContain('id="ai-form"');
    expect(dashboardHtml).toContain('id="ai-image-form"');
    expect(dashboardHtml).toContain('id="ai-video-form"');
    expect(dashboardHtml).toContain('id="plan-form"');
    expect(dashboardHtml).toContain('id="workflow-run"');
    expect(dashboardHtml).toContain('id="cowork-mission-social"');
    expect(dashboardHtml).toContain('id="context-inbox-list"');
    expect(dashboardHtml).toContain('id="approval-action-modal"');
    expect(dashboardHtml).toContain('id="approval-modal-auto-toggle"');
    expect(dashboardHtml).toContain('id="desktop-command-palette"');
  });
});
