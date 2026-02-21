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
  it("supports tabbed pages, panel/tool/modal segments, and draggable arrangement", () => {
    expect(dashboardAppSource).toContain("DASHBOARD_PAGE_TABS");
    expect(dashboardAppSource).toContain("DASHBOARD_SEGMENT_TABS");
    expect(dashboardAppSource).toContain("initDashboardWorkbench()");
    expect(dashboardAppSource).toContain("panel.draggable = true");
    expect(dashboardAppSource).toContain("dashboard-tool-item");
    expect(webStyles).toContain(".dashboard-workbench {");
    expect(webStyles).toContain(".dashboard-panel-grid {");
    expect(webStyles).toContain(".panel-drag-handle {");
    expect(webStyles).toContain(".dashboard-modal-overlay {");
    expect(webStyles).toContain(".cowork-grid {");
  });
});
