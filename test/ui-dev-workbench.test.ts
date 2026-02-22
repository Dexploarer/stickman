import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const dashboardHtml = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const dashboardAppSource = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const tailwindInput = readFileSync(new URL("../web/tailwind.input.css", import.meta.url), "utf8");
const tailwindBuilt = readFileSync(new URL("../web/tailwind.generated.css", import.meta.url), "utf8");

describe("dev workbench UI integration", () => {
  it("ships a compiled Tailwind pipeline for the renderer", () => {
    expect(packageJson.scripts?.["ui:tailwind:build"]).toContain("tailwindcss");
    expect(packageJson.devDependencies?.tailwindcss).toBeDefined();
    expect(dashboardHtml).toContain('href="/tailwind.generated.css?v=tw-v1"');
    expect(tailwindInput).toContain("@tailwind base;");
    expect(tailwindInput).toContain(".tw-dev-grid");
    expect(tailwindBuilt).toContain(".tw-dev-grid");
    expect(tailwindBuilt).toContain(".panel-dev-workbench");
  });

  it("renders dedicated controls for workspace, git, code, and terminal surfaces", () => {
    expect(dashboardHtml).toContain('id="dev-workbench-panel"');
    expect(dashboardHtml).toContain('data-ide-label="Dev Workbench"');
    expect(dashboardHtml).toContain('id="dev-workspace-tree-refresh"');
    expect(dashboardHtml).toContain('id="dev-workspace-file-read"');
    expect(dashboardHtml).toContain('id="dev-workspace-write-dry-run"');
    expect(dashboardHtml).toContain('id="dev-workspace-write-execute"');
    expect(dashboardHtml).toContain('id="dev-git-action-dry-run"');
    expect(dashboardHtml).toContain('id="dev-git-action-execute"');
    expect(dashboardHtml).toContain('id="dev-code-plan-run"');
    expect(dashboardHtml).toContain('id="dev-code-exec-run"');
    expect(dashboardHtml).toContain('id="dev-terminal-create"');
    expect(dashboardHtml).toContain('id="dev-terminal-connect"');
    expect(dashboardHtml).toContain('id="dev-terminal-send"');
  });

  it("wires each workbench surface to its API contract", () => {
    expect(dashboardAppSource).toContain("/api/workspace/tree");
    expect(dashboardAppSource).toContain("/api/workspace/file");
    expect(dashboardAppSource).toContain('apiGet("/api/git/status")');
    expect(dashboardAppSource).toContain("/api/git/actions");
    expect(dashboardAppSource).toContain('apiGet("/api/code/status")');
    expect(dashboardAppSource).toContain("/api/code/exec");
    expect(dashboardAppSource).toContain("/api/code/approvals");
    expect(dashboardAppSource).toContain("/api/terminal/sessions");
    expect(dashboardAppSource).toContain("/api/terminal/ws?sessionId=");
    expect(dashboardAppSource).toContain("refreshDevWorkbench");
  });
});

