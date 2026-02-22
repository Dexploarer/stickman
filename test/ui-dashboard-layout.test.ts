import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const dashboardAppSource = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const dashboardHtml = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const webStyles = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");

const countMatches = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].length;

describe("social agent studio ui contract", () => {
  it("uses v8 layout state + chat mode persistence with top-tab contract", () => {
    expect(dashboardAppSource).toContain("prompt-or-die-social-suite.ui-layout.v8");
    expect(dashboardAppSource).toContain("prompt-or-die-social-suite.ui-chat-mode.v1");
    expect(dashboardAppSource).toContain("const UI_ACTIVITY_TABS = Object.freeze([");
    expect(dashboardAppSource).toContain('"chat"');
    expect(dashboardAppSource).toContain('"agent"');
    expect(dashboardAppSource).toContain('"memory"');
    expect(dashboardAppSource).toContain('"tools"');
    expect(dashboardAppSource).toContain('"integrations"');
    expect(dashboardAppSource).toContain('"workflows"');
    expect(dashboardAppSource).toContain('"settings"');
    expect(dashboardAppSource).toContain('"advanced"');
    expect(dashboardAppSource).toContain("activeTopTab: \"chat\"");
    expect(dashboardAppSource).toContain("leftDrawerCollapsed: true");
    expect(dashboardAppSource).toContain("rightRailCollapsed: false");
    expect(dashboardAppSource).toContain("bottomDrawerCollapsed: true");
    expect(dashboardAppSource).toContain("chatMode: \"simple\"");
  });

  it("maps each top tab to direct center views and tab-context drawer behavior", () => {
    expect(dashboardAppSource).toContain('chat: "cowork-panel"');
    expect(dashboardAppSource).toContain('agent: "ai-chat-panel"');
    expect(dashboardAppSource).toContain('memory: "memory-panel"');
    expect(dashboardAppSource).toContain('tools: "command-studio-panel"');
    expect(dashboardAppSource).toContain('integrations: "integrations-panel"');
    expect(dashboardAppSource).toContain('workflows: "planner-panel"');
    expect(dashboardAppSource).toContain('settings: "settings-panel"');
    expect(dashboardAppSource).toContain('advanced: "advanced-panel"');

    expect(dashboardAppSource).toContain('memory: ["memory-tools-panel", "recent-runs-panel", "quick-automations-panel"]');
    expect(dashboardAppSource).toContain('tools: ["tools-drawer-panel", "mac-watch-panel", "layout-generator-panel"]');
    expect(dashboardAppSource).toContain('integrations: ["integrations-drawer-panel", "mac-watch-panel", "runtime-controls-panel"]');
    expect(dashboardAppSource).toContain('workflows: ["workflows-drawer-panel", "task-board-panel", "mac-watch-panel"]');
    expect(dashboardAppSource).toContain('advanced: ["advanced-drawer-panel", "mac-watch-panel", "approval-queue-panel"]');

    expect(dashboardAppSource).toContain("if (next === \"chat\") {");
    expect(dashboardAppSource).toContain("updated.leftDrawerCollapsed = true;");
    expect(dashboardAppSource).toContain("updated.leftDrawerCollapsed = false;");
  });

  it("renders Social Agent Studio shell regions and exact top-tab order", () => {
    expect(dashboardHtml).toContain("<title>Social Agent Studio</title>");
    expect(dashboardHtml).toContain('class="ide-topbar-title">Social Agent Studio</strong>');

    const tabSequence = [
      'data-ide-activity="chat"',
      'data-ide-activity="agent"',
      'data-ide-activity="memory"',
      'data-ide-activity="tools"',
      'data-ide-activity="integrations"',
      'data-ide-activity="workflows"',
      'data-ide-activity="settings"',
      'data-ide-activity="advanced"',
    ];
    let prevIndex = -1;
    for (const marker of tabSequence) {
      const nextIndex = dashboardHtml.indexOf(marker);
      expect(nextIndex).toBeGreaterThan(prevIndex);
      prevIndex = nextIndex;
    }

    expect(countMatches(dashboardHtml, /id="ide-left-dock"/g)).toBe(1);
    expect(countMatches(dashboardHtml, /id="ide-main-dock"/g)).toBe(1);
    expect(countMatches(dashboardHtml, /id="dashboard-utility-rail"/g)).toBe(1);
    expect(countMatches(dashboardHtml, /id="ide-bottom-rail"/g)).toBe(1);

    expect(dashboardHtml).toContain('id="ide-current-heading"');
    expect(dashboardHtml).toContain('id="ide-event-heading"');
    expect(dashboardHtml).toContain('id="ide-goals-heading"');
    expect(dashboardHtml).toContain('id="ide-tasks-heading"');
    expect(dashboardHtml).toContain('id="watch-expand-live"');
    expect(dashboardHtml).toContain('id="live-viewer-modal"');

    expect(dashboardHtml).toContain('id="integrations-panel"');
    expect(dashboardHtml).toContain('id="settings-panel"');
    expect(dashboardHtml).toContain('id="advanced-panel"');
    expect(dashboardHtml).toContain('id="memory-tools-panel"');
    expect(dashboardHtml).toContain('id="tools-drawer-panel"');
    expect(dashboardHtml).toContain('id="integrations-drawer-panel"');
    expect(dashboardHtml).toContain('id="workflows-drawer-panel"');
    expect(dashboardHtml).toContain('id="advanced-drawer-panel"');
    expect(dashboardHtml).not.toContain("data-ide-center-tab=");
  });

  it("ships canonical Social Agent Studio styling without legacy parity override stack", () => {
    expect(webStyles).toContain("#dashboard-root.ide-shell {");
    expect(webStyles).toContain("grid-template-rows: 50px 54px minmax(0, 1fr) auto;");
    expect(webStyles).toContain("#dashboard-root .ide-workspace {");
    expect(webStyles).toContain("grid-template-columns: 300px minmax(0, 1fr) 330px;");
    expect(webStyles).toContain("#dashboard-root #ide-center-tabs {");
    expect(webStyles).toContain("display: none !important;");
    expect(webStyles).toContain("#dashboard-root #ide-main-tabs {");
    expect(webStyles).toContain("#dashboard-root .ide-view-header {");
    expect(webStyles).toContain("#dashboard-root .arg-row {");
    expect(webStyles).toContain("#dashboard-root .integration-badge {");
    expect(webStyles).toContain("#dashboard-root .context-inbox-actions,");
    expect(webStyles).toContain("#dashboard-root table {");
    expect(webStyles).toContain(".dashboard-panel-grid {");
    expect(webStyles).toContain("#dashboard-root.ide-left-collapsed .ide-workspace {");
    expect(webStyles).toContain("#dashboard-root.ide-right-collapsed .ide-workspace {");
    expect(webStyles).toContain("#dashboard-root.ide-bottom-collapsed #ide-bottom-rail {");
    expect(webStyles).toContain("@media (max-width: 1280px)");
    expect(webStyles).not.toContain("Milady chat-shell parity override");
  });

  it("keeps feature wiring IDs and readable rail render contract", () => {
    expect(dashboardHtml).toContain('id="login-form"');
    expect(dashboardHtml).toContain('id="tweet-form"');
    expect(dashboardHtml).toContain('id="x-algo-form"');
    expect(dashboardHtml).toContain('id="ai-form"');
    expect(dashboardHtml).toContain('id="plan-form"');
    expect(dashboardHtml).toContain('id="workflow-run"');
    expect(dashboardHtml).toContain('id="context-inbox-list"');
    expect(dashboardHtml).toContain('id="approval-action-modal"');
    expect(dashboardHtml).toContain('id="desktop-command-palette"');

    expect(dashboardAppSource).toContain('eventHeading.textContent = `Event Stream (${eventCount})`;');
    expect(dashboardAppSource).toContain('goalsHeading.textContent = `Goals (${goalsCount})`;');
    expect(dashboardAppSource).toContain('tasksHeading.textContent = `Tasks (${totalTasks})`;');
    expect(dashboardAppSource).toContain('setText(\n    "ide-task-summary",');
    expect(dashboardAppSource).toContain('setText(\n    "ide-provider-summary",');
  });
});
