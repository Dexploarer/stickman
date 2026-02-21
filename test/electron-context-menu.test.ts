import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const mainSource = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");

describe("electron native context menu", () => {
  it("wires webContents context-menu and sends allowlisted actions", () => {
    expect(mainSource).toContain("webContents.on(\"context-menu\"");
    expect(mainSource).toContain("CONTEXT_ACTION_ALLOWLIST");
    expect(mainSource).toContain("Menu.buildFromTemplate");
    expect(mainSource).toContain("pod:context-action");
    expect(mainSource).toContain("pod:context-menu:opened");
    expect(mainSource).toContain("ipcMain.handle(\"pod:context-action:execute\"");
  });

  it("exposes safe preload wrappers without leaking raw ipc to renderer globals", () => {
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld(\"podDesktop\"");
    expect(preloadSource).toContain("onContextAction");
    expect(preloadSource).toContain("offContextAction");
    expect(preloadSource).toContain("getDesktopCapabilities");
    expect(preloadSource).toContain("executeContextAction");
    expect(preloadSource).not.toContain("exposeInMainWorld(\"ipcRenderer\"");
  });
});
