import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const mainSource = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const htmlSource = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");

describe("electron desktop shell integrations", () => {
  it("wires native menu templates, tray background mode, and notification event hooks", () => {
    expect(mainSource).toContain("Menu.setApplicationMenu");
    expect(mainSource).toContain("new Tray");
    expect(mainSource).toContain("desktopPreferences.backgroundModeEnabled");
    expect(mainSource).toContain("Notification");
    expect(mainSource).toContain("/api/live/events");
    expect(mainSource).toContain("titleBarOverlayMode");
    expect(mainSource).toContain("ipcMain.handle(\"pod:desktop:commands:get\"");
    expect(mainSource).toContain("ipcMain.handle(\"pod:desktop:preferences:set\"");
    expect(mainSource).toContain("pod:desktop-command");
    expect(mainSource).toContain("pod:desktop-live-event");
  });

  it("exposes safe desktop bridge APIs in preload", () => {
    expect(preloadSource).toContain("getDesktopCapabilities");
    expect(preloadSource).toContain("getDesktopCommands");
    expect(preloadSource).toContain("getDesktopPreferences");
    expect(preloadSource).toContain("setDesktopPreferences");
    expect(preloadSource).toContain("executeDesktopCommand");
    expect(preloadSource).toContain("onDesktopCommand");
    expect(preloadSource).toContain("onDesktopLiveEvent");
    expect(preloadSource).toContain("onDesktopCapabilities");
    expect(preloadSource).toContain("onDesktopPreferences");
    expect(preloadSource).not.toContain("exposeInMainWorld(\"ipcRenderer\"");
  });

  it("adds command palette parity and titlebar-aware UI hooks in renderer", () => {
    expect(appSource).toContain("DESKTOP_COMMAND_ACTION_MAP");
    expect(appSource).toContain("openDesktopCommandPalette");
    expect(appSource).toContain("executeDesktopCommand");
    expect(appSource).toContain("syncDesktopWindowChrome");
    expect(appSource).toContain("onDesktopCommand");
    expect(appSource).toContain("onDesktopLiveEvent");

    expect(htmlSource).toContain('id="desktop-command-palette"');
    expect(htmlSource).toContain('id="desktop-command-search"');
    expect(htmlSource).toContain('id="desktop-drag-region"');

    expect(styleSource).toContain(".desktop-drag-region {");
    expect(styleSource).toContain(".desktop-command-item {");
    expect(styleSource).toContain(".pplx-notification-feed {");
  });
});
