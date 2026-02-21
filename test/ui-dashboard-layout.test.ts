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
});
