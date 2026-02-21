import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const electronMainSource = readFileSync(
  new URL("../electron/main.cjs", import.meta.url),
  "utf8"
);

const dashboardAppSource = readFileSync(
  new URL("../web/app.js", import.meta.url),
  "utf8"
);

const dashboardHtml = readFileSync(
  new URL("../web/index.html", import.meta.url),
  "utf8"
);

const webStyles = readFileSync(
  new URL("../web/styles.css", import.meta.url),
  "utf8"
);

describe("electron desktop shell", () => {
  it("creates a secure BrowserWindow and hosts the local dashboard", () => {
    expect(electronMainSource).toContain("new BrowserWindow");
    expect(electronMainSource).toContain("contextIsolation: true");
    expect(electronMainSource).toContain("nodeIntegration: false");
    expect(electronMainSource).toContain("mainWindow.loadURL(appUrl)");
    expect(electronMainSource).toContain("startServer()");
  });
});

describe("dashboard workbench layout", () => {
  it("supports tabbed pages, panel/tool/modal segments, draggable arrangement, and dynamic custom panels", () => {
    expect(dashboardAppSource).toContain("DASHBOARD_PAGE_TABS");
    expect(dashboardAppSource).toContain("DASHBOARD_SEGMENT_TABS");
    expect(dashboardAppSource).toContain("DASHBOARD_MAX_CUSTOM_PANELS = 16");
    expect(dashboardAppSource).toContain("Add Panel");
    expect(dashboardAppSource).toContain("custom-panel-notes");
    expect(dashboardAppSource).toContain("panel.dataset.panelSize");
    expect(dashboardAppSource).toContain("initDashboardWorkbench()");
    expect(dashboardAppSource).toContain("panel.draggable = true");
    expect(dashboardAppSource).toContain("dashboard-tool-item");
    expect(webStyles).toContain(".dashboard-workbench {");
    expect(webStyles).toContain(".dashboard-panel-grid {");
    expect(webStyles).toContain("var(--dashboard-panel-min-width");
    expect(webStyles).toContain(".dashboard-panel-card[data-panel-size=\"wide\"]");
    expect(webStyles).toContain(".dashboard-panel-card[data-panel-size=\"tall\"]");
    expect(webStyles).toContain(".dashboard-panel-card[data-panel-size=\"large\"]");
    expect(webStyles).toContain(".custom-panel-config {");
    expect(webStyles).toContain(".panel-drag-handle {");
    expect(webStyles).toContain(".dashboard-modal-overlay {");
    expect(webStyles).toContain(".cowork-grid {");
  });

  it("keeps social + X panels and removes coding-focused surface ids", () => {
    expect(dashboardHtml).toContain("id=\"login-form\"");
    expect(dashboardHtml).toContain("id=\"tweet-form\"");
    expect(dashboardHtml).toContain("id=\"x-algo-form\"");
    expect(dashboardHtml).toContain("id=\"ai-form\"");
    expect(dashboardHtml).toContain("id=\"ai-image-form\"");
    expect(dashboardHtml).toContain("id=\"ai-video-form\"");
    expect(dashboardHtml).toContain("id=\"plan-form\"");
    expect(dashboardHtml).toContain("id=\"workflow-run\"");
    expect(dashboardHtml).toContain("id=\"cowork-mission-social\"");

    expect(dashboardHtml).not.toContain("id=\"cowork-quick-terminal\"");
    expect(dashboardHtml).not.toContain("id=\"cowork-quick-codex\"");
    expect(dashboardHtml).not.toContain("id=\"cowork-quick-claude\"");
    expect(dashboardHtml).not.toContain("id=\"cowork-mission-coding\"");
    expect(dashboardHtml).not.toContain("id=\"ext-code-enable\"");
    expect(dashboardHtml).not.toContain("id=\"ext-code-disable\"");
    expect(dashboardHtml).not.toContain("id=\"integration-open-terminal\"");
    expect(dashboardHtml).not.toContain("id=\"integration-claude-login\"");
    expect(dashboardHtml).not.toContain("id=\"code-plan-form\"");
    expect(dashboardHtml).not.toContain("id=\"terminal-pty-refresh\"");
  });

  it("does not keep stale app bindings for removed coding ids", () => {
    expect(dashboardAppSource).not.toContain("cowork-quick-terminal");
    expect(dashboardAppSource).not.toContain("cowork-quick-codex");
    expect(dashboardAppSource).not.toContain("cowork-quick-claude");
    expect(dashboardAppSource).not.toContain("cowork-mission-coding");
    expect(dashboardAppSource).not.toContain("integration-open-terminal");
    expect(dashboardAppSource).not.toContain("integration-claude-login");
    expect(dashboardAppSource).not.toContain("ext-code-enable");
    expect(dashboardAppSource).not.toContain("ext-code-disable");
    expect(dashboardAppSource).not.toContain("code-plan-form");
    expect(dashboardAppSource).not.toContain("terminal-pty");
    expect(dashboardAppSource).not.toContain("workspace-tree");
    expect(dashboardAppSource).not.toContain("git-refresh");
  });
});
